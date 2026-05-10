import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { BigNumber } from "bignumber.js";
import {
  makeWithdrawIx,
  makeKaminoWithdrawIx,
  makeDriftWithdrawIx,
  makeJuplendWithdrawIx,
} from "@0dotxyz/p0-ts-sdk";
import { fetchKaminoReserve } from "../resolvers/kamino-reserve.js";
import {
  createKaminoLendingProgram,
  makeRefreshKaminoReserveIx,
  makeRefreshKaminoObligationIx,
} from "../instructions/kamino-refresh.js";
import { fetchDriftSpotMarket } from "../resolvers/drift-spot-market.js";
import { makeDriftRefreshSpotMarketIx } from "../pdas/drift.js";
import { fetchJuplendLending } from "../resolvers/juplend-lending.js";
import { makeUpdateJupLendRateIx } from "../instructions/juplend-update-rate.js";

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

/**
 * @typedef {object} PlanContext
 * @property {import("@0dotxyz/p0-ts-sdk").Project0Client} client
 * @property {import("@solana/web3.js").Connection} connection
 * @property {import("@0dotxyz/p0-ts-sdk").MarginfiAccountWrapper | null} liquidateeWrapper
 * @property {import("@solana/web3.js").PublicKey} liquidatorPk
 * @property {import("@solana/web3.js").PublicKey} marginfiAccountLiquidatee
 * @property {import("@solana/web3.js").PublicKey} liquidationReceiver
 * @property {import("@solana/web3.js").PublicKey} assetWithdrawAta
 * @property {import("@solana/web3.js").PublicKey} liabRepayAta
 * @property {import("@0dotxyz/p0-ts-sdk").Bank} assetBank
 * @property {import("@0dotxyz/p0-ts-sdk").Bank} liabBank
 * @property {bigint} withdrawAmountNative
 * @property {bigint} repayAmountNative
 *
 * Venue handlers return ordered withdraw instructions: optional setup (e.g. ATA create) then the main withdraw.
 */

/**
 * @param {import("../candidate.js")} candidate
 */
export function pickVenueHandler(venue) {
  switch (venue) {
    case "marginfi":
      return new MarginfiNativeHandler();
    case "kamino":
      return new KaminoHandler();
    case "drift":
      return new DriftHandler();
    case "juplend":
      return new JupLendHandler();
    case "solend":
      return new SolendRejectHandler();
    default:
      return new UnknownVenueRejectHandler();
  }
}

export class MarginfiNativeHandler {
  get venue() {
    return "marginfi";
  }

  canHandle(candidate) {
    return candidate.venue === "marginfi";
  }

  /** @returns {Promise<import("@solana/web3.js").TransactionInstruction[]>} */
  async buildPreRefreshIxs(_ctx) {
    return [];
  }

  /**
   * p0-ts-sdk exports `makeWithdrawIx` as the v3 builder (object args): full `Bank`, `bankMap`, decoded liquidatee account, UI amount.
   * @returns {Promise<import("@solana/web3.js").TransactionInstruction[]>}
   */
  async buildWithdrawIx(ctx) {
    if (!ctx.liquidateeWrapper) {
      throw new Error("MarginfiNativeHandler: liquidateeWrapper required");
    }
    if (!ctx.assetBank?.mint || !ctx.assetBank?.address) {
      throw new Error(
        "MarginfiNativeHandler.buildWithdrawIx: asset bank missing mint or address",
      );
    }
    if (!ctx.liabBank?.mint || !ctx.liabBank?.address) {
      throw new Error(
        "MarginfiNativeHandler.buildWithdrawIx: liability bank missing mint or address",
      );
    }
    const amountUi = withdrawNativeToUiAmount(ctx.withdrawAmountNative, ctx.assetBank);
    const tokenProgram = await getMintOwnerOrTokenProgram(ctx.connection, ctx.assetBank.mint);
    const wrap = await makeWithdrawIx({
      program: ctx.client.program,
      bank: ctx.assetBank,
      bankMap: ctx.client.bankMap,
      bankMetadataMap: ctx.client.bankIntegrationMap,
      tokenProgram,
      amount: amountUi,
      marginfiAccount: ctx.liquidateeWrapper.account,
      authority: ctx.liquidationReceiver,
      withdrawAll: false,
      opts: { createAtas: true, wrapAndUnwrapSol: true },
    });
    return wrap.instructions;
  }

  /** @returns {Promise<import("@solana/web3.js").PublicKey[]>} */
  async getRequiredAccounts(_ctx) {
    return [];
  }
}

async function getMintOwnerOrTokenProgram(connection, mintPk) {
  const ai = await connection.getAccountInfo(mintPk, "processed");
  return ai?.owner ?? TOKEN_PROGRAM_ID;
}

export class KaminoHandler {
  get venue() {
    return "kamino";
  }

  canHandle(candidate) {
    return candidate.venue === "kamino";
  }

  /** @param {PlanContext} ctx */
  async buildPreRefreshIxs(ctx) {
    const k = ctx.assetBank.kaminoIntegrationAccounts;
    if (!k) return [];
    const reserve = await fetchKaminoReserve(ctx.connection, k.kaminoReserve);
    const kaminoProgram = createKaminoLendingProgram(ctx.connection);
    const refreshReserve = await makeRefreshKaminoReserveIx(kaminoProgram, k.kaminoReserve, reserve);
    const refreshObligation = makeRefreshKaminoObligationIx(reserve.lendingMarket, k.kaminoObligation, k.kaminoReserve);
    ctx._kaminoReserveLayout = reserve;
    return [refreshReserve, refreshObligation];
  }

  /** @param {PlanContext} ctx */
  async buildWithdrawIx(ctx) {
    if (!ctx.liquidateeWrapper) throw new Error("KaminoHandler: liquidateeWrapper required");
    const k = ctx.assetBank.kaminoIntegrationAccounts;
    if (!k) throw new Error("KaminoHandler: bank missing kaminoIntegrationAccounts");
    const reserve =
      ctx._kaminoReserveLayout ?? (await fetchKaminoReserve(ctx.connection, k.kaminoReserve));
    const liquidityTokenProgram = await getMintOwnerOrTokenProgram(ctx.connection, ctx.assetBank.mint);
    const amountUi = withdrawNativeToUiAmount(ctx.withdrawAmountNative, ctx.assetBank);
    const wrap = await makeKaminoWithdrawIx({
      program: ctx.client.program,
      bank: ctx.assetBank,
      bankMap: ctx.client.bankMap,
      bankMetadataMap: ctx.client.bankIntegrationMap,
      tokenProgram: liquidityTokenProgram,
      cTokenAmount: amountUi,
      marginfiAccount: ctx.liquidateeWrapper.account,
      authority: ctx.liquidationReceiver,
      reserve,
      withdrawAll: false,
      opts: { createAtas: true, wrapAndUnwrapSol: true },
    });
    return wrap.instructions;
  }

  async getRequiredAccounts(ctx) {
    const k = ctx.assetBank.kaminoIntegrationAccounts;
    if (!k) return [];
    return [k.kaminoReserve, k.kaminoObligation];
  }
}

export class DriftHandler {
  get venue() {
    return "drift";
  }

  canHandle(candidate) {
    return candidate.venue === "drift";
  }

  /** @param {PlanContext} ctx */
  async buildPreRefreshIxs(ctx) {
    const d = ctx.assetBank.driftIntegrationAccounts;
    if (!d) return [];
    const spot = await fetchDriftSpotMarket(ctx.connection, d.driftSpotMarket);
    ctx._driftSpotLayout = spot;
    return [makeDriftRefreshSpotMarketIx(spot, d.driftSpotMarket)];
  }

  /** @param {PlanContext} ctx */
  async buildWithdrawIx(ctx) {
    if (!ctx.liquidateeWrapper) throw new Error("DriftHandler: liquidateeWrapper required");
    const d = ctx.assetBank.driftIntegrationAccounts;
    if (!d) throw new Error("DriftHandler: bank missing driftIntegrationAccounts");
    const spot =
      ctx._driftSpotLayout ?? (await fetchDriftSpotMarket(ctx.connection, d.driftSpotMarket));
    const tokenProgram = await getMintOwnerOrTokenProgram(ctx.connection, ctx.assetBank.mint);
    const amountUi = withdrawNativeToUiAmount(ctx.withdrawAmountNative, ctx.assetBank);
    const wrap = await makeDriftWithdrawIx({
      program: ctx.client.program,
      bank: ctx.assetBank,
      bankMap: ctx.client.bankMap,
      bankMetadataMap: ctx.client.bankIntegrationMap,
      tokenProgram,
      amount: amountUi,
      marginfiAccount: ctx.liquidateeWrapper.account,
      authority: ctx.liquidationReceiver,
      driftSpotMarket: spot,
      userRewards: [],
      withdrawAll: false,
      opts: { createAtas: true, wrapAndUnwrapSol: true },
    });
    return wrap.instructions;
  }

  async getRequiredAccounts(ctx) {
    const d = ctx.assetBank.driftIntegrationAccounts;
    if (!d) return [];
    return [d.driftSpotMarket, d.driftUser, d.driftUserStats];
  }
}

export class JupLendHandler {
  get venue() {
    return "juplend";
  }

  canHandle(candidate) {
    return candidate.venue === "juplend";
  }

  /** @param {PlanContext} ctx */
  async buildPreRefreshIxs(ctx) {
    const j = ctx.assetBank.jupLendIntegrationAccounts;
    if (!j) return [];
    const lending = await fetchJuplendLending(ctx.connection, j.jupLendingState);
    ctx._juplendLendingLayout = lending;
    return [makeUpdateJupLendRateIx(lending)];
  }

  /** @param {PlanContext} ctx */
  async buildWithdrawIx(ctx) {
    if (!ctx.liquidateeWrapper) throw new Error("JupLendHandler: liquidateeWrapper required");
    const j = ctx.assetBank.jupLendIntegrationAccounts;
    if (!j) throw new Error("JupLendHandler: bank missing jupLendIntegrationAccounts");
    const lending =
      ctx._juplendLendingLayout ?? (await fetchJuplendLending(ctx.connection, j.jupLendingState));
    const tokenProgram = await getMintOwnerOrTokenProgram(ctx.connection, ctx.assetBank.mint);
    const amountUi = withdrawNativeToUiAmount(ctx.withdrawAmountNative, ctx.assetBank);
    const wrap = await makeJuplendWithdrawIx({
      program: ctx.client.program,
      bank: ctx.assetBank,
      bankMap: ctx.client.bankMap,
      bankMetadataMap: ctx.client.bankIntegrationMap,
      tokenProgram,
      amount: amountUi,
      marginfiAccount: ctx.liquidateeWrapper.account,
      authority: ctx.liquidationReceiver,
      jupLendingState: lending,
      withdrawAll: false,
      opts: { createAtas: true, wrapAndUnwrapSol: true },
    });
    return wrap.instructions;
  }

  async getRequiredAccounts(ctx) {
    const j = ctx.assetBank.jupLendIntegrationAccounts;
    if (!j) return [];
    return [j.jupLendingState, j.jupFTokenVault, j.jupFTokenAta];
  }
}

/** Plan approval explicitly rejects Solend until a dedicated handler exists. */
export class SolendRejectHandler {
  get venue() {
    return "solend";
  }

  canHandle() {
    return false;
  }

  async buildPreRefreshIxs() {
    return [];
  }

  async buildWithdrawIx() {
    throw new Error("SolendRejectHandler: solend maps to UnknownVenueReject until SolendHandler is implemented.");
  }

  async getRequiredAccounts() {
    return [];
  }
}

export class UnknownVenueRejectHandler extends SolendRejectHandler {
  get venue() {
    return "unknown";
  }
}
