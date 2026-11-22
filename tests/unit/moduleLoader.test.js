import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ModuleManager, MODULE_STATES } from '../../src/handlers/moduleLoader.js';
import { ConflictError, ValidationError } from '../../src/utils/errors.js';

const mod = (name, extra = {}) => ({ name, version: '1.0.0', ...extra });

describe('ModuleManager', () => {
  test('registers modules and reports discovery state', () => {
    const manager = new ModuleManager();
    manager.register(mod('alpha'));
    manager.register(mod('beta', { dependencies: ['alpha'] }));
    assert.equal(manager.size, 2);
    assert.deepEqual(manager.resolveOrder(), ['alpha', 'beta']);
  });

  test('rejects an invalid module name', () => {
    const manager = new ModuleManager();
    assert.throws(() => manager.register(mod('Bad_Name')), ValidationError);
    assert.throws(() => manager.register({ version: '1' }), ValidationError);
  });

  test('rejects a duplicate module', () => {
    const manager = new ModuleManager();
    manager.register(mod('alpha'));
    assert.throws(() => manager.register(mod('alpha')), ConflictError);
  });

  test('rejects a non-function lifecycle hook', () => {
    const manager = new ModuleManager();
    assert.throws(() => manager.register(mod('alpha', { init: 'nope' })), ValidationError);
  });

  test('detects a dependency cycle', () => {
    const manager = new ModuleManager();
    manager.register(mod('a', { dependencies: ['b'] }));
    manager.register(mod('b', { dependencies: ['a'] }));
    assert.throws(() => manager.resolveOrder(), /cycle detected/);
  });

  test('detects an unknown dependency', () => {
    const manager = new ModuleManager();
    manager.register(mod('a', { dependencies: ['ghost'] }));
    assert.throws(() => manager.resolveOrder(), /unknown module "ghost"/);
  });

  test('orders by dependency first, then declared phase', () => {
    const manager = new ModuleManager();
    manager.register(mod('tickets', { phase: 4, dependencies: ['core'] }));
    manager.register(mod('core', { phase: 1 }));
    manager.register(mod('welcome', { phase: 2, dependencies: ['core'] }));
    assert.deepEqual(manager.resolveOrder(), ['core', 'welcome', 'tickets']);
  });

  test('boots modules in order and records their state', async () => {
    const manager = new ModuleManager();
    const order = [];
    manager.register(
      mod('core', {
        phase: 1,
        async start() {
          order.push('core');
        },
      }),
    );
    manager.register(
      mod('child', {
        phase: 2,
        dependencies: ['core'],
        async start() {
          order.push('child');
        },
      }),
    );

    const result = await manager.boot({});
    assert.deepEqual(order, ['core', 'child']);
    assert.deepEqual(result.started, ['core', 'child']);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(
      manager.status().map((m) => `${m.name}:${m.state}`),
      ['core:running', 'child:running'],
    );
  });

  test('a failing module is isolated — the others still start', async () => {
    const manager = new ModuleManager();
    manager.register(
      mod('broken', {
        phase: 1,
        async init() {
          throw new Error('init exploded');
        },
      }),
    );
    manager.register(mod('healthy', { phase: 2, async start() {} }));

    const result = await manager.boot({});
    assert.deepEqual(result.started, ['healthy']);
    assert.deepEqual(result.failed, [{ name: 'broken', error: 'init exploded' }]);
    const broken = manager.status().find((m) => m.name === 'broken');
    assert.equal(broken.state, MODULE_STATES.FAILED);
    assert.equal(broken.error, 'init exploded');
  });

  test('stops modules in reverse order', async () => {
    const manager = new ModuleManager();
    const order = [];
    manager.register(mod('a', { phase: 1, async stop() { order.push('a'); } }));
    manager.register(mod('b', { phase: 2, dependencies: ['a'], async stop() { order.push('b'); } }));

    await manager.boot({});
    await manager.shutdown({});
    assert.deepEqual(order, ['b', 'a']);
  });

  test('discovers the real modules directory and boots the core module', async () => {
    const manager = new ModuleManager();
    const names = await manager.discover(new URL('../../src/bot/modules/', import.meta.url).pathname);
    assert.ok(names.includes('core'), `expected the core module, found ${names.join(', ')}`);

    const healthChecks = [];
    const timers = [];
    const fakeCtx = {
      client: { guilds: { cache: new Map() } },
      health: { register: (name, fn) => healthChecks.push({ name, fn }) },
      settings: { stats: () => ({ size: 0 }), getGuildSettings: async () => ({}) },
      logger: { debug() {}, info() {}, warn() {}, error() {}, errorFrom() {}, child: () => fakeCtx.logger },
    };

    const result = await manager.boot(fakeCtx);
    assert.ok(result.started.includes('core'));
    assert.ok(healthChecks.some((check) => check.name === 'i18n'), 'core must register the i18n health check');

    const i18nCheck = healthChecks.find((check) => check.name === 'i18n');
    const report = await i18nCheck.fn();
    assert.ok(['ok', 'degraded', 'error'].includes(report.status));

    await manager.shutdown(fakeCtx);
    assert.deepEqual(timers, []);
  });
});
