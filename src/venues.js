const KNOWN_VENUES = ["marginfi", "kamino", "juplend", "drift", "unknown"];

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

export function inferBankVenue(bank) {
  const haystack = collectBankText(bank).toLowerCase();
  if (haystack.includes("kamino") || haystack.includes("klend") || haystack.includes("k-lend")) return "kamino";
  if (haystack.includes("juplend") || haystack.includes("jup lend") || haystack.includes("jupiter lend")) return "juplend";
  if (haystack.includes("drift")) return "drift";
  if (!haystack) return "unknown";
  return "marginfi";
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
