import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { TicketService, CLOSE_DELAY_MS } from '../../src/services/ticketService.js';
import { DatabaseError, NotFoundError, ValidationError } from '../../src/utils/errors.js';
import { initI18n } from '../../src/services/i18nService.js';
import { LOCALE_CODES, DEFAULT_LOCALE } from '../../src/config/locales.js';

before(async () => {
  await initI18n({ locales: LOCALE_CODES, defaultLocale: DEFAULT_LOCALE });
});

/**
 * The defaults the Ticket schema applies.
 *
 * A stub that omits these leaves new documents with `undefined` where Mongoose
 * writes `null` or `'open'`, and the service's atomic-update filters
 * (`claimedById: null`, `rating: null`, `status: { $ne: 'closed' }`) then
 * silently stop matching — claim, close and rate would all look broken when the
 * service itself is fine.
 */
const TICKET_DEFAULTS = Object.freeze({
  categoryId: 'support',
  subject: null,
  status: 'open',
  priority: 'normal',
  claimedById: null,
  claimedAt: null,
  closedAt: null,
  closedById: null,
  closeReason: null,
  rating: null,
  ratingComment: null,
  messages: [],
  participantIds: [],
  locale: null,
});

/** In-memory TicketConfig / Ticket / Counter with the Mongoose surface used. */
function createStores({ config = null, tickets = [] } = {}) {
  const state = { config, tickets: [...tickets], counters: new Map(), created: [] };

  return {
    __state: state,
    TicketConfig: {
      findOne: ({ guildId }) => ({ lean: async () => (state.config?.guildId === guildId ? state.config : null) }),
      async findOneAndUpdate({ guildId }, update) {
        state.config = { guildId, ...(state.config ?? {}), ...(update.$set ?? {}) };
        return state.config;
      },
    },
    Ticket: {
      async create(doc) {
        // Defaults first, then the caller's values — matching what Mongoose
        // materialises before the document reaches the service. The two arrays
        // are rebuilt per row: `TICKET_DEFAULTS` is module-level, so spreading
        // it alone would hand every ticket the *same* array and one ticket's
        // transcript would appear in every other ticket.
        const row = {
          ...TICKET_DEFAULTS,
          messages: [],
          participantIds: [],
          ...doc,
          createdAt: new Date(Date.now() + state.tickets.length),
        };
        state.tickets.push(row);
        state.created.push(doc.number);
        return row;
      },
      async countDocuments(filter) {
        return state.tickets.filter((t) => {
          if (filter.guildId && t.guildId !== filter.guildId) return false;
          if (filter.openerId && t.openerId !== filter.openerId) return false;
          if (filter.status?.$in && !filter.status.$in.includes(t.status)) return false;
          if (filter.status && !filter.status.$in && t.status !== filter.status) return false;
          if (filter.rating?.$ne !== undefined && t.rating === filter.rating.$ne) return false;
          return true;
        }).length;
      },
      findOne(filter) {
        const rows = state.tickets.filter((t) => {
          for (const [key, value] of Object.entries(filter)) {
            if (value && typeof value === 'object' && value.$ne !== undefined) {
              if (t[key] === value.$ne) return false;
            } else if (value === null) {
              if (t[key] !== null && t[key] !== undefined) return false;
            } else if (t[key] !== value) return false;
          }
          return true;
        });
        return {
          sort: () => ({ lean: async () => rows.at(-1) ?? null }),
          select: () => ({ lean: async () => rows }),
          lean: async () => rows[0] ?? null,
        };
      },
      find(filter) {
        const rows = state.tickets.filter((t) => {
          if (filter.guildId && t.guildId !== filter.guildId) return false;
          if (filter.status?.$in && !filter.status.$in.includes(t.status)) return false;
          if (filter.rating?.$ne !== undefined && t.rating === filter.rating.$ne) return false;
          return true;
        });
        return {
          sort: () => ({ limit: () => ({ lean: async () => rows }) }),
          limit: () => ({ lean: async () => rows }),
          select: () => ({ lean: async () => rows }),
          lean: async () => rows,
        };
      },
      async findOneAndUpdate(filter, update) {
        const row = state.tickets.find((t) => {
          for (const [key, value] of Object.entries(filter)) {
            if (value && typeof value === 'object' && value.$ne !== undefined) {
              if (t[key] === value.$ne) return false;
            } else if (t[key] !== value) return false;
          }
          return true;
        });
        if (!row) return null;
        Object.assign(row, update.$set ?? {});
        return row;
      },
      async updateOne({ guildId, number }, update) {
        const row = state.tickets.find((t) => t.guildId === guildId && t.number === number);
        if (!row) return { modifiedCount: 0 };
        if (update.$set) Object.assign(row, update.$set);
        if (update.$push?.messages) row.messages.push(update.$push.messages);
        if (update.$addToSet?.participantIds && !row.participantIds.includes(update.$addToSet.participantIds)) {
          row.participantIds.push(update.$addToSet.participantIds);
        }
        return { modifiedCount: 1 };
      },
    },
    Counter: {
      async next(scope, key) {
        const k = `${scope}:${key}`;
        const next = (state.counters.get(k) ?? 0) + 1;
        state.counters.set(k, next);
        return next;
      },
    },
  };
}

let channelSeq = 0;

function createGuild({ staffRole = 'staff-role' } = {}) {
  const channels = new Map();
  const log = [];
  const guild = {
    id: 'g1',
    name: 'Test Guild',
    roles: { everyone: { id: 'everyone', position: 0 } },
    channels: {
      async create(options) {
        log.push({ method: 'create', ...options });
        channelSeq += 1;
        const id = `tchan-${channelSeq}`;
        const channel = {
          id,
          name: options.name,
          sent: [],
          overwrites: options.permissionOverwrites ?? [],
          async send(payload) {
            channel.sent.push(payload);
            return { id: 'm1' };
          },
          async delete(reason) {
            log.push({ method: 'delete', id, reason });
            channels.delete(id);
          },
          permissionOverwrites: {
            async edit(target, overwrite, opts) {
              log.push({ method: 'overwrite', id, target, overwrite, reason: opts?.reason });
            },
          },
        };
        channels.set(id, channel);
        return channel;
      },
      async fetch(id) {
        const channel = channels.get(id);
        if (!channel) throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
        return channel;
      },
      __put(channel) {
        channels.set(channel.id, channel);
      },
    },
    __log: log,
    __staffRole: staffRole,
  };
  return { guild, channels, log };
}

function member(id, { username = id, roles = [] } = {}) {
  return {
    id,
    user: { username },
    roles: { cache: { has: (r) => roles.includes(r) } },
    permissions: { has: () => true },
  };
}

/** Build a service wired to fakes, with a resolvable channel map. */
function makeService(stores, fixture) {
  return new TicketService({
    models: stores,
    isDbReady: () => true,
    resolveChannel: async (id) => fixture.channels.get(id) ?? null,
  });
}

describe('TicketService — opening', () => {
  let stores;
  let fixture;
  let service;

  beforeEach(() => {
    channelSeq = 0;
    stores = createStores({ config: { guildId: 'g1', enabled: true, staffRoleId: 'staff-role' } });
    fixture = createGuild();
    service = makeService(stores, fixture);
  });

  test('opening creates a channel, a record and posts a greeting', async () => {
    const result = await service.open({ guild: fixture.guild, member: member('ada', { username: 'Ada' }) });

    assert.equal(result.ok, true);
    assert.equal(result.ticket.number, 1);
    assert.equal(result.ticket.status, 'open');
    assert.equal(result.ticket.openerLabel, 'Ada');
    assert.ok(result.channel.id);
    assert.equal(result.channel.sent.length, 2, 'greeting plus staff notice');
  });

  test('the opener can see the channel and @everyone cannot', async () => {
    await service.open({ guild: fixture.guild, member: member('ada') });

    const created = fixture.log.find((e) => e.method === 'create');
    const opener = created.permissionOverwrites.find((o) => o.id === 'ada');
    const everyone = created.permissionOverwrites.find((o) => o.id === 'everyone');
    const staff = created.permissionOverwrites.find((o) => o.id === 'staff-role');

    assert.ok(opener.allow.includes(1024n), 'the opener must be able to view the channel');
    assert.ok(everyone.deny.includes(1024n), '@everyone must not see tickets');
    assert.ok(staff, 'the staff role must be granted access');
  });

  test('ticket numbers increment per guild', async () => {
    const a = await service.open({ guild: fixture.guild, member: member('a') });
    const b = await service.open({ guild: fixture.guild, member: member('b') });
    assert.equal(a.ticket.number, 1);
    assert.equal(b.ticket.number, 2);
  });

  test('opening is refused when the system is disabled', async () => {
    await stores.TicketConfig.findOneAndUpdate({ guildId: 'g1' }, { $set: { enabled: false } });
    const result = await service.open({ guild: fixture.guild, member: member('ada') });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'disabled');
    assert.equal(stores.__state.tickets.length, 0);
  });

  test('a member at the open limit cannot open another', async () => {
    await service.open({ guild: fixture.guild, member: member('ada') });
    const second = await service.open({ guild: fixture.guild, member: member('ada') });
    assert.equal(second.ok, false);
    // With the defaults (maxOpenPerUser 1, cooldown 300s) both gates are
    // tripped. The open limit is reported because it is the one the member can
    // actually act on, and it is checked first in canOpen.
    assert.equal(second.reason, 'max-open');
  });

  test('the cooldown can be disabled', async () => {
    await stores.TicketConfig.findOneAndUpdate({ guildId: 'g1' }, { $set: { cooldownSeconds: 0, maxOpenPerUser: 5 } });
    const a = await service.open({ guild: fixture.guild, member: member('ada') });
    const b = await service.open({ guild: fixture.guild, member: member('ada') });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
  });

  test('the max-open limit is enforced even with no cooldown', async () => {
    await stores.TicketConfig.findOneAndUpdate({ guildId: 'g1' }, { $set: { cooldownSeconds: 0, maxOpenPerUser: 1 } });
    await service.open({ guild: fixture.guild, member: member('ada') });
    const second = await service.open({ guild: fixture.guild, member: member('ada') });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'max-open');
  });

  test('an unknown category falls back to the first configured one', async () => {
    const result = await service.open({ guild: fixture.guild, member: member('ada'), categoryId: 'nonsense' });
    assert.equal(result.ok, true);
    assert.equal(result.ticket.categoryId, 'support');
  });

  test('a subject is stored and truncated', async () => {
    const result = await service.open({ guild: fixture.guild, member: member('ada'), subject: 'x'.repeat(500) });
    assert.equal(result.ticket.subject.length, 200);
  });

  test('a failed channel creation is reported, not thrown', async () => {
    fixture.guild.channels.create = async () => {
      throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
    };
    const result = await service.open({ guild: fixture.guild, member: member('ada') });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'channel-failed');
    assert.equal(stores.__state.tickets.length, 0, 'no ticket record without a channel');
  });
});

describe('TicketService — claim and close', () => {
  let stores;
  let fixture;
  let service;
  let channelId;

  beforeEach(async () => {
    channelSeq = 0;
    stores = createStores({ config: { guildId: 'g1', enabled: true, staffRoleId: 'staff-role', cooldownSeconds: 0 } });
    fixture = createGuild();
    service = makeService(stores, fixture);
    const opened = await service.open({ guild: fixture.guild, member: member('ada'), subject: 'help' });
    channelId = opened.channel.id;
  });

  test('a moderator can claim an open ticket', async () => {
    const result = await service.claim({ guildId: 'g1', channelId, moderator: member('mod') });
    assert.equal(result.ok, true);
    assert.equal(result.ticket.status, 'claimed');
    assert.equal(result.ticket.claimedById, 'mod');
  });

  test('a second moderator cannot claim an already-claimed ticket', async () => {
    await service.claim({ guildId: 'g1', channelId, moderator: member('mod1') });
    const second = await service.claim({ guildId: 'g1', channelId, moderator: member('mod2') });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'already-claimed');
  });

  test('the same moderator claiming twice is told it is theirs', async () => {
    await service.claim({ guildId: 'g1', channelId, moderator: member('mod') });
    const again = await service.claim({ guildId: 'g1', channelId, moderator: member('mod') });
    assert.equal(again.reason, 'already-yours');
  });

  test('claiming a channel that is not a ticket throws NotFound', async () => {
    await assert.rejects(
      service.claim({ guildId: 'g1', channelId: 'not-a-ticket', moderator: member('mod') }),
      NotFoundError,
    );
  });

  test('closing records the closure and builds a transcript', async () => {
    const result = await service.close({
      guild: fixture.guild,
      channelId,
      closedBy: member('mod'),
      reason: 'resolved',
      deleteChannel: false,
    });

    assert.equal(result.ok, true);
    assert.equal(result.ticket.status, 'closed');
    assert.equal(result.ticket.closeReason, 'resolved');
    assert.equal(result.transcript.number, 1);
    assert.equal(result.transcript.subject, 'help');
  });

  test('closing twice is refused', async () => {
    await service.close({ guild: fixture.guild, channelId, closedBy: member('mod'), deleteChannel: false });
    const second = await service.close({ guild: fixture.guild, channelId, closedBy: member('mod'), deleteChannel: false });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'already-closed');
  });

  test('a claimed ticket can still be claimed no more after closing', async () => {
    await service.close({ guild: fixture.guild, channelId, closedBy: member('mod'), deleteChannel: false });
    const claim = await service.claim({ guildId: 'g1', channelId, moderator: member('mod2') });
    assert.equal(claim.ok, false);
    assert.equal(claim.reason, 'closed');
  });

  test('the transcript contains the recorded messages', async () => {
    await service.recordMessage({
      guildId: 'g1',
      channelId,
      message: { author: { id: 'ada', username: 'Ada' }, content: 'my printer is on fire' },
    });
    await service.recordMessage({
      guildId: 'g1',
      channelId,
      message: { author: { id: 'mod', username: 'Mod' }, content: 'have you tried turning it off' },
      isStaff: true,
    });

    const closed = await service.close({ guild: fixture.guild, channelId, closedBy: member('mod'), deleteChannel: false });

    assert.equal(closed.transcript.messageCount, 2);
    assert.match(closed.transcript.text, /my printer is on fire/);
    assert.match(closed.transcript.text, /Mod \[staff\]/);
  });

  test('bot messages are not recorded', async () => {
    await service.recordMessage({
      guildId: 'g1',
      channelId,
      message: { author: { id: 'bot', username: 'Bot', bot: true }, content: 'beep' },
    });
    assert.equal(stores.__state.tickets[0].messages.length, 0);
  });

  test('secrets in a message are redacted before being stored', async () => {
    const { registerSecret } = await import('../../src/utils/redact.js');
    registerSecret('super-secret-token');

    await service.recordMessage({
      guildId: 'g1',
      channelId,
      message: { author: { id: 'ada', username: 'Ada' }, content: 'my token is super-secret-token' },
    });

    const stored = stores.__state.tickets[0].messages[0].content;
    assert.ok(!stored.includes('super-secret-token'), `the transcript leaked a secret: ${stored}`);
  });

  test('messages cannot be added to a closed ticket', async () => {
    await service.close({ guild: fixture.guild, channelId, closedBy: member('mod'), deleteChannel: false });
    await service.recordMessage({
      guildId: 'g1',
      channelId,
      message: { author: { id: 'ada', username: 'Ada' }, content: 'hello?' },
    });
    assert.equal(stores.__state.tickets[0].messages.length, 0);
  });
});

describe('TicketService — rating', () => {
  let stores;
  let fixture;
  let service;
  let channelId;

  beforeEach(async () => {
    channelSeq = 0;
    stores = createStores({ config: { guildId: 'g1', enabled: true, cooldownSeconds: 0 } });
    fixture = createGuild();
    service = makeService(stores, fixture);
    const opened = await service.open({ guild: fixture.guild, member: member('ada') });
    channelId = opened.channel.id;
    await service.close({ guild: fixture.guild, channelId, closedBy: member('mod'), deleteChannel: false });
  });

  test('the opener can rate a closed ticket', async () => {
    const result = await service.rate({ guildId: 'g1', channelId, userId: 'ada', rating: 5, comment: 'great' });
    assert.equal(result.ok, true);
    assert.equal(stores.__state.tickets[0].rating, 5);
    assert.equal(stores.__state.tickets[0].ratingComment, 'great');
  });

  test('somebody else cannot rate it', async () => {
    const result = await service.rate({ guildId: 'g1', channelId, userId: 'someone-else', rating: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-opener');
  });

  test('a ticket can only be rated once', async () => {
    await service.rate({ guildId: 'g1', channelId, userId: 'ada', rating: 5 });
    const second = await service.rate({ guildId: 'g1', channelId, userId: 'ada', rating: 1 });
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'already-rated');
    assert.equal(stores.__state.tickets[0].rating, 5, 'the original rating must survive');
  });

  test('an out-of-range rating is rejected', async () => {
    for (const rating of [0, 6, 2.5, 'five']) {
      await assert.rejects(
        service.rate({ guildId: 'g1', channelId, userId: 'ada', rating }),
        ValidationError,
      );
    }
  });
});

describe('TicketService — participants and priority', () => {
  let stores;
  let fixture;
  let service;
  let channelId;

  beforeEach(async () => {
    channelSeq = 0;
    stores = createStores({ config: { guildId: 'g1', enabled: true, cooldownSeconds: 0 } });
    fixture = createGuild();
    service = makeService(stores, fixture);
    const opened = await service.open({ guild: fixture.guild, member: member('ada') });
    channelId = opened.channel.id;
  });

  test('a member can be added to a ticket', async () => {
    const result = await service.addParticipant({
      guild: fixture.guild,
      channelId,
      actor: member('mod'),
      target: member('bob'),
    });
    assert.equal(result.ok, true);
    assert.ok(stores.__state.tickets[0].participantIds.includes('bob'));

    const overwrite = fixture.log.filter((e) => e.method === 'overwrite').at(-1);
    assert.equal(overwrite.target, 'bob');
    assert.equal(overwrite.overwrite.ViewChannel, true);
  });

  test('priority can be set to a known level', async () => {
    for (const priority of ['low', 'normal', 'high', 'urgent']) {
      const result = await service.setPriority({ guildId: 'g1', channelId, priority });
      assert.equal(result.ok, true);
      assert.equal(stores.__state.tickets[0].priority, priority);
    }
  });

  test('an unknown priority is rejected', async () => {
    await assert.rejects(
      service.setPriority({ guildId: 'g1', channelId, priority: 'whenever' }),
      ValidationError,
    );
  });
});

describe('TicketService — configuration and stats', () => {
  let stores;
  let service;

  beforeEach(() => {
    stores = createStores();
    service = makeService(stores, createGuild());
  });

  test('an unconfigured guild gets the defaults', async () => {
    const config = await service.getConfig('g1');
    assert.equal(config.enabled, false);
    assert.equal(config.categories.length, 3);
    assert.equal(config.maxOpenPerUser, 1);
  });

  test('saving without a database throws rather than pretending', async () => {
    const offline = new TicketService({ models: stores, isDbReady: () => false });
    await assert.rejects(offline.saveConfig('g1', { enabled: true }), DatabaseError);
  });

  test('stats aggregate the open, claimed and closed counts', async () => {
    const fixture = createGuild();
    const svc = makeService(stores, fixture);
    await stores.TicketConfig.findOneAndUpdate({ guildId: 'g1' }, { $set: { enabled: true, cooldownSeconds: 0, maxOpenPerUser: 5 } });

    const a = await svc.open({ guild: fixture.guild, member: member('a') });
    const b = await svc.open({ guild: fixture.guild, member: member('b') });
    await svc.claim({ guildId: 'g1', channelId: b.channel.id, moderator: member('mod') });
    await svc.close({ guild: fixture.guild, channelId: a.channel.id, closedBy: member('mod'), deleteChannel: false });
    await svc.rate({ guildId: 'g1', channelId: a.channel.id, userId: 'a', rating: 4 });

    const stats = await svc.getStats('g1');
    assert.equal(stats.total, 2);
    assert.equal(stats.closed, 1);
    assert.equal(stats.claimed, 1);
    assert.equal(stats.rated, 1);
    assert.equal(stats.averageRating, 4);
  });

  test('stats for a guild with no tickets are zero, not null', async () => {
    const stats = await service.getStats('g1');
    assert.deepEqual(stats, { total: 0, open: 0, claimed: 0, closed: 0, rated: 0, averageRating: null });
  });
});

describe('TicketService — reconciliation', () => {
  test('tickets whose channel is gone are closed rather than left open', async () => {
    const stores = createStores({
      config: { guildId: 'g1', enabled: true },
      tickets: [{ guildId: 'g1', number: 1, channelId: 'gone', status: 'open', openerId: 'ada' }],
    });
    const fixture = createGuild();
    const service = makeService(stores, fixture);

    const result = await service.reconcile(fixture.guild);

    assert.equal(result.stale, 1);
    assert.equal(stores.__state.tickets[0].status, 'closed');
    assert.equal(stores.__state.tickets[0].closeReason, 'channel-missing');
  });

  test('tickets whose channel still exists are left alone', async () => {
    const stores = createStores({
      config: { guildId: 'g1', enabled: true },
      tickets: [{ guildId: 'g1', number: 1, channelId: 'alive', status: 'open', openerId: 'ada' }],
    });
    const fixture = createGuild();
    fixture.guild.channels.__put({ id: 'alive', members: new Map() });
    const service = makeService(stores, fixture);

    const result = await service.reconcile(fixture.guild);

    assert.equal(result.stale, 0);
    assert.equal(stores.__state.tickets[0].status, 'open');
  });
});

describe('TicketService — labels and transcript shape', () => {
  const service = new TicketService({ models: {}, isDbReady: () => false });

  test('an explicit label wins over the locale key', () => {
    assert.equal(service.categoryLabel({ id: 'x', label: 'Custom', labelKey: 'common:tickets.categories.support' }, () => 'ignored'), 'Custom');
  });

  test('a missing translation falls back to the raw id, not the key', () => {
    // i18next returns the key itself when a translation is absent; showing
    // "common:tickets.categories.support" to a user is worse than "support".
    const label = service.categoryLabel({ id: 'support', labelKey: 'common:tickets.categories.support' }, (key) => key);
    assert.equal(label, 'support');
  });

  test('a resolved translation is used', () => {
    const label = service.categoryLabel({ id: 'support', labelKey: 'common:tickets.categories.support' }, () => 'Support');
    assert.equal(label, 'Support');
  });

  test('buildTranscript handles a ticket with no messages', () => {
    const transcript = service.buildTranscript({ number: 1, guildId: 'g1', openerId: 'ada', status: 'closed' });
    assert.equal(transcript.messageCount, 0);
    assert.equal(transcript.text, '');
  });
});

describe('TicketService — contracts', () => {
  test('the close delay is long enough to be seen but short enough not to linger', () => {
    assert.ok(CLOSE_DELAY_MS >= 1000, 'the closing message would vanish before it is read');
    assert.ok(CLOSE_DELAY_MS <= 15000, 'a closed ticket should not hang around');
  });
});
