/**
 * src/bot/commands/admin/booster.js
 * ---------------------------------------------------------------------------
 * /booster — server boosting: statistics, leaderboard, history and config.
 *
 * Read subcommands (stats, leaderboard, history, view) are open to everyone in
 * the server; the rest mutate configuration and require ManageGuild.
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
import { discordTimestamp } from '../../../utils/format.js';
import { placeholderCatalogue } from '../../../utils/templates.js';

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

/** Tier names Discord actually uses, so the panel is not invented. */
const TIER_LABELS = { 0: 'None', 1: 'Tier 1', 2: 'Tier 2', 3: 'Tier 3' };

function requireGuild(interaction) {
  if (!interaction.inGuild()) {
    throw new PermissionDeniedError('Booster commands require a server', { i18nKey: 'errors:guildOnly' });
  }
}

function requireManageGuild(interaction) {
  requireGuild(interaction);
  if (!interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new PermissionDeniedError('ManageGuild is required to configure boosters', {
      i18nKey: 'errors:missingPermissions',
      details: { permissions: 'ManageGuild' },
    });
  }
}

/** Read-only subcommands anyone in the server may use. */
const PUBLIC_SUBCOMMANDS = new Set(['stats', 'leaderboard', 'history']);

export default {
  data: new SlashCommandBuilder()
    .setName('booster')
    .setDescription('Server boosting: announcements, booster role, leaderboard and history.')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub.setName('stats').setDescription('Show boosting statistics for this server.'))
    .addSubcommand((sub) => sub.setName('leaderboard').setDescription('Show the longest-running boosters.'))
    .addSubcommand((sub) =>
      sub
        .setName('history')
        .setDescription("Show one member's boost history.")
        .addUserOption((option) => option.setName('user').setDescription('The member to look up.')),
    )
    .addSubcommand((sub) => sub.setName('view').setDescription('Show the booster configuration.'))
    .addSubcommand((sub) => sub.setName('enable').setDescription('Turn booster announcements on.'))
    .addSubcommand((sub) => sub.setName('disable').setDescription('Turn booster announcements off.'))
    .addSubcommand((sub) =>
      sub
        .setName('channel')
        .setDescription('Set the channel booster messages are sent to.')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('The channel to use. Choose none to clear.')
            .addChannelTypes(...TEXT_CHANNELS),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('role')
        .setDescription('Set the role granted while boosting.')
        .addRoleOption((option) =>
          option.setName('role').setDescription('The role to use. Choose none to clear.'),
        ),
    ),

  category: 'admin',
  cooldown: 3000,

  async execute(interaction, { client, t, dir }) {
    const subcommand = interaction.options.getSubcommand();
    const booster = client.booster;
    const guild = interaction.guild;

    if (PUBLIC_SUBCOMMANDS.has(subcommand)) requireGuild(interaction);
    else requireManageGuild(interaction);

    const config = await booster.getConfig(interaction.guildId);

    switch (subcommand) {
      case 'stats': {
        const stats = await booster.getStats(interaction.guildId, guild);
        await interaction.reply({
          embeds: [
            brandEmbed({
              t,
              dir,
              color: COLORS.neon,
              title: `💎 ${t('common:boosterPanel.title')}`,
              fields: [
                { name: t('common:boosterPanel.boostCount'), value: String(stats.boostCount ?? 0), inline: true },
                {
                  name: t('common:boosterPanel.tier'),
                  value: TIER_LABELS[stats.tier ?? 0] ?? String(stats.tier ?? 0),
                  inline: true,
                },
                { name: t('common:boosterPanel.boosters'), value: String(stats.boosters), inline: true },
                { name: t('common:boosterPanel.lifetime'), value: String(stats.lifetime), inline: true },
                { name: t('common:boosterPanel.totalMonths'), value: String(stats.totalMonths), inline: true },
              ],
              footer: `${guild.name} • ${guild.id}`,
            }),
          ],
        });
        return;
      }

      case 'leaderboard': {
        const rows = await booster.getLeaderboard(interaction.guildId, config.leaderboard.limit);
        const body = rows.length
          ? rows
              .map(
                (row, index) =>
                  `**${index + 1}.** <@${row.userId}> — ${t('common:boosterPanel.months', { count: row.months })} (${discordTimestamp(row.since, 'R')})`,
              )
              .join('\n')
          : t('common:boosterPanel.noBoosters');

        await interaction.reply({
          embeds: [
            brandEmbed({
              t,
              dir,
              color: COLORS.neon,
              title: `🏆 ${t('common:boosterPanel.leaderboard')}`,
              description: body,
            }),
          ],
        });
        return;
      }

      case 'history': {
        const user = interaction.options.getUser('user') ?? interaction.user;
        const rows = await booster.getHistory(interaction.guildId, user.id);

        const body = rows.length
          ? rows
              .map(
                (row) =>
                  `• ${discordTimestamp(row.since, 'd')} → ${
                    row.current ? t('common:boosterPanel.since') : discordTimestamp(row.until, 'd')
                  } — ${t('common:boosterPanel.months', { count: row.months })}${row.current ? ' 🟢' : ''}`,
              )
              .join('\n')
          : t('common:boosterPanel.noHistory');

        await interaction.reply({
          embeds: [
            brandEmbed({
              t,
              dir,
              color: COLORS.silver,
              title: `📜 ${t('common:boosterPanel.history')} — ${user.username}`,
              description: body,
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      case 'view': {
        await interaction.reply({
          embeds: [
            brandEmbed({
              t,
              dir,
              color: config.enabled ? COLORS.neon : COLORS.silver,
              title: `💎 ${t('common:boosterPanel.title')}`,
              fields: [
                {
                  name: t('common:boosterPanel.status'),
                  value: config.enabled ? t('common:boosterPanel.enabled') : t('common:boosterPanel.disabled'),
                  inline: true,
                },
                {
                  name: t('common:boosterPanel.channel'),
                  value: config.channelId ? `<#${config.channelId}>` : t('common:boosterPanel.noChannel'),
                  inline: true,
                },
                {
                  name: t('common:boosterPanel.role'),
                  value: config.role.id ? `<@&${config.role.id}>` : t('common:boosterPanel.noRole'),
                  inline: true,
                },
                {
                  name: t('common:boosterPanel.rewards'),
                  value: config.rewards.length
                    ? config.rewards
                        .map((reward) => `${reward.months} ${t('common:boosterPanel.monthsLabel')} → <@&${reward.roleId}>`)
                        .join('\n')
                    : t('common:boosterPanel.noRewards'),
                },
              ],
              footer: placeholderCatalogue()
                .slice(0, 6)
                .map((entry) => `{${entry.path}}`)
                .join(' '),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      case 'enable':
      case 'disable': {
        const enabled = subcommand === 'enable';
        if (enabled && !config.channelId) {
          throw new ValidationError('Cannot enable booster announcements without a channel', {
            i18nKey: 'errors:validation',
            details: { reason: t('common:boosterPanel.noChannelConfigured') },
          });
        }
        await booster.saveConfig(interaction.guildId, { enabled }, interaction.user.id);
        await interaction.reply({
          embeds: [
            brandEmbed({
              t,
              dir,
              variant: enabled ? 'success' : 'warning',
              title: `✅ ${t('common:boosterPanel.saved')}`,
              description: t(enabled ? 'common:boosterPanel.enabledNow' : 'common:boosterPanel.disabledNow'),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      case 'channel': {
        const channel = interaction.options.getChannel('channel');
        if (!channel) {
          await booster.saveConfig(interaction.guildId, { channelId: null, enabled: false }, interaction.user.id);
          await interaction.reply({
            embeds: [
              brandEmbed({
                t,
                dir,
                variant: 'warning',
                title: `🧹 ${t('common:boosterPanel.saved')}`,
                description: t('common:boosterPanel.channelSet', { channel: t('common:boosterPanel.noChannel') }),
              }),
            ],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await booster.saveConfig(interaction.guildId, { channelId: channel.id }, interaction.user.id);
        await interaction.reply({
          embeds: [
            brandEmbed({
              t,
              dir,
              variant: 'success',
              title: `✅ ${t('common:boosterPanel.saved')}`,
              description: t('common:boosterPanel.channelSet', { channel: `<#${channel.id}>` }),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      case 'role': {
        const role = interaction.options.getRole('role');
        if (!role) {
          await booster.saveConfig(interaction.guildId, { 'role.id': null }, interaction.user.id);
          await interaction.reply({
            embeds: [
              brandEmbed({
                t,
                dir,
                variant: 'info',
                title: `↩️ ${t('common:boosterPanel.saved')}`,
                description: t('common:boosterPanel.roleCleared'),
              }),
            ],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (role.id === interaction.guildId) {
          throw new ValidationError('The @everyone role cannot be the booster role', {
            i18nKey: 'errors:validation',
            details: { reason: t('common:welcomePanel.everyoneRole') },
          });
        }

        const me = guild.members.me;
        if (me && role.position >= me.roles.highest.position) {
          throw new ValidationError(`Cannot use ${role.name} as the booster role`, {
            i18nKey: 'errors:validation',
            details: { reason: t('common:boosterPanel.roleAboveBot', { role: role.name }) },
          });
        }

        await booster.saveConfig(interaction.guildId, { 'role.id': role.id }, interaction.user.id);
        await interaction.reply({
          embeds: [
            brandEmbed({
              t,
              dir,
              variant: 'success',
              title: `✅ ${t('common:boosterPanel.saved')}`,
              description: t('common:boosterPanel.roleSet', { role: role.name }),
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

export { TIER_LABELS, PUBLIC_SUBCOMMANDS };
