/**
 * Liquidation smoke harness: dry-run by default; validates account ordering, Pyth crank tx,
 * liquidation tx, Jito bundle shape, simulations, optional live submit (double-gated).
 *
 *   npm run liq:smoke
 *   npm run liq:smoke -- --account <marginfi_pubkey>
 *
 * Requires LIQ_SMOKE_ENABLED=true and LIQ_SMOKE_TARGET_ACCOUNT (unless --account).
 */

import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { Project0Client, getConfig, MarginfiAccountWrapper, fetchOracleData } from "@0dotxyz/p0-ts-sdk";
import { loadConfig } from "./config.js";
import { loadSmokeConfig } from "./liquidation/smoke/config.js";
import { SlotTracker } from "./liquidation/slot-tracker.js";
import { buildLiquidationCandidate, buildSmokeLiquidationCandidate } from "./liquidation/candidate.js";
import { buildAgnesLiquidationPlan, resolveAgnesFlashCtx } from "./liquidation/plan.js";
import { loadKeypairFromJsonPath } from "./liquidation/keypair-fs.js";
import { summarizeAccountState, computeStatus } from "./health.js";
import { capCandidateRepayUsd } from "./liquidation/smoke/cap-repay.js";
import {
  assessOracleCrankNeed,
  buildPythPushCrankIxs,
  compileOracleCrankTx,
  decodePostedSlotFromPushAccount,
  collectPushOraclePriceAccountsForCrank,
  HermesBrokenFeedError,
} from "./liquidation/smoke/oracle-crank.js";
import {
  assessSwitchboardCrankNeed,
  buildSwitchboardCrankIxs,
  collectSwitchboardPullFeedAccountsForCrank,
  isSwitchboardPullSetup,
} from "./liquidation/smoke/switchboard-crank.js";
import { validateLiquidationAccountOrdering, validateOracleCrankIxs } from "./liquidation/smoke/account-validator.js";
import { simulateForAgnes } from "./liquidation/simulate.js";
import {
  fetchJitoTipAccounts,
  pickRandomTipAccount,
  compileLiquidationTxForSmoke,
  signSmokeBundle,
  validateBundleShape,
  bundleToBase64Array,
  sendJitoBundle,
} from "./liquidation/smoke/jito-bundle.js";
import { submitRpcBackup } from "./liquidation/smoke/rpc-backup.js";
import { classifySmokeFailure, logSmokeToLiqDebug, SmokeFailureClass } from "./liquidation/smoke/failure-classifier.js";
import {
  buildSmokeReport,
  writeSmokeReport,
  labeledIxsToReportRows,
  rawIxsToReportRows,
} from "./liquidation/smoke/report.js";
import { collectWatchedOraclePubkeys } from "./subscribe.js";

const PUSH_ORACLE_OWNER = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");

function parseArgs(argv) {
  let account = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--account" && argv[i + 1]) {
      account = argv[++i];
      continue;
    }
  }
  return { account };
}

async function refreshOraclePrices(client, connection) {
  const { bankOraclePriceMap } = await fetchOracleData(client.banks, {
    pythOpts: { mode: "on-chain", connection },
    swbOpts: { mode: "on-chain", connection },
    isolatedBanksOpts: { fetchPrices: true },
  });
  for (const [bankPk, price] of bankOraclePriceMap) {
    client.oraclePriceByBank.set(bankPk, price);
  }
}

/**
 * @param {object} candidate
 * @param {import("@0dotxyz/p0-ts-sdk").Project0Client} client
 */
function uniqueBanksForCandidate(candidate, client) {
  const keys = new Set();
  for (const k of candidate.banksInHealth || []) {
    keys.add(k?.toBase58?.() ?? new PublicKey(k).toBase58());
  }
  keys.add(candidate.assetBank.toBase58());
  keys.add(candidate.liabBank.toBase58());
  /** @type {import("@0dotxyz/p0-ts-sdk").Bank[]} */
  const banks = [];
  for (const s of keys) {
    const b = client.getBank(new PublicKey(s));
    if (b) banks.push(b);
  }
  return banks;
}

/**
 * @param {import("@solana/web3.js").Connection} connection
 * @param {import("./liquidation/slot-tracker.js").SlotTracker} slotTracker
 * @param {import("@0dotxyz/p0-ts-sdk").Bank[]} banks
 */
async function warmSlotTrackerFromRpc(connection, slotTracker, banks) {
  const slot = await connection.getSlot("processed");
  slotTracker.recordChainTip(slot);
  const oracleSet = new Set(collectWatchedOraclePubkeys(banks));
  for (const s of oracleSet) {
    let obs = slot;
    try {
      const pk = new PublicKey(s);
      const ai = await connection.getAccountInfo(pk, "processed");
      if (ai?.owner?.equals(PUSH_ORACLE_OWNER) && ai.data) {
        const ps = decodePostedSlotFromPushAccount(Buffer.from(ai.data));
        if (ps != null && Number.isFinite(ps)) obs = ps;
      }
    } catch {
      /* ignore */
    }
    slotTracker.recordOracle(s, obs);
  }
  for (const b of banks) {
    slotTracker.recordBank(b.address.toBase58(), slot);
  }
}

async function main() {
  const smoke = loadSmokeConfig();
  if (!smoke.enabled) {
    console.log("[liq:smoke] disabled (set LIQ_SMOKE_ENABLED=true)");
    process.exit(0);
  }

  if (smoke.protocol !== "marginfi") {
    console.error(`[liq:smoke] unsupported LIQ_SMOKE_PROTOCOL=${smoke.protocol} (only marginfi)`);
    process.exit(2);
  }

  const argv = parseArgs(process.argv.slice(2));
  const targetStr = argv.account || smoke.targetAccount;
  if (!targetStr) {
    console.error("[liq:smoke] missing LIQ_SMOKE_TARGET_ACCOUNT or --account <pubkey>");
    process.exit(2);
  }

  let targetPk;
  try {
    targetPk = new PublicKey(targetStr);
  } catch (e) {
    console.error("[liq:smoke] invalid account", e?.message);
    process.exit(2);
  }

  const cfg = loadConfig();
  if (!cfg.agnesWalletKeypairPath) {
    console.error("[liq:smoke] AGNES_WALLET_KEYPAIR_PATH (or liquidator.json) required");
    process.exit(1);
  }

  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const p0Config = getConfig(cfg.p0Environment, cfg.p0ConfigOverrides);
  const client = await Project0Client.initialize(connection, p0Config);
  await refreshOraclePrices(client, connection);

  const signer = loadKeypairFromJsonPath(cfg.agnesWalletKeypairPath);
  let liquidatorMarginfi = undefined;
  if (cfg.agnesLiquidatorMarginfiAccount) {
    const wrapped = await client.fetchAccount(new PublicKey(cfg.agnesLiquidatorMarginfiAccount), true);
    liquidatorMarginfi = wrapped.account;
  }

  const slot = await connection.getSlot("processed");
  const slotTracker = new SlotTracker();
  slotTracker.recordChainTip(slot);

  const { account: liquidateeAccount } = await client.fetchAccount(targetPk, true);
  const liquidateeWrapper = new MarginfiAccountWrapper(liquidateeAccount, client);
  slotTracker.recordMarginfiAccount(targetPk.toBase58(), slot);

  const summary = summarizeAccountState(liquidateeWrapper, client);
  const liquidatable = summary.totals ? computeStatus(summary.totals) === "LIQUIDATABLE" : false;

  let built = liquidatable
    ? buildLiquidationCandidate(liquidateeWrapper, client, slotTracker, cfg)
    : buildSmokeLiquidationCandidate(liquidateeWrapper, client, slotTracker, cfg);

  if (!built.candidate) {
    const report = buildSmokeReport({
      mode: smoke.dryRun ? "DRY_RUN" : "LIVE",
      status: smoke.dryRun ? "DRY_RUN_FAIL" : "FAIL",
      classification: SmokeFailureClass.LIQUIDATION_BUILD_FAILED,
      targetAccount: targetPk.toBase58(),
      protocol: smoke.protocol,
      slot,
      health: {
        maintHealthUsd: summary.totals?.maintenance?.health ?? null,
        ratioPct: summary.totals ? (() => {
          const a = Number(summary.totals.maintenance?.assets ?? 0);
          const l = Number(summary.totals.maintenance?.liabilities ?? 0);
          return l > 0 ? (a / l) * 100 : null;
        })() : null,
        status: summary.totals ? computeStatus(summary.totals) : "UNKNOWN",
      },
      liquidatable,
      candidate: null,
      cappedRepayUsd: 0,
      oracleCrank: {
        required: false,
        reasons: [],
        stalePythPushFeeds: [],
        staleSwitchboardPullFeeds: [],
        switchboardBuildErrors: [],
        missingFeeds: [],
        brokenFeeds: [],
        hermesEndpointUsed: null,
        venuePreRefreshRequired: false,
        instructions: [],
        buildError: null,
      },
      liquidationInstructions: [],
      accountOrderingValidation: { ok: false, mismatches: [], missingAccounts: [], unexpectedAccounts: [], writableMismatches: [], signerMismatches: [] },
      transactions: { cranks: [], crank: null, liquidation: null },
      simulation: { crank: null, liquidation: null },
      jitoBundle: { enabled: smoke.useJito, txCount: 0, order: [], tipAccount: null, tipLamports: smoke.jitoTipLamports, tipSource: "none" },
      rpcBackup: { enabled: smoke.useRpcBackup, submitted: false, reason: "no_candidate" },
      liveSubmit: { enabled: smoke.liveSubmitAllowed, jitoBundleId: null, rpcSignature: null },
      planSkipReason: built.skipReason ?? null,
      errors: [{ step: "candidate", message: built.skipReason ?? "no_candidate" }],
    });
    const paths = writeSmokeReport(smoke.logDir, report, targetPk.toBase58());
    console.log(`[liq:smoke] ${report.status}  liquidatable=no  report=${paths.named}`);
    process.exit(1);
  }

  let candidate = built.candidate;
  const cap = capCandidateRepayUsd(candidate, client, smoke.maxRepayUsd);
  candidate = cap.candidate;

  if (liquidatable && candidate.expectedProfitUsdBeforeSwap < smoke.minProfitUsd) {
    const report = buildSmokeReport({
      mode: smoke.dryRun ? "DRY_RUN" : "LIVE",
      status: smoke.dryRun ? "DRY_RUN_FAIL" : "FAIL",
      classification: SmokeFailureClass.LIQUIDATION_BUILD_FAILED,
      targetAccount: targetPk.toBase58(),
      protocol: smoke.protocol,
      slot,
      health: {
        maintHealthUsd: summary.totals?.maintenance?.health ?? null,
        ratioPct: null,
        status: computeStatus(summary.totals),
      },
      liquidatable,
      candidate: { ...serializeCandidate(candidate), cappedRepayUsd: cap.cappedRepayUsd },
      cappedRepayUsd: cap.cappedRepayUsd,
      oracleCrank: {
        required: false,
        reasons: [],
        stalePythPushFeeds: [],
        staleSwitchboardPullFeeds: [],
        switchboardBuildErrors: [],
        missingFeeds: [],
        brokenFeeds: [],
        hermesEndpointUsed: null,
        venuePreRefreshRequired: false,
        instructions: [],
        buildError: null,
      },
      liquidationInstructions: [],
      accountOrderingValidation: { ok: false, mismatches: [], missingAccounts: [], unexpectedAccounts: [], writableMismatches: [], signerMismatches: [] },
      transactions: { cranks: [], crank: null, liquidation: null },
      simulation: { crank: null, liquidation: null },
      jitoBundle: { enabled: smoke.useJito, txCount: 0, order: [], tipAccount: null, tipLamports: smoke.jitoTipLamports, tipSource: "none" },
      rpcBackup: { enabled: smoke.useRpcBackup, submitted: false, reason: "min_profit" },
      liveSubmit: { enabled: smoke.liveSubmitAllowed, jitoBundleId: null, rpcSignature: null },
      planSkipReason: "SMOKE_MIN_PROFIT_USD",
      errors: [{ step: "min_profit", minProfitUsd: smoke.minProfitUsd, expectedProfitUsd: candidate.expectedProfitUsdBeforeSwap }],
    });
    const paths = writeSmokeReport(smoke.logDir, report, targetPk.toBase58());
    console.log(
      `[liq:smoke] ${report.status}  liquidatable=yes  crank=n/a  accountOrdering=n/a  sim=n/a  report=${paths.named}`,
    );
    process.exit(1);
  }

  const uniqueBanks = uniqueBanksForCandidate(candidate, client);
  await warmSlotTrackerFromRpc(connection, slotTracker, uniqueBanks);

  const oracleAssess = assessOracleCrankNeed({
    banks: uniqueBanks,
    slotTracker,
    currentSlot: slotTracker.getCurrentSlot(),
    cfg,
    force: smoke.forceOracleCrank,
    venue: candidate.venue,
  });

  const swbAssess = uniqueBanks.some(isSwitchboardPullSetup)
    ? await assessSwitchboardCrankNeed({
        banks: uniqueBanks,
        slotTracker,
        currentSlot: slotTracker.getCurrentSlot(),
        cfg,
        force: smoke.forceOracleCrank,
        connection,
        payer: signer,
      })
    : {
        required: false,
        reasons: [],
        staleSwitchboardPullFeeds: [],
        missingFeeds: [],
      };

  const oracleCrankCombinedRequired = oracleAssess.required || swbAssess.required;

  /** @type {import("@solana/web3.js").VersionedTransaction[]} */
  let crankTxs = [];
  /** @type {import("@solana/web3.js").VersionedTransaction | null} */
  let crankTx = null;
  /** @type {import("@solana/web3.js").Keypair[]} */
  let crankEphemeral = [];
  /** @type {import("@solana/web3.js").TransactionInstruction[]} */
  let crankIxs = [];
  /** @type {import("@solana/web3.js").AddressLookupTableAccount[]} */
  let crankLookupTables = [];
  let crankBuildError = null;
  /** @type {object[]} */
  let crankBrokenFeeds = [];
  /** @type {string | null} */
  let crankHermesEndpointUsed = null;
  /** @type {object[]} */
  let switchboardBuildErrors = [];

  if (oracleCrankCombinedRequired) {
    let pricePks = oracleAssess.stalePythPushFeeds.map((r) => new PublicKey(r.priceAccount));
    if (pricePks.length === 0 && oracleAssess.required) {
      pricePks = collectPushOraclePriceAccountsForCrank(uniqueBanks);
    }

    let pullPks = swbAssess.staleSwitchboardPullFeeds.map((r) => new PublicKey(r.pullFeed));
    if (pullPks.length === 0 && swbAssess.required) {
      pullPks = collectSwitchboardPullFeedAccountsForCrank(uniqueBanks);
    }

    try {
      const [builtPyth, builtSwbo] = await Promise.all([
        buildPythPushCrankIxs(connection, signer, pricePks, {
          primaryUrl: smoke.hermesBaseUrl,
          fallbackUrl: smoke.hermesFallbackUrl,
        }),
        buildSwitchboardCrankIxs(connection, signer, pullPks, {
          numSignatures: smoke.switchboardNumSignatures,
          gatewayUrl: smoke.switchboardGatewayUrl,
        }),
      ]);

      crankBrokenFeeds = builtPyth.brokenFeeds ?? [];
      crankHermesEndpointUsed = builtPyth.hermesEndpointUsed ?? null;
      switchboardBuildErrors = builtSwbo.errors ?? [];
      crankEphemeral = builtPyth.ephemeralSigners ?? [];
      crankLookupTables = builtSwbo.lookupTables ?? [];

      const builtPythIxs = builtPyth.ixs ?? [];
      const builtSwboIxs = builtSwbo.ixs ?? [];
      crankIxs = [...builtPythIxs, ...builtSwboIxs];

      if (
        swbAssess.required &&
        pullPks.length > 0 &&
        (builtSwbo.ixs?.length ?? 0) === 0 &&
        (builtSwbo.errors?.length ?? 0) > 0
      ) {
        crankBuildError = new Error(
          `switchboard_crank_build_failed:${builtSwbo.errors.map((e) => e.message).join(";")}`,
        );
      } else if (!crankIxs.length) {
        crankBuildError = new Error("oracle_crank_no_instructions_built");
      }

      if (!crankBuildError) {
        const bh0 = await connection.getLatestBlockhash("processed");
        /**
         * @param {import("@solana/web3.js").TransactionInstruction[]} ixs
         * @param {import("@solana/web3.js").AddressLookupTableAccount[]} luts
         */
        const compileSubset = (ixs, luts) => {
          if (!ixs?.length) return null;
          return compileOracleCrankTx({
            ixs,
            payer: signer.publicKey,
            recentBlockhash: bh0.blockhash,
            lookupTables: luts ?? [],
          });
        };

        const combined = compileSubset(crankIxs, crankLookupTables);
        if (combined) {
          const sz = combined.serialize().length;
          if (sz <= 1232) crankTxs = [combined];
        }

        if (crankTxs.length === 0 && crankIxs.length) {
          const txP = compileSubset(builtPythIxs, []);
          const txS = compileSubset(builtSwboIxs, crankLookupTables);
          if (builtPythIxs.length) {
            if (!txP) throw new Error("pyth_crank_compile_failed");
            if (txP.serialize().length > 1232) throw new Error(`pyth_crank_oversize_${txP.serialize().length}`);
            crankTxs.push(txP);
          }
          if (builtSwboIxs.length) {
            if (!txS) throw new Error("switchboard_crank_compile_failed");
            if (txS.serialize().length > 1232) throw new Error(`switchboard_crank_oversize_${txS.serialize().length}`);
            crankTxs.push(txS);
          }
        }

        crankTx = crankTxs[0] ?? null;
      }
    } catch (e) {
      crankBuildError = e;
    }
  }

  const planCtx = {
    client,
    connection,
    liquidatorSigner: signer.publicKey,
    liquidatorMarginfiAccount: liquidatorMarginfi,
    liquidateeWrapper,
    candidate,
  };

  let plan;
  try {
    plan = await buildAgnesLiquidationPlan(planCtx, cfg);
  } catch (e) {
    plan = { skipReason: String(e?.message || e), candidate };
  }

  const flashCtx = resolveAgnesFlashCtx(plan, client, liquidatorMarginfi);
  const bh = await connection.getLatestBlockhash("processed");

  /** @type {{ ok: boolean, tx?: import("@solana/web3.js").VersionedTransaction, labeledIxs?: object[], err?: unknown }} */
  let liqCompiled = { ok: false, labeledIxs: [], err: null };
  if (!plan.skipReason) {
    let tipPk = smoke.jitoTipAccount;
    if (smoke.useJito && !plan.jupiterTipIx && smoke.jitoTipLamports > 0 && !tipPk) {
      try {
        await fetchJitoTipAccounts(smoke.jitoBlockEngineUrl);
        const tipPkStr = pickRandomTipAccount();
        if (tipPkStr) tipPk = new PublicKey(tipPkStr);
      } catch {
        /* optional */
      }
    }
    liqCompiled = await compileLiquidationTxForSmoke(plan, signer.publicKey, bh.blockhash, flashCtx, {
      addJitoTip: Boolean(smoke.useJito && !plan.jupiterTipIx && smoke.jitoTipLamports > 0 && tipPk),
      tipAccount: tipPk ?? null,
      tipLamports: smoke.jitoTipLamports,
    });
  } else {
    liqCompiled = { ok: false, err: new Error(plan.skipReason), labeledIxs: [] };
  }

  /** @type {import("@solana/web3.js").VersionedTransaction | null} */
  let liquidationTx = liqCompiled.ok ? liqCompiled.tx : null;
  /** @type {{ label: string, ix: import("@solana/web3.js").TransactionInstruction }[]} */
  let labeledIxs = liqCompiled.labeledIxs || [];

  const jitoTipAccountStr =
    smoke.jitoTipAccount?.toBase58?.() ?? (smoke.useJito && !plan.jupiterTipIx ? pickRandomTipAccount() : null);
  const tipSource = plan.jupiterTipIx ? "jupiter_build_tip_instruction" : smoke.useJito && smoke.jitoTipLamports > 0 ? "smoke_jito_tip_transfer" : "none";

  let liqValidation = { ok: true, mismatches: [], missingAccounts: [], unexpectedAccounts: [], writableMismatches: [], signerMismatches: [] };
  if (labeledIxs.length) {
    liqValidation = validateLiquidationAccountOrdering(labeledIxs, {
      liquidateeWrapper,
      liquidatorAccount: liquidatorMarginfi ?? null,
      bankMap: client.bankMap,
      marginfiProgramId: client.program.programId,
      liquidatorSigner: signer.publicKey,
      marginfiGroup: client.group.address,
      liquidationAssetBank: candidate.assetBank,
      liquidationLiabBank: candidate.liabBank,
      liquidatorMarginfiPk: liquidatorMarginfi?.address ?? null,
      liquidateeMarginfiPk: targetPk,
      classicLendingLiquidateMetas: plan.classicLendingLiquidateMetas ?? null,
    });
  }

  let crankValidation = { ok: true, mismatches: [] };
  if (crankIxs.length) {
    crankValidation = validateOracleCrankIxs(crankIxs, signer.publicKey);
  }

  const accountOrderingValidation = {
    ok: liqValidation.ok && crankValidation.ok,
    liquidation: liqValidation,
    crank: crankValidation,
    mismatches: [...(liqValidation.mismatches || []), ...(crankValidation.mismatches || [])],
    missingAccounts: liqValidation.missingAccounts,
    unexpectedAccounts: liqValidation.unexpectedAccounts,
    writableMismatches: liqValidation.writableMismatches,
    signerMismatches: [...(liqValidation.signerMismatches || []), ...(crankValidation.mismatches || [])],
  };

  /** @type {{ ok: boolean, err: unknown, unitsConsumed: number | null, logsTail: string[], sizeBytes: number }[]} */
  const simCranks = [];
  for (const tx of crankTxs) {
    const sim = await connection.simulateTransaction(tx, {
      commitment: "processed",
      replaceRecentBlockhash: true,
      sigVerify: false,
    });
    simCranks.push({
      ok: !sim.value.err,
      err: sim.value.err,
      unitsConsumed: sim.value.unitsConsumed ?? null,
      logsTail: (sim.value.logs ?? []).slice(-80),
      sizeBytes: tx.serialize().length,
    });
  }
  const simCrankAllOk = simCranks.length === 0 || simCranks.every((s) => s.ok);
  const simCrank =
    simCranks.length === 0
      ? null
      : {
          ok: simCrankAllOk,
          err: simCranks.find((s) => !s.ok)?.err ?? null,
          unitsConsumed: simCranks[simCranks.length - 1]?.unitsConsumed ?? null,
          logsTail: simCranks[simCranks.length - 1]?.logsTail ?? [],
          cranks: simCranks,
        };

  let simLiq = null;
  if (liquidationTx) {
    simLiq = await simulateForAgnes(connection, liquidationTx, {});
  } else {
    simLiq = { rpcOk: false, gateOk: false, err: liqCompiled.err ?? "no_tx", logs: [], unitsConsumed: null, failedInstructionIndex: undefined };
  }

  const bundleTxs = [...crankTxs, liquidationTx].filter(Boolean);
  const bundleShape = validateBundleShape(bundleTxs);
  let jitoSend = null;
  let rpcBackup = { submitted: false, reason: smoke.dryRun ? "dry_run" : "not_attempted" };

  if (smoke.liveSubmitAllowed && bundleShape.ok && liquidationTx) {
    signSmokeBundle({ crankTxs, liquidationTx, signer, crankEphemeralSigners: crankEphemeral });
    const base64 = bundleToBase64Array(bundleTxs);
    if (smoke.useJito) {
      jitoSend = await sendJitoBundle(smoke.jitoBlockEngineUrl, base64);
    }
    rpcBackup = await submitRpcBackup({
      connection,
      liquidationTx,
      liveSubmitAllowed: smoke.liveSubmitAllowed,
      useRpcBackup: smoke.useRpcBackup,
    });
  } else if (smoke.dryRun) {
    if (bundleShape.ok && liquidationTx) {
      signSmokeBundle({ crankTxs, liquidationTx, signer, crankEphemeralSigners: crankEphemeral });
    }
    rpcBackup = { submitted: false, reason: "dry_run" };
  } else {
    rpcBackup = { submitted: false, reason: "live_submit_not_enabled" };
  }

  /** @type {object[]} */
  const errors = [];
  if (crankBuildError instanceof HermesBrokenFeedError) {
    errors.push({
      step: "oracle_crank_broken_feeds",
      shardId: crankBuildError.shardId,
      brokenFeeds: crankBuildError.missingIds,
    });
  } else if (crankBuildError) {
    errors.push({ step: "oracle_crank", message: String(crankBuildError.message || crankBuildError) });
  }
  if (plan.skipReason) errors.push({ step: "plan", message: plan.skipReason });
  if (!liqCompiled.ok) errors.push({ step: "compile", message: String(liqCompiled.err?.message || liqCompiled.err) });
  if (!bundleShape.ok) errors.push({ step: "bundle", message: bundleShape.err });

  let classification = SmokeFailureClass.UNKNOWN;
  if (crankBuildError instanceof HermesBrokenFeedError) classification = SmokeFailureClass.ORACLE_CRANK_BROKEN_FEEDS;
  else if (crankBuildError && String(crankBuildError.message || "").startsWith("switchboard_crank_build_failed"))
    classification = SmokeFailureClass.SWITCHBOARD_CRANK_BUILD_FAILED;
  else if (crankBuildError) classification = SmokeFailureClass.ORACLE_CRANK_BUILD_FAILED;
  else if (plan.skipReason || !liqCompiled.ok) classification = SmokeFailureClass.LIQUIDATION_BUILD_FAILED;
  else if (!accountOrderingValidation.ok) {
    classification = classifySmokeFailure(new Error("order"), { accountOrder: accountOrderingValidation });
  } else if (!bundleShape.ok) classification = SmokeFailureClass.JITO_BUNDLE_BUILD_FAILED;
  else if (simCranks.length && !simCrankAllOk) classification = SmokeFailureClass.SIMULATION_FAILED;
  else if (simLiq && (!simLiq.rpcOk || !simLiq.gateOk)) classification = SmokeFailureClass.SIMULATION_FAILED;
  else classification = "OK";

  const mode = smoke.dryRun ? "DRY_RUN" : "LIVE";
  const buildOk = !plan.skipReason && liqCompiled.ok;
  const simOk = simCrankAllOk && simLiq?.rpcOk && simLiq?.gateOk;
  let status = "FAIL";
  if (smoke.dryRun) {
    status = buildOk && accountOrderingValidation.ok && bundleShape.ok && simOk ? "DRY_RUN_PASS" : "DRY_RUN_FAIL";
  } else {
    const liveJitoOk = !smoke.useJito || jitoSend?.ok === true;
    status = buildOk && accountOrderingValidation.ok && bundleShape.ok && simOk && liveJitoOk ? "PASS" : "FAIL";
  }

  const report = buildSmokeReport({
    mode,
    status,
    classification,
    targetAccount: targetPk.toBase58(),
    protocol: smoke.protocol,
    slot,
    health: {
      maintHealthUsd: summary.totals?.maintenance?.health ?? null,
      ratioPct: summary.totals ? (() => {
        const a = Number(summary.totals.maintenance?.assets ?? 0);
        const l = Number(summary.totals.maintenance?.liabilities ?? 0);
        return l > 0 ? (a / l) * 100 : null;
      })() : null,
      status: summary.totals ? computeStatus(summary.totals) : "UNKNOWN",
    },
    liquidatable,
    candidate: serializeCandidate(candidate),
    cappedRepayUsd: cap.cappedRepayUsd,
    oracleCrank: {
      required: oracleCrankCombinedRequired,
      reasons: [...new Set([...(oracleAssess.reasons || []), ...(swbAssess.reasons || [])])],
      stalePythPushFeeds: oracleAssess.stalePythPushFeeds,
      staleSwitchboardPullFeeds: swbAssess.staleSwitchboardPullFeeds,
      switchboardBuildErrors,
      missingFeeds: [...(oracleAssess.missingFeeds || []), ...(swbAssess.missingFeeds || [])],
      brokenFeeds: crankBrokenFeeds,
      hermesEndpointUsed: crankHermesEndpointUsed,
      venuePreRefreshRequired: oracleAssess.venuePreRefreshRequired,
      instructions: rawIxsToReportRows(crankIxs).map((row) => {
        const pid = row?.programId ?? "";
        const idx = row.index;
        if (pid === "SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv") return { ...row, label: `swbo_crank_${idx}` };
        if (pid === "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT" || pid === "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ")
          return { ...row, label: `pyth_crank_${idx}` };
        return { ...row, label: `oracle_crank_${idx}` };
      }),
      buildError: crankBuildError ? String(crankBuildError.message || crankBuildError) : null,
    },
    liquidationInstructions: labeledIxsToReportRows(labeledIxs),
    accountOrderingValidation,
    transactions: {
      cranks: crankTxs.map((tx) => ({
        sizeBytes: tx.serialize().length,
        ixCount: tx.message.compiledInstructions?.length ?? 0,
        accountMetas: tx.message.getAccountKeys().length,
        lookupTables: crankLookupTables.map((t) => t.key.toBase58()),
      })),
      crank:
        crankTxs.length === 1
          ? {
              sizeBytes: crankTxs[0].serialize().length,
              ixCount: crankIxs.length,
              accountMetas: crankIxs.reduce((n, ix) => n + (ix.keys?.length ?? 0), 0),
              lookupTables: crankLookupTables.map((t) => t.key.toBase58()),
            }
          : null,
      liquidation: liquidationTx
        ? {
            sizeBytes: liquidationTx.serialize().length,
            ixCount: labeledIxs.length,
            accountMetas: liquidationTx.message.getAccountKeys({ addressLookupTableAccounts: plan.lookupTables || [] }).length,
            lookupTables: (plan.lookupTables || []).map((t) => t.key.toBase58()),
          }
        : null,
    },
    simulation: {
      crank: simCrank,
      liquidation: simLiq
        ? {
            ok: simLiq.rpcOk && simLiq.gateOk,
            err: simLiq.err,
            unitsConsumed: simLiq.unitsConsumed,
            logsTail: (simLiq.logs ?? []).slice(-80),
            failedInstructionIndex: simLiq.failedInstructionIndex,
          }
        : null,
    },
    jitoBundle: {
      enabled: smoke.useJito,
      txCount: bundleTxs.length,
      order: [...crankTxs.map((_, i) => `oracle_crank_${i}`), "liquidation"],
      tipAccount: jitoTipAccountStr,
      tipLamports: smoke.jitoTipLamports,
      tipSource,
      shapeOk: bundleShape.ok,
      shapeError: bundleShape.ok ? null : bundleShape.err,
      sendResult: jitoSend,
    },
    rpcBackup: { enabled: smoke.useRpcBackup, ...rpcBackup },
    liveSubmit: {
      enabled: smoke.liveSubmitAllowed,
      jitoBundleId: jitoSend?.bundleId ?? null,
      rpcSignature: rpcBackup.signature ?? null,
    },
    planSkipReason: plan.skipReason ?? null,
    errors,
  });

  const paths = writeSmokeReport(smoke.logDir, report, targetPk.toBase58());

  logSmokeToLiqDebug(cfg, {
    tag: "LIQ_SMOKE",
    status,
    classification,
    target: targetPk.toBase58(),
    reportPath: paths.named,
  });

  const simErrStr = simLiq?.err ? JSON.stringify(simLiq.err).slice(0, 120) : "";
  const txSize = liquidationTx ? liquidationTx.serialize().length : 0;
  console.log(
    `[liq:smoke] ${status}  account=${targetPk.toBase58()}  liquidatable=${liquidatable ? "yes" : "no"}  crankNeeded=${oracleCrankCombinedRequired ? "yes" : "no"}  accountOrderingValid=${accountOrderingValidation.ok ? "yes" : "no"}  txSize=${txSize}B  ixCount=${labeledIxs.length}  simErr=${simErrStr || "none"}  report=${paths.named}`,
  );

  const exitOk = status === "DRY_RUN_PASS" || status === "PASS";
  process.exit(exitOk ? 0 : 1);
}

function serializeCandidate(c) {
  return {
    venue: c.venue,
    assetBank: c.assetBank.toBase58(),
    liabBank: c.liabBank.toBase58(),
    assetMint: c.assetMint.toBase58(),
    liabMint: c.liabMint.toBase58(),
    maxAssetNative: c.maxAssetAmount.toString(),
    maxLiabNative: c.maxLiabAmount.toString(),
    expectedProfitUsd: c.expectedProfitUsdBeforeSwap,
    smokeTest: Boolean(c.smokeTest),
  };
}

main().catch((err) => {
  console.error("[liq:smoke] fatal", err);
  process.exit(1);
});
