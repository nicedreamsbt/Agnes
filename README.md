# Marginfi gRPC Account State Monitor

This repository contains a read-only Node.js monitor that preloads marginfi market state and user accounts, subscribes to Yellowstone gRPC account updates, keeps local caches hot, and prints affected account health whenever an oracle, bank, mint, or account changes.

marginfi / Project Zero represents supported venues such as Kamino, JupLend, and Drift as marginfi banks/assets. The monitor therefore uses the marginfi SDK as the single source of truth for account state and health instead of loading separate protocol SDKs.

## What it preloads

On startup the monitor:

1. Builds a read-only `MarginfiClient` with the official `@mrgnlabs/marginfi-client-v2` SDK.
2. Loads every SDK bank, including banks that represent external venues such as Kamino, JupLend, and Drift.
3. Indexes each bank's oracle accounts, infers a display venue from SDK bank metadata/symbols, and prints a bank catalog with each bank's oracle setup and oracle keys.
4. Fetches and decodes token mint accounts for bank mints.
5. Fetches all marginfi account addresses in the configured group, or only `MARGINFI_ACCOUNTS` if supplied.
6. Decodes marginfi accounts through `MarginfiAccountWrapper.fromAccountDataRaw` and indexes `bank -> marginfi accounts`.

## What it streams

Yellowstone is wired with **program owner** filters, not a per-pubkey list of every marginfi user:

1. **`marginfi_program`** — `owner =` the marginfi v2 program id. That single filter delivers **all** program-owned accounts (banks, user marginfi accounts, and any other marginfi PDAs). The handler uses the Anchor discriminator / IDL helpers in [`src/idl.js`](src/idl.js) client-side to classify `Bank` vs `MarginfiAccount` vs other layouts and only act on what it understands.

2. **`oracle_owner_*`** — one entry per distinct **oracle account owner program** (Switchboard, Pyth Push, Drift oracle program, etc.), discovered from on-chain owners of the bank `oracleKeys` set (see below). The node receives every account owned by those programs; the handler **ignores** updates unless `pubkey` is in the watched oracle pubkey set built from banks.

3. **Optional `GRPC_SUBSCRIBE_SLOTS`** — slot ticks for labeling / debugging.

**Not** the default model: `GRPC_SUBSCRIBE_EXPLICIT_ACCOUNTS=true` adds a second filter that lists individual marginfi user pubkeys. That duplicates (1) for full groups and is only useful for a **small** explicit allowlist (e.g. `MARGINFI_ACCOUNTS` debugging).

### gRPC oracle mapping (not `OracleSetup` streams)

Oracle coverage is **not** wired as separate Yellowstone filters per marginfi `OracleSetup` variant. The watch set is every non-system pubkey in each bank’s `config.oracleKeys` (the same keys the SDK uses for that bank’s oracle layout). For each of those pubkeys the monitor RPCs `getMultipleAccountsInfo`, collects each account’s **owner program**, and subscribes with one Yellowstone **owner** filter per distinct program (plus Pyth Push and optional `GRPC_ORACLE_OWNER_PROGRAMS`). Unrelated accounts under those programs are ignored unless the pubkey is in the watched oracle set. So the pipeline is: **bank state → oracle pubkeys → on-chain owner → owner filters**, with **client-side filtering** to the watched oracle keys.

Optional: set `GRPC_SUBSCRIBE_SLOTS=true` to add a Yellowstone **slots** filter (chain slot ticks). Account updates already include a `slot` field on each message; oracle log lines include that slot when present.

When an oracle account changes, the monitor finds every marginfi bank that references that oracle, then every cached marginfi account with an active balance in those banks, and prints the account's quantities and USD assets/liabilities/health using SDK `Balance.computeUsdValue` for equity, initial, and maintenance requirement types. After a refresh, the `[oracle]` line also prints a compact **oracleUsd** snippet (SDK price per linked bank). If no marginfi user accounts are cached yet, you will see the oracle line without following account lines—that is expected until `accountByKey` is populated (gRPC updates or `RPC_PRELOAD_MARGINFI_ACCOUNTS`).


## Update behavior

Yes: the monitor prints a decoded account state directly when a watched marginfi account receives a gRPC account update.

For market-side updates, it prints linked account states instead of only the updated market account:

- **Oracle update**: finds every cached marginfi bank that lists the oracle, then prints every cached marginfi account with an active balance in those banks.
- **Bank update**: updates the cached bank, then prints every cached marginfi account with an active balance in that bank.
- **Mint update**: refreshes the cached mint metadata. Mint updates do not currently trigger account-state output because mint metadata changes do not directly identify a smaller linked-account health set.
- **New marginfi-program account update**: identifies the Anchor account discriminator, logs the account type, and then handles known layouts. New `MarginfiAccount` layouts are decoded, tracked, and printed; new `Bank` layouts update the bank cache and fan out to linked accounts.

Account output is always recomputed from the cached full marginfi account and current SDK bank/oracle state, so linked oracle/bank updates show full-account health rather than only the changed position.



## Oracle types

No: not every marginfi bank has to use a Pyth oracle. Each bank carries its own oracle setup and oracle account keys, and the monitor discovers those accounts from the bank config. marginfi commonly uses Pyth/Pyth Push and Switchboard, and some configurations can include fixed or venue-specific oracle accounts. Because the oracle type and price-bias logic are bank-specific, the monitor does not assume every oracle account is Pyth or try to parse all raw oracle account bytes itself.

Instead, gRPC oracle writes are used as the trigger, while account health is computed through the marginfi SDK using `client.getOraclePriceByBank(bank.address)` and `balance.computeUsdValue(...)`. This keeps the monitor aligned with the SDK's supported oracle setup for each bank.

## RPC vs local health math

The startup bank catalog can be disabled with `PRINT_BANK_CATALOG=false` if the full bank/oracle listing is too noisy.

The arithmetic for a printed account state is local: it uses cached decoded marginfi accounts, cached SDK banks, and SDK oracle-price objects already loaded into the `MarginfiClient`. The calculation path is `client.getBankByPk(...)`, `client.getOraclePriceByBank(...)`, and `balance.computeUsdValue(...)`.

RPC is still used for data loading and refreshes:

- initial SDK/client and bank/oracle preload;
- initial marginfi account and mint fetches;
- periodic market refreshes;
- the optional `REFRESH_ORACLES_ON_UPDATE=true` SDK market refresh after an oracle gRPC write.

So the health calculation itself is not an RPC formula call, but if oracle-refresh-on-update is enabled the monitor intentionally performs an SDK/RPC refresh immediately before printing oracle-linked health so prices stay aligned with SDK oracle parsing.

## IDL/discriminator handling

marginfi accounts are Anchor accounts, so the first eight bytes identify the account layout. The monitor now classifies unknown marginfi-program-owned updates by Anchor discriminator before deciding what to do with them. That lets it understand and log program-owned updates instead of blindly trying only a marginfi-account decode. Known `MarginfiAccount` updates are tracked and printed, known `Bank` updates are cached and linked-account output is triggered, and other known/unknown program layouts are logged for visibility.

## Venue filtering

Venue labels on each bank come from the marginfi SDK’s decoded `config.oracleSetup`, `config.assetTag`, and optional integrator account handles on the `Bank` model—not from heuristics on the token name.

Use `VENUES` to limit which bank updates/oracle-linked banks trigger output:

```env
VENUES=all
# or
VENUES=kamino,juplend,drift,solend
```

The filter only controls printing triggers. Health is always computed from the complete marginfi account so cross-venue collateral and debt remain accurate.


## Rust companion version

A Rust companion implementation lives in `rust-monitor/`. I originally built the Node.js service first because the published TypeScript SDK exposes the marginfi account wrapper, oracle price lookup, and health helpers directly. The Rust companion mirrors the monitor state machine and cache/index behavior in a std-only crate so it can be compiled in restricted environments, and it is structured for live wiring to `yellowstone-grpc-client` plus the marginfi Rust SDK/IDL decoder from `marginfi-v2`.

```bash
cd rust-monitor
cargo run -- --help
RUST_REPLAY_EVENTS=fixtures/events.jsonl cargo run
```

The Rust core supports replaying bank/account/oracle/mint/program updates, printing bank catalogs with multiple oracle keys, routing oracle updates through `oracle -> banks -> accounts`, and aggregating local account health values supplied by the decoder layer.

## Setup

```bash
cp .env.example .env
npm install
npm start
```

Liquidation transaction smoke harness (dry-run by default): `npm run liq:smoke` or `pnpm run liq:smoke`. Set `LIQ_SMOKE_ENABLED=true` and `LIQ_SMOKE_TARGET_ACCOUNT` (see `.env.example`).

Set `GRPC_ENDPOINT` and `GRPC_X_TOKEN` to your Yellowstone / Dragon's Mouth provider. `RPC_URL` is used for the initial snapshot and SDK market refreshes.

For a smaller first run, set `MARGINFI_ACCOUNTS` to a comma-separated list of marginfi account pubkeys.

### Catalog noise (`status=missing`)

By default, when the group lists more than `CATALOG_SUMMARY_THRESHOLD` marginfi account addresses (500), the catalog runs in **summary** mode: it prints counts and only health lines for accounts already in the cache—**not** one `status=missing` line per pubkey. Use `CATALOG_MODE=full` to force the old per-key listing (very large groups will spam logs). Set `RPC_PRELOAD_MARGINFI_ACCOUNTS=true` to batch-fetch and decode up to `RPC_PRELOAD_MAX_ACCOUNTS` user accounts over RPC at startup so the cache is warm before gRPC catches up. Preload tries a single full-data `getProgramAccounts` when the full cap slice is still missing from disk (`RPC_PRELOAD_USE_GPA`); otherwise it uses parallel `getMultipleAccountsInfo` with periodic `[preload]` progress lines. Raw account bytes are optionally persisted under `AGNES_MARGINFI_ACCOUNT_CACHE_FILE` so the next process start can decode from disk first and skip most preload RPC.

### Slot and oracle logging env vars

| Variable | Default | Purpose |
|----------|---------|---------|
| `GRPC_SUBSCRIBE_SLOTS` | `false` | Add Yellowstone slot subscription |
| `GRPC_LOG_SLOT_UPDATES` | `false` | Log each slot message (noisy) |
| `GRPC_LOG_ACCOUNT_UPDATE_SLOT` | `false` | Log slot on marginfi `Bank` / `MarginfiAccount` updates |
| `GRPC_SUBSCRIBE_EXPLICIT_ACCOUNTS` | `false` | Extra subscribe entry listing every marginfi user pubkey. For mainnet-sized groups keep **`false`**: the `marginfi_program` owner filter already receives all program-owned accounts; repeating hundreds of thousands of pubkeys can overload the provider and make live `[account]` / `[oracle]` lines look “stuck” until a huge snapshot drains. |
| `CATALOG_MODE` | `auto` | `auto` \| `summary` \| `full` |
| `CATALOG_SUMMARY_THRESHOLD` | `500` | In `auto`, use summary when the group has more addresses than this |
| `RPC_PRELOAD_MARGINFI_ACCOUNTS` | `false` | RPC batch preload user accounts into cache |
| `RPC_PRELOAD_MAX_ACCOUNTS` | `50000` | Cap for preload |
| `RPC_PRELOAD_CONCURRENCY` | `16` | Max parallel `getMultipleAccountsInfo` chunk requests during preload |
| `RPC_PRELOAD_CHUNK_SIZE` | `100` | Accounts per chunk (max 100) |
| `RPC_PRELOAD_PROGRESS_INTERVAL_MS` | `1000` | Progress log interval during MGA preload |
| `RPC_PRELOAD_USE_GPA` | `true` | Try one `getProgramAccounts` (full data) before MGA; auto-skipped when partial disk cache hits |
| `AGNES_MARGINFI_ACCOUNT_CACHE_FILE` | `.cache/marginfi-accounts.json` | Persist raw account bytes; set to `""` to disable |
| `AGNES_MARGINFI_ACCOUNT_CACHE_SAVE_DEBOUNCE_MS` | `30000` | Debounce writes after gRPC account updates |

## Important implementation notes

- The monitor treats gRPC oracle writes as the trigger source. By default it also refreshes SDK market data after an oracle write (`REFRESH_ORACLES_ON_UPDATE=true`) so health math stays aligned with the SDK's oracle parsing and price-bias logic.
- The marginfi account and bank caches are updated directly from gRPC account data.
- The health printout includes per-position venue labels, token quantities, per-position USD assets/liabilities, and account totals for equity, initial, and maintenance.
- The process is intentionally read-only. The wallet object refuses to sign transactions.

## npm overrides (`rpc-websockets` / `uuid`)

`@pythnetwork/pyth-solana-receiver` pulls `jito-ts` → an older `@solana/web3.js` that expects `rpc-websockets@7.x` (CommonClient path). A hoisted `rpc-websockets@9` breaks that subtree at runtime.

`package.json` **`overrides`** pins `rpc-websockets@7.11.2` under **`jito-ts` → `@solana/web3.js` only**, and pins **`uuid@8.3.2`** globally so both `rpc-websockets@7` (jito) and `rpc-websockets@9` (top-level `@solana/web3.js`) resolve a CJS-compatible `uuid` (avoids `ERR_REQUIRE_ESM` from `uuid@9`).

Removing these overrides without replacing them (e.g. upgrading `jito-ts` / receiver deps) will likely re-break `npm run liq:smoke` / Hermes + Pyth receiver startup.
