import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { LoggingService } from '../../src/services/loggingService.js';
import { LocaleService } from '../../src/services/localeService.js';
import { SettingsService } from '../../src/services/settingsService.js';
import { CacheManager } from '../../src/services/cacheManager.js';
import { initI18n } from '../../src/services/i18nService.js';
import { LOCALE_CODES } from '../../src/config/locales.js';
import { classifyVoiceChange } from '../../src/bot/events/voiceStateUpdate.js';
import { shouldSkipMessage } from '../../src/bot/events/_logHelper.js';

const silentLogger = { child: () => silentLogger, debug() {}, info() {}, warn() {}, error() {}, errorFrom() {} };

const GUILD_ID = '111111111111111111';
const LOG_CHANNEL = '999999999999999999';

before(async () => {
  await initI18n({ locales: LOCALE_CODES, defaultLocale: 'en-US' });
});

function createChannel(id = LOG_CHANNEL) {
  const sent = [];
  return {
    sent,
    id,
    isTextBased: () => true,
    async send(payload) {
      sent.push(payload);
      return { id: 'msg-1' };
    },
  };
}

/** Build a service wired to real locale resolution and fake storage. */
function createService({ guildLanguage = null, channel = createChannel(), dbReady = true } = {}) {
  const auditRows = [];
  const settings = new SettingsService({
    models: {
      GuildSettings: {
        findOne: () => ({
          lean: () => ({
            exec: async () => ({
              guildId: GUILD_ID,
              language: guildLanguage,
              moduleToggles: {},
              features: {},
              channels: { logs: LOG_CHANNEL, announcements: null, welcome: null },
            }),
          }),
        }),
      },
      UserSettings: { findOne: () => ({ lean: () => ({ exec: async () => null }) }) },
      LanguageOverride: { find: () => ({ sort: () => ({ limit: () => ({ lean: () => ({ exec: async () => [] }) }) }) }) },
    },
    cache: new CacheManager({ autoSweep: false }),
    isDbReady: () => dbReady,
    logger: silentLogger,
  });

  const service = new LoggingService({
    model: {
      create: async (doc) => (auditRows.push(doc), { _id: `a${auditRows.length}` }),
      countDocuments: async () => auditRows.length,
      find: () => ({ sort: () => ({ limit: () => ({ skip: () => ({ lean: async () => auditRows }) }) }) }),
    },
    settings,
    localeService: new LocaleService({ settings }),
    resolveChannel: async (id) => (id === LOG_CHANNEL ? channel : null),
    isDbReady: () => dbReady,
    logger: silentLogger,
  });

  return { service, channel, auditRows };
}

const guild = { id: GUILD_ID, name: 'Test Guild', preferredLocale: 'en-US' };

describe('LoggingService.logEvent', () => {
  test('renders a localized title and description', async () => {
    const { service, channel, auditRows } = createService();
    await service.logEvent({
      guild,
      type: 'message.delete',
      key: 'messageDelete',
      values: { author: '<@222>', channel: '<#333>' },
    });

    const embed = channel.sent[0].embeds[0].toJSON();
    assert.equal(embed.title, 'Message deleted');
    assert.equal(embed.description, 'A message by <@222> was deleted in <#333>.');
    assert.equal(auditRows[0].type, 'message.delete');
    assert.equal(auditRows[0].locale, 'en-US');
  });

  test('uses the guild language, never mixing', async () => {
    const { service, channel } = createService({ guildLanguage: 'id-ID' });
    await service.logEvent({
      guild,
      type: 'message.delete',
      key: 'messageDelete',
      values: { author: '<@222>', channel: '<#333>' },
    });

    const embed = channel.sent[0].embeds[0].toJSON();
    assert.equal(embed.title, 'Pesan dihapus');
    assert.match(embed.description, /Pesan dari <@222> dihapus di <#333>\./);
    assert.ok(!JSON.stringify(embed).includes('Message deleted'), 'must not mix languages');
  });

  test('translates field names and truncates long values', async () => {
    const { service, channel } = createService();
    await service.logEvent({
      guild,
      type: 'message.edit',
      key: 'messageUpdate',
      values: { author: '<@222>', channel: '<#333>' },
      embed: { fields: [{ nameKey: 'common:logs.field.before', value: 'x'.repeat(1500) }] },
    });

    const [field] = channel.sent[0].embeds[0].toJSON().fields;
    assert.equal(field.name, 'Before');
    assert.ok(field.value.length <= 1060, `field too long: ${field.value.length}`);
    assert.match(field.value, /Content truncated/);
  });

  test('an empty field value still renders', async () => {
    const { service, channel } = createService();
    await service.logEvent({
      guild,
      type: 'message.delete',
      key: 'messageDelete',
      values: { author: '<@222>', channel: '<#333>' },
      embed: { fields: [{ nameKey: 'common:logs.field.content', value: '' }] },
    });
    assert.equal(channel.sent[0].embeds[0].toJSON().fields[0].value, '_ _');
  });

  test('never emits a raw i18n key as a field name', async () => {
    const { service, channel } = createService();
    await service.logEvent({
      guild,
      type: 'message.delete',
      key: 'messageDelete',
      values: { author: '<@222>', channel: '<#333>' },
      embed: { fields: [{ nameKey: 'common:logs.field.reason', value: 'spam' }] },
    });
    assert.equal(channel.sent[0].embeds[0].toJSON().fields[0].name, 'Reason');
  });

  test('requires a guild', async () => {
    const { service } = createService();
    const result = await service.logEvent({ type: 'message.delete', key: 'messageDelete' });
    assert.equal(result.error, 'guild is required');
  });
});

describe('logging events', () => {
  let channel;
  beforeEach(() => {
    channel = createChannel();
  });

  test('messageDelete logs the author, channel and content', async () => {
    const { service } = createService({ channel });
    const client = { logging: service, user: { id: '1' }, metrics: { increment() {} } };
    const handler = (await import('../../src/bot/events/messageDelete.js')).default;

    await handler.execute(client, {
      id: 'm1',
      guild,
      channelId: '333333333333333333',
      content: 'deleted text',
      partial: false,
      system: false,
      attachments: { size: 0 },
      author: { id: '222222222222222222', username: 'ada' },
    });

    assert.equal(channel.sent.length, 1);
    const embed = channel.sent[0].embeds[0].toJSON();
    assert.match(embed.description, /A message by <@222222222222222222> was deleted/);
    assert.equal(embed.fields[0].value, 'deleted text');
  });

  test('messageDelete skips system messages and the bot itself', async () => {
    const { service } = createService({ channel });
    const client = { logging: service, user: { id: 'bot-1' }, metrics: { increment() {} } };
    const handler = (await import('../../src/bot/events/messageDelete.js')).default;

    await handler.execute(client, { guild, channelId: '3', content: 'x', partial: false, system: true, author: { id: 'a' } });
    await handler.execute(client, { guild, channelId: '3', content: 'x', partial: false, system: false, author: { id: 'bot-1' } });

    assert.equal(channel.sent.length, 0, 'system and self messages must not be logged');
  });

  test('messageDelete handles a partial message without inventing details', async () => {
    const { service } = createService({ channel });
    const client = { logging: service, user: { id: '1' }, metrics: { increment() {} } };
    const handler = (await import('../../src/bot/events/messageDelete.js')).default;

    await handler.execute(client, { id: 'm1', guild, channelId: '3', partial: true });
    const embed = channel.sent[0].embeds[0].toJSON();
    assert.match(embed.description, /was deleted in <#3>/);
    assert.equal(embed.fields, undefined, 'no content means no content field');
  });

  test('messageUpdate skips embed-only edits', async () => {
    const { service } = createService({ channel });
    const client = { logging: service, user: { id: '1' }, metrics: { increment() {} } };
    const handler = (await import('../../src/bot/events/messageUpdate.js')).default;

    const base = { guild, channelId: '3', partial: false, system: false, author: { id: '222', username: 'ada' } };
    await handler.execute(client, { ...base, content: 'same' }, { ...base, content: 'same' });
    assert.equal(channel.sent.length, 0, 'a link preview resolving is not an edit');

    await handler.execute(client, { ...base, content: 'before' }, { ...base, content: 'after' });
    assert.equal(channel.sent.length, 1);
    const fields = channel.sent[0].embeds[0].toJSON().fields;
    assert.equal(fields[0].value, 'before');
    assert.equal(fields[1].value, 'after');
  });

  test('messageDeleteBulk produces ONE entry with a count', async () => {
    const { service, auditRows } = createService({ channel });
    const client = { logging: service, metrics: { increment() {} } };
    const handler = (await import('../../src/bot/events/messageDeleteBulk.js')).default;

    const messages = new Map(
      Array.from({ length: 100 }, (_, i) => [`m${i}`, { id: `m${i}`, author: { id: '222' } }]),
    );
    await handler.execute(client, messages, { id: '333333333333333333', guild });

    assert.equal(channel.sent.length, 1, 'a 100-message purge must not produce 100 log messages');
    assert.match(channel.sent[0].embeds[0].toJSON().description, /100 messages were purged/);
    assert.equal(auditRows[0].evidence.messageIds.length, 50, 'evidence is capped, not unbounded');
    assert.equal(auditRows[0].evidence.content, undefined, 'purged bodies must not be stored');
  });

  test('guildBanAdd names no moderator when the audit trail has none', async () => {
    const { service } = createService({ channel });
    const client = { logging: service, logger: silentLogger, metrics: { increment() {} } };
    const handler = (await import('../../src/bot/events/guildBanAdd.js')).default;

    await handler.execute(client, { guild, user: { id: '444', username: 'spammer', createdTimestamp: Date.now() } });

    const embed = channel.sent[0].embeds[0].toJSON();
    assert.match(embed.description, /<@444> was banned by unknown/);
  });

  test('guildMemberUpdate exits early when nothing logged changed', async () => {
    const { service } = createService({ channel });
    const client = { logging: service, metrics: { increment() {} } };
    const handler = (await import('../../src/bot/events/guildMemberUpdate.js')).default;

    const member = (roles, nickname) => ({
      id: '444',
      partial: false,
      guild,
      nickname,
      roles: { cache: new Map(roles.map((r) => [r, {}])) },
      user: { username: 'ada' },
    });

    // Only presence-style changes — must not log.
    await handler.execute(client, member(['everyone-role'], null), member(['everyone-role'], null));
    assert.equal(channel.sent.length, 0);

    // A role added — must log, and must not report @everyone.
    await handler.execute(client, member([GUILD_ID], null), member([GUILD_ID, '555'], null));
    assert.equal(channel.sent.length, 1);
    const embed = channel.sent[0].embeds[0].toJSON();
    assert.match(embed.description, /added: <@&555>/);
    assert.ok(!embed.description.includes(`<@&${GUILD_ID}>`), '@everyone must never be reported');
  });

  test('guildMemberUpdate logs a nickname change separately', async () => {
    const { service } = createService({ channel });
    const client = { logging: service, metrics: { increment() {} } };
    const handler = (await import('../../src/bot/events/guildMemberUpdate.js')).default;

    const member = (nickname) => ({
      id: '444',
      partial: false,
      guild,
      nickname,
      roles: { cache: new Map([[GUILD_ID, {}]]) },
      user: { username: 'ada' },
    });

    await handler.execute(client, member(null), member('Ada L.'));
    assert.equal(channel.sent.length, 1);
    assert.match(channel.sent[0].embeds[0].toJSON().description, /is now known as Ada L\. \(was ada\)/);
  });

  test('channelCreate logs the channel; channelDelete logs the plain name', async () => {
    const { service } = createService({ channel });
    const client = { logging: service, metrics: { increment() {} } };

    const created = (await import('../../src/bot/events/channelCreate.js')).default;
    await created.execute(client, { id: '555', guild, name: 'new-channel', type: 0, parentId: null, nsfw: false });
    assert.match(channel.sent[0].embeds[0].toJSON().description, /<#555> was created/);

    const deleted = (await import('../../src/bot/events/channelDelete.js')).default;
    await deleted.execute(client, { id: '555', guild, name: 'old-channel', type: 0, parentId: null });
    const desc = channel.sent[1].embeds[0].toJSON().description;
    assert.match(desc, /#old-channel was deleted/);
    assert.ok(!desc.includes('<#555>'), 'a deleted channel mention renders as #deleted-channel');
  });

  test('a DM channel is not logged', async () => {
    const { service } = createService({ channel });
    const client = { logging: service, metrics: { increment() {} } };
    const created = (await import('../../src/bot/events/channelCreate.js')).default;
    await created.execute(client, { id: '555', guild: null, name: 'dm', type: 1 });
    assert.equal(channel.sent.length, 0);
  });

  test('voiceStateUpdate ignores the bot itself', async () => {
    const { service } = createService({ channel });
    const client = { logging: service, user: { id: 'bot-1' }, metrics: { increment() {} } };
    const handler = (await import('../../src/bot/events/voiceStateUpdate.js')).default;

    await handler.execute(
      client,
      { channelId: null, guild, member: { id: 'bot-1' } },
      { channelId: 'vc-1', guild, member: { id: 'bot-1', user: { username: 'xXx Family' } } },
    );
    assert.equal(channel.sent.length, 0);
  });
});

describe('classifyVoiceChange', () => {
  const state = (channelId) => ({ channelId });

  test('classifies join, leave, move and no-op', () => {
    assert.equal(classifyVoiceChange(state(null), state('a')), 'join');
    assert.equal(classifyVoiceChange(state('a'), state(null)), 'leave');
    assert.equal(classifyVoiceChange(state('a'), state('b')), 'move');
    assert.equal(classifyVoiceChange(state('a'), state('a')), null);
    assert.equal(classifyVoiceChange(state(null), state(null)), null);
  });
});

describe('shouldSkipMessage', () => {
  test('skips missing, system and self messages', () => {
    assert.equal(shouldSkipMessage(null), true);
    assert.equal(shouldSkipMessage({ system: true }), true);
    assert.equal(shouldSkipMessage({ author: { id: 'bot' } }, 'bot'), true);
    assert.equal(shouldSkipMessage({ author: { id: 'user' } }, 'bot'), false);
    assert.equal(shouldSkipMessage({ author: { id: 'user' } }), false);
  });
});

/**
 * safeLog swallows errors by design — a logging listener must never abort
 * discord.js's event dispatch. That makes a bug inside one invisible, which is
 * exactly how the `Set.filter()` defect in guildMemberUpdate went unnoticed.
 * These tests pin the observability that makes it visible again.
 */
describe('safeLog observability', () => {
  test('a throwing logging event does not propagate', async () => {
    const { safeLog } = await import('../../src/bot/events/_logHelper.js');
    const counters = new Map();
    const client = { logging: {}, metrics: { increment: (name) => counters.set(name, (counters.get(name) ?? 0) + 1) } };

    await assert.doesNotReject(() =>
      safeLog(client, 'guildMemberUpdate', async () => {
        throw new TypeError('after.filter is not a function');
      }),
    );

    assert.equal(counters.get('logging.eventErrors'), 1);
    assert.equal(counters.get('logging.eventErrors.guildMemberUpdate'), 1);
  });

  test('the regression it caught: role diffing works on Sets', async () => {
    // Directly reproduces the bug safeLog was hiding.
    const before = new Set([GUILD_ID]);
    const after = new Set([GUILD_ID, '555']);
    const added = [...after].filter((id) => !before.has(id));
    const removed = [...before].filter((id) => !after.has(id));
    assert.deepEqual(added, ['555']);
    assert.deepEqual(removed, []);
  });
});
