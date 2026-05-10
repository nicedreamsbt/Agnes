import { AssetTag, OracleSetup } from "@0dotxyz/p0-ts-sdk";

/** Venue buckets aligned with P0 SDK enums (`OracleSetup`, `AssetTag`) + README filters. */
const KNOWN_VENUES = ["marginfi", "kamino", "juplend", "drift", "solend", "unknown"];

export function parseVenueList(value) {
  const items = (value || "all")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (items.includes("all")) return new Set(KNOWN_VENUES);

  for (const item of items) {
    if (!KNOWN_VENUES.includes(item)) {
      throw new Error(`Unsupported venue '${item}'. Supported venues: all, ${KNOWN_VENUES.join(", ")}`);
    }
  }
  return new Set(items);
}

/**
 * Venue label from marginfi SDK bank state (on-chain config), not string guessing.
 * Order: oracleSetup → assetTag → integration account handles → native oracle families → metadata text (juplend only).
 */
export function inferBankVenue(bank) {
  const config = bank?.config;
  const oracleSetup = config?.oracleSetup ?? bank?.oracleSetup;
  const assetTag = config?.assetTag ?? bank?.assetTag;

  const fromOracle = oracleSetup != null ? venueFromOracleSetup(oracleSetup) : null;
  if (fromOracle) return fromOracle;

  const fromTag = assetTag != null ? venueFromAssetTag(assetTag) : null;
  if (fromTag) return fromTag;

  const fromIx = venueFromIntegrationAccounts(bank);
  if (fromIx) return fromIx;

  if (oracleSetup != null && isNativeMarginfiOracleSetup(oracleSetup)) {
    return "marginfi";
  }

  const haystack = collectBankText(bank).toLowerCase();
  if (haystack.includes("juplend") || haystack.includes("jup lend") || haystack.includes("jupiter lend")) return "juplend";

  if (!haystack) return "unknown";
  return "marginfi";
}

/**
 * Venue for Agnes liquidation execution (withdraw path): integration accounts and
 * `assetTag` are authoritative so Kamino/Drift/JupLend/Solend banks are not routed
 * through native `makeWithdrawIx` due to oracle/metadata fallthrough to `"marginfi"`.
 */
export function inferLiquidationExecutionVenue(bank) {
  const fromIx = venueFromIntegrationAccounts(bank);
  if (fromIx) return fromIx;
  const assetTag = bank?.config?.assetTag ?? bank?.assetTag;
  const fromTag = assetTag != null ? venueFromAssetTag(assetTag) : null;
  if (fromTag) return fromTag;
  return inferBankVenue(bank);
}

function venueFromOracleSetup(setup) {
  switch (setup) {
    case OracleSetup.KaminoPythPush:
    case OracleSetup.KaminoSwitchboardPull:
    case OracleSetup.FixedKamino:
      return "kamino";
    case OracleSetup.DriftPythPull:
    case OracleSetup.DriftSwitchboardPull:
    case OracleSetup.FixedDrift:
      return "drift";
    case OracleSetup.SolendPythPull:
    case OracleSetup.SolendSwitchboardPull:
      return "solend";
    case OracleSetup.JuplendPythPull:
    case OracleSetup.JuplendSwitchboardPull:
    case OracleSetup.FixedJuplend:
      return "juplend";
    default:
      return null;
  }
}

function venueFromAssetTag(tag) {
  switch (tag) {
    case AssetTag.KAMINO:
      return "kamino";
    case AssetTag.DRIFT:
      return "drift";
    case AssetTag.SOLEND:
      return "solend";
    case AssetTag.JUPLEND:
      return "juplend";
    default:
      return null;
  }
}

function venueFromIntegrationAccounts(bank) {
  if (bank?.kaminoIntegrationAccounts) return "kamino";
  if (bank?.driftIntegrationAccounts) return "drift";
  if (bank?.solendIntegrationAccounts) return "solend";
  if (bank?.jupLendIntegrationAccounts) return "juplend";
  return null;
}

function isNativeMarginfiOracleSetup(setup) {
  return (
    setup === OracleSetup.None ||
    setup === OracleSetup.PythLegacy ||
    setup === OracleSetup.SwitchboardV2 ||
    setup === OracleSetup.PythPushOracle ||
    setup === OracleSetup.SwitchboardPull ||
    setup === OracleSetup.StakedWithPythPush ||
    setup === OracleSetup.Fixed
  );
}

export function bankMatchesVenueFilter(bank, venueAllowList) {
  return venueAllowList.has(inferBankVenue(bank));
}

export function getBankDisplayName(bank) {
  return firstString(
    bank.tokenSymbol,
    bank.meta?.tokenSymbol,
    bank.meta?.symbol,
    bank.meta?.name,
    bank.metadata?.tokenSymbol,
    bank.metadata?.symbol,
    bank.metadata?.name,
  ) || shortKey(bank.address || bank.mint);
}

export function summarizeVenueCounts(banks) {
  const counts = new Map();
  for (const bank of banks) {
    const venue = inferBankVenue(bank);
    counts.set(venue, (counts.get(venue) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([venue, count]) => `${venue}=${count}`)
    .join(" ");
}

function collectBankText(bank) {
  const values = [];
  collectStringish(values, bank.tokenSymbol);
  collectStringish(values, bank.meta);
  collectStringish(values, bank.metadata);
  collectStringish(values, bank.config?.assetTag);
  collectStringish(values, bank.config?.assetWeightInit);
  return values.join(" ");
}

function collectStringish(out, value) {
  if (!value) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") return;
  if (value.toBase58) return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectStringish(out, item));
    return;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) collectStringish(out, item);
  }
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function shortKey(key) {
  const value = key?.toBase58?.() ?? String(key || "unknown");
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
