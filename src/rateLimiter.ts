function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TokenBucket {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private lastRefill: number;
  private penaltyUntil = 0;

  constructor(ratePerSec: number) {
    this.capacity = ratePerSec;
    this.tokens = ratePerSec;
    this.refillPerMs = ratePerSec / 1000;
    this.lastRefill = Date.now();
  }

  private refill(now: number): void {
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
      this.lastRefill = now;
    }
  }

  async take(): Promise<void> {
    while (true) {
      const now = Date.now();
      if (now < this.penaltyUntil) {
        await sleep(this.penaltyUntil - now);
        continue;
      }
      this.refill(now);
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.max(5, Math.ceil((1 - this.tokens) / this.refillPerMs));
      await sleep(waitMs);
    }
  }

  penalize(ms: number): void {
    this.penaltyUntil = Math.max(this.penaltyUntil, Date.now() + ms);
  }
}

export class KeyPool {
  private readonly buckets: TokenBucket[];
  private rrIndex = 0;

  constructor(
    private readonly keys: string[],
    ratePerSec: number,
  ) {
    if (keys.length === 0) throw new Error("KeyPool requires at least one key");
    this.buckets = keys.map(() => new TokenBucket(ratePerSec));
  }

  size(): number {
    return this.keys.length;
  }

  /**
   * Round-robin pick a key, waiting until that key's bucket has a token.
   * Returns both the key and the index so callers can apply penalties on 429.
   */
  async acquire(): Promise<{ key: string; index: number }> {
    const index = this.rrIndex;
    this.rrIndex = (this.rrIndex + 1) % this.keys.length;
    await this.buckets[index]!.take();
    return { key: this.keys[index]!, index };
  }

  penalize(index: number, ms: number): void {
    const bucket = this.buckets[index];
    if (bucket) bucket.penalize(ms);
  }
}
