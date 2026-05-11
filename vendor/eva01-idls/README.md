# Eva01 IDL snapshots

JSON IDLs are copied from the upstream Eva01 repository for **decode-at-build-time** (`BorshAccountsCoder`) and optional Anchor `Program` construction (Kamino refresh).

- **Source:** https://github.com/mrgnlabs/eva01/tree/main/idls  
- **Files:** `kamino_lending.json`, `kamino_farms.json`, `drift.json`, `juplend_earn.json`, `liquidity.json`  
- **Update policy:** When on-chain layouts or Eva01 parity requirements change, refresh these files from the same path on `main` (or a pinned commit) and note the upstream git SHA in the commit message.

Do **not** commit keypair material (e.g. `liquidator.json`); this directory is only program IDLs.
