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
