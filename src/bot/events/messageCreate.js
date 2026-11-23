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

import { Events } from 'discord.js';

import { getLogger } from '../../utils/logger.js';

export default {
  name: Events.MessageCreate,

  /** @param {import('../client.js').XxxFamilyClient} client @param {import('discord.js').Message} message */
  async execute(client, message) {
    const logger = getLogger().child('automod');

    // Cheapest checks first. Bots, webhooks and DMs are never screened.
    if (!message.inGuild()) return;
    if (message.author?.bot || message.webhookId || message.system) return;
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
