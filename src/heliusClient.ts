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

export interface BatchCall {
  method: string;
  params: unknown[];
}

export interface BatchCallResult<T> {
  result?: T;
  error?: { code?: number; message: string; retryable: boolean };
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

  /**
   * JSON-RPC batch: send N calls in one HTTP request, return per-call results
   * matched by id. Whole-batch transient failures (network, 429, 5xx, malformed
   * body) are retried with backoff; per-call rpc errors are returned to the
   * caller so it can decide whether to retry individual calls.
   */
  async rpcBatch<T>(calls: BatchCall[], opts: RpcCallOptions = {}): Promise<BatchCallResult<T>[]> {
    if (calls.length === 0) return [];
    const maxRetries = opts.maxRetries ?? 6;
    let attempt = 0;
    let lastErr: unknown = null;

    while (attempt <= maxRetries) {
      const { key, index } = await this.pool.acquire();
      this.stats.lastKeyIndex = index;
      const url = `https://beta.helius-rpc.com/?api-key=${key}`;
      const body = JSON.stringify(
        calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, params: c.params })),
      );

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
        lastErr = new Error(`Helius batch HTTP ${res.status}`);
        continue;
      }

      if (!res.ok) {
        const text = await safeText(res);
        throw new Error(`Helius batch HTTP ${res.status}: ${text}`);
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

      if (!Array.isArray(json)) {
        // Some servers respond with a single error object instead of an array.
        const obj = json as { error?: { code?: number; message?: string } };
        if (obj.error) {
          const msg = obj.error.message ?? "unknown batch error";
          // If the whole batch was rate-limited or busy, penalize and retry.
          if (/rate|busy|timeout/i.test(msg)) {
            this.pool.penalize(index, 1000);
            attempt++;
            opts.onRetry?.();
            this.stats.retries++;
            await sleep(backoffMs(attempt));
            lastErr = new Error(`Helius batch error: ${msg}`);
            continue;
          }
          throw new Error(`Helius batch RPC error: ${msg}`);
        }
        throw new Error(`Helius batch returned non-array body`);
      }

      const out: Array<BatchCallResult<T> | null> = new Array(calls.length).fill(null);
      for (const r of json as Array<{ id?: number; result?: T; error?: { code?: number; message?: string } }>) {
        const idx = typeof r.id === "number" ? r.id : -1;
        if (idx < 0 || idx >= calls.length) continue;
        if (r.error) {
          const code = r.error.code;
          const msg = r.error.message ?? "unknown rpc error";
          const retryable =
            code === -32005 || code === -32429 || /rate|busy|timeout/i.test(msg);
          out[idx] = { error: { code, message: msg, retryable } };
        } else {
          out[idx] = { result: (r.result ?? null) as T };
        }
      }
      // Any slot the server didn't return → mark retryable so the caller can
      // fall back to a single-call rpc().
      for (let i = 0; i < out.length; i++) {
        if (out[i] === null) {
          out[i] = { error: { message: "missing in batch response", retryable: true } };
        }
      }
      return out as BatchCallResult<T>[];
    }

    throw new Error(`Helius batch RPC failed after ${maxRetries} retries: ${String(lastErr)}`);
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
