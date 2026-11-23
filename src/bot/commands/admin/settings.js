import {
  SlashCommandBuilder,
  MessageFlags,
  PermissionFlagsBits,
  InteractionContextType,
} from 'discord.js';

import { COLORS } from '../../../config/constants.js';
import { LOCALE_MAP, DEFAULT_LOCALE } from '../../../config/locales.js';
import { brandEmbed } from '../../../utils/embeds.js';
import { ValidationError } from '../../../utils/errors.js';

/**
 * /settings — inspect this server's xXx Family configuration, or reset it.
 *
 * Requires ManageGuild. `reset` additionally requires typing CONFIRM so the
 * destructive path cannot be triggered by an accidental click.
 */
export default {
  data: new SlashCommandBuilder()
    .setName('settings')
    .setDescription('View or reset the xXx Family configuration of this server.')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub.setName('view').setDescription('Show this server configuration.'))
    .addSubcommand((sub) =>
      sub
        .setName('reset')
        .setDescription('Reset every setting of this server to its default.')
        .addStringOption((option) =>
          option
            .setName('confirm')
            .setDescription('Type CONFIRM to reset. This cannot be undone.')
            .setRequired(true),
        ),
    ),
  category: 'admin',
  cooldown: 5000,
  guildOnly: true,
  userPermissions: ['ManageGuild'],

  async execute(interaction, { client, t, dir }) {
    const subcommand = interaction.options.getSubcommand();
    const settings = client.settings;

    if (subcommand === 'reset') {
      const confirm = interaction.options.getString('confirm', true);
      if (confirm.toUpperCase() !== 'CONFIRM') {
        await interaction.reply({
          embeds: [
            brandEmbed({
              t,
              dir,
              variant: 'warning',
              title: t('commands:responses.settingsResetConfirm'),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await settings.resetGuildSettings(interaction.guildId, { clearAll: true });
      await interaction.reply({
        embeds: [
          brandEmbed({
            t,
            dir,
            variant: 'success',
            title: t('commands:responses.settingsTitle'),
            description: t('commands:responses.settingsResetDone'),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guildSettings = await settings.getGuildSettings(interaction.guildId, { forceRefresh: true });
    const modules = client.modules.status();
    const language = guildSettings.language ? LOCALE_MAP.get(guildSettings.language) : null;

    const moduleLines = modules.length
      ? modules.map((m) => `\`${m.name}\` — ${t(`common:status.${m.state === 'running' ? 'online' : m.state === 'failed' ? 'degraded' : 'unknown'}`)}`).join('\n')
      : t('commands:responses.noModules');

    const embed = brandEmbed({
      t,
      dir,
      color: COLORS.neon,
      title: `⚙️ ${t('commands:responses.settingsTitle')}`,
      fields: [
        { name: t('commands:responses.settingsGuildId'), value: `\`${interaction.guildId}\``, inline: true },
        {
          name: t('common:language.server'),
          value: language ? `${language.flag} ${language.nativeName} (\`${language.code}\`)` : `${t('common:none')} (${DEFAULT_LOCALE})`,
          inline: true,
        },
        {
          name: t('common:fields.commands'),
          value: String(client.commands.size),
          inline: true,
        },
        {
          name: t('commands:responses.modulesLoaded'),
          value: moduleLines.slice(0, 1024),
          inline: false,
        },
        {
          name: t('common:fields.database'),
          value: guildSettings.persisted ? t('common:status.online') : t('common:status.degraded'),
          inline: true,
        },
      ],
    });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};

export const SETTINGS_RESET_TOKEN = 'CONFIRM';
export const assertResetToken = (value) => {
  if (String(value).toUpperCase() !== SETTINGS_RESET_TOKEN) {
    throw new ValidationError('Reset token must be CONFIRM');
  }
  return true;
};
