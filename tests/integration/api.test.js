import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../../src/api/server.js';
import { HealthService, HEALTH_STATUS } from '../../src/services/healthService.js';
import { loadConfig } from '../../src/config/index.js';
import { initI18n } from '../../src/services/i18nService.js';
import { LOCALE_CODES, DEFAULT_LOCALE } from '../../src/config/locales.js';
import { metrics } from '../../src/services/metrics.js';

let server;
let baseUrl;
let health;

before(async () => {
  await initI18n({ locales: LOCALE_CODES, defaultLocale: DEFAULT_LOCALE });
  const config = loadConfig({ NODE_ENV: 'test' });
  health = new HealthService({ defaultTimeoutMs: 1000 });
  health.register('process', () => ({ status: HEALTH_STATUS.OK, pid: process.pid }));
  health.register('database', () => ({ status: HEALTH_STATUS.DEGRADED, reason: 'not configured in tests' }));

  const app = createApp({ config, client: null, health });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.closeAllConnections?.();
  server?.close();
});

describe('API — health endpoints', () => {
  test('GET /health reports the aggregated status', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200, 'no critical check fails, so this must be 200');
    const body = await res.json();
    assert.equal(body.status, HEALTH_STATUS.DEGRADED, 'a non-critical degraded check degrades the report');
    assert.equal(body.ready, true);
    assert.equal(body.checks.process.status, 'ok');
    assert.equal(body.checks.database.status, 'degraded');
    assert.ok(body.uptimeMs >= 0);
    assert.ok(body.version);
  });

  test('GET /health/live always answers while the process is up', async () => {
    const res = await fetch(`${baseUrl}/health/live`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'alive');
    assert.equal(body.pid, process.pid);
  });

  test('GET /health/ready returns 503 when a critical check fails', async () => {
    const failing = new HealthService({ defaultTimeoutMs: 500 });
    failing.register('critical', () => { throw new Error('down'); }, { critical: true });
    const app = createApp({ config: loadConfig({ NODE_ENV: 'test' }), client: null, health: failing });
    const failingServer = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => failingServer.once('listening', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${failingServer.address().port}/health/ready`);
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.ready, false);
      assert.equal(body.checks.critical, 'error');
    } finally {
      failingServer.closeAllConnections?.();
      failingServer.close();
    }
  });

  test('a hanging check is timed out instead of hanging the endpoint', async () => {
    const slow = new HealthService({ defaultTimeoutMs: 100 });
    slow.register('hang', () => new Promise(() => {}));
    const report = await slow.run();
    assert.equal(report.checks.hang.status, 'error');
    assert.match(report.checks.hang.error, /timed out/);
  });
});

describe('API — status endpoints', () => {
  test('GET /api/v1/status exposes only non-sensitive data', async () => {
    const res = await fetch(`${baseUrl}/api/v1/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.bot.name, 'xXx Family');
    assert.equal(body.i18n.localeCount, 10);
    assert.equal(body.bot.online, false, 'no gateway in tests');

    const raw = JSON.stringify(body);
    for (const secret of ['DISCORD_TOKEN', 'clientSecret', 'sessionSecret']) {
      assert.ok(!raw.includes(secret), `response must not leak ${secret}`);
    }
  });

  test('GET /api/v1/locales describes every shipped locale', async () => {
    const res = await fetch(`${baseUrl}/api/v1/locales`);
    const body = await res.json();
    assert.equal(body.locales.length, 10);
    const indonesian = body.locales.find((locale) => locale.code === 'id-ID');
    assert.equal(indonesian.nativeName, 'Bahasa Indonesia');
    assert.equal(indonesian.discordCode, 'id');
    assert.equal(indonesian.loaded, true);
    const arabic = body.locales.find((locale) => locale.code === 'ar');
    assert.equal(arabic.rtl, true);
    assert.equal(arabic.discordCode, null, 'Arabic has no Discord command locale');
  });

  test('GET /api/v1/commands lists the registered commands', async () => {
    const res = await fetch(`${baseUrl}/api/v1/commands`);
    const body = await res.json();
    assert.equal(body.count, 0, 'no client is attached in this test');
    assert.deepEqual(body.commands, []);
  });

  test('GET /metrics returns counters and memory', async () => {
    metrics.increment('testCounter');
    const res = await fetch(`${baseUrl}/metrics`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.counters.testCounter, 1);
    assert.ok(body.memory.rssMb > 0);
  });
});

describe('API — security', () => {
  test('sets hardened headers and hides the server fingerprint', async () => {
    const res = await fetch(`${baseUrl}/health/live`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  test('only echoes an allow-listed CORS origin', async () => {
    const allowed = await fetch(`${baseUrl}/health/live`, { headers: { origin: 'http://localhost:3000' } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:3000');

    const denied = await fetch(`${baseUrl}/health/live`, { headers: { origin: 'https://evil.example' } });
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  });

  test('answers OPTIONS preflight without hitting a route', async () => {
    const res = await fetch(`${baseUrl}/health/live`, { method: 'OPTIONS', headers: { origin: 'http://localhost:3000' } });
    assert.equal(res.status, 204);
  });

  test('unknown routes return a structured 404, never a stack trace', async () => {
    const res = await fetch(`${baseUrl}/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, 'ERR_NOT_FOUND');
    assert.ok(!JSON.stringify(body).includes('at '));
  });

  test('rejects an oversized JSON body', async () => {
    const res = await fetch(`${baseUrl}/api/v1/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blob: 'x'.repeat(400_000) }),
    });
    assert.ok(res.status === 413 || res.status === 400, `expected a payload rejection, got ${res.status}`);
  });

  test('rate limits a burst of API calls and sends Retry-After', async () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    const { rateLimitMiddleware } = await import('../../src/middleware/rateLimiter.js');
    const express = (await import('express')).default;
    const app = express();
    app.set('trust proxy', 1);
    app.use(rateLimitMiddleware({ capacity: 3, refillMs: 60_000 }));
    app.get('/limited', (req, res) => res.json({ ok: true }));
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

    const limited = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => limited.once('listening', resolve));
    try {
      const url = `http://127.0.0.1:${limited.address().port}/limited`;
      const statuses = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await fetch(url)).status);
      assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
      assert.equal(statuses[3], 429);

      const blocked = await fetch(url);
      assert.equal(blocked.headers.get('retry-after') !== null, true);
    } finally {
      limited.closeAllConnections?.();
      limited.close();
    }
    assert.ok(config);
  });
});
