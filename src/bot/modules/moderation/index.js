/**
 * src/bot/modules/moderation/index.js
 * ---------------------------------------------------------------------------
 * The `moderation` module.
 *
 * The behaviour lives in ModerationService and AutomodService. This file
 * declares the module and exposes health so a server where moderation silently
 * stopped working — or where automod is flagging everything — is visible from
 * /health instead of being discovered by an angry moderator.
 */

import { HEALTH_STATUS } from '../../../services/healthService.js';

let startedAt = null;

export default {
  name: 'moderation',
  version: '1.0.0',
  phase: 3,
  dependencies: ['core'],
  configKey: 'moderation',

  async init(ctx) {
    const { health, client, metrics } = ctx;

    health.register(
      'moderation',
      () => {
        if (!startedAt) {
          return { status: HEALTH_STATUS.DEGRADED, ready: false, reason: 'not started' };
        }
        if (!client?.moderation) {
          return { status: HEALTH_STATUS.DEGRADED, ready: false, reason: 'moderation service missing' };
        }
        const get = (name) => client.metrics?.get?.(name) ?? 0;
        return {
          status: HEALTH_STATUS.OK,
          ready: true,
          since: startedAt,
          actions: get('moderation.ban') + get('moderation.kick') + get('moderation.timeout') + get('moderation.warn'),
          automodScanned: get('automod.scanned'),
          automodActions: get('automod.delete') + get('automod.warn') + get('automod.timeout'),
          automodErrors: get('automod.errors'),
        };
      },
      { critical: false },
    );

    // Automod runs on every message; a spike here is the first sign a rule is
    // mis-tuned and quietly deleting legitimate messages.
    metrics?.gauge?.('automod.scanned', () => client?.metrics?.get?.('automod.scanned') ?? 0);
    metrics?.gauge?.('moderation.cases', () => client?.metrics?.get?.('moderation.warn') ?? 0);
  },

  async start(ctx) {
    startedAt = new Date().toISOString();
    ctx.logger?.info('Moderation module started');
  },

  async stop(ctx) {
    startedAt = null;
    ctx.logger?.debug('Moderation module stopped');
  },
};
