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

The Yellowstone subscription tracks three account groups:

- explicitly preloaded marginfi accounts;
- all accounts owned by the marginfi v2 program so newly-touched program accounts can be observed;
- marginfi market accounts: banks, bank mints, and bank oracle accounts.

When an oracle account changes, the monitor finds every marginfi bank that references that oracle, then every cached marginfi account with an active balance in those banks, and prints the account's quantities and USD assets/liabilities/health using SDK `Balance.computeUsdValue` for equity, initial, and maintenance requirement types.


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

Use `VENUES` to limit which bank updates/oracle-linked banks trigger output:

```env
VENUES=all
# or
VENUES=kamino,juplend,drift
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

Set `GRPC_ENDPOINT` and `GRPC_X_TOKEN` to your Yellowstone / Dragon's Mouth provider. `RPC_URL` is used for the initial snapshot and SDK market refreshes.

For a smaller first run, set `MARGINFI_ACCOUNTS` to a comma-separated list of marginfi account pubkeys.

## Important implementation notes

- The monitor treats gRPC oracle writes as the trigger source. By default it also refreshes SDK market data after an oracle write (`REFRESH_ORACLES_ON_UPDATE=true`) so health math stays aligned with the SDK's oracle parsing and price-bias logic.
- The marginfi account and bank caches are updated directly from gRPC account data.
- The health printout includes per-position venue labels, token quantities, per-position USD assets/liabilities, and account totals for equity, initial, and maintenance.
- The process is intentionally read-only. The wallet object refuses to sign transactions.
