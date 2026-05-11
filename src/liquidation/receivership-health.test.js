import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { Project0Client, getConfig, MarginfiAccountWrapper } from "@0dotxyz/p0-ts-sdk";
import { buildClassicLiquidateRemainingAccounts } from "./receivership-health.js";

const root = dirname(fileURLToPath(import.meta.url));

test("buildClassicLiquidateRemainingAccounts matches reference liquidation remainingAccounts", async () => {
  const rpcUrl = process.env.RPC_URL;
  assert.ok(rpcUrl, "RPC_URL required for integration test");

  const fixturePath = join(root, "../../debug/reference-liquidation-tx-flash-5nGX.json");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const bt = fixture.builderTest;
  const expected = bt.expectedRemainingMetas;
  assert.equal(expected.length, 20, "fixture should store Anchor remainingAccounts only (after 10 static keys)");

  const connection = new Connection(rpcUrl, "confirmed");
  const client = await Project0Client.initialize(connection, getConfig("production"));

  const liquidateePk = new PublicKey(bt.liquidateeMarginfiPubkey);
  const liquidatorPk = new PublicKey(bt.liquidatorMarginfiPubkey);
  const assetBankPk = new PublicKey(bt.assetBank);
  const liabBankPk = new PublicKey(bt.liabBank);

  const { account: liquidateeAccount } = await client.fetchAccount(liquidateePk, true);
  const { account: liquidatorAccount } = await client.fetchAccount(liquidatorPk, true);
  const liquidateeWrapper = new MarginfiAccountWrapper(liquidateeAccount, client);

  const built = buildClassicLiquidateRemainingAccounts(liquidateeWrapper, liquidatorAccount, client.bankMap, {
    assetBankPk,
    liabBankPk,
  });

  assert.equal(built.liquidateeAccounts, bt.liquidateeAccounts);
  assert.equal(built.liquidatorAccounts, bt.liquidatorAccounts);
  assert.equal(built.remainingAccounts.length, expected.length);

  for (let i = 0; i < expected.length; i++) {
    const a = built.remainingAccounts[i];
    const e = expected[i];
    assert.equal(a.pubkey.toBase58(), e.pubkey, `pubkey mismatch at ${i}`);
    assert.equal(a.isWritable, e.isWritable, `isWritable mismatch at ${i}`);
    assert.equal(a.isSigner, e.isSigner, `isSigner mismatch at ${i}`);
  }
});
