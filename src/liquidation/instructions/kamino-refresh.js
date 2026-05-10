import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { loadEva01IdlJson } from "../idl/eva01-idl.js";
import { getKaminoOracleSetup } from "../resolvers/kamino-reserve.js";
import { KAMINO_LENDING_PROGRAM_ID } from "../pdas/kamino.js";

const KAMINO_IDL = loadEva01IdlJson("kamino_lending.json");

const NULLISH = new PublicKey("nu11111111111111111111111111111111111111111");

function optionalOracle(pk) {
  if (!pk) return null;
  if (pk.equals(PublicKey.default)) return null;
  if (pk.equals(NULLISH)) return null;
  return pk;
}

function noopWallet() {
  return new Wallet(Keypair.generate());
}

/**
 * @param {import("@solana/web3.js").Connection} connection
 */
export function createKaminoLendingProgram(connection) {
  const idl = {
    ...KAMINO_IDL,
    address: KAMINO_LENDING_PROGRAM_ID.toBase58(),
  };
  const provider = new AnchorProvider(connection, noopWallet(), AnchorProvider.defaultOptions());
  return new Program(idl, provider);
}

/**
 * @param {import("@coral-xyz/anchor").Program} kaminoProgram
 * @param {PublicKey} reservePk
 * @param {{ lendingMarket: PublicKey, raw: object }} reserveLayout
 */
export async function makeRefreshKaminoReserveIx(kaminoProgram, reservePk, reserveLayout) {
  const oracles = getKaminoOracleSetup(reserveLayout.raw);
  return kaminoProgram.methods
    .refreshReserve()
    .accounts({
      reserve: reservePk,
      lendingMarket: reserveLayout.lendingMarket,
      pythOracle: optionalOracle(oracles.pythOracle),
      switchboardPriceOracle: optionalOracle(oracles.switchboardPriceOracle),
      switchboardTwapOracle: optionalOracle(oracles.switchboardTwapOracle),
      scopePrices: optionalOracle(oracles.scopePrices),
    })
    .instruction();
}

/** P0-style obligation refresh: 8-byte discriminator only, reserve appended as remaining. */
const REFRESH_OBLIGATION_DISCRIMINATOR = Buffer.from([33, 132, 147, 228, 151, 192, 72, 89]);

/**
 * @param {PublicKey} lendingMarket
 * @param {PublicKey} obligation
 * @param {PublicKey} reservePk
 */
export function makeRefreshKaminoObligationIx(lendingMarket, obligation, reservePk) {
  const keys = [
    { pubkey: lendingMarket, isSigner: false, isWritable: false },
    { pubkey: obligation, isSigner: false, isWritable: true },
    { pubkey: reservePk, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({
    keys,
    programId: KAMINO_LENDING_PROGRAM_ID,
    data: REFRESH_OBLIGATION_DISCRIMINATOR,
  });
}
