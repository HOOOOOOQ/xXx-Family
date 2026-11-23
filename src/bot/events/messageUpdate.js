/**
 * src/bot/events/messageUpdate.js
 * ---------------------------------------------------------------------------
 * A message was edited.
 *
 * Two cases are deliberately not logged, because they are noise rather than
 * moderation signal:
 *   - embed-only changes (Discord re-sends the message when a link preview
 *     resolves, which would flood the log on every posted URL)
 *   - messages whose text did not actually change
 */

import { Events } from 'discord.js';

import { COLORS } from '../../config/constants.js';
import { safeLog, shouldSkipMessage } from './_logHelper.js';

export default {
  name: Events.MessageUpdate,

  /**
   * @param {import('../client.js').XxxFamilyClient} client
   * @param {import('discord.js').Message} oldMessage
   * @param {import('discord.js').Message} newMessage
   */
  async execute(client, oldMessage, newMessage) {
    await safeLog(client, 'messageUpdate', async () => {
      if (!newMessage.guild) return;
      if (shouldSkipMessage(newMessage, client.user?.id)) return;
      if (oldMessage.partial || newMessage.partial) return;

      // Embed-only edit (link preview resolving) — not a content change.
      if (oldMessage.content === newMessage.content) {
        client.metrics.increment('events.messageUpdateSkipped');
        return;
      }

      client.metrics.increment('events.messageUpdate');

      await client.logging.logEvent({
        guild: newMessage.guild,
        type: 'message.edit',
        key: 'messageUpdate',
        values: {
          author: `<@${newMessage.author.id}>`,
          channel: `<#${newMessage.channelId}>`,
        },
        channelId: newMessage.channelId,
        target: { id: newMessage.author.id, label: newMessage.author.username },
        evidence: {
          messageId: newMessage.id,
          before: oldMessage.content?.slice(0, 2000) ?? null,
          after: newMessage.content?.slice(0, 2000) ?? null,
        },
        embed: {
          color: COLORS.warning,
          fields: [
            { nameKey: 'common:logs.field.before', value: oldMessage.content },
            { nameKey: 'common:logs.field.after', value: newMessage.content },
          ],
        },
      });
    });
  },
};
