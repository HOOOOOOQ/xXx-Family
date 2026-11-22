import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CacheManager } from '../../src/services/cacheManager.js';

describe('CacheManager', () => {
  test('stores and retrieves values', () => {
    const cache = new CacheManager({ autoSweep: false });
    cache.set('a', 1);
    assert.equal(cache.get('a'), 1);
    assert.equal(cache.has('a'), true);
    assert.equal(cache.get('missing'), undefined);
  });

  test('expires entries after the TTL', async () => {
    const cache = new CacheManager({ autoSweep: false });
    cache.set('short', 'value', 20);
    assert.equal(cache.get('short'), 'value');
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(cache.get('short'), undefined);
  });

  test('treats ttl 0 as "never expires"', async () => {
    const cache = new CacheManager({ autoSweep: false });
    cache.set('forever', 'value', 0);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(cache.get('forever'), 'value');
    assert.equal(cache.sweep(), 0);
  });

  test('evicts the least recently used entry beyond maxEntries', () => {
    const cache = new CacheManager({ maxEntries: 3, autoSweep: false });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.get('a'); // refresh "a" so "b" becomes the oldest
    cache.set('d', 4);
    assert.equal(cache.has('b'), false);
    assert.equal(cache.has('a'), true);
    assert.equal(cache.stats().evictions, 1);
  });

  test('deleteByPrefix only removes matching keys', () => {
    const cache = new CacheManager({ autoSweep: false });
    cache.set('guild:1', 'x');
    cache.set('guild:2', 'y');
    cache.set('user:1', 'z');
    assert.equal(cache.deleteByPrefix('guild:'), 2);
    assert.equal(cache.has('user:1'), true);
  });

  test('tracks hit rate', () => {
    const cache = new CacheManager({ autoSweep: false });
    cache.set('a', 1);
    cache.get('a');
    cache.get('a');
    cache.get('nope');
    const stats = cache.stats();
    assert.equal(stats.hits, 2);
    assert.equal(stats.misses, 1);
    assert.equal(stats.hitRate, 66.7);
  });

  test('wrap() reads through to the factory only once per key', async () => {
    const cache = new CacheManager({ autoSweep: false });
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return { from: 'db' };
    };

    const first = await cache.wrap('k', factory);
    const second = await cache.wrap('k', factory);
    assert.equal(first.from, 'db');
    assert.equal(second.from, 'db');
    assert.equal(calls, 1, 'the second read must be served from cache');
  });

  test('wrap() de-duplicates concurrent in-flight loads', async () => {
    const cache = new CacheManager({ autoSweep: false });
    let calls = 0;
    const factory = () =>
      new Promise((resolve) => {
        calls += 1;
        setTimeout(() => resolve({ calls }), 10);
      });

    const [a, b, c] = await Promise.all([cache.wrap('k', factory), cache.wrap('k', factory), cache.wrap('k', factory)]);
    assert.equal(calls, 1, 'a burst of reads must not stampede the database');
    assert.deepEqual([a, b, c], [{ calls: 1 }, { calls: 1 }, { calls: 1 }]);
  });

  test('wrap() does not cache failures', async () => {
    const cache = new CacheManager({ autoSweep: false });
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error('nope');
    };
    await assert.rejects(() => cache.wrap('k', failing));
    await assert.rejects(() => cache.wrap('k', failing));
    assert.equal(calls, 2);
    assert.equal(cache.get('k'), undefined);
  });

  test('sweep removes only expired entries', () => {
    const cache = new CacheManager({ autoSweep: false });
    cache.set('gone', 1, 1);
    cache.set('stays', 2, 60_000);
    return new Promise((resolve) => {
      setTimeout(() => {
        assert.equal(cache.sweep(), 1);
        assert.equal(cache.has('stays'), true);
        resolve();
      }, 10);
    });
  });
});
