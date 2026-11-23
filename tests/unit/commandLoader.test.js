import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { SlashCommandBuilder } from 'discord.js';

import { validateCommand, loadCommands, localizeCommandPayload } from '../../src/handlers/commandLoader.js';
import { initI18n } from '../../src/services/i18nService.js';
import { LOCALE_CODES, DEFAULT_LOCALE } from '../../src/config/locales.js';
import { ROOT_DIR } from '../../src/config/index.js';

const COMMANDS_DIR = join(ROOT_DIR, 'src', 'bot', 'commands');

before(async () => {
  await initI18n({ locales: LOCALE_CODES, defaultLocale: DEFAULT_LOCALE });
});

describe('command validation', () => {
  const valid = () => ({
    data: new SlashCommandBuilder().setName('ping').setDescription('Check latency.'),
    execute: async () => {},
  });

  test('accepts a valid command and fills in the defaults', () => {
    const command = validateCommand(valid(), 'ping.js');
    assert.equal(command.name, 'ping');
    assert.equal(command.category, 'general');
    assert.equal(command.guildOnly, false);
    assert.equal(command.ownerOnly, false);
    assert.deepEqual(command.userPermissions, []);
    assert.ok(command.cooldown > 0);
    assert.equal(command.i18nKey, 'ping');
  });

  test('rejects a command without a data builder', () => {
    assert.throws(() => validateCommand({ execute: async () => {} }, 'a.js'), /valid "data" builder/);
  });

  test('rejects a command without execute()', () => {
    assert.throws(
      () => validateCommand({ data: new SlashCommandBuilder().setName('x').setDescription('y') }, 'a.js'),
      /execute\(\) function/,
    );
  });

  test('rejects a non-conforming command name', () => {
    for (const bad of ['Ping', 'has space', 'a'.repeat(33), '']) {
      const builder = new SlashCommandBuilder().setDescription('y');
      // setName validates too, so poke the JSON directly for the exotic cases.
      const json = { name: bad, description: 'y', options: [] };
      const fake = { toJSON: () => json };
      assert.throws(() => validateCommand({ data: fake, execute: async () => {} }, 'a.js'), /invalid command name/, bad);
      assert.ok(builder);
    }
  });

  test('rejects a non-function autocomplete', () => {
    assert.throws(
      () => validateCommand({ ...valid(), autocomplete: 'nope' }, 'a.js'),
      /not a function/,
    );
  });
});

describe('loading the real command tree', () => {
  test('loads every shipped command', async () => {
    const { commands, errors } = await loadCommands(COMMANDS_DIR);
    assert.deepEqual(errors, []);
    assert.ok(commands.size >= 5, `expected at least 5 commands, got ${commands.size}`);
    for (const name of ['ping', 'uptime', 'help', 'language', 'settings']) {
      assert.ok(commands.has(name), `missing command ${name}`);
    }
  });

  test('assigns a category to every command', async () => {
    const { commands } = await loadCommands(COMMANDS_DIR);
    for (const command of commands.values()) {
      assert.ok(command.category, command.name);
      assert.equal(typeof command.execute, 'function', command.name);
    }
  });

  test('rejects duplicate command names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xxx-cmd-'));
    await mkdir(join(dir, 'sub'));
    // A hermetic fixture: no imports, so it loads from anywhere on disk.
    const source = `
      export default {
        data: { toJSON: () => ({ name: 'dup', description: 'd', options: [] }) },
        execute: async () => {},
      };
    `;
    await writeFile(join(dir, 'a.js'), source);
    await writeFile(join(dir, 'sub', 'b.js'), source);
    try {
      await assert.rejects(() => loadCommands(dir, { strict: true }), /duplicate command name/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('non-strict mode collects errors instead of throwing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xxx-cmd-'));
    await writeFile(join(dir, 'broken.js'), 'export default { nope: true };');
    try {
      const { commands, errors } = await loadCommands(dir, { strict: false });
      assert.equal(commands.size, 0);
      assert.equal(errors.length, 1);
      assert.match(errors[0].message, /valid "data" builder/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a missing directory is not an error (a fresh clone has none)', async () => {
    const { commands, errors } = await loadCommands(join(ROOT_DIR, 'src', 'does-not-exist'));
    assert.equal(commands.size, 0);
    assert.deepEqual(errors, []);
  });
});

describe('localized payloads', () => {
  test('attaches name/description localizations for the root command', async () => {
    const { commands } = await loadCommands(COMMANDS_DIR);
    const payload = localizeCommandPayload(commands.get('language'));

    assert.equal(payload.name, 'language', 'the internal routing name never changes');
    assert.equal(payload.name_localizations.id, 'bahasa');
    assert.equal(payload.name_localizations['es-ES'], 'idioma');
    assert.equal(payload.name_localizations.de, 'sprache');
    assert.equal(payload.name_localizations.ar, undefined, 'Arabic is not a Discord command locale');
  });

  test('localizes subcommands', async () => {
    const { commands } = await loadCommands(COMMANDS_DIR);
    const payload = localizeCommandPayload(commands.get('language'));
    const set = payload.options.find((option) => option.name === 'set');
    assert.equal(set.name_localizations.id, 'atur');
    assert.equal(set.name_localizations['es-ES'], 'establecer');
    assert.equal(set.name_localizations.fr, 'definir');
    assert.equal(set.name_localizations['pt-BR'], 'definir');
  });

  test('localizes an option shared by several subcommands via the fallback key', async () => {
    const { commands } = await loadCommands(COMMANDS_DIR);
    const payload = localizeCommandPayload(commands.get('language'));
    for (const subName of ['set', 'server']) {
      const sub = payload.options.find((option) => option.name === subName);
      const option = sub.options.find((o) => o.name === 'language');
      assert.ok(option.name_localizations, `${subName} -> language option must be localized`);
      assert.equal(option.name_localizations.id, 'bahasa');
      assert.equal(option.name_localizations.de, 'sprache');
    }
  });

  test('localizes the settings subcommands', async () => {
    const { commands } = await loadCommands(COMMANDS_DIR);
    const payload = localizeCommandPayload(commands.get('settings'));
    assert.equal(payload.name_localizations.id, 'pengaturan');
    const view = payload.options.find((option) => option.name === 'view');
    assert.equal(view.name_localizations.id, 'lihat');
    assert.equal(view.name_localizations.ja, 'ひょうじ');
  });

  test('keeps option choices intact', async () => {
    const { commands } = await loadCommands(COMMANDS_DIR);
    const payload = localizeCommandPayload(commands.get('language'));
    const set = payload.options.find((option) => option.name === 'set');
    const option = set.options.find((o) => o.name === 'language');
    assert.equal(option.choices.length, 10, 'one choice per shipped locale');
    assert.ok(option.choices.every((choice) => typeof choice.value === 'string' && choice.value.length > 0));
  });
});
