import { Events } from 'discord.js';

import { getLogger } from '../../utils/logger.js';

/**
 * Client-level errors. Logged and counted, never thrown: a gateway hiccup must
 * not take the process down.
 */
export default {
  name: Events.Error,
  async execute(client, error) {
    const logger = getLogger().child('client-error');
    logger.errorFrom(error, 'Discord client error', {
      code: error?.code,
      shardId: client.shard?.ids?.[0] ?? 0,
    });
    client.metrics.increment('clientErrors');
  },
};
