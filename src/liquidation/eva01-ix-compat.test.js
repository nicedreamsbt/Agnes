/**
 * Instruction compatibility: Agnes builders vs marginfi IDL (Eva01 parity baseline).
 * Add golden account-meta vectors from Eva01 when porting.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { MARGINFI_PROGRAM, MARGINFI_IDL, deriveFeeState } from "@0dotxyz/p0-ts-sdk";
import { makeStartLiquidationIx, makeEndLiquidationIx } from "./marginfi-receivership.js";
import { deriveLiquidationRecord } from "./pda.js";

function program() {
  const kp = Keypair.generate();
  const connection = new Connection("http://127.0.0.1:8899", "processed");
  const wallet = new Wallet(kp);
  const provider = new AnchorProvider(connection, wallet, AnchorProvider.defaultOptions());
  const idl = { ...MARGINFI_IDL, address: MARGINFI_PROGRAM.toBase58() };
  return new Program(idl, provider);
}

test("start_liquidation discriminator matches IDL", async () => {
  const idlIx = MARGINFI_IDL.instructions.find((i) => i.name === "start_liquidation");
  assert.ok(idlIx);
  const expected = Buffer.from(idlIx.discriminator);
  const p = program();
  const liquidatee = Keypair.generate().publicKey;
  const receiver = Keypair.generate().publicKey;
  const ix = await makeStartLiquidationIx(p, {
    marginfiAccountLiquidatee: liquidatee,
    liquidationReceiver: receiver,
  });
  assert.deepEqual(Buffer.from(ix.data.subarray(0, 8)), expected);
  assert.equal(ix.keys.length, idlIx.accounts.length);

  const obs = [
    { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false },
    { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
  ];
  const ix2 = await makeStartLiquidationIx(p, {
    marginfiAccountLiquidatee: liquidatee,
    liquidationReceiver: receiver,
    startRemainingAccounts: obs,
  });
  assert.equal(ix2.keys.length, idlIx.accounts.length + obs.length);
});

test("end_liquidation discriminator + account count", async () => {
  const idlIx = MARGINFI_IDL.instructions.find((i) => i.name === "end_liquidation");
  assert.ok(idlIx);
  const expected = Buffer.from(idlIx.discriminator);
  const p = program();
  const [feeState] = deriveFeeState(p.programId);
  const liquidatee = Keypair.generate().publicKey;
  const receiver = Keypair.generate().publicKey;
  const feeWallet = Keypair.generate().publicKey;
  const ix = await makeEndLiquidationIx(p, {
    marginfiAccountLiquidatee: liquidatee,
    liquidationReceiver: receiver,
    globalFeeWallet: feeWallet,
    feeState,
  });
  assert.deepEqual(Buffer.from(ix.data.subarray(0, 8)), expected);
  assert.equal(ix.keys.length, idlIx.accounts.length);

  const endBanks = [
    { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
    { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
  ];
  const ix2 = await makeEndLiquidationIx(p, {
    marginfiAccountLiquidatee: liquidatee,
    liquidationReceiver: receiver,
    globalFeeWallet: feeWallet,
    feeState,
    endRemainingAccounts: endBanks,
  });
  assert.equal(ix2.keys.length, idlIx.accounts.length + endBanks.length);
});

test("lending_account_repay IDL layout (meta count for Eva01 diff tooling)", () => {
  const rIdl = MARGINFI_IDL.instructions.find((i) => i.name === "lending_account_repay");
  assert.ok(rIdl);
  assert.equal(rIdl.accounts.length, 7);
});

test("liquidation record PDA derivation is stable", () => {
  const m = Keypair.generate().publicKey;
  const [a] = deriveLiquidationRecord(m, MARGINFI_PROGRAM);
  const [b] = deriveLiquidationRecord(m, MARGINFI_PROGRAM);
  assert.equal(a.toBase58(), b.toBase58());
});
