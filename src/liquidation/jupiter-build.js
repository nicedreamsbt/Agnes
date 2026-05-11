import { PublicKey, TransactionInstruction, AddressLookupTableAccount } from "@solana/web3.js";

/**
 * Main-pool marginfi address lookup tables from **mrgnlabs/eva01** `bin/env.template` on `main`
 * (`ADDRESS_LOOKUP_TABLES` for `MARGINFI_GROUP_KEY=4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8`).
 * Source: https://raw.githubusercontent.com/mrgnlabs/eva01/main/bin/env.template
 * @type {string[]}
 */
export const MARGINFI_MAINNET_EVA01_ADDRESS_LOOKUP_TABLES = [
  "HGmknUTUmeovMc9ryERNWG6UFZDFDVr9xrum3ZhyL4fC",
  "5FuKF7C1tJji2mXZuJ14U9oDb37is5mmvYLf4KwojoF1",
  "FEFhAFKz48P3w82Ds5VhvyEDwhRqu2FejmnuxEPZ8wNR",
];

/**
 * Extra lookup tables seen on a successful mainnet marginfi + Jupiter liquidation v0 tx alongside the Eva01
 * trio (`debug/reference-liquidation-tx-flash.json`, sig `2aj9nD9b…`). Not listed in Eva01 `env.template`;
 * v0 packets often need them (or equivalent keys in `ADDRESS_LOOKUP_TABLES`) so the wire tx stays within limits.
 * @type {string[]}
 */
export const MAINNET_LIQUIDATION_SUPPLEMENTAL_LOOKUP_TABLES = [
  "4VUvLs2NWeYJ7foJJa4haPj1qmSCASpCH5DZpPJx6K4m",
  "FfeWRCHU1fHeA6kA7LSJWFyvJGYGiMFvwHu27tfvBihj",
  "4DkrbVbYgvTUuvjaszMePRy47BFoJUvueF2fZW4dM9pR",
  "4w1WePBAVEN3TzVjTeviUqjwDjhRA5LEnuREQv2uLJRD",
  "Cw9mkkuEs1s7miv54xADZzNJ8byQ5JkgW4xhQoysvreK",
  "ApkUquETmFzDKZod6ZXKMgSBwDaM7TcajDRjP5m6uS8B",
  "FQCY2Cbea1jazkUc6xjBUD72gMT2o8Mr4mnMd7gpL2F1",
  "GERDuMq2KXct84sG9JUxuRguqfcPvn71gYXg2p3LLHv4",
  "HuN7BpVBvKAWhquZb5gC9x1MUcAwVRkHpNM9sJKEWo8x",
];

/** Jupiter `/build` HTTP failure (body never includes API key; key is only in headers). */
export class JupiterBuildHttpError extends Error {
  /**
   * @param {string} message
   * @param {{ status: number, body: string, url: string }} info
   */
  constructor(message, info) {
    super(message);
    this.name = "JupiterBuildHttpError";
    this.status = info.status;
    this.body = info.body;
    this.url = info.url;
  }
}

/**
 * @param {object} apiIx
 * @param {string} apiIx.programId
 * @param {{ pubkey: string, isSigner: boolean, isWritable: boolean }[]} apiIx.accounts
 * @param {string} apiIx.data
 */
export function ixFromJup(apiIx) {
  return new TransactionInstruction({
    programId: new PublicKey(apiIx.programId),
    keys: apiIx.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(apiIx.data, "base64"),
  });
}

/**
 * Jupiter Swap API v2 `/build` (build-path HTTP; not hot-path state revalidation).
 * @param {string} baseUrl e.g. https://lite-api.jup.ag/swap/v2
 * @param {Record<string, string>} queryParams
 * @param {object} [opts]
 * @param {string} [opts.apiKey] Jupiter portal API key (`x-api-key` header)
 */
export async function jupiterSwapBuildGet(baseUrl, queryParams, opts = {}) {
  const root = baseUrl.replace(/\/$/, "");
  const u = new URL(`${root}/build`);
  for (const [k, v] of Object.entries(queryParams)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  /** @type {Record<string, string>} */
  const headers = { Accept: "application/json" };
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
  const url = u.toString();
  const res = await fetch(url, { method: "GET", headers });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new JupiterBuildHttpError(`Jupiter /build failed ${res.status}`, {
      status: res.status,
      body: text,
      url,
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new JupiterBuildHttpError("Jupiter /build returned non-JSON", {
      status: res.status,
      body: text.slice(0, 10_000),
      url,
    });
  }
}

/**
 * Extract route labels and swap summary fields from Jupiter `/build` JSON (shape varies by API version).
 * @param {object} raw
 * @param {Record<string, string>} requestParams
 */
export function buildJupiterRouteSummary(raw, requestParams) {
  /** @type {string[]} */
  const routeLabels = [];
  const plan = raw?.routePlan;
  if (Array.isArray(plan)) {
    for (const step of plan) {
      const li = step?.swapInfo;
      if (li && typeof li === "object" && li.label) routeLabels.push(String(li.label));
      else if (typeof li === "string") routeLabels.push(li);
    }
  }
  const maxAccountsStr = requestParams?.maxAccounts;
  const slipStr = requestParams?.slippageBps;
  return {
    inAmount: raw?.inAmount != null ? String(raw.inAmount) : undefined,
    outAmount: raw?.outAmount != null ? String(raw.outAmount) : undefined,
    minOutAmount: raw?.otherAmountThreshold != null ? String(raw.otherAmountThreshold) : undefined,
    priceImpactPct:
      typeof raw?.priceImpactPct === "number"
        ? raw.priceImpactPct
        : raw?.priceImpactPct != null
          ? Number(raw.priceImpactPct)
          : undefined,
    slippageBps: slipStr != null && slipStr !== "" ? Number(slipStr) : undefined,
    routeLabels: routeLabels.length ? routeLabels : undefined,
    maxAccounts: maxAccountsStr != null && maxAccountsStr !== "" ? Number(maxAccountsStr) : undefined,
  };
}

/**
 * Map Jupiter `/build` JSON into structured ix arrays + LUT addresses.
 * @param {object} build
 */
export function parseJupiterBuildResponse(build) {
  const setupInstructions = (build.setupInstructions ?? []).map(ixFromJup);
  const swapInstruction = build.swapInstruction ? ixFromJup(build.swapInstruction) : null;
  const cleanupInstruction = build.cleanupInstruction ? ixFromJup(build.cleanupInstruction) : null;
  const otherInstructions = (build.otherInstructions ?? []).map(ixFromJup);
  const tipInstruction = build.tipInstruction ? ixFromJup(build.tipInstruction) : null;
  const computeBudgetInstructions = (build.computeBudgetInstructions ?? []).map(ixFromJup);

  const lutAddresses = Object.keys(build.addressesByLookupTableAddress ?? {});

  return {
    computeBudgetInstructions,
    setupInstructions,
    swapInstruction,
    cleanupInstruction,
    otherInstructions,
    tipInstruction,
    lutAddresses,
    raw: build,
  };
}

/**
 * Build-path RPC: load on-chain LUT account data for v0 compilation.
 * @param {import("@solana/web3.js").Connection} connection
 * @param {string[]} lutAddresses base58
 */
export async function fetchLookupTableAccounts(connection, lutAddresses) {
  const pks = lutAddresses.map((a) => new PublicKey(a));
  if (pks.length === 0) return [];
  const infos = await connection.getMultipleAccountsInfo(pks);
  const out = [];
  for (let i = 0; i < pks.length; i++) {
    const info = infos[i];
    if (!info?.data) continue;
    const acc = new AddressLookupTableAccount({
      key: pks[i],
      state: AddressLookupTableAccount.deserialize(info.data),
    });
    out.push(acc);
  }
  return out;
}
