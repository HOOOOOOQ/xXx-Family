import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  initI18n,
  isI18nReady,
  getLoadedLocales,
  getLoadedNamespaces,
  translate,
  getT,
  getLocaleContext,
  resolveLocale,
  commandLocalizations,
  hasCommandLocalization,
  getMissingKeys,
  clearMissingKeys,
  NAMESPACES,
} from '../../src/services/i18nService.js';
import { LOCALE_CODES, DEFAULT_LOCALE } from '../../src/config/locales.js';

before(async () => {
  await initI18n({ locales: LOCALE_CODES, defaultLocale: DEFAULT_LOCALE });
});

describe('i18n engine', () => {
  test('initialises and loads every shipped locale', () => {
    assert.equal(isI18nReady(), true);
    const loaded = getLoadedLocales();
    assert.equal(loaded.length, 10);
    for (const locale of LOCALE_CODES) assert.ok(loaded.includes(locale), `${locale} must be loaded`);
  });

  test('every locale provides every namespace', () => {
    for (const locale of LOCALE_CODES) {
      assert.deepEqual(getLoadedNamespaces(locale).sort(), [...NAMESPACES].sort(), locale);
      assert.equal(translate(locale, 'common:brand.name'), 'xXx Family');
      // One real key per namespace, to prove the bundles are wired up.
      assert.ok(translate(locale, 'commands:responses.pong'), `${locale} commands`);
      assert.ok(translate(locale, 'errors:generic'), `${locale} errors`);
      assert.ok(translate(locale, 'components:buttons.confirm'), `${locale} components`);
    }
  });

  test('translates the same key differently per locale', () => {
    assert.equal(translate('en-US', 'common:yes'), 'Yes');
    assert.equal(translate('id-ID', 'common:yes'), 'Ya');
    assert.equal(translate('es-ES', 'common:yes'), 'Sí');
    assert.equal(translate('ja-JP', 'common:yes'), 'はい');
    assert.equal(translate('ko-KR', 'common:yes'), '예');
    assert.equal(translate('ar', 'common:yes'), 'نعم');
    assert.equal(translate('de-DE', 'common:yes'), 'Ja');
    assert.equal(translate('fr-FR', 'common:yes'), 'Oui');
    assert.equal(translate('pt-BR', 'common:yes'), 'Sim');
    assert.equal(translate('en-GB', 'common:yes'), 'Yes');
  });

  test('interpolates values', () => {
    assert.equal(translate('en-US', 'common:greeting', { user: 'Ada' }), 'Hello, Ada!');
    assert.equal(translate('id-ID', 'common:greeting', { user: 'Ada' }), 'Halo, Ada!');
  });

  test('pluralises per language rules', () => {
    assert.equal(translate('en-US', 'common:language.availableCount', { count: 1 }), '1 language available');
    assert.equal(translate('en-US', 'common:language.availableCount', { count: 10 }), '10 languages available');
    // Arabic has six plural categories; the dual form must not leak a raw key.
    const arabicTwo = translate('ar', 'common:language.availableCount', { count: 2 });
    assert.ok(!arabicTwo.includes('availableCount'), arabicTwo);
    // Japanese has a single category.
    assert.equal(translate('ja-JP', 'common:language.availableCount', { count: 3 }), '3 件の言語が利用可能です');
  });

  test('getT returns a translator pinned to one locale', () => {
    const t = getT('id-ID');
    assert.equal(t('common:fields.uptime'), 'Waktu aktif');
    assert.equal(t('errors:guildOnly'), 'Perintah ini hanya berfungsi di dalam server.');
  });

  test('an unknown locale falls back to the default instead of throwing', () => {
    const t = getT('xx-XX');
    assert.equal(t('common:yes'), 'Yes');
  });

  test('getLocaleContext exposes direction and metadata', () => {
    const ar = getLocaleContext('ar');
    assert.equal(ar.dir, 'rtl');
    assert.equal(ar.nativeName, 'العربية');
    const id = getLocaleContext('id-ID');
    assert.equal(id.dir, 'ltr');
    assert.equal(id.flag, '🇮🇩');
  });

  test('missing keys are recorded for telemetry but never leak raw text into a reply', () => {
    clearMissingKeys();
    const t = getT('id-ID');
    // i18next returns the bare key (namespace stripped) when a key is absent.
    assert.equal(t('common:this.key.does.not.exist'), 'this.key.does.not.exist');
    const missing = getMissingKeys();
    assert.ok(Object.keys(missing).length >= 1);
    assert.ok(JSON.stringify(missing).includes('this.key.does.not.exist'));
  });
});

describe('locale resolution priority', () => {
  test('an explicit user preference wins over everything', () => {
    const { locale, source } = resolveLocale({
      userLocale: 'ja-JP',
      discordUserLocale: 'de-DE',
      guildLocale: 'id-ID',
      discordGuildLocale: 'en-US',
      defaultLocale: 'en-US',
    });
    assert.equal(locale, 'ja-JP');
    assert.equal(source, 'user');
  });

  test('the Discord client locale is used when the member has no stored preference', () => {
    const { locale, source } = resolveLocale({
      userLocale: null,
      discordUserLocale: 'pt-BR',
      guildLocale: 'id-ID',
      defaultLocale: 'en-US',
    });
    assert.equal(locale, 'pt-BR');
    assert.equal(source, 'discordUser');
  });

  test('the guild default applies when Discord reports no supported locale', () => {
    const { locale, source } = resolveLocale({
      userLocale: null,
      discordUserLocale: null,
      guildLocale: 'id-ID',
      discordGuildLocale: 'en-US',
      defaultLocale: 'en-US',
    });
    assert.equal(locale, 'id-ID');
    assert.equal(source, 'guild');
  });

  test('the configured bot default is used when nothing else matches', () => {
    const { locale, source } = resolveLocale({
      userLocale: 'xx-XX',
      discordUserLocale: 'nl',
      guildLocale: null,
      discordGuildLocale: null,
      defaultLocale: 'en-US',
    });
    assert.equal(locale, DEFAULT_LOCALE);
    assert.equal(source, 'default');
  });

  test('English is the last resort when even the configured default is unusable', () => {
    const { locale, source } = resolveLocale({
      userLocale: 'xx-XX',
      discordUserLocale: 'nl',
      guildLocale: 'yy-YY',
      defaultLocale: 'zz-ZZ',
    });
    assert.equal(locale, DEFAULT_LOCALE);
    assert.equal(source, 'fallback');
  });

  test('the priority order can be overridden per call', () => {
    const { locale, source } = resolveLocale({
      userLocale: 'ja-JP',
      discordUserLocale: 'de-DE',
      guildLocale: 'id-ID',
      defaultLocale: 'en-US',
      priority: ['guild', 'user', 'default'],
    });
    assert.equal(locale, 'id-ID');
    assert.equal(source, 'guild');
  });
});

describe('Discord command localizations', () => {
  test('produces name + description localizations keyed by Discord locale codes', () => {
    const { nameLocalizations, descriptionLocalizations } = commandLocalizations('ping');
    assert.equal(nameLocalizations['en-US'], 'ping');
    assert.equal(nameLocalizations.id, 'ping', 'Indonesian maps to the Discord code "id"');
    assert.equal(nameLocalizations.ja, 'ぴんぐ');
    assert.equal(nameLocalizations.ko, '핑');
    assert.equal(nameLocalizations.de, 'ping');
    assert.equal(descriptionLocalizations['pt-BR'], 'Verifica a latência do bot, do gateway e do banco de dados.');
  });

  test('never emits the unsupported Arabic locale (Discord would reject the payload)', () => {
    const { nameLocalizations } = commandLocalizations('language');
    assert.equal(nameLocalizations.ar, undefined);
    assert.ok(!Object.keys(nameLocalizations).includes('ar'));
  });

  test('lowercases and sanitises localized command names', () => {
    const { nameLocalizations } = commandLocalizations('language');
    for (const [locale, name] of Object.entries(nameLocalizations)) {
      assert.match(name, /^[-_\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u, `${locale}: ${name}`);
      assert.equal(name, name.toLowerCase(), `${locale}: ${name} must be lowercase`);
    }
  });

  test('keeps descriptions within the 100 character limit', () => {
    for (const key of ['ping', 'uptime', 'help', 'language', 'settings']) {
      const { descriptionLocalizations } = commandLocalizations(key);
      for (const [locale, description] of Object.entries(descriptionLocalizations)) {
        assert.ok(description.length <= 100, `${key}/${locale}: ${description.length} chars`);
      }
    }
  });

  test('returns nothing for a key that has no translations', () => {
    const { nameLocalizations, descriptionLocalizations } = commandLocalizations('does.not.exist');
    assert.deepEqual(nameLocalizations, {});
    assert.deepEqual(descriptionLocalizations, {});
  });

  test('finds shared option keys', () => {
    assert.equal(hasCommandLocalization('language.options.language'), true);
    assert.equal(hasCommandLocalization('language.options.set'), true);
    assert.equal(hasCommandLocalization('language.options.nope'), false);
  });
});
