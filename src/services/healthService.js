/**
 * src/services/healthService.js
 * ---------------------------------------------------------------------------
 * Health registry.
 *
 * Modules register named probes; `/health` runs them concurrently with a
 * per-probe timeout so one hung dependency can never make the endpoint hang.
 * Liveness (`/health/live`) is intentionally dumb — if the process answers, it
 * is alive. Readiness (`/health/ready`) is what Termux/PM2/a load balancer
 * should gate restarts on.
 */

import { BRAND } from '../config/constants.js';
import { getLogger } from '../utils/logger.js';

export const HEALTH_STATUS = Object.freeze({ OK: 'ok', DEGRADED: 'degraded', ERROR: 'error' });

export class HealthService {
  /** @param {object} [deps] @param {number} [deps.defaultTimeoutMs] */
  constructor(deps = {}) {
    /** @type {Map<string, { check:()=>Promise<any>|any, timeoutMs:number, critical:boolean }>} */
    this.checks = new Map();
    this.defaultTimeoutMs = deps.defaultTimeoutMs ?? 4000;
    this.logger = (deps.logger ?? getLogger()).child('health');
    this.startedAt = new Date();
    this.lastReport = null;
  }

  /**
   * @param {string} name
   * @param {() => Promise<Record<string, any>>|Record<string, any>} check
   * @param {object} [options]
   * @param {number} [options.timeoutMs]
   * @param {boolean} [options.critical] a failing critical check fails readiness
   */
  register(name, check, options = {}) {
    if (typeof check !== 'function') throw new TypeError(`health check "${name}" must be a function`);
    this.checks.set(name, {
      check,
      timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
      critical: options.critical ?? false,
    });
    return this;
  }

  /** @param {string} name */
  unregister(name) {
    return this.checks.delete(name);
  }

  /**
   * @param {object} [options]
   * @param {boolean} [options.deep] also run expensive probes (default true)
   * @returns {Promise<{ status:string, uptimeMs:number, version:string, timestamp:string, checks:Record<string, any> }>}
   */
  async run(options = {}) {
    const deep = options.deep ?? true;
    const results = {};
    const names = [...this.checks.keys()];

    await Promise.all(
      names.map(async (name) => {
        const entry = this.checks.get(name);
        const started = process.hrtime.bigint();
        try {
          const value = await Promise.race([
            Promise.resolve(entry.check()),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`health check timed out after ${entry.timeoutMs}ms`)), entry.timeoutMs).unref?.(),
            ),
          ]);
          results[name] = {
            status: value?.status ?? HEALTH_STATUS.OK,
            critical: entry.critical,
            durationMs: Math.round((Number(process.hrtime.bigint() - started) / 1e6) * 100) / 100,
            ...(value && typeof value === 'object' ? value : { value }),
          };
        } catch (err) {
          results[name] = {
            status: HEALTH_STATUS.ERROR,
            critical: entry.critical,
            error: err.message,
            durationMs: Math.round((Number(process.hrtime.bigint() - started) / 1e6) * 100) / 100,
          };
          this.logger.warn('Health check failed', { check: name, reason: err.message });
        }
      }),
    );

    const failed = Object.values(results).filter((r) => r.status !== HEALTH_STATUS.OK);
    const criticalFailed = failed.filter((r) => r.critical);
    const status = criticalFailed.length
      ? HEALTH_STATUS.ERROR
      : failed.length
        ? HEALTH_STATUS.DEGRADED
        : HEALTH_STATUS.OK;

    const report = {
      status,
      ready: criticalFailed.length === 0,
      uptimeMs: Date.now() - this.startedAt.getTime(),
      version: BRAND.version,
      timestamp: new Date().toISOString(),
      checks: deep ? results : Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.status])),
    };
    this.lastReport = report;
    return report;
  }

  /** @returns {string[]} */
  registeredChecks() {
    return [...this.checks.keys()];
  }
}

export const healthService = new HealthService();

export default healthService;
