import "dotenv/config";
import path from "node:path";
import type { AppConfig } from "./types.js";

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function parseNumber(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid number for ${label}: "${raw}"`);
  }
  return n;
}

const SOLANA_BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function loadConfig(): AppConfig {
  const targetWallet = (process.env.TARGET_WALLET ?? "").trim();
  if (!targetWallet) {
    throw new Error("TARGET_WALLET is required (set it in .env)");
  }
  if (!SOLANA_BASE58_RE.test(targetWallet)) {
    throw new Error(`TARGET_WALLET does not look like a base58 Solana address: ${targetWallet}`);
  }

  const heliusApiKeys = parseList(process.env.HELIUS_API_KEYS);
  if (heliusApiKeys.length === 0) {
    throw new Error("HELIUS_API_KEYS is required (provide at least one Helius API key)");
  }

  const hoursBack = parseNumber(process.env.HOURS_BACK, 24, "HOURS_BACK");
  if (hoursBack <= 0) {
    throw new Error(`HOURS_BACK must be positive, got ${hoursBack}`);
  }

  const rateLimitPerKey = parseNumber(process.env.RATE_LIMIT_PER_KEY, 8, "RATE_LIMIT_PER_KEY");
  if (rateLimitPerKey <= 0 || rateLimitPerKey > 100) {
    throw new Error(`RATE_LIMIT_PER_KEY must be in (0, 100], got ${rateLimitPerKey}`);
  }

  const outputFile = (process.env.OUTPUT_FILE ?? "data/trades.json").trim();
  const resolvedOutput = path.isAbsolute(outputFile) ? outputFile : path.resolve(process.cwd(), outputFile);

  const checkpointFile = (process.env.EVENTS_CHECKPOINT_FILE ?? "data/events.jsonl").trim();
  const resolvedCheckpoint = path.isAbsolute(checkpointFile)
    ? checkpointFile
    : path.resolve(process.cwd(), checkpointFile);

  const writeIntervalSec = parseNumber(process.env.WRITE_INTERVAL_SEC, 3600, "WRITE_INTERVAL_SEC");
  if (writeIntervalSec <= 0) {
    throw new Error(`WRITE_INTERVAL_SEC must be positive, got ${writeIntervalSec}`);
  }

  const txChunkSize = parseNumber(process.env.TX_CHUNK_SIZE, 1000, "TX_CHUNK_SIZE");
  if (!Number.isInteger(txChunkSize) || txChunkSize < 50) {
    throw new Error(`TX_CHUNK_SIZE must be an integer >= 50, got ${txChunkSize}`);
  }

  const userProgramIds = parseList(process.env.PUMP_FUN_PROGRAM_ID);
  // Defaults cover the active Pump.fun program family:
  //   - legacy bonding curve (older tx)
  //   - current bonding curve (post-migration, what most live trades execute)
  //   - PumpSwap AMM (graduated tokens)
  // Users may override via env (comma-separated list).
  const pumpFunProgramIds =
    userProgramIds.length > 0
      ? userProgramIds
      : [
          "6EF8rrecthR5DkXPBu7q1yUPQsFEe1J7a6A9fPpump",
          "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
          "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
        ];
  const pumpFunEventAuthority =
    (process.env.PUMP_FUN_EVENT_AUTHORITY ?? "").trim() || "Ce6TQqeHCWjNFyMS3kH2vQU3J9gnMMtDU4LiwYfPUEA";
  const pumpFunFeeRecipient =
    (process.env.PUMP_FUN_FEE_RECIPIENT ?? "").trim() || "G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP";

  const minSolChange = parseNumber(process.env.MIN_SOL_CHANGE, 0.000001, "MIN_SOL_CHANGE");
  const minTokenChange = parseNumber(process.env.MIN_TOKEN_CHANGE, 0.000001, "MIN_TOKEN_CHANGE");

  return {
    targetWallet,
    hoursBack,
    heliusApiKeys,
    rateLimitPerKey,
    outputFile: resolvedOutput,
    eventsCheckpointFile: resolvedCheckpoint,
    writeIntervalSec,
    txChunkSize,
    pumpFunProgramIds,
    pumpFunEventAuthority,
    pumpFunFeeRecipient,
    minSolChange,
    minTokenChange,
  };
}
