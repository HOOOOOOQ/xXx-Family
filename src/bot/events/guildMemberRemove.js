/**
 * src/bot/events/guildMemberRemove.js
 * ---------------------------------------------------------------------------
 * A member left, or was kicked/banned.
 *
 * Two things must happen even if the farewell message is disabled:
 *   1. the leave is recorded, so a quick return is greeted as "welcome back"
 *   2. the audit trail gets the event
 *
 * Both live in WelcomeService; this file only adapts the payload.
 *
 * `removed` is best-effort. Discord does not tell this event why the member is
 * gone, so we consult the audit trail: a ban or kick logged in the last few
 * seconds for this user means this is a removal, not a voluntary leave. When
 * the database is offline we cannot tell, and we say so instead of guessing.
 */

import { Events } from 'discord.js';

import { getLogger } from '../../utils/logger.js';

/** A kick/ban audit entry within this window is treated as the cause. */
const REMOVAL_LOOKBACK_MS = 30_000;

/**
 * Was this member just kicked or banned?
 * @returns {Promise<boolean>}
 */
async function wasRemoved(client, guildId, userId, logger) {
  if (!client.logging) return false;
  try {
    const since = Date.now() - REMOVAL_LOOKBACK_MS;
    const result = await client.logging.search({
      guildId,
      type: ['member.ban', 'member.kick'],
      targetId: userId,
      limit: 1,
    });
    const latest = result.entries[0];
    return Boolean(latest && new Date(latest.createdAt).getTime() >= since);
  } catch (err) {
    // No database, or the query failed: we genuinely do not know. Falling back
    // to "not removed" is the honest default and is what skipOnRemoval guards.
    logger.debug('Could not determine whether the member was removed', { userId, reason: err.message });
    return false;
  }
}

export default {
  name: Events.GuildMemberRemove,

  /** @param {import('../client.js').XxxFamilyClient} client @param {import('discord.js').GuildMember} member */
  async execute(client, member) {
    const logger = getLogger().child('member');
    client.metrics.increment('members.left');

    // The event hands us a partial member when the user is no longer cached.
    // `guild` is still present on a partial, which is all we need.
    const guild = member.guild;
    if (!guild) {
      logger.warn('Member left without guild context', { userId: member.id });
      return;
    }

    const removed = await wasRemoved(client, guild.id, member.id, logger);

    try {
      const result = await client.welcome.farewellMember(member, { removed });
      logger.debug('Goodbye processed', {
        guildId: guild.id,
        userId: member.id,
        sent: result.sent,
        removed,
        skipped: result.skipped ?? null,
      });
    } catch (err) {
      logger.errorFrom(err, 'Goodbye handling failed', { guildId: guild.id, userId: member.id });
    }
  },
};
