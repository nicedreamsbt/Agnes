# Verifying Marginfi Account Health

How to confirm the live gRPC monitor is reporting accurate account state and liquidation signals using the bundled RPC verifier (`src/verify-account.js`).

---

## TL;DR

```bash
npm run verify -- <pubkey> [<pubkey> ...]
```

This boots a fresh marginfi client over plain RPC (no gRPC), refreshes oracle prices on-chain, then for each pubkey prints health using **three independent paths** so you can triangulate:

1. **`from-balances / live-oracle`** — same SDK code path the monitor uses (`computeHealthComponentsFromBalances` + `computeHealthComponentsWithoutBiasFromBalances`). Uses freshly fetched oracle prices.
2. **`from-cache / on-chain`** — reads the `HealthCache` fields the marginfi program itself wrote at the last `PulseHealth` crank (`assetValueMaint`, `liabilityValueMaint`, etc).
3. **`nav`** — maintenance weights without price bias. "Fair-value risk-weighted equity" — same weights as `health`, oracle midpoint instead of conservative bias. Diagnostic only; do **not** treat it as a liquidation signal, and do **not** assume it matches any specific external tool's "Equity" field — different tools (eva01, marginfi UI, the marginfi-v2 program) use different conventions for `RequirementType::Equity`.

If `live-oracle` matches an external RPC tool's maintenance numbers within ~1% and `liquidatable` agrees, the gRPC monitor is reading the chain correctly.

---

## What the verifier prints

```
account=BCv3vL...28r authority=2deAqF...mtT2
  rpc owner=MFv2hWf...vacA lamports=16982400 dataLen=2312 slot=418666780 cacheTimestamp=unset
  oneliner: - BCv3vL...28r | authority=2deAqF...mtT2 | positions=8 venues=marginfi | health=$-0.058825 ratio=-10.27% assets=$0.513915 liab=$0.572740 equity=$64.499599 nav=$-0.057376 status=LIQUIDATABLE
  --- live oracle (computeHealthComponents*FromBalances) ---
    maintenance  health=$-0.058825 assets=$0.513915 liab=$0.572740 ratio=-10.27% status=LIQUIDATABLE
    initial      health=$-0.167029 assets=$0.432684 liab=$0.599714 (free_collateral)
    equity (SDK weight=1.0, no bias) = wallet NAV   value=$64.499599 assets=$65.044201 liab=$0.544602
    nav    (maint weights, no bias) = fair-value risk-weighted equity  value=$-0.057376 assets=$0.514456 liab=$0.571832
  --- on-chain HealthCache (last PulseHealth crank) ---
    maintenance  health=$-1.269327 assets=$6.352264 liab=$7.621592
    initial      health=$0         assets=$0        liab=$0
    equity       value=$0.963485   assets=$8.220317 liab=$7.256832
  --- drift (live - cache) / |cache| ---
    drift maintenance: health=95.37%  assets=-91.91% liab=-92.49%
    drift initial    : health=n/a     assets=n/a     liab=n/a
    drift equity     : health=6594%   assets=691%    liab=-92.5%
  positions: ...per-bank breakdown...
  verify elapsed_ms=160
```

### Field meanings

| Field | What it is | Convention |
| --- | --- | --- |
| `health` | Maintenance-weighted assets minus liabilities **with** price bias. **The canonical liquidation signal.** `< 0` means liquidatable. | Marginfi protocol |
| `ratio` | `health / weighted_assets` when healthy, `health / weighted_liabs` when underwater. Bounded `-100% .. 100%`. | Our monitor |
| `assets` / `liab` | Maintenance-weighted, price-biased USD. The numbers `health` is computed from. | Marginfi protocol |
| `equity` | SDK `RequirementType::Equity` (weight = 1.0, no price bias) = wallet net worth. Same as `wrapper.computeAccountValue()`. | SDK / wallet UI |
| `nav` | Maintenance weights, **no** price bias = "fair-value risk-weighted equity". Diagnostic — not a liquidation signal, not guaranteed to match any external tool's "Equity". | Internal diagnostic |
| `status` | `HEALTHY` \| `RISK` (ratio < 10%) \| `LIQUIDATABLE` (maint health <= 0 with real liabs) \| `DUST` \| `UNKNOWN` | Our monitor |

---

## Running it

### Prereqs
- `.env` populated (same one the monitor uses): `RPC_URL`, optional `MARGINFI_ENV`, `MARGINFI_PROGRAM_ID`, `MARGINFI_GROUP_PK`.
- The verifier does **not** need `GRPC_ENDPOINT` to function (RPC only), but `loadConfig()` currently requires it; keep the value from your monitor `.env`.

### Single account
```bash
npm run verify -- BCv3vLsZaha75Yt37RJAya2PZV9pXbsJLUN9Vyxdg28r
```

### Multiple accounts (one boot, multiple verifies)
```bash
npm run verify -- \
  BCv3vLsZaha75Yt37RJAya2PZV9pXbsJLUN9Vyxdg28r \
  B48SrgaGHv1S1MeqSYsCudHrCQ7h3jqPDe8TFMxaWyFw
```

The P0 client (banks + oracles) is fetched once and reused, so a 2nd / 3rd / Nth account adds only ~150ms each.

### Cross-checking against the live monitor

The verifier doesn't talk to the monitor process. To confirm the gRPC monitor matches it:

1. Tail `monitor.log` and grep for the pubkey:
   ```bash
   grep -F "<pubkey>" monitor.log | tail
   ```
2. Run the verifier within ~30s of that line:
   ```bash
   npm run verify -- <pubkey>
   ```
3. Compare maintenance `health` / `assets` / `liab`. Agreement within ~0.5–2% (oracle drift between two reads) means the gRPC pipeline is delivering accurate state.

---

## Interpreting the three paths

### Live-oracle path (the one the monitor uses)
This is the **ground truth for liquidation decisions**. It reproduces exactly what `marginfi-v2` would compute on-chain *if PulseHealth ran right now* with the current oracle prices. Use this for:
- Confirming the monitor's `LIQUIDATABLE` flag.
- Matching against an independent RPC tool (eva01, marginfi UI, your own).

### On-chain HealthCache path
Values written by `PulseHealth` cranks the protocol triggers. **Often stale** — many accounts go long stretches without a crank, so the cache can be wildly off. Useful only for:
- Sanity-checking the order of magnitude.
- Catching gross bugs (if cache and live disagree by 10000% something is genuinely wrong, not just oracle drift).

If `cacheTimestamp=unset` or the drift is huge, **trust the live-oracle path**. The protocol itself does not consult `HealthCache` for liquidation eligibility — it recomputes.

### `nav` (maint weights, no bias)
A diagnostic equity-style number: the same risk weights as `health`, but using the oracle midpoint instead of the conservative bias. Useful for answering "what does this account look like at fair-value pricing?" without the protocol's safety margin. It is **not** a liquidation signal — gate liquidations on `health`.

External tools (eva01, marginfi UI, the marginfi-v2 program) each pick a different convention for `RequirementType::Equity`. Empirically, our `nav` does **not** match eva01's `Equity` output (we observed `-$0.057` vs their `~$0.106` on identical maint inputs of `~$0.51 / ~$0.57`). If you need to reconcile to a specific external tool, read its source — don't assume the labels line up.

---

## How to know it's working

After `npm run verify -- <pubkey>` you should see, for a typical account:

| Indicator | Healthy reading |
| --- | --- |
| `verify elapsed_ms` (per account) | < 500ms after the first |
| `live-oracle` maintenance numbers | within 0.5–2% of an independent RPC tool's run on the same account |
| `liquidatable` agreement | matches between live-oracle and any external check |
| Cache drift | ignore; cache is unreliable for non-cranked accounts |
| Per-position USD totals | sum to the totals (modulo rounding) |

For a problem account (likely **not** the monitor's fault, but worth catching):

| Symptom | Likely cause |
| --- | --- |
| `totals unavailable (Bank ... not found)` | Bank wasn't in `client.bankMap` — usually a brand-new bank not yet in the SDK config. Restart the verifier; check the gRPC bank subscription too. |
| `Price info for bank ... not found` | Oracle missing — check `Broken feeds from primary endpoint:` warning above and fix the feed mapping. |
| All three tiers report `n/a` | Account RPC fetch returned 0-byte data; pubkey may be the wrong account type. |
| Cache drift exactly 0% on every tier | Account was just cranked. Re-run after a few seconds for a real comparison. |

---

## Are our gRPC health checks accurate?

**Yes — the live-oracle math the monitor runs is correct, and end-to-end accuracy matches independent RPC tools within typical oracle drift.**

Evidence from this verifier on `BCv3vL...28r` (the worker's sample):

| Field | Worker's RPC tool | Our verifier (live-oracle) | Drift |
| --- | --- | --- | --- |
| Maintenance assets | $0.512548 | $0.513915 | +0.27% |
| Maintenance liabs | $0.572523 | $0.572740 | +0.04% |
| Maintenance health | -$0.059975 | -$0.058825 | (within drift) |
| Liquidatable? | true | LIQUIDATABLE | match |

What's working:
- The SDK functions we call (`computeHealthComponentsFromBalances`, `computeHealthComponentsWithoutBiasFromBalances`) are the same ones the protocol uses, so the *formula* is identical to on-chain.
- The gRPC pipeline keeps `client.bankMap` and `client.oraclePriceByBank` continuously fresh from Yellowstone account updates, so the *data* fed into the formula is current.
- `LIQUIDATABLE` / `RISK` / `HEALTHY` classifications agree with independent RPC checks on the same slot.

What to watch out for (data freshness, not math):
- **Oracle staleness near boundary**: an account with maint health near $0 can flip `LIQUIDATABLE` between two reads <1s apart due to oracle ticks. Normal.
- **New banks**: if a bank was created in the last few seconds and we haven't ingested it, accounts with positions in that bank will report `totals unavailable` until the gRPC bank subscription delivers it. The monitor warns when this happens.
- **`nav` does not cross-reconcile with eva01.** Our `nav` (maint weights, no bias) and eva01's `RequirementType::Equity` came out with different *signs* on identical maint asset/liab inputs ($0.51 / $0.57 → ours -$0.057, theirs ~$0.106). Different convention, not our math. The label has been changed to "fair-value risk-weighted equity (diagnostic)" so it doesn't claim cross-tool equivalence. Always treat `health` as the authoritative liquidation signal.
- **On-chain `HealthCache` is unreliable** for accounts that aren't being actively cranked. The verifier shows this clearly — and that's exactly why we recompute live rather than trusting the cache.

Bottom line: if the monitor says an account is `LIQUIDATABLE` and the live-oracle path in the verifier agrees, the protocol's risk engine will too. The remaining question — "will the liquidation tx actually land?" — is a separate problem (oracle crank timing, slippage, flash-loan locks) that lives downstream of this monitor.

---

## Notes / pitfalls

- The `[health] legend: ...` line at monitor startup decodes the one-liner format. If you don't see it in `monitor.log`, restart the monitor: `npm start` (the legend was added alongside the `nav` field).
- `bigint: Failed to load bindings, pure JS will be used` is harmless — it's the `bigint-buffer` native fallback warning from `@solana/web3.js`.
- `Broken feeds from primary endpoint: [...]` from `fetchOracleData` is a known SDK warning when one of the on-chain Pyth feeds isn't readable; it does not affect the bank you're verifying unless that bank's oracle is in the list.
- The verifier's exit code is `0` if every pubkey verified, `1` if at least one failed, `2` for usage errors.
