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
  if (rateLimitPerKey <= 0 || rateLimitPerKey > 10) {
    throw new Error(`RATE_LIMIT_PER_KEY must be in (0, 10], got ${rateLimitPerKey}`);
  }

  const outputFile = (process.env.OUTPUT_FILE ?? "data/trades.json").trim();
  const resolvedOutput = path.isAbsolute(outputFile) ? outputFile : path.resolve(process.cwd(), outputFile);

  const pumpProgramIds = parseList(process.env.PUMP_PROGRAM_IDS);
  const minSolChange = parseNumber(process.env.MIN_SOL_CHANGE, 0.000001, "MIN_SOL_CHANGE");
  const minTokenChange = parseNumber(process.env.MIN_TOKEN_CHANGE, 1, "MIN_TOKEN_CHANGE");

  return {
    targetWallet,
    hoursBack,
    heliusApiKeys,
    rateLimitPerKey,
    outputFile: resolvedOutput,
    pumpProgramIds,
    minSolChange,
    minTokenChange,
  };
}
