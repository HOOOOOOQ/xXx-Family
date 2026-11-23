/**
 * src/bot/events/guildBanRemove.js
 * ---------------------------------------------------------------------------
 * A ban was lifted. Same actor-resolution rule as guildBanAdd: name the
 * moderator only when the audit trail actually records one.
 */

import { Events } from 'discord.js';

import { COLORS } from '../../config/constants.js';
import { safeLog } from './_logHelper.js';

export default {
  name: Events.GuildBanRemove,

  /** @param {import('../client.js').XxxFamilyClient} client @param {import('discord.js').GuildBan} ban */
  async execute(client, ban) {
    await safeLog(client, 'guildBanRemove', async () => {
      const { guild, user } = ban;
      if (!guild || !user) return;

      client.metrics.increment('events.unban');

      // The member is no longer in the guild, so the only reliable record of
      // who unbanned them is our own audit trail.
      let actor = { id: null, label: null };
      try {
        const result = await client.logging.search({ guildId: guild.id, type: 'member.unban', targetId: user.id, limit: 1 });
        const latest = result.entries[0];
        if (latest && Date.now() - new Date(latest.createdAt).getTime() <= 60_000) {
          actor = { id: latest.actorId, label: latest.actorLabel };
        }
      } catch {
        // No database: log without an actor rather than failing the entry.
      }

      await client.logging.logEvent({
        guild,
        type: 'member.unban',
        key: 'memberUnban',
        values: {
          user: `<@${user.id}>`,
          moderator: actor.label ? `<@${actor.id}>` : 'unknown',
        },
        actor: actor.id ? { id: actor.id, label: actor.label } : undefined,
        target: { id: user.id, label: user.username },
        evidence: { username: user.username, knownActor: Boolean(actor.id) },
        embed: { color: COLORS.success },
      });
    });
  },
};
