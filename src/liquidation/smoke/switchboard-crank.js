import { PublicKey } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor-31";
import { OracleSetup } from "@0dotxyz/p0-ts-sdk";
import { AnchorUtils, PullFeed } from "@switchboard-xyz/on-demand";
import { SLOT_NEVER_OBSERVED } from "../slot-tracker.js";

/** Switchboard On-Demand program id (mainnet). */
export const SWITCHBOARD_ON_DEMAND_PID = new PublicKey("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");

/** @param {import("@0dotxyz/p0-ts-sdk").Bank} bank */
export function isSwitchboardPullSetup(bank) {
  const s = bank?.config?.oracleSetup;
  if (s === OracleSetup.SwitchboardV2) return false;
  return (
    s === OracleSetup.SwitchboardPull ||
    s === OracleSetup.KaminoSwitchboardPull ||
    s === OracleSetup.DriftSwitchboardPull ||
    s === OracleSetup.JuplendSwitchboardPull ||
    s === OracleSetup.SolendSwitchboardPull
  );
}

/** @param {import("@0dotxyz/p0-ts-sdk").Bank} bank */
export function primarySwitchboardPullPubkey(bank) {
  const ok = bank.config?.oracleKeys ?? [];
  if (ok[0] && !ok[0].equals(PublicKey.default)) return ok[0];
  return null;
}

/**
 * @param {import("@0dotxyz/p0-ts-sdk").Bank[]} banks
 * @returns {import("@solana/web3.js").PublicKey[]}
 */
export function collectSwitchboardPullFeedAccountsForCrank(banks) {
  /** @type {import("@solana/web3.js").PublicKey[]} */
  const out = [];
  const seen = new Set();
  for (const bank of banks) {
    if (!bank || !isSwitchboardPullSetup(bank)) continue;
    const pk = primarySwitchboardPullPubkey(bank);
    if (!pk) continue;
    const s = pk.toBase58();
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(pk);
  }
  return out;
}

/** @type {import("@coral-xyz/anchor-31").Program | null} */
let _sbProgramCache = null;

/**
 * @param {import("@solana/web3.js").Connection} connection
 * @param {import("@solana/web3.js").Keypair} payer
 */
async function loadSwitchboardProgram(connection, payer) {
  if (_sbProgramCache) return _sbProgramCache;
  const w = new Wallet(payer);
  _sbProgramCache = await AnchorUtils.loadProgramFromConnection(connection, w, SWITCHBOARD_ON_DEMAND_PID);
  return _sbProgramCache;
}

/**
 * @param {object} ctx
 * @param {import("@0dotxyz/p0-ts-sdk").Bank[]} ctx.banks
 * @param {number} ctx.currentSlot
 * @param {object} ctx.cfg
 * @param {boolean} ctx.force
 * @param {import("@solana/web3.js").Connection} ctx.connection
 * @param {import("@solana/web3.js").Keypair} ctx.payer
 */
export async function assessSwitchboardCrankNeed(ctx) {
  const { banks, currentSlot, cfg, force, connection, payer } = ctx;
  const maxLag = cfg.maxOracleLagSlots ?? 100_000;

  /** @type {string[]} */
  const reasons = [];
  /** @type {object[]} */
  const staleSwitchboardPullFeeds = [];
  /** @type {object[]} */
  const missingFeeds = [];

  const program = await loadSwitchboardProgram(connection, payer);

  let hasSwboBank = false;
  for (const bank of banks) {
    if (!bank) continue;
    if (isSwitchboardPullSetup(bank)) hasSwboBank = true;
    const pk = primarySwitchboardPullPubkey(bank);
    if (!pk || !isSwitchboardPullSetup(bank)) continue;

    let lastSlot = SLOT_NEVER_OBSERVED;
    try {
      const feed = new PullFeed(program, pk);
      const data = await feed.loadData();
      if (data?.result?.slot != null) lastSlot = data.result.slot.toNumber();
    } catch {
      missingFeeds.push({ bank: bank.address.toBase58(), feed: pk.toBase58(), message: "loadData_failed" });
      continue;
    }

    const stale = lastSlot === SLOT_NEVER_OBSERVED || currentSlot - lastSlot > maxLag;
    if (stale || force) {
      if (force) reasons.push("force_oracle_crank");
      if (stale) reasons.push("stale_switchboard_pull");
      staleSwitchboardPullFeeds.push({
        pullFeed: pk.toBase58(),
        lastResultSlot: lastSlot === SLOT_NEVER_OBSERVED ? null : lastSlot,
        slotAge: lastSlot === SLOT_NEVER_OBSERVED ? null : currentSlot - lastSlot,
        bank: bank.address?.toBase58?.() ?? "",
        oracleSetup: bank.config?.oracleSetup,
      });
    }
  }

  const uniqueReasons = [...new Set(reasons)];
  const required = force || staleSwitchboardPullFeeds.length > 0;
  let outReasons = uniqueReasons;
  if (!required) {
    outReasons = hasSwboBank ? [] : ["unsupported_switchboard_for_crank"];
  }

  return {
    required,
    reasons: outReasons,
    staleSwitchboardPullFeeds,
    missingFeeds,
  };
}

/**
 * @param {import("@solana/web3.js").Connection} connection
 * @param {import("@solana/web3.js").Keypair} payer
 * @param {import("@solana/web3.js").PublicKey[]} pullFeedPks
 * @param {{ numSignatures?: number, gatewayUrl?: string | null }} [opts]
 */
export async function buildSwitchboardCrankIxs(connection, payer, pullFeedPks, opts = {}) {
  const numSignatures = opts.numSignatures ?? 3;
  const gateway = opts.gatewayUrl ?? undefined;

  await loadSwitchboardProgram(connection, payer);
  const program = /** @type {NonNullable<typeof _sbProgramCache>} */ (_sbProgramCache);

  /** @type {import("@solana/web3.js").TransactionInstruction[]} */
  const ixs = [];
  /** @type {Map<string, import("@solana/web3.js").AddressLookupTableAccount>} */
  const lutByKey = new Map();
  /** @type {{ pullFeed: string, numIxs: number }[]} */
  const feedSummaries = [];
  /** @type {{ priceAccount: string, message: string }[]} */
  const errors = [];

  for (const pullPk of pullFeedPks) {
    try {
      const feed = new PullFeed(program, pullPk);
      /** @type {{ numSignatures: number, gateway?: string }} */
      const params = { numSignatures };
      if (gateway) params.gateway = gateway;
      const res = await feed.fetchUpdateIx(params);
      const pullIxs = res[0];
      const luts = res[3] ?? [];
      if (!pullIxs?.length) {
        errors.push({ priceAccount: pullPk.toBase58(), message: "fetchUpdateIx_empty" });
        continue;
      }
      for (const ix of pullIxs) ixs.push(ix);
      for (const lut of luts) {
        if (lut?.key) lutByKey.set(lut.key.toBase58(), lut);
      }
      feedSummaries.push({ pullFeed: pullPk.toBase58(), numIxs: pullIxs.length });
    } catch (e) {
      errors.push({ priceAccount: pullPk.toBase58(), message: String(e?.message || e) });
    }
  }

  return { ixs, lookupTables: [...lutByKey.values()], feedSummaries, errors };
}
