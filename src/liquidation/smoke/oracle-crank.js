import { BorshAccountsCoder, Wallet } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { OracleSetup } from "@0dotxyz/p0-ts-sdk";
import { HermesClient } from "@pythnetwork/hermes-client";
import {
  PythSolanaReceiver,
  getPriceFeedAccountForProgram,
  pythSolanaReceiverIdl,
} from "@pythnetwork/pyth-solana-receiver";
import { SLOT_NEVER_OBSERVED } from "../slot-tracker.js";

const PUSH_ORACLE_PID = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");

/** Hermes returned no usable payload for one or more feed ids in a shard. */
export class HermesBrokenFeedError extends Error {
  /**
   * @param {number} shardId
   * @param {string[]} missingIds
   */
  constructor(shardId, missingIds) {
    super(`Hermes broken feeds (shard ${shardId}): missing ${missingIds.join(", ")}`);
    this.name = "HermesBrokenFeedError";
    this.shardId = shardId;
    this.missingIds = missingIds;
  }
}

/**
 * @param {string} id
 */
function normalizeHermesFeedId(id) {
  const s = String(id).trim().toLowerCase();
  return s.startsWith("0x") ? s : `0x${s}`;
}

/**
 * @param {string[]} idsForShard
 * @param {import("@pythnetwork/hermes-client").PriceUpdate} priceUpdate
 */
function missingHermesFeedIds(idsForShard, priceUpdate) {
  const parsed = priceUpdate?.parsed ?? [];
  const returned = new Set(parsed.map((p) => normalizeHermesFeedId(p.id)));
  return idsForShard.filter((id) => !returned.has(normalizeHermesFeedId(id)));
}

/**
 * @param {string} primaryUrl
 * @param {string | null | undefined} fallbackUrl
 * @param {string[]} ids
 * @param {{ encoding: "base64"; parsed: true }} opts
 */
async function getLatestPriceUpdatesWithFallback(primaryUrl, fallbackUrl, ids, opts) {
  try {
    const c = new HermesClient(primaryUrl, {});
    return { url: primaryUrl, update: await c.getLatestPriceUpdates(ids, opts) };
  } catch (primaryErr) {
    if (!fallbackUrl) throw primaryErr;
    const c2 = new HermesClient(fallbackUrl, {});
    return { url: fallbackUrl, update: await c2.getLatestPriceUpdates(ids, opts) };
  }
}

/** @param {import("@0dotxyz/p0-ts-sdk").Bank} bank */
export function primaryOraclePubkey(bank) {
  const ok = bank.config?.oracleKeys || [];
  if (bank.oracleKey && !bank.oracleKey.equals(PublicKey.default)) return bank.oracleKey;
  if (ok[0] && !ok[0].equals(PublicKey.default)) return ok[0];
  return null;
}

/** @param {import("@0dotxyz/p0-ts-sdk").Bank} bank */
export function isPythPushStyleSetup(bank) {
  const s = bank.config?.oracleSetup;
  return (
    s === OracleSetup.PythPushOracle ||
    s === OracleSetup.StakedWithPythPush ||
    s === OracleSetup.KaminoPythPush ||
    s === OracleSetup.DriftPythPull ||
    s === OracleSetup.JuplendPythPull ||
    s === OracleSetup.SolendPythPull
  );
}

/**
 * @param {Buffer} data
 * @returns {{ feedId: Buffer, feedHex: string } | null}
 */
function decodePriceUpdateV2FeedId(data) {
  try {
    const coder = new BorshAccountsCoder(pythSolanaReceiverIdl);
    const decoded = coder.decode("priceUpdateV2", data);
    const feedArr = decoded?.priceMessage?.feedId;
    if (!feedArr) return null;
    const feedId = Buffer.from(feedArr);
    if (feedId.length !== 32) return null;
    return { feedId, feedHex: "0x" + feedId.toString("hex") };
  } catch {
    return null;
  }
}

/**
 * Posted slot from on-chain Pyth Push price account (for stale detection).
 * @param {Buffer} data
 * @returns {number | null}
 */
export function decodePostedSlotFromPushAccount(data) {
  try {
    const coder = new BorshAccountsCoder(pythSolanaReceiverIdl);
    const decoded = coder.decode("priceUpdateV2", data);
    const ps = decoded?.postedSlot;
    if (ps == null) return null;
    if (typeof ps.toNumber === "function") return ps.toNumber();
    const n = Number(ps);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * @param {PublicKey} priceFeedAccount
 * @param {Buffer} feedId
 */
function resolveShardForPriceAccount(priceFeedAccount, feedId) {
  const maxShard = 4096;
  for (let shardId = 0; shardId < maxShard; shardId++) {
    const derived = getPriceFeedAccountForProgram(shardId, feedId, PUSH_ORACLE_PID);
    if (derived.equals(priceFeedAccount)) return shardId;
  }
  return null;
}

/**
 * Unique push-oracle price accounts for banks in scope (for crank build).
 * @param {import("@0dotxyz/p0-ts-sdk").Bank[]} banks
 * @returns {import("@solana/web3.js").PublicKey[]}
 */
export function collectPushOraclePriceAccountsForCrank(banks) {
  /** @type {import("@solana/web3.js").PublicKey[]} */
  const out = [];
  const seen = new Set();
  for (const bank of banks) {
    if (!bank || !isPythPushStyleSetup(bank)) continue;
    const pk = primaryOraclePubkey(bank);
    if (!pk) continue;
    const s = pk.toBase58();
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(pk);
  }
  return out;
}

/**
 * @param {object} ctx
 * @param {import("@0dotxyz/p0-ts-sdk").Bank[]} ctx.banks
 * @param {import("../slot-tracker.js").SlotTracker} ctx.slotTracker
 * @param {number} ctx.currentSlot
 * @param {object} ctx.cfg
 * @param {boolean} ctx.force
 * @param {string} [ctx.venue]
 */
export function assessOracleCrankNeed(ctx) {
  const { banks, slotTracker, currentSlot, cfg, force, venue = "" } = ctx;
  const maxLag = cfg.maxOracleLagSlots ?? 100_000;
  /** @type {string[]} */
  const reasons = [];
  /** @type {object[]} */
  const stalePythPushFeeds = [];
  /** @type {string[]} */
  const missingFeeds = [];
  const venuePreRefreshRequired = ["kamino", "drift", "juplend"].includes(String(venue).toLowerCase());

  const seen = new Set();
  let hasPushStyleBank = false;
  for (const bank of banks) {
    if (!bank) continue;
    if (isPythPushStyleSetup(bank)) hasPushStyleBank = true;
    const pk = primaryOraclePubkey(bank);
    if (!pk) continue;
    const s = pk.toBase58();
    if (seen.has(s)) continue;
    seen.add(s);

    const slot = slotTracker.getOracleSlot(s);
    const stale = slot === SLOT_NEVER_OBSERVED || currentSlot - slot > maxLag;
    if (isPythPushStyleSetup(bank) && (stale || force)) {
      if (force) reasons.push("force_oracle_crank");
      if (stale) reasons.push("stale_oracle");
      if (slot === SLOT_NEVER_OBSERVED) missingFeeds.push(s);
      stalePythPushFeeds.push({
        priceAccount: s,
        slot: slot === SLOT_NEVER_OBSERVED ? null : slot,
        slotAge: slot === SLOT_NEVER_OBSERVED ? null : currentSlot - slot,
        bank: bank.address?.toBase58?.() ?? "",
        oracleSetup: bank.config?.oracleSetup,
      });
    }
  }

  const uniqueReasons = [...new Set(reasons)];
  const required = force || stalePythPushFeeds.length > 0;
  let outReasons = uniqueReasons;
  if (!required) {
    outReasons = hasPushStyleBank ? [] : ["unsupported_oracle_for_crank"];
  }

  return {
    required,
    reasons: outReasons,
    stalePythPushFeeds,
    missingFeeds,
    venuePreRefreshRequired,
  };
}

/**
 * @param {import("@solana/web3.js").Connection} connection
 * @param {import("@solana/web3.js").Keypair} payer
 * @param {PublicKey[]} priceAccountPks
 * @param {string | { primaryUrl: string, fallbackUrl?: string | null }} hermesOpts
 */
export async function buildPythPushCrankIxs(connection, payer, priceAccountPks, hermesOpts) {
  const primaryUrl = typeof hermesOpts === "string" ? hermesOpts : (hermesOpts?.primaryUrl ?? "https://hermes.pyth.network");
  const fallbackUrl = typeof hermesOpts === "string" ? null : (hermesOpts?.fallbackUrl ?? null);

  const wallet = new Wallet(payer);
  const receiver = new PythSolanaReceiver({
    connection,
    wallet,
  });

  /** @type {{ priceAccount: string, feedHex: string, shardId: number }[]} */
  const feedSummaries = [];
  /** @type {Buffer[]} */
  const vaas = [];
  /** @type {{ shardId: number, missingIds: string[] }[]} */
  const brokenFeeds = [];
  /** @type {string[]} */
  const hermesUrlsUsed = [];

  for (const pricePk of priceAccountPks) {
    const info = await connection.getAccountInfo(pricePk, "processed");
    if (!info?.data) continue;
    if (!info.owner.equals(PUSH_ORACLE_PID)) continue;
    const parsed = decodePriceUpdateV2FeedId(Buffer.from(info.data));
    if (!parsed) continue;
    const shardId = resolveShardForPriceAccount(pricePk, parsed.feedId);
    if (shardId == null) continue;
    feedSummaries.push({ priceAccount: pricePk.toBase58(), feedHex: parsed.feedHex, shardId });
  }

  if (feedSummaries.length === 0) {
    return { ixs: [], ephemeralSigners: [], feedSummaries: [], vaas: [], brokenFeeds: [], hermesEndpointUsed: null };
  }

  /** @type {Map<number, string[]>} */
  const idsByShard = new Map();
  for (const row of feedSummaries) {
    if (!idsByShard.has(row.shardId)) idsByShard.set(row.shardId, []);
    idsByShard.get(row.shardId).push(row.feedHex);
  }

  /** @type {import("@solana/web3.js").TransactionInstruction[]} */
  const flatIxs = [];
  /** @type {import("@solana/web3.js").Keypair[]} */
  const ephemeralSigners = [];

  const hermesRequestOpts = { encoding: /** @type {const} */ ("base64"), parsed: true };

  for (const [shardId, idsForShard] of idsByShard) {
    let { url, update } = await getLatestPriceUpdatesWithFallback(primaryUrl, fallbackUrl, idsForShard, hermesRequestOpts);
    hermesUrlsUsed.push(url);

    let missing = missingHermesFeedIds(idsForShard, update);
    if (missing.length && fallbackUrl && url === primaryUrl) {
      try {
        const c2 = new HermesClient(fallbackUrl, {});
        const upd2 = await c2.getLatestPriceUpdates(idsForShard, hermesRequestOpts);
        const missing2 = missingHermesFeedIds(idsForShard, upd2);
        if (missing2.length === 0 || missing2.length < missing.length) {
          url = fallbackUrl;
          update = upd2;
          missing = missing2;
          hermesUrlsUsed.push(fallbackUrl);
        }
      } catch {
        /* keep primary response; HermesBrokenFeedError may still throw below */
      }
    }

    if (missing.length) {
      brokenFeeds.push({ shardId, missingIds: missing });
      throw new HermesBrokenFeedError(shardId, missing);
    }

    const blobs = update?.binary?.data;
    if (!Array.isArray(blobs) || blobs.length === 0) {
      brokenFeeds.push({ shardId, missingIds: idsForShard });
      throw new HermesBrokenFeedError(shardId, idsForShard);
    }
    const b64 = blobs.length === 1 ? blobs[0] : blobs.join("");
    const { postInstructions, closeInstructions } = await receiver.buildUpdatePriceFeedInstructions([b64], shardId);
    vaas.push(Buffer.from(b64, "base64"));
    for (const row of [...postInstructions, ...closeInstructions]) {
      flatIxs.push(row.instruction);
      for (const kp of row.signers || []) {
        ephemeralSigners.push(kp);
      }
    }
  }

  const hermesEndpointUsed = hermesUrlsUsed.length ? hermesUrlsUsed[hermesUrlsUsed.length - 1] : primaryUrl;

  return { ixs: flatIxs, ephemeralSigners, feedSummaries, vaas, brokenFeeds, hermesEndpointUsed };
}

/**
 * @param {object} o
 * @param {import("@solana/web3.js").TransactionInstruction[]} o.ixs
 * @param {import("@solana/web3.js").PublicKey} o.payer
 * @param {string} o.recentBlockhash
 * @param {import("@solana/web3.js").AddressLookupTableAccount[]} [o.lookupTables]
 * @param {number} [o.computeUnitLimit]
 */
export function compileOracleCrankTx({ ixs, payer, recentBlockhash, lookupTables = [], computeUnitLimit = 1_400_000 }) {
  if (!ixs?.length) return null;
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit });
  const instructions = [cu, ...ixs];
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash,
    instructions,
  }).compileToV0Message(lookupTables);
  return new VersionedTransaction(message);
}
