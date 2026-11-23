/**
 * src/bot/events/guildMemberUpdate.js
 * ---------------------------------------------------------------------------
 * Role and nickname changes.
 *
 * This event fires very often (presence, avatar, boost status, voice mute…), so
 * the first job here is deciding whether anything worth logging changed at all.
 * Everything else is discarded before any I/O happens.
 */

import { Events } from 'discord.js';

import { COLORS } from '../../config/constants.js';
import { safeLog } from './_logHelper.js';

/**
 * Compare two role id sets to what was actually added / removed.
 * Both arguments are Sets, so neither can be filtered directly.
 */
function diffRoles(before, after) {
  const added = [...after].filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !after.has(id));
  return { added, removed };
}

export default {
  name: Events.GuildMemberUpdate,

  /**
   * @param {import('../client.js').XxxFamilyClient} client
   * @param {import('discord.js').GuildMember} oldMember
   * @param {import('discord.js').GuildMember} newMember
   */
  async execute(client, oldMember, newMember) {
    await safeLog(client, 'guildMemberUpdate', async () => {
      const guild = newMember.guild;
      if (!guild) return;
      if (oldMember.partial || newMember.partial) return;

      // Boost state. discord.js has no dedicated boost event, so this is the
      // only signal we get — and it is cleared the instant a boost ends, which
      // is why BoosterService has to persist it.
      if (Boolean(oldMember.premiumSince) !== Boolean(newMember.premiumSince)) {
        await client.booster?.handleBoostChange(newMember, oldMember.premiumSince, newMember.premiumSince);
      }

      const beforeRoles = new Set(oldMember.roles.cache.keys());
      const afterRoles = new Set(newMember.roles.cache.keys());
      const { added, removed } = diffRoles(beforeRoles, afterRoles);

      const nicknameBefore = oldMember.nickname ?? null;
      const nicknameAfter = newMember.nickname ?? null;
      const nicknameChanged = nicknameBefore !== nicknameAfter;

      // Nothing we log changed — exit before touching the cache or the network.
      if (!added.length && !removed.length && !nicknameChanged) return;

      // @everyone is always present and must never be reported as a change.
      const addedRoles = added.filter((id) => id !== guild.id);
      const removedRoles = removed.filter((id) => id !== guild.id);
      if (!addedRoles.length && !removedRoles.length && !nicknameChanged) return;

      const formatList = (ids) => (ids.length ? ids.map((id) => `<@&${id}>`).join(' ') : '—');

      if (addedRoles.length || removedRoles.length) {
        client.metrics.increment('events.roleChange');
        await client.logging.logEvent({
          guild,
          type: 'member.role.add',
          key: 'roleChange',
          values: {
            user: `<@${newMember.id}>`,
            added: formatList(addedRoles),
            removed: formatList(removedRoles),
          },
          target: { id: newMember.id, label: newMember.user.username },
          evidence: { added: addedRoles, removed: removedRoles },
          embed: { color: COLORS.neon },
        });
      }

      if (nicknameChanged) {
        client.metrics.increment('events.nicknameChange');
        await client.logging.logEvent({
          guild,
          type: 'member.nickname',
          key: 'nicknameChange',
          values: {
            user: `<@${newMember.id}>`,
            before: nicknameBefore ?? newMember.user.username,
            after: nicknameAfter ?? newMember.user.username,
          },
          target: { id: newMember.id, label: newMember.user.username },
          evidence: { before: nicknameBefore, after: nicknameAfter },
          embed: { color: COLORS.silver },
        });
      }
    });
  },
};
