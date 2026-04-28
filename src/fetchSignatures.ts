import type { HeliusClient } from "./heliusClient.js";
import type { SignatureInfo } from "./types.js";

interface RawSig {
  signature: string;
  blockTime: number | null;
  slot: number;
  err: unknown;
}

export interface FetchSignaturesOptions {
  walletAddress: string;
  hoursBack: number;
  /** Called whenever new signatures are appended. */
  onProgress?: (totalCollected: number) => void;
}

/**
 * Page backwards via `before` cursor until blockTime crosses now - hoursBack,
 * or until the wallet has no more signatures.
 *
 * Filters out signatures with err !== null (failed transactions) and sorts
 * the result by blockTime ascending.
 */
export async function fetchSignatures(
  client: HeliusClient,
  options: FetchSignaturesOptions,
): Promise<SignatureInfo[]> {
  const cutoff = Math.floor(Date.now() / 1000) - options.hoursBack * 3600;
  const seen = new Set<string>();
  const collected: SignatureInfo[] = [];
  let before: string | undefined;

  while (true) {
    const params: [string, Record<string, unknown>] = [
      options.walletAddress,
      { limit: 1000, ...(before ? { before } : {}), commitment: "confirmed" },
    ];
    const page = await client.rpc<RawSig[]>("getSignaturesForAddress", params);
    if (!page || page.length === 0) break;

    let crossedCutoff = false;
    for (const sig of page) {
      if (seen.has(sig.signature)) continue;
      seen.add(sig.signature);

      // Skip failed transactions
      if (sig.err !== null && sig.err !== undefined) continue;

      // Tx with no blockTime usually means very recent / unconfirmed, keep them
      // unless they are clearly older than cutoff.
      if (sig.blockTime !== null && sig.blockTime < cutoff) {
        crossedCutoff = true;
        continue;
      }

      collected.push({
        signature: sig.signature,
        blockTime: sig.blockTime,
        slot: sig.slot,
        err: sig.err,
      });
    }

    options.onProgress?.(collected.length);

    // Stop if we crossed the cutoff or the page wasn't full (no more history).
    if (crossedCutoff || page.length < 1000) break;

    const last = page[page.length - 1]!;
    if (last.signature === before) break; // safety guard
    before = last.signature;
  }

  // Sort ascending by blockTime so trades replay in chronological order.
  collected.sort((a, b) => {
    const ta = a.blockTime ?? 0;
    const tb = b.blockTime ?? 0;
    if (ta !== tb) return ta - tb;
    return a.slot - b.slot;
  });

  return collected;
}
