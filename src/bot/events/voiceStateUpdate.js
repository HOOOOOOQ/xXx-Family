/**
 * src/bot/events/voiceStateUpdate.js
 * ---------------------------------------------------------------------------
 * Voice joins, leaves and moves.
 *
 * This is the highest-frequency event the bot listens to, so almost every
 * invocation must end in a cheap early return. In order of cost:
 *
 *   1. no guild, or not a real join/leave/move  → return (no object allocation)
 *   2. the guild has not configured voice logging → return before any I/O
 *
 * Only then does it touch the logging service. A server that does not want
 * voice logs must never pay for them.
 */

import { Events } from 'discord.js';

import { COLORS } from '../../config/constants.js';
import { getLogger } from '../../utils/logger.js';
import { safeLog } from './_logHelper.js';

/**
 * Classify a voice state transition.
 * @returns {'join'|'leave'|'move'|null}
 */
export function classifyVoiceChange(oldState, newState) {
  if (!oldState.channelId && newState.channelId) return 'join';
  if (oldState.channelId && !newState.channelId) return 'leave';
  if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    return 'move';
  }
  // Mute/deafen/self-video/stream changes are not movements.
  return null;
}

export default {
  name: Events.VoiceStateUpdate,

  /**
   * @param {import('../client.js').XxxFamilyClient} client
   * @param {import('discord.js').VoiceState} oldState
   * @param {import('discord.js').VoiceState} newState
   */
  async execute(client, oldState, newState) {
    const change = classifyVoiceChange(oldState, newState);
    if (!change) return;

    const guild = newState.guild ?? oldState.guild;
    if (!guild) return;

    // Temporary voice runs first and is guarded separately: it must not be
    // suppressed by a logging failure, and its own failure must not stop voice
    // logs from being written.
    if (client.tempVoice) {
      try {
        await client.tempVoice.handleVoiceUpdate(
          newState.member ?? oldState.member,
          oldState.channelId,
          newState.channelId,
          guild,
        );
      } catch (err) {
        getLogger()
          .child('tempvoice')
          .errorFrom(err, 'Temporary voice handling failed', {
            guildId: guild.id,
            userId: newState.member?.id ?? oldState.member?.id,
          });
        client.metrics?.increment?.('tempvoice.errors');
      }
    }

    await safeLog(client, 'voiceStateUpdate', async () => {
      // Ignore our own voice presence — the music module joins channels too,
      // and a server does not want its log filled by the bot's own moves.
      if (client.user && newState.member?.id === client.user.id) return;

      client.metrics.increment(`events.voice.${change}`);

      const member = newState.member ?? oldState.member;
      if (!member) return;

      const from = oldState.channelId ? `<#${oldState.channelId}>` : null;
      const to = newState.channelId ? `<#${newState.channelId}>` : null;

      // A "move" is logged as a leave plus a join would double-count; instead it
      // is one entry describing both ends.
      if (change === 'move') {
        await client.logging.logEvent({
          guild,
          type: 'voice.leave',
          key: 'voiceLeave',
          values: { user: `<@${member.id}>`, channel: from },
          target: { id: member.id, label: member.user?.username ?? null },
          evidence: { from: oldState.channelId, to: newState.channelId, move: true },
          embed: { color: COLORS.silver },
        });
        return;
      }

      await client.logging.logEvent({
        guild,
        type: change === 'join' ? 'voice.join' : 'voice.leave',
        key: change === 'join' ? 'voiceJoin' : 'voiceLeave',
        values: { user: `<@${member.id}>`, channel: change === 'join' ? to : from },
        channelId: change === 'join' ? newState.channelId : oldState.channelId,
        target: { id: member.id, label: member.user?.username ?? null },
        evidence: {
          channelId: change === 'join' ? newState.channelId : oldState.channelId,
          joinedAt: change === 'join' ? Date.now() : null,
        },
        embed: { color: change === 'join' ? COLORS.success : COLORS.silver },
      });
    });
  },
};
