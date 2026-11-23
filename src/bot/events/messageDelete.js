/**
 * src/bot/events/messageDelete.js
 * ---------------------------------------------------------------------------
 * A message was deleted. Discord does not say who deleted it, so this logs what
 * is actually known (author, channel, content) and does not invent a moderator.
 */

import { Events } from 'discord.js';

import { COLORS } from '../../config/constants.js';
import { safeLog, shouldSkipMessage } from './_logHelper.js';

export default {
  name: Events.MessageDelete,

  /** @param {import('../client.js').XxxFamilyClient} client @param {import('discord.js').Message} message */
  async execute(client, message) {
    await safeLog(client, 'messageDelete', async () => {
      if (!message.guild) return;
      if (shouldSkipMessage(message, client.user?.id)) return;

      client.metrics.increment('events.messageDelete');

      // Partial messages (uncached) have no author or content. We still record
      // that something was deleted, and say the details were unavailable rather
      // than silently producing an empty log.
      const partial = message.partial || !message.author;
      const authorLabel = message.author?.username ?? null;

      await client.logging.logEvent({
        guild: message.guild,
        type: 'message.delete',
        key: 'messageDelete',
        values: {
          author: message.author ? `<@${message.author.id}>` : 'unknown',
          channel: `<#${message.channelId}>`,
        },
        channelId: message.channelId,
        target: message.author ? { id: message.author.id, label: authorLabel } : undefined,
        evidence: {
          messageId: message.id,
          partial,
          content: partial ? null : message.content?.slice(0, 2000) ?? null,
          attachments: message.attachments?.size ?? 0,
        },
        embed: {
          color: COLORS.danger,
          // Content is evidence for moderators, so it is included — but only
          // when we actually have it.
          fields: partial
            ? undefined
            : [{ nameKey: 'common:logs.field.content', value: message.content }],
        },
      });
    });
  },
};
