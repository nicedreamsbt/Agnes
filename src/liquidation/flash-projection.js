import { BorshInstructionCoder } from "@coral-xyz/anchor";
import { computeProjectedActiveBanksNoCpi } from "@0dotxyz/p0-ts-sdk";

/**
 * Index of the marginfi user account pubkey in instruction keys for flash projection filtering.
 * Must stay aligned with marginfi IDL account order for each instruction.
 * @param {string} ixName instruction name from Anchor (camelCase or snake_case)
 * @returns {number | null} null = do not include in liquidator projection (unknown / CPI-only)
 */
export function marginfiAccountKeyIndexForFlashFilter(ixName) {
  const n = ixName.includes("_") ? snakeToCamelCase(ixName) : ixName;
  switch (n) {
    case "startLiquidation":
    case "endLiquidation":
    case "marginfiAccountInitLiqRecord":
      return 0;
    case "lendingAccountWithdraw":
    case "lendingAccountRepay":
    case "lendingAccountBorrow":
    case "lendingAccountDeposit":
    case "kaminoDeposit":
    case "kaminoWithdraw":
    case "driftDeposit":
    case "driftWithdraw":
    case "solendDeposit":
    case "solendWithdraw":
    case "juplendDeposit":
    case "juplendWithdraw":
      return 1;
    case "lendingAccountLiquidate":
      return 3; // liquidator_marginfi_account
    default:
      return null;
  }
}

function snakeToCamelCase(s) {
  return s.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
}

/**
 * Keeps only marginfi instructions that target `liquidatorMarginfiPk` for P0's
 * `computeProjectedActiveBanksNoCpi` (which assumes all ixs apply to the same account as `balances`).
 * Liquidation bundles mostly touch the liquidatee; those must be excluded.
 *
 * @param {import("@solana/web3.js").TransactionInstruction[]} instructions
 * @param {import("@coral-xyz/anchor").Program} program
 * @param {import("@solana/web3.js").PublicKey} liquidatorMarginfiPk
 * @returns {import("@solana/web3.js").TransactionInstruction[]}
 */
export function filterInstructionsForLiquidatorFlashProjection(instructions, program, liquidatorMarginfiPk) {
  const coder = new BorshInstructionCoder(program.idl);
  /** @type {import("@solana/web3.js").TransactionInstruction[]} */
  const out = [];
  for (const ix of instructions) {
    if (!ix?.programId?.equals(program.programId)) continue;
    const decoded = coder.decode(ix.data);
    if (!decoded) continue;
    const accIdx = marginfiAccountKeyIndexForFlashFilter(decoded.name);
    if (accIdx == null) continue;
    const meta = ix.keys[accIdx];
    if (!meta?.pubkey?.equals(liquidatorMarginfiPk)) continue;
    out.push(ix);
  }
  return out;
}

/**
 * @param {import("@0dotxyz/p0-ts-sdk").Balance[]} balances liquidator marginfi balances
 * @param {import("@solana/web3.js").TransactionInstruction[]} flashProjectionIxs liquidator-scoped marginfi ixs only
 * @param {import("@coral-xyz/anchor").Program} program
 * @param {object} [logCtx] optional context when projection throws
 */
export function computeProjectedActiveBanksForFlashEnd(balances, flashProjectionIxs, program, logCtx) {
  try {
    return computeProjectedActiveBanksNoCpi(balances, flashProjectionIxs, program);
  } catch (err) {
    const payload = {
      stage: "FLASH_LOAN_BUILD_PROJECTED_BANK_FAIL",
      message: err?.message,
      flashLoanProvider: logCtx?.flashLoanProvider,
      liquidatorMarginfi: logCtx?.liquidatorMarginfi?.toBase58?.(),
      liquidatee: logCtx?.liquidatee?.toBase58?.(),
      assetBank: logCtx?.assetBank,
      liabBank: logCtx?.liabBank,
      instructionLabels: logCtx?.instructionLabels,
      flashProjectionIxCount: flashProjectionIxs.length,
    };
    console.error(JSON.stringify(payload));
    throw err;
  }
}
