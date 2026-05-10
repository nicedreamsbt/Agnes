import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { AccountType } from "@0dotxyz/p0-ts-sdk";

/**
 * All marginfi user accounts in the group (same GPA shape as legacy marginfi client).
 */
export async function getAllMarginfiAccountAddresses(program, groupPk) {
  const coder = new BorshAccountsCoder(program.idl);
  const disc = coder.memcmp(AccountType.MarginfiAccount);
  const resp = await program.provider.connection.getProgramAccounts(program.programId, {
    commitment: program.provider.connection.commitment,
    dataSlice: { offset: 0, length: 0 },
    filters: [
      { memcmp: { bytes: groupPk.toBase58(), offset: 8 } },
      { memcmp: { offset: disc.offset, bytes: disc.bytes } },
    ],
  });
  return resp.map((a) => a.pubkey);
}
