import {
  ActionRowBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
  PermissionFlagsBits,
  InteractionContextType,
} from 'discord.js';

import { COLORS } from '../../../config/constants.js';
import { LOCALES, LOCALE_CODE_SET, DEFAULT_LOCALE } from '../../../config/locales.js';
import { brandEmbed } from '../../../utils/embeds.js';
import { PermissionDeniedError, ValidationError } from '../../../utils/errors.js';
import { truncate } from '../../../utils/format.js';
import { translate } from '../../../services/i18nService.js';

/**
 * /language — the entry point of the whole i18n system.
 *
 *   /language user            show the language currently applied to you + why
 *   /language list            every shipped language, with a quick picker
 *   /language set <lang>      store YOUR preference (MongoDB UserSettings)
 *   /language reset           drop YOUR preference
 *   /language server <lang>   set the guild default (ManageGuild required)
 *
 * Nothing here is ephemeral-by-accident: personal changes are ephemeral, the
 * server default is public so the change is visible to moderators.
 */

/** Human readable list of every shipped language. */
function languageTable(activeCode) {
  return LOCALES.map((locale) => {
    const marker = locale.code === activeCode ? ' ✅' : '';
    const translatedName = translate(locale.code, 'common:language.title');
    return `\`${locale.code}\` • ${locale.flag} ${locale.nativeName} — ${translatedName}${marker}`;
  }).join('\n');
}

function languagePicker(t, target, activeCode) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`language:select:${target}`)
    .setPlaceholder(t('components:selects.languagePlaceholder'))
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      LOCALES.map((locale) => ({
        label: truncate(`${locale.flag} ${locale.nativeName}`, 100),
        value: locale.code,
        description: truncate(`${locale.name} • ${locale.code}`, 100),
        default: locale.code === activeCode,
      })),
    );
  return new ActionRowBuilder().addComponents(select);
}

function choices() {
  return LOCALES.map((locale) => ({ name: `${locale.flag} ${locale.nativeName}`, value: locale.code }));
}

export default {
  data: new SlashCommandBuilder()
    .setName('language')
    .setDescription('Manage your language or the language of this server.')
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM)
    .addSubcommand((sub) =>
      sub.setName('user').setDescription('Show the language currently used for you.'),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('List every available language.'))
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Set your personal language.')
        .addStringOption((option) =>
          option.setName('language').setDescription('The language to use.').setRequired(true).addChoices(...choices()),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('reset').setDescription('Reset your personal language to the server default.'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('server')
        .setDescription('Set the default language of this server.')
        .addStringOption((option) =>
          option.setName('language').setDescription('The language to use.').setRequired(true).addChoices(...choices()),
        ),
    ),
  category: 'admin',
  cooldown: 2000,

  /** Quick picker used by `/language list`. */
  async register(client) {
    client.registerComponent('language', async (interaction, ctx) => {
      const locale = interaction.isStringSelectMenu() ? interaction.values[0] : ctx.payload;
      if (!LOCALE_CODE_SET.has(locale)) {
        throw new ValidationError(`Unsupported locale "${locale}"`);
      }
      const target = ctx.action === 'select' ? 'user' : ctx.action; // language:select[:target]
      const isServerTarget = target === 'server';

      if (isServerTarget) {
        const member = interaction.member;
        if (!interaction.inGuild() || !member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
          throw new PermissionDeniedError('ManageGuild is required to change the server language', {
            i18nKey: 'errors:missingPermissions',
            details: { permissions: 'ManageGuild' },
          });
        }
        await client.settings.setGuildLanguage(interaction.guildId, locale, interaction.guild?.name ?? null);
        const fresh = await client.localeService.resolveForGuild(interaction.guildId);
        await interaction.update({
          embeds: [
            brandEmbed({
              t: fresh.t,
              dir: fresh.dir,
              variant: 'success',
              title: `✅ ${fresh.t('common:language.title')}`,
              description: fresh.t('common:language.updatedServer', { language: `${fresh.flag} ${fresh.nativeName}` }),
            }),
          ],
          components: [],
        });
        return;
      }

      await client.settings.setUserLanguage(interaction.user.id, locale, interaction.user.username);
      const fresh = await client.localeService.resolveForUser(interaction.user.id, interaction.guildId);
      await interaction.update({
        embeds: [
          brandEmbed({
            t: fresh.t,
            dir: fresh.dir,
            variant: 'success',
            title: `✅ ${fresh.t('common:language.title')}`,
            description: fresh.t('common:language.updatedPersonal', { language: `${fresh.flag} ${fresh.nativeName}` }),
            fields: [
              { name: fresh.t('common:language.source'), value: fresh.t(`common:language.source${fresh.source.charAt(0).toUpperCase()}${fresh.source.slice(1)}`) },
            ],
          }),
        ],
        components: [],
      });
    });
  },

  async execute(interaction, { client, t, localeContext, dir }) {
    const subcommand = interaction.options.getSubcommand();
    const settings = client.settings;

    switch (subcommand) {
      case 'user': {
        const userSettings = await settings.getUserSettings(interaction.user.id);
        const guildSettings = interaction.guildId ? await settings.getGuildSettings(interaction.guildId) : null;
        const sourceKey = `common:language.source${localeContext.source.charAt(0).toUpperCase()}${localeContext.source.slice(1)}`;

        const embed = brandEmbed({
          t,
          dir,
          color: COLORS.neon,
          title: `🌐 ${t('common:language.title')}`,
          fields: [
            {
              name: t('common:language.current'),
              value: `${localeContext.flag} ${localeContext.nativeName} (\`${localeContext.locale}\`)`,
              inline: true,
            },
            { name: t('common:language.source'), value: t(sourceKey), inline: true },
            {
              name: t('common:language.personal'),
              value: userSettings.language
                ? LOCALES.find((l) => l.code === userSettings.language)?.nativeName ?? userSettings.language
                : t('common:none'),
              inline: true,
            },
            {
              name: t('common:language.server'),
              value: guildSettings?.language
                ? LOCALES.find((l) => l.code === guildSettings.language)?.nativeName ?? guildSettings.language
                : `${t('common:none')} (${DEFAULT_LOCALE})`,
              inline: true,
            },
          ],
          footer: userSettings.persisted || guildSettings?.persisted ? undefined : '⚠️ database offline — preferences are not saved',
        });

        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        return;
      }

      case 'list': {
        const embed = brandEmbed({
          t,
          dir,
          color: COLORS.neon,
          title: `🌐 ${t('common:language.availableTitle')}`,
          description: `${languageTable(localeContext.locale)}\n\n${t('common:language.availableCount', { count: LOCALES.length })}`,
        });
        await interaction.reply({
          embeds: [embed],
          components: [languagePicker(t, 'user', localeContext.locale)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      case 'set': {
        const requested = interaction.options.getString('language', true);
        if (!LOCALE_CODE_SET.has(requested)) throw new ValidationError(`Unsupported locale "${requested}"`);

        await settings.setUserLanguage(interaction.user.id, requested, interaction.user.username);
        const fresh = await client.localeService.resolveForUser(interaction.user.id, interaction.guildId);
        await interaction.reply({
          embeds: [
            brandEmbed({
              t: fresh.t,
              dir: fresh.dir,
              variant: 'success',
              title: `✅ ${fresh.t('common:language.title')}`,
              description: fresh.t('common:language.updatedPersonal', { language: `${fresh.flag} ${fresh.nativeName}` }),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      case 'reset': {
        await settings.resetUserLanguage(interaction.user.id);
        const fresh = await client.localeService.resolveForUser(interaction.user.id, interaction.guildId);
        await interaction.reply({
          embeds: [
            brandEmbed({
              t: fresh.t,
              dir: fresh.dir,
              variant: 'info',
              title: `↩️ ${fresh.t('common:language.title')}`,
              description: fresh.t('common:language.reset'),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      case 'server': {
        if (!interaction.inGuild()) {
          throw new PermissionDeniedError('Server language requires a guild', { i18nKey: 'errors:guildOnly' });
        }
        const member = interaction.member;
        if (!member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
          throw new PermissionDeniedError('ManageGuild is required', {
            i18nKey: 'errors:missingPermissions',
            details: { permissions: 'ManageGuild' },
          });
        }

        const requested = interaction.options.getString('language', true);
        if (!LOCALE_CODE_SET.has(requested)) throw new ValidationError(`Unsupported locale "${requested}"`);

        await settings.setGuildLanguage(interaction.guildId, requested, interaction.guild.name);
        const fresh = await client.localeService.resolveForGuild(interaction.guildId);

        await interaction.reply({
          embeds: [
            brandEmbed({
              t: fresh.t,
              dir: fresh.dir,
              variant: 'success',
              title: `✅ ${fresh.t('common:language.title')}`,
              description: fresh.t('common:language.updatedServer', { language: `${fresh.flag} ${fresh.nativeName}` }),
            }),
          ],
        });
        return;
      }

      default:
        throw new ValidationError(`Unknown subcommand "${subcommand}"`);
    }
  },
};

export { languageTable, languagePicker };
