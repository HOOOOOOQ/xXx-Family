import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  AppError,
  ValidationError,
  PermissionDeniedError,
  RateLimitError,
  DatabaseError,
  ConfigError,
  isAppError,
  normalizeError,
  hasUnresolvedPlaceholders,
  resolveUserMessage,
} from '../../src/utils/errors.js';

describe('error hierarchy', () => {
  test('AppError carries code, status, i18n key and expose flag', () => {
    const err = new AppError('boom', { code: 'ERR_TEST', statusCode: 418, i18nKey: 'errors:generic' });
    assert.ok(err instanceof Error);
    assert.equal(err.code, 'ERR_TEST');
    assert.equal(err.statusCode, 418);
    assert.equal(err.i18nKey, 'errors:generic');
    assert.equal(err.name, 'AppError');
    assert.equal(isAppError(err), true);
  });

  test('client errors are exposed, server errors are not', () => {
    assert.equal(new ValidationError('bad input').expose, true);
    assert.equal(new PermissionDeniedError('nope').expose, true);
    assert.equal(new DatabaseError('db down').expose, false);
    assert.equal(new ConfigError('no token').expose, false);
  });

  test('toJSON never leaks a message for server errors', () => {
    const json = new DatabaseError('mongo says: user xxx password yyy').toJSON();
    assert.equal(json.error.message, 'Internal server error');
    assert.equal(json.error.code, 'ERR_DATABASE');
    assert.ok(!JSON.stringify(json).includes('password'));
  });

  test('RateLimitError keeps the retry hint', () => {
    const err = new RateLimitError('slow down', { retryAfterMs: 4200 });
    assert.equal(err.statusCode, 429);
    assert.equal(err.retryAfterMs, 4200);
    assert.equal(err.i18nKey, 'errors:rateLimited');
  });

  test('normalizeError classifies AppErrors', () => {
    const normalized = normalizeError(new PermissionDeniedError('missing', { details: { permissions: 'BanMembers' } }));
    assert.equal(normalized.statusCode, 403);
    assert.equal(normalized.code, 'ERR_PERMISSION');
    assert.equal(normalized.i18nKey, 'errors:missingPermissions');
  });

  test('normalizeError classifies Discord REST errors', () => {
    const discordError = Object.assign(new Error('Missing Access'), { status: 403, code: 50001 });
    const normalized = normalizeError(discordError);
    assert.equal(normalized.statusCode, 403);
    assert.equal(normalized.code, 'ERR_DISCORD_50001');
    assert.equal(normalized.expose, false);
  });

  test('normalizeError never crashes on primitives', () => {
    assert.equal(normalizeError('plain string').code, 'ERR_INTERNAL');
    assert.equal(normalizeError(null).statusCode, 500);
    assert.equal(normalizeError(undefined).code, 'ERR_INTERNAL');
    assert.equal(isAppError(null), false);
    assert.equal(isAppError({ isAppError: false }), false);
  });

  test('cause is preserved for debugging', () => {
    const root = new Error('root cause');
    const wrapped = new DatabaseError('wrapped', { cause: root });
    assert.equal(wrapped.cause, root);
  });
});

/**
 * Regression coverage for a real defect: when a caller passed `details` that
 * did not contain the placeholder an `errors:*` template needs, the raw
 * `{{reason}}` string was sent straight to the member.
 */
describe('resolveUserMessage', () => {
  /** Minimal `t` that mimics i18next: leaves `{{x}}` in place when no value. */
  const t = (key, values = {}) => {
    const table = {
      'errors:validation': 'That input is not valid: {{reason}}',
      'errors:missingPermissions': 'You are missing the required permissions: {{permissions}}',
      'errors:generic': 'Something went wrong while handling that. The error has been logged.',
    };
    let out = table[key] ?? key;
    for (const [name, value] of Object.entries(values)) {
      out = out.replaceAll(`{{${name}}}`, String(value));
    }
    return out;
  };

  test('detects unresolved i18next placeholders', () => {
    assert.equal(hasUnresolvedPlaceholders('That input is not valid: {{reason}}'), true);
    assert.equal(hasUnresolvedPlaceholders('That input is not valid: bad role'), false);
    assert.equal(hasUnresolvedPlaceholders(null), false);
    assert.equal(hasUnresolvedPlaceholders('a {single} brace is fine'), false);
  });

  test('uses the localized template when it interpolated completely', () => {
    const err = new ValidationError('bad input', { details: { reason: 'that role is too high' } });
    assert.equal(
      resolveUserMessage(err, { t, i18nKey: 'errors:validation', values: err.details }),
      'That input is not valid: that role is too high',
    );
  });

  test('NEVER leaks a raw placeholder — falls back to the exposed message', () => {
    // This is the exact mistake that shipped: details keyed on `field`, while
    // the template asks for `reason`.
    const err = new ValidationError('Set a channel first with /welcome channel', {
      details: { field: 'channel' },
    });
    const out = resolveUserMessage(err, { t, i18nKey: 'errors:validation', values: err.details });
    assert.ok(!out.includes('{{'), `leaked a placeholder: ${out}`);
    assert.equal(out, 'Set a channel first with /welcome channel');
  });

  test('falls back to errors:generic when nothing usable exists', () => {
    const err = new Error('internal detail nobody should read');
    const out = resolveUserMessage(err, { t, i18nKey: 'errors:validation', values: {} });
    assert.ok(!out.includes('{{'));
    assert.match(out, /Something went wrong/);
    assert.ok(!out.includes('internal detail'), 'an unexposed message must not be shown');
  });

  test('does not expose the message of a 5xx error', () => {
    const err = new DatabaseError('mongodb://user:pass@host exploded');
    const out = resolveUserMessage(err, { t, i18nKey: 'errors:validation', values: {} });
    assert.ok(!out.includes('mongodb://'), 'credentials must never reach a reply');
    assert.match(out, /Something went wrong/);
  });

  test('survives a missing t entirely', () => {
    const err = new ValidationError('plain fallback', { details: { reason: 'x' } });
    assert.equal(resolveUserMessage(err, {}), 'plain fallback');
    assert.equal(resolveUserMessage(new Error('hidden'), {}), 'Something went wrong while handling that.');
  });
});
