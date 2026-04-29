import { createHash } from "node:crypto";
import type {
  FullTransaction,
  ParsedTradeEvent,
  TokenBalance,
  TransactionMeta,
} from "./types.js";
import { extractAccountKeys } from "./pumpFunFilter.js";

const LAMPORTS_PER_SOL = 1_000_000_000;
const WSOL_MINT = "So11111111111111111111111111111111111111112";

// Anchor event discriminator = first 8 bytes of sha256("event:<EventName>").
// Pump.fun bonding curve emits "TradeEvent" via emit_cpi!. The base64 of these
// events shows up in tx.meta.logMessages as "Program data: <base64>" lines.
// Layout (after 8-byte discriminator, all little-endian):
//   mint: Pubkey (32)
//   sol_amount: u64 (8)        ← the canonical swap-only SOL amount
//   token_amount: u64 (8)
//   is_buy: bool (1)
//   user: Pubkey (32)
//   timestamp: i64 (8)
//   ... reserves (varies; we only read up to is_buy)
function eventDisc(name: string): Buffer {
  return createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
}
const PUMP_TRADE_EVENT_DISC = eventDisc("TradeEvent");
const PUMP_TRADE_EVENT_MIN_LEN = 8 + 32 + 8 + 8 + 1; // up to is_buy

// PumpSwap AMM events. Both BuyEvent and SellEvent share an identical 7-u64
// prefix after timestamp:
//   timestamp(i64) | base_amount(u64) | min_or_max_quote(u64)
//   user_base_reserves(u64) | user_quote_reserves(u64)
//   pool_base_reserves(u64) | pool_quote_reserves(u64)
//   quote_amount_in/out(u64)   ← canonical pool-side swap amount, offset 64
//   ... (lp_fee, protocol_fee, etc., not needed)
const PUMP_AMM_BUY_EVENT_DISC = eventDisc("BuyEvent");
const PUMP_AMM_SELL_EVENT_DISC = eventDisc("SellEvent");
const PUMP_AMM_EVENT_QUOTE_OFFSET = 8 + 8 * 7; // 64
const PUMP_AMM_EVENT_MIN_LEN = PUMP_AMM_EVENT_QUOTE_OFFSET + 8;

// Approximate rent for a fresh SPL token account (ATA). The exact value depends
// on rent params, but ~0.00203928 SOL is the long-standing minimum-balance for
// a 165-byte token account on mainnet. We subtract this from BUY SOL when we
// detect a token account was created in this tx.
const ATA_RENT_LAMPORTS = 2_039_280;

export interface ParseOptions {
  targetWallet: string;
  minSolChange: number;
  minTokenChange: number;
}

export type ParseSkipReason = "noTradeFound" | "ambiguousMints";

export interface ParseResult {
  events: ParsedTradeEvent[];
  reason?: ParseSkipReason;
}

/**
 * Parse Pump.fun BUY/SELL events from a transaction that has ALREADY been
 * validated as a Pump.fun trade tx by the filter. Returns events keyed by mint.
 */
export function parsePumpFunTrade(
  tx: FullTransaction,
  signature: string,
  opts: ParseOptions,
): ParseResult {
  const meta = tx.meta!; // filter guaranteed non-null
  const blockTime = tx.blockTime!;
  const accountKeys = extractAccountKeys(tx);

  const targetIndex = accountKeys.indexOf(opts.targetWallet);
  if (targetIndex < 0) return { events: [], reason: "noTradeFound" };

  // Raw lamports delta for target wallet, with fee added back if target paid it.
  const pre = meta.preBalances[targetIndex] ?? 0;
  const post = meta.postBalances[targetIndex] ?? 0;
  let lamportsDelta = post - pre;
  if (targetIndex === 0) lamportsDelta += meta.fee;

  // Token deltas per mint for target-wallet-owned token accounts only.
  const tokenDeltas = computeTokenDeltas(meta.preTokenBalances, meta.postTokenBalances, opts.targetWallet);
  if (tokenDeltas.size === 0) return { events: [], reason: "noTradeFound" };

  // Detect ATA creation: if the target wallet now owns a token account that did
  // not exist pre-tx, an ATA was likely created and lamports went to rent.
  const ataCreated = countNewlyOwnedTokenAccounts(meta.preTokenBalances, meta.postTokenBalances, opts.targetWallet);
  const ataRentLamports = ataCreated * ATA_RENT_LAMPORTS;

  // Canonical swap SOL from the Pump.fun program's own emitted TradeEvent.
  // When present, this is the exact SOL the bonding curve charged/paid for the
  // swap, excluding protocol/creator fees, Jito tips, priority fees, and rent.
  const tradeEvent = decodePumpTradeEvent(meta);

  const events: ParsedTradeEvent[] = [];

  // Trades on Pump.fun are single-mint per tx in practice. If multiple non-WSOL
  // mints changed, we keep the largest absolute delta and discard the rest as
  // noise (e.g. fee-token routing). This is the strict interpretation of
  // "exactly one non-SOL token mint should have significant target-wallet
  // balance change".
  const candidateMints = [...tokenDeltas.entries()].filter(
    ([mint, delta]) => mint !== WSOL_MINT && Math.abs(delta) >= opts.minTokenChange,
  );
  if (candidateMints.length === 0) return { events: [], reason: "noTradeFound" };

  candidateMints.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const [mint, tokenDelta] = candidateMints[0]!;

  if (tokenDelta > 0) {
    // BUY: prefer the program's emitted swap-only sol amount (TradeEvent for
    // bonding curve, BuyEvent for AMM). Sanity-check against user outflow:
    // the swap amount can never exceed what actually left the wallet (minus
    // ATA rent), since fees/tips/rent are all on top of it. If decoded looks
    // implausible (offset drift / unknown layout), fall back to the heuristic.
    const actualOutflowLamports = Math.max(0, -lamportsDelta - ataRentLamports);
    let buySol: number;
    if (
      tradeEvent &&
      tradeEvent.isBuy &&
      tradeEvent.solLamports > 0 &&
      tradeEvent.solLamports <= actualOutflowLamports
    ) {
      buySol = tradeEvent.solLamports / LAMPORTS_PER_SOL;
    } else {
      if (actualOutflowLamports <= 0) return { events: [], reason: "noTradeFound" };
      buySol = actualOutflowLamports / LAMPORTS_PER_SOL;
    }
    if (buySol < opts.minSolChange) return { events: [], reason: "noTradeFound" };

    events.push({
      type: "BUY",
      signature,
      blockTime,
      mint,
      solAmount: buySol,
      tokenAmount: tokenDelta,
    });
  } else if (tokenDelta < 0) {
    // SELL: gross pool-side amount (decoded) is always ≥ user inflow, since
    // fees come out of it before crediting the user. If decoded violates that,
    // fall back to user inflow.
    const actualInflowLamports = Math.max(0, lamportsDelta);
    let sellSol: number;
    if (
      tradeEvent &&
      !tradeEvent.isBuy &&
      tradeEvent.solLamports >= actualInflowLamports
    ) {
      sellSol = tradeEvent.solLamports / LAMPORTS_PER_SOL;
    } else {
      if (actualInflowLamports <= 0) return { events: [], reason: "noTradeFound" };
      sellSol = actualInflowLamports / LAMPORTS_PER_SOL;
    }
    if (sellSol < opts.minSolChange) return { events: [], reason: "noTradeFound" };

    events.push({
      type: "SELL",
      signature,
      blockTime,
      mint,
      solAmount: sellSol,
      tokenAmount: Math.abs(tokenDelta),
    });
  } else {
    return { events: [], reason: "noTradeFound" };
  }

  return { events };
}

interface DecodedTradeEvent {
  solLamports: number;
  tokenAmountRaw: number;
  isBuy: boolean;
}

function decodePumpTradeEvent(meta: TransactionMeta): DecodedTradeEvent | null {
  const logs = meta.logMessages ?? [];
  const PREFIX = "Program data: ";
  for (const log of logs) {
    if (!log.startsWith(PREFIX)) continue;
    const b64 = log.slice(PREFIX.length).trim();
    if (!b64) continue;
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, "base64");
    } catch {
      continue;
    }
    if (buf.length < 8) continue;
    const disc = buf.subarray(0, 8);

    // Bonding curve: TradeEvent
    if (disc.equals(PUMP_TRADE_EVENT_DISC) && buf.length >= PUMP_TRADE_EVENT_MIN_LEN) {
      // Layout: disc(8) | mint(32) | sol_amount(u64) | token_amount(u64) | is_buy(1)
      const solLamports = Number(buf.readBigUInt64LE(40));
      const tokenAmountRaw = Number(buf.readBigUInt64LE(48));
      const isBuy = buf[56] === 1;
      return { solLamports, tokenAmountRaw, isBuy };
    }

    // PumpSwap AMM: BuyEvent / SellEvent
    if (disc.equals(PUMP_AMM_BUY_EVENT_DISC) && buf.length >= PUMP_AMM_EVENT_MIN_LEN) {
      const solLamports = Number(buf.readBigUInt64LE(PUMP_AMM_EVENT_QUOTE_OFFSET));
      const tokenAmountRaw = Number(buf.readBigUInt64LE(8 + 8)); // base_amount_out
      return { solLamports, tokenAmountRaw, isBuy: true };
    }
    if (disc.equals(PUMP_AMM_SELL_EVENT_DISC) && buf.length >= PUMP_AMM_EVENT_MIN_LEN) {
      const solLamports = Number(buf.readBigUInt64LE(PUMP_AMM_EVENT_QUOTE_OFFSET));
      const tokenAmountRaw = Number(buf.readBigUInt64LE(8 + 8)); // base_amount_in
      return { solLamports, tokenAmountRaw, isBuy: false };
    }
  }
  return null;
}

function computeTokenDeltas(
  preList: TokenBalance[] | undefined,
  postList: TokenBalance[] | undefined,
  owner: string,
): Map<string, number> {
  const preByMint = new Map<string, number>();
  const postByMint = new Map<string, number>();

  for (const b of preList ?? []) {
    if (!b || b.owner !== owner) continue;
    const amt = readUiAmount(b);
    if (amt == null) continue;
    preByMint.set(b.mint, (preByMint.get(b.mint) ?? 0) + amt);
  }
  for (const b of postList ?? []) {
    if (!b || b.owner !== owner) continue;
    const amt = readUiAmount(b);
    if (amt == null) continue;
    postByMint.set(b.mint, (postByMint.get(b.mint) ?? 0) + amt);
  }

  const mints = new Set<string>([...preByMint.keys(), ...postByMint.keys()]);
  const deltas = new Map<string, number>();
  for (const mint of mints) {
    const delta = (postByMint.get(mint) ?? 0) - (preByMint.get(mint) ?? 0);
    if (delta !== 0) deltas.set(mint, delta);
  }
  return deltas;
}

function countNewlyOwnedTokenAccounts(
  preList: TokenBalance[] | undefined,
  postList: TokenBalance[] | undefined,
  owner: string,
): number {
  const preAccounts = new Set<number>();
  for (const b of preList ?? []) {
    if (b && b.owner === owner) preAccounts.add(b.accountIndex);
  }
  let count = 0;
  for (const b of postList ?? []) {
    if (!b || b.owner !== owner) continue;
    if (!preAccounts.has(b.accountIndex)) count++;
  }
  return count;
}

function readUiAmount(b: TokenBalance): number | null {
  const ui = b.uiTokenAmount;
  if (!ui) return null;
  if (typeof ui.uiAmount === "number" && Number.isFinite(ui.uiAmount)) return ui.uiAmount;
  if (typeof ui.uiAmountString === "string" && ui.uiAmountString.length > 0) {
    const n = Number(ui.uiAmountString);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof ui.amount === "string" && typeof ui.decimals === "number") {
    const raw = Number(ui.amount);
    if (!Number.isFinite(raw)) return null;
    return raw / Math.pow(10, ui.decimals);
  }
  return null;
}
