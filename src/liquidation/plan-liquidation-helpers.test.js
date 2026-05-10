import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { AssetTag } from "@0dotxyz/p0-ts-sdk";
import { inferLiquidationExecutionVenue } from "../venues.js";
import { instructionMetasForLog } from "./liq-tx-metadata.js";

test("inferLiquidationExecutionVenue maps AssetTag.KAMINO to kamino", () => {
  const bank = { config: { assetTag: AssetTag.KAMINO } };
  assert.equal(inferLiquidationExecutionVenue(bank), "kamino");
});

test("inferLiquidationExecutionVenue prefers kaminoIntegrationAccounts over DEFAULT tag", () => {
  const bank = {
    config: { assetTag: AssetTag.DEFAULT },
    kaminoIntegrationAccounts: {
      kaminoReserve: Keypair.generate().publicKey,
      kaminoObligation: Keypair.generate().publicKey,
    },
  };
  assert.equal(inferLiquidationExecutionVenue(bank), "kamino");
});

test("instructionMetasForLog skips writable entries without pubkey", () => {
  const pk = Keypair.generate().publicKey;
  const ix = {
    programId: Keypair.generate().publicKey,
    keys: [
      { isWritable: true, isSigner: false },
      { pubkey: pk, isWritable: true, isSigner: false },
    ],
    data: Buffer.alloc(0),
  };
  const [row] = instructionMetasForLog([{ label: "t", ix }], { verbose: false });
  assert.equal(row.writableAccounts.length, 1);
  assert.equal(row.writableAccounts[0], pk.toBase58());
});
