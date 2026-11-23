/**
 * src/services/settingsService.js
 * ---------------------------------------------------------------------------
 * Guild / user configuration access layer.
 *
 * Every module reads configuration through here, never through Mongoose
 * directly, which gives us:
 *   - one cache in front of MongoDB (settings are read on nearly every event)
 *   - one place that defines what "default" means
 *   - a graceful degraded mode when MongoDB is unreachable: defaults are
 *     served and the caller is told persistence is unavailable, instead of
 *     throwing inside an event handler
 *
 * The models are injected, so the service is fully unit-testable with an
 * in-memory fake and no MongoDB server.
 */

import mongoose from 'mongoose';

import { isSupportedLocale } from '../config/locales.js';
import { ValidationError, NotFoundError } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';
import { settingsCache } from './cacheManager.js';
import * as defaultModels from '../database/models/index.js';

/** Shape returned when nothing is stored yet. */
export const DEFAULT_GUILD_SETTINGS = Object.freeze({
  guildId: null,
  guildName: null,
  language: null,
  moduleToggles: {},
  features: {},
  channels: { logs: null, announcements: null, welcome: null },
  persisted: false,
});

export const DEFAULT_USER_SETTINGS = Object.freeze({
  userId: null,
  language: null,
  preferences: { theme: 'cyberpunk', timezone: null, allowDirectMessages: true, keepAiHistory: false },
  persisted: false,
});

const GUILD_KEY = (id) => `guild:${id}`;
const USER_KEY = (id) => `user:${id}`;

function mapToObject(value) {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value);
  if (typeof value === 'object') return { ...value };
  return {};
}

export class SettingsService {
  /**
   * @param {object} [deps]
   * @param {object} [deps.models]
   * @param {import('./cacheManager.js').CacheManager} [deps.cache]
   * @param {() => boolean} [deps.isDbReady]
   */
  constructor(deps = {}) {
    this.models = deps.models ?? defaultModels;
    this.cache = deps.cache ?? settingsCache;
    this.isDbReady = deps.isDbReady ?? (() => mongoose.connection.readyState === 1);
    this.logger = (deps.logger ?? getLogger()).child('settings');
    this.degradedWarned = false;
  }

  #warnDegraded(what) {
    if (this.degradedWarned) return;
    this.degradedWarned = true;
    this.logger.warn('Settings are served from defaults — MongoDB is not connected', { operation: what });
  }

  /**
   * @param {string} guildId
   * @param {object} [options]
   * @param {boolean} [options.forceRefresh]
   * @returns {Promise<typeof DEFAULT_GUILD_SETTINGS>}
   */
  async getGuildSettings(guildId, options = {}) {
    if (!guildId) throw new ValidationError('guildId is required');
    const key = GUILD_KEY(guildId);
    if (!options.forceRefresh) {
      const cached = this.cache.get(key);
      if (cached) return cached;
    }

    if (!this.isDbReady()) {
      this.#warnDegraded('getGuildSettings');
      const fallback = { ...DEFAULT_GUILD_SETTINGS, guildId, persisted: false };
      this.cache.set(key, fallback, 15_000);
      return fallback;
    }

    const doc = await this.models.GuildSettings.findOne({ guildId }).lean().exec();
    if (!doc) {
      const fallback = { ...DEFAULT_GUILD_SETTINGS, guildId, persisted: false };
      this.cache.set(key, fallback, 30_000);
      return fallback;
    }

    const normalized = {
      guildId: doc.guildId,
      guildName: doc.guildName ?? null,
      language: doc.language ?? null,
      moduleToggles: mapToObject(doc.moduleToggles),
      features: mapToObject(doc.features),
      channels: {
        logs: doc.channels?.logs ?? null,
        announcements: doc.channels?.announcements ?? null,
        welcome: doc.channels?.welcome ?? null,
      },
      persisted: true,
      updatedAt: doc.updatedAt ?? null,
    };
    this.cache.set(key, normalized, 120_000);
    return normalized;
  }

  /**
   * Upsert the guild default language.
   * @param {string} guildId
   * @param {string|null} locale  null clears the override
   * @param {string} [guildName]
   */
  async setGuildLanguage(guildId, locale, guildName = null) {
    if (!guildId) throw new ValidationError('guildId is required');
    if (locale !== null && !isSupportedLocale(locale)) {
      throw new ValidationError(`"${locale}" is not a supported locale`);
    }
    if (!this.isDbReady()) throw new NotFoundError('Settings cannot be saved while the database is offline');

    const doc = await this.models.GuildSettings.findOneAndUpdate(
      { guildId },
      { $set: { language: locale, ...(guildName ? { guildName } : {}) }, $setOnInsert: { guildId } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();

    this.cache.delete(GUILD_KEY(guildId));
    this.logger.info('Guild language updated', { guildId, locale });
    return { guildId, language: doc.language ?? null, persisted: true };
  }

  /**
   * @param {string} guildId
   * @param {boolean} [options.clearAll] drop the document entirely
   */
  async resetGuildSettings(guildId, options = {}) {
    if (!guildId) throw new ValidationError('guildId is required');
    if (!this.isDbReady()) throw new NotFoundError('Settings cannot be reset while the database is offline');

    if (options.clearAll) {
      await this.models.GuildSettings.deleteOne({ guildId }).exec();
    } else {
      await this.models.GuildSettings.findOneAndUpdate(
        { guildId },
        { $set: { language: null, moduleToggles: {}, features: {}, channels: { logs: null, announcements: null, welcome: null } } },
        { upsert: false, new: true },
      ).exec();
    }
    this.cache.delete(GUILD_KEY(guildId));
    this.logger.info('Guild settings reset', { guildId, clearAll: Boolean(options.clearAll) });
    return { guildId, reset: true };
  }

  /**
   * @param {string} userId
   * @returns {Promise<typeof DEFAULT_USER_SETTINGS>}
   */
  async getUserSettings(userId, options = {}) {
    if (!userId) throw new ValidationError('userId is required');
    const key = USER_KEY(userId);
    if (!options.forceRefresh) {
      const cached = this.cache.get(key);
      if (cached) return cached;
    }

    if (!this.isDbReady()) {
      this.#warnDegraded('getUserSettings');
      const fallback = { ...DEFAULT_USER_SETTINGS, userId, persisted: false };
      this.cache.set(key, fallback, 15_000);
      return fallback;
    }

    const doc = await this.models.UserSettings.findOne({ userId }).lean().exec();
    if (!doc) {
      const fallback = { ...DEFAULT_USER_SETTINGS, userId, persisted: false };
      this.cache.set(key, fallback, 30_000);
      return fallback;
    }
    const normalized = {
      userId: doc.userId,
      language: doc.language ?? null,
      preferences: { ...DEFAULT_USER_SETTINGS.preferences, ...(doc.preferences ?? {}) },
      persisted: true,
      updatedAt: doc.updatedAt ?? null,
    };
    this.cache.set(key, normalized, 120_000);
    return normalized;
  }

  /**
   * @param {string} userId
   * @param {string|null} locale null clears the personal preference
   * @param {string} [username]
   */
  async setUserLanguage(userId, locale, username = null) {
    if (!userId) throw new ValidationError('userId is required');
    if (locale !== null && !isSupportedLocale(locale)) {
      throw new ValidationError(`"${locale}" is not a supported locale`);
    }
    if (!this.isDbReady()) throw new NotFoundError('Your language cannot be saved while the database is offline');

    const doc = await this.models.UserSettings.findOneAndUpdate(
      { userId },
      { $set: { language: locale, ...(username ? { username } : {}) }, $setOnInsert: { userId } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();

    this.cache.delete(USER_KEY(userId));
    this.logger.info('User language updated', { userId, locale });
    return { userId, language: doc.language ?? null, persisted: true };
  }

  /** @param {string} userId */
  async resetUserLanguage(userId) {
    return this.setUserLanguage(userId, null);
  }

  /**
   * Module gate read by every feature before it does anything.
   * Unknown modules default to enabled so a new phase works out of the box.
   * @param {typeof DEFAULT_GUILD_SETTINGS} settings
   * @param {string} moduleName
   * @returns {boolean}
   */
  isModuleEnabled(settings, moduleName) {
    const toggles = settings?.moduleToggles ?? {};
    const value = toggles[moduleName];
    return value === undefined ? true : Boolean(value);
  }

  /**
   * Narrowest matching language override (channel > role > module), or null.
   * @param {object} params
   * @param {string} params.guildId
   * @param {string|null} [params.channelId]
   * @param {string|null} [params.moduleName]
   * @param {string[]} [params.roleIds]
   * @returns {Promise<{ language:string, scope:string, scopeId:string }|null>}
   */
  async findLanguageOverride({ guildId, channelId = null, moduleName = null, roleIds = [] }) {
    if (!guildId) return null;
    if (!this.isDbReady()) return null;

    const cacheKey = `override:${guildId}:${channelId ?? '-'}:${moduleName ?? '-'}:${[...roleIds].sort().join('|')}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached === '' ? null : cached;

    const candidates = [];
    if (channelId) candidates.push({ scope: 'channel', scopeId: channelId, priority: 30 });
    for (const roleId of roleIds) candidates.push({ scope: 'role', scopeId: roleId, priority: 20 });
    if (moduleName) candidates.push({ scope: 'module', scopeId: moduleName, priority: 10 });
    if (!candidates.length) {
      this.cache.set(cacheKey, '', 60_000);
      return null;
    }

    const rows = await this.models.LanguageOverride.find({
      guildId,
      enabled: true,
      $or: candidates.map(({ scope, scopeId }) => ({ scope, scopeId })),
    })
      .sort({ priority: -1 })
      .limit(1)
      .lean()
      .exec();

    const hit = rows[0];
    const result = hit ? { language: hit.language, scope: hit.scope, scopeId: hit.scopeId } : null;
    this.cache.set(cacheKey, result ?? '', 60_000);
    return result;
  }

  /**
   * Read a feature block out of the guild document.
   *
   * Automod rules live under `features.automod` rather than in their own
   * collection: the block is small, it is read on every message, and it is
   * already covered by the guild settings cache. Returns null when nothing has
   * been configured, so the caller can merge over its own defaults.
   *
   * @param {string} guildId
   * @param {string} name e.g. `automod`
   * @returns {Promise<object|null>}
   */
  async getFeatureConfig(guildId, name) {
    const settings = await this.getGuildSettings(guildId);
    const value = settings?.features?.[name];
    return value && typeof value === 'object' ? value : null;
  }

  /** Automod rules for a guild, or null when unconfigured. */
  async getAutomodConfig(guildId) {
    return this.getFeatureConfig(guildId, 'automod');
  }

  /**
   * Merge a partial feature block into the guild document.
   *
   * Merges rather than replaces so a caller updating one rule cannot silently
   * delete the others.
   *
   * @param {string} guildId
   * @param {string} name
   * @param {object} patch
   */
  async setFeatureConfig(guildId, name, patch) {
    if (!guildId) throw new ValidationError('guildId is required');
    if (!this.isDbReady()) throw new NotFoundError('Settings cannot be saved while the database is offline');
    if (!patch || typeof patch !== 'object') {
      throw new ValidationError(`The ${name} configuration must be an object`);
    }

    // A dotted path targets one key of the Map without rewriting the whole
    // thing, so other features survive the update.
    await this.models.GuildSettings.findOneAndUpdate(
      { guildId },
      { $set: { [`features.${name}`]: patch }, $setOnInsert: { guildId } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).exec();

    this.cache.delete(GUILD_KEY(guildId));
    this.logger.info('Feature configuration updated', { guildId, feature: name });
    return this.getFeatureConfig(guildId, name);
  }

  /** Persist automod rules for a guild. */
  async setAutomodConfig(guildId, patch) {
    return this.setFeatureConfig(guildId, 'automod', patch);
  }

  /** @param {string} guildId */
  invalidateGuild(guildId) {
    this.cache.deleteByPrefix(`override:${guildId}`);
    this.cache.delete(GUILD_KEY(guildId));
  }

  /** @param {string} userId */
  invalidateUser(userId) {
    this.cache.delete(USER_KEY(userId));
  }

  /** @returns {ReturnType<import('./cacheManager.js').CacheManager['stats']>} */
  stats() {
    return this.cache.stats();
  }
}

/** Process-wide instance used by handlers and modules. */
export const settingsService = new SettingsService();

export default settingsService;
