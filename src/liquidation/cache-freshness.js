/**
 * @typedef {object} CacheFreshness
 * @property {number} currentSlot
 * @property {number} accountSlot
 * @property {Record<string, number>} bankSlots
 * @property {Record<string, number>} oracleSlots
 * @property {Record<string, number>} integrationSlots
 * @property {number} maxAccountLagSlots
 * @property {number} maxBankLagSlots
 * @property {number} maxOracleLagSlots
 * @property {number} maxIntegrationLagSlots
 */

/**
 * @param {CacheFreshness} f
 * @param {{ requireAllIntegrationObserved?: boolean }} [opts]
 */
export function isFresh(f, opts = {}) {
  const requireInt = opts.requireAllIntegrationObserved !== false;
  if (f.currentSlot - f.accountSlot > f.maxAccountLagSlots) return false;

  for (const slot of Object.values(f.bankSlots)) {
    if (f.currentSlot - slot > f.maxBankLagSlots) return false;
  }

  for (const slot of Object.values(f.oracleSlots)) {
    if (f.currentSlot - slot > f.maxOracleLagSlots) return false;
  }

  const intEntries = Object.entries(f.integrationSlots);
  for (const [key, slot] of intEntries) {
    if (slot < 0) {
      if (requireInt) return false;
      continue;
    }
    if (f.currentSlot - slot > f.maxIntegrationLagSlots) return false;
  }

  return true;
}

/**
 * Missing integration keys (never observed on gRPC) are marked -1 for callers to detect.
 * @param {object} ctx
 * @param {import("./slot-tracker.js").SlotTracker} ctx.slotTracker
 * @param {string} ctx.marginfiAccountKey
 * @param {string[]} ctx.bankKeys
 * @param {string[]} ctx.oracleKeys
 * @param {string[]} ctx.integrationKeys
 * @param {object} ctx.thresholds
 */
export function buildCacheFreshness(ctx) {
  const { slotTracker, marginfiAccountKey, bankKeys, oracleKeys, integrationKeys, thresholds } = ctx;
  const currentSlot = slotTracker.getCurrentSlot();
  const bankSlots = {};
  for (const k of bankKeys) {
    bankSlots[k] = slotTracker.getBankSlot(k);
  }
  const oracleSlots = {};
  for (const k of oracleKeys) {
    oracleSlots[k] = slotTracker.getOracleSlot(k);
  }
  const integrationSlots = {};
  for (const k of integrationKeys) {
    integrationSlots[k] = slotTracker.getIntegrationSlot(k);
  }

  return {
    currentSlot,
    accountSlot: slotTracker.getMarginfiAccountSlot(marginfiAccountKey),
    bankSlots,
    oracleSlots,
    integrationSlots,
    maxAccountLagSlots: thresholds.maxAccountLagSlots,
    maxBankLagSlots: thresholds.maxBankLagSlots,
    maxOracleLagSlots: thresholds.maxOracleLagSlots,
    maxIntegrationLagSlots: thresholds.maxIntegrationLagSlots,
  };
}
