import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { MARGINFI_IDL } from "@0dotxyz/p0-ts-sdk";

const MAINNET_MARGINFI_PROGRAM_ID = new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
import {
  filterInstructionsForLiquidatorFlashProjection,
  marginfiAccountKeyIndexForFlashFilter,
  computeProjectedActiveBanksForFlashEnd,
} from "./flash-projection.js";
import { computeProjectedActiveBanksNoCpi } from "@0dotxyz/p0-ts-sdk";

/** Minimal stub matching `flash-projection` usage (`program.idl`, `program.programId`). */
function stubMarginfiProgram() {
  return { idl: MARGINFI_IDL, programId: MAINNET_MARGINFI_PROGRAM_ID };
}

test("marginfiAccountKeyIndexForFlashFilter normalizes snake_case IDL names", () => {
  assert.equal(marginfiAccountKeyIndexForFlashFilter("lending_account_withdraw"), 1);
  assert.equal(marginfiAccountKeyIndexForFlashFilter("start_liquidation"), 0);
  assert.equal(marginfiAccountKeyIndexForFlashFilter("lendingAccountLiquidate"), 3);
});

test("filterInstructionsForLiquidatorFlashProjection drops liquidatee withdraw", () => {
  const program = stubMarginfiProgram();
  const coder = new anchor.BorshInstructionCoder(program.idl);
  const data = coder.encode("lending_account_withdraw", { amount: new BN(1), withdraw_all: false });
  const liquidatee = Keypair.generate().publicKey;
  const liquidator = Keypair.generate().publicKey;
  const group = Keypair.generate().publicKey;
  const authority = Keypair.generate().publicKey;
  const bank = Keypair.generate().publicKey;
  const dest = Keypair.generate().publicKey;
  const vaultAuth = Keypair.generate().publicKey;
  const vault = Keypair.generate().publicKey;
  const tokenProgram = Keypair.generate().publicKey;
  const ix = new TransactionInstruction({
    programId: program.programId,
    keys: [
      { pubkey: group, isSigner: false, isWritable: false },
      { pubkey: liquidatee, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: bank, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: vaultAuth, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data,
  });
  const filtered = filterInstructionsForLiquidatorFlashProjection([ix], program, liquidator);
  assert.equal(filtered.length, 0);
});

test("filterInstructionsForLiquidatorFlashProjection keeps liquidator withdraw", () => {
  const program = stubMarginfiProgram();
  const coder = new anchor.BorshInstructionCoder(program.idl);
  const data = coder.encode("lending_account_withdraw", { amount: new BN(1), withdraw_all: false });
  const liquidator = Keypair.generate().publicKey;
  const group = Keypair.generate().publicKey;
  const authority = Keypair.generate().publicKey;
  const bank = Keypair.generate().publicKey;
  const dest = Keypair.generate().publicKey;
  const vaultAuth = Keypair.generate().publicKey;
  const vault = Keypair.generate().publicKey;
  const tokenProgram = Keypair.generate().publicKey;
  const ix = new TransactionInstruction({
    programId: program.programId,
    keys: [
      { pubkey: group, isSigner: false, isWritable: false },
      { pubkey: liquidator, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: bank, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: vaultAuth, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data,
  });
  const filtered = filterInstructionsForLiquidatorFlashProjection([ix], program, liquidator);
  assert.equal(filtered.length, 1);
});

test("empty flash projection matches computeProjectedActiveBanksNoCpi baseline", () => {
  const program = stubMarginfiProgram();
  /** @type {import("@0dotxyz/p0-ts-sdk").Balance[]} */
  const balances = [
    {
      active: true,
      bankPk: Keypair.generate().publicKey,
      assetShares: { toString: () => "0" },
      liabilityShares: { toString: () => "0" },
      emissionsOutstanding: { toString: () => "0" },
      lastUpdate: { toNumber: () => 0 },
    },
  ];
  const a = computeProjectedActiveBanksNoCpi(balances, [], program);
  const b = computeProjectedActiveBanksForFlashEnd(balances, [], program, {});
  assert.deepEqual(
    a.map((p) => p.toBase58()),
    b.map((p) => p.toBase58()),
  );
});
