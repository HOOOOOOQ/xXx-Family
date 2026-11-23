import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';

import { XxxFamilyClient } from '../../src/bot/client.js';
import { loadConfig } from '../../src/config/index.js';
import { WelcomeService, LeaveTracker } from '../../src/services/welcomeService.js';
import { LoggingService } from '../../src/services/loggingService.js';
import { SettingsService } from '../../src/services/settingsService.js';
import { CacheManager } from '../../src/services/cacheManager.js';
import { CooldownManager } from '../../src/middleware/cooldownManager.js';
import { createFakeInteraction } from '../helpers/fakeInteraction.js';

const silentLogger = { child: () => silentLogger, debug() {}, info() {}, warn() {}, error() {}, errorFrom() {} };

const GUILD_ID = '111111111111111111';
const LOG_CHANNEL = '999999999999999999';

/** In-memory WelcomeConfig / GoodbyeConfig with the Mongoose surface used. */
function createConfigStore(initial = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    findOne: ({ guildId }) => ({ lean: async () => rows.get(guildId) ?? null }),
    findOneAndUpdate: async ({ guildId }, update) => {
      const current = rows.get(guildId) ?? { guildId };
      const next = { ...current };
      for (const [path, value] of Object.entries(update.$set ?? {})) {
        if (path.includes('.')) {
          const [a, b] = path.split('.');
          next[a] = { ...(next[a] ?? {}), [b]: value };
        } else {
          next[path] = value;
        }
      }
      rows.set(guildId, next);
      return next;
    },
    updateOne: async () => ({ acknowledged: true }),
  };
}

function createChannel(id = LOG_CHANNEL) {
  const sent = [];
  return {
    sent,
    id,
    type: 0, // GuildText
    isTextBased: () => true,
    async send(payload) {
      sent.push(payload);
      return { id: 'msg-1' };
    },
  };
}

let client;
let store;
let channel;
let auditRows;

before(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });

  store = createConfigStore();
  channel = createChannel();
  auditRows = [];

  const settings = new SettingsService({
    models: {
      GuildSettings: { findOne: () => ({ lean: () => ({ exec: async () => null }) }) },
      UserSettings: { findOne: () => ({ lean: () => ({ exec: async () => null }) }) },
      LanguageOverride: { find: () => ({ sort: () => ({ limit: () => ({ lean: () => ({ exec: async () => [] }) }) }) }) },
    },
    cache: new CacheManager({ autoSweep: false }),
    isDbReady: () => true,
    logger: silentLogger,
  });

  const logging = new LoggingService({
    model: {
      create: async (doc) => (auditRows.push(doc), { _id: `a${auditRows.length}` }),
      countDocuments: async () => 0,
      find: () => ({ sort: () => ({ limit: () => ({ skip: () => ({ lean: async () => [] }) }) }) }),
    },
    settings,
    isDbReady: () => true,
    resolveChannel: async () => null,
    logger: silentLogger,
  });

  const welcome = new WelcomeService({
    models: { WelcomeConfig: store, GoodbyeConfig: createConfigStore() },
    settings,
    logging,
    resolveChannel: async (id) => (id === LOG_CHANNEL ? channel : null),
    isDbReady: () => true,
    leaveTracker: new LeaveTracker(),
    logger: silentLogger,
  });

  client = new XxxFamilyClient(config, {}, { settings, logging, welcome });
  await client.initialize({ connectDatabase: false, loadEvents: false });
});

beforeEach(() => {
  client.cooldowns = new CooldownManager();
  store.rows.clear();
  channel.sent.length = 0;
  auditRows.length = 0;
});

/** Run /welcome with the given subcommand and options. */
async function run(subcommand, options = {}, overrides = {}) {
  const interaction = createFakeInteraction({
    commandName: 'welcome',
    options: { __subcommand: subcommand, ...options },
    client,
    ...overrides,
  });
  await client.interactionHandler.handle(interaction);
  return interaction;
}

function replyEmbeds(interaction) {
  const payload = interaction.__calls.reply[0] ?? interaction.__calls.editReply[0];
  return (payload?.embeds ?? []).map((embed) => embed.toJSON());
}

describe('/welcome — registration', () => {
  test('the command is loaded and localized', () => {
    assert.ok(client.commands.has('welcome'), `commands: ${[...client.commands.keys()]}`);
    const payload = client.buildCommandPayloads().find((p) => p.name === 'welcome');
    assert.equal(payload.name_localizations.id, 'welcome');
    assert.deepEqual(
      payload.options.map((o) => o.name),
      ['view', 'enable', 'disable', 'channel', 'message', 'goodbye', 'roles', 'test'],
    );
  });

  test('subcommand names are localized per locale', () => {
    const payload = client.buildCommandPayloads().find((p) => p.name === 'welcome');
    const view = payload.options.find((o) => o.name === 'view');
    assert.equal(view.name_localizations.id, 'tampilan');
    assert.equal(view.name_localizations['es-ES'], 'ver');
    assert.equal(view.name_localizations.ja, 'ひょうじ');
    assert.equal(view.name_localizations.ko, '보기');
  });

  test('it is guild-only and gated behind ManageGuild', () => {
    const payload = client.buildCommandPayloads().find((p) => p.name === 'welcome');
    assert.deepEqual(payload.contexts, [0], 'InteractionContextType.Guild only');
    assert.equal(BigInt(payload.default_member_permissions), PermissionFlagsBits.ManageGuild);
  });

  test('the welcome module booted and registered its health probe', () => {
    assert.ok(client.modules.get('welcome') !== null, `modules: ${[...client.modules.status().map((m) => m.name)]}`);
    assert.ok(client.health.registeredChecks().includes('welcome'));
  });
});

describe('/welcome — permissions', () => {
  test('a member without ManageGuild is refused', async () => {
    const interaction = await run('enable', {}, { permissions: [PermissionFlagsBits.ViewChannel] });
    const [embed] = replyEmbeds(interaction);
    assert.ok(embed, 'must reply with an error');
    assert.match(JSON.stringify(embed), /ManageGuild/i);
    assert.equal(store.rows.size, 0, 'nothing was written');
  });

  test('a DM is refused', async () => {
    const interaction = await run('view', {}, { guildId: null });
    const [embed] = replyEmbeds(interaction);
    assert.ok(embed);
    assert.equal(store.rows.size, 0);
  });
});

describe('/welcome view', () => {
  test('shows the default configuration for an unconfigured guild', async () => {
    const interaction = await run('view');
    const embeds = replyEmbeds(interaction);
    assert.equal(embeds.length, 2, 'a config panel plus a placeholder help panel');

    const [panel, help] = embeds;
    assert.match(panel.title, /Welcome configuration/);
    const status = panel.fields.find((f) => f.name === 'Status');
    assert.equal(status.value, 'Disabled');
    const channelField = panel.fields.find((f) => f.name === 'Channel');
    assert.equal(channelField.value, 'No channel set');
    assert.match(help.description, /Available placeholders/);
    assert.match(help.description, /`\{user\.mention\}`/);
  });

  test('the panel is ephemeral', async () => {
    const interaction = await run('view');
    // MessageFlags.Ephemeral === 64
    assert.equal(interaction.__calls.reply[0].flags, 64);
  });

  test('an Indonesian admin gets an Indonesian panel', async () => {
    const interaction = await run('view', {}, { locale: 'id' });
    const [panel] = replyEmbeds(interaction);
    assert.match(panel.title, /Konfigurasi sambutan/);
    assert.ok(panel.fields.some((f) => f.name === 'Status' && f.value === 'Nonaktif'));
    assert.ok(!JSON.stringify(panel).includes('Welcome configuration'), 'must not mix languages');
  });

  test('reflects saved configuration', async () => {
    store.rows.set(GUILD_ID, {
      guildId: GUILD_ID,
      enabled: true,
      channelIds: [LOG_CHANNEL],
      message: 'Hi {user.mention}',
      autoRoles: ['555555555555555555'],
    });
    const interaction = await run('view');
    const [panel] = replyEmbeds(interaction);
    assert.equal(panel.fields.find((f) => f.name === 'Status').value, 'Enabled');
    assert.match(panel.fields.find((f) => f.name === 'Channel').value, /<#999999999999999999>/);
    assert.match(panel.fields.find((f) => f.name === 'Auto roles').value, /<@&555555555555555555>/);
    assert.match(panel.fields.find((f) => f.name === 'Message').value, /Hi \{user\.mention\}/);
  });
});

describe('/welcome enable + channel', () => {
  test('enabling without a channel is refused, not silently ignored', async () => {
    const interaction = await run('enable');
    const [embed] = replyEmbeds(interaction);
    assert.match(JSON.stringify(embed), /Set a channel first/i);
    assert.equal(store.rows.size, 0);
  });

  test('setting a channel saves it', async () => {
    const interaction = await run('channel', { channel });
    const [embed] = replyEmbeds(interaction);
    assert.match(JSON.stringify(embed), /will be sent to <#999999999999999999>/);
    assert.deepEqual(store.rows.get(GUILD_ID).channelIds, [LOG_CHANNEL]);
  });

  test('clearing the channel also disables the feature', async () => {
    store.rows.set(GUILD_ID, { guildId: GUILD_ID, enabled: true, channelIds: [LOG_CHANNEL] });
    const interaction = await run('channel', { channel: null });
    assert.match(JSON.stringify(replyEmbeds(interaction)[0]), /cleared/i);
    assert.deepEqual(store.rows.get(GUILD_ID).channelIds, []);
    assert.equal(store.rows.get(GUILD_ID).enabled, false);
  });

  test('enable after a channel is set succeeds', async () => {
    store.rows.set(GUILD_ID, { guildId: GUILD_ID, enabled: false, channelIds: [LOG_CHANNEL] });
    await run('enable');
    assert.equal(store.rows.get(GUILD_ID).enabled, true);
  });

  test('disable always succeeds', async () => {
    store.rows.set(GUILD_ID, { guildId: GUILD_ID, enabled: true, channelIds: [LOG_CHANNEL] });
    await run('disable');
    assert.equal(store.rows.get(GUILD_ID).enabled, false);
  });

  test('a non-text channel is refused', async () => {
    const voice = { id: '999999999999999999', type: 2, name: 'General Voice', isTextBased: () => false };
    const interaction = await run('channel', { channel: voice });
    const [embed] = replyEmbeds(interaction);
    assert.match(JSON.stringify(embed), /That channel type cannot receive messages/);
    assert.ok(!JSON.stringify(embed).includes('{{'), 'no raw placeholder may reach the user');
    assert.equal(store.rows.size, 0, 'nothing was saved');
  });
});

describe('/welcome message', () => {
  test('a template with an unknown placeholder is refused and named', async () => {
    store.rows.set(GUILD_ID, { guildId: GUILD_ID, channelIds: [LOG_CHANNEL] });
    const interaction = await run('message', { text: 'Hello {user.nicknmae}!' });
    const [embed] = replyEmbeds(interaction);
    assert.match(JSON.stringify(embed), /user\.nicknmae/);
    assert.equal(store.rows.get(GUILD_ID).message, undefined, 'the bad template was not saved');
  });

  test('a valid template is saved', async () => {
    store.rows.set(GUILD_ID, { guildId: GUILD_ID, channelIds: [LOG_CHANNEL] });
    await run('message', { text: 'Welcome {user.mention} to {server.name}!' });
    assert.equal(store.rows.get(GUILD_ID).message, 'Welcome {user.mention} to {server.name}!');
  });

  test('omitting the text resets to the localized default', async () => {
    store.rows.set(GUILD_ID, { guildId: GUILD_ID, channelIds: [LOG_CHANNEL], message: 'custom' });
    const interaction = await run('message', { text: null });
    assert.match(JSON.stringify(replyEmbeds(interaction)[0]), /reset to the default/i);
    assert.equal(store.rows.get(GUILD_ID).message, null);
  });
});

describe('/welcome roles', () => {
  const role = (id, position) => ({ id, name: `role-${id}`, position });

  test('adds a role below the bot hierarchy', async () => {
    store.rows.set(GUILD_ID, { guildId: GUILD_ID, channelIds: [LOG_CHANNEL], autoRoles: [] });
    const interaction = await run('roles', { role: role('555555555555555555', 3) });
    assert.match(JSON.stringify(replyEmbeds(interaction)[0]), /is now granted on join/);
    assert.deepEqual(store.rows.get(GUILD_ID).autoRoles, ['555555555555555555']);
  });

  test('toggles a role off when it is already configured', async () => {
    store.rows.set(GUILD_ID, { guildId: GUILD_ID, channelIds: [LOG_CHANNEL], autoRoles: ['555555555555555555'] });
    const interaction = await run('roles', { role: role('555555555555555555', 3) });
    assert.match(JSON.stringify(replyEmbeds(interaction)[0]), /no longer granted/);
    assert.deepEqual(store.rows.get(GUILD_ID).autoRoles, []);
  });

  test('refuses a role at or above the bot highest role', async () => {
    store.rows.set(GUILD_ID, { guildId: GUILD_ID, channelIds: [LOG_CHANNEL], autoRoles: [] });
    const interaction = await run('roles', { role: role('666666666666666666', 99) });
    const [embed] = replyEmbeds(interaction);
    assert.match(JSON.stringify(embed), /above my highest role/i);
    assert.ok(!JSON.stringify(embed).includes('{{'), 'no raw placeholder may reach the user');
    assert.deepEqual(store.rows.get(GUILD_ID).autoRoles, []);
  });

  test('refuses the @everyone role', async () => {
    store.rows.set(GUILD_ID, { guildId: GUILD_ID, channelIds: [LOG_CHANNEL], autoRoles: [] });
    const interaction = await run('roles', { role: role(GUILD_ID, 0) });
    assert.match(JSON.stringify(replyEmbeds(interaction)[0]), /@everyone/i);
    assert.deepEqual(store.rows.get(GUILD_ID).autoRoles, []);
  });
});

describe('/welcome test', () => {
  test('refuses when no channel is configured', async () => {
    const interaction = await run('test');
    assert.match(JSON.stringify(replyEmbeds(interaction)[0]), /Set a channel first/i);
    assert.equal(channel.sent.length, 0);
  });

  test('sends a preview and does not write an audit join', async () => {
    store.rows.set(GUILD_ID, { guildId: GUILD_ID, enabled: true, channelIds: [LOG_CHANNEL] });
    const interaction = await run('test');
    assert.equal(channel.sent.length, 1);
    assert.match(JSON.stringify(replyEmbeds(interaction)[0]), /A test welcome message was sent/);
    assert.equal(auditRows.length, 0, 'a preview must not create a member.join record');
    assert.equal(store.rows.get(GUILD_ID).meta, undefined, 'a preview must not bump the counter');
  });
});

describe('/welcome — end to end through the real event path', () => {
  test('an enabled guild gets a welcome message when a member joins', async () => {
    store.rows.set(GUILD_ID, { guildId: GUILD_ID, enabled: true, channelIds: [LOG_CHANNEL] });

    const member = {
      id: '444444444444444444',
      partial: false,
      joinedTimestamp: Date.now(),
      guild: {
        id: GUILD_ID,
        name: 'Test Guild',
        memberCount: 1300,
        iconURL: () => null,
        roles: { cache: new Map() },
        members: { me: { roles: { highest: { position: 10 } } } },
      },
      roles: { cache: new Map(), add: async () => {} },
      user: {
        id: '444444444444444444',
        username: 'newbie',
        displayName: 'Newbie',
        bot: false,
        createdTimestamp: Date.now() - 86400_000,
        displayAvatarURL: () => null,
      },
      send: async () => ({}),
    };

    const handler = (await import('../../src/bot/events/guildMemberAdd.js')).default;
    await handler.execute(client, member);

    assert.equal(channel.sent.length, 1);
    const embed = channel.sent[0].embeds[0].toJSON();
    // 1300 is a multiple of 100, so the milestone message wins over the
    // ordinary welcome — that is the intended precedence.
    assert.match(embed.description, /is our member \*\*#1300\*\*/);
    assert.match(embed.description, /<@444444444444444444>/);
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].type, 'member.join');
    assert.equal(auditRows[0].reason, 'milestone');
  });

  test('a non-milestone join gets the ordinary welcome message', async () => {
    store.rows.set(GUILD_ID, { guildId: GUILD_ID, enabled: true, channelIds: [LOG_CHANNEL] });

    const member = {
      id: '444444444444444444',
      partial: false,
      joinedTimestamp: Date.now(),
      guild: {
        id: GUILD_ID,
        name: 'Test Guild',
        memberCount: 1284,
        iconURL: () => null,
        roles: { cache: new Map() },
        members: { me: { roles: { highest: { position: 10 } } } },
      },
      roles: { cache: new Map(), add: async () => {} },
      user: {
        id: '444444444444444444',
        username: 'newbie',
        displayName: 'Newbie',
        bot: false,
        createdTimestamp: Date.now() - 86400_000,
        displayAvatarURL: () => null,
      },
      send: async () => ({}),
    };

    const handler = (await import('../../src/bot/events/guildMemberAdd.js')).default;
    await handler.execute(client, member);

    const embed = channel.sent[0].embeds[0].toJSON();
    assert.match(embed.description, /Welcome to \*\*Test Guild\*\*/);
    assert.match(embed.description, /#1284/);
    assert.equal(auditRows[0].reason, null);
  });

  test('a disabled guild produces nothing at all', async () => {
    const member = {
      id: '444444444444444444',
      partial: false,
      guild: { id: GUILD_ID, name: 'Test Guild', memberCount: 5, iconURL: () => null, roles: { cache: new Map() }, members: { me: { roles: { highest: { position: 10 } } } } },
      user: { id: '444444444444444444', username: 'newbie', bot: false, displayAvatarURL: () => null },
    };
    const handler = (await import('../../src/bot/events/guildMemberAdd.js')).default;
    await handler.execute(client, member);
    assert.equal(channel.sent.length, 0);
    assert.equal(auditRows.length, 0);
  });

  test('a member leaving is recorded for rejoin detection', async () => {
    const member = {
      id: '444444444444444444',
      guild: { id: GUILD_ID, name: 'Test Guild', memberCount: 4, iconURL: () => null, roles: { cache: new Map() }, members: { me: { roles: { highest: { position: 10 } } } } },
      user: { id: '444444444444444444', username: 'leaver', bot: false, displayAvatarURL: () => null },
    };
    const handler = (await import('../../src/bot/events/guildMemberRemove.js')).default;
    await handler.execute(client, member);
    assert.equal(client.welcome.leaveTracker.size, 1);
  });
});
