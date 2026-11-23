import { Events } from 'discord.js';

import { getLogger } from '../../utils/logger.js';

/** Shard lifecycle events, collapsed into one file so the gateway story is readable. */
const logger = () => getLogger().child('shard');

export const shardReady = {
  name: Events.ShardReady,
  async execute(client, shardId) {
    logger().info('Shard ready', { shardId });
    client.metrics.increment('shardReady');
  },
};

export const shardReconnecting = {
  name: Events.ShardReconnecting,
  async execute(client, shardId) {
    logger().warn('Shard reconnecting', { shardId });
    client.metrics.increment('shardReconnecting');
  },
};

export const shardResume = {
  name: Events.ShardResume,
  async execute(client, shardId, replayedEvents) {
    logger().info('Shard resumed', { shardId, replayedEvents });
  },
};

export const shardDisconnect = {
  name: Events.ShardDisconnect,
  async execute(client, closeEvent, shardId) {
    logger().warn('Shard disconnected', {
      shardId,
      code: closeEvent?.code,
      reason: closeEvent?.reason,
      wasClean: closeEvent?.wasClean,
    });
    client.metrics.increment('shardDisconnect');
  },
};

export const shardError = {
  name: Events.ShardError,
  async execute(client, error, shardId) {
    logger().errorFrom(error, 'Shard error', { shardId });
    client.metrics.increment('shardErrors');
  },
};

export const invalidated = {
  name: Events.Invalidated,
  async execute(client) {
    logger().error('Session invalidated by Discord — the client must restart');
    client.metrics.increment('sessionInvalidated');
    // Exit non-zero so the process manager (Termux/PM2/systemd) restarts us.
    client.stop('invalidated').finally(() => process.exit(1));
  },
};

export default shardReady;
