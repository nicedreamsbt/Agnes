import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { loadEva01IdlJson } from "../idl/eva01-idl.js";
import { JUP_LEND_PROGRAM_ID } from "./juplend-derived.js";

const JUPLEND_IDL = loadEva01IdlJson("juplend_earn.json");
const LENDING_DISCRIMINATOR = Buffer.from(JUPLEND_IDL.accounts.find((a) => a.name === "Lending").discriminator);
const accountsCoder = new BorshAccountsCoder(JUPLEND_IDL);

/**
 * @param {import("@solana/web3.js").Connection} connection
 * @param {PublicKey} lendingPk
 */
export async function fetchJuplendLending(connection, lendingPk) {
  const ai = await connection.getAccountInfo(lendingPk, "processed");
  if (!ai) throw new Error(`JupLend lending missing: ${lendingPk.toBase58()}`);
  if (!ai.owner.equals(JUP_LEND_PROGRAM_ID)) {
    throw new Error(`JupLend lending ${lendingPk.toBase58()} owned by ${ai.owner.toBase58()}`);
  }
  if (!Buffer.from(ai.data.subarray(0, 8)).equals(LENDING_DISCRIMINATOR)) {
    throw new Error(`JupLend lending ${lendingPk.toBase58()}: bad discriminator`);
  }
  return decodeJuplendLendingAccount(ai.data, lendingPk);
}

/**
 * Normalized shape used by `makeUpdateJupLendRateIx` / `makeJuplendWithdrawIx` (P0-style field names).
 * @param {Buffer} data
 * @param {PublicKey} lendingPk
 */
export function decodeJuplendLendingAccount(data, lendingPk) {
  const d = accountsCoder.decode("Lending", data);
  return {
    pubkey: lendingPk,
    mint: d.mint,
    fTokenMint: d.fTokenMint ?? d.f_token_mint,
    rewardsRateModel: d.rewardsRateModel ?? d.rewards_rate_model,
    tokenReservesLiquidity: d.tokenReservesLiquidity ?? d.token_reserves_liquidity,
    supplyPositionOnLiquidity: d.supplyPositionOnLiquidity ?? d.supply_position_on_liquidity,
    raw: d,
  };
}
