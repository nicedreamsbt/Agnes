import { BorshAccountsCoder } from "@coral-xyz/anchor";
import { AccountType } from "@0dotxyz/p0-ts-sdk";

/** @param {Buffer | Uint8Array | [string, string]} data */
function accountDataToBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (Array.isArray(data) && typeof data[0] === "string") return Buffer.from(data[0], data[1] || "base64");
  return Buffer.from(/** @type {Uint8Array} */ (data));
}

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

/**
 * Same filters as {@link getAllMarginfiAccountAddresses} but returns full account data (no dataSlice).
 * One RPC; may fail on large groups if the provider rejects oversized responses — callers should fall back to MGA.
 *
 * @param {import("@coral-xyz/anchor").Program} program
 * @param {import("@solana/web3.js").PublicKey} groupPk
 * @returns {Promise<{ pubkey: import("@solana/web3.js").PublicKey; data: Buffer }[]>}
 */
export async function getAllMarginfiAccountsFull(program, groupPk) {
  const coder = new BorshAccountsCoder(program.idl);
  const disc = coder.memcmp(AccountType.MarginfiAccount);
  const resp = await program.provider.connection.getProgramAccounts(program.programId, {
    commitment: program.provider.connection.commitment,
    filters: [
      { memcmp: { bytes: groupPk.toBase58(), offset: 8 } },
      { memcmp: { offset: disc.offset, bytes: disc.bytes } },
    ],
  });
  return resp.map((a) => ({
    pubkey: a.pubkey,
    data: accountDataToBuffer(a.account.data),
  }));
}
