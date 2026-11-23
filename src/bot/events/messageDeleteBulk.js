/**
 * src/bot/events/messageDeleteBulk.js
 * ---------------------------------------------------------------------------
 * A bulk delete (purge) happened. Logged as one entry with a count, not as N
 * delete entries — a 100-message purge must not produce 100 log messages.
 */

import { Events } from 'discord.js';

import { COLORS } from '../../config/constants.js';
import { safeLog } from './_logHelper.js';

export default {
  name: Events.MessageBulkDelete,

  /**
   * @param {import('../client.js').XxxFamilyClient} client
   * @param {import('discord.js').Collection<string, import('discord.js').Message>} messages
   * @param {import('discord.js').TextBasedChannel} channel
   */
  async execute(client, messages, channel) {
    await safeLog(client, 'messageDeleteBulk', async () => {
      if (!channel.guild) return;

      const count = messages.size;
      if (count === 0) return;

      client.metrics.increment('events.messagePurge');

      // Who ran the purge is not in the payload. We attribute it to the audit
      // trail if a purge command recorded one moments ago; otherwise the entry
      // simply has no actor, which is honest.
      const actors = new Set(
        [...messages.values()].map((message) => message.author?.id).filter(Boolean),
      );

      await client.logging.logEvent({
        guild: channel.guild,
        type: 'message.purge',
        key: 'messagePurge',
        values: { count, channel: `<#${channel.id}>` },
        channelId: channel.id,
        evidence: {
          count,
          distinctAuthors: actors.size,
          // Storing 100 message bodies is exactly the "unnecessary sensitive
          // data" the logging policy forbids, so only metadata is kept.
          messageIds: [...messages.keys()].slice(0, 50),
        },
        embed: { color: COLORS.danger },
      });
    });
  },
};
