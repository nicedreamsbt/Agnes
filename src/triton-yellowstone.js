import { createRequire } from "node:module";

/** Load Triton Yellowstone via CommonJS — the published ESM entry uses `.js` without `type: module`, which breaks Node named imports. */
const require = createRequire(import.meta.url);
const mod = require("@triton-one/yellowstone-grpc");

export const CommitmentLevel = mod.CommitmentLevel;
export default mod.default;
