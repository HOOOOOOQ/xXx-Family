import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { WelcomeService, LeaveTracker } from '../../src/services/welcomeService.js';
import { LoggingService } from '../../src/services/loggingService.js';
import { LocaleService } from '../../src/services/localeService.js';
import { initI18n } from '../../src/services/i18nService.js';
import { LOCALE_CODES } from '../../src/config/locales.js';
import { DEFAULT_WELCOME_CONFIG } from '../../src/database/models/WelcomeConfig.js';

const silentLogger = { child: () => silentLogger, debug() {}, info() {}, warn() {}, error() {}, errorFrom() {} };

before(async () => {
  await initI18n({ locales: LOCALE_CODES, defaultLocale: 'en-US' });
});

/** A guild member with the surface the service touches. */
function createMember(overrides = {}) {
  const added = [];
  const dms = [];
  const roles = new Map([['10', { id: '10', position: 1 }]]);
  const guildRoles = new Map([
    ['10', { id: '10', position: 1 }],
    ['20', { id: '20', position: 5 }],
    ['99', { id: '99', position: 50 }],
  ]);

  const guild = {
    id: '111111111111111111',
    name: 'xXx Family',
    memberCount: 1284,
    iconURL: () => null,
    roles: { cache: guildRoles },
    members: { me: { roles: { highest: { position: 10 } } } },
  };

  return {
    id: '222222222222222222',
    guild,
    joinedTimestamp: Date.now() - 3600_000,
    user: {
      id: '222222222222222222',
      username: 'ada',
      displayName: 'Ada Lovelace',
      bot: false,
      createdTimestamp: Date.now() - 900 * 86400_000,
      displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/222/a.png',
    },
    roles: {
      cache: roles,
      async add(roleId) {
        if (!guildRoles.has(roleId)) throw new Error('Unknown Role');
        added.push(roleId);
        roles.set(roleId, guildRoles.get(roleId));
      },
    },
    async send(content) {
      if (overrides.dmFails) throw new Error('Cannot send messages to this user');
      dms.push(content);
    },
    __added: added,
    __dms: dms,
    ...overrides,
  };
}

function createChannel(id = '999999999999999999') {
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

/** In-memory config stores. */
function createStores({ welcome = null, goodbye = null } = {}) {
  const welcomeRow = welcome;
  const goodbyeRow = goodbye;
  const updates = [];
  const make = (row) => ({
    findOne: ({ guildId }) => ({ lean: async () => (row && row.guildId === guildId ? row : null) }),
    updateOne: async (filter, update) => {
      updates.push({ filter, update });
      return { acknowledged: true };
    },
  });
  return {
    models: { WelcomeConfig: make(welcomeRow), GoodbyeConfig: make(goodbyeRow) },
    updates,
  };
}

function createService({ welcome = null, goodbye = null, channels = {}, dbReady = true, logging = null } = {}) {
  const { models, updates } = createStores({ welcome, goodbye });
  const guildSettings = {
    guildId: '111111111111111111',
    language: null,
    moduleToggles: {},
    features: {},
    channels: { logs: null, announcements: null, welcome: null },
    persisted: true,
  };
  const settings = {
    getGuildSettings: async () => guildSettings,
    getUserSettings: async () => ({ language: null }),
    findLanguageOverride: async () => null,
  };
  const auditRows = [];
  const audit =
    logging ??
    new LoggingService({
      model: { create: async (doc) => (auditRows.push(doc), { _id: 'a1' }), countDocuments: async () => 0, find: () => ({ sort: () => ({ limit: () => ({ skip: () => ({ lean: async () => [] }) }) }) }) },
      settings,
      isDbReady: () => dbReady,
      resolveChannel: async () => null,
      logger: silentLogger,
    });

  const service = new WelcomeService({
    models,
    settings,
    logging: audit,
    localeService: new LocaleService({ settings }),
    resolveChannel: async (id) => channels[id] ?? null,
    isDbReady: () => dbReady,
    logger: silentLogger,
  });

  return { service, updates, auditRows, audit };
}

const enabledWelcome = (overrides = {}) => ({
  guildId: '111111111111111111',
  ...DEFAULT_WELCOME_CONFIG,
  enabled: true,
  channelIds: ['999999999999999999'],
  ...overrides,
});

describe('WelcomeService — gating', () => {
  test('sends nothing when the guild has no configuration', async () => {
    const channel = createChannel();
    const { service, auditRows } = createService({ channels: { [channel.id]: channel } });
    const result = await service.welcomeMember(createMember());
    assert.equal(result.skipped, 'disabled');
    assert.equal(channel.sent.length, 0);
    assert.equal(auditRows.length, 0, 'a disabled feature must not spam the audit log');
  });

  test('sends nothing when explicitly disabled', async () => {
    const channel = createChannel();
    const { service } = createService({ welcome: enabledWelcome({ enabled: false }), channels: { [channel.id]: channel } });
    assert.equal((await service.welcomeMember(createMember())).skipped, 'disabled');
    assert.equal(channel.sent.length, 0);
  });

  test('ignores bots by default', async () => {
    const channel = createChannel();
    const { service } = createService({ welcome: enabledWelcome(), channels: { [channel.id]: channel } });
    const bot = createMember();
    bot.user.bot = true;
    assert.equal((await service.welcomeMember(bot)).skipped, 'bot');
    assert.equal(channel.sent.length, 0);
  });

  test('welcomes bots when the guild opts in', async () => {
    const channel = createChannel();
    const { service } = createService({ welcome: enabledWelcome({ includeBots: true }), channels: { [channel.id]: channel } });
    const bot = createMember();
    bot.user.bot = true;
    const result = await service.welcomeMember(bot);
    assert.equal(result.sent, 1);
  });
});

describe('WelcomeService — delivery', () => {
  let channel;
  beforeEach(() => {
    channel = createChannel();
  });

  test('sends the localized default message when no template is configured', async () => {
    const { service } = createService({ welcome: enabledWelcome(), channels: { [channel.id]: channel } });
    await service.welcomeMember(createMember());

    assert.equal(channel.sent.length, 1);
    const embed = channel.sent[0].embeds[0].toJSON();
    assert.match(embed.description, /Welcome to \*\*xXx Family\*\*/);
    assert.match(embed.description, /<@222222222222222222>/);
    assert.match(embed.description, /#1284/);
  });

  test('renders a custom template with placeholders', async () => {
    const { service } = createService({
      welcome: enabledWelcome({ message: 'Hey {user.name} — server {server.name} now has {memberCount} members.' }),
      channels: { [channel.id]: channel },
    });
    await service.welcomeMember(createMember());
    const embed = channel.sent[0].embeds[0].toJSON();
    assert.match(embed.description, /Hey Ada Lovelace — server xXx Family now has 1284 members\./);
  });

  test('sends to every configured channel', async () => {
    const a = createChannel('888888888888888888');
    const b = createChannel('777777777777777777');
    const { service } = createService({
      welcome: enabledWelcome({ channelIds: [a.id, b.id] }),
      channels: { [a.id]: a, [b.id]: b },
    });
    const result = await service.welcomeMember(createMember());
    assert.equal(result.sent, 2);
    assert.equal(a.sent.length, 1);
    assert.equal(b.sent.length, 1);
  });

  test('a broken channel does not stop the others', async () => {
    const good = createChannel('777777777777777777');
    const { service } = createService({
      welcome: enabledWelcome({ channelIds: ['000000000000000000', good.id] }),
      channels: { [good.id]: good },
    });
    const result = await service.welcomeMember(createMember());
    assert.equal(result.sent, 1);
    assert.equal(good.sent.length, 1);
  });

  test('the message text appears exactly once, not in content AND embed', async () => {
    const { service } = createService({ welcome: enabledWelcome(), channels: { [channel.id]: channel } });
    await service.welcomeMember(createMember());

    const payload = channel.sent[0];
    const description = payload.embeds[0].toJSON().description;
    assert.equal(payload.content, null, 'with an embed enabled the text belongs in the embed only');
    assert.match(description, /Welcome to \*\*xXx Family\*\*/);
  });

  test('a plain-text send carries no embed at all', async () => {
    const { service } = createService({
      welcome: enabledWelcome({ embed: { enabled: false } }),
      channels: { [channel.id]: channel },
    });
    await service.welcomeMember(createMember());
    const payload = channel.sent[0];
    assert.deepEqual(payload.embeds, []);
    assert.match(payload.content, /Welcome to \*\*xXx Family\*\*/);
  });

  test('a custom embed description replaces the message, it does not duplicate it', async () => {
    const { service } = createService({
      welcome: enabledWelcome({
        message: 'the content line',
        embed: { enabled: true, showAvatar: false, description: 'the embed line for {user.name}' },
      }),
      channels: { [channel.id]: channel },
    });
    await service.welcomeMember(createMember());
    const payload = channel.sent[0];
    assert.equal(payload.content, null);
    assert.equal(payload.embeds[0].toJSON().description, 'the embed line for Ada Lovelace');
  });

  test('a display name cannot inject a second render pass', async () => {
    // The default welcome template never mentions {user.name}, so this test
    // needs one that does — otherwise the display name is not in the output at
    // all and the assertion proves nothing.
    const { service } = createService({
      welcome: enabledWelcome({ message: 'Hi {user.name}!', embed: { enabled: true, showAvatar: false } }),
      channels: { [channel.id]: channel },
    });
    const member = createMember();
    member.user.displayName = '{server.name}';
    member.user.username = '{server.name}';
    await service.welcomeMember(member);

    const description = channel.sent[0].embeds[0].toJSON().description;
    assert.equal(description, 'Hi {server.name}!', 'the display name must survive as literal text');
  });

  test('uses the guild language for the default message', async () => {
    const { service } = createService({
      welcome: enabledWelcome({ language: 'id-ID' }),
      channels: { [channel.id]: channel },
    });
    await service.welcomeMember(createMember());
    const embed = channel.sent[0].embeds[0].toJSON();
    assert.match(embed.description, /Selamat datang di \*\*xXx Family\*\*/);
    assert.match(embed.title, /Selamat datang!/);
  });

  test('includes the avatar as a thumbnail when configured', async () => {
    const { service } = createService({ welcome: enabledWelcome(), channels: { [channel.id]: channel } });
    await service.welcomeMember(createMember());
    assert.equal(channel.sent[0].embeds[0].toJSON().thumbnail.url, 'https://cdn.discordapp.com/avatars/222/a.png');
  });

  test('omits the thumbnail when showAvatar is off', async () => {
    const { service } = createService({
      welcome: enabledWelcome({ embed: { enabled: true, showAvatar: false } }),
      channels: { [channel.id]: channel },
    });
    await service.welcomeMember(createMember());
    assert.equal(channel.sent[0].embeds[0].toJSON().thumbnail, undefined);
  });
});

describe('WelcomeService — auto roles', () => {
  let channel;
  beforeEach(() => {
    channel = createChannel();
  });

  test('grants the configured roles', async () => {
    const { service } = createService({
      welcome: enabledWelcome({ autoRoles: ['20'] }),
      channels: { [channel.id]: channel },
    });
    const member = createMember();
    const result = await service.welcomeMember(member);
    assert.deepEqual(result.roles, ['20']);
    assert.deepEqual(member.__added, ['20']);
  });

  test('refuses a role at or above the bot highest role', async () => {
    const { service } = createService({
      welcome: enabledWelcome({ autoRoles: ['99'] }),
      channels: { [channel.id]: channel },
    });
    const member = createMember();
    const result = await service.welcomeMember(member);
    assert.deepEqual(result.roles, [], 'role 99 (position 50) is above the bot (position 10)');
    assert.deepEqual(member.__added, []);
  });

  test('skips a role that no longer exists', async () => {
    const { service } = createService({
      welcome: enabledWelcome({ autoRoles: ['12345'] }),
      channels: { [channel.id]: channel },
    });
    const result = await service.welcomeMember(createMember());
    assert.deepEqual(result.roles, []);
  });

  test('does not re-grant a role the member already has', async () => {
    const { service } = createService({
      welcome: enabledWelcome({ autoRoles: ['10'] }),
      channels: { [channel.id]: channel },
    });
    const member = createMember();
    const result = await service.welcomeMember(member);
    assert.deepEqual(result.roles, ['10']);
    assert.deepEqual(member.__added, [], 'already present, so no API call');
  });
});

describe('WelcomeService — DM, rejoin and milestones', () => {
  let channel;
  beforeEach(() => {
    channel = createChannel();
  });

  test('sends a DM when enabled and reports failure without throwing', async () => {
    const { service } = createService({
      welcome: enabledWelcome({ dm: { enabled: true, message: null } }),
      channels: { [channel.id]: channel },
    });
    const member = createMember();
    assert.equal((await service.welcomeMember(member)).dm, true);
    assert.match(member.__dms[0], /Welcome to \*\*xXx Family\*\*/);

    const closed = createMember({ dmFails: true });
    assert.equal((await service.welcomeMember(closed)).dm, false);
  });

  test('greets a quick return as a rejoin', async () => {
    const { service } = createService({ welcome: enabledWelcome(), channels: { [channel.id]: channel } });
    await service.farewellMember(createMember());
    const result = await service.welcomeMember(createMember());
    assert.equal(result.rejoin, true);
    assert.match(channel.sent.at(-1).embeds[0].toJSON().description, /Welcome back/);
  });

  test('a return outside the window is a normal welcome', async () => {
    const tracker = new LeaveTracker();
    const { service } = createService({
      welcome: enabledWelcome({ rejoin: { detect: true, windowMinutes: 1 } }),
      channels: { [channel.id]: channel },
    });
    service.leaveTracker = tracker;
    tracker.entries.set('111111111111111111:222222222222222222', Date.now() - 5 * 60_000);
    const result = await service.welcomeMember(createMember());
    assert.equal(result.rejoin, false);
  });

  test('announces a milestone member', async () => {
    const { service } = createService({
      welcome: enabledWelcome({ milestones: { enabled: true, every: 100 } }),
      channels: { [channel.id]: channel },
    });
    const member = createMember();
    member.guild.memberCount = 1300;
    const result = await service.welcomeMember(member);
    assert.equal(result.milestone, true);
    assert.match(channel.sent[0].embeds[0].toJSON().description, /is our member \*\*#1300\*\*/);
  });

  test('no milestone when the count is not a multiple', async () => {
    const { service } = createService({
      welcome: enabledWelcome({ milestones: { enabled: true, every: 100 } }),
      channels: { [channel.id]: channel },
    });
    assert.equal((await service.welcomeMember(createMember())).milestone, false, '1284 is not a multiple of 100');
  });
});

describe('WelcomeService — goodbye', () => {
  let channel;
  beforeEach(() => {
    channel = createChannel();
  });

  const enabledGoodbye = (overrides = {}) => ({
    guildId: '111111111111111111',
    enabled: true,
    channelId: '999999999999999999',
    message: null,
    embed: { enabled: true, showAvatar: false },
    skipOnRemoval: true,
    includeBots: false,
    showDuration: true,
    language: null,
    ...overrides,
  });

  test('sends the localized goodbye with the stay duration', async () => {
    const { service } = createService({ goodbye: enabledGoodbye(), channels: { [channel.id]: channel } });
    const result = await service.farewellMember(createMember());
    assert.equal(result.sent, 1);
    const embed = channel.sent[0].embeds[0].toJSON();
    assert.match(embed.description, /\*\*Ada Lovelace\*\* left the server/);
    assert.match(embed.description, /They stayed for 1h\./);
  });

  test('stays silent after a kick or ban when skipOnRemoval is set', async () => {
    const { service } = createService({ goodbye: enabledGoodbye(), channels: { [channel.id]: channel } });
    assert.equal((await service.farewellMember(createMember(), { removed: true })).skipped, 'removed');
    assert.equal(channel.sent.length, 0);
  });

  test('reports a removal when the guild wants it', async () => {
    const { service } = createService({ goodbye: enabledGoodbye({ skipOnRemoval: false }), channels: { [channel.id]: channel } });
    await service.farewellMember(createMember(), { removed: true });
    assert.match(channel.sent[0].embeds[0].toJSON().description, /was removed from the server/);
  });

  test('records the leave even when goodbye messages are disabled', async () => {
    const { service } = createService({ goodbye: enabledGoodbye({ enabled: false }), channels: { [channel.id]: channel } });
    assert.equal((await service.farewellMember(createMember())).skipped, 'disabled');
    assert.equal(service.leaveTracker.size, 1, 'rejoin detection must still work');
  });
});

describe('WelcomeService — audit and resilience', () => {
  test('writes an audit record for a join', async () => {
    const channel = createChannel();
    const { service, auditRows } = createService({ welcome: enabledWelcome(), channels: { [channel.id]: channel } });
    await service.welcomeMember(createMember());
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].type, 'member.join');
    assert.equal(auditRows[0].targetId, '222222222222222222');
  });

  test('works with the database offline (no config, no audit, no throw)', async () => {
    const channel = createChannel();
    const { service } = createService({ dbReady: false, channels: { [channel.id]: channel } });
    const result = await service.welcomeMember(createMember());
    assert.equal(result.skipped, 'disabled');
  });

  test('a throwing channel send never escapes', async () => {
    const hostile = { id: '999999999999999999', isTextBased: () => true, async send() { throw new Error('Missing Permissions'); } };
    const { service } = createService({ welcome: enabledWelcome(), channels: { [hostile.id]: hostile } });
    const result = await service.welcomeMember(createMember());
    assert.equal(result.sent, 0);
  });
});

describe('LeaveTracker', () => {
  test('reports a rejoin inside the window and forgets it afterwards', () => {
    const tracker = new LeaveTracker();
    tracker.markLeave('g', 'u');
    assert.equal(tracker.consume('g', 'u', 60_000).rejoined, true);
    assert.equal(tracker.consume('g', 'u', 60_000).rejoined, false, 'consumed once');
  });

  test('reports no rejoin outside the window', () => {
    const tracker = new LeaveTracker();
    tracker.entries.set('g:u', Date.now() - 120_000);
    const result = tracker.consume('g', 'u', 60_000);
    assert.equal(result.rejoined, false);
    assert.ok(result.awayMs >= 120_000);
  });

  test('sweeps stale entries once it grows', () => {
    const tracker = new LeaveTracker(1000);
    for (let i = 0; i < 600; i += 1) tracker.entries.set(`g:${i}`, Date.now() - 10_000);
    tracker.markLeave('g', 'new');
    assert.ok(tracker.size < 600, `expected a sweep, size=${tracker.size}`);
  });
});
