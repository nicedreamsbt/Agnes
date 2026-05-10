import { PublicKey } from "@solana/web3.js";

/** Kamino KLend program (matches P0 / Eva01). */
export const KAMINO_LENDING_PROGRAM_ID = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

/** Kamino Farms program (matches P0 / Eva01). */
export const KAMINO_FARMS_PROGRAM_ID = new PublicKey("FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr");

const SEED_LENDING_MARKET_AUTH = Buffer.from("lma");
const SEED_USER_STATE = Buffer.from("user");

export function deriveKaminoLendingMarketAuthority(lendingMarketPk) {
  return PublicKey.findProgramAddressSync(
    [SEED_LENDING_MARKET_AUTH, lendingMarketPk.toBuffer()],
    KAMINO_LENDING_PROGRAM_ID,
  );
}

/**
 * @param {PublicKey} farmsProgramId
 * @param {PublicKey} farmStatePk
 * @param {PublicKey} obligationPk
 */
export function deriveKaminoUserFarmState(farmsProgramId, farmStatePk, obligationPk) {
  return PublicKey.findProgramAddressSync(
    [SEED_USER_STATE, farmStatePk.toBuffer(), obligationPk.toBuffer()],
    farmsProgramId,
  );
}
