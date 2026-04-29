import type { BatchCall, BatchCallResult, HeliusClient } from "./heliusClient.js";
import type { FullTransaction, SignatureInfo } from "./types.js";

const BATCH_SIZE = 50;

export interface FetchTransactionsOptions {
  signatures: SignatureInfo[];
  concurrency: number;
  onTick?: (done: number, total: number, retries: number, lastKeyIndex: number) => void;
}

interface FetchedTransaction {
  signature: string;
  tx: FullTransaction | null;
  error?: string;
}

const TX_PARAMS = {
  commitment: "confirmed" as const,
  maxSupportedTransactionVersion: 0,
  encoding: "jsonParsed" as const,
};

export async function fetchTransactions(
  client: HeliusClient,
  options: FetchTransactionsOptions,
): Promise<FetchedTransaction[]> {
  const { signatures } = options;
  const total = signatures.length;
  const results: FetchedTransaction[] = new Array(total);

  let nextIndex = 0;
  let done = 0;

  const tick = (): void => {
    options.onTick?.(done, total, client.stats.retries, client.stats.lastKeyIndex);
  };

  const worker = async (): Promise<void> => {
    while (true) {
      // Each worker grabs a contiguous chunk of up to BATCH_SIZE signatures
      // and dispatches them as a single JSON-RPC batch call.
      const startIdx = nextIndex;
      if (startIdx >= total) return;
      const endIdx = Math.min(startIdx + BATCH_SIZE, total);
      nextIndex = endIdx;

      const chunk = signatures.slice(startIdx, endIdx);
      const calls: BatchCall[] = chunk.map((s) => ({
        method: "getTransaction",
        params: [s.signature, TX_PARAMS],
      }));

      let batchResults: BatchCallResult<FullTransaction | null>[];
      try {
        batchResults = await client.rpcBatch<FullTransaction | null>(calls);
      } catch (err) {
        // Whole-batch failure (after internal retries). Mark all as retryable
        // so each falls through to the single-call path below.
        const message = err instanceof Error ? err.message : String(err);
        batchResults = chunk.map(() => ({
          error: { message, retryable: true },
        }));
      }

      for (let k = 0; k < chunk.length; k++) {
        const sig = chunk[k]!;
        const r = batchResults[k]!;
        const myIndex = startIdx + k;

        if (r.error?.retryable) {
          try {
            const tx = await client.rpc<FullTransaction | null>(
              "getTransaction",
              [sig.signature, TX_PARAMS],
              { onRetry: () => {} },
            );
            results[myIndex] = { signature: sig.signature, tx };
          } catch (err) {
            results[myIndex] = {
              signature: sig.signature,
              tx: null,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        } else if (r.error) {
          results[myIndex] = {
            signature: sig.signature,
            tx: null,
            error: r.error.message,
          };
        } else {
          results[myIndex] = { signature: sig.signature, tx: r.result ?? null };
        }
        done++;
        tick();
      }
    }
  };

  const workers = Array.from({ length: Math.max(1, options.concurrency) }, () => worker());
  await Promise.all(workers);
  return results;
}
