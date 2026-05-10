import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../../../vendor/eva01-idls");

/** @param {"kamino_lending.json"|"drift.json"|"juplend_earn.json"} name */
export function loadEva01IdlJson(name) {
  return JSON.parse(readFileSync(join(ROOT, name), "utf8"));
}
