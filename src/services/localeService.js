/**
 * src/services/localeService.js
 * ---------------------------------------------------------------------------
 * Locale resolution — the bridge between stored preferences (MongoDB), Discord
 * metadata (interaction.locale / guildLocale) and the translation engine.
 *
 * Every reply-producing code path calls {@link LocaleService.resolveForInteraction}
 * and uses the returned bound translator `t`, so a single response can never
 * mix languages: `t` is pinned to one locale for the whole handler.
 */

import { getConfig } from '../config/index.js';
import { fromDiscordLocale, localeDirection, LOCALE_MAP } from '../config/locales.js';
import { getLogger } from '../utils/logger.js';
import { getLocaleContext, getT, resolveLocale } from './i18nService.js';
import { settingsService } from './settingsService.js';

export class LocaleService {
  /**
   * @param {object} [deps]
   * @param {import('./settingsService.js').SettingsService} [deps.settings]
   * @param {ReturnType<typeof getConfig>} [deps.config]
   */
  constructor(deps = {}) {
    this.settings = deps.settings ?? settingsService;
    this.config = deps.config ?? null;
    this.logger = (deps.logger ?? getLogger()).child('locale');
  }

  get defaultLocale() {
    return this.config?.i18n?.defaultLocale ?? getConfig().i18n.defaultLocale;
  }

  /**
   * Resolve the locale for one interaction.
   *
   * @param {import('discord.js').Interaction} interaction
   * @param {object} [options]
   * @param {string|null} [options.moduleName] module producing the reply
   * @param {string[]} [options.roleIds]
   * @returns {Promise<{
   *   locale: string,
   *   source: string,
   *   dir: 'ltr'|'rtl',
   *   nativeName: string,
   *   flag: string,
   *   t: (key: string, options?: Record<string, unknown>) => string
   * }>}
   */
  async resolveForInteraction(interaction, options = {}) {
    const guildId = interaction?.guildId ?? null;
    const userId = interaction?.user?.id ?? null;

    let userPref = null;
    let guildPref = null;
    try {
      const [userSettings, guildSettings] = await Promise.all([
        userId ? this.settings.getUserSettings(userId) : Promise.resolve({ language: null }),
        guildId ? this.settings.getGuildSettings(guildId) : Promise.resolve({ language: null }),
      ]);
      userPref = userSettings?.language ?? null;
      guildPref = guildSettings?.language ?? null;
    } catch (err) {
      // Never let a database hiccup break a reply — fall back to Discord metadata.
      this.logger.errorFrom(err, 'Locale resolution could not read stored preferences', {
        guildId,
        userId,
      });
    }

    const override = guildId
      ? await this.settings
          .findLanguageOverride({
            guildId,
            channelId: interaction?.channelId ?? null,
            moduleName: options.moduleName ?? null,
            roleIds: options.roleIds ?? [],
          })
          .catch(() => null)
      : null;

    const { locale, source } = resolveLocale({
      userLocale: override?.language ?? userPref,
      discordUserLocale: fromDiscordLocale(interaction?.locale),
      guildLocale: guildPref,
      discordGuildLocale: fromDiscordLocale(interaction?.guildLocale),
      defaultLocale: this.defaultLocale,
    });

    return this.buildContext(locale, override ? 'override' : source);
  }

  /**
   * Resolve for a user outside an interaction (DM, scheduler, welcome DM).
   * @param {string} userId
   * @param {string|null} [guildId]
   */
  async resolveForUser(userId, guildId = null) {
    const [userSettings, guildSettings] = await Promise.all([
      userId ? this.settings.getUserSettings(userId) : Promise.resolve({ language: null }),
      guildId ? this.settings.getGuildSettings(guildId) : Promise.resolve({ language: null }),
    ]);
    const { locale, source } = resolveLocale({
      userLocale: userSettings?.language ?? null,
      guildLocale: guildSettings?.language ?? null,
      defaultLocale: this.defaultLocale,
    });
    return this.buildContext(locale, source);
  }

  /**
   * Resolve the language a server-wide message should use (announcements,
   * logs, automod notices).
   * @param {string} guildId
   */
  async resolveForGuild(guildId) {
    const guildSettings = await this.settings.getGuildSettings(guildId);
    const { locale, source } = resolveLocale({
      guildLocale: guildSettings?.language ?? null,
      defaultLocale: this.defaultLocale,
    });
    return this.buildContext(locale, source);
  }

  /**
   * @param {string} locale
   * @param {string} source
   */
  buildContext(locale, source) {
    const context = getLocaleContext(locale);
    return {
      locale: context.code,
      source,
      dir: localeDirection(context.code),
      nativeName: context.nativeName,
      name: context.name,
      flag: context.flag,
      rtl: localeDirection(context.code) === 'rtl',
      t: getT(context.code),
      /** Human readable explanation of why this locale was chosen. */
      sourceKey: `common:language.source${source.charAt(0).toUpperCase()}${source.slice(1)}`,
    };
  }

  /** @param {string} locale */
  describe(locale) {
    const def = LOCALE_MAP.get(locale);
    return def ? `${def.flag} ${def.nativeName} (${def.code})` : locale;
  }
}

export const localeService = new LocaleService();

export default localeService;
