import { PublicKey } from "@solana/web3.js";
import { CommitmentLevel } from "./triton-yellowstone.js";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/** Pyth Push oracle program (owns push price accounts like Dpw1…). */
export const PYTH_PUSH_ORACLE_PROGRAM = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";

function pubkeyStrings(pubkeys) {
  return pubkeys.map((pk) => (typeof pk === "string" ? pk : pk.toBase58()));
}

/**
 * Non-default oracle account pubkeys from loaded banks (for client-side filtering).
 */
export function collectWatchedOraclePubkeys(banks) {
  const out = new Set();
  for (const bank of banks) {
    const cfg = bank.config || {};
    for (const k of cfg.oracleKeys || []) {
      const s = k?.toBase58?.() ?? (k != null ? String(k) : "");
      if (s && s !== SYSTEM_PROGRAM) out.add(s);
    }
  }
  return [...out].sort();
}

/**
 * Resolve on-chain owner program for each oracle account so we subscribe to the right
 * Yellowstone owner filters (Pyth Push, Switchboard, etc.).
 */
export async function discoverOracleOwnerPrograms(connection, oraclePubkeyStrings) {
  const owners = new Set();
  const chunk = 100;
  for (let i = 0; i < oraclePubkeyStrings.length; i += chunk) {
    const batch = oraclePubkeyStrings.slice(i, i + chunk).map((s) => new PublicKey(s));
    const infos = await connection.getMultipleAccountsInfo(batch);
    for (let j = 0; j < batch.length; j++) {
      const info = infos[j];
      if (info?.owner) owners.add(info.owner.toBase58());
    }
  }
  return [...owners].sort();
}

/**
 * Yellowstone `SubscribeRequest` (protobuf-shaped plain object for the v5 native client).
 *
 * - `marginfi_program`: all marginfi-owned accounts (banks, user accounts, …); decode with IDL.
 * - `oracle_owner_*`: each distinct oracle **program** id; we only react client-side to
 *   accounts in {@link collectWatchedOraclePubkeys}.
 *
 * @param {object} opts
 * @param {boolean} [opts.includeExplicitMarginfiAccounts=false]
 * @param {boolean} [opts.subscribeSlots=false] — subscribe to chain slot updates (label key is arbitrary).
 */
export function buildSubscribeRequest({
  commitment = CommitmentLevel.PROCESSED,
  marginfiProgramId,
  oracleOwnerProgramIds,
  accountPubkeys = [],
  includeExplicitMarginfiAccounts = false,
  subscribeSlots = false,
}) {
  const programs = [...new Set(pubkeyStrings(oracleOwnerProgramIds))].sort();
  /** @type {Record<string, { account: string[]; owner: string[]; filters: unknown[] }>} */
  const accounts = {
    marginfi_program: { account: [], owner: [marginfiProgramId], filters: [] },
  };
  programs.forEach((programId, i) => {
    accounts[`oracle_owner_${i}`] = { account: [], owner: [programId], filters: [] };
  });
  if (includeExplicitMarginfiAccounts) {
    accounts.marginfi_accounts = { account: pubkeyStrings(accountPubkeys), owner: [], filters: [] };
  }
  /** @type {Record<string, { filterByCommitment?: boolean; interslotUpdates?: boolean }>} */
  const slots = subscribeSlots
    ? {
        chain: {
          filterByCommitment: true,
          interslotUpdates: false,
        },
      }
    : {};
  return {
    accounts,
    slots,
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    commitment,
  };
}

export function commitmentFromConfig(value) {
  const v = String(value || "processed").toLowerCase();
  if (v === "finalized") return CommitmentLevel.FINALIZED;
  if (v === "confirmed") return CommitmentLevel.CONFIRMED;
  return CommitmentLevel.PROCESSED;
}

/**
 * Ping frames must still be a full `SubscribeRequest` shape: the Yellowstone encoder
 * always runs `Object.entries` on accounts/slots/… maps (see geyser.js SubscribeRequest.encode).
 */
export function buildSubscribePingRequest(pingId = Date.now() & 0x7fffffff || 1) {
  return {
    accounts: {},
    slots: {},
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    ping: { id: pingId | 0 },
  };
}
