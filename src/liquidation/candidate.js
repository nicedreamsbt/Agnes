import { PublicKey } from "@solana/web3.js";
import { MarginRequirementType, uiToNative } from "@0dotxyz/p0-ts-sdk";
import { BigNumber } from "bignumber.js";
import BN from "bn.js";
import { getActiveBalances, summarizeAccountState, computeMaintRatio, computeStatus } from "../health.js";
import { inferLiquidationExecutionVenue } from "../venues.js";
import { buildCacheFreshness, isFresh } from "./cache-freshness.js";
import { collectIntegrationPubkeysFromBank } from "./integration-accounts.js";

/** @typedef {import("./cache-freshness.js").CacheFreshness} CacheFreshness */

export const SkipReason = {
  SKIP_HEALTH_POSITIVE: "SKIP_HEALTH_POSITIVE",
  SKIP_DUST_DEBT: "SKIP_DUST_DEBT",
  SKIP_DUST_HEALTH: "SKIP_DUST_HEALTH",
  SKIP_UNKNOWN_VENUE: "SKIP_UNKNOWN_VENUE",
  SKIP_STALE_CACHE: "SKIP_STALE_CACHE",
  SKIP_NO_JUPITER_ROUTE: "SKIP_NO_JUPITER_ROUTE",
  SKIP_TX_TOO_LARGE: "SKIP_TX_TOO_LARGE",
  SKIP_SIM_FAILED: "SKIP_SIM_FAILED",
  SKIP_PROFIT_TOO_LOW: "SKIP_PROFIT_TOO_LOW",
  SKIP_FLASH_REPAY_NOT_COVERED: "SKIP_FLASH_REPAY_NOT_COVERED",
  SKIP_ORACLE_STALE: "SKIP_ORACLE_STALE",
  SKIP_INTEGRATION_STALE: "SKIP_INTEGRATION_STALE",
  SKIP_NOT_LIQUIDATABLE: "SKIP_NOT_LIQUIDATABLE",
  SKIP_NO_POSITIONS: "SKIP_NO_POSITIONS",
  SKIP_SOLEND_UNSUPPORTED: "SKIP_SOLEND_UNSUPPORTED",
  SKIP_BANK_HYDRATION: "SKIP_BANK_HYDRATION",
  /** Classic flash liquidation needs AGNES_LIQUIDATOR_MARGINFI_ACCOUNT (decoded). */
  SKIP_CLASSIC_REQUIRES_LIQUIDATOR_MARGINFI: "SKIP_CLASSIC_REQUIRES_LIQUIDATOR_MARGINFI",
  /** lending_account_liquidate path is marginfi-native only (no Kamino/Drift withdraw leg). */
  SKIP_CLASSIC_MARGINFI_NATIVE_ONLY: "SKIP_CLASSIC_MARGINFI_NATIVE_ONLY",
};

function getShareMultiplier(client, bank) {
  return client.assetShareValueMultiplierByBank?.get(bank.address.toBase58());
}

function bnToBigInt(bn) {
  if (!bn) return 0n;
  if (typeof bn === "bigint") return bn;
  if (bn.toArrayLike) {
    const hex = bn.toString(16);
    return BigInt(hex ? "0x" + hex : "0");
  }
  return BigInt(String(bn));
}

function mintDecimalsToNumber(mintDecimals) {
  if (mintDecimals == null) return 0;
  if (typeof mintDecimals === "number" && Number.isFinite(mintDecimals)) return mintDecimals;
  if (typeof mintDecimals === "bigint") return Number(mintDecimals);
  if (BN.isBN(mintDecimals)) return mintDecimals.toNumber();
  if (typeof mintDecimals.toNumber === "function") {
    try {
      const n = mintDecimals.toNumber();
      if (Number.isFinite(n)) return n;
    } catch {
      /* fall through */
    }
  }
  const parsed = Number.parseInt(String(mintDecimals), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Top collateral and liability banks for liquidation routing (same scoring as production).
 * @param {import("@0dotxyz/p0-ts-sdk").MarginfiAccountWrapper} wrapper
 * @param {import("@0dotxyz/p0-ts-sdk").Project0Client} client
 */
export function scoreLiquidationAssetLiabilityBanks(wrapper, client) {
  const summary = summarizeAccountState(wrapper, client);
  const balances = getActiveBalances(wrapper);
  const scoredAssets = [];
  const scoredLiabs = [];

  for (const balance of balances) {
    const bank = client.getBank(balance.bankPk);
    if (!bank) continue;
    const mult = getShareMultiplier(client, bank);
    const oraclePrice = client.oraclePriceByBank.get(bank.address.toBase58());
    if (!oraclePrice) continue;
    if (!balance.assetShares?.isZero?.()) {
      try {
        const usd = balance.getUsdValueWithPriceBias(bank, oraclePrice, MarginRequirementType.Maintenance, mult);
        const a = toNum(usd.assets);
        if (a > 0) scoredAssets.push({ balance, bank, usdMaintAssets: a });
      } catch {
        /* skip */
      }
    }
    if (!balance.liabilityShares?.isZero?.()) {
      try {
        const usd = balance.getUsdValueWithPriceBias(bank, oraclePrice, MarginRequirementType.Maintenance, mult);
        const l = toNum(usd.liabilities);
        if (l > 0) scoredLiabs.push({ balance, bank, usdMaintLiabs: l });
      } catch {
        /* skip */
      }
    }
  }

  scoredAssets.sort((x, y) => y.usdMaintAssets - x.usdMaintAssets);
  scoredLiabs.sort((x, y) => y.usdMaintLiabs - x.usdMaintLiabs);

  return { summary, balances, scoredAssets, scoredLiabs };
}

/** ~0.0001 of token unit when decimals allow; else 1 native unit (smoke / sim probe). */
function nativeDustAmount(mintDecimals) {
  const md = mintDecimalsToNumber(mintDecimals);
  const exp = Math.max(0, Math.min(md, 9) - 4);
  return 10n ** BigInt(exp);
}

function clampDustToPosition(dust, positionMax) {
  if (positionMax <= 0n) return 0n;
  return dust < positionMax ? dust : positionMax;
}

/**
 * Same bank pair as production candidates, but tiny withdraw/repay sizes to exercise ix build + sim
 * without requiring the account to be liquidatable.
 * @param {import("@0dotxyz/p0-ts-sdk").MarginfiAccountWrapper} wrapper
 * @param {import("@0dotxyz/p0-ts-sdk").Project0Client} client
 * @param {import("./slot-tracker.js").SlotTracker} slotTracker
 * @param {object} cfg
 * @returns {{ candidate: object | null, skipReason?: string }}
 */
export function buildSmokeLiquidationCandidate(wrapper, client, slotTracker, cfg) {
  const { summary, balances, scoredAssets, scoredLiabs } = scoreLiquidationAssetLiabilityBanks(wrapper, client);

  if (scoredAssets.length === 0 || scoredLiabs.length === 0) {
    return { candidate: null, skipReason: SkipReason.SKIP_NO_POSITIONS };
  }

  const { bank: assetBank, balance: assetBalance } = scoredAssets[0];
  const { bank: liabBank, balance: liabBalance } = scoredLiabs[0];

  const t = summary.totals;
  const maintAssetsUsd = t?.maintenance?.assets ?? 0;
  const maintLiabsUsd = t?.maintenance?.liabilities ?? 0;
  const maintHealthUsd = t?.maintenance?.health ?? 0;
  const ratio = t ? computeMaintRatio(t) : NaN;
  const maintRatioPct = Number.isFinite(ratio) ? ratio * 100 : 0;
  const rawAssetsUsd = t?.navMaint?.assets ?? 0;
  const rawLiabsUsd = t?.navMaint?.liabilities ?? 0;
  const equityUsd = t?.equity?.health ?? 0;

  const multA = getShareMultiplier(client, assetBank);
  const multL = getShareMultiplier(client, liabBank);
  const qtyA = assetBalance.computeQuantityUi(assetBank, multA);
  const qtyL = liabBalance.computeQuantityUi(liabBank, multL);
  const assetUi = toBigNumber(qtyA.assets);
  const liabUiL = toBigNumber(qtyL.liabilities);
  const fullAsset = bnToBigInt(uiToNative(assetUi, mintDecimalsToNumber(assetBank.mintDecimals)));
  const fullLiab = bnToBigInt(uiToNative(liabUiL, mintDecimalsToNumber(liabBank.mintDecimals)));

  const dustA = nativeDustAmount(assetBank.mintDecimals);
  const dustL = nativeDustAmount(liabBank.mintDecimals);
  const maxAssetAmount = clampDustToPosition(dustA, fullAsset);
  const maxLiabAmount = clampDustToPosition(dustL, fullLiab);

  if (maxAssetAmount <= 0n || maxLiabAmount <= 0n) {
    return { candidate: null, skipReason: SkipReason.SKIP_NO_POSITIONS };
  }

  const venue = inferLiquidationExecutionVenue(assetBank);

  const banksInHealth = [...new Set(balances.map((b) => b.bankPk.toBase58()))];
  const oraclesInHealth = uniqueOracleKeys([assetBank, liabBank]);
  const observationAccounts = oraclesInHealth.map((s) => new PublicKey(s));

  const integrationKeys = uniqueKeys([
    ...collectIntegrationPubkeysFromBank(assetBank),
    ...collectIntegrationPubkeysFromBank(liabBank),
  ]);

  const thresholds = {
    maxAccountLagSlots: cfg.maxAccountLagSlots,
    maxBankLagSlots: cfg.maxBankLagSlots,
    maxOracleLagSlots: cfg.maxOracleLagSlots,
    maxIntegrationLagSlots: cfg.maxIntegrationLagSlots,
  };

  const cacheFreshness = buildCacheFreshness({
    slotTracker,
    marginfiAccountKey: summary.address,
    bankKeys: [assetBank.address.toBase58(), liabBank.address.toBase58()],
    oracleKeys: oraclesInHealth,
    integrationKeys,
    thresholds,
  });

  const candidate = {
    liquidatee: new PublicKey(summary.address),
    assetBank: assetBank.address,
    liabBank: liabBank.address,
    assetMint: assetBank.mint,
    liabMint: liabBank.mint,
    venue,
    maintAssetsUsd,
    maintLiabsUsd,
    maintHealthUsd,
    maintRatioPct,
    rawAssetsUsd,
    rawLiabsUsd,
    equityUsd,
    maxAssetAmount,
    maxLiabAmount,
    expectedLiquidationBonusUsd: 0,
    expectedProfitUsdBeforeSwap: 0,
    observationAccounts,
    banksInHealth: banksInHealth.map((s) => new PublicKey(s)),
    oraclesInHealth: oraclesInHealth.map((s) => new PublicKey(s)),
    cacheFreshness,
    smokeTest: true,
  };

  return { candidate };
}

/**
 * @param {import("@0dotxyz/p0-ts-sdk").MarginfiAccountWrapper} wrapper
 * @param {import("@0dotxyz/p0-ts-sdk").Project0Client} client
 * @param {import("./slot-tracker.js").SlotTracker} slotTracker
 * @param {object} cfg
 * @returns {{ candidate: object | null, skipReason?: string }}
 */
export function buildLiquidationCandidate(wrapper, client, slotTracker, cfg) {
  const { summary, balances, scoredAssets, scoredLiabs } = scoreLiquidationAssetLiabilityBanks(wrapper, client);
  const status = summary.totals ? computeStatus(summary.totals) : "UNKNOWN";
  if (status !== "LIQUIDATABLE") {
    return { candidate: null, skipReason: SkipReason.SKIP_NOT_LIQUIDATABLE };
  }

  if (scoredAssets.length === 0 || scoredLiabs.length === 0) {
    return { candidate: null, skipReason: SkipReason.SKIP_NO_POSITIONS };
  }

  const { bank: assetBank, balance: assetBalance } = scoredAssets[0];
  const { bank: liabBank, balance: liabBalance } = scoredLiabs[0];

  const t = summary.totals;
  const maintAssetsUsd = t.maintenance.assets;
  const maintLiabsUsd = t.maintenance.liabilities;
  const maintHealthUsd = t.maintenance.health;
  const ratio = computeMaintRatio(t);
  const maintRatioPct = Number.isFinite(ratio) ? ratio * 100 : 0;

  const rawAssetsUsd = t.navMaint.assets;
  const rawLiabsUsd = t.navMaint.liabilities;
  const equityUsd = t.equity.health;

  const multA = getShareMultiplier(client, assetBank);
  const multL = getShareMultiplier(client, liabBank);
  const qtyA = assetBalance.computeQuantityUi(assetBank, multA);
  const qtyL = liabBalance.computeQuantityUi(liabBank, multL);
  const assetUi = toBigNumber(qtyA.assets);
  const maxAssetAmount = bnToBigInt(uiToNative(assetUi, mintDecimalsToNumber(assetBank.mintDecimals)));
  const liabUiL = toBigNumber(qtyL.liabilities);
  const maxLiabAmount = bnToBigInt(uiToNative(liabUiL, mintDecimalsToNumber(liabBank.mintDecimals)));

  const venue = inferLiquidationExecutionVenue(assetBank);
  const bonusRate = 0.025;
  const expectedLiquidationBonusUsd = Math.max(0, maintAssetsUsd * bonusRate);
  const expectedProfitUsdBeforeSwap = expectedLiquidationBonusUsd;

  const banksInHealth = [...new Set(balances.map((b) => b.bankPk.toBase58()))];
  const oraclesInHealth = uniqueOracleKeys([assetBank, liabBank]);
  const observationAccounts = oraclesInHealth.map((s) => new PublicKey(s));

  const integrationKeys = uniqueKeys([
    ...collectIntegrationPubkeysFromBank(assetBank),
    ...collectIntegrationPubkeysFromBank(liabBank),
  ]);

  const thresholds = {
    maxAccountLagSlots: cfg.maxAccountLagSlots,
    maxBankLagSlots: cfg.maxBankLagSlots,
    maxOracleLagSlots: cfg.maxOracleLagSlots,
    maxIntegrationLagSlots: cfg.maxIntegrationLagSlots,
  };

  const cacheFreshness = buildCacheFreshness({
    slotTracker,
    marginfiAccountKey: summary.address,
    bankKeys: [assetBank.address.toBase58(), liabBank.address.toBase58()],
    oracleKeys: oraclesInHealth,
    integrationKeys,
    thresholds,
  });

  const candidate = {
    liquidatee: new PublicKey(summary.address),
    assetBank: assetBank.address,
    liabBank: liabBank.address,
    assetMint: assetBank.mint,
    liabMint: liabBank.mint,
    venue,
    maintAssetsUsd,
    maintLiabsUsd,
    maintHealthUsd,
    maintRatioPct,
    rawAssetsUsd,
    rawLiabsUsd,
    equityUsd,
    maxAssetAmount,
    maxLiabAmount,
    expectedLiquidationBonusUsd,
    expectedProfitUsdBeforeSwap,
    observationAccounts,
    banksInHealth: banksInHealth.map((s) => new PublicKey(s)),
    oraclesInHealth: oraclesInHealth.map((s) => new PublicKey(s)),
    cacheFreshness,
  };

  return { candidate };
}

function uniqueOracleKeys(banks) {
  const s = new Set();
  for (const bank of banks) {
    for (const k of bank.config?.oracleKeys || []) {
      const b = k?.toBase58?.() ?? String(k);
      if (b && b !== "11111111111111111111111111111111") s.add(b);
    }
  }
  return [...s];
}

function uniqueKeys(arr) {
  return [...new Set(arr)];
}

function toNum(x) {
  if (x == null) return 0;
  if (typeof x.toNumber === "function") {
    try {
      return x.toNumber();
    } catch {
      return Number(x.toString());
    }
  }
  return Number(x);
}

function toBigNumber(x) {
  if (!x) return new BigNumber(0);
  if (x instanceof BigNumber) return x;
  return new BigNumber(String(x));
}

/**
 * @param {object} c - LiquidationCandidate-like
 * @param {object} cfg
 */
export function shouldPlan(c, cfg) {
  if (c.venue === "solend") return { ok: false, reason: SkipReason.SKIP_SOLEND_UNSUPPORTED };
  if (c.venue === "unknown") return { ok: false, reason: SkipReason.SKIP_UNKNOWN_VENUE };
  if (c.maintHealthUsd > 0) return { ok: false, reason: SkipReason.SKIP_HEALTH_POSITIVE };
  if (c.rawLiabsUsd < cfg.agnesMinDebtUsd) return { ok: false, reason: SkipReason.SKIP_DUST_DEBT };
  if (Math.abs(c.maintHealthUsd) < cfg.agnesMinAbsHealthUsd) return { ok: false, reason: SkipReason.SKIP_DUST_HEALTH };
  if (c.expectedLiquidationBonusUsd < cfg.agnesMinBonusUsd) return { ok: false, reason: SkipReason.SKIP_PROFIT_TOO_LOW };
  const fresh = isFresh(c.cacheFreshness, {
    requireAllIntegrationObserved: cfg.strictIntegrationFreshness,
  });
  if (!fresh) return { ok: false, reason: SkipReason.SKIP_STALE_CACHE };
  return { ok: true };
}

export function formatCandidateLog(c, skipReason) {
  const base = {
    liquidatee: c.liquidatee.toBase58(),
    venue: c.venue,
    assetBank: c.assetBank.toBase58(),
    liabBank: c.liabBank.toBase58(),
    maintHealthUsd: c.maintHealthUsd,
    maxAsset: c.maxAssetAmount.toString(),
    maxLiab: c.maxLiabAmount.toString(),
    freshness: c.cacheFreshness,
  };
  if (skipReason) return JSON.stringify({ ...base, skipReason });
  return JSON.stringify(base);
}
