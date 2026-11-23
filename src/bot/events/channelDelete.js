/**
 * src/bot/events/channelDelete.js
 * ---------------------------------------------------------------------------
 * A channel was deleted.
 *
 * The channel is gone by the time this fires, so `<#id>` would render as
 * `#deleted-channel`. The name is captured from the payload and used as text.
 */

import { Events } from 'discord.js';

import { COLORS } from '../../config/constants.js';
import { safeLog } from './_logHelper.js';
import { channelTypeName } from './channelCreate.js';

export default {
  name: Events.ChannelDelete,

  /** @param {import('../client.js').XxxFamilyClient} client @param {import('discord.js').GuildChannel} channel */
  async execute(client, channel) {
    await safeLog(client, 'channelDelete', async () => {
      if (!channel.guild) return;

      client.metrics.increment('events.channelDelete');

      await client.logging.logEvent({
        guild: channel.guild,
        type: 'channel.delete',
        key: 'channelDelete',
        values: {
          // Deliberately plain text: a mention of a deleted channel is useless
          // and renders as "#deleted-channel" in the client.
          name: `#${channel.name ?? 'unknown'}`,
          moderator: 'unknown',
        },
        channelId: channel.id,
        evidence: {
          name: channel.name,
          kind: channelTypeName(channel),
          parentId: channel.parentId ?? null,
        },
        embed: { color: COLORS.danger },
      });
    });
  },
};
