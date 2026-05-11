import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { loadEva01IdlJson } from "../idl/eva01-idl.js";
import { deriveKaminoLendingMarketAuthority, KAMINO_LENDING_PROGRAM_ID } from "../pdas/kamino.js";

const KAMINO_IDL = loadEva01IdlJson("kamino_lending.json");
const RESERVE_DISCRIMINATOR = Buffer.from(KAMINO_IDL.accounts.find((a) => a.name === "Reserve").discriminator);
const accountsCoder = new BorshAccountsCoder(KAMINO_IDL);

function isMeaningfulPubkey(pk) {
  if (!pk) return false;
  const d = PublicKey.default.toBase58();
  return pk.toBase58?.() !== d;
}

/**
 * Oracle pubkeys for `refresh_reserve` (Eva01 `get_oracle_setup`).
 * @param {Record<string, any>} reserveDecoded — `Reserve` from BorshAccountsCoder
 */
export function getKaminoOracleSetup(reserveDecoded) {
  const tokenInfo = reserveDecoded.config?.tokenInfo ?? reserveDecoded.config?.token_info;
  if (!tokenInfo) {
    return { pythOracle: null, switchboardPriceOracle: null, switchboardTwapOracle: null, scopePrices: null };
  }
  const pyth = tokenInfo.pythConfiguration?.price ?? tokenInfo.pyth_configuration?.price ?? null;
  const sw = tokenInfo.switchboardConfiguration ?? tokenInfo.switchboard_configuration;
  const scope = tokenInfo.scopeConfiguration?.priceFeed ?? tokenInfo.scope_configuration?.price_feed ?? null;
  return {
    pythOracle: isMeaningfulPubkey(pyth) ? pyth : null,
    switchboardPriceOracle: isMeaningfulPubkey(sw?.priceAggregator ?? sw?.price_aggregator) ? sw.priceAggregator ?? sw.price_aggregator : null,
    switchboardTwapOracle: isMeaningfulPubkey(sw?.twapAggregator ?? sw?.twap_aggregator) ? sw.twapAggregator ?? sw.twap_aggregator : null,
    scopePrices: isMeaningfulPubkey(scope) ? scope : null,
  };
}

/**
 * @param {import("@solana/web3.js").Connection} connection
 * @param {PublicKey} reservePk
 */
export async function fetchKaminoReserve(connection, reservePk) {
  const ai = await connection.getAccountInfo(reservePk, "processed");
  if (!ai) throw new Error(`Kamino reserve account missing: ${reservePk.toBase58()}`);
  if (!ai.owner.equals(KAMINO_LENDING_PROGRAM_ID)) {
    throw new Error(`Kamino reserve ${reservePk.toBase58()} owned by ${ai.owner.toBase58()}`);
  }
  if (!Buffer.from(ai.data.subarray(0, 8)).equals(RESERVE_DISCRIMINATOR)) {
    throw new Error(`Kamino reserve ${reservePk.toBase58()}: bad discriminator`);
  }
  const decoded = accountsCoder.decode("Reserve", ai.data);
  const lendingMarket = decoded.lendingMarket ?? decoded.lending_market;
  const [lendingMarketAuthority] = deriveKaminoLendingMarketAuthority(lendingMarket);
  const farmCollateral = decoded.farmCollateral ?? decoded.farm_collateral;
  const liquidity = decoded.liquidity;
  const collateral = decoded.collateral;
  return {
    address: reservePk,
    lendingMarket,
    lendingMarketAuthority,
    farmCollateral,
    liquidity: {
      mintPubkey: liquidity.mintPubkey ?? liquidity.mint_pubkey,
      supplyVault: liquidity.supplyVault ?? liquidity.supply_vault,
    },
    collateral: {
      mintPubkey: collateral.mintPubkey ?? collateral.mint_pubkey,
      supplyVault: collateral.supplyVault ?? collateral.supply_vault,
    },
    raw: decoded,
  };
}
