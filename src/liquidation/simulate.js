import { parseInstructionErrorIndex } from "./liq-tx-metadata.js";

/**
 * Full transaction simulation as the final gate (uses RPC; not hot-path account revalidation).
 * @param {import("@solana/web3.js").Connection} connection
 * @param {import("@solana/web3.js").VersionedTransaction} tx
 */
export async function validatePlanBySimulation(connection, tx) {
  const sim = await connection.simulateTransaction(tx, {
    commitment: "processed",
    replaceRecentBlockhash: true,
    sigVerify: false,
  });

  if (sim.value.err) {
    return { ok: false, err: sim.value.err, logs: sim.value.logs ?? [], unitsConsumed: sim.value.unitsConsumed };
  }

  const logs = sim.value.logs ?? [];
  const failed = logs.some(
    (l) =>
      l.includes("insufficient funds") ||
      l.includes("SlippageToleranceExceeded") ||
      l.includes("stale") ||
      l.includes("custom program error"),
  );

  if (failed) {
    return { ok: false, err: "log_heuristic", logs, unitsConsumed: sim.value.unitsConsumed };
  }

  return { ok: true, err: null, logs, unitsConsumed: sim.value.unitsConsumed };
}

function logHeuristicIndicatesFailure(logs) {
  return logs.some(
    (l) =>
      l.includes("insufficient funds") ||
      l.includes("SlippageToleranceExceeded") ||
      l.includes("stale") ||
      l.includes("custom program error"),
  );
}

/**
 * Rich simulation for liquidation debug logs (inner instructions; optional raw RPC for extra fields).
 * @param {import("@solana/web3.js").Connection} connection
 * @param {import("@solana/web3.js").VersionedTransaction} tx
 * @param {{ fetchRawPostBalances?: boolean, verboseRaw?: boolean }} [opts]
 */
export async function simulateForAgnes(connection, tx, opts = {}) {
  const config = {
    commitment: "processed",
    replaceRecentBlockhash: true,
    sigVerify: false,
    innerInstructions: true,
  };

  const sim = await connection.simulateTransaction(tx, config);
  const value = sim.value;
  const logs = value.logs ?? [];
  const failedInstructionIndex = parseInstructionErrorIndex(value.err);

  let postTokenBalances = null;
  let rawValue = null;
  if (opts.fetchRawPostBalances && typeof connection._rpcRequest === "function") {
    try {
      const enc = Buffer.from(tx.serialize()).toString("base64");
      const unsafe = await connection._rpcRequest("simulateTransaction", [
        enc,
        {
          encoding: "base64",
          commitment: "processed",
          replaceRecentBlockhash: true,
          sigVerify: false,
          innerInstructions: true,
        },
      ]);
      rawValue = unsafe?.result?.value ?? null;
      if (rawValue?.postTokenBalances) postTokenBalances = rawValue.postTokenBalances;
    } catch {
      /* RPC may omit postTokenBalances; optional path */
    }
  }

  const rpcOk = !value.err;
  let gateOk = rpcOk;
  if (gateOk && logHeuristicIndicatesFailure(logs)) {
    gateOk = false;
  }

  return {
    rpcOk,
    gateOk,
    err: value.err,
    logs,
    unitsConsumed: value.unitsConsumed,
    failedInstructionIndex,
    innerInstructions: value.innerInstructions ?? null,
    postTokenBalances,
    rawSimulationValue: opts.verboseRaw ? rawValue : undefined,
  };
}
