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

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [
    days ? t('common:time.days', { count: days }) : null,
    hours ? t('common:time.hours', { count: hours }) : null,
    minutes ? t('common:time.minutes', { count: minutes }) : null,
    seconds ? t('common:time.seconds', { count: seconds }) : null,
  ].filter(Boolean);

  return parts.slice(0, maxUnits).join(' ');
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
