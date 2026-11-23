/**
 * src/bot/events/messageCreate.js
 * ---------------------------------------------------------------------------
 * Runs every guild message through automod.
 *
 * This is the hottest path in the bot, so it is deliberately boring: cheap
 * bail-outs first, no awaits before them, and nothing allowed to throw.
 * A screening failure must degrade to "message not screened", never to a
 * gateway disconnect.
 */

import { Events, PermissionFlagsBits } from 'discord.js';

import { getLogger } from '../../utils/logger.js';

export default {
  name: Events.MessageCreate,

  /** @param {import('../client.js').XxxFamilyClient} client @param {import('discord.js').Message} message */
  async execute(client, message) {
    const logger = getLogger().child('automod');

    // Cheapest checks first. Bots, webhooks and DMs are never screened.
    if (!message.inGuild()) return;
    if (message.author?.bot || message.webhookId || message.system) return;

    // Ticket transcripts. This runs before the automod gate below on purpose:
    // a server may disable automod and still expect its tickets to be recorded.
    // `isTicketChannel` is a synchronous in-memory lookup, so messages outside
    // a ticket — nearly all of them — cost nothing here.
    if (client.tickets?.isTicketChannel?.(message.channelId)) {
      try {
        const ticketConfig = await client.tickets.getConfig(message.guildId);
        await client.tickets.recordMessage({
          guildId: message.guildId,
          channelId: message.channelId,
          message,
          isStaff: Boolean(
            ticketConfig.staffRoleId
              ? message.member?.roles?.cache?.has?.(ticketConfig.staffRoleId)
              : message.member?.permissions?.has?.(PermissionFlagsBits.ManageMessages),
          ),
        });
      } catch (err) {
        // A transcript gap is bad; losing the gateway over it is worse.
        logger.warn('Could not record a ticket message', {
          channelId: message.channelId,
          reason: err.message,
        });
      }
    }

    if (!client.automod) return;

    // A module the server switched off should cost nothing at all.
    let config;
    try {
      config = await client.automod.getConfig(message.guildId);
    } catch (err) {
      logger.warn('Could not read the automod configuration', {
        guildId: message.guildId,
        reason: err.message,
      });
      return;
    }
    if (!config.enabled) return;

    client.metrics.increment('automod.scanned');

    try {
      const result = await client.automod.process(message, { config });
      if (result.action) {
        logger.info('Automod action taken', {
          guildId: message.guildId,
          userId: message.author.id,
          rules: result.matched.join(','),
          action: result.action,
        });
      }
    } catch (err) {
      // process() already contains its own failures; this is the backstop for
      // anything unexpected so a screening bug cannot take the gateway down.
      logger.errorFrom(err, 'Automod screening failed', {
        guildId: message.guildId,
        messageId: message.id,
      });
      client.metrics.increment('automod.errors');
    }
  },
};
