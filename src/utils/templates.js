/**
 * src/utils/templates.js
 * ---------------------------------------------------------------------------
 * Placeholder engine for welcome/goodbye messages, announcements and tags.
 *
 * Templates are **stored per guild** but their *defaults* live in the locale
 * files, so a server that never customises anything still gets a message in its
 * own language.
 *
 *   Hello {user.mention}, welcome to {server.name}!
 *   You are member #{memberCount}.
 *
 * Rules:
 *   - unknown placeholders are left untouched by default, so a typo is visible
 *     to the admin instead of silently deleting text (`strict: true` blanks them)
 *   - values are escaped for the context they land in (Discord markdown) unless
 *     the placeholder is explicitly marked safe (mentions, timestamps)
 *   - rendering is pure and cannot throw on bad input
 */

import { escapeMarkdown, truncate } from './format.js';

/** `{path.to.value}` — dots allow nested lookups. */
export const PLACEHOLDER_RE = /\{([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)*)\}/g;

/**
 * Placeholders that must NOT be markdown-escaped because they are markup
 * themselves (mentions, custom emoji, Discord timestamps).
 */
const SAFE_PATHS = new Set([
  'user.mention',
  'user.avatar',
  'inviter.mention',
  'role.mention',
  'channel.mention',
  'server.icon',
  'user.created',
  'user.joined',
]);

/**
 * Resolve `a.b.c` against a nested object.
 * @param {Record<string, unknown>} values
 * @param {string} path
 * @returns {unknown}
 */
export function resolvePath(values, path) {
  return path.split('.').reduce((node, key) => {
    if (node === null || node === undefined) return undefined;
    if (typeof node === 'object') return node[key];
    return undefined;
  }, values);
}

/**
 * Render a template.
 *
 * @param {string} template
 * @param {Record<string, unknown>} values
 * @param {object} [options]
 * @param {boolean} [options.strict] replace unknown placeholders with ''
 * @param {number} [options.maxLength] truncate the result (Discord limit aware)
 * @param {boolean} [options.escape] escape markdown in substituted values (default true)
 * @returns {string}
 */
export function renderTemplate(template, values = {}, options = {}) {
  const { strict = false, maxLength = null, escape = true } = options;
  if (typeof template !== 'string' || template.length === 0) return '';

  const rendered = template.replace(PLACEHOLDER_RE, (match, path) => {
    const value = resolvePath(values, path);
    if (value === undefined || value === null) return strict ? '' : match;

    const text = typeof value === 'string' ? value : String(value);
    if (!escape || SAFE_PATHS.has(path)) return text;
    return escapeMarkdown(text);
  });

  return maxLength ? truncate(rendered, maxLength) : rendered;
}

/**
 * Every placeholder a template uses — used to validate admin input and to build
 * the "available placeholders" help panel.
 * @param {string} template
 * @returns {string[]} unique paths, in order of first appearance
 */
export function listPlaceholders(template) {
  if (typeof template !== 'string') return [];
  const seen = new Set();
  for (const match of template.matchAll(PLACEHOLDER_RE)) seen.add(match[1]);
  return [...seen];
}

/**
 * Placeholders a template references that no value provides — i.e. the typos.
 * @param {string} template
 * @param {Record<string, unknown>} values
 * @returns {string[]}
 */
export function findUnknownPlaceholders(template, values = {}) {
  return listPlaceholders(template).filter((path) => {
    const value = resolvePath(values, path);
    return value === undefined || value === null;
  });
}

/**
 * The placeholder catalogue shown to administrators. Kept here so the help
 * command, the dashboard and the docs cannot drift apart.
 * @returns {{ path:string, example:string }[]}
 */
export function placeholderCatalogue() {
  return [
    { path: 'user.mention', example: '@Ada' },
    { path: 'user.name', example: 'Ada' },
    { path: 'user.tag', example: 'ada' },
    { path: 'user.id', example: '222222222222222222' },
    { path: 'user.avatar', example: 'https://cdn…/avatar.png' },
    { path: 'user.created', example: '<t:1700000000:R>' },
    { path: 'user.joined', example: '<t:1760000000:R>' },
    { path: 'user.accountAge', example: '2y 3mo' },
    { path: 'server.name', example: 'xXx Family' },
    { path: 'server.id', example: '111111111111111111' },
    { path: 'server.memberCount', example: '1284' },
    { path: 'memberCount', example: '1284' },
    { path: 'inviter.mention', example: '@Bob' },
    { path: 'inviter.invites', example: '12' },
  ];
}

export default renderTemplate;
