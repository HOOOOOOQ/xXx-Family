/**
 * src/bot/commands/admin/mod.js
 * ---------------------------------------------------------------------------
 * /mod — the moderator's control surface.
 *
 *   /mod ban <user> [reason] [delete_days]
 *   /mod unban <user_id> [reason]
 *   /mod kick <user> [reason]
 *   /mod timeout <user> <duration> [reason]
 *   /mod untimeout <user> [reason]
 *   /mod warn <user> <reason>
 *   /mod purge <count> [user]
 *   /mod slowmode <seconds> [channel]
 *   /mod lock [channel] [reason]
 *   /mod unlock [channel] [reason]
 *   /mod history [user]
 *
 * The command does no permission checking of its own beyond requiring the
 * server context — ModerationService gates every action, and a check here would
 * be a second copy of the rule that could drift from the first.
 *
 * Confirmation is shown to the moderator only (ephemeral). The affected member
 * is notified separately, by DM, so the outcome is not posted to the channel
 * where it could be screenshotted and argued with.
 */

import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

import { COLORS } from '../../../config/constants.js';
import { brandEmbed } from '../../../utils/embeds.js';
import { PermissionDeniedError, ValidationError } from '../../../utils/errors.js';
import { formatDuration, parseDuration, truncate } from '../../../utils/format.js';

/** Text channels a purge or slowmode can be applied to. */
const MODERABLE_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildPublicThread];

/** How many cases /mod history shows on one page. */
const HISTORY_PAGE_SIZE = 10;

function requireGuild(interaction) {
  if (!interaction.inGuild()) {
    throw new PermissionDeniedError('Moderation requires a server', { i18nKey: 'errors:guildOnly' });
  }
}

/**
 * Resolve a user option to a GuildMember.
 *
 * A bare User is not enough: hierarchy checks and `member.kick()` both need the
 * member object, and a user who is not in the server must be reported as such
 * rather than failing later with a Discord 10013.
 */
function resolveMember(interaction, name = 'user') {
  const member = interaction.options.getMember(name);
  if (!member) {
    throw new ValidationError('That user is not in this server', {
      i18nKey: 'errors:validation',
      details: { reason: 'user is not a member of this server' },
    });
  }
  return member;
}

function resolveChannel(interaction, fallback) {
  const channel = interaction.options.getChannel('channel');
  if (!channel) return fallback;
  if (!MODERABLE_CHANNELS.includes(channel.type)) {
    throw new ValidationError('That channel type cannot be moderated this way', {
      i18nKey: 'errors:validation',
      details: { reason: 'unsupported channel type' },
    });
  }
  return channel;
}

function reasonFrom(interaction) {
  const reason = interaction.options.getString('reason');
  return reason ? truncate(reason, 500) : null;
}

/** The confirmation a moderator sees after an action. */
function resultReply({ t, dir, title, description, caseNumber, dmSent, color = COLORS.success }) {
  const lines = [description];
  if (caseNumber) lines.push(`**${t('common:moderation.panel.case')}** #${caseNumber}`);
  if (dmSent !== undefined) {
    lines.push(dmSent ? `✅ ${t('common:moderation.panel.dmSent')}` : `⚠️ ${t('common:moderation.panel.dmFailed')}`);
  }
  return {
    embeds: [
      brandEmbed({
        t,
        dir,
        variant: 'success',
        color,
        title: `🛡️ ${title}`,
        description: lines.join('\n'),
      }),
    ],
    flags: MessageFlags.Ephemeral,
  };
}

export default {
  data: new SlashCommandBuilder()
    .setName('mod')
    .setDescription('Moderation actions: ban, kick, timeout, warn, purge, lock and history.')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addSubcommand((sub) =>
      sub
        .setName('ban')
        .setDescription('Ban a member from the server.')
        .addUserOption((option) => option.setName('user').setDescription('The member to ban.').setRequired(true))
        .addStringOption((option) => option.setName('reason').setDescription('Why they are being banned.'))
        .addIntegerOption((option) =>
          option
            .setName('delete_days')
            .setDescription('Days of their messages to delete (0-7).')
            .setMinValue(0)
            .setMaxValue(7),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('unban')
        .setDescription('Remove a ban by user ID.')
        .addStringOption((option) => option.setName('user_id').setDescription("The banned user's ID.").setRequired(true))
        .addStringOption((option) => option.setName('reason').setDescription('Why the ban is being lifted.')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('kick')
        .setDescription('Remove a member from the server.')
        .addUserOption((option) => option.setName('user').setDescription('The member to kick.').setRequired(true))
        .addStringOption((option) => option.setName('reason').setDescription('Why they are being kicked.')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('timeout')
        .setDescription('Temporarily prevent a member from talking.')
        .addUserOption((option) => option.setName('user').setDescription('The member to time out.').setRequired(true))
        .addStringOption((option) =>
          option
            .setName('duration')
            .setDescription('How long, e.g. 10m, 2h, 1d (max 28d).')
            .setRequired(true),
        )
        .addStringOption((option) => option.setName('reason').setDescription('Why they are being timed out.')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('untimeout')
        .setDescription('Lift a timeout early.')
        .addUserOption((option) => option.setName('user').setDescription('The member to release.').setRequired(true))
        .addStringOption((option) => option.setName('reason').setDescription('Why the timeout is being lifted.')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('warn')
        .setDescription('Record a warning against a member.')
        .addUserOption((option) => option.setName('user').setDescription('The member to warn.').setRequired(true))
        .addStringOption((option) => option.setName('reason').setDescription('What they did.').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('purge')
        .setDescription('Bulk-delete recent messages in a channel.')
        .addIntegerOption((option) =>
          option.setName('count').setDescription('How many messages to delete (1-100).').setRequired(true).setMinValue(1).setMaxValue(100),
        )
        .addUserOption((option) => option.setName('user').setDescription("Only delete this member's messages."))
        .addChannelOption((option) =>
          option.setName('channel').setDescription('The channel to purge. Defaults to this one.').addChannelTypes(...MODERABLE_CHANNELS),
        )
        .addStringOption((option) => option.setName('reason').setDescription('Why the messages are being removed.')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('slowmode')
        .setDescription('Set the per-user message delay for a channel.')
        .addIntegerOption((option) =>
          option
            .setName('seconds')
            .setDescription('Delay in seconds. 0 turns it off.')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(21600),
        )
        .addChannelOption((option) =>
          option.setName('channel').setDescription('The channel to change. Defaults to this one.').addChannelTypes(...MODERABLE_CHANNELS),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('lock')
        .setDescription('Stop everyone from sending messages in a channel.')
        .addChannelOption((option) =>
          option.setName('channel').setDescription('The channel to lock. Defaults to this one.').addChannelTypes(...MODERABLE_CHANNELS),
        )
        .addStringOption((option) => option.setName('reason').setDescription('Why the channel is being locked.')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('unlock')
        .setDescription('Reopen a locked channel.')
        .addChannelOption((option) =>
          option.setName('channel').setDescription('The channel to unlock. Defaults to this one.').addChannelTypes(...MODERABLE_CHANNELS),
        )
        .addStringOption((option) => option.setName('reason').setDescription('Why the channel is being reopened.')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('history')
        .setDescription("Show a member's moderation history.")
        .addUserOption((option) => option.setName('user').setDescription('The member to look up. Defaults to you.')),
    ),

  category: 'admin',
  cooldown: 3000,

  async execute(interaction, { client, t, dir }) {
    requireGuild(interaction);

    const subcommand = interaction.options.getSubcommand();
    const moderation = client.moderation;
    const guild = interaction.guild;
    const moderator = interaction.member;

    if (!moderation) {
      throw new ValidationError('The moderation module is not running', {
        i18nKey: 'errors:validation',
        details: { reason: 'moderation module unavailable' },
      });
    }

    switch (subcommand) {
      case 'ban': {
        const target = resolveMember(interaction);
        const result = await moderation.ban({
          guild,
          target,
          moderator,
          reason: reasonFrom(interaction),
          deleteMessageDays: interaction.options.getInteger('delete_days') ?? 0,
        });
        await interaction.reply(
          resultReply({
            t,
            dir,
            title: t('common:moderation.done.ban', { target: target.user.username }),
            description: `<@${target.id}>`,
            caseNumber: result.caseNumber,
            dmSent: result.dmSent,
            color: COLORS.danger,
          }),
        );
        return;
      }

      case 'unban': {
        const userId = interaction.options.getString('user_id').trim();
        // A snowflake is 17-20 digits; anything else is a username, and passing
        // that to the API produces a confusing 10013.
        if (!/^\d{17,20}$/.test(userId)) {
          throw new ValidationError("Provide the user's ID, not their name", {
            i18nKey: 'errors:validation',
            details: { reason: 'a numeric user ID is required' },
          });
        }
        const result = await moderation.unban({ guild, userId, moderator, reason: reasonFrom(interaction) });
        await interaction.reply(
          resultReply({
            t,
            dir,
            title: t('common:moderation.done.unban', { target: userId }),
            description: `<@${userId}>`,
            caseNumber: result.caseNumber,
            color: COLORS.success,
          }),
        );
        return;
      }

      case 'kick': {
        const target = resolveMember(interaction);
        const result = await moderation.kick({ guild, target, moderator, reason: reasonFrom(interaction) });
        await interaction.reply(
          resultReply({
            t,
            dir,
            title: t('common:moderation.done.kick', { target: target.user.username }),
            description: `<@${target.id}>`,
            caseNumber: result.caseNumber,
            dmSent: result.dmSent,
            color: COLORS.warning,
          }),
        );
        return;
      }

      case 'timeout': {
        const target = resolveMember(interaction);
        const raw = interaction.options.getString('duration');
        const ms = parseDuration(raw);
        if (ms === null || ms <= 0) {
          throw new ValidationError(`Could not read "${raw}" as a duration`, {
            i18nKey: 'errors:validation',
            details: { reason: 'use a form like 10m, 2h or 1d' },
          });
        }

        const result = await moderation.timeout({
          guild,
          target,
          moderator,
          reason: reasonFrom(interaction),
          durationMs: ms,
        });
        await interaction.reply(
          resultReply({
            t,
            dir,
            title: t('common:moderation.done.timeout', {
              target: target.user.username,
              duration: formatDuration(ms, t),
            }),
            description: `<@${target.id}>`,
            caseNumber: result.caseNumber,
            dmSent: result.dmSent,
            color: COLORS.warning,
          }),
        );
        return;
      }

      case 'untimeout': {
        const target = resolveMember(interaction);
        const result = await moderation.untimeout({ guild, target, moderator, reason: reasonFrom(interaction) });
        await interaction.reply(
          resultReply({
            t,
            dir,
            title: t('common:moderation.done.untimeout', { target: target.user.username }),
            description: `<@${target.id}>`,
            caseNumber: result.caseNumber,
            color: COLORS.success,
          }),
        );
        return;
      }

      case 'warn': {
        const target = resolveMember(interaction);
        const result = await moderation.warn({ guild, target, moderator, reason: reasonFrom(interaction) });
        await interaction.reply(
          resultReply({
            t,
            dir,
            title: t('common:moderation.done.warn', { target: target.user.username }),
            description: `<@${target.id}>`,
            caseNumber: result.caseNumber,
            dmSent: result.dmSent,
            color: COLORS.warning,
          }),
        );
        return;
      }

      case 'purge': {
        const channel = resolveChannel(interaction, interaction.channel);
        const result = await moderation.purge({
          guild,
          channel,
          moderator,
          count: interaction.options.getInteger('count'),
          filterUserId: interaction.options.getUser('user')?.id ?? null,
          reason: reasonFrom(interaction),
        });
        await interaction.reply(
          resultReply({
            t,
            dir,
            title: t('common:moderation.done.purge', { count: String(result.deleted) }),
            description: `<#${channel.id}>`,
            caseNumber: result.caseNumber,
            color: COLORS.info,
          }),
        );
        return;
      }

      case 'slowmode': {
        const channel = resolveChannel(interaction, interaction.channel);
        const seconds = interaction.options.getInteger('seconds');
        const result = await moderation.slowmode({ guild, channel, moderator, seconds, reason: reasonFrom(interaction) });
        await interaction.reply(
          resultReply({
            t,
            dir,
            title:
              seconds === 0
                ? t('common:moderation.done.slowmodeOff', { channel: `<#${channel.id}>` })
                : t('common:moderation.done.slowmode', {
                    channel: `<#${channel.id}>`,
                    duration: formatDuration(seconds * 1000, t),
                  }),
            description: `<#${channel.id}>`,
            caseNumber: result.caseNumber,
            color: COLORS.info,
          }),
        );
        return;
      }

      case 'lock':
      case 'unlock': {
        const channel = resolveChannel(interaction, interaction.channel);
        const result =
          subcommand === 'lock'
            ? await moderation.lock({ guild, channel, moderator, reason: reasonFrom(interaction) })
            : await moderation.unlock({ guild, channel, moderator, reason: reasonFrom(interaction) });

        await interaction.reply(
          resultReply({
            t,
            dir,
            title: t(`common:moderation.done.${subcommand}`, { channel: `<#${channel.id}>` }),
            description: `<#${channel.id}>`,
            caseNumber: result.caseNumber,
            color: subcommand === 'lock' ? COLORS.danger : COLORS.success,
          }),
        );
        return;
      }

      case 'history': {
        // `user` is optional here, so this must not throw when it is absent.
        const target = interaction.options.getMember('user') ?? interaction.member;
        const history = await moderation.getHistory(guild.id, target.id, { limit: HISTORY_PAGE_SIZE });

        if (history.entries.length === 0) {
          await interaction.reply({
            embeds: [
              brandEmbed({
                t,
                dir,
                variant: 'info',
                title: `🛡️ ${t('common:moderation.panel.history')}`,
                description: t('common:moderation.panel.noHistory'),
              }),
            ],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const lines = history.entries.map((entry) => {
          const when = `<t:${Math.floor(new Date(entry.createdAt).getTime() / 1000)}:R>`;
          const who = entry.moderatorId ? `<@${entry.moderatorId}>` : t('common:moderation.panel.automod');
          const strike = entry.revokedAt ? '~~' : '';
          return `${strike}\`#${entry.caseNumber}\` **${entry.type}** — ${entry.reason ?? t('common:moderation.panel.noReason')} (${who}, ${when})${strike}`;
        });

        await interaction.reply({
          embeds: [
            brandEmbed({
              t,
              dir,
              variant: 'info',
              title: `🛡️ ${t('common:moderation.panel.history')} — ${target.user.username}`,
              description: lines.join('\n'),
              // brandEmbed takes a string here, not { text } — passing an object
              // renders as "[object Object]" in the footer.
              footer: `${t('common:moderation.panel.totalCases')}: ${history.total}`,
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      default:
        throw new ValidationError(`Unknown subcommand "${subcommand}"`, {
          i18nKey: 'errors:validation',
          details: { reason: subcommand },
        });
    }
  },
};

export { resolveMember, resolveChannel, reasonFrom, MODERABLE_CHANNELS, HISTORY_PAGE_SIZE };
