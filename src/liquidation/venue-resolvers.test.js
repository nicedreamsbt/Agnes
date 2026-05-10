import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { makeRefreshKaminoObligationIx } from "./instructions/kamino-refresh.js";
import { KAMINO_LENDING_PROGRAM_ID } from "./pdas/kamino.js";
import {
  makeDriftRefreshSpotMarketIx,
  UPDATE_SPOT_MARKET_CUMULATIVE_INTEREST_DISCRIMINATOR,
  DRIFT_PROGRAM_ID,
} from "./pdas/drift.js";
import { makeUpdateJupLendRateIx } from "./instructions/juplend-update-rate.js";
import { JUP_LEND_PROGRAM_ID } from "./resolvers/juplend-derived.js";
import { getKaminoOracleSetup } from "./resolvers/kamino-reserve.js";
import { deriveKaminoLendingMarketAuthority } from "./pdas/kamino.js";

test("Kamino refresh_obligation ix: program, discriminator length, reserve remaining", () => {
  const lm = Keypair.generate().publicKey;
  const ob = Keypair.generate().publicKey;
  const res = Keypair.generate().publicKey;
  const ix = makeRefreshKaminoObligationIx(lm, ob, res);
  assert(ix.programId.equals(KAMINO_LENDING_PROGRAM_ID));
  assert.equal(ix.data.length, 8);
  assert.equal(ix.keys.length, 3);
  assert(ix.keys[2].pubkey.equals(res));
  assert.equal(ix.keys[2].isWritable, false);
});

test("Drift update spot market cumulative interest ix shape", () => {
  const spotPk = Keypair.generate().publicKey;
  const oracle = Keypair.generate().publicKey;
  const vault = Keypair.generate().publicKey;
  const ix = makeDriftRefreshSpotMarketIx(
    { oracle, marketIndex: 1, pubkey: spotPk, mint: Keypair.generate().publicKey, vault },
    spotPk,
  );
  assert(ix.programId.equals(DRIFT_PROGRAM_ID));
  assert.deepEqual(Buffer.from(ix.data), UPDATE_SPOT_MARKET_CUMULATIVE_INTEREST_DISCRIMINATOR);
  assert.equal(ix.keys.length, 4);
});

test("JupLend update rate ix targets earn program", () => {
  const lending = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const fToken = Keypair.generate().publicKey;
  const reservesLiq = Keypair.generate().publicKey;
  const rewardsModel = Keypair.generate().publicKey;
  const ix = makeUpdateJupLendRateIx({
    pubkey: lending,
    mint,
    fTokenMint: fToken,
    tokenReservesLiquidity: reservesLiq,
    rewardsRateModel: rewardsModel,
  });
  assert(ix.programId.equals(JUP_LEND_PROGRAM_ID));
  assert.equal(ix.data.length, 8);
  assert.equal(ix.keys.length, 5);
  assert(ix.keys[0].isWritable);
});

test("getKaminoOracleSetup filters default pubkeys", () => {
  const pyth = Keypair.generate().publicKey;
  const setup = getKaminoOracleSetup({
    config: {
      tokenInfo: {
        pythConfiguration: { price: pyth },
        switchboardConfiguration: {
          priceAggregator: PublicKey.default,
          twapAggregator: PublicKey.default,
        },
        scopeConfiguration: { priceFeed: PublicKey.default },
      },
    },
  });
  assert(setup.pythOracle.equals(pyth));
  assert.equal(setup.switchboardPriceOracle, null);
});

test("deriveKaminoLendingMarketAuthority is stable", () => {
  const lm = Keypair.generate().publicKey;
  const [a] = deriveKaminoLendingMarketAuthority(lm);
  const [b] = deriveKaminoLendingMarketAuthority(lm);
  assert.equal(a.toBase58(), b.toBase58());
});
