/**
 * src/bot/modules/tickets/index.js
 * ---------------------------------------------------------------------------
 * The `tickets` module.
 *
 * The behaviour lives in TicketService, the entry points are /ticket and the
 * panel buttons, and transcripts are recorded from the messageCreate event.
 * This file declares the module, exposes health, and reconciles stored tickets
 * against the channels Discord actually still has.
 *
 * The reconciliation is what makes transcripts survive a restart. It also
 * repopulates the in-memory channel cache, which is what lets messageCreate
 * recognise a ticket without a database read per message.
 */

import { HEALTH_STATUS } from '../../../services/healthService.js';

let startedAt = null;

export default {
  name: 'tickets',
  version: '1.0.0',
  phase: 4,
  dependencies: ['core'],
  configKey: 'tickets',

  async init(ctx) {
    const { health, client, metrics } = ctx;

    health.register(
      'tickets',
      () => {
        if (!startedAt) {
          return { status: HEALTH_STATUS.DEGRADED, ready: false, reason: 'not started' };
        }
        if (!client?.tickets) {
          return { status: HEALTH_STATUS.DEGRADED, ready: false, reason: 'ticket service missing' };
        }
        const get = (name) => client.metrics?.get?.(name) ?? 0;
        return {
          status: HEALTH_STATUS.OK,
          ready: true,
          since: startedAt,
          opened: get('tickets.opened'),
          claimed: get('tickets.claimed'),
          closed: get('tickets.closed'),
          rated: get('tickets.rated'),
          trackedChannels: client.tickets.trackedChannels(),
        };
      },
      { critical: false },
    );

    // How many ticket channels we can recognise from memory. If this is zero
    // while tickets are open, transcript recording is silently off.
    metrics?.gauge?.('tickets.trackedChannels', () => client?.tickets?.trackedChannels?.() ?? 0);
  },

  async start(ctx) {
    const { client, logger } = ctx;
    startedAt = new Date().toISOString();

    /** Reconcile one guild, never throwing into the caller. */
    const reconcile = async (guild, source) => {
      try {
        const result = await client.tickets.reconcile(guild);
        if (result.stale) {
          logger.info('Tickets reconciled', { guildId: guild.id, stale: result.stale, source });
        }
      } catch (err) {
        logger.warn('Ticket reconciliation failed', { guildId: guild.id, reason: err.message });
      }
    };

    // On boot every cached guild fires guildCreate, so this one handler covers
    // both the initial sweep and later joins.
    client.on?.('guildCreate', (guild) => reconcile(guild, 'guildCreate'));
    client.on?.('guildDelete', (guild) => {
      const removed = client.tickets?.forgetGuild?.(guild.id) ?? 0;
      if (removed) logger.info('Ticket cache cleared for a guild', { guildId: guild.id, removed });
    });

    // Belt and braces: reconcile any guild already cached before the module
    // started, in case guildCreate fired earlier during boot.
    for (const guild of client.guilds?.cache?.values?.() ?? []) {
      await reconcile(guild, 'boot');
    }

    logger.info('Tickets module started');
  },

  async stop() {
    startedAt = null;
  },
};
