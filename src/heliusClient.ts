import { KeyPool } from "./rateLimiter.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RpcCallOptions {
  /** Tracked retry counter shared across the run, incremented on every retry. */
  onRetry?: () => void;
  /** Override max retries (default 6). */
  maxRetries?: number;
}

export interface HeliusClientStats {
  retries: number;
  lastKeyIndex: number;
}

export class HeliusClient {
  public readonly stats: HeliusClientStats = { retries: 0, lastKeyIndex: 0 };

  constructor(private readonly pool: KeyPool) {}

  keyCount(): number {
    return this.pool.size();
  }

  async rpc<T>(method: string, params: unknown[], opts: RpcCallOptions = {}): Promise<T> {
    const maxRetries = opts.maxRetries ?? 6;
    let attempt = 0;
    let lastErr: unknown = null;

    while (attempt <= maxRetries) {
      const { key, index } = await this.pool.acquire();
      this.stats.lastKeyIndex = index;
      const url = `https://beta.helius-rpc.com/?api-key=${key}`;
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

      let res: Response | null = null;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
      } catch (err) {
        lastErr = err;
        attempt++;
        opts.onRetry?.();
        this.stats.retries++;
        await sleep(backoffMs(attempt));
        continue;
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 1;
        this.pool.penalize(index, retryAfter * 1000);
        attempt++;
        opts.onRetry?.();
        this.stats.retries++;
        await sleep(backoffMs(attempt));
        continue;
      }

      if (res.status >= 500) {
        attempt++;
        opts.onRetry?.();
        this.stats.retries++;
        await sleep(backoffMs(attempt));
        lastErr = new Error(`Helius HTTP ${res.status}`);
        continue;
      }

      if (!res.ok) {
        const text = await safeText(res);
        throw new Error(`Helius HTTP ${res.status}: ${text}`);
      }

      let json: unknown;
      try {
        json = await res.json();
      } catch (err) {
        attempt++;
        opts.onRetry?.();
        this.stats.retries++;
        await sleep(backoffMs(attempt));
        lastErr = err;
        continue;
      }

      const obj = json as { error?: { code?: number; message?: string }; result?: T };
      if (obj.error) {
        const code = obj.error.code;
        const msg = obj.error.message ?? "unknown rpc error";
        // Treat rate-limit / busy errors as retryable
        if (code === -32005 || code === -32429 || /rate|busy|timeout/i.test(msg)) {
          this.pool.penalize(index, 1000);
          attempt++;
          opts.onRetry?.();
          this.stats.retries++;
          await sleep(backoffMs(attempt));
          lastErr = new Error(`RPC error ${code}: ${msg}`);
          continue;
        }
        throw new Error(`RPC error ${code}: ${msg}`);
      }

      if (obj.result === undefined) {
        // Some methods legitimately return null; coerce.
        return null as unknown as T;
      }
      return obj.result;
    }

    throw new Error(`Helius RPC ${method} failed after ${maxRetries} retries: ${String(lastErr)}`);
  }
}

function backoffMs(attempt: number): number {
  // Exponential backoff with jitter: 200ms, 400, 800, 1600, 3200, 5000 cap
  const base = Math.min(5000, 200 * 2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * 200);
  return base + jitter;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<no body>";
  }
}
