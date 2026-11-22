import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RateLimiter, TokenBucket } from '../../src/middleware/rateLimiter.js';
import { CooldownManager, enforceCommandGuards } from '../../src/middleware/cooldownManager.js';
import { PermissionFlagsBits } from 'discord.js';
import { createFakeInteraction, FakePermissions } from '../helpers/fakeInteraction.js';

describe('TokenBucket', () => {
  test('allows a burst up to capacity then blocks', () => {
    const bucket = new TokenBucket({ capacity: 3, refillMs: 1000 });
    assert.equal(bucket.take().allowed, true);
    assert.equal(bucket.take().allowed, true);
    assert.equal(bucket.take().allowed, true);
    const blocked = bucket.take();
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 1000, `retryAfter=${blocked.retryAfterMs}`);
  });

  test('refills continuously over time', async () => {
    const bucket = new TokenBucket({ capacity: 2, refillMs: 100 });
    bucket.take(2);
    assert.equal(bucket.take().allowed, false);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(bucket.take().allowed, true);
  });

  test('never exceeds capacity while refilling', async () => {
    const bucket = new TokenBucket({ capacity: 2, refillMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(bucket.peek().tokens, 2);
  });
});

describe('RateLimiter', () => {
  test('keeps independent buckets per key', () => {
    const limiter = new RateLimiter({ capacity: 1, refillMs: 60_000 });
    assert.equal(limiter.consume('user-a').allowed, true);
    assert.equal(limiter.consume('user-a').allowed, false);
    assert.equal(limiter.consume('user-b').allowed, true);
  });

  test('reports limit, remaining and retryAfter', () => {
    const limiter = new RateLimiter({ capacity: 2, refillMs: 1000 });
    const first = limiter.consume('k');
    assert.equal(first.limit, 2);
    assert.equal(first.remaining, 1);
    limiter.consume('k');
    const third = limiter.consume('k');
    assert.equal(third.allowed, false);
    assert.equal(third.remaining, 0);
  });

  test('evicts the least recently used keys beyond maxKeys', () => {
    const limiter = new RateLimiter({ capacity: 1, refillMs: 1000, maxKeys: 2 });
    limiter.consume('a');
    limiter.consume('b');
    limiter.consume('c');
    assert.equal(limiter.stats().keys, 2);
  });

  test('reset() clears a single key', () => {
    const limiter = new RateLimiter({ capacity: 1, refillMs: 60_000 });
    limiter.consume('k');
    assert.equal(limiter.consume('k').allowed, false);
    limiter.reset('k');
    assert.equal(limiter.consume('k').allowed, true);
  });
});

describe('CooldownManager', () => {
  test('is per user AND per command', () => {
    const cooldowns = new CooldownManager();
    assert.equal(cooldowns.consume('u1', 'ping', 5000).allowed, true);
    assert.equal(cooldowns.consume('u1', 'ping', 5000).allowed, false);
    assert.equal(cooldowns.consume('u1', 'help', 5000).allowed, true);
    assert.equal(cooldowns.consume('u2', 'ping', 5000).allowed, true);
  });

  test('a zero cooldown never blocks', () => {
    const cooldowns = new CooldownManager();
    for (let i = 0; i < 50; i += 1) assert.equal(cooldowns.consume('u', 'ping', 0).allowed, true);
  });

  test('refund gives the use back when a command aborts early', () => {
    const cooldowns = new CooldownManager();
    cooldowns.consume('u', 'ping', 5000);
    assert.equal(cooldowns.consume('u', 'ping', 5000).allowed, false);
    assert.equal(cooldowns.refund('u', 'ping', 5000), true);
    assert.equal(cooldowns.consume('u', 'ping', 5000).allowed, true);
  });

  test('reset(userId) clears every command for that user', () => {
    const cooldowns = new CooldownManager();
    cooldowns.consume('u', 'ping', 5000);
    cooldowns.consume('u', 'help', 5000);
    assert.equal(cooldowns.reset('u'), true);
    assert.equal(cooldowns.consume('u', 'ping', 5000).allowed, true);
  });
});

describe('enforceCommandGuards', () => {
  const command = { name: 'ping', cooldown: 0, guildOnly: false, dmOnly: false, nsfwOnly: false, ownerOnly: false };

  test('lets a plain guild command through', () => {
    const interaction = createFakeInteraction({ commandName: 'ping' });
    assert.doesNotThrow(() => enforceCommandGuards(interaction, command, { cooldowns: new CooldownManager() }));
  });

  test('blocks a guild-only command in DMs', () => {
    const interaction = createFakeInteraction({ guildId: null, commandName: 'ping' });
    assert.throws(
      () => enforceCommandGuards(interaction, { ...command, guildOnly: true }, { cooldowns: new CooldownManager() }),
      (err) => err.i18nKey === 'errors:guildOnly',
    );
  });

  test('blocks an owner-only command for a normal member', () => {
    const interaction = createFakeInteraction({ commandName: 'ping' });
    assert.throws(
      () => enforceCommandGuards(interaction, { ...command, ownerOnly: true }, { cooldowns: new CooldownManager(), ownerIds: ['999'] }),
      (err) => err.i18nKey === 'errors:ownerOnly',
    );
  });

  test('allows an owner-only command for a configured owner', () => {
    const interaction = createFakeInteraction({ commandName: 'ping', userId: '999' });
    assert.doesNotThrow(() =>
      enforceCommandGuards(interaction, { ...command, ownerOnly: true }, { cooldowns: new CooldownManager(), ownerIds: ['999'] }),
    );
  });

  test('blocks a member missing the required permission', () => {
    const interaction = createFakeInteraction({
      commandName: 'ping',
      permissions: [PermissionFlagsBits.SendMessages],
    });
    assert.throws(
      () =>
        enforceCommandGuards(
          interaction,
          { ...command, userPermissions: ['ManageGuild'] },
          { cooldowns: new CooldownManager() },
        ),
      (err) => err.i18nKey === 'errors:missingPermissions' && err.details.permissions === 'ManageGuild',
    );
  });

  test('an Administrator bypasses per-command permission requirements', () => {
    const interaction = createFakeInteraction({
      commandName: 'ping',
      permissions: [PermissionFlagsBits.Administrator],
    });
    assert.doesNotThrow(() =>
      enforceCommandGuards(interaction, { ...command, userPermissions: ['ManageGuild'] }, { cooldowns: new CooldownManager() }),
    );
  });

  test('blocks when the BOT lacks the permission it needs', () => {
    const interaction = createFakeInteraction({ commandName: 'ping' });
    interaction.guild.members.me.permissions = new FakePermissions([PermissionFlagsBits.SendMessages]);
    assert.throws(
      () => enforceCommandGuards(interaction, { ...command, botPermissions: ['BanMembers'] }, { cooldowns: new CooldownManager() }),
      (err) => err.i18nKey === 'errors:missingPermissionsBot',
    );
  });

  test('enforces the cooldown and reports the wait in whole seconds', () => {
    const interaction = createFakeInteraction({ commandName: 'ping' });
    const cooldowns = new CooldownManager();
    const guarded = { ...command, cooldown: 10_000 };
    enforceCommandGuards(interaction, guarded, { cooldowns });
    assert.throws(
      () => enforceCommandGuards(interaction, guarded, { cooldowns }),
      (err) => err.i18nKey === 'errors:cooldown' && err.details.seconds === 10,
    );
  });
});
