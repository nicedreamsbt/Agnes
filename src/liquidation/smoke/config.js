import "dotenv/config";
import { PublicKey } from "@solana/web3.js";

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

/**
 * @param {string} s
 * @returns {import("@solana/web3.js").PublicKey | null}
 */
function parsePubkey(s) {
  if (!s) return null;
  try {
    return new PublicKey(s);
  } catch {
    return null;
  }
}

/**
 * Smoke harness env (LIQ_SMOKE_*). Live submit requires both dryRun=false and allowLiveSubmit=true.
 */
export function loadSmokeConfig() {
  const enabled = envBool("LIQ_SMOKE_ENABLED", false);
  const dryRun = envBool("LIQ_SMOKE_DRY_RUN", true);
  const allowLiveSubmit = envBool("LIQ_SMOKE_ALLOW_LIVE_SUBMIT", false);
  const useJito = envBool("LIQ_SMOKE_USE_JITO", true);
  const useRpcBackup = envBool("LIQ_SMOKE_USE_RPC_BACKUP", true);
  const forceOracleCrank = envBool("LIQ_SMOKE_FORCE_ORACLE_CRANK", false);
  const protocol = envStr("LIQ_SMOKE_PROTOCOL", "marginfi").toLowerCase();
  const targetAccount = envStr("LIQ_SMOKE_TARGET_ACCOUNT", "");
  const maxRepayUsd = envFloat("LIQ_SMOKE_MAX_REPAY_USD", 5);
  const minProfitUsd = envFloat("LIQ_SMOKE_MIN_PROFIT_USD", 0);
  const logDir = envStr("LIQ_SMOKE_LOG_DIR", "logs/liquidations/smoke");
  const jitoBlockEngineUrl = envStr("LIQ_SMOKE_JITO_BLOCK_ENGINE_URL", "https://mainnet.block-engine.jito.wtf");
  const jitoTipLamports = envInt("LIQ_SMOKE_JITO_TIP_LAMPORTS", 10_000);
  const jitoTipAccount = parsePubkey(envStr("LIQ_SMOKE_JITO_TIP_ACCOUNT", ""));
  const hermesBaseUrl = envStr("LIQ_SMOKE_HERMES_BASE_URL", "https://hermes.pyth.network");
  const hermesFallbackUrl = envStr("LIQ_SMOKE_HERMES_FALLBACK_URL", "https://hermes-beta.pyth.network");
  const switchboardGatewayUrlRaw = envStr("LIQ_SMOKE_SWITCHBOARD_GATEWAY_URL", "");
  const switchboardGatewayUrl = switchboardGatewayUrlRaw === "" ? null : switchboardGatewayUrlRaw;
  const switchboardNumSignatures = envInt("LIQ_SMOKE_SWITCHBOARD_NUM_SIGNATURES", 3);

  const liveSubmitAllowed = !dryRun && allowLiveSubmit;

  return Object.freeze({
    enabled,
    dryRun,
    allowLiveSubmit,
    liveSubmitAllowed,
    useJito,
    useRpcBackup,
    forceOracleCrank,
    protocol,
    targetAccount,
    targetPubkey: parsePubkey(targetAccount),
    maxRepayUsd,
    minProfitUsd,
    logDir,
    jitoBlockEngineUrl,
    jitoTipLamports,
    jitoTipAccount,
    hermesBaseUrl,
    hermesFallbackUrl,
    switchboardGatewayUrl,
    switchboardNumSignatures,
  });
}
