import { PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import { deriveLiquidationRecord } from "./pda.js";

/**
 * Permissionless: create the liquidation record PDA for a marginfi user (required before start_liquidation).
 * @param {import("@coral-xyz/anchor").Program} program
 * @param {object} acc
 * @param {PublicKey} acc.marginfiAccountLiquidatee
 * @param {PublicKey} acc.feePayer signer; pays rent
 */
export async function makeInitLiquidationRecordIx(program, acc) {
  const [liquidationRecord] = deriveLiquidationRecord(acc.marginfiAccountLiquidatee, program.programId);
  return program.methods
    .marginfiAccountInitLiqRecord()
    .accounts({
      marginfiAccount: acc.marginfiAccountLiquidatee,
      feePayer: acc.feePayer,
      liquidationRecord,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export async function makeStartLiquidationIx(program, acc) {
  const [liquidationRecord] = deriveLiquidationRecord(acc.marginfiAccountLiquidatee, program.programId);
  const builder = program.methods.startLiquidation().accounts({
    marginfiAccount: acc.marginfiAccountLiquidatee,
    liquidationRecord,
    liquidationReceiver: acc.liquidationReceiver,
    instructionSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
  });
  if (acc.startRemainingAccounts?.length) {
    builder.remainingAccounts(acc.startRemainingAccounts);
  }
  return builder.instruction();
}

/**
 * @param {import("@coral-xyz/anchor").Program} program
 * @param {object} acc
 * @param {PublicKey} acc.marginfiAccountLiquidatee
 * @param {PublicKey} acc.liquidationReceiver
 * @param {PublicKey} acc.globalFeeWallet
 * @param {import("@solana/web3.js").AccountMeta[]} [acc.endRemainingAccounts] writable bank keys (Eva01)
 */
export async function makeEndLiquidationIx(program, acc) {
  const [liquidationRecord] = deriveLiquidationRecord(acc.marginfiAccountLiquidatee, program.programId);
  const builder = program.methods.endLiquidation().accounts({
    marginfiAccount: acc.marginfiAccountLiquidatee,
    liquidationRecord,
    liquidationReceiver: acc.liquidationReceiver,
    feeState: acc.feeState,
    globalFeeWallet: acc.globalFeeWallet,
  });
  if (acc.endRemainingAccounts?.length) {
    builder.remainingAccounts(acc.endRemainingAccounts);
  }
  return builder.instruction();
}

/**
 * Permissionless `lending_account_liquidate` (classic liquidation, often inside a flash loan).
 * @param {import("@coral-xyz/anchor").Program} program
 * @param {object} acc
 * @param {PublicKey} acc.group
 * @param {PublicKey} acc.assetBank
 * @param {PublicKey} acc.liabBank
 * @param {PublicKey} acc.liquidatorMarginfiAccount
 * @param {PublicKey} acc.authority
 * @param {PublicKey} acc.liquidateeMarginfiAccount
 * @param {PublicKey} acc.tokenProgram
 * @param {import("@solana/web3.js").AccountMeta[]} acc.remainingAccounts
 * @param {object} args
 * @param {import("bn.js")} args.assetAmount
 * @param {number} args.liquidateeAccounts u8
 * @param {number} args.liquidatorAccounts u8
 */
export async function makeClassicLendingLiquidateIx(program, acc, args) {
  return program.methods
    .lendingAccountLiquidate(args.assetAmount, args.liquidateeAccounts, args.liquidatorAccounts)
    .accounts({
      group: acc.group,
      assetBank: acc.assetBank,
      liabBank: acc.liabBank,
      liquidatorMarginfiAccount: acc.liquidatorMarginfiAccount,
      authority: acc.authority,
      liquidateeMarginfiAccount: acc.liquidateeMarginfiAccount,
      tokenProgram: acc.tokenProgram,
    })
    .remainingAccounts(acc.remainingAccounts)
    .instruction();
}

/**
 * Repay during receivership — `authority` may be any signer per IDL.
 * @param {import("@coral-xyz/anchor").Program} program
 */
export async function makeRepayIx(program, acc, args) {
  return program.methods
    .lendingAccountRepay(new BN(args.amount.toString()), args.repayAll ?? null)
    .accounts({
      group: acc.group,
      marginfiAccount: acc.marginfiAccount,
      authority: acc.authority,
      bank: acc.bank,
      signerTokenAccount: acc.signerTokenAccount,
      liquidityVault: acc.liquidityVault,
      tokenProgram: acc.tokenProgram,
    })
    .instruction();
}
