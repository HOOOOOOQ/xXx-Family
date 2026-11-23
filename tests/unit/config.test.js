import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../../src/config/index.js';
import { LOCALE_CODES, DEFAULT_LOCALE, fromDiscordLocale, isSupportedLocale } from '../../src/config/locales.js';
import { ConfigError } from '../../src/utils/errors.js';

describe('config loading', () => {
  test('applies defaults when the environment is empty', () => {
    const config = loadConfig({});
    assert.equal(config.env, 'development');
    assert.equal(config.isProduction, false);
    assert.equal(config.i18n.defaultLocale, DEFAULT_LOCALE);
    assert.equal(config.api.port, 4000);
    assert.equal(config.api.host, '0.0.0.0', 'must bind 0.0.0.0 for Termux/proxy previews');
    assert.equal(config.database.enabled, false);
    assert.deepEqual(config.i18n.enabledLocales, LOCALE_CODES);
  });

  test('loads every shipped locale by default', () => {
    const config = loadConfig({});
    assert.equal(config.i18n.enabledLocales.length, 10);
    for (const locale of config.i18n.enabledLocales) assert.ok(isSupportedLocale(locale), locale);
  });

  test('rejects an unsupported DEFAULT_LANGUAGE', () => {
    assert.throws(() => loadConfig({ DEFAULT_LANGUAGE: 'xx-XX' }), ConfigError);
  });

  test('rejects an unsupported ENABLED_LOCALES entry', () => {
    assert.throws(() => loadConfig({ ENABLED_LOCALES: 'en-US,xx-XX' }), ConfigError);
  });

  test('accepts a comma separated ENABLED_LOCALES list and keeps the default first', () => {
    const config = loadConfig({ DEFAULT_LANGUAGE: 'id-ID', ENABLED_LOCALES: 'id-ID, en-US ,ja-JP' });
    assert.deepEqual(config.i18n.enabledLocales, ['id-ID', 'en-US', 'ja-JP']);
    assert.equal(config.i18n.defaultLocale, 'id-ID');
  });

  test('reports missing required variables in production instead of booting half-broken', () => {
    const config = loadConfig({ NODE_ENV: 'production' });
    assert.deepEqual(config.missingRequired.sort(), ['DISCORD_TOKEN', 'MONGODB_URI', 'SESSION_SECRET']);
  });

  test('production with a full environment reports nothing missing', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      DISCORD_TOKEN: 'x'.repeat(60),
      MONGODB_URI: 'mongodb+srv://user:pass@cluster.example.net/xxxfamily',
      SESSION_SECRET: 'y'.repeat(48),
      DISCORD_CLIENT_ID: '123456789012345678',
    });
    assert.deepEqual(config.missingRequired, []);
    assert.equal(config.discord.token, 'x'.repeat(60));
  });

  test('rejects a malformed PORT', () => {
    assert.throws(() => loadConfig({ PORT: 'not-a-port' }), ConfigError);
    assert.throws(() => loadConfig({ PORT: '70000' }), ConfigError);
  });

  test('rejects a non-snowflake DEPLOY_GUILD_ID', () => {
    assert.throws(() => loadConfig({ DEPLOY_GUILD_ID: 'my-server' }), ConfigError);
    assert.equal(loadConfig({ DEPLOY_GUILD_ID: '' }).discord.deployGuildId, null);
    assert.equal(loadConfig({ DEPLOY_GUILD_ID: '123456789012345678' }).discord.deployGuildId, '123456789012345678');
  });

  test('parses OWNER_IDS and CORS_ORIGINS into arrays', () => {
    const config = loadConfig({ OWNER_IDS: ' 111 , 222 ', CORS_ORIGINS: 'https://a.example,https://b.example' });
    assert.deepEqual(config.discord.owners, ['111', '222']);
    assert.deepEqual(config.api.corsOrigins, ['https://a.example', 'https://b.example']);
  });

  test('falls back to the dashboard URL when CORS_ORIGINS is empty', () => {
    const config = loadConfig({ DASHBOARD_URL: 'https://dash.example' });
    assert.deepEqual(config.api.corsOrigins, ['https://dash.example']);
  });
});

describe('locale mapping', () => {
  test('maps Discord locale codes to internal codes', () => {
    assert.equal(fromDiscordLocale('id'), 'id-ID');
    assert.equal(fromDiscordLocale('en-US'), 'en-US');
    assert.equal(fromDiscordLocale('pt-BR'), 'pt-BR');
    assert.equal(fromDiscordLocale('fr'), 'fr-FR');
    assert.equal(fromDiscordLocale('ja'), 'ja-JP');
    assert.equal(fromDiscordLocale('ar'), 'ar');
  });

  test('maps an unsupported Discord locale by primary subtag', () => {
    assert.equal(fromDiscordLocale('en-AU'), 'en-US');
    assert.equal(fromDiscordLocale('es-419'), 'es-ES');
    assert.equal(fromDiscordLocale('nl'), null, 'Dutch is not shipped, so it must fall back');
  });

  test('rejects junk input', () => {
    assert.equal(fromDiscordLocale(null), null);
    assert.equal(fromDiscordLocale(undefined), null);
    assert.equal(fromDiscordLocale(''), null);
    assert.equal(fromDiscordLocale(42), null);
  });
});
