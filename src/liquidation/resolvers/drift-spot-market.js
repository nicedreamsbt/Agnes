import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { loadEva01IdlJson } from "../idl/eva01-idl.js";
import { DRIFT_PROGRAM_ID } from "../pdas/drift.js";

const DRIFT_IDL = loadEva01IdlJson("drift.json");
const SPOT_DISCRIMINATOR = Buffer.from(DRIFT_IDL.accounts.find((a) => a.name === "SpotMarket").discriminator);
const accountsCoder = new BorshAccountsCoder(DRIFT_IDL);

/**
 * @param {import("@solana/web3.js").Connection} connection
 * @param {PublicKey} spotMarketPk
 */
export async function fetchDriftSpotMarket(connection, spotMarketPk) {
  const ai = await connection.getAccountInfo(spotMarketPk, "processed");
  if (!ai) throw new Error(`Drift spot market missing: ${spotMarketPk.toBase58()}`);
  if (!ai.owner.equals(DRIFT_PROGRAM_ID)) {
    throw new Error(`Drift spot market ${spotMarketPk.toBase58()} owned by ${ai.owner.toBase58()}`);
  }
  if (!Buffer.from(ai.data.subarray(0, 8)).equals(SPOT_DISCRIMINATOR)) {
    throw new Error(`Drift spot market ${spotMarketPk.toBase58()}: bad discriminator`);
  }
  return decodeDriftSpotMarketAccount(ai.data, spotMarketPk);
}

/**
 * @param {Buffer} data
 * @param {PublicKey} spotMarketPk
 */
export function decodeDriftSpotMarketAccount(data, spotMarketPk) {
  const d = accountsCoder.decode("SpotMarket", data);
  return {
    pubkey: spotMarketPk,
    oracle: d.oracle,
    mint: d.mint,
    vault: d.vault,
    marketIndex: d.marketIndex ?? d.market_index,
  };
}
