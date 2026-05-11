import { PublicKey } from "@solana/web3.js";
import { uiToNative, getPrice, PriceBias } from "@0dotxyz/p0-ts-sdk";
import { BigNumber } from "bignumber.js";

function mintDecimalsToNumber(mintDecimals) {
  if (mintDecimals == null) return 0;
  if (typeof mintDecimals === "number" && Number.isFinite(mintDecimals)) return mintDecimals;
  if (typeof mintDecimals === "bigint") return Number(mintDecimals);
  if (typeof mintDecimals.toNumber === "function") {
    try {
      const n = mintDecimals.toNumber();
      if (Number.isFinite(n)) return n;
    } catch {
      /* fall through */
    }
  }
  const parsed = Number.parseInt(String(mintDecimals), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function bnToBigInt(bn) {
  if (!bn) return 0n;
  if (typeof bn === "bigint") return bn;
  if (bn.toArrayLike) {
    const hex = bn.toString(16);
    return BigInt(hex ? "0x" + hex : "0");
  }
  return BigInt(String(bn));
}

/**
 * USD per 1 UI token (human) from SDK oracle map (same path as health).
 * @param {import("@0dotxyz/p0-ts-sdk").Project0Client} client
 * @param {import("@0dotxyz/p0-ts-sdk").Bank} bank
 */
function usdPerUiToken(client, bank) {
  const pk = bank.address.toBase58();
  const oraclePrice = client.oraclePriceByBank.get(pk);
  if (!oraclePrice) return null;
  const p = getPrice(oraclePrice, PriceBias.None, true);
  const n = typeof p?.toNumber === "function" ? p.toNumber() : Number(p);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Cap candidate repay / withdraw sizes to roughly LIQ_SMOKE_MAX_REPAY_USD notional on the liability leg.
 * @param {object} candidate
 * @param {import("@0dotxyz/p0-ts-sdk").Project0Client} client
 * @param {number} maxRepayUsd
 * @returns {{ candidate: object, cappedRepayUsd: number, applied: boolean }}
 */
export function capCandidateRepayUsd(candidate, client, maxRepayUsd) {
  if (!candidate || maxRepayUsd <= 0 || !Number.isFinite(maxRepayUsd)) {
    return { candidate, cappedRepayUsd: maxRepayUsd, applied: false };
  }

  const liabPk = candidate.liabBank instanceof PublicKey ? candidate.liabBank : new PublicKey(candidate.liabBank);
  const liabBank = client.getBank(liabPk);
  if (!liabBank) {
    return { candidate, cappedRepayUsd: maxRepayUsd, applied: false };
  }

  const usdPerUi = usdPerUiToken(client, liabBank);
  if (!usdPerUi || usdPerUi <= 0) {
    return { candidate, cappedRepayUsd: maxRepayUsd, applied: false };
  }

  const md = mintDecimalsToNumber(liabBank.mintDecimals);
  const maxLiabUi = new BigNumber(maxRepayUsd).dividedBy(usdPerUi);
  const maxLiabCapNative = bnToBigInt(uiToNative(maxLiabUi, md));
  const origLiab = candidate.maxLiabAmount;
  const origAsset = candidate.maxAssetAmount;
  if (origLiab <= 0n) {
    return { candidate, cappedRepayUsd: maxRepayUsd, applied: false };
  }

  const newLiab = origLiab < maxLiabCapNative ? origLiab : maxLiabCapNative;
  if (newLiab <= 0n || newLiab === origLiab) {
    const liabUiOrig = new BigNumber(origLiab.toString()).dividedBy(new BigNumber(10).pow(md));
    const liabUsd = liabUiOrig.multipliedBy(usdPerUi).toNumber();
    return { candidate, cappedRepayUsd: liabUsd, applied: newLiab !== origLiab };
  }

  const ratioNum = new BigNumber(newLiab.toString()).dividedBy(new BigNumber(origLiab.toString()));
  const newAssetBn = new BigNumber(origAsset.toString()).multipliedBy(ratioNum).integerValue(BigNumber.ROUND_FLOOR);
  let newAsset = BigInt(newAssetBn.toFixed(0));
  if (newAsset <= 0n && origAsset > 0n) newAsset = 1n;

  const capped = {
    ...candidate,
    maxLiabAmount: newLiab,
    maxAssetAmount: newAsset,
  };
  const liabUi = new BigNumber(newLiab.toString()).dividedBy(new BigNumber(10).pow(md));
  const liabUsd = liabUi.multipliedBy(usdPerUi).toNumber();
  return { candidate: capped, cappedRepayUsd: liabUsd, applied: true };
}
