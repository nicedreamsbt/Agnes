import "dotenv/config";
import fs from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { getConfig as p0GetConfig } from "@0dotxyz/p0-ts-sdk";

/** @typedef {"production"|"staging"|"staging-mainnet-clone"|"staging-alt"} P0Environment */

const P0_ENVIRONMENTS = new Set(["production", "staging", "staging-mainnet-clone", "staging-alt"]);

/** Default Eva01 main-pool LUT addresses (same as `jupiter-build.js`). */
const DEFAULT_EVA_LOOKUP_TABLES = [
  "HGmknUTUmeovMc9ryERNWG6UFZDFDVr9xrum3ZhyL4fC",
  "5FuKF7C1tJji2mXZuJ14U9oDb37is5mmvYLf4KwojoF1",
  "FEFhAFKz48P3w82Ds5VhvyEDwhRqu2FejmnuxEPZ8wNR",
];

function envStr(key, fallback = "") {
  const v = process.env[key];
  if (v === undefined || v === null) return fallback;
  const t = String(v).trim();
  return t === "" ? fallback : t;
}

function envBool(key, defaultVal = false) {
  const v = process.env[key];
  if (v === undefined || v === null || String(v).trim() === "") return defaultVal;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return defaultVal;
}

function envInt(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === null || String(v).trim() === "") return fallback;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function envFloat(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === null || String(v).trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function splitComma(key) {
  return envStr(key, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {string} s
 * @returns {import("@solana/web3.js").PublicKey | undefined}
 */
function optionalPubkey(s) {
  if (!s) return undefined;
  try {
    return new PublicKey(s);
  } catch {
    return undefined;
  }
}

function resolveWalletKeypairPath() {
  const explicit = envStr("AGNES_WALLET_KEYPAIR_PATH", "");
  if (explicit) return explicit;
  const fallback = "liquidator.json";
  try {
    if (fs.existsSync(fallback)) return fallback;
  } catch {
    /* ignore */
  }
  return undefined;
}

function mergeUniqueStrings(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const s of list || []) {
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * Shared configuration for the monitor (when present), RPC verify, and liquidation smoke tools.
 * Loads `.env` via `dotenv` on first import of this module.
 */
export function loadConfig() {
  const p0EnvironmentRaw = envStr("MARGINFI_ENV", envStr("P0_ENV", "production"));
  /** @type {P0Environment} */
  const p0Environment = P0_ENVIRONMENTS.has(p0EnvironmentRaw) ? /** @type {P0Environment} */ (p0EnvironmentRaw) : "production";

  const programOverride = optionalPubkey(envStr("MARGINFI_PROGRAM_ID", ""));
  const groupOverride = optionalPubkey(envStr("MARGINFI_GROUP_PK", ""));

  /** @type {{ programId?: import("@solana/web3.js").PublicKey, groupPk?: import("@solana/web3.js").PublicKey }} */
  const p0ConfigOverrides = {};
  if (programOverride) p0ConfigOverrides.programId = programOverride;
  if (groupOverride) p0ConfigOverrides.groupPk = groupOverride;

  const resolvedP0 = p0GetConfig(p0Environment, p0ConfigOverrides);

  const rpcUrl = envStr("RPC_URL", "https://api.mainnet-beta.solana.com");
  const grpcEndpoint = envStr("GRPC_ENDPOINT", "");
  const grpcToken = envStr("GRPC_X_TOKEN", "");

  const evaFromEnv = splitComma("EVA_LOOKUP_TABLES");
  const evaLookupTables = evaFromEnv.length > 0 ? evaFromEnv : [...DEFAULT_EVA_LOOKUP_TABLES];

  const agnesLookupTables = mergeUniqueStrings(splitComma("AGNES_LOOKUP_TABLES"), splitComma("ADDRESS_LOOKUP_TABLES"));

  const grpcOracleExtra = splitComma("GRPC_ORACLE_OWNER_PROGRAMS");

  /** Empty string disables on-disk marginfi account cache; unset uses default path. */
  const cacheFileRaw = process.env.AGNES_MARGINFI_ACCOUNT_CACHE_FILE;
  const agnesMarginfiAccountCacheFile =
    cacheFileRaw === undefined || cacheFileRaw === null
      ? ".cache/marginfi-accounts.json"
      : String(cacheFileRaw).trim() === ""
        ? ""
        : String(cacheFileRaw).trim();

  return {
    rpcUrl,
    p0Environment,
    p0ConfigOverrides,

    grpcEndpoint,
    grpcToken,
    grpcOracleOwnerProgramIds: grpcOracleExtra,
    /** Duplicate pubkey subscribe; default false — owner=marginfi filter already covers all program accounts. */
    grpcSubscribeExplicitAccounts: envBool("GRPC_SUBSCRIBE_EXPLICIT_ACCOUNTS", false),
    grpcSubscribeSlots: envBool("GRPC_SUBSCRIBE_SLOTS", false),
    grpcLogSlotUpdates: envBool("GRPC_LOG_SLOT_UPDATES", false),
    grpcLogAccountUpdateSlot: envBool("GRPC_LOG_ACCOUNT_UPDATE_SLOT", false),

    marginfiProgramId: resolvedP0.programId.toBase58(),
    marginfiGroupPk: resolvedP0.groupPk.toBase58(),
    marginfiAccounts: splitComma("MARGINFI_ACCOUNTS"),
    commitment: envStr("COMMITMENT", "processed"),

    venuesFilter: envStr("VENUES", "all"),
    printBankCatalog: envBool("PRINT_BANK_CATALOG", true),
    refreshOraclesOnUpdate: envBool("REFRESH_ORACLES_ON_UPDATE", true),
    logFile: envStr("LOG_FILE", ""),

    catalogMode: envStr("CATALOG_MODE", "auto"),
    catalogSummaryThreshold: envInt("CATALOG_SUMMARY_THRESHOLD", 500),
    rpcPreloadMarginfiAccounts: envBool("RPC_PRELOAD_MARGINFI_ACCOUNTS", false),
    rpcPreloadMaxAccounts: envInt("RPC_PRELOAD_MAX_ACCOUNTS", 50000),
    rpcPreloadConcurrency: Math.max(1, envInt("RPC_PRELOAD_CONCURRENCY", 16)),
    rpcPreloadChunkSize: Math.min(100, Math.max(1, envInt("RPC_PRELOAD_CHUNK_SIZE", 100))),
    rpcPreloadProgressIntervalMs: Math.max(100, envInt("RPC_PRELOAD_PROGRESS_INTERVAL_MS", 1000)),
    rpcPreloadUseGpa: envBool("RPC_PRELOAD_USE_GPA", true),
    agnesMarginfiAccountCacheFile,
    agnesMarginfiAccountCacheSaveDebounceMs: Math.max(1000, envInt("AGNES_MARGINFI_ACCOUNT_CACHE_SAVE_DEBOUNCE_MS", 30_000)),

    agnesWalletKeypairPath: resolveWalletKeypairPath(),
    agnesLiquidatorMarginfiAccount: envStr("AGNES_LIQUIDATOR_MARGINFI_ACCOUNT", ""),
    agnesAllowSend: envBool("AGNES_ALLOW_SEND", false),

    flashLoanProvider: envStr("FLASH_LOAN_PROVIDER", ""),

    jupiterSwapApiBase: envStr("JUPITER_SWAP_API_BASE", "https://lite-api.jup.ag/swap/v2"),
    jupiterApiKey: envStr("JUPITER_API_KEY", ""),
    jupiterMaxAccounts: envInt("JUPITER_MAX_ACCOUNTS", 28),
    jupiterOnlyDirectRoutes: envBool("JUPITER_ONLY_DIRECT_ROUTES", false),
    jupiterExcludeDexes: envStr("JUPITER_EXCLUDE_DEXES", ""),

    agnesComputeUnitLimit: envInt("AGNES_COMPUTE_UNIT_LIMIT", 1_400_000),
    agnesComputeUnitPriceMicroLamports: envInt("AGNES_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS", 0),
    agnesUseMarginfiDefaultLuts: envBool("AGNES_USE_MARGINFI_DEFAULT_LUTS", true),
    agnesUseSupplementalLiquidationLuts: envBool("AGNES_USE_SUPPLEMENTAL_LIQUIDATION_LUTS", true),
    agnesLookupTables,
    evaLookupTables,

    agnesLiqDebug: envBool("AGNES_LIQ_DEBUG", false),
    agnesLiqDebugVerbose: envBool("AGNES_LIQ_DEBUG_VERBOSE", false),

    maxAccountLagSlots: envInt("MAX_ACCOUNT_LAG_SLOTS", 100_000),
    maxBankLagSlots: envInt("MAX_BANK_LAG_SLOTS", 100_000),
    maxOracleLagSlots: envInt("MAX_ORACLE_LAG_SLOTS", 100_000),
    maxIntegrationLagSlots: envInt("MAX_INTEGRATION_LAG_SLOTS", 100_000),
    strictIntegrationFreshness: envBool("STRICT_INTEGRATION_FRESHNESS", false),

    agnesMinDebtUsd: envFloat("AGNES_MIN_DEBT_USD", 0),
    agnesMinAbsHealthUsd: envFloat("AGNES_MIN_ABS_HEALTH_USD", 0),
    agnesMinBonusUsd: envFloat("AGNES_MIN_BONUS_USD", 0),
  };
}
