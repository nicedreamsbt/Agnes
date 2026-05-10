import { TransactionInstruction } from "@solana/web3.js";
import { JUP_LEND_PROGRAM_ID } from "../resolvers/juplend-derived.js";

/** Same bytes as P0 `makeUpdateJupLendRateIx`. */
const UPDATE_RATE_DISCRIMINATOR = Buffer.from([24, 225, 53, 189, 72, 212, 225, 178]);

/** @param {object} lendingState normalized `decodeJuplendLendingAccount` result */
export function makeUpdateJupLendRateIx(lendingState) {
  const keys = [
    { pubkey: lendingState.pubkey, isSigner: false, isWritable: true },
    { pubkey: lendingState.mint, isSigner: false, isWritable: false },
    { pubkey: lendingState.fTokenMint, isSigner: false, isWritable: false },
    { pubkey: lendingState.tokenReservesLiquidity, isSigner: false, isWritable: false },
    { pubkey: lendingState.rewardsRateModel, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({
    keys,
    programId: JUP_LEND_PROGRAM_ID,
    data: UPDATE_RATE_DISCRIMINATOR,
  });
}
