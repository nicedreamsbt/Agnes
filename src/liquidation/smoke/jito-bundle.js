import { SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { buildLabeledAgnesInstructionList } from "../plan.js";

/** @type {string[] | null} */
let _tipAccountsCache = null;
/** @type {number} */
let _tipAccountsCacheAt = 0;
const TIP_CACHE_MS = 60_000;

/**
 * @param {string} blockEngineOrigin e.g. https://mainnet.block-engine.jito.wtf
 */
export async function fetchJitoTipAccounts(blockEngineOrigin) {
  const now = Date.now();
  if (_tipAccountsCache && now - _tipAccountsCacheAt < TIP_CACHE_MS) {
    return _tipAccountsCache;
  }
  const url = new URL("/api/v1/getTipAccounts", blockEngineOrigin.replace(/\/$/, "")).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`getTipAccounts HTTP ${res.status}${t ? `: ${t.slice(0, 200)}` : ""}`);
  }
  const json = await res.json();
  const arr = json?.result;
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error("getTipAccounts: empty result");
  }
  _tipAccountsCache = arr.map(String);
  _tipAccountsCacheAt = now;
  return _tipAccountsCache;
}

export function pickRandomTipAccount() {
  if (!_tipAccountsCache?.length) return null;
  const i = Math.floor(Math.random() * _tipAccountsCache.length);
  return _tipAccountsCache[i];
}

/**
 * Compile liquidation plan to v0, optionally appending a SOL tip when Jupiter did not include one.
 * @param {object} plan Agnes liquidation plan from buildAgnesLiquidationPlan
 * @param {import("@solana/web3.js").PublicKey} payer
 * @param {string} recentBlockhash
 * @param {object | null} flashCtx
 * @param {{ addJitoTip: boolean, tipAccount: import("@solana/web3.js").PublicKey | null, tipLamports: number }} tipOpts
 */
export async function compileLiquidationTxForSmoke(plan, payer, recentBlockhash, flashCtx, tipOpts) {
  let labeledIxs = await buildLabeledAgnesInstructionList(plan, flashCtx);
  if (tipOpts.addJitoTip && tipOpts.tipAccount && tipOpts.tipLamports > 0 && !plan.jupiterTipIx) {
    const tipIx = SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: tipOpts.tipAccount,
      lamports: BigInt(tipOpts.tipLamports),
    });
    labeledIxs = [...labeledIxs, { label: "jito_smoke_tip_transfer", ix: tipIx }];
  }
  const instructions = labeledIxs.map((r) => r.ix);
  try {
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash,
      instructions,
    }).compileToV0Message(plan.lookupTables || []);
    const tx = new VersionedTransaction(message);
    tx.serialize();
    return { ok: true, tx, labeledIxs };
  } catch (err) {
    return { ok: false, err, labeledIxs };
  }
}

/**
 * @param {object} o
 * @param {import("@solana/web3.js").VersionedTransaction | null} [o.crankTx]
 * @param {import("@solana/web3.js").VersionedTransaction[]} [o.crankTxs]
 * @param {import("@solana/web3.js").VersionedTransaction} o.liquidationTx
 * @param {import("@solana/web3.js").Keypair} o.signer
 * @param {import("@solana/web3.js").Keypair[]} [o.crankEphemeralSigners]
 */
export function signSmokeBundle({ crankTx, crankTxs = [], liquidationTx, signer, crankEphemeralSigners = [] }) {
  const crankList = [];
  if (crankTx) crankList.push(crankTx);
  for (const t of crankTxs) {
    if (t) crankList.push(t);
  }
  for (const t of crankList) {
    t.sign([signer, ...crankEphemeralSigners]);
  }
  liquidationTx.sign([signer]);
}

/**
 * @param {(import("@solana/web3.js").VersionedTransaction | null)[]} txs
 */
export function validateBundleShape(txs) {
  const filtered = txs.filter(Boolean);
  if (filtered.length === 0) return { ok: false, err: "empty_bundle" };
  if (filtered.length > 5) return { ok: false, err: "bundle_too_many_txs" };
  for (const tx of filtered) {
    if (!tx.message?.recentBlockhash) return { ok: false, err: "missing_blockhash" };
    try {
      const ser = tx.serialize();
      if (ser.length > 1232) return { ok: false, err: `tx_oversize_${ser.length}` };
    } catch (e) {
      return { ok: false, err: String(e?.message || e) };
    }
  }
  return { ok: true };
}

/**
 * @param {import("@solana/web3.js").VersionedTransaction[]} txs
 */
export function bundleToBase64Array(txs) {
  return txs.map((tx) => Buffer.from(tx.serialize()).toString("base64"));
}

/**
 * @param {string} blockEngineOrigin
 * @param {string[]} base64Txs
 * @param {string} [requestId]
 */
export async function sendJitoBundle(blockEngineOrigin, base64Txs, requestId = "1") {
  const url = new URL("/api/v1/bundles", blockEngineOrigin.replace(/\/$/, "")).toString();
  const body = {
    jsonrpc: "2.0",
    id: requestId,
    method: "sendBundle",
    params: [base64Txs, { encoding: "base64" }],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await res.json().catch(async () => ({ parseError: await res.text() }));
  if (!res.ok) {
    return { ok: false, httpStatus: res.status, raw };
  }
  const bundleId = raw?.result ?? null;
  const err = raw?.error ?? null;
  if (err) return { ok: false, bundleId: null, raw, err };
  return { ok: true, bundleId, raw };
}
