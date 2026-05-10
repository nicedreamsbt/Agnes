import { PublicKey } from "@solana/web3.js";

const SYS = "11111111111111111111111111111111";

/**
 * All integration pubkeys embedded on a marginfi Bank (for gRPC slot tracking).
 * These accounts are typically owned by venue programs, not marginfi.
 * @param {import("@0dotxyz/p0-ts-sdk").Bank} bank
 * @returns {string[]} base58 pubkeys
 */
export function collectIntegrationPubkeysFromBank(bank) {
  const out = [];
  const k = bank?.kaminoIntegrationAccounts;
  if (k) {
    pushPk(out, k.kaminoReserve);
    pushPk(out, k.kaminoObligation);
  }
  const d = bank?.driftIntegrationAccounts;
  if (d) {
    pushPk(out, d.driftSpotMarket);
    pushPk(out, d.driftUser);
    pushPk(out, d.driftUserStats);
  }
  const s = bank?.solendIntegrationAccounts;
  if (s) {
    pushPk(out, s.solendReserve);
    pushPk(out, s.solendObligation);
  }
  const j = bank?.jupLendIntegrationAccounts;
  if (j) {
    pushPk(out, j.jupLendingState);
    pushPk(out, j.jupFTokenVault);
    pushPk(out, j.jupFTokenAta);
  }
  return [...new Set(out)];
}

function pushPk(out, pk) {
  if (!pk) return;
  const s = pk instanceof PublicKey ? pk.toBase58() : String(pk);
  if (s && s !== SYS) out.push(s);
}
