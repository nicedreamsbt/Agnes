import "dotenv/config";
import { parseVenueList } from "./venues.js";

const DEFAULT_PROGRAM_ID = "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA";

export function loadConfig() {
  const required = ["RPC_URL", "GRPC_ENDPOINT"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  return {
    rpcUrl: process.env.RPC_URL,
    grpcEndpoint: process.env.GRPC_ENDPOINT,
    grpcToken: process.env.GRPC_X_TOKEN || undefined,
    marginfiEnvironment: process.env.MARGINFI_ENV || "production",
    marginfiProgramId: process.env.MARGINFI_PROGRAM_ID || DEFAULT_PROGRAM_ID,
    commitment: process.env.GRPC_COMMITMENT || "processed",
    accountAllowList: parsePubkeyList(process.env.MARGINFI_ACCOUNTS),
    refreshOraclesOnUpdate: parseBoolean(process.env.REFRESH_ORACLES_ON_UPDATE, true),
    marketRefreshMs: parseInteger(process.env.MARKET_REFRESH_MS, 60_000),
    venueAllowList: parseVenueList(process.env.VENUES),
    printBankCatalog: parseBoolean(process.env.PRINT_BANK_CATALOG, true),
  };
}

function parsePubkeyList(value) {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "y"].includes(value.toLowerCase());
}

function parseInteger(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
