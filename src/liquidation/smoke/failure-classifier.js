import { createLiqAttemptLogger } from "../liq-attempt-logger.js";

export const SmokeFailureClass = {
  ACCOUNT_ORDER_INVALID: "ACCOUNT_ORDER_INVALID",
  MISSING_ACCOUNT: "MISSING_ACCOUNT",
  INVALID_WRITABLE_FLAG: "INVALID_WRITABLE_FLAG",
  INVALID_SIGNER_FLAG: "INVALID_SIGNER_FLAG",
  ORACLE_STALE: "ORACLE_STALE",
  ORACLE_CRANK_BUILD_FAILED: "ORACLE_CRANK_BUILD_FAILED",
  ORACLE_CRANK_BROKEN_FEEDS: "ORACLE_CRANK_BROKEN_FEEDS",
  SWITCHBOARD_CRANK_BUILD_FAILED: "SWITCHBOARD_CRANK_BUILD_FAILED",
  LIQUIDATION_BUILD_FAILED: "LIQUIDATION_BUILD_FAILED",
  SIMULATION_FAILED: "SIMULATION_FAILED",
  JITO_BUNDLE_BUILD_FAILED: "JITO_BUNDLE_BUILD_FAILED",
  RPC_BACKUP_BUILD_FAILED: "RPC_BACKUP_BUILD_FAILED",
  UNKNOWN: "UNKNOWN",
};

/**
 * @param {unknown} err
 * @param {object} [ctx]
 * @returns {keyof typeof SmokeFailureClass}
 */
export function classifySmokeFailure(err, ctx = {}) {
  const msg = String(err?.message ?? err ?? "");
  const stage = ctx.stage ?? "";

  if (stage === "oracle_crank" || msg.includes("Hermes") || msg.includes("Pyth")) {
    return SmokeFailureClass.ORACLE_CRANK_BUILD_FAILED;
  }
  if (stage === "jito" || msg.includes("sendBundle") || msg.includes("getTipAccounts")) {
    return SmokeFailureClass.JITO_BUNDLE_BUILD_FAILED;
  }
  if (stage === "rpc_backup") {
    return SmokeFailureClass.RPC_BACKUP_BUILD_FAILED;
  }
  if (stage === "liquidation_build" || ctx.skipReason) {
    return SmokeFailureClass.LIQUIDATION_BUILD_FAILED;
  }
  if (stage === "simulation" || msg.includes("simulation")) {
    return SmokeFailureClass.SIMULATION_FAILED;
  }
  if (ctx.accountOrder && !ctx.accountOrder.ok) {
    const kinds = new Set((ctx.accountOrder.mismatches || []).map((m) => m.kind));
    if (kinds.has("MISSING_ACCOUNT")) return SmokeFailureClass.MISSING_ACCOUNT;
    if (kinds.has("INVALID_WRITABLE_FLAG")) return SmokeFailureClass.INVALID_WRITABLE_FLAG;
    if (kinds.has("INVALID_SIGNER_FLAG")) return SmokeFailureClass.INVALID_SIGNER_FLAG;
    return SmokeFailureClass.ACCOUNT_ORDER_INVALID;
  }
  if (msg.toLowerCase().includes("stale")) return SmokeFailureClass.ORACLE_STALE;

  return SmokeFailureClass.UNKNOWN;
}

/**
 * @param {object} cfg
 * @param {object} entry
 */
export function logSmokeToLiqDebug(cfg, entry) {
  const logger = createLiqAttemptLogger(cfg);
  if (!logger) return;
  logger.logAttemptEntry({ ...entry, source: "liq:smoke" });
}
