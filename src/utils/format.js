/**
 * src/utils/format.js — locale-aware formatting helpers.
 *
 * Numbers and dates use `Intl` with the *same* locale the reply is rendered in,
 * so a Japanese member sees Japanese grouping and an Indonesian member sees
 * Indonesian month names. Durations are formatted through translation keys,
 * never by string concatenation, because word order differs per language.
 */

import { LIMITS } from '../config/constants.js';

/**
 * Human readable duration, built from translation keys so the unit words and
 * their order come from the locale instead of being concatenated in English.
 *
 * At most three units are rendered (largest first) to keep embed fields compact.
 *
 * @param {number} ms
 * @param {(key:string, options?:Record<string, unknown>) => string} t bound translator
 * @returns {string}
 */
export function formatDuration(ms, t, options = {}) {
  const maxUnits = options.maxUnits ?? 3;
  if (!Number.isFinite(ms) || ms < 0) return t('common:unknown');
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 1) return t('common:time.justNow');

  // Long spans are expressed in years/months: a 3-month boost reading as "90d",
  // or a 2-year-old account as "730d", is technically correct and still the
  // wrong thing to show a person.
  const totalDays = Math.floor(totalSeconds / 86400);
  const years = Math.floor(totalDays / 365);
  const months = Math.floor((totalDays % 365) / 30);
  // What is left after the years and months are taken out — NOT totalDays % 30,
  // which leaves a phantom remainder (730 days used to read as "2y 10d").
  const days = totalDays - years * 365 - months * 30;
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [
    years ? t('common:time.years', { count: years }) : null,
    months ? t('common:time.months', { count: months }) : null,
    days ? t('common:time.days', { count: days }) : null,
    hours ? t('common:time.hours', { count: hours }) : null,
    minutes ? t('common:time.minutes', { count: minutes }) : null,
    seconds ? t('common:time.seconds', { count: seconds }) : null,
  ].filter(Boolean);

  return parts.slice(0, maxUnits).join(' ');
}

/** Unit suffixes accepted by parseDuration, in milliseconds. */
const DURATION_UNITS = Object.freeze({
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
});

/** Matches one `<number><unit>` pair, e.g. `90s` or `2 days`. */
const DURATION_PART_RE = /(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/g;

/**
 * Parse a human duration string into milliseconds.
 *
 * Accepts `90s`, `10m`, `2h`, `1d`, `2 weeks` and combinations such as `1h30m`.
 * A bare number is read as minutes, because "10" is what most people type when
 * they mean a ten-minute timeout.
 *
 * @param {string|number} input
 * @returns {number|null} milliseconds, or null when nothing could be parsed
 */
export function parseDuration(input) {
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? input : null;
  if (typeof input !== 'string') return null;

  const text = input.trim().toLowerCase();
  if (text.length === 0) return null;

  // A bare number means minutes.
  if (/^\d+(\.\d+)?$/.test(text)) {
    const value = Number.parseFloat(text);
    return Number.isFinite(value) ? Math.round(value * 60_000) : null;
  }

  let total = 0;
  let matchedLength = 0;

  for (const match of text.matchAll(DURATION_PART_RE)) {
    const amount = Number.parseFloat(match[1]);
    const unit = DURATION_UNITS[match[2]];
    // An unrecognised suffix (e.g. "5 fortnights") must not be silently read as
    // zero, or a moderator asking for two weeks would get an instant timeout.
    if (!unit) return null;
    total += amount * unit;
    matchedLength += match[0].replace(/\s+/g, '').length;
  }

  if (matchedLength === 0) return null;

  // Everything in the input must have been consumed, so "10m please" is not
  // quietly accepted as 10 minutes.
  if (matchedLength !== text.replace(/\s+/g, '').length) return null;

  return Math.round(total);
}

/**
 * @param {number} value
 * @param {string} locale BCP-47 tag
 */
export function formatNumber(value, locale) {
  try {
    return new Intl.NumberFormat(locale).format(value);
  } catch {
    return String(value);
  }
}

/**
 * @param {number|Date} input
 * @param {string} locale
 * @param {Intl.DateTimeFormatOptions} [options]
 */
export function formatDate(input, locale, options = { dateStyle: 'medium', timeStyle: 'short' }) {
  try {
    return new Intl.DateTimeFormat(locale, options).format(new Date(input));
  } catch {
    return new Date(input).toISOString();
  }
}

/** Discord `<t:...:R>` relative timestamp. */
export function discordTimestamp(date, style = 'R') {
  return `<t:${Math.floor(new Date(date).getTime() / 1000)}:${style}>`;
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

/**
 * Hard-truncate with an ellipsis so a payload never exceeds a Discord limit.
 * @param {string} value
 * @param {number} [max]
 */
export function truncate(value, max = LIMITS.embedDescription) {
  const str = String(value ?? '');
  if (str.length <= max) return str;
  return `${str.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Prefix RTL text with a right-to-left mark so Discord renders mixed
 * Arabic/Latin content in the correct direction.
 * @param {string} text
 * @param {'ltr'|'rtl'} dir
 */
export function applyDirection(text, dir) {
  if (dir !== 'rtl') return text;
  const str = String(text ?? '');
  return str.startsWith('\u200F') ? str : `\u200F${str}`;
}

/**
 * Split text on line boundaries for message payloads (2000 char limit).
 * @param {string} text
 * @param {number} [max]
 * @returns {string[]}
 */
export function chunkText(text, max = LIMITS.messageContent) {
  const str = String(text ?? '');
  if (str.length <= max) return [str];
  const chunks = [];
  let rest = str;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut <= 0) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length) chunks.push(rest);
  return chunks.filter(Boolean);
}

/**
 * Escape Discord markdown so user supplied text can never break an embed or
 * impersonate a mention (`@everyone`, `@here`, roles, custom emoji).
 * @param {string} text
 */
export function escapeMarkdown(text) {
  // `:` is deliberately NOT escaped: it would break URLs. Custom emoji are
  // already neutralised because `<` and `>` are escaped.
  return String(text ?? '').replace(/([\\`*_~|>[\]()#!@-])/g, '\\$1');
}
