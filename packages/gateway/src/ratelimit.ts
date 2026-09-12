/**
 * Per-tenant request rate limiting.
 *
 * A fixed window rather than a token bucket: the goal is to stop one tenant
 * exhausting the gateway or their own plan, not to shape traffic precisely.
 * A fixed window can allow up to 2x the limit across a boundary, which is an
 * acceptable overshoot for a protective cap and much cheaper to reason about.
 *
 * In-process, so each gateway instance enforces its own share. A multi-node
 * deployment needs a shared counter (Redis); until then the effective limit is
 * `limit x instances`, which is documented rather than pretended away.
 */
export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Unix ms when the current window ends. */
  readonly resetAt: number;
  /** Seconds to wait, for a Retry-After header. Only meaningful when blocked. */
  readonly retryAfterSeconds: number;
}

interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  readonly #windows = new Map<string, Window>();
  readonly #windowMs: number;
  /** Bound on distinct keys, so an attacker cannot grow the map without limit. */
  readonly #maxKeys: number;

  constructor(windowMs = 60_000, maxKeys = 10_000) {
    this.#windowMs = windowMs;
    this.#maxKeys = maxKeys;
  }

  check(key: string, limit: number, now = Date.now()): RateLimitDecision {
    if (limit <= 0) {
      return { allowed: false, limit, remaining: 0, resetAt: now, retryAfterSeconds: 60 };
    }

    let window = this.#windows.get(key);
    if (window === undefined || window.resetAt <= now) {
      // Sweep opportunistically rather than on a timer: no background work in
      // a process that may be handling a request at any moment.
      if (this.#windows.size >= this.#maxKeys) this.#evictExpired(now);
      window = { count: 0, resetAt: now + this.#windowMs };
      this.#windows.set(key, window);
    }

    window.count += 1;
    const remaining = Math.max(0, limit - window.count);

    return {
      allowed: window.count <= limit,
      limit,
      remaining,
      resetAt: window.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
    };
  }

  #evictExpired(now: number): void {
    for (const [key, window] of this.#windows) {
      if (window.resetAt <= now) this.#windows.delete(key);
    }
    // Everything is still live: drop the oldest-resetting entries so the map
    // stays bounded. Those tenants get a fresh window, which is the failure
    // mode that errs toward availability rather than false rejection.
    if (this.#windows.size >= this.#maxKeys) {
      const byReset = [...this.#windows.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
      for (const [key] of byReset.slice(0, Math.ceil(this.#maxKeys / 4))) {
        this.#windows.delete(key);
      }
    }
  }

  /** Test seam: current number of tracked keys. */
  get size(): number {
    return this.#windows.size;
  }
}
