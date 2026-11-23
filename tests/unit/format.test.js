import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatDuration,
  formatNumber,
  formatBytes,
  discordTimestamp,
  truncate,
  applyDirection,
  chunkText,
  escapeMarkdown,
} from '../../src/utils/format.js';
import { brandEmbed, errorEmbed } from '../../src/utils/embeds.js';
import { getT, initI18n } from '../../src/services/i18nService.js';
import { LOCALE_CODES, DEFAULT_LOCALE } from '../../src/config/locales.js';
import { COLORS } from '../../src/config/constants.js';

before(async () => {
  await initI18n({ locales: LOCALE_CODES, defaultLocale: DEFAULT_LOCALE });
});

describe('formatDuration', () => {
  const tEn = () => getT('en-US');
  const tId = () => getT('id-ID');

  test('formats a multi unit duration using translation keys', () => {
    assert.equal(formatDuration((2 * 86400 + 3 * 3600 + 4 * 60) * 1000, tEn()), '2d 3h 4m');
  });

  test('long spans use months and years, not hundreds of days', () => {
    // A 3-month boost used to read as "90d"; a 2-year account as "730d".
    assert.equal(formatDuration(90 * 86400_000, tEn()), '3mo');
    assert.equal(formatDuration(730 * 86400_000, tEn()), '2y');
    assert.equal(formatDuration((2 * 365 + 3 * 30) * 86400_000, tEn()), '2y 3mo');
  });

  test('short spans are unaffected by the larger units', () => {
    assert.equal(formatDuration(86400_000, tEn()), '1d');
    assert.equal(formatDuration(29 * 86400_000, tEn()), '29d');
  });

  test('months and years are localized', () => {
    assert.equal(formatDuration(90 * 86400_000, tId()), '3bln');
    // 395 days = exactly 1 year + 1 month (id-ID abbreviates "hari" as "h",
    // which is why a leftover day count would read as a suffix h here).
    assert.equal(formatDuration(395 * 86400_000, tId()), '1th 1bln');
  });

  test('every locale can render the larger units', () => {
    for (const locale of LOCALE_CODES) {
      const out = formatDuration((2 * 365 + 3 * 30) * 86400_000, getT(locale));
      assert.ok(out.length > 0, `${locale} produced nothing`);
      assert.ok(!out.includes('{{'), `${locale} leaked a placeholder: ${out}`);
      assert.ok(!out.includes('common:time'), `${locale} leaked a key: ${out}`);
    }
  });

  test('renders at most three units so embeds stay compact', () => {
    const out = formatDuration((5 * 86400 + 6 * 3600 + 7 * 60 + 8) * 1000, tEn());
    assert.equal(out, '5d 6h 7m');
    assert.equal(out.split(' ').length, 3);
  });

  test('the unit cap is configurable', () => {
    const ms = (5 * 86400 + 6 * 3600 + 7 * 60 + 8) * 1000;
    assert.equal(formatDuration(ms, tEn(), { maxUnits: 1 }), '5d');
    assert.equal(formatDuration(ms, tEn(), { maxUnits: 2 }), '5d 6h');
  });

  test('a sub-minute duration still shows seconds', () => {
    assert.equal(formatDuration(45_000, tEn()), '45s');
  });

  test('uses the localized unit words', () => {
    const ms = 90 * 60 * 1000;
    assert.equal(formatDuration(ms, tEn()), '1h 30m');
    assert.equal(formatDuration(ms, tId()), '1j 30m');
  });

  test('handles zero and invalid input', () => {
    assert.equal(formatDuration(0, tEn()), 'just now');
    assert.equal(formatDuration(-5, tEn()), 'Unknown');
    assert.equal(formatDuration(Number.NaN, tEn()), 'Unknown');
  });
});

describe('locale aware primitives', () => {
  test('formats numbers per locale', () => {
    assert.equal(formatNumber(1234567, 'en-US'), '1,234,567');
    assert.equal(formatNumber(1234567, 'de-DE'), '1.234.567');
    assert.equal(formatNumber(1234567, 'id-ID'), '1.234.567');
  });

  test('falls back for an unknown locale instead of throwing', () => {
    assert.equal(formatNumber(5, 'not-a-locale'), '5');
  });

  test('formats byte sizes', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  });

  test('produces a Discord relative timestamp', () => {
    const ts = discordTimestamp(new Date('2026-01-01T00:00:00Z'));
    assert.match(ts, /^<t:1767225600:R>$/);
  });
});

describe('text safety helpers', () => {
  test('truncate adds an ellipsis only when needed', () => {
    assert.equal(truncate('short', 10), 'short');
    assert.equal(truncate('abcdefghij', 5), 'abcd…');
  });

  test('applyDirection prefixes RTL text once', () => {
    const text = 'مرحبا';
    const once = applyDirection(text, 'rtl');
    assert.equal(once.startsWith('\u200F'), true);
    assert.equal(applyDirection(once, 'rtl'), once, 'must not double prefix');
    assert.equal(applyDirection(text, 'ltr'), text);
  });

  test('chunkText respects the 2000 character payload limit', () => {
    const chunks = chunkText('a'.repeat(4500), 2000);
    assert.equal(chunks.length, 3);
    for (const chunk of chunks) assert.ok(chunk.length <= 2000);
  });

  test('chunkText prefers line boundaries', () => {
    const text = `${'x'.repeat(1900)}\n${'y'.repeat(500)}`;
    const chunks = chunkText(text, 2000);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].endsWith('x'.repeat(100)), true);
  });

  test('escapeMarkdown neutralises formatting and mentions', () => {
    assert.equal(escapeMarkdown('**bold**'), '\\*\\*bold\\*\\*');
    assert.equal(escapeMarkdown('@everyone'), '\\@everyone');
  });
});

describe('embed builders', () => {
  test('applies the cyberpunk palette and a localized footer', () => {
    const embed = brandEmbed({ t: getT('id-ID'), title: 'Judul', description: 'Isi' });
    const json = embed.toJSON();
    assert.equal(json.color, COLORS.neon);
    assert.equal(json.title, 'Judul');
    assert.equal(json.footer.text, 'Ditenagai oleh xXx Family');
  });

  test('truncates oversized fields instead of failing the Discord API call', () => {
    const embed = brandEmbed({ t: getT('en-US'), title: 'x'.repeat(500), description: 'y'.repeat(5000) });
    const json = embed.toJSON();
    assert.ok(json.title.length <= 256);
    assert.ok(json.description.length <= 4096);
  });

  test('caps the field count at the Discord limit of 25', () => {
    const fields = Array.from({ length: 40 }, (_, i) => ({ name: `f${i}`, value: 'v' }));
    const json = brandEmbed({ t: getT('en-US'), fields }).toJSON();
    assert.equal(json.fields.length, 25);
  });

  test('errorEmbed uses the danger colour', () => {
    const json = errorEmbed({ t: getT('en-US'), description: 'nope' }).toJSON();
    assert.equal(json.color, COLORS.danger);
  });

  test('renders RTL descriptions with a direction mark', () => {
    const json = brandEmbed({ t: getT('ar'), description: 'مرحبا', dir: 'rtl' }).toJSON();
    assert.equal(json.description.startsWith('\u200F'), true);
  });
});
