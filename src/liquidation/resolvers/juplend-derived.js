import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

/** Matches internal P0 constants (`@0dotxyz/p0-ts-sdk` vendor jup-lend). */
export const JUP_LEND_PROGRAM_ID = new PublicKey("jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9");
export const JUP_LIQUIDITY_PROGRAM_ID = new PublicKey("jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC");
export const JUP_REWARDS_PROGRAM_ID = new PublicKey("jup7TthsMgcR9Y3L277b8Eo9uboVSmu1utkuXHNUKar");

const SEED_LENDING_ADMIN = Buffer.from("lending_admin");
const SEED_F_TOKEN_MINT = Buffer.from("f_token_mint");
const SEED_LENDING = Buffer.from("lending");
const SEED_LIQUIDITY = Buffer.from("liquidity");
const SEED_RESERVE = Buffer.from("reserve");
const SEED_RATE_MODEL = Buffer.from("rate_model");
const SEED_USER_SUPPLY_POSITION = Buffer.from("user_supply_position");
const SEED_LENDING_REWARDS_RATE_MODEL = Buffer.from("lending_rewards_rate_model");

export function deriveJupLendFTokenMint(assetMint, lendingProgramId = JUP_LEND_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([SEED_F_TOKEN_MINT, assetMint.toBuffer()], lendingProgramId);
}

export function deriveJupLendLendingPda(assetMint, fTokenMint, lendingProgramId = JUP_LEND_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [SEED_LENDING, assetMint.toBuffer(), fTokenMint.toBuffer()],
    lendingProgramId,
  );
}

export function deriveJupLendLendingAdmin(lendingProgramId = JUP_LEND_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([SEED_LENDING_ADMIN], lendingProgramId);
}

export function deriveJupLendLendingRewardsRateModel(assetMint, rewardsProgramId = JUP_REWARDS_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [SEED_LENDING_REWARDS_RATE_MODEL, assetMint.toBuffer()],
    rewardsProgramId,
  );
}

export function deriveJupLendTokenReserve(assetMint, liquidityProgramId = JUP_LIQUIDITY_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([SEED_RESERVE, assetMint.toBuffer()], liquidityProgramId);
}

export function deriveJupLendRateModel(assetMint, liquidityProgramId = JUP_LIQUIDITY_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([SEED_RATE_MODEL, assetMint.toBuffer()], liquidityProgramId);
}

export function deriveJupLendLiquidity(liquidityProgramId = JUP_LIQUIDITY_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync([SEED_LIQUIDITY], liquidityProgramId);
}

export function deriveJupLendLiquiditySupplyPositionPda(
  underlyingMint,
  lendingPda,
  liquidityProgramId = JUP_LIQUIDITY_PROGRAM_ID,
) {
  return PublicKey.findProgramAddressSync(
    [SEED_USER_SUPPLY_POSITION, underlyingMint.toBuffer(), lendingPda.toBuffer()],
    liquidityProgramId,
  );
}

export function deriveJupLendLiquidityVaultAta(
  underlyingMint,
  liquidityPda,
  tokenProgramId = TOKEN_PROGRAM_ID,
) {
  return getAssociatedTokenAddressSync(
    underlyingMint,
    liquidityPda,
    true,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

/**
 * Same layout as P0 `getAllDerivedJupLendAccounts(mint, tokenProgram)`.
 * @param {PublicKey} mint
 * @param {PublicKey} tokenProgram
 */
export function getAllDerivedJupLendAccounts(mint, tokenProgram) {
  const [fTokenMint] = deriveJupLendFTokenMint(mint);
  const [lending] = deriveJupLendLendingPda(mint, fTokenMint);
  const [liquidity] = deriveJupLendLiquidity();
  return {
    fTokenMint,
    lendingAdmin: deriveJupLendLendingAdmin()[0],
    supplyTokenReservesLiquidity: deriveJupLendTokenReserve(mint)[0],
    lendingSupplyPositionOnLiquidity: deriveJupLendLiquiditySupplyPositionPda(mint, lending)[0],
    rateModel: deriveJupLendRateModel(mint)[0],
    vault: deriveJupLendLiquidityVaultAta(mint, liquidity, tokenProgram),
    liquidity,
    rewardsRateModel: deriveJupLendLendingRewardsRateModel(mint)[0],
  };
}
