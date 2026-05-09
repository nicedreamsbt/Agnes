# Rust marginfi monitor companion

This crate is a Rust companion to the Node.js monitor in the repository root.

I started with Node.js because the published TypeScript SDK exposes the account wrapper, bank cache, oracle price lookup, and health helpers directly. The official Rust tooling is distributed as the marginfi CLI source inside `marginfi-v2`, so a production Rust service should link that crate/source tree or the exact generated IDL/types used by your deployed program.

What is implemented here:

- the same configuration surface (`RPC_URL`, `GRPC_ENDPOINT`, `GRPC_X_TOKEN`, `MARGINFI_PROGRAM_ID`, `MARGINFI_ACCOUNTS`, `VENUES`, refresh flags);
- Anchor discriminator classification for marginfi program accounts;
- bank/oracle/account cache indexes (`oracle -> banks`, `bank -> accounts`);
- update routing for account, bank, oracle, mint, and unknown marginfi-program-owned updates;
- bank catalog printing including multiple oracle keys/providers;
- local account-health summary aggregation once decoded account positions are supplied.

The default binary is intentionally std-only so it can compile without pulling crates from the network. It accepts replay events from `RUST_REPLAY_EVENTS` to exercise the same routing logic offline. The `live-yellowstone` feature is reserved for wiring this state machine to `yellowstone-grpc-client` plus the marginfi Rust SDK/IDL decoder from `marginfi-v2`.

## Run the Rust monitor core

```bash
cd rust-monitor
cargo run -- --help
RUST_REPLAY_EVENTS=fixtures/events.jsonl cargo run
```

Replay event format is line-delimited key/value pairs:

```text
kind=bank pubkey=Bank111 mint=Mint111 symbol=USDC venue=marginfi oracle_setup=PythPush oracles=OracleA,OracleB
kind=account pubkey=Acct111 authority=Wallet111 positions=Bank111:100:0
kind=oracle pubkey=OracleA slot=123
```

Position format is `bank:asset_value:liability_value`; the Rust core sums those cached values to demonstrate local health aggregation. In production, those position values should be decoded/computed from the marginfi Rust SDK/risk engine exactly like the Node.js monitor uses the TypeScript SDK.
