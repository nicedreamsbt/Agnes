import { getBankDisplayName, inferBankVenue } from "./venues.js";

export function printBankCatalog(banks) {
  console.log("\npreloaded bank catalog");
  const sortedBanks = Array.from(banks).sort((a, b) => getBankDisplayName(a).localeCompare(getBankDisplayName(b)));
  for (const bank of sortedBanks) {
    printBankInfo(bank);
  }
}

export function printBankInfo(bank, prefix = "  bank") {
  const summary = summarizeBank(bank);
  console.log(
    `${prefix} ${summary.symbol} venue=${summary.venue} address=${summary.address} mint=${summary.mint} active=${summary.active}`
  );
  console.log(`    oracleSetup=${summary.oracleSetup} oracleKeys=${summary.oracleKeys.length}`);
  summary.oracleKeys.forEach((oracle, index) => console.log(`      oracle[${index}]=${oracle}`));
  console.log(
    `    weights asset(init=${summary.weights.assetInit}, maint=${summary.weights.assetMaint}) liability(init=${summary.weights.liabilityInit}, maint=${summary.weights.liabilityMaint})`
  );
  console.log(
    `    limits deposit=${summary.limits.depositLimit} borrow=${summary.limits.borrowLimit} emissionMint=${summary.emissions.mint}`
  );
}

export function summarizeBank(bank) {
  const config = bank.config || {};
  return {
    address: toKey(bank.address),
    mint: toKey(bank.mint),
    symbol: getBankDisplayName(bank),
    venue: inferBankVenue(bank),
    active: valueToString(config.operationalState ?? bank.operationalState ?? "unknown"),
    oracleSetup: valueToString(config.oracleSetup ?? bank.oracleSetup ?? "unknown"),
    oracleKeys: (config.oracleKeys || []).map(toKey),
    weights: {
      assetInit: valueToString(config.assetWeightInit ?? bank.assetWeightInit),
      assetMaint: valueToString(config.assetWeightMaint ?? bank.assetWeightMaint),
      liabilityInit: valueToString(config.liabilityWeightInit ?? bank.liabilityWeightInit),
      liabilityMaint: valueToString(config.liabilityWeightMaint ?? bank.liabilityWeightMaint),
    },
    limits: {
      depositLimit: valueToString(config.depositLimit ?? bank.depositLimit),
      borrowLimit: valueToString(config.borrowLimit ?? bank.borrowLimit),
    },
    emissions: {
      mint: toKey(config.emissionsMint ?? bank.emissionsMint, "none"),
    },
  };
}

function toKey(value, fallback = "unknown") {
  if (!value) return fallback;
  return value.toBase58?.() ?? value.toString?.() ?? String(value);
}

function valueToString(value) {
  if (value === undefined || value === null) return "unknown";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return String(value);
  return value.toString?.() ?? JSON.stringify(value);
}
