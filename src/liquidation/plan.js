import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { makeBeginFlashLoanIx, makeEndFlashLoanIx, MarginfiAccountWrapper, makeWithdrawIx } from "@0dotxyz/p0-ts-sdk";
import { BigNumber } from "bignumber.js";
import BN from "bn.js";
import {
  makeStartLiquidationIx,
  makeEndLiquidationIx,
  makeRepayIx,
  makeClassicLendingLiquidateIx,
  makeInitLiquidationRecordIx,
} from "./marginfi-receivership.js";
import { deriveLiquidationRecord } from "./pda.js";
import { computeProjectedActiveBanksForFlashEnd } from "./flash-projection.js";
import { fetchFeeStateAccounts } from "./fee-state.js";
import { pickVenueHandler } from "./venues/index.js";
import { buildReceivershipRemainingForLiquidatee, buildClassicLiquidateRemainingAccounts } from "./receivership-health.js";
import {
  jupiterSwapBuildGet,
  parseJupiterBuildResponse,
  fetchLookupTableAccounts,
  JupiterBuildHttpError,
  buildJupiterRouteSummary,
  MARGINFI_MAINNET_EVA01_ADDRESS_LOOKUP_TABLES,
  MAINNET_LIQUIDATION_SUPPLEMENTAL_LOOKUP_TABLES,
} from "./jupiter-build.js";
import { SkipReason } from "./candidate.js";

/** When primary `JUPITER_MAX_ACCOUNTS` has no route, retry `/build` with at least this cap before giving up. */
const JUPITER_WIDEN_MAX_ACCOUNTS = 32;

/**
 * @typedef {object} LabeledIx
 * @property {string} label
 * @property {import("@solana/web3.js").TransactionInstruction} ix
 */

/**
 * @typedef {object} AgnesLiquidationPlan
 * @property {object} candidate
 * @property {string} flashLoanProvider
 * @property {import("@solana/web3.js").TransactionInstruction | null} flashBorrowIx
 * @property {import("@solana/web3.js").TransactionInstruction | null} flashRepayIx
 * @property {import("@solana/web3.js").TransactionInstruction[]} preRefreshIxs
 * @property {import("@solana/web3.js").TransactionInstruction | null} startLiquidateIx
 * @property {import("@solana/web3.js").TransactionInstruction[]} venueWithdrawPrepIxs
 * @property {import("@solana/web3.js").TransactionInstruction | null} venueWithdrawIx
 * @property {import("@solana/web3.js").TransactionInstruction | null} repayLiabilityIx
 * @property {import("@solana/web3.js").TransactionInstruction | null} endLiquidateIx
 * @property {import("@solana/web3.js").TransactionInstruction[]} jupiterSetupIxs
 * @property {import("@solana/web3.js").TransactionInstruction | null} jupiterSwapIx
 * @property {import("@solana/web3.js").TransactionInstruction | null} jupiterCleanupIx
 * @property {import("@solana/web3.js").TransactionInstruction[]} jupiterOtherIxs
 * @property {import("@solana/web3.js").TransactionInstruction | null} jupiterTipIx
 * @property {import("@solana/web3.js").AddressLookupTableAccount[]} lookupTables
 * @property {bigint} expectedInAmount
 * @property {bigint} expectedOutAmount
 * @property {bigint} minOutAmount
 * @property {number} estimatedCuLimit
 * @property {number} expectedProfitUsd
 * @property {string} [skipReason]
 * @property {object} [_jupiterDebug]
 * @property {Error} [_planBuildError]
 * @property {object} [_bankHydrationDebug]
 * @property {"receivership" | "classic_flash"} [liquidationBundleKind]
 * @property {import("@solana/web3.js").TransactionInstruction | null} [classicLendingLiquidateIx]
 * @property {import("@solana/web3.js").AccountMeta[] | null} [classicLendingLiquidateMetas] snapshot of ix.keys at plan build (for smoke validator)
 * @property {number} [computeUnitPriceMicroLamports]
 * @property {boolean} [usesMarginfiFlashWrap] true when classic_flash (marginfi flash envelope)
 * @property {import("@solana/web3.js").TransactionInstruction | null} [initLiqRecordIx] receivership only: marginfi_account_init_liq_record when PDA missing
 * @property {boolean} [needsInitLiqRecord] true when receivership path must create LiquidationRecord first
 */

/**
 * @param {import("@solana/web3.js").PublicKey | string} pk
 */
function normalizeBankPubkey(pk) {
  return pk instanceof PublicKey ? pk : new PublicKey(pk);
}

/**
 * @param {import("@0dotxyz/p0-ts-sdk").Bank | undefined | null} b
 */
function isBankHydratedForSdk(b) {
  if (!b?.mint || !b?.address) return false;
  if (b.mintDecimals == null) return false;
  return true;
}

/**
 * @param {bigint} withdrawAmountNative
 * @param {import("@0dotxyz/p0-ts-sdk").Bank} bank
 */
function withdrawNativeToUiAmount(withdrawAmountNative, bank) {
  const md =
    typeof bank.mintDecimals === "number"
      ? bank.mintDecimals
      : bank.mintDecimals?.toNumber?.() ?? 0;
  return new BigNumber(withdrawAmountNative.toString()).dividedBy(new BigNumber(10).pow(md));
}

/** @param {import("@solana/web3.js").Connection} connection */
async function getMintOwnerOrTokenProgram(connection, mintPk) {
  const ai = await connection.getAccountInfo(mintPk, "processed");
  return ai?.owner ?? TOKEN_PROGRAM_ID;
}

/**
 * Flash ctx for compile: classic_flash always wraps; receivership never wraps (even if env FLASH_LOAN_PROVIDER=marginfi).
 * @param {AgnesLiquidationPlan} plan
 * @param {import("@0dotxyz/p0-ts-sdk").Project0Client} client
 * @param {import("@0dotxyz/p0-ts-sdk").MarginfiAccount | null | undefined} liquidatorDecoded
 */
export function resolveAgnesFlashCtx(plan, client, liquidatorDecoded) {
  if (plan.liquidationBundleKind === "classic_flash") {
    if (!liquidatorDecoded) return null;
    return { client, liquidatorMarginfiAccount: liquidatorDecoded };
  }
  return null;
}

/**
 * @param {AgnesLiquidationPlan} plan
 * @param {object} [flashCtx] required for classic_flash
 * @returns {Promise<LabeledIx[]>}
 */
export async function buildLabeledAgnesInstructionList(plan, flashCtx = null) {
  if (plan.liquidationBundleKind === "receivership") {
    return buildReceivershipReferenceLabeledList(plan);
  }
  if (plan.liquidationBundleKind === "classic_flash") {
    return buildClassicFlashReferenceLabeledList(plan, flashCtx);
  }
  throw new Error(`unknown liquidationBundleKind: ${plan.liquidationBundleKind}`);
}

/**
 * Match debug/reference-liquidation-tx-no-flash.json: start, withdraw, CU limit+price, Jupiter, repay, end.
 * @param {AgnesLiquidationPlan} plan
 */
function buildReceivershipReferenceLabeledList(plan) {
  const v = plan.candidate.venue;
  const initLabeled = plan.initLiqRecordIx ? [{ label: "init_liq_record", ix: plan.initLiqRecordIx }] : [];
  const preLabeled = (plan.preRefreshIxs || []).map((ix, i) => ({
    label: `${v}_pre_refresh_${i}`,
    ix,
  }));
  const venueWithdrawRows = [
    ...(plan.venueWithdrawPrepIxs || []).map((ix, i) => ({ label: `${v}_withdraw_setup_${i}`, ix })),
    { label: `${v}_withdraw`, ix: plan.venueWithdrawIx },
  ].filter((row) => row.ix);

  const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({
    units: plan.estimatedCuLimit || 1_400_000,
  });
  const cuPrice = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: BigInt(plan.computeUnitPriceMicroLamports ?? 0),
  });

  const jupiterLabeled = [
    ...(plan.jupiterSetupIxs || []).map((ix, i) => ({ label: `jupiter_setup_${i}`, ix })),
    { label: "jupiter_swap", ix: plan.jupiterSwapIx },
    ...(plan.jupiterCleanupIx ? [{ label: "jupiter_cleanup", ix: plan.jupiterCleanupIx }] : []),
    ...(plan.jupiterOtherIxs || []).map((ix, i) => ({ label: `jupiter_other_${i}`, ix })),
    ...(plan.jupiterTipIx ? [{ label: "jupiter_tip", ix: plan.jupiterTipIx }] : []),
  ].filter((row) => row.ix);

  /** @type {LabeledIx[]} */
  const head = [
    ...initLabeled,
    ...preLabeled,
    { label: "start_liquidate", ix: plan.startLiquidateIx },
    ...venueWithdrawRows,
  ].filter((row) => row.ix);

  /** @type {LabeledIx[]} */
  const tail = [
    { label: "repay_liability", ix: plan.repayLiabilityIx },
    { label: "end_liquidate", ix: plan.endLiquidateIx },
  ].filter((row) => row.ix);

  return [
    ...head,
    { label: "compute_budget_limit", ix: cuLimit },
    { label: "compute_budget_price", ix: cuPrice },
    ...jupiterLabeled,
    ...tail,
  ];
}

/**
 * Match debug/reference-liquidation-tx-flash.json: flash begin, liquidate, withdraw, Jupiter, repay, flash end, CU price+limit.
 * @param {AgnesLiquidationPlan} plan
 * @param {object} flashCtx
 */
async function buildClassicFlashReferenceLabeledList(plan, flashCtx) {
  if (!flashCtx?.liquidatorMarginfiAccount || !flashCtx?.client) {
    throw new Error("classic_flash requires flashCtx with liquidatorMarginfiAccount and client");
  }
  const m = flashCtx.liquidatorMarginfiAccount;
  const v = plan.candidate.venue;
  const preLabeled = (plan.preRefreshIxs || []).map((ix, i) => ({
    label: `${v}_pre_refresh_${i}`,
    ix,
  }));
  const venueWithdrawRows = [
    ...(plan.venueWithdrawPrepIxs || []).map((ix, i) => ({ label: `${v}_withdraw_setup_${i}`, ix })),
    { label: `${v}_withdraw`, ix: plan.venueWithdrawIx },
  ].filter((row) => row.ix);

  /** @type {LabeledIx[]} */
  const coreMiddle = [
    { label: "classic_lending_liquidate", ix: plan.classicLendingLiquidateIx },
    ...preLabeled,
    ...venueWithdrawRows,
    ...(plan.jupiterSetupIxs || []).map((ix, i) => ({ label: `jupiter_setup_${i}`, ix })),
    { label: "jupiter_swap", ix: plan.jupiterSwapIx },
    ...(plan.jupiterCleanupIx ? [{ label: "jupiter_cleanup", ix: plan.jupiterCleanupIx }] : []),
    ...(plan.jupiterOtherIxs || []).map((ix, i) => ({ label: `jupiter_other_${i}`, ix })),
    ...(plan.jupiterTipIx ? [{ label: "jupiter_tip", ix: plan.jupiterTipIx }] : []),
    { label: "repay_liability", ix: plan.repayLiabilityIx },
  ].filter((row) => row.ix);

  const coreIxsOnly = coreMiddle.map((r) => r.ix);
  // P0's computeProjectedActiveBanksNoCpi does not model lending_account_liquidate; including inner
  // marginfi ixs would throw after liquidate+withdraw. Use liquidator's current active banks for end_flashloan.
  const flashProjectionIxs = [];
  const endIndex = 1 + coreIxsOnly.length;
  const beginWrap = await makeBeginFlashLoanIx(flashCtx.client.program, m.address, endIndex, m.authority);
  const beginFlash = beginWrap.instructions[0];
  const projectedKeys = computeProjectedActiveBanksForFlashEnd(
    m.balances,
    flashProjectionIxs,
    flashCtx.client.program,
    {
      flashLoanProvider: "marginfi",
      liquidatorMarginfi: m.address,
      liquidatee: plan.candidate.liquidatee,
      assetBank: plan.candidate.assetBank?.toBase58?.() ?? String(plan.candidate.assetBank),
      liabBank: plan.candidate.liabBank?.toBase58?.() ?? String(plan.candidate.liabBank),
      instructionLabels: coreMiddle.map((r) => r.label),
    },
  );
  const projectedBanks = projectedKeys
    .map((pk) => flashCtx.client.bankMap.get(pk.toBase58()))
    .filter(Boolean);
  const endWrap = await makeEndFlashLoanIx(flashCtx.client.program, m.address, projectedBanks, m.authority);
  const endFlash = endWrap.instructions[0];

  const cuPrice = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: BigInt(plan.computeUnitPriceMicroLamports ?? 0),
  });
  const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({
    units: plan.estimatedCuLimit || 1_400_000,
  });

  return [
    { label: "flash_borrow", ix: beginFlash },
    ...coreMiddle,
    { label: "flash_repay", ix: endFlash },
    { label: "compute_budget_price", ix: cuPrice },
    { label: "compute_budget_limit", ix: cuLimit },
  ];
}

/**
 * @param {object} ctx
 * @param {import("@0dotxyz/p0-ts-sdk").Project0Client} ctx.client
 * @param {import("@solana/web3.js").Connection} ctx.connection
 * @param {import("@solana/web3.js").PublicKey} ctx.liquidatorSigner
 * @param {import("@0dotxyz/p0-ts-sdk").MarginfiAccount} [ctx.liquidatorMarginfiAccount] decoded account for marginfi flash wrap
 * @param {import("@0dotxyz/p0-ts-sdk").MarginfiAccountWrapper | null} [ctx.liquidateeWrapper]
 * @param {object} ctx.candidate
 * @param {object} cfg
 * @returns {Promise<AgnesLiquidationPlan>}
 */
export async function buildAgnesLiquidationPlan(ctx, cfg) {
  const c = ctx.candidate;
  const base = emptyPlan(c, cfg);

  try {
    const { feeState, globalFeeWallet } = await fetchFeeStateAccounts(ctx.client.program);

    const assetWithdrawAta = getAssociatedTokenAddressSync(
      c.assetMint,
      ctx.liquidatorSigner,
      false,
      TOKEN_PROGRAM_ID,
    );
    const liabRepayAta = getAssociatedTokenAddressSync(
      c.liabMint,
      ctx.liquidatorSigner,
      false,
      TOKEN_PROGRAM_ID,
    );

    const handler = pickVenueHandler(c.venue);
    if (!handler.canHandle(c)) {
      base.skipReason = SkipReason.SKIP_UNKNOWN_VENUE;
      return base;
    }

    if (!ctx.liquidateeWrapper) {
      base.skipReason = SkipReason.SKIP_STALE_CACHE;
      return base;
    }

    const { startRemainingAccounts, endRemainingAccounts } = buildReceivershipRemainingForLiquidatee(
      ctx.liquidateeWrapper,
      ctx.client.bankMap,
    );

    const assetBankPk = normalizeBankPubkey(c.assetBank);
    const liabBankPk = normalizeBankPubkey(c.liabBank);
    const assetBankResolved = ctx.client.getBank(assetBankPk);
    const liabBankResolved = ctx.client.getBank(liabBankPk);

    const planCtx = {
      client: ctx.client,
      connection: ctx.connection,
      liquidateeWrapper: ctx.liquidateeWrapper,
      liquidatorPk: ctx.liquidatorSigner,
      marginfiAccountLiquidatee: c.liquidatee,
      liquidationReceiver: ctx.liquidatorSigner,
      assetWithdrawAta,
      liabRepayAta,
      assetBank: assetBankResolved,
      liabBank: liabBankResolved,
      withdrawAmountNative: c.maxAssetAmount,
      repayAmountNative: c.maxLiabAmount,
    };

    if (!isBankHydratedForSdk(planCtx.assetBank) || !isBankHydratedForSdk(planCtx.liabBank)) {
      base.skipReason = SkipReason.SKIP_BANK_HYDRATION;
      base._bankHydrationDebug = {
        assetBankPk: assetBankPk.toBase58(),
        liabBankPk: liabBankPk.toBase58(),
        hasAssetBank: !!planCtx.assetBank,
        hasLiabBank: !!planCtx.liabBank,
        assetHasMint: !!planCtx.assetBank?.mint,
        liabHasMint: !!planCtx.liabBank?.mint,
        assetHasAddress: !!planCtx.assetBank?.address,
        liabHasAddress: !!planCtx.liabBank?.address,
        assetMintDecimalsOk: planCtx.assetBank?.mintDecimals != null,
        liabMintDecimalsOk: planCtx.liabBank?.mintDecimals != null,
      };
      console.warn("[agnes:plan] bank hydration failed", base._bankHydrationDebug);
      return base;
    }

    if (cfg.agnesLiqDebugVerbose) {
      const ab = planCtx.assetBank;
      console.warn("[agnes:plan] withdraw bank", {
        address: ab?.address?.toBase58?.(),
        mint: ab?.mint?.toBase58?.(),
        assetTag: ab?.config?.assetTag,
      });
    }

    base.preRefreshIxs = await handler.buildPreRefreshIxs(planCtx);

    const [liqRecordPda] = deriveLiquidationRecord(c.liquidatee, ctx.client.program.programId);
    const liqRecordInfo = await ctx.connection.getAccountInfo(liqRecordPda, "processed");
    const hasLiqRecord = Boolean(liqRecordInfo);
    /** marginfi native: flash when no record; resume receivership if record exists. Cross-venue: always receivership. */
    if (c.venue === "marginfi") {
      base.liquidationBundleKind = hasLiqRecord ? "receivership" : "classic_flash";
      base.needsInitLiqRecord = false;
    } else {
      base.liquidationBundleKind = "receivership";
      base.needsInitLiqRecord = !hasLiqRecord;
    }
    base.computeUnitPriceMicroLamports = cfg.agnesComputeUnitPriceMicroLamports ?? 0;
    base.usesMarginfiFlashWrap = base.liquidationBundleKind === "classic_flash";

    if (base.liquidationBundleKind === "classic_flash") {
      if (!ctx.liquidatorMarginfiAccount) {
        base.skipReason = SkipReason.SKIP_CLASSIC_REQUIRES_LIQUIDATOR_MARGINFI;
        return base;
      }
      const clRem = buildClassicLiquidateRemainingAccounts(
        ctx.liquidateeWrapper,
        ctx.liquidatorMarginfiAccount,
        ctx.client.bankMap,
        {
          assetBankPk: planCtx.assetBank.address,
          liabBankPk: planCtx.liabBank.address,
        },
      );
      if (clRem.liquidateeAccounts > 255 || clRem.liquidatorAccounts > 255) {
        base.skipReason = "CLASSIC_LIQUIDATE_REMAINING_ACCOUNTS_TOO_LARGE";
        return base;
      }
      base.classicLendingLiquidateIx = await makeClassicLendingLiquidateIx(
        ctx.client.program,
        {
          group: ctx.client.group.address,
          assetBank: planCtx.assetBank.address,
          liabBank: planCtx.liabBank.address,
          liquidatorMarginfiAccount: ctx.liquidatorMarginfiAccount.address,
          authority: ctx.liquidatorSigner,
          liquidateeMarginfiAccount: c.liquidatee,
          tokenProgram: TOKEN_PROGRAM_ID,
          remainingAccounts: clRem.remainingAccounts,
        },
        {
          assetAmount: new BN(c.maxAssetAmount.toString()),
          liquidateeAccounts: clRem.liquidateeAccounts,
          liquidatorAccounts: clRem.liquidatorAccounts,
        },
      );
      base.classicLendingLiquidateMetas = base.classicLendingLiquidateIx.keys.map((k) => ({
        pubkey: k.pubkey,
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      }));
      const liqWrapper = new MarginfiAccountWrapper(ctx.liquidatorMarginfiAccount, ctx.client);
      const amountUi = withdrawNativeToUiAmount(c.maxAssetAmount, planCtx.assetBank);
      const tokenProgramW = await getMintOwnerOrTokenProgram(ctx.connection, planCtx.assetBank.mint);
      const wrap = await makeWithdrawIx({
        program: ctx.client.program,
        bank: planCtx.assetBank,
        bankMap: ctx.client.bankMap,
        bankMetadataMap: ctx.client.bankIntegrationMap,
        tokenProgram: tokenProgramW,
        amount: amountUi,
        marginfiAccount: liqWrapper.account,
        authority: ctx.liquidatorSigner,
        withdrawAll: false,
        opts: { createAtas: true, wrapAndUnwrapSol: true },
      });
      const withdrawIxs = wrap.instructions;
      if (!Array.isArray(withdrawIxs) || withdrawIxs.length === 0) {
        base.skipReason = "WITHDRAW_IX_EMPTY";
        return base;
      }
      base.venueWithdrawPrepIxs = withdrawIxs.slice(0, -1);
      base.venueWithdrawIx = withdrawIxs[withdrawIxs.length - 1];
      base.startLiquidateIx = null;
      base.endLiquidateIx = null;
      base.initLiqRecordIx = null;
    } else {
      base.initLiqRecordIx = base.needsInitLiqRecord
        ? await makeInitLiquidationRecordIx(ctx.client.program, {
            marginfiAccountLiquidatee: c.liquidatee,
            feePayer: ctx.liquidatorSigner,
          })
        : null;
      base.startLiquidateIx = await makeStartLiquidationIx(ctx.client.program, {
        marginfiAccountLiquidatee: c.liquidatee,
        liquidationReceiver: ctx.liquidatorSigner,
        startRemainingAccounts,
      });
      const withdrawIxs = await handler.buildWithdrawIx(planCtx);
      if (!Array.isArray(withdrawIxs) || withdrawIxs.length === 0) {
        base.skipReason = "WITHDRAW_IX_EMPTY";
        return base;
      }
      base.venueWithdrawPrepIxs = withdrawIxs.slice(0, -1);
      base.venueWithdrawIx = withdrawIxs[withdrawIxs.length - 1];
      base.classicLendingLiquidateIx = null;
      base.classicLendingLiquidateMetas = null;
    }

    const widenMax = Math.min(64, Math.max(cfg.jupiterMaxAccounts, JUPITER_WIDEN_MAX_ACCOUNTS));
    /** Prefer direct routes first (smaller v0 wire size); then widen caps; multi-hop last. */
    const jupParamSeen = new Set();
    /** @type {Record<string, unknown>[]} */
    const jupiterAttempts = [];
    /** @param {Record<string, unknown>} partial */
    function pushJupiterTry(partial) {
      const merged = { ...cfg, ...partial };
      const key = `${merged.jupiterOnlyDirectRoutes}:${merged.jupiterMaxAccounts}`;
      if (jupParamSeen.has(key)) return;
      jupParamSeen.add(key);
      jupiterAttempts.push(merged);
    }
    pushJupiterTry({ jupiterOnlyDirectRoutes: true, jupiterMaxAccounts: cfg.jupiterMaxAccounts });
    pushJupiterTry({ jupiterOnlyDirectRoutes: true, jupiterMaxAccounts: widenMax });
    pushJupiterTry({ jupiterOnlyDirectRoutes: false, jupiterMaxAccounts: cfg.jupiterMaxAccounts });
    pushJupiterTry({ jupiterOnlyDirectRoutes: false, jupiterMaxAccounts: widenMax });
    let jup = null;
    for (const tryCfg of jupiterAttempts) {
      const next = await buildJupiterLeg(tryCfg, c, ctx.liquidatorSigner, c.maxAssetAmount);
      if (!next.error && next.swap) {
        jup = next;
        break;
      }
      jup = next;
    }
    if (jup.error) {
      base.skipReason =
        jup.error instanceof JupiterBuildHttpError
          ? SkipReason.SKIP_NO_JUPITER_ROUTE
          : String(jup.error?.message || jup.error);
      return base;
    }
    if (!jup.swap) {
      base.skipReason = SkipReason.SKIP_NO_JUPITER_ROUTE;
      return base;
    }
    await mergeJupiterPayloadIntoPlan(base, jup, ctx, cfg);

    const repayMarginfiPk =
      base.liquidationBundleKind === "classic_flash"
        ? ctx.liquidatorMarginfiAccount.address
        : c.liquidatee;

    base.repayLiabilityIx = await makeRepayIx(
      ctx.client.program,
      {
        group: ctx.client.group.address,
        marginfiAccount: repayMarginfiPk,
        authority: ctx.liquidatorSigner,
        bank: planCtx.liabBank.address,
        signerTokenAccount: liabRepayAta,
        liquidityVault: planCtx.liabBank.liquidityVault,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      { amount: c.maxLiabAmount, repayAll: false },
    );

    if (base.liquidationBundleKind === "receivership") {
      base.endLiquidateIx = await makeEndLiquidationIx(ctx.client.program, {
        marginfiAccountLiquidatee: c.liquidatee,
        liquidationReceiver: ctx.liquidatorSigner,
        globalFeeWallet,
        feeState,
        endRemainingAccounts,
      });
    } else {
      base.endLiquidateIx = null;
    }

    base._feeState = feeState;
    base._globalFeeWallet = globalFeeWallet;

    base.estimatedCuLimit = cfg.agnesComputeUnitLimit;
    base.expectedProfitUsd = c.expectedProfitUsdBeforeSwap;

    const bhFit = await ctx.connection.getLatestBlockhash("processed");
    const flashCtxFit = resolveAgnesFlashCtx(base, ctx.client, ctx.liquidatorMarginfiAccount);
    let compiledFit = await compileAgnesPlanToV0Tx(base, ctx.liquidatorSigner, bhFit.blockhash, flashCtxFit);
    if (!compiledFit.ok) {
      const errStr = String(compiledFit.err?.message || compiledFit.err || "");
      const packetFail =
        compiledFit.err?.name === "RangeError" ||
        errStr.includes("overruns") ||
        errStr.includes("encoding overruns");
      if (packetFail) {
        const slimDirectCfgs = [
          { ...cfg, jupiterOnlyDirectRoutes: true },
          { ...cfg, jupiterOnlyDirectRoutes: true, jupiterMaxAccounts: widenMax },
        ];
        for (const tryCfg of slimDirectCfgs) {
          const jupSlim = await buildJupiterLeg(tryCfg, c, ctx.liquidatorSigner, c.maxAssetAmount);
          if (jupSlim.error || !jupSlim.swap) continue;
          await mergeJupiterPayloadIntoPlan(base, jupSlim, ctx, cfg);
          compiledFit = await compileAgnesPlanToV0Tx(base, ctx.liquidatorSigner, bhFit.blockhash, flashCtxFit);
          if (compiledFit.ok) break;
        }
      }
    }
    if (!compiledFit.ok) {
      const errStr = String(compiledFit.err?.message || compiledFit.err || "");
      const packetFail =
        compiledFit.err?.name === "RangeError" ||
        errStr.includes("overruns") ||
        errStr.includes("encoding overruns");
      base.skipReason = packetFail ? SkipReason.SKIP_TX_TOO_LARGE : errStr || "TX_COMPILE_FAILED";
      base._packetFitError = errStr;
      return base;
    }

    return base;
  } catch (err) {
    base.skipReason = err?.message?.includes("Jupiter") ? SkipReason.SKIP_NO_JUPITER_ROUTE : String(err?.message || err);
    base._planBuildError = err;
    return base;
  }
}

/**
 * @param {AgnesLiquidationPlan} base
 * @param {object} jup return of buildJupiterLeg (no error)
 * @param {object} ctx
 * @param {object} cfg
 */
function dedupeAddressLookupTables(luts) {
  const seen = new Set();
  return luts.filter((acc) => {
    const k = acc.key.toBase58();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function mergeJupiterPayloadIntoPlan(base, jup, ctx, cfg) {
  base._jupiterDebug = jup.jupiterDebug;
  base.jupiterSetupIxs = jup.setup;
  base.jupiterSwapIx = jup.swap;
  base.jupiterCleanupIx = jup.cleanup;
  base.jupiterOtherIxs = jup.other;
  base.jupiterTipIx = jup.tip;
  base.expectedInAmount = jup.inAmount;
  base.expectedOutAmount = jup.outAmount;
  base.minOutAmount = jup.minOut;
  /**
   * Order: Jupiter `/build` LUTs first (every key in `addressesByLookupTableAddress`), then Eva01 trio,
   * then optional supplemental mainnet tables, then env (`AGNES_LOOKUP_TABLES` / `ADDRESS_LOOKUP_TABLES`).
   * Solana drains non-signer metas into the first LUT that contains each key.
   */
  const jupiterLuts = await fetchLookupTableAccounts(ctx.connection, jup.lutAddresses);
  const marginfiLuts = cfg.agnesUseMarginfiDefaultLuts
    ? await fetchLookupTableAccounts(ctx.connection, MARGINFI_MAINNET_EVA01_ADDRESS_LOOKUP_TABLES)
    : [];
  const supplementalLuts = cfg.agnesUseSupplementalLiquidationLuts
    ? await fetchLookupTableAccounts(ctx.connection, MAINNET_LIQUIDATION_SUPPLEMENTAL_LOOKUP_TABLES)
    : [];
  const persistent = await fetchLookupTableAccounts(ctx.connection, cfg.agnesLookupTables ?? []);
  base.lookupTables = dedupeAddressLookupTables([
    ...jupiterLuts,
    ...marginfiLuts,
    ...supplementalLuts,
    ...persistent,
  ]);
}

function emptyPlan(candidate, cfg) {
  return {
    candidate,
    flashLoanProvider: cfg.flashLoanProvider,
    liquidationBundleKind: undefined,
    needsInitLiqRecord: false,
    initLiqRecordIx: null,
    usesMarginfiFlashWrap: false,
    computeUnitPriceMicroLamports: cfg.agnesComputeUnitPriceMicroLamports ?? 0,
    classicLendingLiquidateIx: null,
    classicLendingLiquidateMetas: null,
    flashBorrowIx: null,
    flashRepayIx: null,
    preRefreshIxs: [],
    startLiquidateIx: null,
    venueWithdrawPrepIxs: [],
    venueWithdrawIx: null,
    repayLiabilityIx: null,
    endLiquidateIx: null,
    jupiterSetupIxs: [],
    jupiterSwapIx: null,
    jupiterCleanupIx: null,
    jupiterOtherIxs: [],
    jupiterTipIx: null,
    lookupTables: [],
    expectedInAmount: 0n,
    expectedOutAmount: 0n,
    minOutAmount: 0n,
    estimatedCuLimit: cfg.agnesComputeUnitLimit,
    expectedProfitUsd: 0,
    skipReason: undefined,
  };
}

/**
 * @param {object} cfg
 * @param {object} candidate
 * @param {import("@solana/web3.js").PublicKey} takerPk
 * @param {bigint} amountIn
 */
async function buildJupiterLeg(cfg, candidate, takerPk, amountIn) {
  const requestParams = {
    inputMint: candidate.assetMint.toBase58(),
    outputMint: candidate.liabMint.toBase58(),
    amount: amountIn.toString(),
    taker: takerPk.toBase58(),
    slippageBps: "100",
    maxAccounts: String(cfg.jupiterMaxAccounts),
    wrapAndUnwrapSol: "false",
  };
  if (cfg.jupiterOnlyDirectRoutes) {
    requestParams.onlyDirectRoutes = "true";
  }
  if (cfg.jupiterExcludeDexes) {
    requestParams.excludeDexes = cfg.jupiterExcludeDexes;
  }

  /** @type {object} */
  const jupiterDebug = {
    requestParams: { ...requestParams },
    ixCounts: { setup: 0, swap: 0, cleanup: 0, other: 0, computeBudget: 0, tip: 0 },
    routeSummary: null,
    raw: null,
    httpError: null,
  };

  let raw;
  try {
    raw = await jupiterSwapBuildGet(cfg.jupiterSwapApiBase, requestParams, {
      apiKey: cfg.jupiterApiKey,
    });
  } catch (e) {
    if (e instanceof JupiterBuildHttpError) {
      jupiterDebug.httpError = { status: e.status, body: e.body, url: e.url };
    } else {
      jupiterDebug.httpError = { message: String(e?.message || e) };
    }
    return {
      setup: [],
      swap: null,
      cleanup: null,
      other: [],
      tip: null,
      lutAddresses: [],
      inAmount: amountIn,
      outAmount: 0n,
      minOut: 0n,
      error: e,
      jupiterDebug,
    };
  }

  jupiterDebug.raw = raw;
  jupiterDebug.ixCounts = {
    setup: (raw.setupInstructions ?? []).length,
    swap: raw.swapInstruction ? 1 : 0,
    cleanup: raw.cleanupInstruction ? 1 : 0,
    other: (raw.otherInstructions ?? []).length,
    computeBudget: (raw.computeBudgetInstructions ?? []).length,
    tip: raw.tipInstruction ? 1 : 0,
  };
  jupiterDebug.routeSummary = buildJupiterRouteSummary(raw, requestParams);

  const parsed = parseJupiterBuildResponse(raw);
  const setup = parsed.setupInstructions;
  const swap = parsed.swapInstruction;
  const cleanup = parsed.cleanupInstruction;
  const other = parsed.otherInstructions;
  const tip = parsed.tipInstruction;
  const outAmt = raw.outAmount ? BigInt(raw.outAmount) : 0n;
  const otherAmt = raw.otherAmountThreshold ? BigInt(raw.otherAmountThreshold) : 0n;
  if (!swap) {
    return {
      setup,
      swap: null,
      cleanup,
      other,
      tip,
      lutAddresses: parsed.lutAddresses,
      inAmount: amountIn,
      outAmount: outAmt,
      minOut: otherAmt,
      error: new Error("Jupiter /build returned no swapInstruction"),
      jupiterDebug,
    };
  }
  return {
    setup,
    swap,
    cleanup,
    other,
    tip,
    lutAddresses: parsed.lutAddresses,
    inAmount: amountIn,
    outAmount: outAmt,
    minOut: otherAmt,
    error: null,
    jupiterDebug,
  };
}

/**
 * Default Agnes ordering: CU limit, optional marginfi flash (liquidator account), core liquidation + Jupiter, flash end.
 * Omits Jupiter compute-budget ixs from `/build` (we own CU sizing).
 * @param {AgnesLiquidationPlan} plan
 * @param {import("@solana/web3.js").PublicKey} payer
 * @param {string} recentBlockhash
 * @param {object} [flashCtx] optional — when `cfg.flashLoanProvider === "marginfi"`
 * @param {import("@0dotxyz/p0-ts-sdk").Project0Client} [flashCtx.client]
 * @param {import("@0dotxyz/p0-ts-sdk").MarginfiAccount} [flashCtx.liquidatorMarginfiAccount]
 * @returns {Promise<{ ok: true, tx: import("@solana/web3.js").VersionedTransaction, message: import("@solana/web3.js").MessageV0, labeledIxs: LabeledIx[] } | { ok: false, err: unknown, labeledIxs: LabeledIx[] }>}
 */
export async function compileAgnesPlanToV0Tx(plan, payer, recentBlockhash, flashCtx = null) {
  const labeledIxs = await buildLabeledAgnesInstructionList(plan, flashCtx);
  const instructions = labeledIxs.map((r) => r.ix);
  try {
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash,
      instructions,
    }).compileToV0Message(plan.lookupTables || []);
    const tx = new VersionedTransaction(message);
    tx.serialize();
    return { ok: true, tx, message, labeledIxs };
  } catch (err) {
    return { ok: false, err, labeledIxs };
  }
}
