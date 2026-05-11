/**
 * Helpers for liquidation debug logs: instruction metas, freshness, LUT classification.
 */

import { SLOT_NEVER_OBSERVED } from "./slot-tracker.js";

/**
 * @param {{ label: string, ix: import("@solana/web3.js").TransactionInstruction }[]} labeledIxs
 * @param {{ verbose: boolean }} opts
 */
export function instructionMetasForLog(labeledIxs, opts) {
  const verbose = opts.verbose === true;
  return labeledIxs.map((row, index) => {
    const ix = row?.ix;
    if (!ix?.programId) {
      return {
        index,
        label: row?.label ?? "?",
        programId: null,
        accountCount: 0,
        writableAccounts: [],
        signerAccounts: [],
        dataLength: 0,
        error: "missing_instruction_or_program_id",
      };
    }
    const programId = ix.programId.toBase58();
    const keys = ix.keys || [];
    const accountsVerbose = keys.map((k, i) => ({
      index: i,
      pubkey: k?.pubkey?.toBase58?.() ?? "<missing>",
      isWritable: k?.isWritable,
      isSigner: k?.isSigner,
    }));
    const writableAccounts = keys
      .filter((k) => k?.isWritable && k?.pubkey != null)
      .map((k) => k?.pubkey?.toBase58?.())
      .filter(Boolean);
    const signerAccounts = keys
      .filter((k) => k?.isSigner && k?.pubkey != null)
      .map((k) => k?.pubkey?.toBase58?.())
      .filter(Boolean);
    const base = {
      index,
      label: row.label,
      programId,
      accountCount: keys.length,
      writableAccounts,
      signerAccounts,
      dataLength: ix.data?.length ?? 0,
    };
    if (verbose) {
      return { ...base, accounts: accountsVerbose };
    }
    return base;
  });
}

/**
 * @param {{ label: string, ix: import("@solana/web3.js").TransactionInstruction }[]} labeledIxs
 * @returns {string[]}
 */
export function unionPubkeysFromLabeledInstructions(labeledIxs) {
  const s = new Set();
  for (const row of labeledIxs) {
    const ix = row?.ix;
    if (!ix?.programId) continue;
    s.add(ix.programId.toBase58());
    for (const k of ix.keys || []) {
      if (k?.pubkey) s.add(k.pubkey.toBase58());
    }
  }
  return [...s];
}

/**
 * @param {import("./cache-freshness.js").CacheFreshness} f
 */
export function staleListsFromCacheFreshness(f) {
  const cur = f.currentSlot;
  /** @type {string[]} */
  const staleBanks = [];
  for (const [k, slot] of Object.entries(f.bankSlots)) {
    if (cur - slot > f.maxBankLagSlots) staleBanks.push(k);
  }
  /** @type {string[]} */
  const staleOracles = [];
  for (const [k, slot] of Object.entries(f.oracleSlots)) {
    if (cur - slot > f.maxOracleLagSlots) staleOracles.push(k);
  }
  /** @type {string[]} */
  const staleIntegrations = [];
  for (const [k, slot] of Object.entries(f.integrationSlots)) {
    if (slot === SLOT_NEVER_OBSERVED || cur - slot > f.maxIntegrationLagSlots) staleIntegrations.push(k);
  }
  return { staleBanks, staleOracles, staleIntegrations };
}

/**
 * @param {import("./cache-freshness.js").CacheFreshness} f
 */
export function freshnessPayloadFromCandidate(f) {
  const { staleBanks, staleOracles, staleIntegrations } = staleListsFromCacheFreshness(f);
  return {
    currentSlot: f.currentSlot,
    accountSlot: f.accountSlot,
    maxAccountLag: f.maxAccountLagSlots,
    staleBanks: staleBanks.length ? staleBanks : undefined,
    staleOracles: staleOracles.length ? staleOracles : undefined,
    staleIntegrations: staleIntegrations.length ? staleIntegrations : undefined,
  };
}

/**
 * @param {string[]} loadedLutAddressesB58 addresses present in `plan.lookupTables`
 * @param {object} cfg
 * @param {string[]} jupiterLutAddresses from `/build` response keys
 */
export function classifyLutAddresses(loadedLutAddressesB58, cfg, jupiterLutAddresses) {
  const agnesSet = new Set(cfg.agnesLookupTables || []);
  const evaSet = new Set(cfg.evaLookupTables || []);
  const jupSet = new Set(jupiterLutAddresses || []);
  /** @type {string[]} */
  const jupiterLuts = [];
  /** @type {string[]} */
  const agnesLuts = [];
  /** @type {string[]} */
  const evaLuts = [];
  for (const a of loadedLutAddressesB58) {
    if (jupSet.has(a)) jupiterLuts.push(a);
    if (agnesSet.has(a)) agnesLuts.push(a);
    if (evaSet.has(a)) evaLuts.push(a);
  }
  return { jupiterLuts, agnesLuts, evaLuts };
}

/**
 * LUT → addresses from Jupiter `addressesByLookupTableAddress` (pre-chain resolution).
 * @param {Record<string, string[]> | undefined} map
 */
export function jupiterLutContentsFromRaw(map) {
  if (!map || typeof map !== "object") return {};
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [lut, addrs] of Object.entries(map)) {
    if (Array.isArray(addrs)) out[lut] = addrs.map(String);
  }
  return out;
}

/**
 * @param {import("@solana/web3.js").MessageV0} message
 * @param {import("@solana/web3.js").AddressLookupTableAccount[]} luts
 */
export function uniqueAccountCountFromCompiledMessage(message, luts) {
  const keys = message.getAccountKeys({ addressLookupTableAccounts: luts });
  const uniq = new Set();
  for (let i = 0; i < keys.length; i++) {
    const k = keys.get(i);
    if (k) uniq.add(k.toBase58());
  }
  return uniq.size;
}

/**
 * @param {import("@solana/web3.js").AddressLookupTableAccount[]} lookupTables
 * @param {boolean} verbose
 */
export function lutContentsForVerbose(lookupTables, verbose) {
  if (!verbose) return undefined;
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const lut of lookupTables) {
    const key = lut.key.toBase58();
    const addresses = lut.state.addresses.map((pk) => pk.toBase58());
    out[key] = addresses;
  }
  return out;
}

/**
 * @param {unknown} err
 * @returns {number | undefined}
 */
export function parseInstructionErrorIndex(err) {
  if (err == null || typeof err !== "object") return undefined;
  const ie = /** @type {{ InstructionError?: [number, unknown] }} */ (err).InstructionError;
  if (Array.isArray(ie) && typeof ie[0] === "number") return ie[0];
  return undefined;
}

/**
 * @param {import("@solana/web3.js").MessageV0} message
 * @param {number | undefined} ixIndex
 * @param {import("@solana/web3.js").AddressLookupTableAccount[]} luts
 */
export function programIdAtCompiledInstructionIndex(message, ixIndex, luts) {
  if (ixIndex == null || ixIndex < 0) return undefined;
  const compiled = message.compiledInstructions[ixIndex];
  if (!compiled) return undefined;
  const keys = message.getAccountKeys({ addressLookupTableAccounts: luts });
  const pid = keys.get(compiled.programIdIndex);
  return pid?.toBase58();
}
