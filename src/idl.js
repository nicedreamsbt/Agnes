import { createHash } from "node:crypto";

const ACCOUNT_NAMES = [
  "Bank",
  "MarginfiAccount",
  "MarginfiGroup",
  "LendingPool",
  "OracleSetup",
  "StakedSettings",
  "FeeState",
  "Emissions",
];

const DISCRIMINATORS = new Map(
  ACCOUNT_NAMES.flatMap((name) => [
    [anchorDiscriminator(name), name],
    [anchorDiscriminator(lowerFirst(name)), name],
  ])
);

export function identifyMarginfiAccount(data) {
  if (!data || data.length < 8) return { type: "too_small", discriminator: "" };
  const discriminator = Buffer.from(data.subarray(0, 8)).toString("hex");
  return {
    type: DISCRIMINATORS.get(discriminator) || "unknown",
    discriminator,
  };
}

export function isMarginfiAccountType(accountInfo, ...types) {
  const { type } = identifyMarginfiAccount(accountInfo);
  return types.includes(type);
}

function anchorDiscriminator(accountName) {
  return createHash("sha256").update(`account:${accountName}`).digest().subarray(0, 8).toString("hex");
}

function lowerFirst(value) {
  return value.charAt(0).toLowerCase() + value.slice(1);
}
