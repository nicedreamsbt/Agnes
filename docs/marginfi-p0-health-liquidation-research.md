# Marginfi / Project Zero: Account Health, Liquidation Eligibility, and Cross-Venue Rules

**Date:** 2026-05-11  
**Scope:** How Project Zero (marginfi v2) computes **user health**, what makes an account **liquidatable**, how much can be liquidated **per transaction / per instruction**, and how **venue-backed banks** (Kamino, Drift, JupLend, native marginfi, etc.) fit into the same rule set.  
**Sources:** Official marginfi documentation, marginfi v2 program docs, `@0dotxyz/p0-ts-sdk` (open-source TypeScript SDK bundled with this repo), and the Agnes monitor / liquidation helper code for operational alignment.

---

## 1. Architectural premise: one account, many banks

Project Zero is a **single marginfi group + program** model (`MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA` on mainnet per SDK defaults). Each **user position** is a `MarginfiAccount` with multiple **balances**, one per **bank** (each bank is a distinct SPL mint / market configuration).

**Venues** (Kamino, Drift, JupLend, …) do **not** run separate health engines for marginfi users. They are represented as **banks** whose price feeds and, where applicable, **integration accounts** (reserve, spot market, JupLend state, etc.) tie the bank’s oracle and settlement path to the external protocol. **Health and liquidation eligibility are always computed in marginfi’s risk engine** over the unified set of balances; execution then uses venue-specific instructions to move collateral or debt only where the bank’s `OracleSetup` / `AssetTag` / integration layout requires it.

This matches the product framing in the [mrgnlend user guide](https://docs.marginfi.com/mrgnlend) and the [marginfi v2 program documentation](https://docs.marginfi.com/mfi-v2).

---

## 2. How health is computed (risk engine + SDK mirror)

### 2.1 Three margin requirement “modes”

The protocol and SDK distinguish **`MarginRequirementType`** values (names from SDK / IDL):

| Mode | Typical use |
|------|-------------|
| **Equity** | Mark-to-market style **wallet NAV**: token quantities × oracle price, **weight = 1**, **no** conservative price bias. |
| **Initial** | **Opening / free collateral**: weighted assets vs weighted liabilities with **conservative** pricing. Borrow/withdraw limits reference this regime. |
| **Maintenance** | **Solvency / liquidation boundary**: same weighting family as initial, still with conservative pricing, but **maintenance** asset/liability weights (usually stricter for assets, looser for liabilities than initial). |

The Agnes codebase treats **maintenance health ≤ 0** (with material maintenance liabilities) as the **canonical liquidatable signal** when recomputing from live balances and oracles—not the on-chain `HealthCache` alone, because the cache can lag unless refreshed by a health pulse crank. See `src/health.js` and the startup legend in `src/monitor.js`.

### 2.2 Portfolio-level formula (conceptual)

For each active balance and each requirement type, the SDK computes **USD asset contribution** and **USD liability contribution**, then sums:

\[
\text{Health}_{R} = A_{R} - L_{R}
\]

where \(R \in \{\text{Equity}, \text{Initial}, \text{Maintenance}\}\), \(A_R\) is the sum of risk-weighted, price-processed **asset** values, and \(L_R\) the same for **liabilities**.

- **Liquidation gating (operational standard in this repo):** use **Maintenance** with **price bias** (see below): liquidatable when **health ≤ 0** and liabilities are economically meaningful (dust thresholds in tooling only).

### 2.3 Per-balance mechanics (weights, shares, oracles)

1. **Shares → quantities:** User positions store **asset shares** and **liability shares**; the bank’s accounting converts shares to token amounts (the SDK exposes `computeQuantity` / `computeQuantityUi`).

2. **Oracle → USD:** Each bank has an **oracle configuration** (`oracleSetup`, `oracleKeys`, etc.). The SDK builds a structured **oracle price object** (real-time and weighted tracks, confidence, and derived **lowest** / **highest** confidence bands).

3. **Risk weights:** From on-chain `BankConfig`: **`assetWeightInit` / `assetWeightMaint`**, **`liabilityWeightInit` / `liabilityWeightMaint`**. For **Equity**, weights are effectively **1** for pricing pass-through; for **Initial** / **Maintenance**, the SDK selects the appropriate weight fields.

4. **eMode:** If an eMode pair applies, the SDK can **raise** effective asset weights for designated collateral banks (see `computeHealthComponentsFromBalances` in `@0dotxyz/p0-ts-sdk`).

5. **LST / share multiplier:** Some banks apply an **`assetShareValueMultiplier`** (e.g. liquid staking drift) so UI quantity and risk value stay aligned with the bank’s internal share model.

6. **Isolated risk tier (borrowing rules, not a separate health VM):** SDK logic prevents certain **new borrows** when isolated-asset rules would be violated (e.g. isolated debt mixing). Marginfi’s [support article](https://support.marginfi.com/en/articles/4394625) states that **isolated-pool assets cannot be used as collateral for global borrowing**—that is a **product/risk boundary**, still enforced inside the same account health framework.

### 2.4 Conservative price bias (critical for Initial / Maintenance)

For **Initial** and **Maintenance**, the SDK’s `computeHealthComponentsFromBalances` path uses **asymmetric price bias**:

- **Assets:** use the **lowest** defensible price (e.g. spot minus capped confidence).  
- **Liabilities:** use the **highest** defensible price.

Implementation reference (SDK): `getBalanceUsdValueWithPriceBias` calls `computeAssetUsdValue` with `priceBias: Lowest` and `computeLiabilityUsdValue` with `priceBias: Highest`, while **Equity** uses neutral bias (`computeBalanceUsdValue`).

**Why it matters:** Two accounts with the same “spot NAV” can have different **maintenance health** depending on oracle width, venue, and weighting. Liquidators must use the **same** oracle refresh discipline as the chain or they will simulate success/failure incorrectly.

### 2.5 Weighted vs unweighted oracle track

For each side, the SDK also chooses between **real-time** and **weighted** (e.g. EMA-like) price tracks depending on requirement type (`isWeightedPrice`). That implements the protocol’s intent to smooth borrowing limits and reduce manipulation—see marginfi [FAQs / docs](https://docs.marginfi.com/faqs) on EMA-style behavior in user-facing materials.

### 2.6 On-chain `HealthCache` vs client recomputation

The program maintains a **`HealthCache`** on each `MarginfiAccount` (flags include **`HEALTHY`**, **`ENGINE`**, **`ORACLE_OK`**, etc.—see SDK IDL docs on `HealthCache`). The permissionless **`lending_account_pulse_health`** instruction refreshes this cache for observability.

**Important:** Liquidators and monitors that read **only** the cache can be **stale** after volatile oracle moves. The Agnes monitor intentionally recomputes from **balances + live oracle map** via `computeHealthComponentsFromBalances` / `WithoutBias` helpers (`src/health.js`) so displayed **maintenance health** tracks liquidator-relevant conditions more closely than a stale pulse.

---

## 3. When an account is liquidatable (rules)

### 3.1 Primary condition

**Under maintenance requirement with conservative prices:**

\[
A_{\text{maint,bias}} - L_{\text{maint,bias}} \le 0
\]

(with non-trivial \(L_{\text{maint,bias}}\) in practice—tooling may apply dust cutoffs).

This is equivalent in spirit to user-facing copy: **health ≤ 0%** in the [support center](https://support.marginfi.com/en/articles/4394625) and “account health reaches 0% or below” in the [mrgnlend guide](https://docs.marginfi.com/mrgnlend), expressed in **percentage UI** rather than raw USD.

### 3.2 Program-level errors (IDL, SDK-embedded)

The marginfi v2 IDL (shipped inside `@0dotxyz/p0-ts-sdk`) defines errors that shape liquidator behavior, including:

| Error | Meaning for liquidators |
|-------|-------------------------|
| **Account is healthy and cannot be liquidated** | Pre-state check failed—often race with oracle refresh or wrong remaining accounts. |
| **Too severe liquidation** | Single liquidation step would **over-repay** / push the account **above** maintenance in an invalid way (bound on max seizure per ix). |
| **Worse health post liquidation** | The proposed trade **hurts** maintenance health—illegal. |
| **Overliquidation attempt** | Seizure / repay sizing violates protocol caps for that step. |
| **Zero liquidation amount** | `asset_amount == 0` in `lending_account_liquidate`. |

These errors establish that liquidation is **not** “burn entire account in one ix without constraints”—the program enforces **local optimality** and **sizing bounds** on each liquidation instruction.

### 3.3 Oracle validity

If oracles are **stale** or invalid, user-facing flows can fail with errors like **“Simulating health/liquidation impact failed”** ([support article](https://support.marginfi.com/en/articles/4394625)). On-chain, the health engine can clear **`ORACLE_OK`** in the cache and record internal error codes—liquidators should treat **oracle liveness** as a **hard gate** for safe execution.

---

## 4. How much can be liquidated at a time?

### 4.1 Two different “caps” (do not conflate them)

1. **Economic / risk cap per liquidation instruction**  
   The program requires that a liquidation **improves** solvency and does not **over-liquidate** relative to maintenance (errors **Too severe liquidation**, **Worse health post liquidation**, **Overliquidation attempt**). In aggregate, this behaves like a **partial liquidation** design: each **`lending_account_liquidate`** call moves a **chosen collateral amount** (`asset_amount` in the IDL) subject to those checks.

   The [mrgnlend documentation](https://docs.marginfi.com/mrgnlend) describes partial liquidation and “restore health factor to 1” in **product** language. The **classic** on-chain `lending_account_liquidate` path is stricter: after a successful liquidation the account’s **maintenance health must still be ≤ 0** but **strictly greater** than before the trade (see **Appendix A** for the exact Rust checks). So a single classic liquidation **improves** an underwater account without **fully curing** it above the maintenance boundary; repeated liquidations can eventually do so across transactions.

   **Receivership** `end_liquidation` can treat very small **equity** accounts differently via a **closeout dollar threshold** (on-chain constant, Appendix A).

2. **Liquidator / bot sizing choice**  
   Off-chain systems (e.g. Agnes `src/liquidation/candidate.js`) often pick the **largest maintenance-USD asset bank** and **largest maintenance-USD liability bank**, then pass **up to full position size** as upper bounds into planning, relying on **simulation** and the program to reject oversize. That is **not** a protocol guarantee that a full position can close in one ix—only an upper bound for builders.

### 4.2 Classic path: `lending_account_liquidate`

Per [marginfi v2 docs](https://docs.marginfi.com/mfi-v2) and the SDK IDL:

- **`asset_amount`:** native units of **collateral (asset bank)** the liquidator seeks to seize / process in that instruction.
- **Remaining accounts:** encode **all banks / oracles** needed to re-price **liquidator and liquidatee** positions for the risk check, in a strict order. Wrong ordering ⇒ **`InvalidBankAccount`** style failures. Agnes encodes venue-aware pubkey lists in `src/liquidation/receivership-health.js` (`liquidateRemainingPubkeysForBank`) specifically because **`OracleSetup::Fixed`** and venue integrations require **different** account counts than generic SDK helpers.

**Practical consequence:** “Max per liquidation” is the **minimum** of:

- liquidator’s chosen `asset_amount`,
- liquidatee’s available collateral on that bank,
- **on-chain** maximum allowed by maintenance recovery and premium math for that step,
- transaction size / CU limits when wrapping venue withdrawals + swaps.

### 4.3 Receivership path: `start_liquidation` → … → `end_liquidation`

The IDL describes **`start_liquidation`** as:

- **Permissionless** entry into **receivership** on an unhealthy account,
- **Snapshots** liquidation prices / TWAP fields into the liquidation record,
- Requires **`end_liquidation`** as the **last** instruction in the same transaction (bundle semantics).

Between start and end, the liquidator typically executes **venue withdraw** (collateral leg), **swap** (if needed), and **`lending_account_repay`** on the liquidatee’s debt, then ends receivership. The program validates the bundle against the **snapshotted** liquidation prices and fee configuration (`liquidation_max_fee`, `liquidation_flat_sol_fee` in the IDL).

**Per-transaction constraint:** The IDL explicitly notes **only one liquidation event** per transaction—liquidators cannot stack multiple independent liquidation sequences in one tx.

### 4.4 Fees and incentives (per liquidation economics)

Consistent across [mrgnlend](https://docs.marginfi.com/mrgnlend) and the SDK IDL docs for **`lending_account_liquidate`**:

- **~5%** liquidation penalty on affected collateral (user-facing docs),
- Split **~2.5%** to **liquidator** and **~2.5%** to **insurance fund** of the liability bank’s insurance vault path.

For **`lending_account_liquidate`**, the **Rust type crate** currently hard-codes **2.5% + 2.5%** liquidator and insurance fee rates (with a `TODO` to make them variable per bank)—see Appendix A. **Receivership** end-state additionally compares seized vs repaid value against `FeeState.liquidation_max_fee` floored by a **5%** minimum bonus constant.

---

## 5. Venue-specific rules (what actually differs)

Venues **do not change the maintenance inequality** \(A_{\text{maint}} - L_{\text{maint}} \le 0\). They change **how prices enter** and **which extra accounts** must be passed so the program can verify those prices and settle token flows.

### 5.1 Price source by `OracleSetup`

Examples from Agnes bank catalog and `src/venues.js`:

| Venue (typical) | Oracle setup families (non-exhaustive) |
|-----------------|------------------------------------------|
| **marginfi native** | `PythPushOracle`, `SwitchboardPull`, `StakedWithPythPush`, `Fixed`, etc. |
| **Kamino** | `KaminoPythPush`, `KaminoSwitchboardPull`, `FixedKamino`, … |
| **Drift** | `DriftSwitchboardPull`, `DriftPythPull`, `FixedDrift`, … |
| **JupLend** | `JuplendSwitchboardPull`, `JuplendPythPull`, `FixedJuplend`, … |
| **Solend** | `SolendPythPull`, `SolendSwitchboardPull` (Agnes execution path may still flag Solend as unsupported in smoke tooling—check `src/liquidation/candidate.js`). |

Each setup determines **which accounts** must be appended for **health pulses**, **liquidations**, and **withdraw** CPIs.

### 5.2 Remaining-account layouts (liquidation-critical)

`src/liquidation/receivership-health.js` documents a critical on-chain constraint: **`computeHealthCheckAccounts` from the SDK does not always match `OracleSetup::Fixed` (bank-only) layouts**. If the liquidator passes **too many** oracle accounts for a fixed-price bank, **every subsequent position’s bank pubkey is shifted** → **`InvalidBankAccount`**. Venue liquidators must mirror **`OracleSetup` + `AssetTag.STAKED` + integration** rules exactly.

**Staked assets (`AssetTag.STAKED`)** use **four** observation pubkeys in the default branch (bank + primary oracle + two extra oracle key slots)—see `liquidateRemainingPubkeysForBank`.

### 5.3 Operational bank state

Banks carry **`BankOperationalState`**: `Paused`, `Operational`, `ReduceOnly`, `KilledByBankruptcy` (SDK enum). The IDL includes **`BankReduceOnly`** errors for disallowed actions when a bank is in **reduce-only** mode—typically this blocks **new risk-increasing** user actions, while liquidations are **risk-reducing** for the system; always **simulate** venue-specific flows because CPI availability can still interact with pause/kill flags.

### 5.4 Execution venues vs health venues

`inferLiquidationExecutionVenue` (`src/venues.js`) chooses **which withdraw builder** to use (native marginfi vs Kamino vs Drift vs JupLend) from **integration accounts** and **`AssetTag`**, not from informal mint heuristics. **Health remains marginfi-global** regardless of that execution routing.

---

## 6. Pulse health, flags, and observability

The `HealthCache` **`flags`** bitfield (SDK IDL) exposes:

- **`HEALTHY`** — if set, account **cannot** be liquidated under the cached engine run.
- **`ENGINE`**, **`ORACLE_OK`** — diagnostics for whether the last pulse succeeded and oracles were acceptable.

Liquidators should treat **`ORACLE_OK == false`** as a **stop** until oracles are refreshed and ordering is corrected.

---

## 7. Summary table (quick reference)

| Question | Answer |
|----------|--------|
| **What defines liquidation?** | **Maintenance** requirement, **conservative** oracle bias, summed over all active balances—**health ≤ 0**. |
| **Do Kamino/Drift/JupLend use different health math?** | **No**—different banks/oracles/CPI accounts, **same** marginfi account risk sum. |
| **How much per tx?** | **One** liquidation bundle end-to-end; classic **`lending_account_liquidate`** takes a specific **`asset_amount`** bounded by **on-chain** optimality / caps (errors above). Full unwind may require **multiple** transactions. |
| **Where do 5% / 2.5% numbers come from?** | Classic liquidator+insurance split is **0.025 + 0.025** in the pinned Rust `type-crate` (Appendix A); receivership uses **`liquidation_max_fee`** with a **5%** floor; deployed bytecode may differ from `main`—verify. |
| **What is the “health factor = 1” phrase in docs?** | **Marketing shorthand**; classic ix requires **maintenance health still ≤ 0** after the trade but **strictly improved** vs pre-liquidation (Appendix A). |

---

## 8. References

1. [mrgnlend User Guide — Liquidation & health](https://docs.marginfi.com/mrgnlend)  
2. [Support — Lending & Liquidation / health percentages & isolated pools](https://support.marginfi.com/en/articles/4394625)  
3. [marginfi v2 Program Documentation](https://docs.marginfi.com/mfi-v2)  
4. [marginfi-v2 program source (Rust)](https://github.com/mrgnlabs/marginfi-v2) — authoritative for exact liquidation math and caps.  
5. **`@0dotxyz/p0-ts-sdk` v2.x** (`node_modules/@0dotxyz/p0-ts-sdk/dist/index.js`) — `computeHealthComponentsFromBalances`, `getBalanceUsdValueWithPriceBias`, IDL types.  
6. **Agnes implementation:** `src/health.js`, `src/liquidation/candidate.js`, `src/liquidation/receivership-health.js`, `src/venues.js`, `README.md`.

---

## Appendix A — On-chain constants and liquidation bounds (Rust source pin)

This appendix quotes **compile-time constants and control-flow bounds** from the public **mrgnlabs/marginfi-v2** monorepo. It is **not** a claim that Solana mainnet’s deployed program matches this commit; auditors and liquidators should pin the **artifact / release tag** they actually CPI against.

| Field | Value |
|-------|--------|
| **Repository** | [https://github.com/mrgnlabs/marginfi-v2](https://github.com/mrgnlabs/marginfi-v2) |
| **Pinned commit** | `843aa82df852b9e9a3c555e67ffd12aa53f4805b` (`843aa82` — “Add known issues to security doc (#546)”) |
| **Embedded `PROGRAM_VERSION` (program crate)** | `3` → comment maps this to program **0.1.5** (`programs/marginfi/src/constants.rs`) |

### A.1 Classic `lending_account_liquidate` — hard-coded fee fractions

Source: `type-crate/src/constants.rs` (commit above).

| Constant | Value | Notes |
|----------|--------|--------|
| `LIQUIDATION_LIQUIDATOR_FEE` | `I80F48!(0.025)` | **2.5%** of the value bridge to the liquidator side of the math (see `liquidate.rs` comments). |
| `LIQUIDATION_INSURANCE_FEE` | `I80F48!(0.025)` | **2.5%** to insurance (same file; comment: *“TODO: Make these variable per bank”*). |

Together these implement the documented **~5%** total fee split on the liability leg described in `programs/marginfi/src/instructions/marginfi_account/liquidate.rs` (comments + `final_discount` / `liquidator_discount`).

**Pricing inside the ix:** asset price uses **low-bias** (`fetch_asset_price_for_bank_low_bias`); liability price uses **real-time** with **high** bias (`PriceBias::High`). That matches the SDK’s conservative maintenance view.

### A.2 Classic liquidation — structural bounds (no global “close factor %”)

marginfi v2 does **not** expose a single global **`liquidation_max_debt_close_factor_pct`**-style knob in the same way some other lending programs do. Instead, **`check_post_liquidation_condition_and_get_account_health`** (`programs/marginfi/src/state/marginfi_account.rs`) enforces:

1. **Liability bank** still has liabilities and **no** assets on that balance (`TooSeverePayoff` / related errors if violated).
2. Let `account_health = maint_assets - maint_liabs` after the trade. Then:
   - **`account_health <= 0`** — otherwise **`MarginfiError::TooSevereLiquidation`**. So one **`lending_account_liquidate`** cannot push the liquidatee **above** the maintenance boundary; it only moves them **toward** it while remaining underwater or exactly at zero.
3. **`account_health > pre_liquidation_health`** — otherwise **`MarginfiError::WorseHealthPostLiquidation`**.

**`OverliquidationAttempt`** in this path is raised when the requested **`asset_amount`** exceeds the liquidatee’s **pre**-balance of collateral on the asset bank (`liquidate.rs`: `pre_balance >= asset_amount`).

**Flash-loan guard:** both pre- and post-checks error if **`ACCOUNT_IN_FLASHLOAN`** is set.

### A.3 Receivership `end_liquidation` — premium floor, closeout threshold, flat SOL fee

Source: `programs/marginfi/src/instructions/marginfi_account/liquidate_end.rs` and `programs/marginfi/src/constants.rs`.

| Constant | Value | Role |
|----------|--------|------|
| `LIQUIDATION_BONUS_FEE_MINIMUM` | `I80F48!(0.05)` | **5%** minimum; used with `FeeState.liquidation_max_fee` so `max_fee = max(1 + fee_state.liquidation_max_fee, 1 + 0.05)` (as `I80F48`). |
| `LIQUIDATION_CLOSEOUT_DOLLAR_THRESHOLD` | `I80F48!(5)` | If **snapshot equity assets** `< $5`, **`ignore_healthy`** is set when ending receivership: the **seized ≤ repaid × max_fee** premium check is **skipped**, allowing small-account wind-down without failing the bonus bound. |
| `LIQUIDATION_FLAT_FEE_DEFAULT` | `5000` (u32) | Default/testing note in comments for **flat SOL** fee (lamports scale in docs); **live** fee is read from **`fee_state.liquidation_flat_sol_fee`** at runtime. |

**Receivership health monotonicity:** `end_receivership` requires **post maintenance health (cached mode) not worse than pre** (`pre_health > post_health` ⇒ `WorseHealthPostLiquidation`), with `ignore_healthy` passed through from the closeout rule above.

### A.4 Bankruptcy and dust (equity / maintenance helpers)

From `type-crate/src/constants.rs` and `check_account_bankrupt` in `marginfi_account.rs`:

| Constant | Value | Role |
|----------|--------|------|
| `BANKRUPT_THRESHOLD` | `I80F48!(0.1)` | Equity assets **below ~$0.10** (literal `0.1` in `I80F48` risk units; see on-chain comment in source) with liabilities exceeding assets contributes to bankruptcy detection in `check_account_bankrupt`. |
| `EMPTY_BALANCE_THRESHOLD` | `I80F48!(1)` | Sub-one-native-unit artifact dust. |
| `ZERO_AMOUNT_THRESHOLD` | `I80F48!(0.0001)` | Arithmetic tolerance. |

### A.5 Oracle / confidence guardrails (type crate)

From `type-crate/src/constants.rs` (same pin):

| Constant | Value |
|----------|--------|
| `ORACLE_MIN_AGE` | `10` (seconds) |
| `MAX_PYTH_ORACLE_AGE` | `60` (seconds) |
| `CONF_INTERVAL_MULTIPLE` | `2.12` (Pyth best-practice multiple in comments) |
| `STD_DEV_MULTIPLE` | `1.96` |
| `MAX_CONF_INTERVAL` | `0.05` (50 bps max confidence interval cap) |
| `MAX_ORACLE_KEYS` | `5` |

### A.6 What this appendix does **not** replace

- **Per-bank** `Bank.config` weights, deposit/borrow caps, operational state, and any **governance-updated** fee fields on `FeeState`.
- **Venue CPI** limits (Kamino reserve liquidity, Drift spot constraints, etc.) enforced outside marginfi’s constant section.
- **Deployed** program hash on Solana — compare `solana program show MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA` to a tagged release build of this repo.

---

## 9. Disclaimer

This document synthesizes **public documentation** and **open-source SDK / repository code**. It is **not** a legal, financial, or audit opinion. On-chain behavior is defined solely by the **deployed marginfi v2 program**; any liquidation bot must **simulate on-chain** against the exact bytecode and current bank configs before risking capital.
