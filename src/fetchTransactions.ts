import type { HeliusClient } from "./heliusClient.js";
import type { FullTransaction, SignatureInfo } from "./types.js";

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

export async function fetchTransactions(
  client: HeliusClient,
  options: FetchTransactionsOptions,
): Promise<FetchedTransaction[]> {
  const { signatures, concurrency } = options;
  const total = signatures.length;
  const results: FetchedTransaction[] = new Array(total);

  let nextIndex = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const myIndex = nextIndex++;
      if (myIndex >= total) return;
      const sig = signatures[myIndex]!;
      try {
        const tx = await client.rpc<FullTransaction | null>("getTransaction", [
          sig.signature,
          {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
            encoding: "jsonParsed",
          },
        ], { onRetry: () => {} });
        results[myIndex] = { signature: sig.signature, tx };
      } catch (err) {
        results[myIndex] = {
          signature: sig.signature,
          tx: null,
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        done++;
        options.onTick?.(done, total, client.stats.retries, client.stats.lastKeyIndex);
      }
    }
  };

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
  await Promise.all(workers);
  return results;
}
