import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  Project0Client,
  getConfig,
  MarginfiAccount,
  MarginfiAccountWrapper,
  Bank,
  fetchOracleData,
} from "@0dotxyz/p0-ts-sdk";

import { loadConfig } from "./config.js";
import { createGrpcStream } from "./yellowstone.js";
import { collectWatchedOraclePubkeys, discoverOracleOwnerPrograms, PYTH_PUSH_ORACLE_PROGRAM } from "./subscribe.js";
import { identifyMarginfiAccount } from "./idl.js";
import { printBankCatalog } from "./bank-summary.js";
import { getAllMarginfiAccountAddresses } from "./marginfi-account-addresses.js";
import { readMarginfiAccountCache, writeMarginfiAccountCache } from "./marginfi-account-cache.js";
import { preloadMarginfiAccountsIntoMaps } from "./preload.js";
import { installLogFileTee } from "./tee-log.js";
import { parseVenueList, inferBankVenue } from "./venues.js";
import {
  printAccountState,
  summarizeAccountHealth,
  summarizeAccountState,
  HEALTH_LEGEND_LINE,
  getActiveBalances,
} from "./health.js";

async function refreshOracleMap(client, connection) {
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
 * @param {string} oraclePk
 */
function banksReferencingOracle(client, oraclePk) {
  const out = [];
  for (const bank of client.banks) {
    const keys = bank.config?.oracleKeys || [];
    for (const k of keys) {
      const s = k?.toBase58?.() ?? String(k);
      if (s === oraclePk) {
        out.push(bank);
        break;
      }
    }
  }
  return out;
}

/**
 * @param {import("@0dotxyz/p0-ts-sdk").Bank} bank
 * @param {Set<string>} venueSet
 */
function bankVenueAllowed(bank, venueSet) {
  return venueSet.has(inferBankVenue(bank));
}

/**
 * @param {import("@0dotxyz/p0-ts-sdk").MarginfiAccountWrapper} wrapper
 * @param {import("@0dotxyz/p0-ts-sdk").Project0Client} client
 * @param {Set<string>} venueSet
 */
function accountTouchesVenueFilter(wrapper, client, venueSet) {
  for (const bal of getActiveBalances(wrapper)) {
    const bank = client.getBank(bal.bankPk);
    if (bank && bankVenueAllowed(bank, venueSet)) return true;
  }
  return false;
}

/**
 * @param {import("@0dotxyz/p0-ts-sdk").OraclePrice} price
 */
function fmtOraclePrice(price) {
  if (!price) return "n/a";
  const p = price?.weightedPrice ?? price?.price ?? price?.medianPrice;
  try {
    const n = typeof p?.toNumber === "function" ? p.toNumber() : Number(p);
    return Number.isFinite(n) ? n.toFixed(6) : "n/a";
  } catch {
    return "n/a";
  }
}

async function main() {
  const cfg = loadConfig();
  if (cfg.logFile) installLogFileTee(cfg.logFile);

  if (!cfg.grpcEndpoint || !cfg.grpcToken) {
    console.error("monitor: GRPC_ENDPOINT and GRPC_X_TOKEN are required");
    process.exit(1);
  }

  let venueSet;
  try {
    venueSet = parseVenueList(cfg.venuesFilter);
  } catch (e) {
    console.error("monitor:", e.message);
    process.exit(1);
  }

  const connection = new Connection(cfg.rpcUrl, cfg.commitment || "processed");
  const p0Config = getConfig(cfg.p0Environment, cfg.p0ConfigOverrides);

  console.log(
    `[monitor] boot rpc=${cfg.rpcUrl} group=${p0Config.groupPk.toBase58()} program=${p0Config.programId.toBase58()} venues=${cfg.venuesFilter}`,
  );
  console.log(HEALTH_LEGEND_LINE);

  const client = await Project0Client.initialize(connection, p0Config);
  await refreshOracleMap(client, connection);

  if (cfg.printBankCatalog) {
    printBankCatalog(client.banks);
  }

  const programId = new PublicKey(cfg.marginfiProgramId);
  const groupPkStr = client.group.address.toBase58();
  const watchedOracleSet = new Set(collectWatchedOraclePubkeys(client.banks));

  /** @type {Map<string, Buffer>} */
  const accountRawByKey = new Map();
  /** @type {Map<string, import("@0dotxyz/p0-ts-sdk").MarginfiAccount>} */
  const accountByKey = new Map();
  /** bankPk -> Set of marginfi account pubkeys */
  const bankToMarginfiAccounts = new Map();

  function removeAccountFromBankIndex(pkStr) {
    for (const set of bankToMarginfiAccounts.values()) {
      set.delete(pkStr);
    }
  }

  function indexAccountBanks(pkStr, account) {
    removeAccountFromBankIndex(pkStr);
    for (const bal of account.activeBalances ?? []) {
      const bk = bal.bankPk?.toBase58?.() ?? String(bal.bankPk);
      if (!bankToMarginfiAccounts.has(bk)) bankToMarginfiAccounts.set(bk, new Set());
      bankToMarginfiAccounts.get(bk).add(pkStr);
    }
  }

  function marginfiKeysLinkedToBank(bankPkStr) {
    return [...(bankToMarginfiAccounts.get(bankPkStr) || [])];
  }

  function unionAccountsForBanks(banks) {
    const keys = new Set();
    for (const b of banks) {
      const s = b.address.toBase58();
      for (const pk of marginfiKeysLinkedToBank(s)) keys.add(pk);
    }
    return [...keys];
  }

  async function printLinkedAccounts(label, marginfiPkStrs, slotLabel) {
    for (const pkStr of marginfiPkStrs) {
      const acc = accountByKey.get(pkStr);
      if (!acc) continue;
      const wrapper = new MarginfiAccountWrapper(acc, client);
      if (!accountTouchesVenueFilter(wrapper, client, venueSet)) continue;
      const row = summarizeAccountHealth(client, wrapper);
      console.log(`[${label}] slot=${slotLabel} ${row.line}`);
      if (cfg.grpcLogAccountUpdateSlot) {
        printAccountState(`[${label}]`, summarizeAccountState(wrapper, client));
      }
    }
  }

  /** @type {string[]} */
  let marginfiAccountAddresses;
  if (cfg.marginfiAccounts.length > 0) {
    marginfiAccountAddresses = cfg.marginfiAccounts.map((s) => new PublicKey(s).toBase58());
  } else {
    const pks = await getAllMarginfiAccountAddresses(client.program, client.group.address);
    marginfiAccountAddresses = pks.map((p) => p.toBase58());
  }

  const catalogMode =
    cfg.catalogMode === "full" ? "full" : cfg.catalogMode === "summary" ? "summary" : "auto";
  const useSummary =
    catalogMode === "summary" ||
    (catalogMode === "auto" && marginfiAccountAddresses.length > cfg.catalogSummaryThreshold);

  console.log(
    `[monitor] discovered ${marginfiAccountAddresses.length} marginfi accounts (catalog=${catalogMode === "auto" ? `auto→${useSummary ? "summary" : "full"}` : catalogMode})`,
  );

  /** @type {ReturnType<typeof setTimeout> | null} */
  let marginfiCacheSaveTimer = null;

  async function persistMarginfiAccountCache(reason = "debounced") {
    if (!cfg.agnesMarginfiAccountCacheFile || accountRawByKey.size === 0) return;
    try {
      await writeMarginfiAccountCache(cfg.agnesMarginfiAccountCacheFile, {
        programId: cfg.marginfiProgramId,
        groupPk: groupPkStr,
        accountRawByKey,
      });
      let rawBytes = 0;
      for (const b of accountRawByKey.values()) rawBytes += b.length;
      const approxMb = (rawBytes / (1024 * 1024)).toFixed(2);
      console.log(
        `[cache] wrote ${accountRawByKey.size} entries (~${approxMb} MiB raw account data) to ${cfg.agnesMarginfiAccountCacheFile} (${reason})`,
      );
    } catch (e) {
      console.warn(`[cache] write failed (${reason}): ${e?.message || e}`);
    }
  }

  function scheduleMarginfiAccountCachePersist() {
    if (!cfg.agnesMarginfiAccountCacheFile) return;
    if (marginfiCacheSaveTimer) clearTimeout(marginfiCacheSaveTimer);
    marginfiCacheSaveTimer = setTimeout(() => {
      marginfiCacheSaveTimer = null;
      void persistMarginfiAccountCache("debounced");
    }, cfg.agnesMarginfiAccountCacheSaveDebounceMs);
    marginfiCacheSaveTimer.unref?.();
  }

  if (cfg.agnesMarginfiAccountCacheFile) {
    const cached = await readMarginfiAccountCache(cfg.agnesMarginfiAccountCacheFile, {
      programId: cfg.marginfiProgramId,
      groupPk: groupPkStr,
    });
    if (cached.ok) {
      let ok = 0;
      let bad = 0;
      for (const [pkStr, buf] of cached.accounts) {
        try {
          const acc = MarginfiAccount.fromAccountDataRaw(new PublicKey(pkStr), buf, client.program.idl);
          accountByKey.set(pkStr, acc);
          indexAccountBanks(pkStr, acc);
          accountRawByKey.set(pkStr, buf);
          ok++;
        } catch {
          bad++;
        }
      }
      console.log(
        `[cache] loaded ${ok} decoded marginfi accounts from ${cfg.agnesMarginfiAccountCacheFile} savedAt=${cached.savedAt ?? "?"} decode_skipped=${bad}`,
      );
    } else {
      console.log(`[cache] disk cache not used (${cached.reason}) path=${cfg.agnesMarginfiAccountCacheFile}`);
    }
  }

  if (!useSummary) {
    for (const pkStr of marginfiAccountAddresses) {
      try {
        const pk = new PublicKey(pkStr);
        const info = await connection.getAccountInfo(pk, cfg.commitment || "confirmed");
        if (!info?.data) {
          console.log(`[catalog] ${pkStr} status=missing`);
          continue;
        }
        const raw = Buffer.from(info.data);
        accountRawByKey.set(pkStr, raw);
        const acc = MarginfiAccount.fromAccountDataRaw(pk, raw, client.program.idl);
        accountByKey.set(pkStr, acc);
        indexAccountBanks(pkStr, acc);
        const w = new MarginfiAccountWrapper(acc, client);
        const row = summarizeAccountHealth(client, w);
        console.log(`[catalog] ${row.line}`);
      } catch (e) {
        console.warn(`[catalog] ${pkStr} decode_error=${e?.message || e}`);
      }
    }
  } else {
    console.log("[catalog] summary mode: per-account lines suppressed; cache warms from gRPC / preload");
  }

  if (cfg.rpcPreloadMarginfiAccounts) {
    const cap = Math.min(cfg.rpcPreloadMaxAccounts, marginfiAccountAddresses.length);
    const slice = marginfiAccountAddresses.slice(0, cap);
    const warmFromCache = new Set();
    for (const pk of slice) {
      if (accountRawByKey.has(pk) && accountByKey.has(pk)) warmFromCache.add(pk);
    }
    const toFetch = slice.filter((pk) => !warmFromCache.has(pk));

    if (toFetch.length === 0) {
      console.log(
        `[monitor] RPC preload: skipped network (all ${slice.length} accounts within cap already warm from disk cache)`,
      );
    } else {
      const useGpaThisRun =
        cfg.rpcPreloadUseGpa && toFetch.length === slice.length && slice.length > 0;
      const result = await preloadMarginfiAccountsIntoMaps({
        connection,
        program: client.program,
        groupPk: client.group.address,
        programId: cfg.marginfiProgramId,
        idl: client.program.idl,
        addressListBase58: toFetch,
        cap: toFetch.length,
        commitment: cfg.commitment || "confirmed",
        useGpa: useGpaThisRun,
        chunkSize: cfg.rpcPreloadChunkSize,
        concurrency: cfg.rpcPreloadConcurrency,
        progressIntervalMs: cfg.rpcPreloadProgressIntervalMs,
        onAccount(pkStr, raw, acc) {
          accountRawByKey.set(pkStr, raw);
          accountByKey.set(pkStr, acc);
          indexAccountBanks(pkStr, acc);
        },
      });
      const elapsedS = (result.stats.elapsedMs / 1000).toFixed(2);
      const rate =
        result.stats.elapsedMs > 0
          ? ((1000 * result.stats.processed) / result.stats.elapsedMs).toFixed(0)
          : "0";
      console.log(
        `[monitor] RPC preload: decoded ${result.stats.decoded}/${cap} marginfi accounts into cache method=${result.method} elapsed=${elapsedS}s procRate=${rate}/s`,
      );
    }

    if (cfg.agnesMarginfiAccountCacheFile) {
      await persistMarginfiAccountCache("post-preload");
    }
  }

  let shuttingDown = false;
  async function shutdownPersist() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (marginfiCacheSaveTimer) {
      clearTimeout(marginfiCacheSaveTimer);
      marginfiCacheSaveTimer = null;
    }
    await persistMarginfiAccountCache("shutdown");
  }

  function onShutdownSignal() {
    void shutdownPersist().finally(() => process.exit(0));
  }
  process.once("SIGINT", onShutdownSignal);
  process.once("SIGTERM", onShutdownSignal);

  const oracleKeys = [...watchedOracleSet];
  const discoveredOwners = await discoverOracleOwnerPrograms(connection, oracleKeys);
  const oracleOwnerProgramIds = [
    ...new Set([...discoveredOwners, ...cfg.grpcOracleOwnerProgramIds, PYTH_PUSH_ORACLE_PROGRAM]),
  ].sort();

  console.log(
    `[monitor] oracle owner filters (${oracleOwnerProgramIds.length}): ${oracleOwnerProgramIds.join(", ")}`,
  );

  if (cfg.grpcSubscribeExplicitAccounts && marginfiAccountAddresses.length > 5_000) {
    console.warn(
      `[monitor] GRPC_SUBSCRIBE_EXPLICIT_ACCOUNTS=true with ${marginfiAccountAddresses.length} keys often overloads Yellowstone (duplicate of the marginfi owner filter). Set GRPC_SUBSCRIBE_EXPLICIT_ACCOUNTS=false unless you need a tiny explicit allowlist.`,
    );
  }

  const explicitAccounts = cfg.grpcSubscribeExplicitAccounts
    ? new Set(marginfiAccountAddresses)
    : new Set();
  const grpcCfg = {
    grpcEndpoint: cfg.grpcEndpoint,
    grpcToken: cfg.grpcToken,
    marginfiProgramId: cfg.marginfiProgramId,
    commitment: cfg.commitment,
    grpcSubscribeExplicitAccounts: cfg.grpcSubscribeExplicitAccounts,
    grpcSubscribeSlots: cfg.grpcSubscribeSlots,
  };

  let latestChainSlot = "0";

  await createGrpcStream(
    grpcCfg,
    {
      explicitAccounts,
      oracleOwnerProgramIds,
      subscribeExplicitAccounts: cfg.grpcSubscribeExplicitAccounts,
    },
    async (u) => {
      const slotLabel = u.slot ?? latestChainSlot;
      const owner = u.owner;
      const pkStr = u.pubkey;

      try {
        if (owner === cfg.marginfiProgramId) {
          const id = identifyMarginfiAccount(u.data);
          if (id.type === "Bank") {
            const bank = Bank.fromBuffer(new PublicKey(pkStr), u.data, client.program.idl);
            if (!bankVenueAllowed(bank, venueSet)) {
              client.bankMap.set(pkStr, bank);
              return;
            }
            client.bankMap.set(pkStr, bank);
            for (const k of collectWatchedOraclePubkeys([bank])) watchedOracleSet.add(k);
            console.log(
              `[bank] slot=${slotLabel} pk=${pkStr} symbol=${bank.tokenSymbol || "?"} venue=${inferBankVenue(bank)} startup=${u.isStartup}`,
            );
            const linked = unionAccountsForBanks([bank]);
            await printLinkedAccounts("bank", linked, slotLabel);
            return;
          }

          if (id.type === "MarginfiAccount") {
            accountRawByKey.set(pkStr, Buffer.from(u.data));
            scheduleMarginfiAccountCachePersist();
            const acc = MarginfiAccount.fromAccountDataRaw(new PublicKey(pkStr), u.data, client.program.idl);
            accountByKey.set(pkStr, acc);
            indexAccountBanks(pkStr, acc);
            const wrapper = new MarginfiAccountWrapper(acc, client);
            if (!accountTouchesVenueFilter(wrapper, client, venueSet)) return;
            const row = summarizeAccountHealth(client, wrapper);
            console.log(`[account] slot=${slotLabel} ${row.line}`);
            if (cfg.grpcLogAccountUpdateSlot) {
              printAccountState("[account]", summarizeAccountState(wrapper, client));
            }
            return;
          }

          console.log(
            `[marginfi_program] slot=${slotLabel} pk=${pkStr} layout=${id.type} disc=${id.discriminator} startup=${u.isStartup}`,
          );
          return;
        }

        if (!watchedOracleSet.has(pkStr)) return;

        if (cfg.refreshOraclesOnUpdate) {
          await refreshOracleMap(client, connection);
        }

        const linkedBanks = banksReferencingOracle(client, pkStr).filter((b) => bankVenueAllowed(b, venueSet));
        const oracleUsdParts = linkedBanks.map((b) => {
          const price = client.oraclePriceByBank.get(b.address.toBase58());
          return `${b.tokenSymbol || b.address.toBase58().slice(0, 4)}@${fmtOraclePrice(price)}`;
        });
        console.log(
          `[oracle] slot=${slotLabel} pk=${pkStr} banks=${linkedBanks.length} oracleUsd=[${oracleUsdParts.join(" ")}]`,
        );

        const linked = unionAccountsForBanks(linkedBanks);
        await printLinkedAccounts("oracle", linked, slotLabel);
      } catch (e) {
        console.warn(`[monitor] handler_error pk=${pkStr} err=${e?.message || e}`);
      }
    },
    (slotMsg) => {
      const s = slotMsg?.slot != null ? String(slotMsg.slot) : "";
      if (s) latestChainSlot = s;
      if (cfg.grpcLogSlotUpdates && s) {
        console.log(`[slot] ${s} status=${slotMsg?.status ?? ""}`);
      }
    },
  );

  console.log("[monitor] gRPC stream running (Ctrl+C to exit)");
}

main().catch((err) => {
  console.error("[monitor] fatal", err);
  process.exit(1);
});
