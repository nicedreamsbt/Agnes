import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { buildReceivershipRemainingForLiquidatee } from "../receivership-health.js";
import { DEFAULT_RECEIVER_PROGRAM_ID } from "@pythnetwork/pyth-solana-receiver";

/** Pyth Push Oracle program (same as @pythnetwork/pyth-solana-receiver/lib/address). */
const DEFAULT_PUSH_ORACLE_PROGRAM_ID = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");

/**
 * @typedef {"MISSING_ACCOUNT"|"DUPLICATE_UNEXPECTED"|"INVALID_WRITABLE_FLAG"|"INVALID_SIGNER_FLAG"|"INVALID_PROGRAM_ID"|"ORDER_MISMATCH"} MismatchKind
 */

/**
 * @param {import("@solana/web3.js").AccountMeta} a
 * @param {import("@solana/web3.js").AccountMeta} b
 */
function metaEqual(a, b) {
  return (
    a.pubkey.equals(b.pubkey) &&
    Boolean(a.isSigner) === Boolean(b.isSigner) &&
    Boolean(a.isWritable) === Boolean(b.isWritable)
  );
}

/**
 * @param {import("@solana/web3.js").AccountMeta[]} actual
 * @param {import("@solana/web3.js").AccountMeta[]} expected
 * @param {string} label
 * @param {number} ixIndex
 */
function compareMetaList(actual, expected, label, ixIndex) {
  /** @type {object[]} */
  const mismatches = [];
  const n = Math.max(actual.length, expected.length);
  for (let i = 0; i < n; i++) {
    const a = actual[i];
    const e = expected[i];
    if (!a && e) {
      mismatches.push({
        ixIndex,
        label,
        kind: "MISSING_ACCOUNT",
        expected: `${i}:${e.pubkey.toBase58()} w=${e.isWritable} s=${e.isSigner}`,
        actual: null,
      });
      continue;
    }
    if (a && !e) {
      mismatches.push({
        ixIndex,
        label,
        kind: "ORDER_MISMATCH",
        expected: null,
        actual: `${i}:${a.pubkey.toBase58()} w=${a.isWritable} s=${a.isSigner}`,
      });
      continue;
    }
    if (!metaEqual(a, e)) {
      if (!a.pubkey.equals(e.pubkey)) {
        mismatches.push({
          ixIndex,
          label,
          kind: "ORDER_MISMATCH",
          expected: `${i}:${e.pubkey.toBase58()}`,
          actual: `${i}:${a.pubkey.toBase58()}`,
        });
      } else {
        if (a.isWritable !== e.isWritable) {
          mismatches.push({
            ixIndex,
            label,
            kind: "INVALID_WRITABLE_FLAG",
            expected: e.isWritable,
            actual: a.isWritable,
          });
        }
        if (a.isSigner !== e.isSigner) {
          mismatches.push({
            ixIndex,
            label,
            kind: "INVALID_SIGNER_FLAG",
            expected: e.isSigner,
            actual: a.isSigner,
          });
        }
      }
    }
  }
  return mismatches;
}

/**
 * @param {object} ctx
 * @param {{ label: string, ix: import("@solana/web3.js").TransactionInstruction }[]} labeledIxs
 * @param {import("@0dotxyz/p0-ts-sdk").MarginfiAccountWrapper} liquidateeWrapper
 * @param {import("@0dotxyz/p0-ts-sdk").MarginfiAccount | null} liquidatorAccount
 * @param {Map<string, import("@0dotxyz/p0-ts-sdk").Bank>} bankMap
 * @param {import("@solana/web3.js").PublicKey} marginfiProgramId
 * @param {import("@solana/web3.js").PublicKey} liquidatorSigner
 * @param {import("@solana/web3.js").PublicKey} [ctx.marginfiGroup] group pubkey for classic_lending_liquidate head
 * @param {import("@solana/web3.js").PublicKey} [ctx.liquidationAssetBank] candidate asset bank
 * @param {import("@solana/web3.js").PublicKey} [ctx.liquidationLiabBank] candidate liab bank
 * @param {import("@solana/web3.js").PublicKey} [ctx.liquidatorMarginfiPk] liquidator marginfi account
 * @param {import("@solana/web3.js").PublicKey} [ctx.liquidateeMarginfiPk] liquidatee marginfi account
 * @param {import("@solana/web3.js").AccountMeta[] | null} [ctx.classicLendingLiquidateMetas] snapshot from plan build
 */
export function validateLiquidationAccountOrdering(labeledIxs, ctx) {
  const {
    liquidateeWrapper,
    liquidatorAccount,
    bankMap,
    marginfiProgramId,
    liquidatorSigner,
    marginfiGroup,
    liquidationAssetBank,
    liquidationLiabBank,
    liquidatorMarginfiPk,
    liquidateeMarginfiPk,
    classicLendingLiquidateMetas,
  } = ctx;

  /** @type {object[]} */
  const mismatches = [];
  /** @type {string[]} */
  const missingAccounts = [];
  /** @type {string[]} */
  const unexpectedAccounts = [];
  /** @type {object[]} */
  const writableMismatches = [];
  /** @type {object[]} */
  const signerMismatches = [];

  const { startRemainingAccounts, endRemainingAccounts } = buildReceivershipRemainingForLiquidatee(
    liquidateeWrapper,
    bankMap,
  );

  for (let ixIndex = 0; ixIndex < labeledIxs.length; ixIndex++) {
    const row = labeledIxs[ixIndex];
    const ix = row?.ix;
    const label = row?.label ?? `ix_${ixIndex}`;
    if (!ix?.programId) continue;

    if (label === "start_liquidate" && ix.programId.equals(marginfiProgramId)) {
      const tail = ix.keys.slice(4);
      mismatches.push(...compareMetaList(tail, startRemainingAccounts, label, ixIndex));
    }

    if (label === "end_liquidate" && ix.programId.equals(marginfiProgramId)) {
      const tail = ix.keys.slice(5);
      mismatches.push(...compareMetaList(tail, endRemainingAccounts, label, ixIndex));
    }

    if (label === "classic_lending_liquidate" && ix.programId.equals(marginfiProgramId) && liquidatorAccount) {
      if (
        !marginfiGroup ||
        !liquidationAssetBank ||
        !liquidationLiabBank ||
        !liquidatorMarginfiPk ||
        !liquidateeMarginfiPk
      ) {
        signerMismatches.push({
          ixIndex,
          label,
          detail: "classic_lending_liquidate validation missing marginfiGroup / bank / account pubkeys in ctx",
        });
      } else {
        const head = [
          marginfiGroup,
          liquidationAssetBank,
          liquidationLiabBank,
          liquidatorMarginfiPk,
          liquidatorSigner,
          liquidateeMarginfiPk,
          TOKEN_PROGRAM_ID,
        ];
        for (let i = 0; i < head.length; i++) {
          const k = ix.keys[i];
          if (!k?.pubkey.equals(head[i])) {
            mismatches.push({
              ixIndex,
              label,
              kind: "ORDER_MISMATCH",
              expected: `${i}:${head[i].toBase58()}`,
              actual: k ? `${i}:${k.pubkey.toBase58()}` : null,
            });
          }
        }
        const auth = ix.keys[4];
        if (!auth?.isSigner || !auth.pubkey.equals(liquidatorSigner)) {
          signerMismatches.push({
            ixIndex,
            label,
            detail: "classic_lending_liquidate index 4 (authority) must be liquidator signer",
          });
        }
        if (classicLendingLiquidateMetas && classicLendingLiquidateMetas.length > 0) {
          mismatches.push(...compareMetaList(ix.keys, classicLendingLiquidateMetas, label, ixIndex));
        }
        const seen = new Map();
        for (let i = 0; i < ix.keys.length; i++) {
          const k = ix.keys[i];
          const s = k.pubkey.toBase58();
          if (seen.has(s)) {
            const prev = seen.get(s);
            if (prev.isWritable !== k.isWritable || prev.isSigner !== k.isSigner) {
              signerMismatches.push({
                ixIndex,
                label,
                detail: `duplicate pubkey ${s} at indices with conflicting flags`,
              });
            }
          } else {
            seen.set(s, { isWritable: k.isWritable, isSigner: k.isSigner });
          }
        }
      }
    }

    if (label === "jupiter_swap" || String(label).includes("jupiter")) {
      const hasSigner = ix.keys.some((k) => k.isSigner && k.pubkey.equals(liquidatorSigner));
      if ((label === "jupiter_swap" || label === "jupiter_tip") && !hasSigner) {
        signerMismatches.push({ ixIndex, label, detail: "expected liquidator signer in Jupiter ix" });
      }
    }

    if (label === "repay_liability" && ix.programId.equals(marginfiProgramId)) {
      const auth = ix.keys.find((k) => k.isSigner);
      if (!auth?.pubkey.equals(liquidatorSigner)) {
        signerMismatches.push({ ixIndex, label, detail: "repay authority should be liquidator" });
      }
    }
  }

  for (const m of mismatches) {
    if (m.kind === "MISSING_ACCOUNT") missingAccounts.push(String(m.expected));
    if (m.kind === "ORDER_MISMATCH" && m.actual && !m.expected) unexpectedAccounts.push(String(m.actual));
    if (m.kind === "INVALID_WRITABLE_FLAG") writableMismatches.push(m);
    if (m.kind === "INVALID_SIGNER_FLAG") signerMismatches.push(m);
  }

  return {
    ok: mismatches.length === 0 && signerMismatches.length === 0,
    mismatches,
    missingAccounts: [...new Set(missingAccounts)],
    unexpectedAccounts: [...new Set(unexpectedAccounts)],
    writableMismatches,
    signerMismatches,
  };
}

/**
 * @param {import("@solana/web3.js").TransactionInstruction[]} ixs
 * @param {import("@solana/web3.js").PublicKey} payer
 */
export function validateOracleCrankIxs(ixs, payer) {
  const mismatches = [];
  const recv = new PublicKey(DEFAULT_RECEIVER_PROGRAM_ID);
  const push = new PublicKey(DEFAULT_PUSH_ORACLE_PROGRAM_ID);
  const switchboardOnDemand = new PublicKey("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");
  for (let i = 0; i < ixs.length; i++) {
    const ix = ixs[i];
    const pid = ix.programId;
    if (pid.equals(recv) || pid.equals(push) || pid.equals(switchboardOnDemand)) {
      const payerMeta = ix.keys.find((k) => k.isSigner);
      if (!payerMeta?.pubkey.equals(payer)) {
        mismatches.push({
          ixIndex: i,
          label: "oracle_crank",
          kind: "INVALID_SIGNER_FLAG",
          expected: payer.toBase58(),
          actual: payerMeta?.pubkey?.toBase58?.() ?? null,
        });
      }
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
