import { Events } from 'discord.js';

import { getLogger } from '../../utils/logger.js';

/**
 * A guild became available (first join, or recovery from an outage).
 * We create the settings document lazily and cache the guild name so the
 * dashboard can list servers without extra Discord calls.
 */
export default {
  name: Events.GuildCreate,
  async execute(client, guild) {
    const logger = getLogger().child('guild');
    logger.info('Guild available', {
      guildId: guild.id,
      name: guild.name,
      members: guild.memberCount,
      locale: guild.preferredLocale ?? null,
    });
    client.metrics.increment('guildsJoined');

    try {
      await client.settings.getGuildSettings(guild.id, { forceRefresh: true });
    } catch (err) {
      logger.warn('Could not warm guild settings cache', { guildId: guild.id, reason: err.message });
    }
  },
};
