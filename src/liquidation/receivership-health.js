import { PublicKey } from "@solana/web3.js";
import {
  AssetTag,
  OracleSetup,
  composeRemainingAccounts,
  computeHealthCheckAccounts,
} from "@0dotxyz/p0-ts-sdk";

/**
 * Whether `pk` is a real on-chain key (not default / unset).
 * @param {import("@solana/web3.js").PublicKey | undefined} pk
 */
function isNonDefault(pk) {
  return !!pk && !pk.equals(PublicKey.default);
}

/**
 * Remaining-account pubkeys for one **active balance** in `lending_account_liquidate` / risk health walks.
 * Mirrors `get_remaining_accounts_per_bank` + `OraclePriceFeedAdapter::try_from_bank` (default tag: bank + 1 oracle AI).
 *
 * @param {import("@0dotxyz/p0-ts-sdk").Bank} bank
 * @returns {import("@solana/web3.js").PublicKey[]}
 */
export function liquidateRemainingPubkeysForBank(bank) {
  const cfg = bank.config;
  const ok = cfg.oracleKeys ?? [];

  switch (cfg.oracleSetup) {
    case OracleSetup.Fixed:
      return [bank.address];
    case OracleSetup.FixedKamino:
      return [bank.address, bank.kaminoIntegrationAccounts?.kaminoReserve ?? ok[1]].filter(isNonDefault);
    case OracleSetup.FixedDrift:
      return [bank.address, bank.driftIntegrationAccounts?.driftSpotMarket ?? ok[1]].filter(isNonDefault);
    case OracleSetup.FixedJuplend:
      return [bank.address, bank.jupLendIntegrationAccounts?.jupLendingState ?? ok[1]].filter(isNonDefault);
    default:
      break;
  }

  switch (cfg.assetTag) {
    case AssetTag.STAKED:
      return [bank.address, bank.oracleKey, ok[1], ok[2]].filter(isNonDefault);
    case AssetTag.KAMINO:
    case AssetTag.DRIFT:
    case AssetTag.SOLEND:
    case AssetTag.JUPLEND:
      return [bank.address, bank.oracleKey, ok[1]].filter(isNonDefault);
    case AssetTag.DEFAULT:
    case AssetTag.SOL:
    default:
      if (isNonDefault(bank.oracleKey)) {
        return [bank.address, bank.oracleKey];
      }
      return [bank.address];
  }
}

/**
 * @param {import("@solana/web3.js").PublicKey} pk
 * @param {import("@solana/web3.js").PublicKey | undefined} assetBankPk
 * @param {import("@solana/web3.js").PublicKey | undefined} liabBankPk
 */
function isLiquidationPairBank(pk, assetBankPk, liabBankPk) {
  if (assetBankPk && pk.equals(assetBankPk)) return true;
  if (liabBankPk && pk.equals(liabBankPk)) return true;
  return false;
}

/**
 * Remaining accounts for `lending_account_liquidate` (Anchor `remainingAccounts` only — after static accounts).
 *
 * Layout matches marginfi `lending_account_liquidate`:
 * `[asset_oracle, liab_oracle, ...liquidator_observation..., ...liquidatee_observation...]`
 *
 * Liquidator observation uses **no** mandatory banks unless `liquidatorMandatoryBanks` is provided (rare).
 * Liquidatee observation always includes mandatory `[assetBank, liabBank]` so the liquidation pair is present
 * even if projected from inactive slots (matches historical mainnet txs).
 *
 * @param {import("@0dotxyz/p0-ts-sdk").MarginfiAccountWrapper} liquidateeWrapper
 * @param {import("@0dotxyz/p0-ts-sdk").MarginfiAccount} liquidatorAccount
 * @param {Map<string, import("@0dotxyz/p0-ts-sdk").Bank>} bankMap
 * @param {object} [opts]
 * @param {import("@solana/web3.js").PublicKey} [opts.assetBankPk]
 * @param {import("@solana/web3.js").PublicKey} [opts.liabBankPk]
 * @param {import("@solana/web3.js").PublicKey[]} [opts.liquidatorMandatoryBanks]
 */
export function buildClassicLiquidateRemainingAccounts(liquidateeWrapper, liquidatorAccount, bankMap, opts = {}) {
  const { assetBankPk, liabBankPk, liquidatorMandatoryBanks = [] } = opts;

  const mandatoryLee = assetBankPk && liabBankPk ? [assetBankPk, liabBankPk] : [];
  const mandatoryLiq = liquidatorMandatoryBanks;

  const leeBanks = computeHealthCheckAccounts(liquidateeWrapper.balances, bankMap, mandatoryLee, []);
  const liqBanks = computeHealthCheckAccounts(liquidatorAccount.balances, bankMap, mandatoryLiq, []);

  const assetBank = assetBankPk ? bankMap.get(assetBankPk.toBase58()) : null;
  const liabBank = liabBankPk ? bankMap.get(liabBankPk.toBase58()) : null;
  if (!assetBank || !liabBank) {
    throw new Error("buildClassicLiquidateRemainingAccounts: assetBankPk and liabBankPk must exist in bankMap");
  }

  /** @type {import("@solana/web3.js").AccountMeta[]} */
  const prefix = [
    { pubkey: assetBank.oracleKey, isSigner: false, isWritable: false },
    { pubkey: liabBank.oracleKey, isSigner: false, isWritable: false },
  ];

  const liqGroups = liqBanks.map((b) => liquidateRemainingPubkeysForBank(b));
  const leeGroups = leeBanks.map((b) => liquidateRemainingPubkeysForBank(b));
  const liqFlat = composeRemainingAccounts(liqGroups);
  const leeFlat = composeRemainingAccounts(leeGroups);

  /** @param {import("@solana/web3.js").PublicKey} pk */
  const metaForObs = (pk) => ({
    pubkey: pk,
    isSigner: false,
    isWritable: isLiquidationPairBank(pk, assetBankPk, liabBankPk),
  });

  const liqRem = liqFlat.map(metaForObs);
  const leeRem = leeFlat.map(metaForObs);

  return {
    remainingAccounts: [...prefix, ...liqRem, ...leeRem],
    liquidateeAccounts: leeRem.length,
    liquidatorAccounts: liqRem.length,
  };
}

/**
 * Eva01-style remaining accounts for `start_liquidation` / `end_liquidation`.
 * @param {import("@0dotxyz/p0-ts-sdk").MarginfiAccountWrapper} liquidateeWrapper
 * @param {Map<string, import("@0dotxyz/p0-ts-sdk").Bank>} bankMap
 */
export function buildReceivershipRemainingForLiquidatee(liquidateeWrapper, bankMap) {
  const healthBanks = computeHealthCheckAccounts(liquidateeWrapper.balances, bankMap, [], []);
  const observationPubkeys = healthBanks.flatMap((b) => liquidateRemainingPubkeysForBank(b));
  const activeBankSet = new Set(
    liquidateeWrapper.balances.filter((b) => b.active).map((b) => b.bankPk.toBase58()),
  );
  const startRemainingAccounts = observationPubkeys.map((pk) => ({
    pubkey: pk,
    isSigner: false,
    isWritable: activeBankSet.has(pk.toBase58()),
  }));
  const endBankKeys = [...new Map(healthBanks.map((b) => [b.address.toBase58(), b.address])).values()];
  const endRemainingAccounts = endBankKeys.map((pk) => ({
    pubkey: pk,
    isSigner: false,
    isWritable: true,
  }));
  return { startRemainingAccounts, endRemainingAccounts };
}
