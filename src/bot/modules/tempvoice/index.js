/**
 * src/bot/modules/tempvoice/index.js
 * ---------------------------------------------------------------------------
 * The `tempvoice` module.
 *
 * The behaviour lives in TempVoiceService and is triggered from the
 * voiceStateUpdate event. This file declares the module, reconciles stored rooms
 * against what Discord actually has on guild join, and exposes health.
 *
 * The reconciliation matters more than it looks: rooms created before a restart
 * are still on Discord, and without a record of them the bot would leave them
 * there forever.
 */

import { HEALTH_STATUS } from '../../../services/healthService.js';

let startedAt = null;

export default {
  name: 'tempvoice',
  version: '1.0.0',
  phase: 4,
  dependencies: ['core'],
  configKey: 'tempvoice',

  async init(ctx) {
    const { health, client, metrics } = ctx;

    health.register(
      'tempvoice',
      () => {
        if (!startedAt) {
          return { status: HEALTH_STATUS.DEGRADED, ready: false, reason: 'not started' };
        }
        if (!client?.tempVoice) {
          return { status: HEALTH_STATUS.DEGRADED, ready: false, reason: 'temp voice service missing' };
        }
        const get = (name) => client.metrics?.get?.(name) ?? 0;
        return {
          status: HEALTH_STATUS.OK,
          ready: true,
          since: startedAt,
          created: get('tempvoice.created'),
          deleted: get('tempvoice.deleted'),
          moveFailures: get('tempvoice.moveFailed'),
          errors: get('tempvoice.errors'),
          pendingCleanups: client.tempVoice.pendingCleanups(),
        };
      },
      { critical: false },
    );

    // A cleanup timer that never fires shows up here as a number that only
    // grows — the sign of a leak rather than of activity.
    metrics?.gauge?.('tempvoice.pendingCleanups', () => client?.tempVoice?.pendingCleanups?.() ?? 0);

    // Reconcile rooms the bot already owns whenever a guild becomes available,
    // including on boot when every cached guild fires guildCreate.
    client.on?.('guildCreate', (guild) => {
      client.tempVoice
        ?.reconcile(guild)
        ?.catch?.((err) => ctx.logger?.warn('Temporary voice reconcile failed', { reason: err.message }));
    });
  },

  async start(ctx) {
    startedAt = new Date().toISOString();

    // Sweep any guild already in cache: on a restart these do not fire
    // guildCreate, and their rooms would never be reconciled.
    const guilds = ctx.client?.guilds?.cache?.values?.() ?? [];
    let reconciled = 0;
    for (const guild of guilds) {
      try {
        await ctx.client.tempVoice?.reconcile(guild);
        reconciled += 1;
      } catch (err) {
        ctx.logger?.warn('Temporary voice reconcile failed', { guildId: guild.id, reason: err.message });
      }
    }

    ctx.logger?.info('Temporary voice module started', { guildsReconciled: reconciled });
  },

  async stop(ctx) {
    startedAt = null;
    const guilds = ctx.client?.guilds?.cache?.values?.() ?? [];
    for (const guild of guilds) ctx.client?.tempVoice?.forgetGuild?.(guild.id);
    ctx.logger?.debug('Temporary voice module stopped');
  },
};
