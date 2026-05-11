import fs from "node:fs";
import { Keypair } from "@solana/web3.js";

export function loadKeypairFromJsonPath(path) {
  const raw = fs.readFileSync(path, "utf8");
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error("Keypair JSON must be a number array");
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}
