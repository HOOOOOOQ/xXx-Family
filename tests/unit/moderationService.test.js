import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';

import {
  ModerationService,
  MAX_TIMEOUT_MS,
  MAX_PURGE,
  MIN_PURGE,
} from '../../src/services/moderationService.js';
import { PermissionDeniedError, ValidationError, ExternalServiceError } from '../../src/utils/errors.js';
import { initI18n } from '../../src/services/i18nService.js';
import { LOCALE_CODES, DEFAULT_LOCALE } from '../../src/config/locales.js';

before(async () => {
  await initI18n({ locales: LOCALE_CODES, defaultLocale: DEFAULT_LOCALE });
});

/** Records every Discord API call the service makes. */
function apiLog() {
  return [];
}

function member(id, { permissions = [], position = 1, username = id, dmOk = true } = {}) {
  const calls = [];
  return {
    id,
    user: { username },
    calls,
    roles: { highest: { position } },
    permissions: { has: (flag) => permissions.includes(String(flag)) || permissions.includes('ALL') },
    async kick(reason) {
      calls.push({ method: 'kick', reason });
      return this;
    },
    async disableCommunicationUntil(until, reason) {
      calls.push({ method: 'disableCommunicationUntil', until, reason });
      return this;
    },
    async send(content) {
      if (!dmOk) throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
      calls.push({ method: 'send', content });
      return { id: 'dm' };
    },
  };
}

/** Builds a guild whose every API call is recorded into `log`. */
function guild(log, { ownerId = 'owner', botPosition = 50, botPermissions = ['ALL'] } = {}) {
  const me = member('bot', { permissions: botPermissions, position: botPosition, username: 'xXx Family' });
  return {
    id: 'g1',
    name: 'xXx Family',
    ownerId,
    roles: { everyone: { id: 'everyone', position: 0 } },
    members: {
      me,
      async ban(targetId, options) {
        log.push({ method: 'guild.ban', targetId, options });
        return { id: targetId };
      },
    },
    bans: {
      async remove(userId, reason) {
        log.push({ method: 'guild.unban', userId, reason });
        return { user: { id: userId } };
      },
    },
    __me: me,
  };
}

function channel(log, { id = 'c1', name = 'general', messages = [] } = {}) {
  return {
    id,
    name,
    createdTimestamp: Date.now(),
    messages: {
      async fetch({ limit }) {
        log.push({ method: 'fetch', limit });
        return new Map(messages.slice(0, limit).map((m) => [m.id, m]));
      },
    },
    async bulkDelete(items) {
      log.push({ method: 'bulkDelete', count: items.length });
      return new Map(items.map((m) => [m.id, m]));
    },
    async setRateLimitPerUser(seconds, reason) {
      log.push({ method: 'setRateLimitPerUser', seconds, reason });
      return this;
    },
    permissionOverwrites: {
      async edit(roleId, overwrite, options) {
        log.push({ method: 'permissionOverwrites.edit', roleId, overwrite, reason: options?.reason });
        return this;
      },
    },
  };
}

function message(id, { authorId = 'someone', ageMs = 0 } = {}) {
  return { id, author: { id: authorId }, createdTimestamp: Date.now() - ageMs };
}

/** In-memory stand-ins for the two Mongoose models the service uses. */
function createStores() {
  const cases = [];
  const counters = new Map();
  let counterSeq = 0;

  return {
    __cases: cases,
    ModerationCase: {
      async create(doc) {
        // Real Mongoose `timestamps: true` fills this in; without it the
        // ordering sort in getHistory() would be a no-op and the history test
        // would pass without proving anything.
        const row = { ...doc, createdAt: new Date(Date.now() + cases.length) };
        cases.push(row);
        return row;
      },
      async countDocuments(filter) {
        return cases.filter((c) => c.guildId === filter.guildId && c.targetId === filter.targetId).length;
      },
      // Mongoose's find() returns a Query synchronously; the await happens at
      // the end of the chain. An `async find` here would hand back a Promise
      // and `.sort()` would not exist on it.
      find(filter) {
        const rows = cases
          .filter((c) => c.guildId === filter.guildId && c.targetId === filter.targetId)
          .sort((a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0));
        return {
          sort: () => ({
            skip: () => ({ limit: () => ({ lean: async () => rows }) }),
          }),
        };
      },
      async findOneAndUpdate(filter, update) {
        const row = cases.find(
          (c) => c.guildId === filter.guildId && c.caseNumber === filter.caseNumber && !c.revokedAt,
        );
        if (!row) return null;
        Object.assign(row, update.$set);
        return row;
      },
      async updateOne(filter, update) {
        const row = cases.find((c) => c.guildId === filter.guildId && c.caseNumber === filter.caseNumber);
        if (row) Object.assign(row, update.$set);
        return { modifiedCount: row ? 1 : 0 };
      },
    },
    Counter: {
      async next(scope, key) {
        const k = `${scope}:${key}`;
        const next = (counters.get(k) ?? 0) + 1;
        counters.set(k, next);
        counterSeq += 1;
        return next;
      },
      __counterCalls: () => counterSeq,
    },
  };
}

describe('ModerationService', () => {
  let log;
  let stores;
  let audits;
  let service;

  beforeEach(() => {
    log = apiLog();
    stores = createStores();
    audits = [];
    service = new ModerationService({
      models: stores,
      logging: { log: async (entry) => audits.push(entry) },
      isDbReady: () => true,
    });
  });

  /** A moderator with every moderation permission, ranked above everyone. */
  const mod = () => member('mod', { permissions: ['ALL'], position: 40, username: 'Mod' });

  describe('ban', () => {
    test('bans, records a case and writes an audit entry', async () => {
      const g = guild(log);
      const target = member('user', { position: 1, username: 'Ada' });

      const result = await service.ban({ guild: g, target, moderator: mod(), reason: 'spam' });

      assert.equal(result.caseNumber, 1);
      assert.equal(result.dmSent, true);
      assert.deepEqual(log, [{ method: 'guild.ban', targetId: 'user', options: { deleteMessageSeconds: 0, reason: 'spam (Mod)' } }]);
      assert.equal(stores.__cases.length, 1);
      assert.equal(stores.__cases[0].type, 'ban');
      assert.equal(stores.__cases[0].targetLabel, 'Ada');
      assert.equal(audits[0].type, 'member.ban');
      assert.equal(audits[0].evidence.caseNumber, 1);
    });

    test('the DM is rendered in the member locale and carries the reason', async () => {
      const g = guild(log);
      const target = member('user', { position: 1 });

      await service.ban({ guild: g, target, moderator: mod(), reason: 'advertising' });

      const dm = target.calls.find((c) => c.method === 'send');
      assert.ok(dm, 'no DM was attempted');
      assert.match(dm.content, /banned from \*\*xXx Family\*\*/);
      assert.match(dm.content, /advertising/);
    });

    test('a closed DM channel does not fail the ban', async () => {
      const g = guild(log);
      const target = member('user', { position: 1, dmOk: false });

      const result = await service.ban({ guild: g, target, moderator: mod(), reason: 'spam' });

      assert.equal(result.caseNumber, 1, 'the case must still be recorded');
      assert.equal(result.dmSent, false);
      // The case is updated to reflect that the member was not notified.
      assert.equal(stores.__cases[0].dmSent, false);
    });

    test('deleteMessageDays outside 0..7 is rejected before any API call', async () => {
      const g = guild(log);
      await assert.rejects(
        service.ban({ guild: g, target: member('user', { position: 1 }), moderator: mod(), deleteMessageDays: 30 }),
        ValidationError,
      );
      assert.equal(log.length, 0, 'Discord must not be called for an invalid request');
    });

    test('case numbers increment per guild and do not repeat', async () => {
      const g = guild(log);
      const a = await service.ban({ guild: g, target: member('u1', { position: 1 }), moderator: mod(), reason: 'a' });
      const b = await service.ban({ guild: g, target: member('u2', { position: 1 }), moderator: mod(), reason: 'b' });
      const c = await service.warn({ guild: g, target: member('u3', { position: 1 }), moderator: mod(), reason: 'c' });

      assert.deepEqual([a.caseNumber, b.caseNumber, c.caseNumber], [1, 2, 3]);
    });

    test('a rejected ban records no case', async () => {
      // The order matters: a case that claims a ban happened, when Discord
      // refused it, is worse than no case at all.
      const g = guild(log);
      g.members.ban = async () => {
        throw Object.assign(new Error('Missing Permissions'), { status: 403, code: 50013 });
      };

      await assert.rejects(
        service.ban({ guild: g, target: member('user', { position: 1 }), moderator: mod(), reason: 'spam' }),
        ExternalServiceError,
      );
      assert.equal(stores.__cases.length, 0);
      assert.equal(audits.length, 0);
    });
  });

  describe('timeout', () => {
    test('applies the timeout and stores the expiry', async () => {
      const g = guild(log);
      const target = member('user', { position: 1 });

      const result = await service.timeout({ guild: g, target, moderator: mod(), reason: 'raiding', durationMs: 3600_000 });

      assert.equal(result.caseNumber, 1);
      assert.equal(target.calls[0].method, 'disableCommunicationUntil');
      assert.ok(target.calls[0].until > Date.now(), 'expiry must be in the future');
      assert.ok(stores.__cases[0].expiresAt instanceof Date);
    });

    test('rejects a zero or negative duration', async () => {
      const g = guild(log);
      await assert.rejects(
        service.timeout({ guild: g, target: member('user', { position: 1 }), moderator: mod(), durationMs: 0 }),
        ValidationError,
      );
      await assert.rejects(
        service.timeout({ guild: g, target: member('user', { position: 1 }), moderator: mod(), durationMs: -5 }),
        ValidationError,
      );
      assert.equal(log.length, 0);
    });

    test('rejects a duration beyond Discord’s 28-day maximum', async () => {
      const g = guild(log);
      await assert.rejects(
        service.timeout({
          guild: g,
          target: member('user', { position: 1 }),
          moderator: mod(),
          durationMs: MAX_TIMEOUT_MS + 1000,
        }),
        (err) => {
          assert.ok(err instanceof ValidationError);
          assert.match(err.message, /28 days/);
          return true;
        },
      );
      assert.equal(log.length, 0, 'a clamped call would make the case record lie');
    });

    test('accepts exactly the maximum', async () => {
      const g = guild(log);
      const result = await service.timeout({
        guild: g,
        target: member('user', { position: 1 }),
        moderator: mod(),
        durationMs: MAX_TIMEOUT_MS,
      });
      assert.equal(result.caseNumber, 1);
    });

    test('untimeout clears the expiry by passing null', async () => {
      const g = guild(log);
      const target = member('user', { position: 1 });
      await service.untimeout({ guild: g, target, moderator: mod(), reason: 'appealed' });
      assert.equal(target.calls[0].until, null);
    });
  });

  describe('warn', () => {
    test('records a case and DMs the member', async () => {
      const g = guild(log);
      const target = member('user', { position: 1 });

      const result = await service.warn({ guild: g, target, moderator: mod(), reason: 'be kind' });

      assert.equal(result.caseNumber, 1);
      assert.equal(stores.__cases[0].type, 'warn');
      assert.match(target.calls.find((c) => c.method === 'send').content, /be kind/);
    });

    test('a warning without a reason is rejected', async () => {
      const g = guild(log);
      for (const reason of [null, '', '   ']) {
        await assert.rejects(
          service.warn({ guild: g, target: member('user', { position: 1 }), moderator: mod(), reason }),
          ValidationError,
        );
      }
      assert.equal(stores.__cases.length, 0);
    });

    test('a warning makes no Discord API call', async () => {
      const g = guild(log);
      await service.warn({ guild: g, target: member('user', { position: 1 }), moderator: mod(), reason: 'noted' });
      assert.equal(log.length, 0);
    });
  });

  describe('permission gating', () => {
    test('a moderator without BanMembers cannot ban', async () => {
      const g = guild(log);
      const weak = member('weak', { permissions: [String(PermissionFlagsBits.ManageChannels)], position: 40 });
      await assert.rejects(
        service.ban({ guild: g, target: member('user', { position: 1 }), moderator: weak, reason: 'spam' }),
        PermissionDeniedError,
      );
      assert.equal(log.length, 0);
    });

    test('a moderator cannot act on a member ranked above them', async () => {
      const g = guild(log);
      await assert.rejects(
        service.ban({ guild: g, target: member('admin', { position: 90 }), moderator: mod(), reason: 'spam' }),
        PermissionDeniedError,
      );
      assert.equal(log.length, 0);
    });

    test('a moderator cannot ban the guild owner', async () => {
      const g = guild(log);
      await assert.rejects(
        service.ban({ guild: g, target: member('owner', { position: 0 }), moderator: mod(), reason: 'spam' }),
        (err) => {
          assert.ok(err instanceof PermissionDeniedError);
          // Its own message, not "you are missing a permission" — the moderator
          // has the permission; the owner is simply out of reach.
          assert.equal(err.i18nKey, 'errors:owner');
          assert.equal(err.details.target, '<@owner>');
          return true;
        },
      );
    });

    test('a low-ranked bot is reported with the hierarchy message', async () => {
      const g = guild(log, { botPosition: 2 });
      await assert.rejects(
        service.ban({ guild: g, target: member('user', { position: 10 }), moderator: mod(), reason: 'spam' }),
        (err) => {
          assert.equal(err.i18nKey, 'errors:hierarchyBot');
          assert.equal(err.details.target, '<@user>');
          return true;
        },
      );
      assert.equal(log.length, 0);
    });
  });

  describe('purge', () => {
    test('deletes recent messages and records how many', async () => {
      const messages = [message('1'), message('2'), message('3')];
      const g = guild(log);
      const ch = channel(log, { messages });

      const result = await service.purge({ guild: g, channel: ch, moderator: mod(), count: 3, reason: 'cleanup' });

      assert.equal(result.deleted, 3);
      assert.equal(result.caseNumber, 1);
      assert.equal(stores.__cases[0].type, 'purge');
      assert.equal(stores.__cases[0].evidence.deleted, 3);
    });

    test('messages older than 14 days are skipped', async () => {
      const messages = [message('fresh'), message('old', { ageMs: 15 * 86400_000 })];
      const g = guild(log);
      const ch = channel(log, { messages });

      const result = await service.purge({ guild: g, channel: ch, moderator: mod(), count: 5 });

      assert.equal(result.deleted, 1, 'the 14-day-old message must not be counted');
    });

    test('filtering by user selects only that user’s messages', async () => {
      const messages = [message('a', { authorId: 'spam1' }), message('b', { authorId: 'other' }), message('c', { authorId: 'spam1' })];
      const g = guild(log);
      const ch = channel(log, { messages });

      const result = await service.purge({ guild: g, channel: ch, moderator: mod(), count: 5, filterUserId: 'spam1' });

      assert.equal(result.deleted, 2);
    });

    test('an empty result still records the case with a zero count', async () => {
      const g = guild(log);
      const ch = channel(log, { messages: [] });

      const result = await service.purge({ guild: g, channel: ch, moderator: mod(), count: 5 });

      assert.equal(result.deleted, 0);
      assert.equal(result.caseNumber, 1);
      // bulkDelete must not be called with an empty list — Discord rejects it.
      assert.ok(!log.some((c) => c.method === 'bulkDelete'));
    });

    test('counts outside the allowed range are rejected', async () => {
      const g = guild(log);
      const ch = channel(log, { messages: [message('1')] });
      for (const count of [0, -1, MAX_PURGE + 1, Number.NaN]) {
        await assert.rejects(
          service.purge({ guild: g, channel: ch, moderator: mod(), count }),
          ValidationError,
        );
      }
      assert.ok(MIN_PURGE === 1);
    });

    test('deleted message content is never stored', async () => {
      const messages = [
        { id: '1', author: { id: 'a' }, createdTimestamp: Date.now(), content: 'a secret phrase' },
      ];
      const g = guild(log);
      const ch = channel(log, { messages });

      await service.purge({ guild: g, channel: ch, moderator: mod(), count: 1 });

      const stored = JSON.stringify(stores.__cases[0].evidence);
      assert.ok(!stored.includes('secret phrase'), 'purge evidence leaked message content');
    });
  });

  describe('slowmode / lock / unlock', () => {
    test('slowmode passes the value through', async () => {
      const g = guild(log);
      const ch = channel(log);
      const result = await service.slowmode({ guild: g, channel: ch, moderator: mod(), seconds: 30 });
      assert.equal(result.seconds, 30);
      assert.equal(log[0].seconds, 30);
    });

    test('slowmode rejects out-of-range values', async () => {
      const g = guild(log);
      const ch = channel(log);
      for (const seconds of [-1, 21601, Number.NaN]) {
        await assert.rejects(service.slowmode({ guild: g, channel: ch, moderator: mod(), seconds }), ValidationError);
      }
      assert.equal(log.length, 0);
    });

    test('lock denies SendMessages for everyone', async () => {
      const g = guild(log);
      const ch = channel(log);
      await service.lock({ guild: g, channel: ch, moderator: mod(), reason: 'raid' });
      assert.deepEqual(log[0].overwrite, { SendMessages: false });
      assert.equal(stores.__cases[0].type, 'lock');
    });

    test('unlock removes the override rather than granting SendMessages', async () => {
      // Setting it to `true` would override a category that intends to deny.
      const g = guild(log);
      const ch = channel(log);
      await service.unlock({ guild: g, channel: ch, moderator: mod() });
      assert.deepEqual(log[0].overwrite, { SendMessages: null });
    });
  });

  describe('history and revocation', () => {
    test('history lists a member’s cases newest first', async () => {
      const g = guild(log);
      const target = member('user', { position: 1 });
      await service.warn({ guild: g, target, moderator: mod(), reason: 'first' });
      await service.warn({ guild: g, target, moderator: mod(), reason: 'second' });

      const history = await service.getHistory('g1', 'user');

      assert.equal(history.total, 2);
      assert.deepEqual(history.entries.map((e) => e.reason), ['second', 'first']);
    });

    test('history for an unknown member is empty, not an error', async () => {
      const history = await service.getHistory('g1', 'nobody');
      assert.deepEqual(history.entries, []);
      assert.equal(history.total, 0);
    });

    test('revoking marks the case and audits it', async () => {
      const g = guild(log);
      const { caseNumber } = await service.warn({ guild: g, target: member('user', { position: 1 }), moderator: mod(), reason: 'x' });

      const ok = await service.revokeCase({ guildId: 'g1', caseNumber, moderator: mod(), reason: 'appeal accepted' });

      assert.equal(ok, true);
      assert.ok(stores.__cases[0].revokedAt instanceof Date);
      assert.equal(audits.at(-1).evidence.revoked, true);
    });

    test('revoking twice is idempotent', async () => {
      const g = guild(log);
      const { caseNumber } = await service.warn({ guild: g, target: member('user', { position: 1 }), moderator: mod(), reason: 'x' });

      await service.revokeCase({ guildId: 'g1', caseNumber, moderator: mod() });
      const second = await service.revokeCase({ guildId: 'g1', caseNumber, moderator: mod() });

      assert.equal(second, false);
    });

    test('history returns nothing when the database is offline', async () => {
      const offline = new ModerationService({ models: stores, isDbReady: () => false });
      const history = await offline.getHistory('g1', 'user');
      assert.deepEqual(history.entries, []);
    });
  });

  describe('without a database', () => {
    test('the action still runs and reports that no case was saved', async () => {
      // A moderator must not lose the ability to moderate because MongoDB is
      // unreachable — but they must be told the record is missing.
      const offline = new ModerationService({ models: stores, isDbReady: () => false });
      const g = guild(log);
      const target = member('user', { position: 1 });

      const result = await offline.ban({ guild: g, target, moderator: mod(), reason: 'spam' });

      assert.equal(result.caseNumber, null);
      assert.equal(log.length, 1, 'the ban itself must still happen');
      assert.equal(result.dmSent, true);
    });
  });

  describe('audit reason', () => {
    test('attributes the action to the moderator', async () => {
      const g = guild(log);
      await service.ban({ guild: g, target: member('user', { position: 1 }), moderator: mod(), reason: 'spam' });
      assert.equal(log[0].options.reason, 'spam (Mod)');
    });

    test('a missing reason still names the bot', async () => {
      const g = guild(log);
      await service.ban({ guild: g, target: member('user', { position: 1 }), moderator: mod() });
      assert.match(log[0].options.reason, /^xXx Family/);
    });

    test('an absurdly long reason is truncated, not rejected', async () => {
      const g = guild(log);
      await service.ban({ guild: g, target: member('user', { position: 1 }), moderator: mod(), reason: 'x'.repeat(2000) });
      assert.ok(log[0].options.reason.length <= 512);
      assert.ok(stores.__cases[0].reason.length <= 1000);
    });
  });
});
