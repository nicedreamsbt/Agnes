import { deriveFeeState } from "@0dotxyz/p0-ts-sdk";

/**
 * Build-path RPC: loads global fee wallet for `end_liquidation` (not hot-path account revalidation).
 * @param {import("@coral-xyz/anchor").Program} program
 */
export async function fetchFeeStateAccounts(program) {
  const [feeState] = deriveFeeState(program.programId);
  const row = await program.account.feeState.fetch(feeState);
  return { feeState, globalFeeWallet: row.globalFeeWallet };
}
