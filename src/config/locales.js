/**
 * src/config/locales.js
 * ---------------------------------------------------------------------------
 * Single source of truth for every locale the xXx Family ecosystem ships with.
 *
 * Two different code systems live here and they are NOT interchangeable:
 *
 *  1. `code`  — the internal locale code used by i18next, MongoDB, the API and
 *               the dashboard. Always a full BCP-47 style tag.
 *  2. `discord` — the locale code Discord's API accepts inside
 *               `name_localizations` / `description_localizations`.
 *               Discord only supports a fixed list of 32 locales (verified
 *               against `Object.values(Locale)` from discord.js 14.28.1).
 *               Indonesian is `id` (NOT `id-ID`) and Arabic has no Discord
 *               command-localization entry at all, so it must be skipped or
 *               Discord rejects the whole command registration payload.
 */

export const DEFAULT_LOCALE = 'en-US';

/**
 * @typedef {object} LocaleDefinition
 * @property {string} code         Internal locale code (MongoDB / i18next key).
 * @property {string} name         English name.
 * @property {string} nativeName   Name written in that language.
 * @property {string|null} discord Discord API locale code, or null if unsupported.
 * @property {string} flag         Emoji flag used in select menus.
 * @property {boolean} rtl         Right-to-left writing direction.
 * @property {boolean} primary     Shown first / used as the fallback chain root.
 */

/** @type {LocaleDefinition[]} */
export const LOCALES = [
  {
    code: 'en-US',
    name: 'English (US)',
    nativeName: 'English (US)',
    discord: 'en-US',
    flag: '🇺🇸',
    rtl: false,
    primary: true,
  },
  {
    code: 'en-GB',
    name: 'English (UK)',
    nativeName: 'English (UK)',
    discord: 'en-GB',
    flag: '🇬🇧',
    rtl: false,
    primary: false,
  },
  {
    code: 'id-ID',
    name: 'Indonesian',
    nativeName: 'Bahasa Indonesia',
    discord: 'id',
    flag: '🇮🇩',
    rtl: false,
    primary: true,
  },
  {
    code: 'es-ES',
    name: 'Spanish',
    nativeName: 'Español',
    discord: 'es-ES',
    flag: '🇪🇸',
    rtl: false,
    primary: false,
  },
  {
    code: 'pt-BR',
    name: 'Portuguese (Brazil)',
    nativeName: 'Português (Brasil)',
    discord: 'pt-BR',
    flag: '🇧🇷',
    rtl: false,
    primary: false,
  },
  {
    code: 'fr-FR',
    name: 'French',
    nativeName: 'Français',
    discord: 'fr',
    flag: '🇫🇷',
    rtl: false,
    primary: false,
  },
  {
    code: 'de-DE',
    name: 'German',
    nativeName: 'Deutsch',
    discord: 'de',
    flag: '🇩🇪',
    rtl: false,
    primary: false,
  },
  {
    code: 'ja-JP',
    name: 'Japanese',
    nativeName: '日本語',
    discord: 'ja',
    flag: '🇯🇵',
    rtl: false,
    primary: false,
  },
  {
    code: 'ko-KR',
    name: 'Korean',
    nativeName: '한국어',
    discord: 'ko',
    flag: '🇰🇷',
    rtl: false,
    primary: false,
  },
  {
    code: 'ar',
    name: 'Arabic',
    nativeName: 'العربية',
    // Discord does not accept `ar` in name_localizations/description_localizations.
    discord: null,
    flag: '🇸🇦',
    rtl: true,
    primary: false,
  },
];

/** @type {string[]} Every internal locale code, default locale first. */
export const LOCALE_CODES = [
  DEFAULT_LOCALE,
  ...LOCALES.filter((l) => l.code !== DEFAULT_LOCALE).map((l) => l.code),
];

/** @type {Map<string, LocaleDefinition>} */
export const LOCALE_MAP = new Map(LOCALES.map((l) => [l.code, l]));

/** @type {Set<string>} */
export const LOCALE_CODE_SET = new Set(LOCALE_CODES);

/**
 * i18next fallback chain. Anything unknown falls back to US English so a reply
 * is never half-translated because of a missing key in an exotic locale.
 */
export const FALLBACK_CHAIN = {
  'en-GB': ['en-US'],
  'id-ID': ['en-US'],
  'es-ES': ['en-US'],
  'pt-BR': ['en-US'],
  'fr-FR': ['en-US'],
  'de-DE': ['en-US'],
  'ja-JP': ['en-US'],
  'ko-KR': ['en-US'],
  ar: ['en-US'],
};

/**
 * Discord user/guild locale (e.g. `id`, `en-US`, `pt-BR`, `ar`) mapped to the
 * internal locale code we store and translate with.
 * @param {string|null|undefined} discordLocale
 * @returns {string|null} internal locale code, or null when unrecognised.
 */
export function fromDiscordLocale(discordLocale) {
  if (!discordLocale || typeof discordLocale !== 'string') return null;
  const tag = discordLocale.trim();
  if (LOCALE_CODE_SET.has(tag)) return tag;
  const entry = LOCALES.find((l) => l.discord === tag);
  if (entry) return entry.code;
  // Loose match on the primary subtag: `en-AU` -> en-GB? No — `en` -> en-US,
  // `pt-PT` -> pt-BR would be wrong in tone, so only match exact language bases.
  const base = tag.split('-')[0].toLowerCase();
  const baseMap = { en: 'en-US', id: 'id-ID', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', ja: 'ja-JP', ko: 'ko-KR', ar: 'ar' };
  return baseMap[base] ?? null;
}

/**
 * True when the locale code is one we ship translations for.
 * @param {unknown} code
 * @returns {boolean}
 */
export function isSupportedLocale(code) {
  return typeof code === 'string' && LOCALE_CODE_SET.has(code);
}

/**
 * Direction of a locale, for embeds and dashboard layout.
 * @param {string} code
 * @returns {'ltr'|'rtl'}
 */
export function localeDirection(code) {
  return LOCALE_MAP.get(code)?.rtl ? 'rtl' : 'ltr';
}
