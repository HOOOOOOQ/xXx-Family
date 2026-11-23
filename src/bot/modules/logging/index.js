/**
 * src/bot/modules/logging/index.js
 * ---------------------------------------------------------------------------
 * The `logging` module.
 *
 * Like `welcome`, the behaviour lives in LoggingService; this file declares the
 * module, exposes health, and reports what it has processed so a server that
 * stopped receiving logs is diagnosable from /health instead of guesswork.
 *
 * Important property: logging is **strictly observational**. Nothing here may
 * throw into a gateway event, and nothing here may block the event it is
 * observing. A log channel that was deleted, a revoked permission, or a slow
 * database must never stop a ban, a message delete or a member join.
 */

import { HEALTH_STATUS } from '../../../services/healthService.js';

/** Rolling counters for /health. Bounded: we only keep aggregate numbers. */
const counters = {
  processed: 0,
  delivered: 0,
  failedDelivery: 0,
  filtered: 0,
  startedAt: null,
};

/** @param {'processed'|'delivered'|'failedDelivery'|'filtered'} key */
export function bumpLoggingStat(key) {
  if (key in counters) counters[key] += 1;
}

export default {
  name: 'logging',
  version: '1.0.0',
  phase: 2,
  dependencies: ['core'],
  configKey: 'logging',

  async init(ctx) {
    const { health, metrics, client } = ctx;

    health.register(
      'logging',
      () => {
        if (!counters.startedAt) {
          return { status: HEALTH_STATUS.DEGRADED, ready: false, reason: 'not started' };
        }
        const eventErrors = client?.metrics?.get?.('logging.eventErrors') ?? 0;
        return {
          status: HEALTH_STATUS.OK,
          ready: true,
          since: counters.startedAt,
          processed: counters.processed,
          delivered: counters.delivered,
          failedDelivery: counters.failedDelivery,
          filtered: counters.filtered,
          // Non-zero means a logging listener threw and was swallowed. The bot
          // is fine, but some category of log is silently missing.
          eventErrors,
        };
      },
      // Losing log delivery must never take the bot out of rotation.
      { critical: false },
    );

    // A rising failure ratio is the signal worth having on a dashboard.
    metrics?.gauge?.('logging.delivered', () => counters.delivered);
  },

  async start(ctx) {
    counters.startedAt = new Date().toISOString();
    ctx.logger?.info('Logging module started');
  },

  async stop(ctx) {
    counters.startedAt = null;
    ctx.logger?.debug('Logging module stopped');
  },
};

/** Exposed for tests. */
export function __loggingStats() {
  return { ...counters };
}
