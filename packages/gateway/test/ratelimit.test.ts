import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/ratelimit.js";

describe("RateLimiter", () => {
  it("allows up to the limit and blocks past it", () => {
    const limiter = new RateLimiter(60_000);
    const now = 1_000_000;

    for (let i = 1; i <= 5; i++) {
      expect(limiter.check("t1", 5, now).allowed, `call ${i}`).toBe(true);
    }
    expect(limiter.check("t1", 5, now).allowed).toBe(false);
  });

  it("reports remaining and a reset time", () => {
    const limiter = new RateLimiter(60_000);
    const now = 1_000_000;

    expect(limiter.check("t1", 3, now).remaining).toBe(2);
    expect(limiter.check("t1", 3, now).remaining).toBe(1);

    const third = limiter.check("t1", 3, now);
    expect(third.remaining).toBe(0);
    expect(third.resetAt).toBe(now + 60_000);
  });

  it("starts a fresh window after the old one expires", () => {
    const limiter = new RateLimiter(60_000);
    const now = 1_000_000;

    limiter.check("t1", 1, now);
    expect(limiter.check("t1", 1, now).allowed).toBe(false);
    expect(limiter.check("t1", 1, now + 60_001).allowed).toBe(true);
  });

  it("keeps tenants independent", () => {
    const limiter = new RateLimiter(60_000);
    const now = 1_000_000;

    limiter.check("noisy", 1, now);
    expect(limiter.check("noisy", 1, now).allowed).toBe(false);
    // One tenant exhausting their limit must not affect anyone else.
    expect(limiter.check("quiet", 1, now).allowed).toBe(true);
  });

  it("returns a usable retry-after when blocked", () => {
    const limiter = new RateLimiter(60_000);
    const now = 1_000_000;

    limiter.check("t1", 1, now);
    const blocked = limiter.check("t1", 1, now + 30_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(30);
  });

  it("blocks outright when the limit is zero or negative", () => {
    const limiter = new RateLimiter();
    expect(limiter.check("t1", 0).allowed).toBe(false);
    expect(limiter.check("t1", -1).allowed).toBe(false);
  });

  it("stays bounded under a flood of distinct keys", () => {
    // Otherwise an attacker rotating tenant ids grows the map until the
    // process runs out of memory — a rate limiter that becomes the outage.
    const limiter = new RateLimiter(60_000, 100);
    for (let i = 0; i < 5_000; i++) limiter.check(`tenant-${i}`, 10, 1_000_000);

    expect(limiter.size).toBeLessThanOrEqual(200);
  });

  it("reclaims expired keys rather than live ones", () => {
    const limiter = new RateLimiter(1_000, 100);
    for (let i = 0; i < 100; i++) limiter.check(`old-${i}`, 10, 1_000);

    // Well past the window: everything above should be swept.
    limiter.check("new", 10, 100_000);
    expect(limiter.size).toBeLessThan(100);
  });
});
