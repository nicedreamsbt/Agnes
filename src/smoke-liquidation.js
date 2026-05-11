/**
 * One-off liquidation pipeline smoke test: build (and optionally simulate) Agnes liquidation tx
 * for a marginfi user account without requiring it to be liquidatable.
 *
 * Usage:
 *   npm run smoke:liquidation -- --liquidatee <marginfi_account_pubkey>
 *   npm run smoke:liquidation -- --liquidatee <pk> --stage build
 *   npm run smoke:liquidation -- --liquidatee <pk> --stage simulate
 *
 * Requires: RPC_URL, GRPC_ENDPOINT (same as monitor), MARGINFI_ENV, AGNES_WALLET_KEYPAIR_PATH.
 * Optional flash: FLASH_LOAN_PROVIDER=marginfi + AGNES_LIQUIDATOR_MARGINFI_ACCOUNT.
 *
 * Success = no local TypeError; reaching RPC simulation with a Marginfi/Jupiter/solv error is expected.
 */

import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { Project0Client, getConfig, MarginfiAccountWrapper, fetchOracleData } from "@0dotxyz/p0-ts-sdk";
import { loadConfig } from "./config.js";
import { SlotTracker } from "./liquidation/slot-tracker.js";
import { buildSmokeLiquidationCandidate } from "./liquidation/candidate.js";
import { buildAgnesLiquidationPlan, compileAgnesPlanToV0Tx, resolveAgnesFlashCtx } from "./liquidation/plan.js";
import { loadKeypairFromJsonPath } from "./liquidation/keypair-fs.js";

function printUsage() {
  console.error(`usage: node src/smoke-liquidation.js --liquidatee <pubkey> [--stage build|simulate|both] [--send]

  --stage build     Only build + compile v0 tx (no RPC simulate)
  --stage simulate  Build + compile + simulate (default when omitted: both)
  --stage both      Same as simulate
  --send            After successful simulation, send raw tx (requires AGNES_ALLOW_SEND=true in env)
`);
}

function parseArgs(argv) {
  let liquidatee = null;
  let stage = "both";
  let send = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--liquidatee" && argv[i + 1]) {
      liquidatee = argv[++i];
      continue;
    }
    if (a === "--stage" && argv[i + 1]) {
      stage = String(argv[++i]).toLowerCase();
      continue;
    }
    if (a === "--send") {
      send = true;
      continue;
    }
    if (a === "-h" || a === "--help") {
      return { help: true };
    }
  }
  return { liquidatee, stage, send, help: false };
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
 * @param {import("@0dotxyz/p0-ts-sdk").Project0Client} client
 * @param {object} candidate
 */
function assertBanksHydrated(client, candidate) {
  const assetPk = candidate.assetBank instanceof PublicKey ? candidate.assetBank : new PublicKey(candidate.assetBank);
  const liabPk = candidate.liabBank instanceof PublicKey ? candidate.liabBank : new PublicKey(candidate.liabBank);
  const assetBankObj = client.getBank(assetPk);
  const liabBankObj = client.getBank(liabPk);
  if (!assetBankObj || !liabBankObj) {
    const payload = {
      reason: "MISSING_BANK_OBJECT",
      liquidatee: candidate.liquidatee.toBase58(),
      assetBank: assetPk.toBase58(),
      liabBank: liabPk.toBase58(),
      assetMint: candidate.assetMint.toBase58(),
      liabMint: candidate.liabMint.toBase58(),
      hasAssetBankObj: !!assetBankObj,
      hasLiabBankObj: !!liabBankObj,
      bankCacheKeysSample: [...client.bankMap.keys()].slice(0, 15),
    };
    throw new Error(JSON.stringify(payload, null, 2));
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help || !parsed.liquidatee) {
    printUsage();
    process.exit(parsed.help ? 0 : 2);
  }

  const { stage, send } = parsed;
  if (!["build", "simulate", "both"].includes(stage)) {
    console.error(`invalid --stage ${stage}`);
    printUsage();
    process.exit(2);
  }

  let liquidateePk;
  try {
    liquidateePk = new PublicKey(parsed.liquidatee);
  } catch (e) {
    console.error("invalid --liquidatee", e.message);
    process.exit(2);
  }

  const cfg = loadConfig();
  if (!cfg.agnesWalletKeypairPath) {
    console.error("AGNES_WALLET_KEYPAIR_PATH (or liquidator.json) is required for smoke liquidation");
    process.exit(1);
  }

  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const p0Config = getConfig(cfg.p0Environment, cfg.p0ConfigOverrides);
  console.log(
    `[smoke:liq] bootstrapping P0 client env=${cfg.p0Environment} group=${p0Config.groupPk.toBase58()}`,
  );
  const client = await Project0Client.initialize(connection, p0Config);
  await refreshOraclePrices(client, connection);

  const signer = loadKeypairFromJsonPath(cfg.agnesWalletKeypairPath);
  let liquidatorMarginfi = undefined;
  if (cfg.agnesLiquidatorMarginfiAccount) {
    const wrapped = await client.fetchAccount(new PublicKey(cfg.agnesLiquidatorMarginfiAccount), true);
    liquidatorMarginfi = wrapped.account;
  }

  const slot = await connection.getSlot("confirmed");
  const slotTracker = new SlotTracker();
  slotTracker.recordChainTip(slot);

  console.log(`[smoke:liq] fetching marginfi account ${liquidateePk.toBase58()} …`);
  const { account: liquidateeAccount } = await client.fetchAccount(liquidateePk, true);
  const liquidateeWrapper = new MarginfiAccountWrapper(liquidateeAccount, client);
  slotTracker.recordMarginfiAccount(liquidateePk.toBase58(), slot);

  const built = buildSmokeLiquidationCandidate(liquidateeWrapper, client, slotTracker, cfg);
  if (!built.candidate) {
    console.error("[smoke:liq] no candidate:", built.skipReason);
    process.exit(1);
  }

  const c = built.candidate;
  slotTracker.recordBank(c.assetBank.toBase58(), slot);
  slotTracker.recordBank(c.liabBank.toBase58(), slot);

  console.log(
    `[smoke:liq] candidate venue=${c.venue} smokeTest=${c.smokeTest} maxAsset=${c.maxAssetAmount.toString()} maxLiab=${c.maxLiabAmount.toString()} maintHealth=${c.maintHealthUsd}`,
  );

  try {
    assertBanksHydrated(client, c);
  } catch (err) {
    console.error("[smoke:liq] LIQUIDATION_SMOKE_TEST_BUILD_FAILED (preflight)", err.message);
    process.exit(1);
  }

  const planCtx = {
    client,
    connection,
    liquidatorSigner: signer.publicKey,
    liquidatorMarginfiAccount: liquidatorMarginfi,
    liquidateeWrapper,
    candidate: c,
  };

  let plan;
  try {
    plan = await buildAgnesLiquidationPlan(planCtx, cfg);
  } catch (err) {
    console.error(
      "[smoke:liq] LIQUIDATION_SMOKE_TEST_BUILD_FAILED",
      JSON.stringify(
        {
          liquidatee: liquidateePk.toBase58(),
          assetBank: c.assetBank.toBase58(),
          liabBank: c.liabBank.toBase58(),
          assetMint: c.assetMint.toBase58(),
          liabMint: c.liabMint.toBase58(),
          error: err?.message,
          stack: err?.stack,
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  if (plan.skipReason) {
    console.error("[smoke:liq] plan skip:", plan.skipReason, plan._bankHydrationDebug ?? plan._planBuildError?.message ?? "");
    process.exit(1);
  }

  const flashCtx = resolveAgnesFlashCtx(plan, client, liquidatorMarginfi);
  console.log(
    `[smoke:liq] bundle=${plan.liquidationBundleKind} marginfiFlashWrap=${plan.usesMarginfiFlashWrap ?? false}`,
  );

  const bh = await connection.getLatestBlockhash("processed");
  let compiled;
  try {
    compiled = await compileAgnesPlanToV0Tx(plan, signer.publicKey, bh.blockhash, flashCtx);
  } catch (err) {
    console.error("[smoke:liq] LIQUIDATION_SMOKE_TEST_BUILD_FAILED (compile)", err?.message, err?.stack);
    process.exit(1);
  }

  if (!compiled.ok) {
    console.error("[smoke:liq] compile failed", compiled.err?.message || compiled.err);
    process.exit(1);
  }

  const { tx, labeledIxs } = compiled;
  console.log(
    `[smoke:liq] compiled v0 ok instructions=${tx.message.compiledInstructions.length} luts=${plan.lookupTables?.length ?? 0}`,
  );

  const cand = plan.candidate;
  console.log("[smoke:liq] candidate+jupiter truth", {
    liquidatee: cand.liquidatee.toBase58(),
    assetBank: cand.assetBank.toBase58(),
    liabBank: cand.liabBank.toBase58(),
    assetMint: cand.assetMint.toBase58(),
    liabMint: cand.liabMint.toBase58(),
    repayUsesLiabBank: true,
    withdrawUsesAssetBank: plan.liquidationBundleKind === "classic_flash",
    jupiterBuildParams: plan._jupiterDebug?.requestParams ?? null,
  });

  for (let i = 0; i < labeledIxs.length; i++) {
    const row = labeledIxs[i];
    console.log(`[smoke:liq] ix ${i} ${row.label}`);
    if (
      row.label === "classic_lending_liquidate" ||
      String(row.label).toLowerCase().includes("liquidate")
    ) {
      row.ix.keys.forEach((k, idx) => {
        console.log(`  [${idx}] ${k.pubkey.toBase58()}`, { isSigner: k.isSigner, isWritable: k.isWritable });
      });
    }
  }

  if (stage === "build") {
    console.log("[smoke:liq] stage=build done (no simulation)");
    process.exit(0);
  }

  // Simulate with sigVerify:false — no local signing required; avoids VersionedTransaction.sign
  // serialization failures on very large v0 bundles (sign still applied for --send).
  const sim = await connection.simulateTransaction(tx, {
    commitment: "processed",
    replaceRecentBlockhash: true,
    sigVerify: false,
  });

  const logs = sim.value.logs ?? [];
  const payload = {
    tag: "LIQUIDATION_SMOKE_TEST_RESULT",
    liquidatee: liquidateePk.toBase58(),
    err: sim.value.err,
    unitsConsumed: sim.value.unitsConsumed,
    logsLineCount: logs.length,
    logsTail: logs.slice(-60),
  };
  console.log(JSON.stringify(payload, null, 2));

  if (send) {
    if (!cfg.agnesAllowSend) {
      console.error("[smoke:liq] --send requires AGNES_ALLOW_SEND=true");
      process.exit(1);
    }
    if (sim.value.err) {
      console.error("[smoke:liq] refusing --send: simulation returned err");
      process.exit(1);
    }
    tx.sign([signer]);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 2 });
    console.log("[smoke:liq] sent", sig);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke:liq] fatal", err);
  process.exit(1);
});
