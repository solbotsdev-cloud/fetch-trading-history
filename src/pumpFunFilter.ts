import type { FullTransaction } from "./types.js";

export interface PumpFunFilterOptions {
  pumpFunProgramIds: string[];
  pumpFunEventAuthority: string;
  pumpFunFeeRecipient: string;
}

export type FilterReason =
  | "noMeta"
  | "txError"
  | "noBlockTime"
  | "notPumpProgram"
  | "noPumpInstruction";

export interface FilterResult {
  isPumpFunTrade: boolean;
  reason?: FilterReason;
}

export function isPumpFunTradeTx(tx: FullTransaction, opts: PumpFunFilterOptions): FilterResult {
  if (!tx || !tx.meta) return { isPumpFunTrade: false, reason: "noMeta" };
  if (tx.meta.err) return { isPumpFunTrade: false, reason: "txError" };
  if (tx.blockTime == null) return { isPumpFunTrade: false, reason: "noBlockTime" };

  const accountKeys = extractAccountKeys(tx);
  const programSet = new Set(opts.pumpFunProgramIds);

  // Cheapest filter first: account keys must include at least one Pump.fun program.
  if (!accountKeys.some((k) => programSet.has(k))) {
    return { isPumpFunTrade: false, reason: "notPumpProgram" };
  }

  // Strict instruction check: at least one instruction (top-level or inner) must
  // execute one of the Pump.fun programs. This rules out tx that merely
  // *reference* a Pump.fun program in account keys via an unrelated CPI.
  if (!hasPumpFunInstruction(tx, accountKeys, programSet)) {
    return { isPumpFunTrade: false, reason: "noPumpInstruction" };
  }

  return { isPumpFunTrade: true };
}

export function extractAccountKeys(tx: FullTransaction): string[] {
  const raw = tx.transaction.message.accountKeys ?? [];
  const keys: string[] = [];
  for (const k of raw) {
    if (typeof k === "string") keys.push(k);
    else if (k && typeof k === "object" && typeof k.pubkey === "string") keys.push(k.pubkey);
  }
  const loaded = tx.meta?.loadedAddresses;
  if (loaded?.writable) keys.push(...loaded.writable);
  if (loaded?.readonly) keys.push(...loaded.readonly);
  return keys;
}

function hasPumpFunInstruction(
  tx: FullTransaction,
  accountKeys: string[],
  programIds: Set<string>,
): boolean {
  const matches = (ix: { programId?: string; programIdIndex?: number }): boolean => {
    if (typeof ix.programId === "string") return programIds.has(ix.programId);
    if (typeof ix.programIdIndex === "number") {
      const id = accountKeys[ix.programIdIndex];
      return id !== undefined && programIds.has(id);
    }
    return false;
  };

  for (const ix of tx.transaction.message.instructions ?? []) {
    if (matches(ix)) return true;
  }
  const inner = tx.meta?.innerInstructions ?? [];
  for (const group of inner as Array<{ instructions?: Array<{ programId?: string; programIdIndex?: number }> }>) {
    for (const ix of group.instructions ?? []) {
      if (matches(ix)) return true;
    }
  }
  return false;
}
