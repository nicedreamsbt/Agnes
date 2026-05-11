/**
 * @param {object} o
 * @param {import("@solana/web3.js").Connection} o.connection
 * @param {import("@solana/web3.js").VersionedTransaction} o.liquidationTx
 * @param {boolean} o.liveSubmitAllowed
 * @param {boolean} o.useRpcBackup
 */
export async function submitRpcBackup({ connection, liquidationTx, liveSubmitAllowed, useRpcBackup }) {
  if (!useRpcBackup) {
    return { submitted: false, reason: "rpc_backup_disabled" };
  }
  if (!liveSubmitAllowed) {
    return { submitted: false, reason: "dry_run_or_live_submit_not_allowed" };
  }
  try {
    const sig = await connection.sendRawTransaction(liquidationTx.serialize(), {
      skipPreflight: false,
      maxRetries: 2,
    });
    return { submitted: true, signature: sig };
  } catch (e) {
    return { submitted: false, reason: "send_failed", error: String(e?.message || e) };
  }
}
