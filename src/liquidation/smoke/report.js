import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { instructionMetasForLog } from "../liq-tx-metadata.js";

function jsonReplacer(_k, v) {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof PublicKey) return v.toBase58();
  return v;
}

const REDACT_KEY_RE = /(apikey|api_key|authorization|secret|seed|keypair|password|token|grpc_x_token|jupiter_api)/i;

/**
 * @param {unknown} v
 */
function redactDeep(v) {
  if (v == null) return v;
  if (typeof v === "string") {
    if (/https?:\/\/[^\s]+api-key=/i.test(v)) {
      return v.replace(/api-key=[^&\s]+/gi, "api-key=<redacted>");
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(redactDeep);
  if (typeof v === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (REDACT_KEY_RE.test(k)) {
        out[k] = "<redacted>";
        continue;
      }
      out[k] = redactDeep(val);
    }
    return out;
  }
  return v;
}

/**
 * @param {object} parts
 */
export function buildSmokeReport(parts) {
  const {
    targetAccount,
    protocol,
    slot,
    health,
    liquidatable,
    candidate,
    cappedRepayUsd,
    oracleCrank,
    liquidationInstructions,
    accountOrderingValidation,
    transactions,
    simulation,
    jitoBundle,
    rpcBackup,
    liveSubmit,
    classification,
    mode,
    status,
    planSkipReason,
    errors,
  } = parts;

  return redactDeep({
    tag: "LIQ_SMOKE_TEST_RESULT",
    mode,
    status,
    classification,
    target: { account: targetAccount, protocol, slot },
    health,
    liquidatable,
    candidate,
    cappedRepayUsd,
    oracleCrank,
    liquidationInstructions,
    accountOrderingValidation,
    transactions,
    simulation,
    jitoBundle,
    rpcBackup,
    liveSubmit,
    planSkipReason,
    errors,
    generatedAt: new Date().toISOString(),
  });
}

/**
 * @param {string} logDir
 * @param {object} report
 * @param {string} targetAccountB58
 */
export function writeSmokeReport(logDir, report, targetAccountB58) {
  fs.mkdirSync(logDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const short = targetAccountB58.length > 12 ? `${targetAccountB58.slice(0, 8)}_${targetAccountB58.slice(-4)}` : targetAccountB58;
  const named = path.join(logDir, `${ts}-${short}.json`);
  const latest = path.join(logDir, "latest-smoke-report.json");
  const tmp = path.join(logDir, `.latest-smoke-report.${process.pid}.tmp`);
  const text = JSON.stringify(report, jsonReplacer, 2);
  fs.writeFileSync(named, text, "utf8");
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, latest);
  return { named, latest };
}

/**
 * @param {{ label: string, ix: import("@solana/web3.js").TransactionInstruction }[]} labeledIxs
 */
export function labeledIxsToReportRows(labeledIxs) {
  return instructionMetasForLog(labeledIxs || [], { verbose: false });
}

/**
 * @param {import("@solana/web3.js").TransactionInstruction[]} ixs
 */
export function rawIxsToReportRows(ixs) {
  return (ixs || []).map((ix, index) => ({
    index,
    label: `oracle_crank_${index}`,
    programId: ix.programId?.toBase58?.() ?? null,
    accountCount: ix.keys?.length ?? 0,
    writableAccounts: (ix.keys || []).filter((k) => k.isWritable).map((k) => k.pubkey.toBase58()),
    signerAccounts: (ix.keys || []).filter((k) => k.isSigner).map((k) => k.pubkey.toBase58()),
    dataLength: ix.data?.length ?? 0,
  }));
}
