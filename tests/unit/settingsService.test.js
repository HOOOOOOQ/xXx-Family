import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SettingsService, DEFAULT_GUILD_SETTINGS } from '../../src/services/settingsService.js';
import { CacheManager } from '../../src/services/cacheManager.js';
import { ValidationError, NotFoundError } from '../../src/utils/errors.js';

/**
 * In-memory stand-in for the Mongoose models. Only the queries the service
 * actually issues are implemented, which keeps the test honest about the
 * contract without needing a MongoDB server.
 */
function createFakeModels({ ready = true } = {}) {
  const guilds = new Map();
  const users = new Map();
  const overrides = [];
  const queryLog = [];

  const lean = (value) => ({ lean: () => ({ exec: async () => value }), exec: async () => value });

  const GuildSettings = {
    findOne: ({ guildId }) => {
      queryLog.push(`guild.findOne:${guildId}`);
      return lean(guilds.get(guildId) ?? null);
    },
    findOneAndUpdate: ({ guildId }, update, opts) => {
      queryLog.push(`guild.upsert:${guildId}`);
      const existing = guilds.get(guildId) ?? { guildId, language: null, moduleToggles: {}, features: {}, channels: {} };
      Object.assign(existing, update.$set ?? {});
      guilds.set(guildId, existing);
      return lean(existing);
    },
    deleteOne: ({ guildId }) => ({ exec: async () => { guilds.delete(guildId); return { deletedCount: 1 }; } }),
  };

  const UserSettings = {
    findOne: ({ userId }) => {
      queryLog.push(`user.findOne:${userId}`);
      return lean(users.get(userId) ?? null);
    },
    findOneAndUpdate: ({ userId }, update) => {
      queryLog.push(`user.upsert:${userId}`);
      const existing = users.get(userId) ?? { userId, language: null, preferences: {} };
      Object.assign(existing, update.$set ?? {});
      users.set(userId, existing);
      return lean(existing);
    },
  };

  const LanguageOverride = {
    find: (filter) => {
      queryLog.push('override.find');
      const matches = overrides.filter((row) => {
        if (row.guildId !== filter.guildId) return false;
        if (filter.enabled !== undefined && row.enabled !== filter.enabled) return false;
        return (filter.$or ?? []).some((clause) => clause.scope === row.scope && clause.scopeId === row.scopeId);
      });
      const sorted = [...matches].sort((a, b) => b.priority - a.priority);
      return {
        sort: () => ({ limit: () => ({ lean: () => ({ exec: async () => sorted.slice(0, 1) }) }) }),
      };
    },
  };

  return {
    models: { GuildSettings, UserSettings, LanguageOverride },
    stores: { guilds, users, overrides },
    queryLog,
    isDbReady: () => ready,
  };
}

function createService(options = {}) {
  const fake = createFakeModels(options);
  const service = new SettingsService({
    models: fake.models,
    cache: new CacheManager({ autoSweep: false }),
    isDbReady: fake.isDbReady,
    logger: { child: () => ({ warn() {}, info() {}, error() {}, errorFrom() {}, debug() {} }) },
  });
  return { service, ...fake };
}

describe('SettingsService — guild settings', () => {
  test('returns documented defaults when nothing is stored', async () => {
    const { service } = createService();
    const settings = await service.getGuildSettings('111');
    assert.equal(settings.language, null);
    assert.equal(settings.persisted, false);
    assert.deepEqual(settings.moduleToggles, {});
    assert.deepEqual(settings.channels, DEFAULT_GUILD_SETTINGS.channels);
  });

  test('requires a guild id', async () => {
    const { service } = createService();
    await assert.rejects(() => service.getGuildSettings(null), ValidationError);
  });

  test('stores and reads back the guild language', async () => {
    const { service, stores } = createService();
    await service.setGuildLanguage('111', 'id-ID', 'Test Guild');
    assert.equal(stores.guilds.get('111').language, 'id-ID');

    const settings = await service.getGuildSettings('111');
    assert.equal(settings.language, 'id-ID');
    assert.equal(settings.guildName, 'Test Guild');
    assert.equal(settings.persisted, true);
  });

  test('rejects an unsupported locale instead of storing garbage', async () => {
    const { service, stores } = createService();
    await assert.rejects(() => service.setGuildLanguage('111', 'xx-XX'), ValidationError);
    assert.equal(stores.guilds.has('111'), false);
  });

  test('serves the second read from cache', async () => {
    const { service, queryLog } = createService();
    await service.getGuildSettings('111');
    await service.getGuildSettings('111');
    assert.equal(queryLog.filter((q) => q === 'guild.findOne:111').length, 1);
  });

  test('invalidateGuild forces a fresh read', async () => {
    const { service, queryLog } = createService();
    await service.getGuildSettings('111');
    service.invalidateGuild('111');
    await service.getGuildSettings('111');
    assert.equal(queryLog.filter((q) => q === 'guild.findOne:111').length, 2);
  });

  test('reset clears the stored language', async () => {
    const { service, stores } = createService();
    await service.setGuildLanguage('111', 'ja-JP');
    await service.resetGuildSettings('111');
    assert.equal(stores.guilds.get('111').language, null);
    const settings = await service.getGuildSettings('111');
    assert.equal(settings.language, null);
  });

  test('reset with clearAll drops the document', async () => {
    const { service, stores } = createService();
    await service.setGuildLanguage('111', 'ja-JP');
    await service.resetGuildSettings('111', { clearAll: true });
    assert.equal(stores.guilds.has('111'), false);
  });
});

describe('SettingsService — degraded mode (no MongoDB)', () => {
  test('serves defaults and refuses to pretend a write succeeded', async () => {
    const { service } = createService({ ready: false });
    const settings = await service.getGuildSettings('111');
    assert.equal(settings.persisted, false);
    assert.equal(settings.language, null);
    await assert.rejects(() => service.setGuildLanguage('111', 'id-ID'), NotFoundError);
  });

  test('does not hammer the database on every call while offline', async () => {
    const { service, queryLog } = createService({ ready: false });
    await service.getGuildSettings('111');
    await service.getGuildSettings('111');
    await service.getGuildSettings('111');
    assert.deepEqual(queryLog, [], 'no query may be issued while offline');
  });
});

describe('SettingsService — user settings', () => {
  test('stores and clears a personal language', async () => {
    const { service, stores } = createService();
    await service.setUserLanguage('222', 'ko-KR', 'ada');
    assert.equal(stores.users.get('222').language, 'ko-KR');

    const settings = await service.getUserSettings('222');
    assert.equal(settings.language, 'ko-KR');
    assert.equal(settings.persisted, true);

    await service.resetUserLanguage('222');
    assert.equal((await service.getUserSettings('222')).language, null);
  });

  test('merges stored preferences over the documented defaults', async () => {
    const { service, stores } = createService();
    stores.users.set('222', { userId: '222', language: null, preferences: { timezone: 'Asia/Jakarta' } });
    const settings = await service.getUserSettings('222');
    assert.equal(settings.preferences.timezone, 'Asia/Jakarta');
    assert.equal(settings.preferences.theme, 'cyberpunk', 'missing keys fall back to the default');
  });

  test('rejects an unsupported locale', async () => {
    const { service } = createService();
    await assert.rejects(() => service.setUserLanguage('222', 'klingon'), ValidationError);
  });
});

describe('SettingsService — module toggles and overrides', () => {
  test('an unknown module is enabled by default', () => {
    const { service } = createService();
    assert.equal(service.isModuleEnabled({ moduleToggles: {} }, 'tickets'), true);
  });

  test('an explicit false disables a module', () => {
    const { service } = createService();
    assert.equal(service.isModuleEnabled({ moduleToggles: { tickets: false } }, 'tickets'), false);
    assert.equal(service.isModuleEnabled({ moduleToggles: { tickets: true } }, 'tickets'), true);
  });

  test('a channel override beats a module override', async () => {
    const { service, stores } = createService();
    stores.overrides.push({ guildId: '111', scope: 'module', scopeId: 'welcome', language: 'es-ES', priority: 10, enabled: true });
    stores.overrides.push({ guildId: '111', scope: 'channel', scopeId: '333', language: 'id-ID', priority: 30, enabled: true });

    const hit = await service.findLanguageOverride({ guildId: '111', channelId: '333', moduleName: 'welcome' });
    assert.equal(hit.language, 'id-ID');
    assert.equal(hit.scope, 'channel');
  });

  test('returns null when no override matches', async () => {
    const { service } = createService();
    assert.equal(await service.findLanguageOverride({ guildId: '111', channelId: '999' }), null);
    assert.equal(await service.findLanguageOverride({ guildId: '111' }), null, 'no criteria means no query');
  });

  test('disabled overrides are ignored', async () => {
    const { service, stores } = createService();
    stores.overrides.push({ guildId: '111', scope: 'channel', scopeId: '333', language: 'id-ID', priority: 30, enabled: false });
    assert.equal(await service.findLanguageOverride({ guildId: '111', channelId: '333' }), null);
  });
});
