import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { redact, redactString, registerSecret, clearSecrets, registeredSecretCount } from '../../src/utils/redact.js';

describe('redaction', () => {
  beforeEach(() => clearSecrets());

  test('redacts credential-like keys at any depth', () => {
    const out = redact({
      user: { name: 'ada' },
      discord: { token: 'super-secret-token', clientId: 'public' },
      database: { uri: 'mongodb://x', password: 'hunter2' },
      headers: { Authorization: 'Bearer abc', 'X-Trace': 'keep-me' },
    });

    assert.equal(out.discord.token, '[REDACTED]');
    assert.equal(out.discord.clientId, 'public');
    assert.equal(out.database.password, '[REDACTED]');
    assert.equal(out.database.uri, 'mongodb://x', 'a key named "uri" is not a credential by itself');
    assert.equal(out.headers.Authorization, '[REDACTED]');
    assert.equal(out.headers['X-Trace'], 'keep-me');
  });

  test('does not redact innocent keys that merely contain "auth"', () => {
    const out = redact({ author: 'ada', authorId: '42', authenticated: true });
    assert.equal(out.author, 'ada');
    assert.equal(out.authorId, '42');
    assert.equal(out.authenticated, true);
  });

  test('masks registered secret values inside arbitrary strings', () => {
    registerSecret('MTAxMjM0NTY3ODkw.secret.token');
    const out = redact({ message: 'login failed with token MTAxMjM0NTY3ODkw.secret.token for user 1' });
    assert.ok(!out.message.includes('MTAxMjM0NTY3ODkw.secret.token'));
    assert.ok(out.message.includes('[REDACTED]'));
  });

  test('masks credentials embedded in connection strings', () => {
    const out = redactString('connecting to mongodb+srv://bot:hunter2secret@cluster0.example.net/db');
    assert.ok(!out.includes('hunter2secret'), out);
    assert.ok(out.includes('mongodb+srv://bot:[REDACTED]@cluster0.example.net/db'));
  });

  test('ignores secrets that are too short to be meaningful', () => {
    registerSecret('abc');
    assert.equal(registeredSecretCount(), 0);
  });

  test('handles arrays, maps, sets, cycles and errors without throwing', () => {
    const cyclic = { name: 'root' };
    cyclic.self = cyclic;

    const out = redact({
      list: [1, 'two', { token: 'x' }],
      map: new Map([['apiKey', 'secret-value'], ['plain', 1]]),
      set: new Set(['a', 'b']),
      err: new Error('boom'),
      cyclic,
      fn: () => {},
    });

    assert.equal(out.list[2].token, '[REDACTED]');
    assert.equal(out.map.apiKey, '[REDACTED]');
    assert.equal(out.map.plain, 1);
    assert.deepEqual(out.set, ['a', 'b']);
    assert.equal(out.err.name, 'Error');
    assert.equal(out.cyclic.self, '[Circular]');
    assert.equal(out.fn, '[Function]');
  });

  test('truncates very deep structures instead of recursing forever', () => {
    let node = { value: 'leaf' };
    for (let i = 0; i < 20; i += 1) node = { next: node };
    const out = redact(node, { maxDepth: 4 });
    assert.ok(JSON.stringify(out).includes('Truncated'));
  });

  test('truncates long arrays', () => {
    const out = redact(Array.from({ length: 100 }, (_, i) => i), { maxArrayLength: 10 });
    assert.equal(out.length, 11);
    assert.match(out[10], /\+90 more/);
  });

  test('never mutates the input', () => {
    const input = { token: 'secret-value' };
    redact(input);
    assert.equal(input.token, 'secret-value');
  });
});
