/**
 * src/bot/commands/admin/welcome.js
 * ---------------------------------------------------------------------------
 * /welcome — configuration surface for the welcome module.
 *
 *   /welcome view                show the current configuration
 *   /welcome enable | disable    switch the feature
 *   /welcome channel <channel>   where messages go
 *   /welcome message <text>      custom template (placeholders validated)
 *   /welcome goodbye <text>      custom goodbye template
 *   /welcome roles <role>        grant a role on join
 *   /welcome test                preview without touching counters
 *
 * Every branch requires ManageGuild: these settings control what the bot posts
 * in a public channel and which roles it hands out, so they are not a
 * self-service action.
 */

import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

import { COLORS, LIMITS } from '../../../config/constants.js';
import { LOCALES } from '../../../config/locales.js';
import { brandEmbed } from '../../../utils/embeds.js';
import { PermissionDeniedError, ValidationError } from '../../../utils/errors.js';
import { findUnknownPlaceholders, placeholderCatalogue } from '../../../utils/templates.js';
import { truncate } from '../../../utils/format.js';

/** Text-ish channel types a welcome message can be posted in. */
const ALLOWED_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildPublicThread,
  ChannelType.GuildPrivateThread,
];

function requireGuild(interaction) {
  if (!interaction.inGuild()) {
    throw new PermissionDeniedError('Welcome configuration requires a server', { i18nKey: 'errors:guildOnly' });
  }
}

function requireManageGuild(interaction) {
  requireGuild(interaction);
  if (!interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new PermissionDeniedError('ManageGuild is required to configure welcome messages', {
      i18nKey: 'errors:missingPermissions',
      details: { permissions: 'ManageGuild' },
    });
  }
}

/** Render the /welcome view panel. */
function configEmbed({ t, dir, config, guild }) {
  const channelList = config.channelIds.length
    ? config.channelIds.map((id) => `<#${id}>`).join(', ')
    : t('common:welcomePanel.noChannel');

  const language = config.language
    ? `${LOCALES.find((l) => l.code === config.language)?.flag ?? ''} ${config.language}`
    : t('common:welcomePanel.followGuild');

  return brandEmbed({
    t,
    dir,
    color: config.enabled ? COLORS.neon : COLORS.silver,
    title: `👋 ${t('common:welcomePanel.title')}`,
    fields: [
      {
        name: t('common:welcomePanel.status'),
        value: config.enabled ? t('common:welcomePanel.enabled') : t('common:welcomePanel.disabled'),
        inline: true,
      },
      { name: t('common:welcomePanel.channel'), value: channelList, inline: true },
      { name: t('common:welcomePanel.language'), value: language, inline: true },
      {
        name: t('common:welcomePanel.message'),
        value: config.message ? truncate(config.message, 1000) : `_${t('common:welcomePanel.usingDefault')}_`,
      },
      {
        name: t('common:welcomePanel.autoRoles'),
        value: config.autoRoles.length ? config.autoRoles.map((id) => `<@&${id}>`).join(' ') : t('common:welcomePanel.noAutoRoles'),
        inline: true,
      },
      {
        name: t('common:welcomePanel.dm'),
        value: config.dm.enabled ? '✅' : '❌',
        inline: true,
      },
      {
        name: t('common:welcomePanel.rejoin'),
        value: config.rejoin.detect ? '✅' : '❌',
        inline: true,
      },
      {
        name: t('common:welcomePanel.milestones'),
        value: config.milestones.enabled
          ? t('common:welcomePanel.every', { count: config.milestones.every })
          : '❌',
        inline: true,
      },
    ],
    footer: `${guild.name} • ${guild.id}`,
  });
}

/**
 * The placeholder help line appended to the view panel.
 * Braces are included because that is what the admin actually has to type —
 * listing bare paths would make every first attempt a typo.
 */
function placeholderLine(t) {
  return `**${t('common:welcomePanel.placeholders')}**\n${placeholderCatalogue()
    .map((entry) => `\`{${entry.path}}\``)
    .join(' ')}`;
}

export default {
  data: new SlashCommandBuilder()
    .setName('welcome')
    .setDescription('Configure welcome and goodbye messages for this server.')
    // Guild-only: this configures server behaviour. setContexts() rather than
    // the deprecated setDMPermission(false).
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub.setName('view').setDescription('Show the current welcome configuration.'))
    .addSubcommand((sub) => sub.setName('enable').setDescription('Turn welcome messages on.'))
    .addSubcommand((sub) => sub.setName('disable').setDescription('Turn welcome messages off.'))
    .addSubcommand((sub) =>
      sub
        .setName('channel')
        .setDescription('Set the channel welcome messages are sent to.')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('The channel to use. Choose none to clear.')
            .addChannelTypes(...ALLOWED_CHANNEL_TYPES),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('message')
        .setDescription('Set a custom welcome message template.')
        .addStringOption((option) =>
          option
            .setName('text')
            .setDescription('The message template. Use {user.mention} and {server.name}.')
            .setMaxLength(2000),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('goodbye')
        .setDescription('Set a custom goodbye message template.')
        .addStringOption((option) =>
          option
            .setName('text')
            .setDescription('The message template. Use {user.mention} and {server.name}.')
            .setMaxLength(2000),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('roles')
        .setDescription('Manage the roles granted on join.')
        .addRoleOption((option) =>
          option.setName('role').setDescription('The role to add or remove.').setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('test').setDescription('Send yourself a test welcome message.')),

  category: 'admin',
  cooldown: 3000,

  async execute(interaction, { client, t, dir }) {
    const subcommand = interaction.options.getSubcommand();
    const welcome = client.welcome;

    // `view` is readable by anyone with ManageGuild (enforced by the command's
    // default member permissions), everything else mutates and re-checks.
    if (subcommand !== 'view') requireManageGuild(interaction);
    else requireGuild(interaction);

    const guildId = interaction.guildId;
    const config = await welcome.getWelcomeConfig(guildId);

    switch (subcommand) {
      case 'view': {
        const embed = configEmbed({ t, dir, config, guild: interaction.guild });
        await interaction.reply({
          embeds: [
            embed,
            brandEmbed({ t, dir, color: COLORS.void, description: placeholderLine(t) }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      case 'enable':
      case 'disable': {
        const enabled = subcommand === 'enable';
        if (enabled && !config.channelIds.length) {
          // Turning it on with nowhere to post would look like a silent failure.
          throw new ValidationError('Cannot enable welcome messages without a channel', {
            i18nKey: 'errors:validation',
            // errors:validation interpolates {{reason}}, so the specific,
            // already-localized cause has to be passed under that exact key.
            details: { reason: t('common:welcomePanel.noChannelConfigured') },
          });
        }
        await welcome.saveWelcomeConfig(guildId, { enabled }, interaction.user.id);
        await interaction.reply({
          embeds: [
            brandEmbed({
              t,
              dir,
              variant: enabled ? 'success' : 'warning',
              title: `✅ ${t('common:welcomePanel.saved')}`,
              description: t(enabled ? 'common:welcomePanel.enabledNow' : 'common:welcomePanel.disabledNow'),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      case 'channel': {
        const channel = interaction.options.getChannel('channel');
        if (!channel) {
          await welcome.saveWelcomeConfig(guildId, { channelIds: [], enabled: false }, interaction.user.id);
          await interaction.reply({
            embeds: [
              brandEmbed({
                t,
                dir,
                variant: 'warning',
                title: `🧹 ${t('common:welcomePanel.saved')}`,
                description: t('common:welcomePanel.channelCleared'),
              }),
            ],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (!ALLOWED_CHANNEL_TYPES.includes(channel.type)) {
          throw new ValidationError(`Channel type ${channel.type} cannot receive welcome messages`, {
            i18nKey: 'errors:validation',
            details: { reason: t('common:welcomePanel.unsupportedChannel'), channel: channel.name },
          });
        }

        await welcome.saveWelcomeConfig(
          guildId,
          { channelIds: [channel.id] },
          interaction.user.id,
        );
        await interaction.reply({
          embeds: [
            brandEmbed({
              t,
              dir,
              variant: 'success',
              title: `✅ ${t('common:welcomePanel.saved')}`,
              description: t('common:welcomePanel.channelSet', { channel: `<#${channel.id}>` }),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      case 'message':
      case 'goodbye': {
        const text = interaction.options.getString('text');

        if (!text) {
          // No text = reset to the localized default.
          if (subcommand === 'message') {
            await welcome.saveWelcomeConfig(guildId, { message: null }, interaction.user.id);
          } else {
            await welcome.saveGoodbyeConfig(guildId, { message: null }, interaction.user.id);
          }
          await interaction.reply({
            embeds: [
              brandEmbed({
                t,
                dir,
                variant: 'info',
                title: `↩️ ${t('common:welcomePanel.saved')}`,
                description: t('common:welcomePanel.messageReset'),
              }),
            ],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        // Warn about typos before saving: an unknown placeholder renders as
        // literal text and admins otherwise assume the bot is broken.
        const probe = welcome.buildTemplateValues(interaction.member, { t });
        const unknown = findUnknownPlaceholders(text, probe);
        if (unknown.length) {
          throw new ValidationError(`Unknown template placeholders: ${unknown.join(', ')}`, {
            i18nKey: 'errors:validation',
            details: {
              reason: t('common:welcomePanel.unknownPlaceholder', { placeholders: unknown.join(', ') }),
              unknown,
            },
          });
        }

        if (subcommand === 'message') {
          await welcome.saveWelcomeConfig(guildId, { message: text }, interaction.user.id);
        } else {
          await welcome.saveGoodbyeConfig(guildId, { message: text }, interaction.user.id);
        }
        await interaction.reply({
          embeds: [
            brandEmbed({
              t,
              dir,
              variant: 'success',
              title: `✅ ${t('common:welcomePanel.saved')}`,
              description: t('common:welcomePanel.messageSet'),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      case 'roles': {
        const role = interaction.options.getRole('role', true);

        // The bot's own @everyone role is always position 0; granting it is a
        // no-op at best and a misconfiguration signal.
        if (role.id === interaction.guildId) {
          throw new ValidationError('The @everyone role cannot be an auto role', {
            i18nKey: 'errors:validation',
            details: { reason: t('common:welcomePanel.everyoneRole') },
          });
        }

        const me = interaction.guild.members.me;
        if (me && role.position >= me.roles.highest.position) {
          throw new PermissionDeniedError(
            `Cannot grant ${role.name} — it is above the bot's highest role`,
            {
              i18nKey: 'errors:validation',
              details: { reason: t('common:welcomePanel.roleAboveBot', { role: role.name }) },
            },
          );
        }

        const already = config.autoRoles.includes(role.id);
        const next = already
          ? config.autoRoles.filter((id) => id !== role.id)
          : [...config.autoRoles, role.id].slice(0, LIMITS.maxAutoRoles);

        await welcome.saveWelcomeConfig(guildId, { autoRoles: next }, interaction.user.id);
        await interaction.reply({
          embeds: [
            brandEmbed({
              t,
              dir,
              variant: 'success',
              title: `✅ ${t('common:welcomePanel.saved')}`,
              description: t(already ? 'common:welcomePanel.roleRemoved' : 'common:welcomePanel.roleAdded', {
                role: role.name,
              }),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      case 'test': {
        if (!config.channelIds.length) {
          throw new ValidationError('Cannot send a test without a channel', {
            i18nKey: 'errors:validation',
            details: { reason: t('common:welcomePanel.noChannelConfigured') },
          });
        }
        const result = await welcome.sendTest(interaction.member);
        await interaction.reply({
          embeds: [
            brandEmbed({
              t,
              dir,
              variant: result.sent > 0 ? 'success' : 'error',
              title: `🧪 ${result.sent > 0 ? t('common:welcomePanel.saved') : t('errors:validation')}`,
              description:
                result.sent > 0
                  ? t('common:welcomePanel.testSent', { channel: `<#${config.channelIds[0]}>` })
                  : t('common:welcomePanel.testFailed', { reason: t('common:welcomePanel.noChannel') }),
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

export { configEmbed, placeholderLine, ALLOWED_CHANNEL_TYPES };
