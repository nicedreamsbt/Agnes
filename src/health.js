import { MarginRequirementType } from "@mrgnlabs/marginfi-client-v2";
import { getBankDisplayName, inferBankVenue } from "./venues.js";

const REQUIREMENT_TYPES = [
  ["equity", MarginRequirementType.Equity],
  ["initial", MarginRequirementType.Initial],
  ["maintenance", MarginRequirementType.Maintenance],
];

export function summarizeAccountState(account, client) {
  const balances = getActiveBalances(account);
  const positions = balances.map((balance) => summarizeBalance(balance, client)).filter(Boolean);
  const totals = computeTotals(positions);

  return {
    address: account.address?.toBase58?.() ?? String(account.address),
    authority: account.authority?.toBase58?.() ?? String(account.authority),
    activeBalanceCount: balances.length,
    totals,
    positions,
    sdkDescription: typeof account.describe === "function" ? account.describe() : undefined,
  };
}

export function printAccountState(prefix, summary) {
  console.log(`\n${prefix} account=${summary.address} authority=${summary.authority}`);
  console.log(
    `  totals equity assets=$${fmt(summary.totals.equity.assets)} liabilities=$${fmt(summary.totals.equity.liabilities)} health=$${fmt(summary.totals.equity.health)}`
  );
  console.log(
    `  totals initial assets=$${fmt(summary.totals.initial.assets)} liabilities=$${fmt(summary.totals.initial.liabilities)} health=$${fmt(summary.totals.initial.health)}`
  );
  console.log(
    `  totals maintenance assets=$${fmt(summary.totals.maintenance.assets)} liabilities=$${fmt(summary.totals.maintenance.liabilities)} health=$${fmt(summary.totals.maintenance.health)}`
  );

  for (const position of summary.positions) {
    console.log(
      `  [${position.venue}:${position.symbol}] bank=${position.bank} mint=${position.mint} quantity assets=${fmt(position.quantity.assets)} liabilities=${fmt(position.quantity.liabilities)}`
    );
    console.log(
      `    equity=$${fmt(position.usd.equity.assets)}/$${fmt(position.usd.equity.liabilities)} initial=$${fmt(position.usd.initial.assets)}/$${fmt(position.usd.initial.liabilities)} maintenance=$${fmt(position.usd.maintenance.assets)}/$${fmt(position.usd.maintenance.liabilities)}`
    );
  }
}

function summarizeBalance(balance, client) {
  const bank = client.getBankByPk(balance.bankPk);
  if (!bank) return undefined;

  const oraclePrice = client.getOraclePriceByBank(bank.address);
  const usd = {};
  if (oraclePrice) {
    for (const [name, type] of REQUIREMENT_TYPES) {
      usd[name] = normalizeBigNumberPair(balance.computeUsdValue(bank, oraclePrice, type));
    }
  }

  return {
    bank: bank.address?.toBase58?.() ?? String(balance.bankPk),
    mint: bank.mint?.toBase58?.() ?? String(bank.mint),
    symbol: getBankDisplayName(bank),
    venue: inferBankVenue(bank),
    oracleKeys: (bank.config?.oracleKeys || []).map((key) => key.toBase58()),
    quantity: normalizeBigNumberPair(balance.computeQuantityUi(bank)),
    usd,
  };
}

function computeTotals(positions) {
  const out = {};
  for (const [name] of REQUIREMENT_TYPES) {
    const assets = positions.reduce((sum, position) => sum + toNumber(position.usd[name]?.assets), 0);
    const liabilities = positions.reduce((sum, position) => sum + toNumber(position.usd[name]?.liabilities), 0);
    out[name] = { assets, liabilities, health: assets - liabilities };
  }
  return out;
}

export function getActiveBalances(account) {
  return (account.activeBalances || account.balances || []).filter((balance) => balance.active !== false);
}

function normalizeBigNumberPair(pair) {
  return {
    assets: toNumber(pair?.assets),
    liabilities: toNumber(pair?.liabilities),
  };
}

function toNumber(value) {
  if (!value) return 0;
  if (typeof value === "number") return value;
  if (typeof value.toNumber === "function") return value.toNumber();
  return Number(value.toString());
}

function fmt(value) {
  return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 6 }) : "n/a";
}
