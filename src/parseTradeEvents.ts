import type {
  FullTransaction,
  ParsedTradeEvent,
  TokenBalance,
} from "./types.js";

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface ParseOptions {
  targetWallet: string;
  pumpProgramIds: string[];
  minSolChange: number;
  minTokenChange: number;
}

export interface ParseStats {
  parsed: number;
  skippedNoMeta: number;
  skippedNoTime: number;
  skippedNotPump: number;
  skippedNoTrade: number;
  errors: number;
}

/**
 * Inspect a single transaction and extract zero or more BUY/SELL events
 * from the perspective of the target wallet.
 *
 * Logic:
 *  - Compute SOL delta for the target wallet account from pre/post balances.
 *  - Compute per-mint token deltas for the target wallet from pre/post token balances.
 *  - SOL decrease + token increase => BUY for that mint.
 *  - Token decrease + SOL increase => SELL for that mint.
 *  - If SOL changes but token deltas are empty (pure transfer), skip.
 */
export function parseTradeEventsFromTx(
  tx: FullTransaction,
  signature: string,
  opts: ParseOptions,
): { events: ParsedTradeEvent[]; reason?: keyof ParseStats } {
  if (!tx || !tx.meta) return { events: [], reason: "skippedNoMeta" };
  if (tx.meta.err) return { events: [], reason: "skippedNoTrade" }; // failed tx
  if (tx.blockTime == null) return { events: [], reason: "skippedNoTime" };

  const accountKeys = extractAccountKeys(tx);
  const targetIndex = accountKeys.indexOf(opts.targetWallet);
  if (targetIndex < 0) {
    // Wallet was referenced indirectly (e.g. token account owner) but not in account keys.
    // We can still inspect token balances, but SOL deltas won't be computable.
    // Pump.fun trades always include the wallet in the account keys, so skip.
    return { events: [], reason: "skippedNoTrade" };
  }

  if (opts.pumpProgramIds.length > 0) {
    const programs = collectProgramIds(tx, accountKeys);
    const matchesPump = opts.pumpProgramIds.some((id) => programs.has(id));
    if (!matchesPump) return { events: [], reason: "skippedNotPump" };
  }

  // SOL delta for target wallet (lamports), corrected for fee if target is fee payer.
  const pre = tx.meta.preBalances[targetIndex] ?? 0;
  const post = tx.meta.postBalances[targetIndex] ?? 0;
  let lamportsDelta = post - pre;
  if (targetIndex === 0) {
    // Fee payer: post-balance already deducted the fee. Add it back so the delta
    // reflects only the trade-related transfer.
    lamportsDelta += tx.meta.fee;
  }
  const solDelta = lamportsDelta / LAMPORTS_PER_SOL;

  // Token deltas per mint for target wallet.
  const tokenDeltas = computeTokenDeltas(tx.meta.preTokenBalances, tx.meta.postTokenBalances, opts.targetWallet);
  if (tokenDeltas.size === 0) {
    return { events: [], reason: "skippedNoTrade" };
  }

  const events: ParsedTradeEvent[] = [];
  const blockTime = tx.blockTime;

  for (const [mint, tokenDelta] of tokenDeltas) {
    if (Math.abs(tokenDelta) < opts.minTokenChange) continue;

    if (tokenDelta > 0 && solDelta < -opts.minSolChange) {
      events.push({
        type: "BUY",
        signature,
        blockTime,
        mint,
        solAmount: Math.abs(solDelta),
        tokenAmount: tokenDelta,
      });
    } else if (tokenDelta < 0 && solDelta > opts.minSolChange) {
      events.push({
        type: "SELL",
        signature,
        blockTime,
        mint,
        solAmount: solDelta,
        tokenAmount: Math.abs(tokenDelta),
      });
    }
  }

  if (events.length === 0) {
    return { events: [], reason: "skippedNoTrade" };
  }

  // If multiple mints traded in one tx (rare on pump), the solDelta would be
  // shared across them. Normalize the SOL portion proportionally to token notional
  // so the per-trade SOL is sensible.
  if (events.length > 1) {
    const totalAbsSol = events.reduce((acc, e) => acc + e.solAmount, 0);
    const fullSol = Math.abs(solDelta);
    if (totalAbsSol > 0 && Math.abs(totalAbsSol - fullSol) > 1e-9) {
      for (const e of events) {
        e.solAmount = (e.solAmount / totalAbsSol) * fullSol;
      }
    }
  }

  return { events };
}

function extractAccountKeys(tx: FullTransaction): string[] {
  const raw = tx.transaction.message.accountKeys ?? [];
  const keys: string[] = [];
  for (const k of raw) {
    if (typeof k === "string") keys.push(k);
    else if (k && typeof k === "object" && typeof k.pubkey === "string") keys.push(k.pubkey);
  }
  // Append loaded addresses (v0 transactions with address lookup tables).
  const loaded = tx.meta?.loadedAddresses;
  if (loaded?.writable) keys.push(...loaded.writable);
  if (loaded?.readonly) keys.push(...loaded.readonly);
  return keys;
}

function collectProgramIds(tx: FullTransaction, accountKeys: string[]): Set<string> {
  const set = new Set<string>();
  // Top-level program IDs from instructions.
  const ixs = tx.transaction.message.instructions ?? [];
  for (const ix of ixs) {
    if (typeof ix.programId === "string") set.add(ix.programId);
    else if (typeof ix.programIdIndex === "number") {
      const id = accountKeys[ix.programIdIndex];
      if (id) set.add(id);
    }
  }
  // Inner instructions (parsed or raw).
  const inner = tx.meta?.innerInstructions ?? [];
  for (const group of inner as Array<{ instructions?: Array<{ programId?: string; programIdIndex?: number }> }>) {
    for (const ix of group.instructions ?? []) {
      if (typeof ix.programId === "string") set.add(ix.programId);
      else if (typeof ix.programIdIndex === "number") {
        const id = accountKeys[ix.programIdIndex];
        if (id) set.add(id);
      }
    }
  }
  return set;
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
