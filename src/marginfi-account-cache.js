import fs from "node:fs/promises";
import path from "node:path";

export const MARGINFI_ACCOUNT_CACHE_VERSION = 1;

/**
 * @param {string} filePath
 * @param {{ programId: string; groupPk: string }} expected
 * @returns {Promise<{ ok: true; accounts: Map<string, Buffer>; savedAt?: string } | { ok: false; reason: string }>}
 */
export async function readMarginfiAccountCache(filePath, { programId, groupPk }) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") {
      return { ok: false, reason: "missing" };
    }
    return { ok: false, reason: String(/** @type {Error} */ (e).message || e) };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (parsed.version !== MARGINFI_ACCOUNT_CACHE_VERSION) {
    return { ok: false, reason: `version_${parsed.version}` };
  }
  if (parsed.programId !== programId || parsed.groupPk !== groupPk) {
    return { ok: false, reason: "program_or_group_mismatch" };
  }
  const accounts = new Map();
  for (const [k, b64] of Object.entries(parsed.accounts || {})) {
    if (typeof b64 !== "string") continue;
    accounts.set(k, Buffer.from(b64, "base64"));
  }
  return { ok: true, accounts, savedAt: parsed.savedAt };
}

/**
 * @param {string} filePath
 * @param {{ programId: string; groupPk: string; accountRawByKey: Map<string, Buffer> }} body
 */
export async function writeMarginfiAccountCache(filePath, { programId, groupPk, accountRawByKey }) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  /** @type {Record<string, string>} */
  const accounts = {};
  for (const [k, buf] of accountRawByKey) {
    accounts[k] = Buffer.from(buf).toString("base64");
  }
  const payload = JSON.stringify({
    version: MARGINFI_ACCOUNT_CACHE_VERSION,
    programId,
    groupPk,
    savedAt: new Date().toISOString(),
    accounts,
  });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, payload, "utf8");
  await fs.rename(tmp, filePath);
}
