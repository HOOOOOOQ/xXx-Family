import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { LOCALES_DIR, ROOT_DIR } from '../../src/config/index.js';
import { LOCALES, LOCALE_CODES, LOCALE_MAP } from '../../src/config/locales.js';
import { NAMESPACES, initI18n } from '../../src/services/i18nService.js';
import { loadCommands } from '../../src/handlers/commandLoader.js';

/** Flatten a translation bundle into `path -> value`. */
function flatten(value, prefix = '', out = new Map()) {
  if (value === null || typeof value !== 'object') {
    out.set(prefix, value);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

const bundles = new Map(); // locale -> ns -> bundle
const flat = new Map(); // locale -> Map<ns:key, value>

before(async () => {
  for (const locale of LOCALE_CODES) {
    const perNamespace = {};
    const flattened = new Map();
    for (const ns of NAMESPACES) {
      const file = join(LOCALES_DIR, locale, `${ns}.json`);
      perNamespace[ns] = JSON.parse(readFileSync(file, 'utf8'));
      for (const [key, value] of flatten(perNamespace[ns])) flattened.set(`${ns}:${key}`, value);
    }
    bundles.set(locale, perNamespace);
    flat.set(locale, flattened);
  }
  await initI18n({ locales: LOCALE_CODES, defaultLocale: 'en-US' });
});

describe('translation files', () => {
  test('every shipped locale exists on disk with every namespace', () => {
    const dirs = readdirSync(LOCALES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(dirs, [...LOCALE_CODES].sort());

    for (const locale of LOCALE_CODES) {
      for (const ns of NAMESPACES) {
        assert.ok(existsSync(join(LOCALES_DIR, locale, `${ns}.json`)), `${locale}/${ns}.json`);
      }
    }
  });

  test('every locale is declared in the locale registry', () => {
    for (const locale of LOCALES) {
      assert.ok(LOCALE_CODES.includes(locale.code), `${locale.code} missing from LOCALE_CODES`);
      assert.ok(LOCALE_MAP.get(locale.code) === locale);
      assert.ok(locale.nativeName, `${locale.code} needs a native name`);
      assert.ok(locale.flag, `${locale.code} needs a flag`);
    }
  });

  test('Arabic is the only RTL locale and the only one without a Discord code', () => {
    const rtl = LOCALES.filter((locale) => locale.rtl).map((locale) => locale.code);
    assert.deepEqual(rtl, ['ar']);
    const withoutDiscord = LOCALES.filter((locale) => !locale.discord).map((locale) => locale.code);
    assert.deepEqual(withoutDiscord, ['ar']);
  });

  test('every Discord locale code is unique', () => {
    const codes = LOCALES.map((locale) => locale.discord).filter(Boolean);
    assert.equal(new Set(codes).size, codes.length);
  });

  test('no locale is left as an untranslated copy of English', () => {
    const reference = flat.get('en-US');
    for (const locale of LOCALE_CODES) {
      if (locale === 'en-US') continue;
      // en-GB is British English: it legitimately differs from en-US in only a
      // handful of strings (spelling, wording), so the "must differ" rule does
      // not apply. Its parity is covered by the key-parity tests instead.
      if (locale === 'en-GB') continue;
      const candidate = flat.get(locale);
      let translated = 0;
      let compared = 0;
      for (const [key, value] of reference) {
        if (typeof value !== 'string' || !value.trim()) continue;
        // Brand strings and pure numbers are legitimately identical everywhere.
        if (key.startsWith('common:brand.') || /^[\d\s.,:%-]+$/.test(value)) continue;
        compared += 1;
        if (candidate.get(key) !== value) translated += 1;
      }
      const ratio = translated / compared;
      assert.ok(ratio > 0.6, `${locale}: only ${(ratio * 100).toFixed(0)}% of ${compared} strings differ from English`);
    }
  });
});

describe('key parity across locales', () => {
  test('no locale is missing a key the reference defines', () => {
    const reference = flat.get('en-US');
    const problems = [];
    for (const locale of LOCALE_CODES) {
      if (locale === 'en-US') continue;
      const candidate = flat.get(locale);
      for (const key of reference.keys()) {
        if (!candidate.has(key)) problems.push(`${locale} missing ${key}`);
      }
    }
    assert.deepEqual(problems, []);
  });

  test('no locale carries orphan keys', () => {
    const reference = flat.get('en-US');
    const problems = [];
    for (const locale of LOCALE_CODES) {
      if (locale === 'en-US') continue;
      const candidate = flat.get(locale);
      for (const key of candidate.keys()) {
        if (reference.has(key)) continue;
        // Arabic legitimately carries the extra plural categories.
        const extraPlural = /_(zero|two|few|many)$/.test(key);
        const baseExists = reference.has(key.replace(/_(zero|two|few|many|one|other)$/, ''));
        if (!(extraPlural && baseExists)) problems.push(`${locale} orphan ${key}`);
      }
    }
    assert.deepEqual(problems, []);
  });

  test('interpolation placeholders never introduce an unknown variable', () => {
    const reference = flat.get('en-US');
    const problems = [];
    const vars = (value) => [...String(value).matchAll(/{{\s*([\w.]+)\s*}}/g)].map((m) => m[1]).sort();

    for (const locale of LOCALE_CODES) {
      for (const [key, value] of flat.get(locale)) {
        // A locale may define a plural category the reference does not (Arabic
        // has six); compare those against the plural base key.
        const baseKey = key.replace(/_(zero|one|two|few|many|other)$/, '');
        const expected = vars(reference.get(key) ?? reference.get(baseKey) ?? '');
        const actual = vars(value);
        const unknown = actual.filter((name) => !expected.includes(name));
        if (unknown.length) problems.push(`${locale} ${key} introduces [${unknown}]`);
      }
    }
    assert.deepEqual(problems, []);
  });

  test('every plural key set includes the plain fallback key', () => {
    const problems = [];
    for (const locale of LOCALE_CODES) {
      for (const [key] of flat.get(locale)) {
        if (!/_other$/.test(key)) continue;
        const base = key.replace(/_other$/, '');
        if (!flat.get(locale).has(base)) problems.push(`${locale} missing plain fallback ${base}`);
      }
    }
    assert.deepEqual(problems, []);
  });
});

describe('command builders stay in sync with the reference locale', () => {
  test('every command and subcommand description matches en-US/commands.json', async () => {
    const { commands } = await loadCommands(join(ROOT_DIR, 'src', 'bot', 'commands'));
    const reference = bundles.get('en-US').commands;
    const problems = [];

    const walk = (options, refOptions, rootOptions, path) => {
      for (const option of options ?? []) {
        // Mirrors the loader's lookup: a nested entry wins, otherwise the option
        // is shared and declared once at `<command>.options.<name>`.
        const ref = refOptions?.[option.name] ?? rootOptions?.[option.name];
        if (!ref) {
          problems.push(`${path}${option.name}: no en-US entry`);
          continue;
        }
        if (option.description !== undefined && option.description !== ref.description) {
          problems.push(`${path}${option.name}: builder "${option.description}" != locale "${ref.description}"`);
        }
        walk(option.options, ref.options, rootOptions, `${path}${option.name}.options.`);
      }
    };

    for (const command of commands.values()) {
      const json = command.data.toJSON();
      const ref = reference[command.i18nKey];
      if (!ref) {
        problems.push(`${command.name}: no en-US entry`);
        continue;
      }
      if (json.description !== ref.description) {
        problems.push(`${command.name}: builder "${json.description}" != locale "${ref.description}"`);
      }
      walk(json.options, ref.options, ref.options, `${command.name}.options.`);
    }

    assert.deepEqual(problems, []);
  });
});
