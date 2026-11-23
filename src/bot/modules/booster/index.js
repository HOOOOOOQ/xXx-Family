/**
 * src/bot/modules/booster/index.js
 * ---------------------------------------------------------------------------
 * The `booster` module.
 *
 * The behaviour lives in BoosterService; the boost signal arrives through the
 * guildMemberUpdate event (discord.js emits no dedicated boost event). This file
 * declares the module and exposes health so a server whose booster announcements
 * quietly stopped is visible from /health rather than guesswork.
 */

import { HEALTH_STATUS } from '../../../services/healthService.js';

let startedAt = null;

export default {
  name: 'booster',
  version: '1.0.0',
  phase: 2,
  dependencies: ['core'],
  configKey: 'booster',

  async init(ctx) {
    const { health, client, metrics } = ctx;

    health.register(
      'booster',
      () => {
        if (!startedAt) {
          return { status: HEALTH_STATUS.DEGRADED, ready: false, reason: 'not started' };
        }
        return {
          status: HEALTH_STATUS.OK,
          ready: true,
          since: startedAt,
          starts: client?.metrics?.get?.('booster.start') ?? 0,
          ends: client?.metrics?.get?.('booster.end') ?? 0,
        };
      },
      { critical: false },
    );

    metrics?.gauge?.('booster.announced', () => (client?.metrics?.get?.('booster.announced.start') ?? 0));
  },

  async start(ctx) {
    startedAt = new Date().toISOString();
    ctx.logger?.info('Booster module started');
  },

  async stop(ctx) {
    startedAt = null;
    ctx.logger?.debug('Booster module stopped');
  },
};
