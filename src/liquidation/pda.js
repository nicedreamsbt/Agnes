import { PublicKey } from "@solana/web3.js";

const LIQ_RECORD_SEED = Buffer.from("liq_record");

/**
 * @param {PublicKey} marginfiAccountPk
 * @param {PublicKey} programId
 */
export function deriveLiquidationRecord(marginfiAccountPk, programId) {
  return PublicKey.findProgramAddressSync([LIQ_RECORD_SEED, marginfiAccountPk.toBuffer()], programId);
}
