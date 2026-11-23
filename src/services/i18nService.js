/**
 * src/services/i18nService.js
 * ---------------------------------------------------------------------------
 * Translation manager.
 *
 * Rules this module enforces:
 *  • Translations live in structured JSON files under `src/locales/<code>/<ns>.json`.
 *    Nothing is "translated at runtime" — every string a user can see is a key.
 *  • A reply is always rendered in ONE locale. `getT(locale)` returns a bound
 *    translator whose fallback chain is fixed, so a single message can never
 *    mix languages unexpectedly (a missing key falls back to en-US, which is
 *    the documented, deterministic behaviour — not a random mixture).
 *  • Discord only accepts 32 locale codes in `name_localizations` (Indonesian
 *    is `id`, Arabic is unsupported). `commandLocalizations()` maps our codes
 *    and silently skips the ones Discord would reject, so command registration
 *    never fails because of a locale.
 */

import i18next from 'i18next';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LOCALES_DIR } from '../config/index.js';
import {
  DEFAULT_LOCALE,
  FALLBACK_CHAIN,
  LOCALES,
  LOCALE_MAP,
  isSupportedLocale,
  localeDirection,
} from '../config/locales.js';
import { LocaleError } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';

/** Namespaces every locale must ship. */
export const NAMESPACES = Object.freeze(['common', 'commands', 'errors', 'components']);

/**
 * Discord's command-name rule (the same pattern @discordjs/builders enforces).
 * It allows any Unicode letter, so Japanese/Korean/Arabic names are valid —
 * but the *default* (non-localized) name must additionally be lowercase ASCII.
 */
export const DISCORD_COMMAND_NAME_RE = /^[-_\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;

/**
 * @param {string} value
 * @param {object} [options]
 * @param {boolean} [options.requireLowercaseAscii] true for the default name
 * @returns {boolean}
 */
export function isDiscordCommandName(value, options = {}) {
  if (typeof value !== 'string' || !DISCORD_COMMAND_NAME_RE.test(value)) return false;
  if (options.requireLowercaseAscii) return /^[a-z0-9][a-z0-9-_]{0,31}$/.test(value);
  return !/[A-Z]/.test(value);
}

let instance = null;
const loadedLocales = new Set();
const loadedNamespaces = new Map(); // locale -> Set<ns>
const missingKeys = new Map(); // locale -> Map<key, count>

/** @returns {ReturnType<typeof getLogger>} */
const log = () => getLogger().child('i18n');

function recordMissing(locale, key) {
  if (!missingKeys.has(locale)) missingKeys.set(locale, new Map());
  const bucket = missingKeys.get(locale);
  bucket.set(key, (bucket.get(key) ?? 0) + 1);
}

/**
 * Read every namespace file for one locale from disk.
 * @param {string} locale
 * @param {string} [dir]
 * @returns {Promise<Record<string, object>>} namespace -> bundle
 */
export async function readLocaleBundles(locale, dir = LOCALES_DIR) {
  const bundles = {};
  const entries = await readdir(dir).catch((err) => {
    throw new LocaleError(`Cannot read locales directory "${dir}": ${err.message}`, { cause: err });
  });
  if (!entries.includes(locale)) {
    throw new LocaleError(`No translation folder found for locale "${locale}" in ${dir}`);
  }
  for (const ns of NAMESPACES) {
    const file = join(dir, locale, `${ns}.json`);
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      throw new LocaleError(`Missing translation file ${file}`, { cause: err });
    }
    try {
      bundles[ns] = JSON.parse(raw);
    } catch (err) {
      throw new LocaleError(`Invalid JSON in ${file}: ${err.message}`, { cause: err });
    }
  }
  return bundles;
}

/**
 * Boot the translation engine.
 * @param {object} [options]
 * @param {string[]} [options.locales]     locales to load (default: all shipped)
 * @param {string}   [options.defaultLocale]
 * @param {string}   [options.localesDir]
 * @returns {Promise<{ loaded: string[], skipped: string[] }>}
 */
export async function initI18n(options = {}) {
  const logger = log();
  const defaultLocale = isSupportedLocale(options.defaultLocale) ? options.defaultLocale : DEFAULT_LOCALE;
  const dir = options.localesDir ?? LOCALES_DIR;
  const requested = options.locales?.length ? options.locales : LOCALES.map((l) => l.code);

  const resources = {};
  const loaded = [];
  const skipped = [];

  for (const locale of requested) {
    if (!isSupportedLocale(locale)) {
      logger.warn('Skipping unsupported locale', { locale });
      skipped.push(locale);
      continue;
    }
    try {
      resources[locale] = await readLocaleBundles(locale, dir);
      loadedLocales.add(locale);
      loadedNamespaces.set(locale, new Set(NAMESPACES));
      loaded.push(locale);
    } catch (err) {
      logger.errorFrom(err, 'Failed to load locale', { locale });
      skipped.push(locale);
    }
  }

  if (!resources[DEFAULT_LOCALE]) {
    // en-US is the fallback root; without it nothing can be rendered safely.
    resources[DEFAULT_LOCALE] = await readLocaleBundles(DEFAULT_LOCALE, dir);
    loadedLocales.add(DEFAULT_LOCALE);
    loadedNamespaces.set(DEFAULT_LOCALE, new Set(NAMESPACES));
    if (!loaded.includes(DEFAULT_LOCALE)) loaded.push(DEFAULT_LOCALE);
  }

  instance = i18next.createInstance();
  await instance.init({
    lng: resources[defaultLocale] ? defaultLocale : DEFAULT_LOCALE,
    fallbackLng: { ...FALLBACK_CHAIN, default: [DEFAULT_LOCALE] },
    resources,
    ns: [...NAMESPACES],
    defaultNS: 'common',
    interpolation: { escapeValue: false, skipOnVariables: true },
    returnEmptyString: false,
    returnNull: false,
    ignoreJSONStructure: false,
    // i18next only invokes `missingKeyHandler` when saveMissing is on. There is
    // no backend attached, so nothing is written anywhere — this exists purely
    // to record missing keys as runtime telemetry (exposed on /health).
    saveMissing: true,
    saveMissingTo: 'current',
    parseMissingKeyHandler: (key) => key,
    missingKeyHandler: (lngs, ns, key) => {
      for (const lng of lngs ?? []) recordMissing(lng, `${ns}:${key}`);
    },
  });

  logger.info('Translations ready', {
    defaultLocale,
    locales: loaded,
    namespaces: NAMESPACES,
    skipped: skipped.length ? skipped : undefined,
  });

  return { loaded, skipped, defaultLocale: instance.language };
}

/** @returns {boolean} */
export function isI18nReady() {
  return instance !== null && instance.isInitialized === true;
}

/** @returns {string[]} internal locale codes currently loaded. */
export function getLoadedLocales() {
  return [...loadedLocales];
}

/** @returns {string[]} */
export function getLoadedNamespaces(locale) {
  return [...(loadedNamespaces.get(locale) ?? [])];
}

/** @returns {i18next.i18n|null} the underlying i18next instance (advanced use). */
export function getI18nInstance() {
  return instance;
}

function assertReady() {
  if (!isI18nReady()) {
    throw new LocaleError('i18n has not been initialised yet — call initI18n() first.');
  }
}

/**
 * Translate one key in one locale.
 * @param {string} locale
 * @param {string} key      `namespace:key` (default namespace: `common`)
 * @param {Record<string, unknown>} [options] interpolation values
 * @returns {string}
 */
export function translate(locale, key, options = {}) {
  assertReady();
  return instance.t(key, { ...options, lng: locale });
}

/**
 * Bound translator for a single locale — use this inside a command so the
 * whole reply stays in one language.
 * @param {string} locale
 * @param {string|string[]} [ns]
 * @returns {(key:string, options?:Record<string, unknown>) => string}
 */
export function getT(locale, ns) {
  assertReady();
  const lng = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  const fixed = instance.getFixedT(lng, ns ?? null);
  return (key, options = {}) => fixed(key, options);
}

/**
 * Locale metadata bundle used when rendering embeds and components.
 * @param {string} locale
 * @returns {{ code:string, name:string, nativeName:string, flag:string, dir:'ltr'|'rtl', t:(k:string,o?:object)=>string }}
 */
export function getLocaleContext(locale) {
  const code = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  const def = LOCALE_MAP.get(code);
  return {
    code,
    name: def?.name ?? code,
    nativeName: def?.nativeName ?? code,
    flag: def?.flag ?? '🌐',
    dir: localeDirection(code),
    t: getT(code),
  };
}

/**
 * Pick the locale to answer with.
 * Priority (highest first):
 *   1. `user`          — language the member explicitly chose (`/language set`)
 *   2. `discordUser`   — the Discord client locale of the member
 *   3. `guild`         — server default configured by an administrator
 *   4. `discordGuild`  — the Discord community locale of the server
 *   5. `default`       — DEFAULT_LANGUAGE from the environment, then en-US
 *
 * @param {object} sources
 * @param {string|null} [sources.userLocale]
 * @param {string|null} [sources.discordUserLocale]
 * @param {string|null} [sources.guildLocale]
 * @param {string|null} [sources.discordGuildLocale]
 * @param {string|null} [sources.defaultLocale]
 * @param {string[]} [sources.priority]
 * @returns {{ locale:string, source:'user'|'discordUser'|'guild'|'discordGuild'|'default'|'fallback' }}
 */
export function resolveLocale(sources = {}) {
  const priority = sources.priority ?? ['user', 'discordUser', 'guild', 'discordGuild', 'default'];
  const candidates = {
    user: sources.userLocale ?? null,
    discordUser: sources.discordUserLocale ?? null,
    guild: sources.guildLocale ?? null,
    discordGuild: sources.discordGuildLocale ?? null,
    default: sources.defaultLocale ?? DEFAULT_LOCALE,
  };

  for (const key of priority) {
    const value = candidates[key];
    if (value && isSupportedLocale(value) && loadedLocales.has(value)) {
      return { locale: value, source: /** @type {any} */ (key) };
    }
  }
  return { locale: DEFAULT_LOCALE, source: 'fallback' };
}

/** @param {string} key */
function sanitizeCommandName(key) {
  const cleaned = String(key)
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^-_\p{L}\p{N}]/gu, '')
    .slice(0, 32);
  return isDiscordCommandName(cleaned) ? cleaned : null;
}

/** @param {string} value */
function sanitizeDescription(value) {
  const cleaned = String(value).trim().replace(/\s+/g, ' ').slice(0, 100);
  return cleaned.length >= 1 ? cleaned : null;
}

/**
 * Build Discord `name_localizations` / `description_localizations` for a key.
 * Locales Discord does not accept (Arabic) are skipped instead of breaking the
 * whole registration payload.
 *
 * @param {string} key i18n key inside the `commands` namespace
 * @returns {{ nameLocalizations: Record<string,string>, descriptionLocalizations: Record<string,string> }}
 */
export function commandLocalizations(key) {
  assertReady();
  const nameLocalizations = {};
  const descriptionLocalizations = {};

  for (const def of LOCALES) {
    if (!def.discord || !loadedLocales.has(def.code)) continue;

    // `exists` is checked WITHOUT the fallback chain: if this locale does not
    // define the key we send nothing for it and Discord falls back to the
    // default (English) name. Translating anyway would emit the raw key.
    const nameKey = `commands:${key}.name`;
    const descriptionKey = `commands:${key}.description`;

    if (instance.exists(nameKey, { lng: def.code, fallbackLng: false })) {
      const name = sanitizeCommandName(instance.t(nameKey, { lng: def.code }));
      if (name) nameLocalizations[def.discord] = name;
    }
    if (instance.exists(descriptionKey, { lng: def.code, fallbackLng: false })) {
      const description = sanitizeDescription(instance.t(descriptionKey, { lng: def.code }));
      if (description) descriptionLocalizations[def.discord] = description;
    }
  }

  return { nameLocalizations, descriptionLocalizations };
}

/**
 * True when every loaded locale defines `commands:<key>.name`.
 * Used by the loader to decide between a nested and a shared option key.
 * @param {string} key
 */
export function hasCommandLocalization(key) {
  if (!isI18nReady()) return false;
  const nameKey = `commands:${key}.name`;
  return [...loadedLocales].some((lng) => instance.exists(nameKey, { lng, fallbackLng: false }));
}

/**
 * Same as {@link commandLocalizations} but for a command option.
 * @param {string} commandKey
 * @param {string} optionName
 */
export function optionLocalizations(commandKey, optionName) {
  return commandLocalizations(`${commandKey}.options.${optionName}`);
}

/**
 * Runtime telemetry: which keys were missing per locale since boot.
 * @returns {Record<string, Record<string, number>>}
 */
export function getMissingKeys() {
  const out = {};
  for (const [locale, bucket] of missingKeys) out[locale] = Object.fromEntries(bucket);
  return out;
}

/** Clear the missing-key telemetry (tests). */
export function clearMissingKeys() {
  missingKeys.clear();
}

/** Tear the engine down (tests / graceful shutdown). */
export async function shutdownI18n() {
  if (instance) await instance.shutdown?.().catch(() => {});
  instance = null;
  loadedLocales.clear();
  loadedNamespaces.clear();
  missingKeys.clear();
}
