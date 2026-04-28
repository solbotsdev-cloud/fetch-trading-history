import type { OpenLot, ParsedTradeEvent } from "./types.js";

export const FULLY_EXITED_TOLERANCE = 0.005; // 0.5% dust tolerance

/**
 * Apply parsed trade events (sorted ascending by blockTime) to a FIFO ledger
 * per mint, producing closed/open buy lots. Each lot can have multiple sells.
 *
 * Sells split across multiple open lots proportionally if a single sell tx
 * covers more tokens than the earliest lot has remaining.
 */
export function groupTrades(events: ParsedTradeEvent[]): OpenLot[] {
  const byMint = new Map<string, OpenLot[]>();
  const allLots: OpenLot[] = [];

  // Stable sort: ascending by blockTime, then by event order. We assume the input
  // is already chronologically sorted (caller responsibility) but normalize anyway.
  const sorted = [...events].sort((a, b) => a.blockTime - b.blockTime);

  for (const ev of sorted) {
    if (ev.type === "BUY") {
      const lot: OpenLot = {
        mint: ev.mint,
        buySignature: ev.signature,
        buyTime: ev.blockTime,
        buySol: ev.solAmount,
        originalTokenAmount: ev.tokenAmount,
        remainingTokenAmount: ev.tokenAmount,
        buyUnitPrice: ev.tokenAmount > 0 ? ev.solAmount / ev.tokenAmount : 0,
        totalSellSol: 0,
        sells: [],
      };
      const queue = byMint.get(ev.mint) ?? [];
      queue.push(lot);
      byMint.set(ev.mint, queue);
      allLots.push(lot);
      continue;
    }

    // SELL
    const queue = byMint.get(ev.mint);
    if (!queue || queue.length === 0) {
      // No open lot for this mint — probably a sell of tokens bought before our
      // time window. Skip it.
      continue;
    }

    let tokensRemainingToSell = ev.tokenAmount;
    let solRemainingToDistribute = ev.solAmount;
    const totalSellTokens = ev.tokenAmount;

    while (tokensRemainingToSell > 0 && queue.length > 0) {
      const lot = queue[0]!;
      if (lot.remainingTokenAmount <= 0) {
        queue.shift();
        continue;
      }

      const tokenSoldFromThisLot = Math.min(lot.remainingTokenAmount, tokensRemainingToSell);
      // Allocate SOL pro-rata to token share of the sell event.
      const solReceivedForThisLotPiece =
        totalSellTokens > 0 ? ev.solAmount * (tokenSoldFromThisLot / totalSellTokens) : 0;

      const sellUnitPrice = tokenSoldFromThisLot > 0 ? solReceivedForThisLotPiece / tokenSoldFromThisLot : 0;
      const multiplier = lot.buyUnitPrice > 0 ? sellUnitPrice / lot.buyUnitPrice : 0;
      const rawPct =
        lot.originalTokenAmount > 0 ? (tokenSoldFromThisLot / lot.originalTokenAmount) * 100 : 0;
      const delaySec = Math.max(0, ev.blockTime - lot.buyTime);

      lot.sells.push({
        multiplier,
        pct: rawPct,
        rawPct,
        delaySec,
        sellTime: ev.blockTime,
        sellSignature: ev.signature,
      });
      lot.remainingTokenAmount -= tokenSoldFromThisLot;
      lot.totalSellSol += solReceivedForThisLotPiece;
      tokensRemainingToSell -= tokenSoldFromThisLot;
      solRemainingToDistribute -= solReceivedForThisLotPiece;

      if (isFullyExited(lot)) {
        // Snap dust away so subsequent sells (if any) cannot apply to this lot.
        lot.remainingTokenAmount = 0;
        queue.shift();
      } else {
        // Lot not yet exited; keep at front of queue. Loop ends because tokensRemainingToSell == 0.
        break;
      }
    }
    // Any leftover tokensRemainingToSell that we couldn't apply (sell exceeded
    // open lot tokens) is silently discarded — it represents tokens bought
    // before the time window.
    void solRemainingToDistribute;
  }

  return allLots;
}

export function isFullyExited(lot: OpenLot): boolean {
  return lot.remainingTokenAmount <= lot.originalTokenAmount * FULLY_EXITED_TOLERANCE;
}
