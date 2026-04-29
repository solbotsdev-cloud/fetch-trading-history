import type { OpenLot, TradeRecord } from "./types.js";
import { isFullyExited } from "./groupTrades.js";

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function toIsoUtc(unixSeconds: number): string {
  // blockTime is unix seconds; render as second-precision ISO 8601 UTC ("Z").
  if (!Number.isFinite(unixSeconds)) return "";
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rem = s - m * 60;
    return `${m}m${rem}s`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s - h * 3600) / 60);
  return `${h}h${m}m`;
}

function formatPnlSol(pnl: number): string {
  const sign = pnl >= 0 ? "+" : "-";
  return `${sign}${Math.abs(pnl).toFixed(4)}`;
}

export function buildTradeRecords(lots: OpenLot[]): TradeRecord[] {
  // Sort lots by buy time ascending so tradeNumber is chronological.
  const sorted = [...lots].sort((a, b) => a.buyTime - b.buyTime);
  const records: TradeRecord[] = [];

  let tradeNumber = 1;
  for (const lot of sorted) {
    const fullyExited = isFullyExited(lot);

    // Sells sorted by delaySec ascending (already chronological because we
    // applied them in event order, but normalize for safety).
    const sellsSorted = [...lot.sells].sort((a, b) => a.delaySec - b.delaySec);

    const sellsOut = sellsSorted.map((s) => ({
      multiplier: round(s.multiplier, 2),
      pct: Math.round(s.rawPct),
      delaySec: Math.round(s.delaySec),
      time: toIsoUtc(s.sellTime),
    }));

    let exitTimeSec: number | null = null;
    let pnlSol: number | null = null;
    if (fullyExited && sellsSorted.length > 0) {
      exitTimeSec = Math.round(sellsSorted[sellsSorted.length - 1]!.delaySec);
      pnlSol = round(lot.totalSellSol - lot.buySol, 4);
    }

    const sequence = sellsOut.map((s) => s.pct);
    const firstMultiplier = sellsOut.length > 0 ? sellsOut[0]!.multiplier : null;
    const durationSec = fullyExited
      ? exitTimeSec
      : sellsOut.length > 0
        ? sellsOut[sellsOut.length - 1]!.delaySec
        : null;

    const raw = buildRawString({
      buySol: lot.buySol,
      sells: sellsOut,
      fullyExited,
      exitTimeSec,
      pnlSol,
    });

    records.push({
      tradeNumber: tradeNumber++,
      buy: {
        sol: round(lot.buySol, 4),
        tx: lot.buySignature,
        time: toIsoUtc(lot.buyTime),
      },
      sells: sellsOut,
      exit: {
        fullyExited,
        exitTimeSec,
        pnlSol,
      },
      pattern: {
        sequence,
        sellCount: sellsOut.length,
        firstMultiplier,
        durationSec,
      },
      raw,
    });
  }

  return records;
}

interface RawArgs {
  buySol: number;
  sells: Array<{ multiplier: number; pct: number; delaySec: number }>;
  fullyExited: boolean;
  exitTimeSec: number | null;
  pnlSol: number | null;
}

function buildRawString(args: RawArgs): string {
  const head = `buy(${args.buySol.toFixed(4)} SOL)`;
  const sellPart = args.sells
    .map((s) => `${s.multiplier.toFixed(2)}x@${formatPctForRaw(s.pct)}%@${formatDuration(s.delaySec)}`)
    .join(" → ");
  const trades = sellPart ? `${head} → ${sellPart}` : head;

  let tail: string;
  if (args.fullyExited && args.exitTimeSec != null && args.pnlSol != null) {
    tail = `(fully exited in ${formatDuration(args.exitTimeSec)}, pnl ${formatPnlSol(args.pnlSol)} SOL)`;
  } else {
    tail = `(not fully exited, pnl N/A SOL)`;
  }
  return `${trades}   ${tail}`;
}

function formatPctForRaw(pct: number): string {
  // Show integer if it rounds cleanly, otherwise one decimal.
  const rounded = Math.round(pct);
  if (Math.abs(pct - rounded) < 0.05) return String(rounded);
  return pct.toFixed(1);
}
