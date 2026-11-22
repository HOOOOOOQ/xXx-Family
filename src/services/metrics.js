/**
 * src/services/metrics.js
 * ---------------------------------------------------------------------------
 * In-process counters. No external metrics stack is required, so this runs on
 * Termux exactly as it runs on a VPS; the values are exposed on `/metrics`
 * (JSON) and in the dashboard's Command Analytics page.
 */

export class MetricsRegistry {
  constructor() {
    this.startedAt = new Date();
    /** @type {Map<string, { count:number, totalMs:number, maxMs:number, errors:number }>} */
    this.commands = new Map();
    this.counters = new Map();
    this.interactions = 0;
    this.errors = 0;
  }

  /** @param {string} name @param {number} durationMs */
  recordCommand(name, durationMs) {
    let entry = this.commands.get(name);
    if (!entry) {
      entry = { count: 0, totalMs: 0, maxMs: 0, errors: 0 };
      this.commands.set(name, entry);
    }
    entry.count += 1;
    entry.totalMs += durationMs;
    entry.maxMs = Math.max(entry.maxMs, durationMs);
  }

  /** @param {string} name */
  recordCommandError(name) {
    const entry = this.commands.get(name) ?? { count: 0, totalMs: 0, maxMs: 0, errors: 0 };
    entry.errors += 1;
    this.commands.set(name, entry);
    this.errors += 1;
  }

  /** @param {string} name @param {number} [amount] */
  increment(name, amount = 1) {
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  /** @param {string} name */
  get(name) {
    return this.counters.get(name) ?? 0;
  }

  /** @returns {Record<string, any>} */
  snapshot() {
    const commands = {};
    for (const [name, entry] of this.commands) {
      commands[name] = {
        count: entry.count,
        errors: entry.errors,
        avgMs: entry.count ? Math.round((entry.totalMs / entry.count) * 100) / 100 : 0,
        maxMs: Math.round(entry.maxMs * 100) / 100,
      };
    }
    return {
      uptimeMs: Date.now() - this.startedAt.getTime(),
      interactions: this.interactions,
      errors: this.errors,
      counters: Object.fromEntries(this.counters),
      commands,
    };
  }

  reset() {
    this.commands.clear();
    this.counters.clear();
    this.interactions = 0;
    this.errors = 0;
  }
}

export const metrics = new MetricsRegistry();

export default MetricsRegistry;
