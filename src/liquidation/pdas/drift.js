import BN from "bn.js";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

export const DRIFT_PROGRAM_ID = new PublicKey("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH");

const SEED_DRIFT_STATE = Buffer.from("drift_state");
const SEED_SPOT_MARKET_VAULT = Buffer.from("spot_market_vault");
const SEED_DRIFT_SIGNER = Buffer.from("drift_signer");

/** Same discriminator as @0dotxyz/p0-ts-sdk `makeUpdateSpotMarketCumulativeInterestIx`. */
export const UPDATE_SPOT_MARKET_CUMULATIVE_INTEREST_DISCRIMINATOR = Buffer.from([
  39, 166, 139, 243, 158, 165, 155, 225,
]);

export function deriveDriftState(programId = DRIFT_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([SEED_DRIFT_STATE], programId);
}

export function deriveDriftSigner(programId = DRIFT_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([SEED_DRIFT_SIGNER], programId);
}

export function deriveDriftSpotMarketVault(marketIndex, programId = DRIFT_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [SEED_SPOT_MARKET_VAULT, new BN(marketIndex).toArrayLike(Buffer, "le", 2)],
    programId,
  );
}

/**
 * @param {object} spotDecoded — output of `decodeDriftSpotMarketAccount`
 * @param {PublicKey} spotMarketPk
 */
export function makeDriftRefreshSpotMarketIx(spotDecoded, spotMarketPk) {
  const [driftState] = deriveDriftState();
  const [vault] = deriveDriftSpotMarketVault(spotDecoded.marketIndex);
  const keys = [
    { pubkey: driftState, isSigner: false, isWritable: false },
    { pubkey: spotMarketPk, isSigner: false, isWritable: true },
    { pubkey: spotDecoded.oracle, isSigner: false, isWritable: false },
    { pubkey: vault, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({
    keys,
    programId: DRIFT_PROGRAM_ID,
    data: UPDATE_SPOT_MARKET_CUMULATIVE_INTEREST_DISCRIMINATOR,
  });
}
