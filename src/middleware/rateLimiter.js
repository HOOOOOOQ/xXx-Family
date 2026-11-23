/**
 * src/middleware/rateLimiter.js
 * ---------------------------------------------------------------------------
 * Token-bucket rate limiter.
 *
 * One implementation, two consumers:
 *   - Discord: per user/command cooldowns (see cooldownManager.js)
 *   - HTTP:    per IP/route limits on the Express API
 *
 * The bucket refills continuously, so a burst is allowed and sustained abuse is
 * not. `retryAfterMs` is exact, which lets callers render an honest
 * "try again in N seconds" message.
 */

export class TokenBucket {
  /**
   * @param {object} options
   * @param {number} options.capacity   max tokens
   * @param {number} options.refillMs   ms to fully refill from empty
   * @param {number} [options.initial]  starting tokens (default: capacity)
   */
  constructor({ capacity, refillMs, initial }) {
    this.capacity = capacity;
    this.refillMs = refillMs;
    this.tokens = initial ?? capacity;
    this.updatedAt = Date.now();
  }

  #refill(now = Date.now()) {
    const elapsed = now - this.updatedAt;
    if (elapsed <= 0) return;
    const gained = (elapsed / this.refillMs) * this.capacity;
    this.tokens = Math.min(this.capacity, this.tokens + gained);
    this.updatedAt = now;
  }

  /**
   * @param {number} [cost]
   * @returns {{ allowed:boolean, remaining:number, retryAfterMs:number|null }}
   */
  take(cost = 1) {
    this.#refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return { allowed: true, remaining: Math.floor(this.tokens), retryAfterMs: null };
    }
    const missing = cost - this.tokens;
    const retryAfterMs = Math.ceil((missing / this.capacity) * this.refillMs);
    return { allowed: false, remaining: Math.floor(this.tokens), retryAfterMs };
  }

  /** @returns {{ tokens:number, capacity:number }} */
  peek() {
    this.#refill();
    return { tokens: Math.floor(this.tokens), capacity: this.capacity };
  }
}

export class RateLimiter {
  /**
   * @param {object} options
   * @param {number} options.capacity
   * @param {number} options.refillMs
   * @param {number} [options.maxKeys] evict the least recently used beyond this
   */
  constructor({ capacity, refillMs, maxKeys = 10_000 }) {
    this.capacity = capacity;
    this.refillMs = refillMs;
    this.maxKeys = maxKeys;
    /** @type {Map<string, TokenBucket>} */
    this.buckets = new Map();
    this.blocked = 0;
    this.allowed = 0;
  }

  /**
   * @param {string} key
   * @param {number} [cost]
   * @returns {{ allowed:boolean, remaining:number, retryAfterMs:number|null, limit:number }}
   */
  consume(key, cost = 1) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket({ capacity: this.capacity, refillMs: this.refillMs });
      this.buckets.set(key, bucket);
      while (this.buckets.size > this.maxKeys) {
        const oldest = this.buckets.keys().next().value;
        if (oldest === undefined) break;
        this.buckets.delete(oldest);
      }
    } else {
      // Refresh LRU position.
      this.buckets.delete(key);
      this.buckets.set(key, bucket);
    }

    const result = bucket.take(cost);
    if (result.allowed) this.allowed += 1;
    else this.blocked += 1;
    return { ...result, limit: this.capacity };
  }

  /** @param {string} key */
  reset(key) {
    return this.buckets.delete(key);
  }

  /** @param {string} prefix */
  resetByPrefix(prefix) {
    let removed = 0;
    for (const key of this.buckets.keys()) {
      if (key.startsWith(prefix)) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** @returns {{ keys:number, allowed:number, blocked:number }} */
  stats() {
    return { keys: this.buckets.size, allowed: this.allowed, blocked: this.blocked };
  }
}

/**
 * Express middleware factory.
 * @param {object} options
 * @param {number} options.capacity
 * @param {number} options.refillMs
 * @param {(req:any)=>string} [options.keyFor]
 */
export function rateLimitMiddleware(options) {
  const limiter = new RateLimiter(options);
  const keyFor = options.keyFor ?? ((req) => `${req.ip ?? 'unknown'}:${req.route?.path ?? req.path}`);

  return function rateLimit(req, res, next) {
    const result = limiter.consume(keyFor(req));
    res.setHeader('X-RateLimit-Limit', String(result.limit));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    if (!result.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
      res.status(429).json({
        error: { code: 'ERR_RATE_LIMIT', message: 'Too many requests', retryAfterMs: result.retryAfterMs },
      });
      return;
    }
    next();
  };
}

export default RateLimiter;
