/**
 * src/bot/events/guildMemberAdd.js
 * ---------------------------------------------------------------------------
 * A member joined. All the actual behaviour lives in WelcomeService so it can
 * be tested without a gateway; this file only translates the Discord payload
 * into a service call and makes sure nothing escapes.
 *
 * A failing welcome must never break the gateway, so the whole body is guarded.
 */

import { Events } from 'discord.js';

import { getLogger } from '../../utils/logger.js';

export default {
  name: Events.GuildMemberAdd,

  /** @param {import('../client.js').XxxFamilyClient} client @param {import('discord.js').GuildMember} member */
  async execute(client, member) {
    const logger = getLogger().child('member');
    client.metrics.increment('members.joined');

    // A partial member has no `user` and no roles; fetch the full object before
    // touching it, and give up cleanly if the fetch fails (deleted account,
    // guild left mid-handshake) rather than throwing into the gateway.
    let full = member;
    if (member.partial) {
      full = await member.fetch().catch((err) => {
        logger.warn('Could not fetch a partial member', { userId: member.id, reason: err.message });
        return null;
      });
      if (!full) return;
    }

    try {
      const result = await client.welcome.welcomeMember(full);
      logger.debug('Welcome processed', {
        guildId: full.guild.id,
        userId: full.id,
        sent: result.sent,
        autoRoles: result.roles.length,
        dm: result.dm,
        rejoin: result.rejoin,
        milestone: result.milestone,
        skipped: result.skipped ?? null,
      });
    } catch (err) {
      // WelcomeService is built not to throw; if it ever does, the member join
      // still has to succeed.
      logger.errorFrom(err, 'Welcome handling failed', { guildId: full.guild?.id, userId: full.id });
    }
  },
};
