/**
 * Fetches reference mainnet liquidation transactions by signature and writes
 * debug/reference-liquidation-tx-*.json plus debug/reference-liquidation-tx-review.json
 *
 * Usage: node scripts/fetch-reference-liquidation-txs.mjs
 * Requires RPC_URL (e.g. from .env via dotenv).
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Connection, PublicKey } from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";
import { MARGINFI_IDL } from "@0dotxyz/p0-ts-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DEBUG = join(ROOT, "debug");

const SIG_NO_FLASH =
  "23am4iaawHfTFKE2TqnYKUV76NWqD7fN9mkb8ZBhZfUJnKcZsA57ieRdTVWE7crYfnfA1LGhvdMjrTaxzrXPoxYt";
const SIG_FLASH =
  "2aj9nD9bQq4bu5CFfonhk38rfCx4Ar7dc4Nj8AHKhW1AdCM3ay3HGsKdWbiAxfgjMpj6vkxdZ5z2LgKbhievRZTz";
/** Flash classic `lending_account_liquidate` reference (user-provided) for receivership-health builder tests */
const SIG_FLASH_5nGX =
  "5nGXoF8AbNVwinziTsgdR4XjBeEXHua8i8kq5Yb2YNcp2UBiTVGunKGt6TBsVDzVrw2TCj5HdJvtUmsjoNEMXP8F";

const MARGINFI = new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");
const COMPUTE_BUDGET = new PublicKey("ComputeBudget111111111111111111111111111111");

const { BorshInstructionCoder } = anchor;
const ixCoder = new BorshInstructionCoder(MARGINFI_IDL);

function hexDisc(data) {
  if (!data || data.length < 8) return null;
  return Buffer.from(data.slice(0, 8)).toString("hex");
}

function summarizeVersionedTx(tx) {
  const msg = tx.transaction.message;
  const la = tx.meta?.loadedAddresses;
  const accountKeysFromLookups =
    la && Array.isArray(la.writable) && Array.isArray(la.readonly)
      ? {
          writable: la.writable.map((k) => new PublicKey(k)),
          readonly: la.readonly.map((k) => new PublicKey(k)),
        }
      : undefined;
  const keys = msg.getAccountKeys({ accountKeysFromLookups });
  const staticCount = msg.staticAccountKeys?.length ?? 0;

  /** @type {object[]} */
  const instructions = [];
  const compiled = msg.compiledInstructions;
  for (let i = 0; i < compiled.length; i++) {
    const ci = compiled[i];
    const programId = keys.get(ci.programIdIndex);
    const accounts = ci.accountKeyIndexes.map((idx) => ({
      index: idx,
      pubkey: keys.get(idx).toBase58(),
    }));
    const data = Buffer.from(ci.data);
    let marginfiDecoded = null;
    if (programId.equals(MARGINFI)) {
      try {
        marginfiDecoded = ixCoder.decode(data);
      } catch {
        marginfiDecoded = { decodeError: true };
      }
    }
    instructions.push({
      index: i,
      programId: programId.toBase58(),
      programLabel: programId.equals(MARGINFI)
        ? "marginfi"
        : programId.equals(COMPUTE_BUDGET)
          ? "compute_budget"
          : "other",
      dataLength: data.length,
      discriminatorHex: hexDisc(data),
      marginfiInstruction: marginfiDecoded
        ? marginfiDecoded.decodeError
          ? "decode_failed"
          : marginfiDecoded.name
        : null,
      accountCount: accounts.length,
      accountsPreview: accounts.slice(0, 6),
    });
  }

  return {
    signatures: tx.transaction.signatures,
    slot: tx.slot,
    blockTime: tx.blockTime,
    err: tx.meta?.err ?? null,
    version: tx.version,
    staticAccountKeysCount: staticCount,
    loadedWritableAddressesCount: tx.meta?.loadedAddresses?.writable?.length ?? 0,
    loadedReadonlyAddressesCount: tx.meta?.loadedAddresses?.readonly?.length ?? 0,
    computeUnitsConsumed: tx.meta?.computeUnitsConsumed ?? null,
    logMessagesTail: (tx.meta?.logMessages ?? []).slice(-40),
    instructions,
  };
}

/**
 * @param {import("@solana/web3.js").VersionedTransactionResponse} raw
 */
async function buildBuilderTestFixture(connection, raw) {
  const msg = raw.transaction.message;
  const la = raw.meta?.loadedAddresses;
  const accountKeysFromLookups =
    la && Array.isArray(la.writable) && Array.isArray(la.readonly)
      ? {
          writable: la.writable.map((k) => new PublicKey(k)),
          readonly: la.readonly.map((k) => new PublicKey(k)),
        }
      : undefined;
  const keys = msg.getAccountKeys({ accountKeysFromLookups });
  const compiled = msg.compiledInstructions;

  for (const ci of compiled) {
    const programId = keys.get(ci.programIdIndex);
    if (!programId.equals(MARGINFI)) continue;
    const data = Buffer.from(ci.data);
    let decoded;
    try {
      decoded = ixCoder.decode(data);
    } catch {
      continue;
    }
    if (decoded?.name !== "lending_account_liquidate") continue;

    const metas = ci.accountKeyIndexes.map((idx) => ({
      pubkey: keys.get(idx).toBase58(),
      isWritable: msg.isAccountWritable(idx),
      isSigner: msg.isAccountSigner(idx),
    }));

    const liquidatorMarginfiPubkey = metas[3].pubkey;
    const liquidateeMarginfiPubkey = metas[5].pubkey;
    const assetBank = metas[1].pubkey;
    const liabBank = metas[2].pubkey;
    /** Anchor `lending_account_liquidate` accounts (group … token_program) before `remaining_accounts`. */
    const STATIC_ACCOUNT_COUNT = 10;
    const expectedRemainingMetas = metas.slice(STATIC_ACCOUNT_COUNT);
    const liquidateeAccounts = Number(
      decoded.data.liquidateeAccounts?.toString?.() ?? decoded.data.liquidateeAccounts ?? 0,
    );
    const liquidatorAccounts = Number(
      decoded.data.liquidatorAccounts?.toString?.() ?? decoded.data.liquidatorAccounts ?? 0,
    );

    return {
      liquidatorMarginfiPubkey,
      liquidateeMarginfiPubkey,
      assetBank,
      liabBank,
      liquidateeAccounts,
      liquidatorAccounts,
      expectedRemainingMetas,
    };
  }
  throw new Error("lendingAccountLiquidate not found in reference transaction");
}

function agnesExpectedOrder({ flash }) {
  const core = [
    "pre_refresh_*",
    "start_liquidate",
    "venue_withdraw_setup_*",
    "withdraw",
    "jupiter_setup_*",
    "jupiter_swap",
    "jupiter_cleanup?",
    "jupiter_other_*",
    "jupiter_tip?",
    "repay_liability",
    "end_liquidate",
  ];
  if (flash) {
    return ["compute_budget", "flash_borrow (lendingAccountStartFlashloan)", ...core, "flash_repay (lendingAccountEndFlashloan)"];
  }
  return ["compute_budget", ...core];
}

async function main() {
  const rpc = process.env.RPC_URL;
  if (!rpc) {
    console.error("RPC_URL is required");
    process.exit(1);
  }
  mkdirSync(DEBUG, { recursive: true });

  const connection = new Connection(rpc, "confirmed");

  const [rawNoFlash, rawFlash, rawFlash5nGX] = await Promise.all([
    connection.getTransaction(SIG_NO_FLASH, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    }),
    connection.getTransaction(SIG_FLASH, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    }),
    connection.getTransaction(SIG_FLASH_5nGX, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    }),
  ]);

  if (!rawNoFlash) {
    console.error("missing tx", SIG_NO_FLASH);
    process.exit(1);
  }
  if (!rawFlash) {
    console.error("missing tx", SIG_FLASH);
    process.exit(1);
  }
  if (!rawFlash5nGX) {
    console.error("missing tx", SIG_FLASH_5nGX);
    process.exit(1);
  }

  const sumNoFlash = summarizeVersionedTx(rawNoFlash);
  const sumFlash = summarizeVersionedTx(rawFlash);
  const sumFlash5nGX = summarizeVersionedTx(rawFlash5nGX);

  writeFileSync(join(DEBUG, "reference-liquidation-tx-no-flash.json"), JSON.stringify(sumNoFlash, null, 2));
  writeFileSync(join(DEBUG, "reference-liquidation-tx-flash.json"), JSON.stringify(sumFlash, null, 2));

  let builderTest;
  try {
    builderTest = await buildBuilderTestFixture(connection, rawFlash5nGX);
  } catch (e) {
    console.error("buildBuilderTestFixture failed:", e);
    process.exit(1);
  }
  writeFileSync(
    join(DEBUG, "reference-liquidation-tx-flash-5nGX.json"),
    JSON.stringify({ summary: sumFlash5nGX, builderTest, signature: SIG_FLASH_5nGX }, null, 2),
  );

  const marginfiIxNames = (s) =>
    s.instructions.filter((x) => x.programLabel === "marginfi").map((x) => x.marginfiInstruction || "?");

  const fullIxLabel = (x) =>
    x.programLabel === "marginfi" ? `marginfi:${x.marginfiInstruction}` : x.programLabel;

  const review = {
    fetchedAt: new Date().toISOString(),
    referenceNoFlashSignature: SIG_NO_FLASH,
    referenceFlashSignature: SIG_FLASH,
    referenceFlash5nGXSignature: SIG_FLASH_5nGX,
    agnesBuildOrderNoFlash: agnesExpectedOrder({ flash: false }),
    agnesBuildOrderFlash: agnesExpectedOrder({ flash: true }),
    noFlash: {
      slot: sumNoFlash.slot,
      err: sumNoFlash.err,
      instructionCount: sumNoFlash.instructions.length,
      fullInstructionSequence: sumNoFlash.instructions.map(fullIxLabel),
      programIdSequence: sumNoFlash.instructions.map((x) => x.programLabel),
      marginfiInstructionSequence: marginfiIxNames(sumNoFlash),
      hasStartFlashloan: sumNoFlash.instructions.some(
        (x) => x.marginfiInstruction === "lending_account_start_flashloan",
      ),
      hasEndFlashloan: sumNoFlash.instructions.some(
        (x) => x.marginfiInstruction === "lending_account_end_flashloan",
      ),
      hasStartLiquidation: sumNoFlash.instructions.some((x) => x.marginfiInstruction === "start_liquidation"),
      hasLendingLiquidate: sumNoFlash.instructions.some(
        (x) => x.marginfiInstruction === "lending_account_liquidate",
      ),
    },
    flash: {
      slot: sumFlash.slot,
      err: sumFlash.err,
      instructionCount: sumFlash.instructions.length,
      fullInstructionSequence: sumFlash.instructions.map(fullIxLabel),
      programIdSequence: sumFlash.instructions.map((x) => x.programLabel),
      marginfiInstructionSequence: marginfiIxNames(sumFlash),
      hasStartFlashloan: sumFlash.instructions.some(
        (x) => x.marginfiInstruction === "lending_account_start_flashloan",
      ),
      hasEndFlashloan: sumFlash.instructions.some(
        (x) => x.marginfiInstruction === "lending_account_end_flashloan",
      ),
      hasStartLiquidation: sumFlash.instructions.some((x) => x.marginfiInstruction === "start_liquidation"),
      hasLendingLiquidate: sumFlash.instructions.some(
        (x) => x.marginfiInstruction === "lending_account_liquidate",
      ),
    },
    analysisVersusAgnes: {
      liquidationStyle: {
        noFlashReference: "receivership: start_liquidation + end_liquidation (matches Agnes venue=marginfi).",
        flashReference:
          "permissionless classic: lending_account_liquidate inside flash window — not the same as Agnes receivership start/end liquidation.",
        agnesToday:
          "Agnes flash path still wraps receivership core (start_liquidate, withdraw, repay, end_liquidate), not lending_account_liquidate.",
      },
      instructionOrdering: {
        noFlashReference:
          "Top-level order is marginfi:start_liquidation, marginfi:withdraw, then compute_budget (x2), then Jupiter (other), then marginfi:repay, marginfi:end_liquidation. Agnes uses compute_budget first, then the full core.",
        flashReference:
          "Top-level order is marginfi:start_flashloan, marginfi:liquidate, marginfi:withdraw, Jupiter (other), marginfi:repay, marginfi:end_flashloan, then compute_budget (x2) at the end. Agnes places compute_budget first and uses flash begin after CU.",
      },
      initLiqRecord:
        "Neither reference transaction includes marginfi_account_init_liq_record; the liq_record PDA was already present for those liquidatees.",
    },
    diffNotes: [
      "Decode names follow marginfi IDL snake_case (e.g. lending_account_start_flashloan).",
      "Jupiter v6 appears as programId other (JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4) inside logs; compiled top-level may route via a router program in 'other'.",
      "To re-fetch after mainnet prune, run: node scripts/fetch-reference-liquidation-txs.mjs",
    ],
  };

  writeFileSync(join(DEBUG, "reference-liquidation-tx-review.json"), JSON.stringify(review, null, 2));

  console.log("Wrote", join(DEBUG, "reference-liquidation-tx-no-flash.json"));
  console.log("Wrote", join(DEBUG, "reference-liquidation-tx-flash.json"));
  console.log("Wrote", join(DEBUG, "reference-liquidation-tx-flash-5nGX.json"));
  console.log("Wrote", join(DEBUG, "reference-liquidation-tx-review.json"));
  console.log("\nNo-flash marginfi ix:", review.noFlash.marginfiInstructionSequence.join(" -> "));
  console.log("Flash ref marginfi ix:", review.flash.marginfiInstructionSequence.join(" -> "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
