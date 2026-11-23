import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderTemplate,
  listPlaceholders,
  findUnknownPlaceholders,
  resolvePath,
  placeholderCatalogue,
} from '../../src/utils/templates.js';
import { translate, initI18n } from '../../src/services/i18nService.js';
import { LOCALE_CODES } from '../../src/config/locales.js';
import { DEFAULT_WELCOME_CONFIG } from '../../src/database/models/WelcomeConfig.js';
import { DEFAULT_GOODBYE_CONFIG } from '../../src/database/models/GoodbyeConfig.js';

before(async () => {
  await initI18n({ locales: LOCALE_CODES, defaultLocale: 'en-US' });
});

const values = {
  user: {
    mention: '<@222222222222222222>',
    name: 'Ada Lovelace',
    tag: 'ada',
    id: '222222222222222222',
    avatar: 'https://cdn.discordapp.com/avatars/222/a.png',
    created: '<t:1700000000:R>',
  },
  server: { name: 'xXx Family', id: '111111111111111111', memberCount: 1284 },
  memberCount: 1284,
};

describe('template engine', () => {
  test('substitutes nested placeholders', () => {
    assert.equal(
      renderTemplate('Hi {user.name}, welcome to {server.name}!', values),
      'Hi Ada Lovelace, welcome to xXx Family!',
    );
  });

  test('leaves mentions and timestamps intact (they are markup, not text)', () => {
    const out = renderTemplate('{user.mention} joined {user.created}', values);
    assert.equal(out, '<@222222222222222222> joined <t:1700000000:R>');
  });

  test('escapes markdown in substituted text values', () => {
    const out = renderTemplate('{user.name}', { user: { name: '**bold** @everyone' } });
    assert.equal(out, '\\*\\*bold\\*\\* \\@everyone', 'a display name must not be able to format or ping');
  });

  test('unknown placeholders stay visible by default', () => {
    assert.equal(renderTemplate('Hello {user.nickname}!', values), 'Hello {user.nickname}!');
  });

  test('strict mode blanks unknown placeholders', () => {
    assert.equal(renderTemplate('Hello {user.nickname}!', values, { strict: true }), 'Hello !');
  });

  test('never throws on junk input', () => {
    assert.equal(renderTemplate(null, values), '');
    assert.equal(renderTemplate(undefined, values), '');
    assert.equal(renderTemplate('', values), '');
    assert.equal(renderTemplate('{user}', {}), '{user}');
    assert.equal(renderTemplate('{a.b.c}', values), '{a.b.c}');
  });

  test('truncates to a maximum length', () => {
    const out = renderTemplate('{server.name}', { server: { name: 'x'.repeat(50) } }, { maxLength: 10 });
    assert.ok(out.length <= 10);
  });

  test('resolves deep paths and reports misses', () => {
    assert.equal(resolvePath(values, 'server.name'), 'xXx Family');
    assert.equal(resolvePath(values, 'server.nope.deep'), undefined);
    assert.equal(resolvePath({}, 'a.b'), undefined);
  });

  test('lists placeholders without duplicates', () => {
    assert.deepEqual(listPlaceholders('{user.name} and {user.name} and {server.name}'), [
      'user.name',
      'server.name',
    ]);
    assert.deepEqual(listPlaceholders('no placeholders'), []);
    assert.deepEqual(listPlaceholders(null), []);
  });

  test('finds the typos in an admin-supplied template', () => {
    const unknown = findUnknownPlaceholders('{user.name} {user.nicknmae} {server.name}', values);
    assert.deepEqual(unknown, ['user.nicknmae']);
  });

  test('the catalogue examples render without leftovers', () => {
    for (const entry of placeholderCatalogue()) {
      assert.equal(typeof entry.path, 'string');
      assert.equal(typeof entry.example, 'string');
    }
    const paths = placeholderCatalogue().map((entry) => entry.path);
    assert.ok(paths.includes('user.mention'));
    assert.ok(paths.includes('memberCount'));
    assert.equal(new Set(paths).size, paths.length, 'catalogue paths must be unique');
  });
});

describe('localized default messages', () => {
  /** Every placeholder the localized defaults rely on. */
  const templateValues = {
    ...values,
    duration: '3d 4h',
  };

  test('every locale ships a welcome and goodbye default', () => {
    for (const locale of LOCALE_CODES) {
      assert.ok(translate(locale, 'common:welcome.message').length > 0, `${locale} welcome.message`);
      assert.ok(translate(locale, 'common:goodbye.message').length > 0, `${locale} goodbye.message`);
    }
  });

  test('every locale default renders with no leftover placeholders', () => {
    const problems = [];
    for (const locale of LOCALE_CODES) {
      for (const key of ['welcome.message', 'welcome.rejoin', 'welcome.milestone', 'welcome.dm', 'goodbye.message', 'goodbye.duration', 'goodbye.removed']) {
        const rendered = renderTemplate(translate(locale, `common:${key}`), templateValues, { strict: false });
        const leftovers = rendered.match(/\{[a-zA-Z][a-zA-Z0-9_.]*\}/g);
        if (leftovers) problems.push(`${locale} ${key}: ${leftovers.join(', ')}`);
      }
    }
    assert.deepEqual(problems, []);
  });

  test('the defaults are actually translated, not English copies', () => {
    const english = translate('en-US', 'common:welcome.message');
    for (const locale of ['id-ID', 'es-ES', 'pt-BR', 'fr-FR', 'de-DE', 'ja-JP', 'ko-KR', 'ar']) {
      assert.notEqual(translate(locale, 'common:welcome.message'), english, `${locale} must differ from English`);
    }
  });

  test('the Indonesian default reads naturally and keeps the placeholders', () => {
    const rendered = renderTemplate(translate('id-ID', 'common:welcome.message'), templateValues);
    assert.equal(
      rendered,
      'Selamat datang di **xXx Family**, <@222222222222222222>! Kamu anggota ke-**#1284**.',
    );
  });

  test('the Japanese default renders the member count correctly', () => {
    const rendered = renderTemplate(translate('ja-JP', 'common:welcome.milestone'), templateValues);
    assert.match(rendered, /1284/);
    assert.match(rendered, /人目のメンバー/);
  });
});

describe('welcome/goodbye default configuration', () => {
  test('welcome defaults are safe: disabled, no channels, no roles', () => {
    assert.equal(DEFAULT_WELCOME_CONFIG.enabled, false, 'must never auto-enable on a fresh server');
    assert.deepEqual(DEFAULT_WELCOME_CONFIG.channelIds, []);
    assert.deepEqual(DEFAULT_WELCOME_CONFIG.autoRoles, []);
    assert.equal(DEFAULT_WELCOME_CONFIG.dm.enabled, false);
    assert.equal(DEFAULT_WELCOME_CONFIG.includeBots, false, 'bots must not be welcomed by default');
    assert.equal(DEFAULT_WELCOME_CONFIG.message, null, 'null means "use the localized default"');
  });

  test('goodbye defaults skip messages after a kick or ban', () => {
    assert.equal(DEFAULT_GOODBYE_CONFIG.enabled, false);
    assert.equal(DEFAULT_GOODBYE_CONFIG.skipOnRemoval, true);
    assert.equal(DEFAULT_GOODBYE_CONFIG.includeBots, false);
  });

  test('rejoin detection is bounded to a sane window', () => {
    assert.equal(DEFAULT_WELCOME_CONFIG.rejoin.detect, true);
    assert.equal(DEFAULT_WELCOME_CONFIG.rejoin.windowMinutes, 60);
  });

  test('milestones default to every 100th member', () => {
    assert.equal(DEFAULT_WELCOME_CONFIG.milestones.enabled, true);
    assert.equal(DEFAULT_WELCOME_CONFIG.milestones.every, 100);
  });
});
