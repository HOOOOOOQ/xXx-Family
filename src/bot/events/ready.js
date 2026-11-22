import { Events } from 'discord.js';

import { BRAND } from '../../config/constants.js';
import { getLogger } from '../../utils/logger.js';

/**
 * Boot complete. Logs the real state we now know: shard id, guild count,
 * command count, module states and any non-fatal load errors.
 */
export default {
  name: Events.ClientReady,
  once: true,
  async execute(client, readyClient) {
    const logger = getLogger().child('ready');
    const shardId = client.shard?.ids?.[0] ?? 0;

    logger.info(`${BRAND.name} v${BRAND.version} is online`, {
      user: readyClient.user?.tag ?? readyClient.user?.username,
      userId: readyClient.user?.id,
      shardId,
      guilds: client.guilds.cache.size,
      commands: client.commands.size,
      modules: client.modules.status().map((m) => `${m.name}:${m.state}`),
      defaultLocale: client.config.i18n.defaultLocale,
    });

    if (client.loadErrors.length) {
      logger.warn('Bot started with non-fatal load errors', { errors: client.loadErrors });
    }

    client.metrics.increment('boots');
    client.health.register('gateway', () => ({
      status: client.isReady() ? 'ok' : 'degraded',
      pingMs: client.ws.ping,
      status: client.ws.status,
      guilds: client.guilds.cache.size,
    }));
  },
};
