/**
 * src/bot/events/guildBanAdd.js
 * ---------------------------------------------------------------------------
 * A member was banned.
 *
 * Discord gives us the ban but not who issued it. Rather than guess, we look
 * for the most recent `member.ban` audit entry for this user; if a moderator
 * used a moderation command the actor is recorded there. When there is no
 * entry (banned from the Discord client directly) the log has no actor and says
 * so, instead of naming an innocent member.
 */

import { Events } from 'discord.js';

import { COLORS } from '../../config/constants.js';
import { safeLog } from './_logHelper.js';

/** How far back a moderation audit entry still counts as "this ban". */
const AUDIT_LOOKBACK_MS = 60_000;

/** @returns {Promise<{ id:string|null, label:string|null, reason:string|null }>} */
async function findActor(client, guildId, userId, logger) {
  try {
    const result = await client.logging.search({ guildId, type: 'member.ban', targetId: userId, limit: 1 });
    const latest = result.entries[0];
    if (!latest) return { id: null, label: null, reason: null };
    if (Date.now() - new Date(latest.createdAt).getTime() > AUDIT_LOOKBACK_MS) {
      return { id: null, label: null, reason: null };
    }
    return { id: latest.actorId, label: latest.actorLabel, reason: latest.reason };
  } catch (err) {
    logger.debug('Could not resolve the ban actor', { userId, reason: err.message });
    return { id: null, label: null, reason: null };
  }
}

export default {
  name: Events.GuildBanAdd,

  /**
   * @param {import('../client.js').XxxFamilyClient} client
   * @param {import('discord.js').GuildBan} ban
   */
  async execute(client, ban) {
    await safeLog(client, 'guildBanAdd', async () => {
      const { guild, user } = ban;
      if (!guild || !user) return;

      client.metrics.increment('events.ban');

      const logger = client.logger.child('ban');
      const actor = await findActor(client, guild.id, user.id, logger);

      await client.logging.logEvent({
        guild,
        type: 'member.ban',
        key: 'memberBan',
        values: {
          user: `<@${user.id}>`,
          moderator: actor.label ? `<@${actor.id}>` : 'unknown',
        },
        actor: actor.id ? { id: actor.id, label: actor.label } : undefined,
        target: { id: user.id, label: user.username },
        reason: actor.reason ?? null,
        evidence: {
          username: user.username,
          accountCreated: user.createdTimestamp ?? null,
          // The ban reason from the audit trail is already stored; do not
          // duplicate large evidence blobs here.
          knownActor: Boolean(actor.id),
        },
        embed: {
          color: COLORS.danger,
          fields: actor.reason ? [{ nameKey: 'common:logs.field.reason', value: actor.reason }] : undefined,
        },
      });
    });
  },
};
