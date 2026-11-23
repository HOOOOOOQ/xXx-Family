/**
 * src/bot/events/channelCreate.js
 * ---------------------------------------------------------------------------
 * A channel was created. Category changes and permission overwrites are logged
 * as channel.create/config evidence rather than separate event types, so the
 * audit trail stays readable.
 */

import { Events } from 'discord.js';

import { COLORS } from '../../config/constants.js';
import { safeLog } from './_logHelper.js';

/** Human-readable channel type; falls back to the raw number for new types. */
function channelTypeName(channel) {
  const names = {
    0: 'text',
    2: 'voice',
    4: 'category',
    5: 'announcement',
    10: 'announcementThread',
    11: 'publicThread',
    12: 'privateThread',
    13: 'stage',
    14: 'directory',
    15: 'forum',
    16: 'media',
  };
  return names[channel.type] ?? `type-${channel.type}`;
}

export default {
  name: Events.ChannelCreate,

  /** @param {import('../client.js').XxxFamilyClient} client @param {import('discord.js').GuildChannel} channel */
  async execute(client, channel) {
    await safeLog(client, 'channelCreate', async () => {
      // DM channels have no guild and must not be logged.
      if (!channel.guild) return;

      client.metrics.increment('events.channelCreate');

      await client.logging.logEvent({
        guild: channel.guild,
        type: 'channel.create',
        key: 'channelCreate',
        values: { channel: `<#${channel.id}>`, moderator: 'unknown' },
        channelId: channel.id,
        evidence: {
          name: channel.name,
          kind: channelTypeName(channel),
          parentId: channel.parentId ?? null,
          nsfw: Boolean(channel.nsfw),
        },
        embed: { color: COLORS.success },
      });
    });
  },
};

export { channelTypeName };
