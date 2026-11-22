/**
 * src/services/cacheManager.js
 * ---------------------------------------------------------------------------
 * In-process TTL cache with LRU eviction.
 *
 * Used to keep guild/user settings, permission lookups and locale resolution
 * off the database. Deliberately dependency-free so it behaves the same on
 * Android Termux as on a server.
 */

export class CacheManager {
  /**
   * @param {object} [options]
   * @param {number} [options.defaultTtlMs]
   * @param {number} [options.maxEntries]
   * @param {number} [options.sweepIntervalMs]
   * @param {boolean} [options.autoSweep] start the interval timer
   */
  constructor(options = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? 60_000;
    this.maxEntries = options.maxEntries ?? 5_000;
    /** @type {Map<string, { value:unknown, expiresAt:number, hits:number }>} */
    this.store = new Map();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.timer = null;
    if (options.autoSweep !== false) this.startSweeper(options.sweepIntervalMs ?? 30_000);
  }

  /** @param {number} [intervalMs] */
  startSweeper(intervalMs = 30_000) {
    if (this.timer) return this.timer;
    this.timer = setInterval(() => this.sweep(), intervalMs);
    // Never keep the event loop alive just for cache housekeeping.
    this.timer.unref?.();
    return this.timer;
  }

  stopSweeper() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * @template T
   * @param {string} key
   * @returns {T|undefined}
   */
  get(key) {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt !== 0 && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    entry.hits += 1;
    // Refresh LRU position.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  /**
   * @param {string} key
   * @param {unknown} value
   * @param {number} [ttlMs] 0 = never expires
   */
  set(key, value, ttlMs = this.defaultTtlMs) {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: ttlMs > 0 ? Date.now() + ttlMs : 0, hits: 0 });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
      this.evictions += 1;
    }
    return value;
  }

  /** @param {string} key */
  has(key) {
    return this.get(key) !== undefined;
  }

  /** @param {string} key */
  delete(key) {
    return this.store.delete(key);
  }

  /** Delete every key starting with `prefix`. @returns {number} deleted count. */
  deleteByPrefix(prefix) {
    let removed = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear() {
    const size = this.store.size;
    this.store.clear();
    return size;
  }

  /** Drop expired entries. @returns {number} removed. */
  sweep() {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (entry.expiresAt !== 0 && entry.expiresAt <= now) {
        this.store.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Read-through helper. Only one in-flight factory per key, so a burst of
   * concurrent requests cannot stampede the database.
   *
   * @template T
   * @param {string} key
   * @param {() => Promise<T>|T} factory
   * @param {object} [options]
   * @param {number} [options.ttlMs]
   * @returns {Promise<T>}
   */
  async wrap(key, factory, options = {}) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const inflightKey = `__inflight:${key}`;
    const inflight = this.store.get(inflightKey);
    if (inflight) return inflight.value;

    const promise = Promise.resolve()
      .then(() => factory())
      .then((value) => {
        if (value !== undefined && value !== null) {
          this.set(key, value, options.ttlMs ?? this.defaultTtlMs);
        }
        this.store.delete(inflightKey);
        return value;
      })
      .catch((err) => {
        this.store.delete(inflightKey);
        throw err;
      });

    this.store.set(inflightKey, { value: promise, expiresAt: Date.now() + 30_000, hits: 0 });
    return promise;
  }

  /** @returns {{ size:number, hits:number, misses:number, evictions:number, hitRate:number }} */
  stats() {
    const total = this.hits + this.misses;
    return {
      size: this.store.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: total === 0 ? 0 : Math.round((this.hits / total) * 1000) / 10,
    };
  }
}

/** Shared cache instance for settings and locale lookups. */
export const settingsCache = new CacheManager({ defaultTtlMs: 120_000, maxEntries: 10_000 });

export default CacheManager;
