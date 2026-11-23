import { Events } from 'discord.js';

import { getLogger } from '../../utils/logger.js';

/**
 * Left a guild (or it became unavailable). Cache entries are dropped so a
 * rejoin starts from a clean slate; stored data is deliberately kept — the
 * server may come back, and privacy retention is a per-guild policy handled
 * by the dashboard.
 */
export default {
  name: Events.GuildDelete,
  async execute(client, guild) {
    const logger = getLogger().child('guild');
    const unavailable = guild.available === false;
    logger.info(unavailable ? 'Guild unavailable' : 'Removed from guild', {
      guildId: guild.id,
      name: guild.name ?? null,
      unavailable,
    });
    client.metrics.increment(unavailable ? 'guildsUnavailable' : 'guildsLeft');
    client.settings.invalidateGuild(guild.id);
  },
};
