/**
 * RPC-only account health verifier.
 *
 * Independently fetches a marginfi account (and the group's banks + oracles) over plain
 * RPC and prints health / equity / nav using THREE independent paths so we can
 * triangulate and confirm the live gRPC monitor is accurate:
 *
 *   1) from-balances / live-oracle: same SDK code path the monitor uses
 *      (computeHealthComponentsFromBalances + computeHealthComponentsWithoutBiasFromBalances).
 *   2) from-cache / on-chain: reads HealthCache fields written by the program at the
 *      most recent PulseHealth crank (assetValueMaint, liabilityValueMaint, etc).
 *   3) nav (maint weights, no bias): "fair-value risk-weighted equity" — same risk
 *      weights as `health`, but oracle midpoint instead of conservative bias.
 *      Diagnostic only; not a liquidation signal and not guaranteed to match any
 *      specific external tool's "Equity" field.
 *
 * Usage:
 *   node src/verify-account.js <pubkey> [<pubkey> ...]
 *
 * Reads RPC_URL / MARGINFI_ENV / MARGINFI_PROGRAM_ID / MARGINFI_GROUP_PK from env via
 * loadConfig() — same source the monitor uses.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  Project0Client,
  getConfig,
  MarginfiAccount,
  MarginfiAccountWrapper,
  MarginRequirementType,
  fetchOracleData,
} from "@0dotxyz/p0-ts-sdk";

import { loadConfig } from "./config.js";
import {
  printAccountState,
  summarizeAccountState,
  summarizeAccountHealth,
  HEALTH_LEGEND_LINE,
  computeMaintRatio,
  computeStatus,
} from "./health.js";

const REQ_TYPE_LABELS = [
  ["maintenance", MarginRequirementType.Maintenance],
  ["initial", MarginRequirementType.Initial],
  ["equity", MarginRequirementType.Equity],
];

function fmt(value) {
  return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 6 }) : "n/a";
}

function fmtPct(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

function toNumber(value) {
  if (value === null || value === undefined) return NaN;
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

/**
 * Read assets/liabs directly from the on-chain HealthCache fields. We bypass the SDK
 * helper to avoid its "Health cache not computed" warning — those cached values WERE
 * computed on-chain (the warning only refers to the SDK's local simulation flag).
 */
function readHealthCacheTier(account, marginRequirement) {
  const cache = account.healthCache;
  if (!cache) return null;
  let assetsBn;
  let liabsBn;
  switch (marginRequirement) {
    case MarginRequirementType.Equity:
      assetsBn = cache.assetValueEquity;
      liabsBn = cache.liabilityValueEquity;
      break;
    case MarginRequirementType.Initial:
      assetsBn = cache.assetValue;
      liabsBn = cache.liabilityValue;
      break;
    case MarginRequirementType.Maintenance:
      assetsBn = cache.assetValueMaint;
      liabsBn = cache.liabilityValueMaint;
      break;
    default:
      return null;
  }
  const assets = toNumber(assetsBn);
  const liabs = toNumber(liabsBn);
  return {
    assets,
    liabilities: liabs,
    health: assets - liabs,
  };
}

function readCacheTotals(account) {
  const out = {};
  for (const [name, type] of REQ_TYPE_LABELS) {
    out[name] = readHealthCacheTier(account, type);
  }
  return out;
}

function fmtTimestamp(bn) {
  const n = toNumber(bn);
  if (!Number.isFinite(n) || n <= 0) return "unset";
  const d = new Date(n * 1000);
  return d.toISOString();
}

function diffPct(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  if (Math.abs(b) < 1e-9) {
    if (Math.abs(a) < 1e-9) return 0;
    return NaN;
  }
  return (a - b) / Math.abs(b);
}

async function refreshOraclesFromChain(client, connection) {
  const { bankOraclePriceMap } = await fetchOracleData(client.banks, {
    pythOpts: { mode: "on-chain", connection },
    swbOpts: { mode: "on-chain", connection },
    isolatedBanksOpts: { fetchPrices: true },
  });
  for (const [bankPk, price] of bankOraclePriceMap) {
    client.oraclePriceByBank.set(bankPk, price);
  }
}

async function fetchWrapper(connection, programIdl, pubkey) {
  const info = await connection.getAccountInfo(pubkey, "confirmed");
  if (!info) {
    throw new Error(`account ${pubkey.toBase58()} not found via RPC`);
  }
  const data = Buffer.from(info.data);
  const account = MarginfiAccount.fromAccountDataRaw(pubkey, data, programIdl);
  return { account, owner: info.owner.toBase58(), lamports: info.lamports, dataLen: data.length };
}

function printDriftLine(label, fromBalances, fromCache) {
  if (!fromBalances || !fromCache) return;
  const dHealth = diffPct(fromBalances.health, fromCache.health);
  const dAssets = diffPct(fromBalances.assets, fromCache.assets);
  const dLiabs = diffPct(fromBalances.liabilities, fromCache.liabilities);
  console.log(
    `    drift ${label}: health=${fmtPct(dHealth)} assets=${fmtPct(dAssets)} liab=${fmtPct(dLiabs)}`,
  );
}

async function verifyOne(connection, client, programIdl, pubkey) {
  const t0 = Date.now();
  const { account, owner, lamports, dataLen } = await fetchWrapper(connection, programIdl, pubkey);
  const wrapper = new MarginfiAccountWrapper(account, client);
  const slot = await connection.getSlot("confirmed");

  const summary = summarizeAccountState(wrapper, client);
  const oneliner = summarizeAccountHealth(client, wrapper);
  const cacheTotals = readCacheTotals(account);
  const ts = fmtTimestamp(account.healthCache?.timestamp);

  console.log("");
  console.log(`account=${pubkey.toBase58()} authority=${summary.authority}`);
  console.log(
    `  rpc owner=${owner} lamports=${lamports} dataLen=${dataLen} slot=${slot} cacheTimestamp=${ts}`,
  );
  console.log(`  oneliner: ${oneliner.line}`);

  if (!summary.totals) {
    const reason = summary.totalsError?.message ?? "missing bank/oracle";
    console.log(`  totals unavailable from balances (${reason})`);
  } else {
    const t = summary.totals;
    const ratio = computeMaintRatio(t);
    const status = computeStatus(t);
    console.log("  --- live oracle (computeHealthComponents*FromBalances) ---");
    console.log(
      `    maintenance  health=$${fmt(t.maintenance.health)} assets=$${fmt(t.maintenance.assets)} liab=$${fmt(t.maintenance.liabilities)} ratio=${fmtPct(ratio)} status=${status}`,
    );
    console.log(
      `    initial      health=$${fmt(t.initial.health)} assets=$${fmt(t.initial.assets)} liab=$${fmt(t.initial.liabilities)} (free_collateral)`,
    );
    console.log(
      `    equity (SDK weight=1.0, no bias) = wallet NAV   value=$${fmt(t.equity.health)} assets=$${fmt(t.equity.assets)} liab=$${fmt(t.equity.liabilities)}`,
    );
    if (t.navMaint) {
      console.log(
        `    nav    (maint weights, no bias) = fair-value risk-weighted equity   value=$${fmt(t.navMaint.health)} assets=$${fmt(t.navMaint.assets)} liab=$${fmt(t.navMaint.liabilities)}`,
      );
    }
    console.log("  --- on-chain HealthCache (last PulseHealth crank) ---");
    if (cacheTotals.maintenance) {
      console.log(
        `    maintenance  health=$${fmt(cacheTotals.maintenance.health)} assets=$${fmt(cacheTotals.maintenance.assets)} liab=$${fmt(cacheTotals.maintenance.liabilities)}`,
      );
    }
    if (cacheTotals.initial) {
      console.log(
        `    initial      health=$${fmt(cacheTotals.initial.health)} assets=$${fmt(cacheTotals.initial.assets)} liab=$${fmt(cacheTotals.initial.liabilities)}`,
      );
    }
    if (cacheTotals.equity) {
      console.log(
        `    equity       value=$${fmt(cacheTotals.equity.health)} assets=$${fmt(cacheTotals.equity.assets)} liab=$${fmt(cacheTotals.equity.liabilities)}`,
      );
    }
    console.log("  --- drift (live - cache) / |cache| ---");
    printDriftLine("maintenance", t.maintenance, cacheTotals.maintenance);
    printDriftLine("initial    ", t.initial, cacheTotals.initial);
    printDriftLine("equity     ", t.equity, cacheTotals.equity);
  }

  printAccountState("  positions:", summary);
  console.log(`  verify elapsed_ms=${Date.now() - t0}`);
}

async function main() {
  const args = process.argv.slice(2).filter(Boolean);
  if (args.length === 0) {
    console.error("usage: node src/verify-account.js <pubkey> [<pubkey> ...]");
    process.exit(2);
  }

  const pubkeys = args.map((s) => {
    try {
      return new PublicKey(s);
    } catch (err) {
      console.error(`invalid pubkey ${s}: ${err.message}`);
      process.exit(2);
    }
  });

  const cfg = loadConfig();
  console.log(`[verify] rpc=${cfg.rpcUrl} env=${cfg.p0Environment}`);
  console.log(HEALTH_LEGEND_LINE);

  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const p0Config = getConfig(cfg.p0Environment, cfg.p0ConfigOverrides);
  console.log(`[verify] bootstrapping P0 client (group=${p0Config.groupPk.toBase58()}) — fetching banks + oracles via RPC...`);
  const t0 = Date.now();
  const client = await Project0Client.initialize(connection, p0Config);
  console.log(
    `[verify] P0 client ready: banks=${client.banks.length} oracles=${client.oraclePriceByBank.size} elapsed_ms=${Date.now() - t0}`,
  );

  console.log("[verify] refreshing oracle prices on-chain (covers any drift since initialize)...");
  const tOracle = Date.now();
  await refreshOraclesFromChain(client, connection);
  console.log(`[verify] oracles refreshed elapsed_ms=${Date.now() - tOracle}`);

  const programIdl = client.program.idl;
  let failures = 0;
  for (const pk of pubkeys) {
    try {
      await verifyOne(connection, client, programIdl, pk);
    } catch (err) {
      failures++;
      console.error(`[verify] ${pk.toBase58()} failed: ${err.message}`);
    }
  }

  console.log("");
  console.log(`[verify] done: ${pubkeys.length - failures}/${pubkeys.length} ok`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[verify] fatal", err);
  process.exit(1);
});
