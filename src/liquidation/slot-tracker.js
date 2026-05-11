/** Slot we use when a pubkey has never been observed (integration gRPC gap). */
export const SLOT_NEVER_OBSERVED = -1;

export class SlotTracker {
  constructor() {
    /** @type {number} */
    this._chainTipSlot = 0;
    /** @type {Map<string, number>} */
    this._marginfiAccount = new Map();
    /** @type {Map<string, number>} */
    this._bank = new Map();
    /** @type {Map<string, number>} */
    this._oracle = new Map();
    /** @type {Map<string, number>} */
    this._integration = new Map();
  }

  /**
   * Yellowstone slot subscription or max(account slots) fallback.
   * @param {number | string | bigint | null | undefined} slot
   */
  recordChainTip(slot) {
    const n = parseSlot(slot);
    if (n !== null && n > this._chainTipSlot) this._chainTipSlot = n;
  }

  bumpChainTipFromAccount(slot) {
    const n = parseSlot(slot);
    if (n !== null && n > this._chainTipSlot) this._chainTipSlot = n;
  }

  getCurrentSlot() {
    return this._chainTipSlot;
  }

  recordMarginfiAccount(key, slot) {
    const n = parseSlot(slot);
    if (n === null) return;
    this._marginfiAccount.set(key, n);
    if (n > this._chainTipSlot) this._chainTipSlot = n;
  }

  getMarginfiAccountSlot(key) {
    return this._marginfiAccount.get(key) ?? SLOT_NEVER_OBSERVED;
  }

  recordBank(key, slot) {
    const n = parseSlot(slot);
    if (n === null) return;
    this._bank.set(key, n);
    if (n > this._chainTipSlot) this._chainTipSlot = n;
  }

  getBankSlot(key) {
    return this._bank.get(key) ?? SLOT_NEVER_OBSERVED;
  }

  recordOracle(key, slot) {
    const n = parseSlot(slot);
    if (n === null) return;
    this._oracle.set(key, n);
    if (n > this._chainTipSlot) this._chainTipSlot = n;
  }

  getOracleSlot(key) {
    return this._oracle.get(key) ?? SLOT_NEVER_OBSERVED;
  }

  recordIntegration(key, slot) {
    const n = parseSlot(slot);
    if (n === null) return;
    this._integration.set(key, n);
    if (n > this._chainTipSlot) this._chainTipSlot = n;
  }

  getIntegrationSlot(key) {
    return this._integration.get(key) ?? SLOT_NEVER_OBSERVED;
  }

  /**
   * Cold-start hint: one RPC `getSlot` (not a hot-path account revalidation).
   * Seeds banks/oracles/integration keys so freshness is not permanently blocked before first gRPC tick.
   * @param {number} slot
   * @param {object} opts
   * @param {string[]} [opts.bankKeys]
   * @param {string[]} [opts.oracleKeys]
   * @param {string[]} [opts.integrationKeys]
   */
  seedFromRpcSlot(slot, opts = {}) {
    if (!Number.isFinite(slot) || slot <= 0) return;
    if (this._chainTipSlot < slot) this._chainTipSlot = slot;
    for (const k of opts.bankKeys || []) {
      if (!this._bank.has(k)) this._bank.set(k, slot);
    }
    for (const k of opts.oracleKeys || []) {
      if (!this._oracle.has(k)) this._oracle.set(k, slot);
    }
    for (const k of opts.integrationKeys || []) {
      if (!this._integration.has(k)) this._integration.set(k, slot);
    }
  }
}

function parseSlot(slot) {
  if (slot === undefined || slot === null) return null;
  const s = String(slot);
  if (s === "" || s === "0") return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
