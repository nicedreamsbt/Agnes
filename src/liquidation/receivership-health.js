import { PublicKey } from "@solana/web3.js";
import {
  AssetTag,
  OracleSetup,
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
 * Mirrors `get_remaining_accounts_per_bank` + account ordering in marginfi-v2 `marginfi_account.rs`
 * (OracleSetup::Fixed => bank only; DEFAULT/SOL => bank+oracle; KAMINO/… => bank+oracle+integration; STAKED => 4 keys).
 *
 * `computeHealthAccountMetas` from the SDK does not follow `OracleSetup::Fixed` (1 key) and can desync
 * all following positions → `InvalidBankAccount` (left = expected balance.bank_pk, right = wrong AI key).
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
 * Remaining accounts for `lending_account_liquidate`: liquidator observation metas first, then liquidatee
 * (matches on-chain slice: `liquidator_remaining_accounts` then tail `liquidatee_accounts`).
 * @param {import("@0dotxyz/p0-ts-sdk").MarginfiAccountWrapper} liquidateeWrapper
 * @param {import("@0dotxyz/p0-ts-sdk").MarginfiAccount} liquidatorAccount
 * @param {Map<string, import("@0dotxyz/p0-ts-sdk").Bank>} bankMap
 */
export function buildClassicLiquidateRemainingAccounts(liquidateeWrapper, liquidatorAccount, bankMap) {
  const leeBanks = computeHealthCheckAccounts(liquidateeWrapper.account.balances, bankMap, [], []);
  const liqBanks = computeHealthCheckAccounts(liquidatorAccount.balances, bankMap, [], []);
  const leeObs = leeBanks.flatMap((b) => liquidateRemainingPubkeysForBank(b));
  const liqObs = liqBanks.flatMap((b) => liquidateRemainingPubkeysForBank(b));
  const leeActive = new Set(
    liquidateeWrapper.account.balances.filter((b) => b.active).map((b) => b.bankPk.toBase58()),
  );
  const liqActive = new Set(liquidatorAccount.balances.filter((b) => b.active).map((b) => b.bankPk.toBase58()));
  /** @param {import("@solana/web3.js").PublicKey[]} pks */
  const toMeta = (pks, activeSet) =>
    pks.map((pk) => ({
      pubkey: pk,
      isSigner: false,
      isWritable: activeSet.has(pk.toBase58()),
    }));
  const leeRem = toMeta(leeObs, leeActive);
  const liqRem = toMeta(liqObs, liqActive);
  return {
    remainingAccounts: [...liqRem, ...leeRem],
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
  const healthBanks = computeHealthCheckAccounts(liquidateeWrapper.account.balances, bankMap, [], []);
  const observationPubkeys = healthBanks.flatMap((b) => liquidateRemainingPubkeysForBank(b));
  const activeBankSet = new Set(
    liquidateeWrapper.account.balances.filter((b) => b.active).map((b) => b.bankPk.toBase58()),
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
