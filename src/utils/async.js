/**
 * src/utils/async.js — small async helpers shared by handlers and modules.
 */

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrap an async interaction handler so a rejection becomes a normal error the
 * central handler can report instead of an unhandled rejection.
 * @template {(...args:any[]) => Promise<any>} F
 * @param {F} fn
 * @returns {F}
 */
export function asyncHandler(fn) {
  return function wrapped(...args) {
    return Promise.resolve(fn(...args)).catch((err) => {
      throw err;
    });
  };
}

/**
 * Retry with exponential backoff + jitter.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {object} [options]
 * @param {number} [options.retries]
 * @param {number} [options.baseDelayMs]
 * @param {number} [options.maxDelayMs]
 * @param {(err:unknown, attempt:number)=>void} [options.onRetry]
 * @param {(ms:number)=>Promise<void>} [options.delay]
 * @returns {Promise<T>}
 */
export async function retry(fn, options = {}) {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 8_000;
  const delay = options.delay ?? sleep;

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      // A 4xx from Discord will not fix itself; only retry what can recover.
      const status = err?.status ?? err?.statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) throw err;
      if (attempt >= retries) break;
      const waitMs = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 120));
      options.onRetry?.(err, attempt);
      await delay(waitMs);
    }
  }
  throw lastError;
}

/**
 * Run promises with a concurrency limit (protects Discord rate limits when a
 * module has to touch many guilds/channels).
 * @template T,R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item:T, index:number)=>Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Promise.race with a timeout that rejects with a TimeoutError-style AppError.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} [message]
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, message = `Operation timed out after ${ms}ms`) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Fire-and-forget that still logs failures (no floating promises).
 * @param {Promise<unknown>} promise
 * @param {(err:unknown)=>void} onError
 */
export function safeVoid(promise, onError) {
  Promise.resolve(promise).catch((err) => onError?.(err));
}
