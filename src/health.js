import {
  MarginRequirementType,
  computeHealthComponentsFromBalances,
  computeHealthComponentsWithoutBiasFromBalances,
} from "@0dotxyz/p0-ts-sdk";
import { getBankDisplayName, inferBankVenue } from "./venues.js";

/**
 * Status thresholds. Tunable here; promote to env/config later if needed.
 *  - DUST_USD_THRESHOLD: below this magnitude on both equity and maint liabilities, the
 *    account is treated as DUST (no real economic activity).
 *  - RISK_RATIO_THRESHOLD: maintenance ratio below this (with real liabilities) flags RISK.
 */
const DUST_USD_THRESHOLD = 0.01;
const RISK_RATIO_THRESHOLD = 0.10;

const REQUIREMENT_TYPES = [
  ["equity", MarginRequirementType.Equity],
  ["initial", MarginRequirementType.Initial],
  ["maintenance", MarginRequirementType.Maintenance],
];

function getShareMultiplier(client, bank) {
  return client.assetShareValueMultiplierByBank?.get(bank.address.toBase58());
}

function buildHealthParams(wrapper, client, marginRequirement) {
  return {
    activeBalances: getActiveBalances(wrapper),
    marginRequirement,
    banksMap: client.bankMap,
    oraclePricesByBank: client.oraclePriceByBank,
    assetShareValueMultiplierByBank: client.assetShareValueMultiplierByBank,
  };
}

/**
 * Computes account-level totals using the marginfi SDK directly:
 *  - Equity: neutral pricing (no price bias), unweighted (weight=1.0) —
 *    `computeHealthComponentsWithoutBiasFromBalances(Equity)`. This is the SDK convention,
 *    equivalent to `wrapper.computeAccountValue()`. Use as wallet net worth / NAV proxy.
 *  - Initial / Maintenance: conservative price bias (lowest-for-assets, highest-for-liabs)
 *    AND risk weights — `computeHealthComponentsFromBalances`. Maintenance health < 0 is
 *    the canonical liquidation signal.
 *  - navMaint: maintenance weights WITHOUT price bias —
 *    `computeHealthComponentsWithoutBiasFromBalances(Maintenance)`. Read as
 *    "fair-value risk-weighted equity": same risk weights as `health`, but oracle
 *    midpoint instead of conservative bias. Useful as a leverage / fair-value
 *    diagnostic. Do NOT use for liquidation gating (use `health` for that), and do
 *    NOT assume it matches any specific external tool's "Equity" field — different
 *    tools (eva01, the marginfi UI, the marginfi-v2 program) use different
 *    conventions for `RequirementType::Equity`.
 *
 * All numbers are read from the live `client.bankMap` / `client.oraclePriceByBank` /
 * `client.assetShareValueMultiplierByBank`, which monitor.js feeds from gRPC in real time.
 *
 * Note: we call the standalone SDK functions (not wrapper methods). The wrapper's
 * `computeHealthComponentsFromCache` reads the on-chain HealthCache, which only
 * refreshes on PulseHealth cranks and so can lag oracle moves — using the
 * "FromBalances" path with our live oracle map gives a fresh, accurate value.
 */
function computeSdkTotals(wrapper, client) {
  const equity = computeHealthComponentsWithoutBiasFromBalances(
    buildHealthParams(wrapper, client, MarginRequirementType.Equity),
  );
  const initial = computeHealthComponentsFromBalances(
    buildHealthParams(wrapper, client, MarginRequirementType.Initial),
  );
  const maintenance = computeHealthComponentsFromBalances(
    buildHealthParams(wrapper, client, MarginRequirementType.Maintenance),
  );
  const navMaintRaw = computeHealthComponentsWithoutBiasFromBalances(
    buildHealthParams(wrapper, client, MarginRequirementType.Maintenance),
  );
  const eqAssets = toNumber(equity.assets);
  const eqLiabs = toNumber(equity.liabilities);
  const initAssets = toNumber(initial.assets);
  const initLiabs = toNumber(initial.liabilities);
  const maintAssets = toNumber(maintenance.assets);
  const maintLiabs = toNumber(maintenance.liabilities);
  const navAssets = toNumber(navMaintRaw.assets);
  const navLiabs = toNumber(navMaintRaw.liabilities);

  return {
    equity: {
      assets: eqAssets,
      liabilities: eqLiabs,
      // Net worth at neutral pricing. Equivalent to wrapper.computeAccountValue() —
      // computeHealthComponentsWithoutBiasFromBalances(Equity) returns weight=1.0, no bias,
      // so assets - liabs IS the canonical account value.
      health: eqAssets - eqLiabs,
    },
    initial: {
      assets: initAssets,
      liabilities: initLiabs,
      health: initAssets - initLiabs,
    },
    maintenance: {
      assets: maintAssets,
      liabilities: maintLiabs,
      health: maintAssets - maintLiabs,
    },
    // Maintenance weights, NO price bias. "Fair-value risk-weighted equity" — the
    // leverage diagnostic version of `health`. Not a liquidation signal; not
    // guaranteed to match any external tool's "Equity" field.
    navMaint: {
      assets: navAssets,
      liabilities: navLiabs,
      health: navAssets - navLiabs,
    },
  };
}

function safeComputeTotals(wrapper, client) {
  try {
    return { totals: computeSdkTotals(wrapper, client), error: null };
  } catch (err) {
    return { totals: null, error: err };
  }
}

export function summarizeAccountState(wrapper, client) {
  const balances = getActiveBalances(wrapper);
  const positions = balances.map((balance) => summarizeBalance(balance, client)).filter(Boolean);
  const { totals, error: totalsError } = safeComputeTotals(wrapper, client);

  return {
    address: wrapper.address?.toBase58?.() ?? String(wrapper.address),
    authority: wrapper.authority?.toBase58?.() ?? String(wrapper.authority),
    activeBalanceCount: balances.length,
    totals,
    totalsError,
    positions,
    sdkDescription: typeof wrapper.describe === "function" ? wrapper.describe() : undefined,
  };
}

export function printAccountState(prefix, summary) {
  console.log(`\n${prefix} account=${summary.address} authority=${summary.authority}`);

  if (!summary.totals) {
    const reason = summary.totalsError?.message ?? "missing bank/oracle";
    console.log(`  totals unavailable (${reason})`);
  } else {
    const { equity, initial, maintenance, navMaint } = summary.totals;
    const ratio = computeMaintRatio(summary.totals);
    const status = computeStatus(summary.totals);
    console.log(
      `  totals equity (SDK weight=1.0, no bias) assets=$${fmt(equity.assets)} liabilities=$${fmt(equity.liabilities)} equity=$${fmt(equity.health)}`,
    );
    console.log(
      `  totals initial (weighted+bias) assets=$${fmt(initial.assets)} liabilities=$${fmt(initial.liabilities)} free_collateral=$${fmt(initial.health)}`,
    );
    console.log(
      `  totals maintenance (weighted+bias) assets=$${fmt(maintenance.assets)} liabilities=$${fmt(maintenance.liabilities)} health=$${fmt(maintenance.health)} ratio=${fmtPct(ratio)} status=${status}`,
    );
    if (navMaint) {
      console.log(
        `  totals nav (maint weights, no bias — fair-value risk-weighted equity, diagnostic only) assets=$${fmt(navMaint.assets)} liabilities=$${fmt(navMaint.liabilities)} nav=$${fmt(navMaint.health)}`,
      );
    }
  }

  for (const position of summary.positions) {
    console.log(
      `  [${position.venue}:${position.symbol}] bank=${position.bank} mint=${position.mint} quantity assets=${fmt(position.quantity.assets)} liabilities=${fmt(position.quantity.liabilities)}`,
    );
    console.log(
      `    equity=$${fmt(position.usd.equity.assets)}/$${fmt(position.usd.equity.liabilities)} initial=$${fmt(position.usd.initial.assets)}/$${fmt(position.usd.initial.liabilities)} maintenance=$${fmt(position.usd.maintenance.assets)}/$${fmt(position.usd.maintenance.liabilities)}`,
    );
  }
}

function summarizeBalance(balance, client) {
  const bank = client.getBank(balance.bankPk);
  if (!bank) return undefined;

  const oraclePrice = client.oraclePriceByBank.get(bank.address.toBase58());
  const mult = getShareMultiplier(client, bank);
  const usd = {
    equity: { assets: 0, liabilities: 0 },
    initial: { assets: 0, liabilities: 0 },
    maintenance: { assets: 0, liabilities: 0 },
  };
  if (oraclePrice) {
    // Equity row uses neutral pricing (no bias) — matches `computeHealthComponentsWithoutBiasFromBalances`.
    try {
      usd.equity = normalizeBigNumberPair(
        balance.computeUsdValue(bank, oraclePrice, MarginRequirementType.Equity, mult),
      );
    } catch {
      // leave zeros; per-position USD is best-effort
    }
    // Initial / Maintenance rows apply conservative price bias so they reconcile with
    // `computeHealthComponentsFromBalances` totals (lowest-for-assets, highest-for-liabs).
    try {
      usd.initial = normalizeBigNumberPair(
        balance.getUsdValueWithPriceBias(bank, oraclePrice, MarginRequirementType.Initial, mult),
      );
    } catch {
      // leave zeros
    }
    try {
      usd.maintenance = normalizeBigNumberPair(
        balance.getUsdValueWithPriceBias(bank, oraclePrice, MarginRequirementType.Maintenance, mult),
      );
    } catch {
      // leave zeros
    }
  }

  return {
    bank: bank.address?.toBase58?.() ?? String(balance.bankPk),
    mint: bank.mint?.toBase58?.() ?? String(bank.mint),
    symbol: getBankDisplayName(bank),
    venue: inferBankVenue(bank),
    oracleKeys: (bank.config?.oracleKeys || []).map((key) => key.toBase58()),
    quantity: normalizeBigNumberPair(balance.computeQuantityUi(bank, mult)),
    usd,
  };
}

export function getActiveBalances(account) {
  const balances = account.activeBalances ?? account.balances ?? [];
  return balances.filter((balance) => balance.active !== false);
}

function normalizeBigNumberPair(pair) {
  return {
    assets: toNumber(pair?.assets),
    liabilities: toNumber(pair?.liabilities),
  };
}

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  if (typeof value.toNumber === "function") {
    try {
      return value.toNumber();
    } catch {
      return Number(value.toString());
    }
  }
  return Number(value.toString());
}

function fmt(value) {
  return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 6 }) : "n/a";
}

function fmtPct(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

/**
 * Maintenance ratio — bounded operator-friendly distance from liquidation.
 *   1.0   = unlevered / no maintenance liabilities
 *   0.0   = at maintenance threshold
 *   < 0   = underwater, expressed as shortfall over maintenance liabilities
 *
 * For healthy accounts, use health/assets to answer "what share of collateral is buffer?"
 * For liquidatable accounts, use health/liabilities to avoid giant negative percentages when
 * weighted assets are dust but liabilities are real.
 */
function computeMaintRatio(totals) {
  if (!totals) return NaN;
  const a = totals.maintenance.assets;
  const l = totals.maintenance.liabilities;
  const h = totals.maintenance.health;
  if (l <= 0) return 1;
  if (h < 0) return h / l;
  if (a > 0) return h / a;
  return 1;
}

/**
 * One of: HEALTHY | RISK | LIQUIDATABLE | DUST | UNKNOWN
 *
 *   UNKNOWN      — totals couldn't be computed (missing bank/oracle in live cache)
 *   DUST         — net worth and maint liabs both below DUST_USD_THRESHOLD
 *   LIQUIDATABLE — maintenance health <= 0 with real maintenance liabilities
 *   RISK         — maintenance ratio below RISK_RATIO_THRESHOLD with real liabilities
 *   HEALTHY      — otherwise
 */
function computeStatus(totals) {
  if (!totals) return "UNKNOWN";
  const liabsMaint = totals.maintenance.liabilities;
  const maintHealth = totals.maintenance.health;
  const equity = totals.equity.health;

  if (Math.abs(equity) < DUST_USD_THRESHOLD && liabsMaint < DUST_USD_THRESHOLD) {
    return "DUST";
  }
  if (liabsMaint > DUST_USD_THRESHOLD && maintHealth <= 0) {
    return "LIQUIDATABLE";
  }
  const ratio = computeMaintRatio(totals);
  if (Number.isFinite(ratio) && ratio < RISK_RATIO_THRESHOLD && liabsMaint > DUST_USD_THRESHOLD) {
    return "RISK";
  }
  return "HEALTHY";
}

/**
 * One-line summary for the monitor catalog.
 *
 * Format:
 *   - <pubkey> | authority=<auth> | positions=N venues=<v> | health=$<maintHealthUsd> ratio=<%> assets=$<…> liab=$<…> equity=$<…> nav=$<…> status=<…>
 *
 * Field semantics (the [health] legend at startup says the same thing):
 *   health  — maintenance-weighted assets minus liabilities WITH price bias (the
 *             canonical marginfi liquidation signal; <0 means liquidatable).
 *   ratio   — health/weighted_assets when healthy, health/weighted_liabs when underwater
 *             (bounded -100%..100%; "collateral stress" interpretation).
 *   assets  — maintenance-weighted, price-biased asset USD.
 *   liab    — maintenance-weighted, price-biased liability USD.
 *   equity  — SDK `RequirementType::Equity` (weight=1.0, no bias) = wallet net worth /
 *             unweighted spot NAV. Equivalent to wrapper.computeAccountValue().
 *   nav     — maintenance weights without price bias = "fair-value risk-weighted
 *             equity". Same risk weights as `health`, oracle midpoint instead of
 *             conservative bias. Diagnostic only; not a liquidation signal and not
 *             guaranteed to match any external tool's "Equity" field.
 *   status  — HEALTHY | RISK | LIQUIDATABLE | DUST | UNKNOWN.
 */
export function summarizeAccountHealth(client, wrapper) {
  const summary = summarizeAccountState(wrapper, client);
  const venues = [...new Set((summary.positions || []).map((p) => p.venue))].join(",") || "—";
  const head = `- ${summary.address} | authority=${summary.authority} | positions=${summary.activeBalanceCount} venues=${venues}`;

  if (!summary.totals) {
    return { line: `${head} | health=n/a status=UNKNOWN`, summary, ratio: NaN, status: "UNKNOWN" };
  }

  const t = summary.totals;
  const ratio = computeMaintRatio(t);
  const status = computeStatus(t);
  const navHealth = t.navMaint ? t.navMaint.health : NaN;

  return {
    line:
      `${head} | health=$${fmt(t.maintenance.health)} ratio=${fmtPct(ratio)} ` +
      `assets=$${fmt(t.maintenance.assets)} liab=$${fmt(t.maintenance.liabilities)} ` +
      `equity=$${fmt(t.equity.health)} nav=$${fmt(navHealth)} status=${status}`,
    summary,
    ratio,
    status,
  };
}

/**
 * One-time legend for the monitor log so anyone reading monitor.log understands the
 * fields without having to grep source. Print once at monitor startup.
 */
export const HEALTH_LEGEND_LINE =
  "[health] legend: " +
  "health=maint-weighted+bias (liq signal, <0 = LIQUIDATABLE) | " +
  "ratio=health/assets when healthy, health/liabs when underwater (bounded -100%..100%) | " +
  "assets/liab=maint-weighted+bias USD | " +
  "equity=weight=1.0, no bias (wallet NAV) | " +
  "nav=maint-weighted, no bias (fair-value risk-weighted equity, diagnostic) | " +
  "status=HEALTHY|RISK|LIQUIDATABLE|DUST|UNKNOWN";

// Exported for tests / advanced callers.
export { computeMaintRatio, computeStatus, DUST_USD_THRESHOLD, RISK_RATIO_THRESHOLD, REQUIREMENT_TYPES };
