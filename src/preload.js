import { PublicKey } from "@solana/web3.js";
import { MarginfiAccount } from "@0dotxyz/p0-ts-sdk";
import { getAllMarginfiAccountsFull } from "./marginfi-account-addresses.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableRpcError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  if (msg.includes("429") || msg.includes("too many")) return true;
  if (msg.includes("503") || msg.includes("502") || msg.includes("504")) return true;
  const code = err?.code;
  if (code === "ECONNRESET" || code === "ETIMEDOUT") return true;
  return false;
}

/**
 * @typedef {object} PreloadStats
 * @property {number} decoded
 * @property {number} decodeErrors
 * @property {number} skippedMissing
 * @property {number} skippedOwner
 * @property {number} rpcChunkErrors
 * @property {number} processed
 * @property {number} totalToProcess
 * @property {number} elapsedMs
 */

/**
 * Warm-path: GPA full group accounts, then keep only pubkeys in `targetKeys`.
 * Fallback: parallel getMultipleAccountsInfo with progress.
 *
 * @param {object} p
 * @param {import("@solana/web3.js").Connection} p.connection
 * @param {import("@coral-xyz/anchor").Program} p.program
 * @param {import("@solana/web3.js").PublicKey} p.groupPk
 * @param {string} p.programId — base58 marginfi program id
 * @param {import("@coral-xyz/anchor").Idl} p.idl
 * @param {string[]} p.addressListBase58
 * @param {number} p.cap
 * @param {import("@solana/web3.js").Commitment} [p.commitment]
 * @param {boolean} p.useGpa
 * @param {number} p.chunkSize
 * @param {number} p.concurrency
 * @param {number} p.progressIntervalMs
 * @param {(s: string) => void} [p.log]
 * @param {(s: string) => void} [p.warn]
 * @param {(pkStr: string, raw: Buffer, acc: import("@0dotxyz/p0-ts-sdk").MarginfiAccount) => void} [p.onAccount]
 *   When set, each decoded account is delivered here and **not** retained in returned maps (avoids ~2× heap for large preloads).
 * @returns {Promise<{ rawByKey: Map<string, Buffer>; decodedByKey: Map<string, import("@0dotxyz/p0-ts-sdk").MarginfiAccount>; stats: PreloadStats; method: "gpa" | "mga" }>}
 */
export async function preloadMarginfiAccountsIntoMaps(p) {
  const log = p.log ?? ((s) => console.log(s));
  const warn = p.warn ?? ((s) => console.warn(s));
  const commitment = p.commitment ?? "confirmed";
  const programIdPk = new PublicKey(p.programId);
  const cap = Math.min(p.cap, p.addressListBase58.length);
  const targetKeys = new Set(p.addressListBase58.slice(0, cap));
  const onAccount = p.onAccount;

  const rawByKey = new Map();
  const decodedByKey = new Map();

  /**
   * @param {string} pkStr
   * @param {Buffer} data
   * @param {import("@0dotxyz/p0-ts-sdk").MarginfiAccount} acc
   */
  function recordDecoded(pkStr, data, acc) {
    if (onAccount) {
      onAccount(pkStr, data, acc);
    } else {
      rawByKey.set(pkStr, data);
      decodedByKey.set(pkStr, acc);
    }
  }
  /** @type {PreloadStats} */
  const stats = {
    decoded: 0,
    decodeErrors: 0,
    skippedMissing: 0,
    skippedOwner: 0,
    rpcChunkErrors: 0,
    processed: 0,
    totalToProcess: cap,
    elapsedMs: 0,
  };

  const t0 = Date.now();

  if (p.useGpa && p.addressListBase58.length > 0) {
    try {
      const tGpa = Date.now();
      const full = await getAllMarginfiAccountsFull(p.program, p.groupPk);
      let matched = 0;
      let decodeOk = 0;
      let decodeBad = 0;
      for (const { pubkey, data } of full) {
        const pkStr = pubkey.toBase58();
        if (!targetKeys.has(pkStr)) continue;
        matched++;
        try {
          const acc = MarginfiAccount.fromAccountDataRaw(pubkey, data, p.idl);
          recordDecoded(pkStr, data, acc);
          decodeOk++;
        } catch {
          decodeBad++;
        }
      }
      stats.decoded = decodeOk;
      stats.decodeErrors = decodeBad;
      stats.processed = matched;
      stats.elapsedMs = Date.now() - t0;
      const rel = (Date.now() - tGpa) / 1000;
      log(
        `[preload] GPA returned ${full.length} group accounts (${matched} matched preload cap set) decoded=${decodeOk} decodeErrs=${decodeBad} in ${rel.toFixed(2)}s`,
      );
      return { rawByKey, decodedByKey, stats, method: "gpa" };
    } catch (e) {
      warn(`[preload] GPA failed (${String(e?.message || e)}), falling back to parallel MGA`);
    }
  }

  const pubkeysToFetch = p.addressListBase58.slice(0, cap).map((s) => new PublicKey(s));
  const cs = Math.min(Math.max(1, p.chunkSize), 100);
  /** @type {import("@solana/web3.js").PublicKey[][]} */
  const chunks = [];
  for (let i = 0; i < pubkeysToFetch.length; i += cs) {
    chunks.push(pubkeysToFetch.slice(i, i + cs));
  }

  let chunkIndex = 0;
  let inflight = 0;
  const maxWorkers = Math.min(Math.max(1, p.concurrency), Math.max(1, chunks.length));

  async function fetchOneChunk(chunk) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const infos = await p.connection.getMultipleAccountsInfo(chunk, commitment);
        for (let i = 0; i < chunk.length; i++) {
          const pk = chunk[i];
          const pkStr = pk.toBase58();
          stats.processed++;
          const info = infos[i];
          if (!info?.data) {
            stats.skippedMissing++;
            continue;
          }
          if (!info.owner.equals(programIdPk)) {
            stats.skippedOwner++;
            continue;
          }
          const buf = Buffer.from(info.data);
          try {
            const acc = MarginfiAccount.fromAccountDataRaw(pk, buf, p.idl);
            recordDecoded(pkStr, buf, acc);
            stats.decoded++;
          } catch {
            stats.decodeErrors++;
          }
        }
        return;
      } catch (e) {
        if (attempt === 2) {
          stats.rpcChunkErrors++;
          stats.processed += chunk.length;
          warn(
            `[preload] chunk RPC failed after retries firstPk=${chunk[0]?.toBase58?.() ?? "?"} err=${e?.message || e}`,
          );
          return;
        }
        if (isRetryableRpcError(e)) {
          await sleep(Math.min(2000, 200 * 2 ** attempt));
        } else {
          warn(`[preload] non-retryable RPC error err=${e?.message || e}`);
          await sleep(300);
        }
      }
    }
  }

  let doneFlag = false;
  const progressTick = () => {
    if (doneFlag) return;
    const elapsed = (Date.now() - t0) / 1000;
    const pct = stats.totalToProcess ? ((100 * stats.processed) / stats.totalToProcess).toFixed(1) : "0";
    const rate = elapsed > 0 ? (stats.processed / elapsed).toFixed(0) : "0";
    const remaining = Math.max(0, stats.totalToProcess - stats.processed);
    const eta = remaining > 0 && Number(rate) > 0 ? (remaining / Number(rate)).toFixed(1) : "?";
    log(
      `[preload] processed=${stats.processed}/${stats.totalToProcess} (${pct}%) decoded=${stats.decoded} rpcErrBatches=${stats.rpcChunkErrors} decodeErrs=${stats.decodeErrors} missing=${stats.skippedMissing} wrongOwner=${stats.skippedOwner} rate=${rate}/s eta=${eta}s inflight=${inflight}`,
    );
  };

  const progressIv =
    p.progressIntervalMs > 0 ? setInterval(progressTick, p.progressIntervalMs) : null;
  if (progressIv) progressIv.unref?.();

  async function worker() {
    while (true) {
      const idx = chunkIndex++;
      if (idx >= chunks.length) break;
      const chunk = chunks[idx];
      inflight++;
      await fetchOneChunk(chunk);
      inflight--;
    }
  }

  try {
    await Promise.all(Array.from({ length: maxWorkers }, () => worker()));
  } finally {
    doneFlag = true;
    if (progressIv) clearInterval(progressIv);
  }

  progressTick();
  stats.elapsedMs = Date.now() - t0;
  return { rawByKey, decodedByKey, stats, method: "mga" };
}
