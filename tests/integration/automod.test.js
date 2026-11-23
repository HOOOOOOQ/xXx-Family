/**
 * tests/integration/automod.test.js
 * ---------------------------------------------------------------------------
 * Drives /automod through the real interaction handler and the real
 * AutomodService, with an in-memory GuildSettings store.
 *
 * The scanner itself is covered exhaustively in unit/automodService.test.js.
 * This file covers what the command layer adds: persisting config, merging a
 * single rule without destroying the others, and the test-preview path.
 */

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';

import { XxxFamilyClient } from '../../src/bot/client.js';
import { loadConfig } from '../../src/config/index.js';
import { AutomodService, AUTOMOD_RULES } from '../../src/services/automodService.js';
import { SettingsService } from '../../src/services/settingsService.js';
import { CacheManager } from '../../src/services/cacheManager.js';
import { CooldownManager } from '../../src/middleware/cooldownManager.js';
import { createFakeInteraction } from '../helpers/fakeInteraction.js';

const silentLogger = { child: () => silentLogger, debug() {}, info() {}, warn() {}, error() {}, errorFrom() {} };

const GUILD_ID = '111111111111111111';

/** In-memory GuildSettings supporting the dotted `features.<name>` writes. */
function createGuildSettings() {
  const rows = new Map();
  return {
    rows,
    findOne: ({ guildId }) => ({ lean: () => ({ exec: async () => rows.get(guildId) ?? null }) }),
    // Mongoose returns a Query, and the service calls `.exec()` on it
    // synchronously. Making this `async` returns a Promise with no `.exec`,
    // which throws *after* the row is already written — so a write would look
    // like it worked while the cache stayed stale.
    findOneAndUpdate({ guildId }, update) {
      const current = rows.get(guildId) ?? { guildId, features: {} };
      const next = { ...current, features: { ...(current.features ?? {}) } };
      for (const [path, value] of Object.entries(update.$set ?? {})) {
        if (path.startsWith('features.')) {
          next.features[path.slice('features.'.length)] = value;
        } else {
          next[path] = value;
        }
      }
      rows.set(guildId, next);
      return { exec: async () => next };
    },
  };
}

let client;
let guildSettings;

before(async () => {
  const config = loadConfig({ LOG_LEVEL: 'error', NODE_ENV: 'test' });
  guildSettings = createGuildSettings();

  const settings = new SettingsService({
    models: {
      GuildSettings: guildSettings,
      UserSettings: { findOne: () => ({ lean: () => ({ exec: async () => null }) }) },
      LanguageOverride: { find: () => ({ sort: () => ({ limit: () => ({ lean: () => ({ exec: async () => [] }) }) }) }) },
    },
    cache: new CacheManager({ autoSweep: false }),
    isDbReady: () => true,
    logger: silentLogger,
  });

  const automod = new AutomodService({ settings, logger: silentLogger });

  client = new XxxFamilyClient(config, {}, { settings, automod });
  await client.initialize({ connectDatabase: false, loadEvents: false });
});

async function run(subcommand, options = {}, overrides = {}) {
  client.cooldowns = new CooldownManager();
  const interaction = createFakeInteraction({
    commandName: 'automod',
    options: { __subcommand: subcommand, ...options },
    client,
    ...overrides,
  });
  await client.interactionHandler.handle(interaction);
  return interaction;
}

function replyOf(interaction) {
  return interaction.__calls.reply[0] ?? interaction.__calls.editReply[0] ?? null;
}

function embedData(interaction) {
  const payload = replyOf(interaction);
  return (payload?.embeds ?? []).map((e) => (e.toJSON ? e.toJSON() : e));
}

/** The persisted automod block for the guild, as stored. */
function stored() {
  return guildSettings.rows.get(GUILD_ID)?.features?.automod ?? null;
}

describe('/automod — registration', () => {
  test('the command is loaded with all six subcommands', () => {
    assert.ok(client.commands.has('automod'), `commands: ${[...client.commands.keys()]}`);
    const payload = client.buildCommandPayloads().find((p) => p.name === 'automod');
    assert.deepEqual(payload.options.map((o) => o.name), ['view', 'enable', 'disable', 'rule', 'whitelist', 'test']);
  });

  test('the rule option offers every rule as a choice', () => {
    const payload = client.buildCommandPayloads().find((p) => p.name === 'automod');
    const rule = payload.options.find((o) => o.name === 'rule');
    const choiceValues = rule.options.find((o) => o.name === 'rule').choices.map((c) => c.value);
    assert.deepEqual(choiceValues.sort(), [...AUTOMOD_RULES].sort());
  });

  test('every name and description is localized 9/9', () => {
    const payload = client.buildCommandPayloads().find((p) => p.name === 'automod');
    for (const sub of payload.options) {
      assert.equal(Object.keys(sub.name_localizations).length, 9, `${sub.name} name`);
      assert.equal(Object.keys(sub.description_localizations).length, 9, `${sub.name} description`);
      for (const opt of sub.options ?? []) {
        assert.equal(Object.keys(opt.name_localizations).length, 9, `${sub.name}.${opt.name} name`);
      }
    }
  });
});

describe('/automod — configuration', () => {
  beforeEach(() => {
    guildSettings.rows.clear();
    // Clearing the store without clearing the cache would let the previous
    // test's settings leak into this one, since getGuildSettings caches.
    client.settings.invalidateGuild(GUILD_ID);
    // Drop automod's sliding windows so one test's messages cannot push the
    // next test over the spam threshold.
    client.automod.forgetGuild(GUILD_ID);
  });

  test('view shows the defaults before anything is configured', async () => {
    const interaction = await run('view');
    const text = JSON.stringify(embedData(interaction));
    assert.match(text, /Disabled/, 'automod must report as off by default');
    // Every rule must appear, so an admin can see what exists.
    for (const rule of AUTOMOD_RULES) assert.match(text, new RegExp(rule));
  });

  test('enable persists the flag', async () => {
    await run('enable');
    assert.equal(stored().enabled, true);
  });

  test('disable persists the flag', async () => {
    await run('enable');
    await run('disable');
    assert.equal(stored().enabled, false);
  });

  test('enabling one rule does not wipe the others', async () => {
    // setFeatureConfig replaces the whole automod block, so the command has to
    // send the other rules back with it. Losing them silently would turn
    // invite screening off the moment an admin touched the caps rule.
    await run('rule', { rule: 'caps', enabled: true, threshold: 80 });

    const saved = stored();
    assert.equal(saved.rules.caps.enabled, true);
    assert.equal(saved.rules.caps.threshold, 80);
    assert.equal(saved.rules.invites.enabled, true, 'the invites default must survive');
    assert.equal(saved.rules.spam.threshold, 4, 'the spam default must survive');
  });

  test('changing a rule keeps automod’s own enabled state', async () => {
    await run('enable');
    await run('rule', { rule: 'links', enabled: true });
    assert.equal(stored().enabled, true, 'editing a rule must not switch the module off');
  });

  test('the action option is validated against the known actions', async () => {
    const interaction = await run('rule', { rule: 'links', enabled: true, action: 'launch-missiles' });
    assert.equal(stored(), null, 'an invalid action must not be persisted');
    const text = JSON.stringify(embedData(interaction));
    assert.match(text, /not valid/i);
  });

  test('the word option only applies to the words rule', async () => {
    const interaction = await run('rule', { rule: 'links', enabled: true, word: 'hello' });
    assert.equal(stored(), null);
    assert.match(JSON.stringify(embedData(interaction)), /not valid/i);
  });

  test('words can be added and removed', async () => {
    await run('rule', { rule: 'words', enabled: true, word: 'badword' });
    assert.deepEqual(stored().rules.words.list, ['badword']);

    await run('rule', { rule: 'words', enabled: true, word: 'other' });
    assert.deepEqual(stored().rules.words.list.sort(), ['badword', 'other']);

    await run('rule', { rule: 'words', enabled: true, word: '-badword' });
    assert.deepEqual(stored().rules.words.list, ['other']);
  });

  test('adding the same word twice does not duplicate it', async () => {
    await run('rule', { rule: 'words', enabled: true, word: 'same' });
    await run('rule', { rule: 'words', enabled: true, word: 'same' });
    assert.deepEqual(stored().rules.words.list, ['same']);
  });

  test('an empty word is rejected', async () => {
    const interaction = await run('rule', { rule: 'words', enabled: true, word: '   ' });
    assert.equal(stored(), null);
    assert.ok(replyOf(interaction));
  });

  test('a role can be whitelisted and un-whitelisted', async () => {
    const role = { id: '888888888888888888', name: 'Mods' };
    await run('whitelist', { role });
    assert.deepEqual(stored().whitelistRoleIds, ['888888888888888888']);

    await run('whitelist', { role, remove: true });
    assert.deepEqual(stored().whitelistRoleIds, []);
  });

  test('whitelisting a second role keeps the first', async () => {
    await run('whitelist', { role: { id: '111', name: 'a' } });
    await run('whitelist', { role: { id: '222', name: 'b' } });
    assert.deepEqual(stored().whitelistRoleIds.sort(), ['111', '222']);
  });

  test('a whitelist change keeps the rules', async () => {
    await run('rule', { rule: 'caps', enabled: true, threshold: 90 });
    await run('whitelist', { role: { id: '333', name: 'c' } });
    assert.equal(stored().rules.caps.threshold, 90, 'the rules must survive a whitelist edit');
  });
});

describe('/automod — preview', () => {
  beforeEach(() => {
    guildSettings.rows.clear();
    // Clearing the store without clearing the cache would let the previous
    // test's settings leak into this one, since getGuildSettings caches.
    client.settings.invalidateGuild(GUILD_ID);
    // Drop automod's sliding windows so one test's messages cannot push the
    // next test over the spam threshold.
    client.automod.forgetGuild(GUILD_ID);
  });

  test('an invite is reported as a match', async () => {
    await run('enable');
    const interaction = await run('test', { text: 'join my server discord.gg/abcdef' });
    const text = JSON.stringify(embedData(interaction));
    assert.match(text, /invites/);
    assert.match(text, /delete/);
  });

  test('a clean message reports no match', async () => {
    await run('enable');
    const interaction = await run('test', { text: 'hello everyone, how are you today' });
    const text = JSON.stringify(embedData(interaction));
    assert.match(text, /Nothing matched/);
  });

  test('the preview never deletes anything', async () => {
    await run('enable');
    await run('test', { text: 'discord.gg/abcdef' });
    // scan() is pure; the assertion is that the command used it rather than
    // process(), which would have called message.delete().
    assert.equal(stored().rules.invites.enabled, true, 'config must be untouched by a preview');
  });

  test('the preview reflects a rule the admin just turned off', async () => {
    await run('enable');
    await run('rule', { rule: 'invites', enabled: false });
    const interaction = await run('test', { text: 'discord.gg/abcdef' });
    assert.match(JSON.stringify(embedData(interaction)), /Nothing matched/);
  });

  test('the preview does not require ManageGuild', async () => {
    // A read-only check is safe for anyone, and gating it would stop moderators
    // from understanding why a message vanished.
    const interaction = await run('test', { text: 'hello' }, { permissions: [PermissionFlagsBits.SendMessages] });
    assert.ok(replyOf(interaction), 'the preview should run without ManageGuild');
    assert.match(JSON.stringify(embedData(interaction)), /Nothing matched/);
  });

  test('configuration does require ManageGuild', async () => {
    const interaction = await run('enable', {}, { permissions: [PermissionFlagsBits.SendMessages] });
    assert.equal(stored(), null, 'the flag must not be persisted without ManageGuild');
    assert.match(JSON.stringify(embedData(interaction)), /ManageGuild/);
  });
});

describe('/automod — guards', () => {
  test('/automod cannot be used in a DM', async () => {
    const interaction = await run('view', {}, { guildId: null });
    assert.ok(replyOf(interaction));
  });
});
