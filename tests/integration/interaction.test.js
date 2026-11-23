import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { XxxFamilyClient } from '../../src/bot/client.js';
import { loadConfig } from '../../src/config/index.js';
import { createFakeInteraction } from '../helpers/fakeInteraction.js';
import { CooldownManager } from '../../src/middleware/cooldownManager.js';
import { PermissionFlagsBits } from 'discord.js';

let client;

before(async () => {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'error' });
  client = new XxxFamilyClient(config);
  // No gateway, no MongoDB: this exercises the real handlers against fakes.
  await client.initialize({ connectDatabase: false, loadEvents: false });
});

// Each test acts as a different member, so a shared per-user cooldown must not
// leak between cases.
beforeEach(() => {
  client.cooldowns = new CooldownManager();
});

describe('client initialisation', () => {
  test('loads commands, events directory, modules and health checks', () => {
    assert.ok(client.commands.size >= 5, `commands: ${client.commands.size}`);
    assert.equal(client.modules.get('core') !== null, true);
    assert.ok(client.health.registeredChecks().includes('database'));
    assert.ok(client.health.registeredChecks().includes('i18n'), 'the core module must add the i18n probe');
  });

  test('the help command registered its component namespace', () => {
    assert.ok(client.components.has('help'), `namespaces: ${[...client.components.keys()]}`);
    assert.ok(client.components.has('language'));
  });

  test('reports a clean load with no errors', () => {
    assert.deepEqual(client.loadErrors, []);
  });

  test('builds deployable payloads with localizations', () => {
    const payloads = client.buildCommandPayloads();
    const language = payloads.find((payload) => payload.name === 'language');
    assert.ok(language);
    assert.equal(language.name_localizations.id, 'bahasa');
    assert.equal(language.description_localizations.ja, '自分の言語やサーバーの言語を管理します。');
  });
});

describe('interaction handler — /ping', () => {
  test('replies in the language the member selected', async () => {
    const interaction = createFakeInteraction({ commandName: 'ping' });
    await client.interactionHandler.handle(interaction);

    assert.equal(interaction.__calls.deferReply, 1);
    assert.equal(interaction.__calls.editReply.length, 1);
    const embed = interaction.__calls.editReply[0].embeds[0].toJSON();
    assert.match(embed.title, /Connection status/);
    assert.ok(embed.fields.some((field) => field.name === 'Round trip'));
  });

  test('answers an Indonesian client in Indonesian', async () => {
    const interaction = createFakeInteraction({ commandName: 'ping', locale: 'id' });
    await client.interactionHandler.handle(interaction);
    const embed = interaction.__calls.editReply[0].embeds[0].toJSON();
    assert.match(embed.title, /Status koneksi/);
    assert.ok(embed.fields.some((field) => field.name === 'Bolak-balik'));
    assert.ok(!embed.fields.some((field) => field.name === 'Round trip'), 'must not mix languages');
  });

  test('answers an Arabic client right-to-left', async () => {
    const interaction = createFakeInteraction({ commandName: 'ping', locale: 'ar' });
    await client.interactionHandler.handle(interaction);
    assert.equal(interaction.__locale, 'ar');
    const embed = interaction.__calls.editReply[0].embeds[0].toJSON();
    assert.match(embed.title, /حالة الاتصال/);
  });
});

describe('interaction handler — /uptime', () => {
  test('reports process and database state', async () => {
    const interaction = createFakeInteraction({ commandName: 'uptime' });
    await client.interactionHandler.handle(interaction);
    const embed = interaction.__calls.reply[0].embeds[0].toJSON();
    assert.match(embed.title, /System uptime/);
    assert.ok(embed.fields.some((field) => field.name === 'Uptime'));
  });
});

describe('interaction handler — /language', () => {
  test('`user` explains which locale is applied and why', async () => {
    const interaction = createFakeInteraction({
      commandName: 'language',
      locale: 'ja',
      options: { __subcommand: 'user' },
    });
    await client.interactionHandler.handle(interaction);
    const embed = interaction.__calls.reply[0].embeds[0].toJSON();
    assert.match(embed.title, /言語/);
    assert.ok(embed.fields.some((field) => field.value.includes('日本語')));
  });

  test('`list` renders every locale plus a select menu', async () => {
    const interaction = createFakeInteraction({ commandName: 'language', options: { __subcommand: 'list' } });
    await client.interactionHandler.handle(interaction);

    const embed = interaction.__calls.reply[0].embeds[0].toJSON();
    assert.match(embed.description, /en-US/);
    assert.match(embed.description, /id-ID/);
    assert.match(embed.description, /10 languages available/);

    const row = interaction.__calls.reply[0].components[0].toJSON();
    assert.equal(row.components[0].type, 3, 'a string select menu');
    assert.equal(row.components[0].options.length, 10);
    assert.equal(row.components[0].custom_id, 'language:select:user');
    assert.equal(row.components[0].placeholder, 'Select a language');
  });

  test('`set` reports a failure in the member locale, not in English', async () => {
    const interaction = createFakeInteraction({
      commandName: 'language',
      locale: 'es', // Spanish-speaking member, no MongoDB behind the write
      options: { __subcommand: 'set', language: 'pt-BR' },
    });
    await client.interactionHandler.handle(interaction);
    const embed = interaction.__calls.reply[0].embeds[0].toJSON();
    assert.match(embed.description, /No encontré/, `expected a Spanish error, got: ${embed.description}`);
    assert.ok(!/could not find/i.test(embed.description), 'must not fall back to English');
  });

  test('a successful `set` is confirmed in the NEWLY selected language', async () => {
    // Inject a working store so the write path can be exercised end to end.
    const store = new Map();
    const originalSet = client.settings.setUserLanguage.bind(client.settings);
    const originalGet = client.settings.getUserSettings.bind(client.settings);
    client.settings.setUserLanguage = async (userId, locale) => {
      store.set(userId, locale);
      return { userId, language: locale, persisted: true };
    };
    client.settings.getUserSettings = async (userId) => ({
      userId,
      language: store.get(userId) ?? null,
      preferences: {},
      persisted: true,
    });

    try {
      const interaction = createFakeInteraction({
        commandName: 'language',
        locale: 'en-US',
        options: { __subcommand: 'set', language: 'id-ID' },
      });
      await client.interactionHandler.handle(interaction);
      const embed = interaction.__calls.reply[0].embeds[0].toJSON();
      assert.match(
        embed.description,
        /Bahasa pribadi kamu sekarang \*\*🇮🇩 Bahasa Indonesia\*\*/,
        `expected an Indonesian confirmation, got: ${embed.description}`,
      );
      assert.match(embed.title, /✅ Bahasa/);
    } finally {
      client.settings.setUserLanguage = originalSet;
      client.settings.getUserSettings = originalGet;
    }
  });

  test('`server` requires ManageGuild', async () => {
    const interaction = createFakeInteraction({
      commandName: 'language',
      permissions: [PermissionFlagsBits.SendMessages],
      options: { __subcommand: 'server', language: 'id-ID' },
    });
    await client.interactionHandler.handle(interaction);
    const embed = interaction.__calls.reply[0].embeds[0].toJSON();
    assert.match(embed.description, /missing the required permissions/i);
    assert.match(embed.description, /ManageGuild/);
  });
});

describe('interaction handler — /help', () => {
  test('groups commands by category', async () => {
    const interaction = createFakeInteraction({ commandName: 'help' });
    await client.interactionHandler.handle(interaction);
    const embed = interaction.__calls.reply[0].embeds[0].toJSON();
    assert.match(embed.title, /Command directory/);
    assert.ok(embed.fields.some((field) => /UTILITY/.test(field.name)));
    assert.ok(embed.fields.some((field) => /ADMIN/.test(field.name)));
  });

  test('shows the details of one command', async () => {
    const interaction = createFakeInteraction({ commandName: 'help', options: { command: 'language' } });
    await client.interactionHandler.handle(interaction);
    const embed = interaction.__calls.reply[0].embeds[0].toJSON();
    assert.equal(embed.title, '/language');
    assert.match(embed.description, /Manage your language/);
  });

  test('the category select menu narrows the list', async () => {
    // Seed the picker through /help, then drive the component handler directly.
    const select = createFakeInteraction({ kind: 'selectMenu', customId: 'help:category:admin', selectValues: ['admin'] });
    await client.interactionHandler.handle(select);
    const embed = select.__calls.update[0].embeds[0].toJSON();
    assert.ok(embed.fields.every((field) => !/UTILITY/.test(field.name)), 'utility commands must be filtered out');
    assert.ok(embed.fields.some((field) => /ADMIN/.test(field.name)));
  });

  test('an unknown component namespace is reported, not swallowed', async () => {
    const interaction = createFakeInteraction({ kind: 'button', customId: 'ghost:action' });
    await client.interactionHandler.handle(interaction);
    const embed = interaction.__calls.reply[0].embeds[0].toJSON();
    assert.match(embed.description, /no longer valid/i);
  });
});

describe('interaction handler — error contract', () => {
  test('an unknown command yields a localized not-found reply', async () => {
    const interaction = createFakeInteraction({ commandName: 'ghost' });
    await client.interactionHandler.handle(interaction);
    const embed = interaction.__calls.reply[0].embeds[0].toJSON();
    assert.match(embed.description, /That command does not exist/);
  });

  test('a failing command never leaks a stack trace to the user', async () => {
    client.commands.set('boom', {
      name: 'boom',
      category: 'utility',
      cooldown: 0,
      guildOnly: false,
      ownerOnly: false,
      userPermissions: [],
      botPermissions: [],
      i18nKey: 'ping',
      async execute() {
        throw new Error('secret internal detail with password=hunter2');
      },
    });
    const interaction = createFakeInteraction({ commandName: 'boom' });
    await client.interactionHandler.handle(interaction);

    const payload = JSON.stringify(interaction.__calls.reply[0]);
    assert.match(payload, /Something went wrong/);
    assert.ok(!payload.includes('hunter2'), 'no secret may reach the user');
    assert.ok(!payload.includes('secret internal detail'), 'no internal message may reach the user');
    assert.ok(!payload.includes('at '), 'no stack trace may reach the user');
    client.commands.delete('boom');
  });

  test('a cooldown is reported with the remaining wait', async () => {
    client.commands.set('slow', {
      name: 'slow',
      category: 'utility',
      cooldown: 30_000,
      guildOnly: false,
      ownerOnly: false,
      userPermissions: [],
      botPermissions: [],
      i18nKey: 'ping',
      async execute(interaction) {
        await interaction.reply({ content: 'ok' });
      },
    });

    const first = createFakeInteraction({ commandName: 'slow', userId: '777' });
    await client.interactionHandler.handle(first);
    assert.equal(first.__calls.reply.length, 1);

    const second = createFakeInteraction({ commandName: 'slow', userId: '777' });
    await client.interactionHandler.handle(second);
    const embed = second.__calls.reply[0].embeds[0].toJSON();
    assert.match(embed.description, /wait 30 seconds/);
    client.commands.delete('slow');
  });

  test('a disabled module blocks its commands', async () => {
    const guildId = '555000000000000000';
    // Simulate the guild having switched the "utility" module off.
    const original = client.settings.getGuildSettings.bind(client.settings);
    client.settings.getGuildSettings = async (id) => {
      if (id !== guildId) return original(id);
      return { guildId: id, language: null, moduleToggles: { utility: false }, features: {}, channels: {}, persisted: true };
    };

    const interaction = createFakeInteraction({ commandName: 'ping', guildId });
    await client.interactionHandler.handle(interaction);
    const embed = interaction.__calls.reply[0].embeds[0].toJSON();
    assert.match(embed.description, /under maintenance/);

    client.settings.getGuildSettings = original;
  });
});
