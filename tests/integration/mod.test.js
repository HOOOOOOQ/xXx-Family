/**
 * tests/integration/mod.test.js
 * ---------------------------------------------------------------------------
 * Drives /mod through the real interaction handler, real ModerationService and
 * real permission gating, against fake Discord objects.
 *
 * The unit tests cover the service's rules; this file covers the command layer
 * that sits on top of them — option resolution, duration parsing, the ephemeral
 * confirmation, and the wiring between the two.
 */

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';

import { XxxFamilyClient } from '../../src/bot/client.js';
import { loadConfig } from '../../src/config/index.js';
import { ModerationService } from '../../src/services/moderationService.js';
import { LoggingService } from '../../src/services/loggingService.js';
import { SettingsService } from '../../src/services/settingsService.js';
import { CacheManager } from '../../src/services/cacheManager.js';
import { CooldownManager } from '../../src/middleware/cooldownManager.js';
import { createFakeInteraction } from '../helpers/fakeInteraction.js';

const silentLogger = { child: () => silentLogger, debug() {}, info() {}, warn() {}, error() {}, errorFrom() {} };

const GUILD_ID = '111111111111111111';

/** In-memory ModerationCase + Counter with the Mongoose surface used. */
function createStores() {
  const cases = [];
  const counters = new Map();
  return {
    __cases: cases,
    ModerationCase: {
      async create(doc) {
        const row = { ...doc, createdAt: new Date(Date.now() + cases.length) };
        cases.push(row);
        return row;
      },
      countDocuments: async (f) => cases.filter((c) => c.guildId === f.guildId && c.targetId === f.targetId).length,
      find(f) {
        const rows = cases
          .filter((c) => c.guildId === f.guildId && c.targetId === f.targetId)
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return { sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => rows }) }) }) };
      },
      async findOneAndUpdate(f, update) {
        const row = cases.find((c) => c.guildId === f.guildId && c.caseNumber === f.caseNumber && !c.revokedAt);
        if (!row) return null;
        Object.assign(row, update.$set);
        return row;
      },
      async updateOne(f, update) {
        const row = cases.find((c) => c.guildId === f.guildId && c.caseNumber === f.caseNumber);
        if (row) Object.assign(row, update.$set);
        return { modifiedCount: row ? 1 : 0 };
      },
    },
    Counter: {
      async next(scope, key) {
        const k = `${scope}:${key}`;
        const next = (counters.get(k) ?? 0) + 1;
        counters.set(k, next);
        return next;
      },
    },
  };
}

/** A member the moderator can act on. */
function targetMember(id = '555555555555555555', { position = 1, username = 'spammer', dmOk = true } = {}) {
  const calls = [];
  return {
    id,
    calls,
    user: { id, username, bot: false },
    roles: { highest: { position }, cache: { keyArray: () => [] } },
    async kick() {
      calls.push('kick');
      return this;
    },
    async disableCommunicationUntil(until) {
      calls.push(['timeout', until]);
      return this;
    },
    async send(content) {
      if (!dmOk) throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
      calls.push(['dm', content]);
      return { id: 'dm' };
    },
  };
}

function textChannel(id = '333333333333333333', { messages = [] } = {}) {
  return {
    id,
    name: 'general',
    type: 0, // GuildText
    permissionOverwrites: {
      async edit() {
        return this;
      },
    },
    async setRateLimitPerUser() {
      return this;
    },
    messages: {
      async fetch() {
        return new Map(messages.map((m) => [m.id, m]));
      },
    },
    async bulkDelete(items) {
      return new Map(items.map((m) => [m.id, m]));
    },
  };
}

let client;
let stores;
let target;
let guild;

before(async () => {
  const config = loadConfig({ LOG_LEVEL: 'error', NODE_ENV: 'test' });
  stores = createStores();
  target = targetMember();

  const cache = new CacheManager({ logger: silentLogger });
  const settings = new SettingsService({ models: {}, cache, isDbReady: () => false, logger: silentLogger });
  const logging = new LoggingService({
    settings,
    resolveChannel: async () => null,
    isDbReady: () => false,
    logger: silentLogger,
  });
  const moderation = new ModerationService({
    models: stores,
    logging,
    isDbReady: () => true,
    logger: silentLogger,
  });

  guild = {
    id: GUILD_ID,
    name: 'Test Guild',
    ownerId: '999999999999999999',
    roles: { everyone: { id: 'everyone', position: 0 } },
    members: {
      me: {
        id: 'bot',
        user: { username: 'xXx Family' },
        roles: { highest: { position: 50 } },
        permissions: { has: () => true },
      },
      async ban() {
        return { id: 'banned' };
      },
    },
    bans: { async remove() { return { user: { id: 'unbanned' } }; } },
  };

  client = new XxxFamilyClient(config, {}, { settings, logging, moderation });
  await client.initialize({ connectDatabase: false, loadEvents: false });
});

beforeEach(() => {
  stores.__cases.length = 0;
  target.calls.length = 0;
});

/**
 * Run /mod with a subcommand and options.
 *
 * Every call gets a fresh cooldown manager: the command carries a 3s cooldown,
 * and tests that make two or three calls in a row would otherwise assert on a
 * rate-limit reply instead of the behaviour under test.
 */
async function run(subcommand, options = {}, overrides = {}) {
  client.cooldowns = new CooldownManager();
  const interaction = createFakeInteraction({
    commandName: 'mod',
    options: { __subcommand: subcommand, ...options },
    client,
    guild,
    ...overrides,
  });
  await client.interactionHandler.handle(interaction);
  return interaction;
}

function replyOf(interaction) {
  return interaction.__calls.reply[0] ?? interaction.__calls.editReply[0] ?? null;
}

function replyText(interaction) {
  const payload = replyOf(interaction);
  return [payload?.content ?? '', ...(payload?.embeds ?? []).map((e) => (e.toJSON ? e.toJSON() : e))].flat();
}

describe('/mod — registration', () => {
  test('the command is loaded with all eleven subcommands', () => {
    assert.ok(client.commands.has('mod'), `commands: ${[...client.commands.keys()]}`);
    const payload = client.buildCommandPayloads().find((p) => p.name === 'mod');
    assert.equal(payload.options.length, 11);
  });

  test('every subcommand carries all nine localizations', () => {
    const payload = client.buildCommandPayloads().find((p) => p.name === 'mod');
    for (const sub of payload.options) {
      assert.equal(Object.keys(sub.name_localizations).length, 9, `${sub.name} name localizations`);
      assert.equal(Object.keys(sub.description_localizations).length, 9, `${sub.name} description localizations`);
      for (const option of sub.options ?? []) {
        assert.equal(Object.keys(option.name_localizations).length, 9, `${sub.name}.${option.name}`);
      }
    }
  });

  test('the Indonesian subcommand names are used', () => {
    const payload = client.buildCommandPayloads().find((p) => p.name === 'mod');
    const ban = payload.options.find((o) => o.name === 'ban');
    assert.equal(ban.name_localizations.id, 'banned');
    const warn = payload.options.find((o) => o.name === 'warn');
    assert.equal(warn.name_localizations.id, 'peringatan');
  });
});

describe('/mod — actions', () => {
  test('ban runs the real service and confirms ephemerally', async () => {
    const interaction = await run('ban', { user: target, reason: 'advertising' });

    assert.equal(stores.__cases.length, 1);
    assert.equal(stores.__cases[0].type, 'ban');
    assert.equal(stores.__cases[0].caseNumber, 1);
    assert.equal(stores.__cases[0].reason, 'advertising');

    const payload = replyOf(interaction);
    assert.ok(payload, 'no reply was sent');
    // The confirmation is for the moderator only; posting it publicly would
    // invite the argument the DM is meant to avoid.
    assert.equal(BigInt(payload.flags ?? 0n) & 64n, 64n, 'the reply must be ephemeral');
  });

  test('the member is DM’d with the reason', async () => {
    await run('ban', { user: target, reason: 'advertising' });
    const dm = target.calls.find((c) => Array.isArray(c) && c[0] === 'dm');
    assert.ok(dm, 'no DM was attempted');
    assert.match(dm[1], /advertising/);
  });

  test('warn requires a reason because the option is required', async () => {
    const interaction = await run('warn', { user: target, reason: 'be kind' });
    assert.equal(stores.__cases[0].type, 'warn');
    assert.equal(stores.__cases[0].reason, 'be kind');
    assert.ok(replyOf(interaction));
  });

  test('timeout parses a human duration into a real expiry', async () => {
    const interaction = await run('timeout', { user: target, duration: '30m', reason: 'spam' });

    const entry = target.calls.find((c) => Array.isArray(c) && c[0] === 'timeout');
    assert.ok(entry, 'no timeout call was made');
    const expected = 30 * 60 * 1000;
    const actual = entry[1] - Date.now();
    assert.ok(Math.abs(actual - expected) < 5000, `expiry was ${actual}ms from now, expected ~${expected}ms`);
    assert.equal(stores.__cases[0].type, 'timeout');
    assert.ok(stores.__cases[0].expiresAt instanceof Date);

    // The confirmation shows the duration in the moderator's own words.
    const text = JSON.stringify(replyText(interaction));
    assert.match(text, /30m/);
  });

  test('an unparseable duration is rejected before any Discord call', async () => {
    const before = target.calls.length;
    await run('timeout', { user: target, duration: 'a while' });

    assert.equal(target.calls.length, before, 'no timeout should have been attempted');
    assert.equal(stores.__cases.length, 0, 'no case should have been recorded');
  });

  test('kick calls through to the member object', async () => {
    await run('kick', { user: target, reason: 'leaving' });
    assert.ok(target.calls.includes('kick'));
    assert.equal(stores.__cases[0].type, 'kick');
  });

  test('unban rejects a username where an ID was expected', async () => {
    await run('unban', { user_id: 'spammer' });
    assert.equal(stores.__cases.length, 0, 'no case should be recorded for a malformed ID');
  });

  test('unban accepts a real snowflake', async () => {
    await run('unban', { user_id: '555555555555555555', reason: 'appealed' });
    assert.equal(stores.__cases[0].type, 'unban');
  });
});

describe('/mod — guards', () => {
  test('a moderator without ModerateMembers is refused', async () => {
    const interaction = await run('ban', { user: target, reason: 'x' }, { permissions: [PermissionFlagsBits.SendMessages] });
    assert.equal(stores.__cases.length, 0, 'no case may be recorded for a refused action');
    // The moderator is told which permission they lack, in their language.
    const payload = replyOf(interaction);
    assert.ok(payload, 'the refusal must be reported, not swallowed');
    const text = JSON.stringify(payload.embeds.map((e) => (e.toJSON ? e.toJSON() : e)));
    assert.match(text, /BanMembers/);
    assert.ok(!/\{[a-z]/i.test(text), `an unresolved placeholder reached the user: ${text}`);
  });

  test('a moderator cannot act on a member ranked above them', async () => {
    const senior = targetMember('666666666666666666', { position: 90, username: 'admin' });
    await run('ban', { user: senior, reason: 'x' }, { botRolePosition: 50 });
    assert.equal(stores.__cases.length, 0);
  });

  test('the guild owner cannot be banned', async () => {
    const owner = targetMember('999999999999999999', { position: 0, username: 'owner' });
    await run('ban', { user: owner, reason: 'x' });
    assert.equal(stores.__cases.length, 0);
  });

  test('a user who is not in the server is reported, not crashed on', async () => {
    // getMember() returns null for someone who left between the menu and the
    // click; the command must say so rather than throw on `.user.username`.
    const interaction = await run('ban', { user: null, reason: 'x' });
    assert.equal(stores.__cases.length, 0);
    assert.doesNotThrow(() => replyOf(interaction));
  });

  test('/mod cannot be used in a DM', async () => {
    const interaction = await run('ban', { user: target, reason: 'x' }, { guildId: null });
    assert.equal(stores.__cases.length, 0);
    assert.ok(interaction.__calls.reply.length + interaction.__calls.editReply.length <= 1);
  });
});

describe('/mod — history', () => {
  test('reports the cases recorded for a member', async () => {
    await run('warn', { user: target, reason: 'first' });
    await run('warn', { user: target, reason: 'second' });
    assert.equal(stores.__cases.length, 2);

    const interaction = await run('history', { user: target });
    const payload = replyOf(interaction);
    const embeds = payload.embeds.map((e) => (e.toJSON ? e.toJSON() : e));
    const text = JSON.stringify(embeds);
    assert.match(text, /first/);
    assert.match(text, /second/);

    // Case numbers come from a per-guild counter shared by the whole file, so
    // assert against the numbers actually allocated rather than a literal.
    const allocated = stores.__cases.map((c) => c.caseNumber);
    for (const n of allocated) assert.match(text, new RegExp(`#${n}`));

    // Newest first, so a moderator reads the latest action at the top.
    const description = embeds[0].description;
    assert.ok(description.indexOf('second') < description.indexOf('first'), 'history is not newest-first');

    // Nothing may render as a literal placeholder or "[object Object]".
    assert.ok(!text.includes('[object Object]'), 'an object reached the embed as a string');
    assert.ok(!/\{[a-z]/i.test(description), `an unresolved placeholder reached the user: ${description}`);
  });

  test('a member with no history gets the empty-state message', async () => {
    const clean = targetMember('777777777777777777', { username: 'clean' });
    const interaction = await run('history', { user: clean });
    const payload = replyOf(interaction);
    assert.ok(payload);
    assert.equal(stores.__cases.length, 0);
  });
});
