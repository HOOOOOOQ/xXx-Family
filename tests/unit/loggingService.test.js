import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';

import { LoggingService, DEFAULT_LOG_TYPES } from '../../src/services/loggingService.js';
import { CacheManager } from '../../src/services/cacheManager.js';
import { SettingsService } from '../../src/services/settingsService.js';
import { brandEmbed } from '../../src/utils/embeds.js';
import { getT, initI18n } from '../../src/services/i18nService.js';
import { LOCALE_CODES } from '../../src/config/locales.js';
import { FakePermissions } from '../helpers/fakeInteraction.js';

// Several assertions build real embeds, which needs the translation engine.
before(async () => {
  await initI18n({ locales: LOCALE_CODES, defaultLocale: 'en-US' });
});

const silentLogger = { child: () => silentLogger, debug() {}, info() {}, warn() {}, error() {}, errorFrom() {} };

/** In-memory AuditLog stand-in that records what would have been written. */
function createFakeModel({ failOn = null } = {}) {
  const rows = [];
  return {
    rows,
    async create(doc) {
      if (failOn === 'create') throw new Error('duplicate key');
      const row = { _id: `id-${rows.length + 1}`, createdAt: new Date(), ...doc };
      rows.push(row);
      return row;
    },
    async countDocuments(filter) {
      return rows.filter((row) => row.guildId === filter.guildId && (!filter.type || matches(row.type, filter.type))).length;
    },
    find(filter) {
      const matched = rows
        .filter((row) => row.guildId === filter.guildId && (!filter.type || matches(row.type, filter.type)))
        .reverse();
      const chain = {
        sort: () => chain,
        skip: (n) => {
          chain.__skip = n;
          return chain;
        },
        limit: (n) => {
          chain.__limit = n;
          return chain;
        },
        lean: async () => matched.slice(chain.__skip ?? 0, (chain.__skip ?? 0) + (chain.__limit ?? 20)),
      };
      return chain;
    },
  };
}

function matches(type, filterType) {
  return filterType?.$in ? filterType.$in.includes(type) : type === filterType;
}

/** A text channel that records sends and can be made to fail or refuse. */
function createFakeChannel({ failOn = null, canSend = true } = {}) {
  const sent = [];
  return {
    sent,
    id: '999999999999999999',
    guild: { members: { me: { permissions: new FakePermissions(canSend ? '*' : [PermissionFlagsBits.ViewChannel]) } } },
    isTextBased: () => true,
    permissionsFor: () => new FakePermissions(canSend ? '*' : [PermissionFlagsBits.ViewChannel]),
    async send(payload) {
      if (failOn === 'send') throw new Error('Missing Permissions');
      sent.push(payload);
      return { id: 'msg-1' };
    },
  };
}

function createService({ channel = null, dbReady = true, settings = null, model } = {}) {
  const fakeModel = model ?? createFakeModel();
  const service = new LoggingService({
    model: fakeModel,
    settings,
    isDbReady: () => dbReady,
    resolveChannel: async () => channel,
    logger: silentLogger,
  });
  return { service, model: fakeModel, channel };
}

describe('LoggingService — delivery', () => {
  test('delivers the embed to the configured channel and records it', async () => {
    const channel = createFakeChannel();
    const { service, model } = createService({ channel });

    const result = await service.log({
      guildId: '111',
      type: 'member.join',
      embed: brandEmbed({ t: getT('en-US'), title: 'Member joined' }),
      target: { id: '222', label: 'ada' },
      logChannelId: '999999999999999999',
      locale: 'en-US',
    });

    assert.equal(result.delivered, true);
    assert.equal(result.recorded, true);
    assert.equal(channel.sent.length, 1);
    assert.equal(model.rows.length, 1);
    assert.equal(model.rows[0].type, 'member.join');
    assert.equal(model.rows[0].targetLabel, 'ada');
    assert.equal(model.rows[0].delivered, true);
  });

  test('a missing log channel records the failure instead of throwing', async () => {
    const { service, model } = createService({ channel: null });
    const result = await service.log({
      guildId: '111',
      type: 'member.join',
      embed: brandEmbed({ t: getT('en-US'), title: 'x' }),
      logChannelId: '999999999999999999',
    });
    assert.equal(result.delivered, false);
    assert.equal(result.error, 'log channel not found');
    assert.equal(result.recorded, true, 'the audit record must still exist');
    assert.equal(model.rows[0].deliveryError, 'log channel not found');
  });

  test('no configured channel is not an error, just undelivered', async () => {
    const { service, model } = createService({});
    const result = await service.log({ guildId: '111', type: 'member.join' });
    assert.equal(result.delivered, false);
    assert.equal(result.error, 'no log channel configured');
    assert.equal(model.rows[0].delivered, false);
  });

  test('a Discord send failure is captured, never propagated', async () => {
    const channel = createFakeChannel({ failOn: 'send' });
    const { service, model } = createService({ channel });
    const result = await service.log({
      guildId: '111',
      type: 'member.ban',
      embed: brandEmbed({ t: getT('en-US'), title: 'x' }),
      logChannelId: '999',
    });
    assert.equal(result.delivered, false);
    assert.equal(model.rows[0].deliveryError, 'Missing Permissions');
  });

  test('refuses to send when the bot lacks SendMessages in that channel', async () => {
    const channel = createFakeChannel({ canSend: false });
    const { service } = createService({ channel });
    const result = await service.log({
      guildId: '111',
      type: 'member.join',
      embed: brandEmbed({ t: getT('en-US'), title: 'x' }),
      logChannelId: '999',
    });
    assert.equal(result.delivered, false);
    assert.match(result.error, /SendMessages/);
    assert.equal(channel.sent.length, 0);
  });

  test('validates its inputs', async () => {
    const { service } = createService({});
    assert.equal((await service.log({ type: 'member.join' })).error, 'guildId is required');
    assert.equal((await service.log({ guildId: '111' })).error, 'type is required');
  });
});

describe('LoggingService — filters', () => {
  const settingsWith = (features) => ({
    guildId: '111',
    language: null,
    moduleToggles: {},
    features,
    channels: { logs: '999', announcements: null, welcome: null },
    persisted: true,
  });

  const fakeSettings = (settings) => ({
    getGuildSettings: async () => settings,
  });

  test('an unknown type is enabled by default', async () => {
    const { service } = createService({});
    assert.equal(service.isTypeEnabled(null, 'member.join'), true);
    assert.equal(service.isTypeEnabled({}, 'some.future.type'), true);
  });

  test('disabledTypes filters an event out entirely', async () => {
    const { service, model } = createService({
      settings: fakeSettings(settingsWith({ logging: { disabledTypes: ['member.join'] } })),
    });
    const result = await service.log({ guildId: '111', type: 'member.join' });
    assert.equal(result.skipped, 'filtered');
    assert.equal(model.rows.length, 0, 'a filtered event must not be recorded either');
  });

  test('an explicit per-type map is respected', async () => {
    const settings = fakeSettings(settingsWith({ logging: { types: { 'member.join': false, 'member.ban': true } } }));
    const { service } = createService({ settings });
    assert.equal(service.isTypeEnabled(await settings.getGuildSettings(), 'member.join'), false);
    assert.equal(service.isTypeEnabled(await settings.getGuildSettings(), 'member.ban'), true);
  });

  test('the log channel comes from guild settings when not overridden', async () => {
    const channel = createFakeChannel();
    const { service } = createService({
      channel,
      settings: fakeSettings(settingsWith({})),
    });
    const result = await service.log({
      guildId: '111',
      type: 'member.join',
      embed: brandEmbed({ t: getT('en-US'), title: 'x' }),
    });
    assert.equal(result.delivered, true, 'must use GuildSettings.channels.logs');
  });
});

describe('LoggingService — degraded and failure modes', () => {
  test('still delivers when the database is offline', async () => {
    const channel = createFakeChannel();
    const { service, model } = createService({ channel, dbReady: false });
    const result = await service.log({
      guildId: '111',
      type: 'member.join',
      embed: brandEmbed({ t: getT('en-US'), title: 'x' }),
      logChannelId: '999',
    });
    assert.equal(result.delivered, true);
    assert.equal(result.recorded, false);
    assert.equal(model.rows.length, 0);
  });

  test('a failing write does not break the caller', async () => {
    const { service } = createService({ model: createFakeModel({ failOn: 'create' }) });
    const result = await service.log({ guildId: '111', type: 'member.join' });
    assert.equal(result.recorded, false);
    assert.match(result.error, /duplicate key/);
  });

  test('redacts secrets before they reach the database', async () => {
    const { service, model } = createService({});
    await service.log({
      guildId: '111',
      type: 'config.change',
      evidence: { token: 'super-secret-token', before: 'a', after: 'b' },
    });
    assert.equal(model.rows[0].evidence.token, '[REDACTED]');
    assert.equal(model.rows[0].evidence.before, 'a');
  });

  test('truncates an over-long reason', async () => {
    const { service, model } = createService({});
    await service.log({ guildId: '111', type: 'member.warn', reason: 'x'.repeat(2000) });
    assert.equal(model.rows[0].reason.length, 1000);
  });
});

describe('LoggingService — search', () => {
  test('returns paginated results newest first', async () => {
    const model = createFakeModel();
    const { service } = createService({ model });
    for (let i = 0; i < 5; i += 1) {
      await service.log({ guildId: '111', type: i % 2 ? 'member.join' : 'member.leave', target: { id: `t${i}` } });
    }
    await service.log({ guildId: '222', type: 'member.join' });

    const first = await service.search({ guildId: '111', limit: 2, page: 1 });
    assert.equal(first.total, 5, 'must not count other guilds');
    assert.equal(first.pages, 3);
    assert.equal(first.entries.length, 2);

    const byType = await service.search({ guildId: '111', type: 'member.join' });
    assert.equal(byType.total, 2);
  });

  test('clamps page size and page number', async () => {
    const { service } = createService({});
    const result = await service.search({ guildId: '111', limit: 9999, page: -3 });
    assert.equal(result.page, 1);
    assert.ok(result.pages >= 1);
  });

  test('requires a guild and degrades offline', async () => {
    const { service } = createService({ dbReady: false });
    await assert.rejects(() => service.search({}), /guildId is required/);
    const empty = await service.search({ guildId: '111' });
    assert.deepEqual(empty.entries, []);
    assert.equal(empty.total, 0);
  });
});

describe('LoggingService — defaults', () => {
  test('every default log type is a known audit type', async () => {
    const { AUDIT_TYPES } = await import('../../src/database/models/AuditLog.js');
    for (const type of DEFAULT_LOG_TYPES) assert.ok(AUDIT_TYPES.includes(type), `${type} is not declared`);
  });
});

describe('SettingsService + LoggingService integration', () => {
  test('the configured log channel is picked up through a real SettingsService', async () => {
    const guilds = new Map([
      ['111', { guildId: '111', language: 'id-ID', moduleToggles: {}, features: {}, channels: { logs: '999', announcements: null, welcome: null } }],
    ]);
    const settings = new SettingsService({
      models: {
        GuildSettings: { findOne: ({ guildId }) => ({ lean: () => ({ exec: async () => guilds.get(guildId) ?? null }) }) },
        UserSettings: { findOne: () => ({ lean: () => ({ exec: async () => null }) }) },
        LanguageOverride: { find: () => ({ sort: () => ({ limit: () => ({ lean: () => ({ exec: async () => [] }) }) }) }) },
      },
      cache: new CacheManager({ autoSweep: false }),
      isDbReady: () => true,
      logger: silentLogger,
    });

    const channel = createFakeChannel();
    const { service, model } = createService({ channel, settings });

    const result = await service.log({
      guildId: '111',
      type: 'member.join',
      embed: brandEmbed({ t: getT('id-ID'), title: 'Anggota bergabung' }),
      target: { id: '222', label: 'budi' },
    });

    assert.equal(result.delivered, true);
    assert.equal(model.rows[0].locale, null, 'locale is only stored when the caller passes it');
    assert.equal(model.rows[0].targetLabel, 'budi');
    assert.equal(channel.sent[0].embeds[0].toJSON().title, 'Anggota bergabung');
  });
});
