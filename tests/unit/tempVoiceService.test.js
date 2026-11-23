import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';

import { TempVoiceService } from '../../src/services/tempVoiceService.js';
import { DEFAULT_TEMPVOICE_CONFIG } from '../../src/database/models/TempVoiceConfig.js';
import { DatabaseError } from '../../src/utils/errors.js';

const TRIGGER = '1000000000000000001';
const CATEGORY = '1000000000000000002';

/** In-memory TempVoiceConfig + TemporaryVoice with the Mongoose surface used. */
function createStores({ config = null, rooms = [] } = {}) {
  const state = {
    config,
    rooms: [...rooms],
    created: [],
    deleted: [],
  };

  return {
    __state: state,
    TempVoiceConfig: {
      findOne: ({ guildId }) => ({ lean: async () => (state.config?.guildId === guildId ? state.config : null) }),
      async findOneAndUpdate({ guildId }, update) {
        state.config = { ...(state.config ?? { guildId }), ...(update.$set ?? {}) };
        state.config.guildId = guildId;
        return state.config;
      },
    },
    TemporaryVoice: {
      findOne: ({ guildId, channelId }) => ({
        lean: async () => state.rooms.find((r) => r.guildId === guildId && r.channelId === channelId) ?? null,
      }),
      countDocuments: async ({ guildId, ownerId }) =>
        state.rooms.filter((r) => r.guildId === guildId && r.ownerId === ownerId).length,
      async create(doc) {
        state.rooms.push({ ...doc });
        state.created.push(doc.channelId);
        return { ...doc };
      },
      async updateOne({ guildId, channelId }, update) {
        const row = state.rooms.find((r) => r.guildId === guildId && r.channelId === channelId);
        if (row) Object.assign(row, update.$set);
        return { modifiedCount: row ? 1 : 0 };
      },
      async findOneAndUpdate({ guildId, channelId, deleting }, update) {
        const row = state.rooms.find(
          (r) => r.guildId === guildId && r.channelId === channelId && (!deleting || r.deleting === deleting),
        );
        if (!row) return null;
        Object.assign(row, update.$set);
        return row;
      },
      async deleteOne({ guildId, channelId }) {
        const index = state.rooms.findIndex((r) => r.guildId === guildId && r.channelId === channelId);
        if (index >= 0) state.deleted.push(channelId);
        if (index >= 0) state.rooms.splice(index, 1);
        return { deletedCount: index >= 0 ? 1 : 0 };
      },
      find: ({ guildId }) => ({ lean: async () => state.rooms.filter((r) => r.guildId === guildId) }),
    },
  };
}

let channelSeq = 0;

/** A guild whose channels.create actually returns a fake channel. */
function createGuild({ botCanMove = true, createFails = false } = {}) {
  const channels = new Map();
  const log = [];

  const guild = {
    id: 'g1',
    name: 'Test Guild',
    client: { user: { id: 'bot' } },
    roles: { everyone: { id: 'everyone', position: 0 } },
    channels: {
      created: [],
      async create(options) {
        log.push({ method: 'create', ...options });
        if (createFails) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
        channelSeq += 1;
        const id = `room-${channelSeq}`;
        const channel = {
          id,
          name: options.name,
          members: new Map(),
          overwrites: options.permissionOverwrites ?? [],
          async delete(reason) {
            log.push({ method: 'delete', id, reason });
            channels.delete(id);
          },
          async setName(name) {
            log.push({ method: 'setName', id, name });
            this.name = name;
          },
          async setUserLimit(limit) {
            log.push({ method: 'setUserLimit', id, limit });
          },
          permissionOverwrites: {
            async edit(roleOrUserId, overwrite, opts) {
              log.push({ method: 'overwrite', id, target: roleOrUserId, overwrite, reason: opts?.reason });
            },
          },
        };
        channels.set(id, channel);
        guild.channels.created.push(channel);
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
  };

  return { guild, channels, botCanMove, log };
}

/** A member with a voice state the service can move. */
function member(id, { canBeMoved = true, username = id, permissions = [] } = {}) {
  return {
    id,
    user: { username },
    displayName: username,
    permissions: { has: (flag) => permissions.includes(String(flag)) || permissions.includes('ALL') },
    voice: {
      channelId: null,
      async setChannel(channel) {
        if (!canBeMoved) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
        this.channelId = channel?.id ?? null;
      },
    },
  };
}

describe('TempVoiceService — room creation', () => {
  let stores;
  let service;
  let fixture;

  beforeEach(async () => {
    channelSeq = 0;
    stores = createStores({ config: { guildId: 'g1', enabled: true, triggerChannelId: TRIGGER, categoryId: CATEGORY } });
    service = new TempVoiceService({ models: stores, isDbReady: () => true });
    fixture = createGuild();
  });

  afterEach(() => {
    service.forgetGuild('g1');
  });

  test('joining the trigger creates a room and moves the member in', async () => {
    const ada = member('ada', { username: 'Ada' });

    const result = await service.handleVoiceUpdate(ada, null, TRIGGER, fixture.guild);

    assert.equal(result.action, 'created');
    assert.ok(result.channelId);
    assert.equal(ada.voice.channelId, result.channelId, 'the member must actually be moved');
    assert.equal(stores.__state.created.length, 1, 'the room must be recorded');
  });

  test('the room is a voice channel in the configured category', async () => {
    await service.handleVoiceUpdate(member('ada'), null, TRIGGER, fixture.guild);

    const created = fixture.log.find((e) => e.method === 'create');
    assert.equal(created.type, 2, 'GuildVoice');
    assert.equal(created.parent, CATEGORY);
  });

  test('the owner gets ManageChannels over their own room', async () => {
    await service.handleVoiceUpdate(member('ada'), null, TRIGGER, fixture.guild);

    const created = fixture.log.find((e) => e.method === 'create');
    const ownerOverwrite = created.permissionOverwrites.find((o) => o.id === 'ada');
    assert.ok(ownerOverwrite, 'no overwrite was written for the owner');
    assert.ok(ownerOverwrite.allow.includes(PermissionFlagsBits.ManageChannels));
  });

  test('joining any other channel creates nothing', async () => {
    const result = await service.handleVoiceUpdate(member('ada'), null, 'some-other-channel', fixture.guild);
    assert.notEqual(result.action, 'created');
    assert.equal(stores.__state.created.length, 0);
  });

  test('a disabled guild creates nothing', async () => {
    await stores.TempVoiceConfig.findOneAndUpdate({ guildId: 'g1' }, { $set: { enabled: false } });
    const result = await service.handleVoiceUpdate(member('ada'), null, TRIGGER, fixture.guild);
    assert.notEqual(result.action, 'created');
  });

  test('the bot moving itself creates nothing', async () => {
    const bot = member('bot');
    await service.handleVoiceUpdate(bot, null, TRIGGER, fixture.guild);
    assert.equal(stores.__state.created.length, 0);
  });

  test('a member at the ownership limit gets no second room', async () => {
    const ada = member('ada');
    await service.handleVoiceUpdate(ada, null, TRIGGER, fixture.guild);
    // Leave, then join the trigger again.
    const second = await service.handleVoiceUpdate(ada, 'room-1', TRIGGER, fixture.guild);
    assert.notEqual(second.action, 'created');
    assert.equal(stores.__state.created.length, 1);
  });

  test('a failed move deletes the room it just created', async () => {
    // Otherwise every failed move leaves an empty room behind, which is how
    // servers end up with hundreds of dead channels.
    const ada = member('ada', { canBeMoved: false });

    const result = await service.handleVoiceUpdate(ada, null, TRIGGER, fixture.guild);

    assert.equal(result.action, 'failed');
    assert.equal(fixture.log.filter((e) => e.method === 'delete').length, 1);
    assert.equal(stores.__state.rooms.length, 0, 'no room record may survive a failed move');
  });

  test('a channel creation failure is reported, not thrown', async () => {
    const broken = createGuild({ createFails: true });
    const result = await service.handleVoiceUpdate(member('ada'), null, TRIGGER, broken.guild);
    assert.equal(result.action, 'failed');
  });
});

describe('TempVoiceService — cleanup', () => {
  let stores;
  let service;
  let fixture;

  beforeEach(() => {
    channelSeq = 0;
    stores = createStores({ config: { guildId: 'g1', enabled: true, triggerChannelId: TRIGGER, categoryId: CATEGORY } });
    fixture = createGuild();
  });

  afterEach(() => {
    service.forgetGuild('g1');
  });

  test('a zero grace period deletes the room as soon as it empties', async () => {
    service = new TempVoiceService({ models: stores, isDbReady: () => true });
    await stores.TempVoiceConfig.findOneAndUpdate({ guildId: 'g1' }, { $set: { emptyGraceMs: 0 } });

    const ada = member('ada');
    await service.handleVoiceUpdate(ada, null, TRIGGER, fixture.guild);
    await service.handleVoiceUpdate(ada, 'room-1', null, fixture.guild);

    assert.equal(fixture.log.filter((e) => e.method === 'delete').length, 1);
    assert.equal(stores.__state.rooms.length, 0);
  });

  test('a grace period keeps the room briefly, then removes it', async () => {
    service = new TempVoiceService({ models: stores, isDbReady: () => true });
    await stores.TempVoiceConfig.findOneAndUpdate({ guildId: 'g1' }, { $set: { emptyGraceMs: 20 } });

    const ada = member('ada');
    await service.handleVoiceUpdate(ada, null, TRIGGER, fixture.guild);
    await service.handleVoiceUpdate(ada, 'room-1', null, fixture.guild);

    // Still there during the grace period — dropping for a second must not
    // cost someone their room.
    assert.equal(stores.__state.rooms.length, 1, 'the room was deleted before the grace period elapsed');

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(stores.__state.rooms.length, 0, 'the room was never cleaned up');
  });

  test('rejoining during the grace period cancels the cleanup', async () => {
    service = new TempVoiceService({ models: stores, isDbReady: () => true });
    await stores.TempVoiceConfig.findOneAndUpdate({ guildId: 'g1' }, { $set: { emptyGraceMs: 40 } });

    const ada = member('ada');
    await service.handleVoiceUpdate(ada, null, TRIGGER, fixture.guild);
    await service.handleVoiceUpdate(ada, 'room-1', null, fixture.guild);
    // Back in before the timer fires.
    await service.handleVoiceUpdate(ada, null, 'room-1', fixture.guild);

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(stores.__state.rooms.length, 1, 'the room was deleted despite the owner returning');
    assert.equal(fixture.log.filter((e) => e.method === 'delete').length, 0);
  });

  test('reconcile deletes records for channels Discord no longer has', async () => {
    service = new TempVoiceService({ models: stores, isDbReady: () => true });
    stores.__state.rooms.push({ guildId: 'g1', channelId: 'gone', ownerId: 'ada', deleting: false });

    const result = await service.reconcile(fixture.guild);

    assert.equal(result.stale, 1);
    assert.equal(stores.__state.rooms.length, 0);
  });

  test('reconcile deletes rooms that are empty on boot', async () => {
    service = new TempVoiceService({ models: stores, isDbReady: () => true });
    const { guild } = createGuild();
    const empty = { id: 'empty-room', members: new Map(), async delete() {} };
    guild.channels.__put(empty);
    stores.__state.rooms.push({ guildId: 'g1', channelId: 'empty-room', ownerId: 'ada', deleting: false });

    const result = await service.reconcile(guild);

    assert.equal(result.emptied, 1);
    assert.equal(stores.__state.rooms.length, 0);
  });

  test('reconcile keeps rooms that still have people in them', async () => {
    service = new TempVoiceService({ models: stores, isDbReady: () => true });
    const { guild } = createGuild();
    const occupied = { id: 'busy-room', members: new Map([['ada', {}]]), async delete() {} };
    guild.channels.__put(occupied);
    stores.__state.rooms.push({ guildId: 'g1', channelId: 'busy-room', ownerId: 'ada', deleting: false });

    const result = await service.reconcile(guild);

    assert.equal(result.emptied, 0);
    assert.equal(stores.__state.rooms.length, 1);
  });
});

describe('TempVoiceService — room control', () => {
  let stores;
  let service;
  let fixture;
  let ada;
  let channelId;

  beforeEach(async () => {
    channelSeq = 0;
    stores = createStores({ config: { guildId: 'g1', enabled: true, triggerChannelId: TRIGGER, categoryId: CATEGORY } });
    service = new TempVoiceService({ models: stores, isDbReady: () => true });
    fixture = createGuild();
    ada = member('ada', { username: 'Ada' });
    const result = await service.handleVoiceUpdate(ada, null, TRIGGER, fixture.guild);
    channelId = result.channelId;
  });

  afterEach(() => {
    service.forgetGuild('g1');
  });

  test('the owner can rename the room', async () => {
    const result = await service.rename({ guild: fixture.guild, channelId, member: ada, name: 'Party room' });
    assert.equal(result.ok, true);
    assert.equal(result.name, 'Party room');
    assert.equal(stores.__state.rooms[0].name, 'Party room');
  });

  test('a non-owner without ManageChannels cannot rename', async () => {
    const other = member('bob');
    const result = await service.rename({ guild: fixture.guild, channelId, member: other, name: 'hijacked' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-owner');
  });

  test('a moderator with ManageChannels can rename any room', async () => {
    const mod = member('mod', { permissions: [String(PermissionFlagsBits.ManageChannels)] });
    const result = await service.rename({ guild: fixture.guild, channelId, member: mod, name: 'Moderated' });
    assert.equal(result.ok, true);
  });

  test('an empty name is rejected', async () => {
    const result = await service.rename({ guild: fixture.guild, channelId, member: ada, name: '   ' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'empty-name');
  });

  test('a channel that is not a temp room is reported as such', async () => {
    const result = await service.rename({ guild: fixture.guild, channelId: 'regular-vc', member: ada, name: 'x' });
    assert.equal(result.reason, 'not-a-temp-room');
  });

  test('the owner can set the member limit', async () => {
    const result = await service.setLimit({ guild: fixture.guild, channelId, member: ada, limit: 5 });
    assert.equal(result.ok, true);
    assert.equal(result.limit, 5);
  });

  test('an out-of-range limit is rejected', async () => {
    for (const limit of [-1, 100, 1.5]) {
      const result = await service.setLimit({ guild: fixture.guild, channelId, member: ada, limit });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'invalid-limit');
    }
  });

  test('the owner can lock and unlock the room', async () => {
    const locked = await service.setLocked({ guild: fixture.guild, channelId, member: ada, locked: true });
    assert.equal(locked.ok, true);
    assert.equal(stores.__state.rooms[0].locked, true);

    const overwrite = fixture.log.filter((e) => e.method === 'overwrite').at(-1);
    assert.deepEqual(overwrite.overwrite, { Connect: false });

    const unlocked = await service.setLocked({ guild: fixture.guild, channelId, member: ada, locked: false });
    assert.equal(unlocked.ok, true);
    // Unlocking removes the override rather than granting Connect, so a server
    // that intends to restrict voice keeps working.
    assert.deepEqual(fixture.log.filter((e) => e.method === 'overwrite').at(-1).overwrite, { Connect: null });
  });

  test('ownership cannot be transferred to someone outside the room', async () => {
    const result = await service.transferOwnership({ guild: fixture.guild, channelId, member: ada, newOwnerId: 'ghost' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-in-room');
  });

  test('ownership transfers to a member inside the room', async () => {
    const bob = member('bob');
    const channel = await fixture.guild.channels.fetch(channelId);
    channel.members.set('bob', bob);

    const result = await service.transferOwnership({ guild: fixture.guild, channelId, member: ada, newOwnerId: 'bob' });

    assert.equal(result.ok, true);
    assert.equal(stores.__state.rooms[0].ownerId, 'bob');
    // The new owner must be granted the same rights, or they inherit a room
    // they cannot manage.
    const overwrite = fixture.log.filter((e) => e.method === 'overwrite').at(-1);
    assert.equal(overwrite.target, 'bob');
    assert.ok(overwrite.overwrite.ManageChannels);
  });
});

describe('TempVoiceService — configuration', () => {
  let stores;
  let service;

  beforeEach(() => {
    stores = createStores();
    service = new TempVoiceService({ models: stores, isDbReady: () => true });
  });

  test('an unconfigured guild gets the defaults', async () => {
    const config = await service.getConfig('g1');
    assert.equal(config.enabled, false);
    assert.equal(config.roomName, DEFAULT_TEMPVOICE_CONFIG.roomName);
    assert.equal(config.emptyGraceMs, 60_000);
  });

  test('saving without a database throws rather than pretending', async () => {
    const offline = new TempVoiceService({ models: stores, isDbReady: () => false });
    await assert.rejects(offline.saveConfig('g1', { enabled: true }), DatabaseError);
  });

  test('reading without a database falls back to the defaults', async () => {
    const offline = new TempVoiceService({ models: stores, isDbReady: () => false });
    const config = await offline.getConfig('g1');
    assert.equal(config.enabled, false);
  });

  test('saving persists and reads back', async () => {
    const config = await service.saveConfig('g1', { enabled: true, triggerChannelId: TRIGGER });
    assert.equal(config.enabled, true);
    assert.equal(config.triggerChannelId, TRIGGER);
  });
});

describe('TempVoiceService.roomName', () => {
  const service = new TempVoiceService({ models: {}, isDbReady: () => false });
  const ada = { displayName: 'Ada', user: { username: 'ada' } };

  test('substitutes the placeholders', () => {
    assert.equal(service.roomName("{user}'s room", ada, 1), "Ada's room");
    assert.equal(service.roomName('Room {number}', ada, 3), 'Room 3');
  });

  test('an empty template falls back rather than producing an empty name', () => {
    // Discord rejects an empty channel name.
    assert.ok(service.roomName('', ada, 1).length > 0);
    assert.ok(service.roomName('   ', ada, 1).length > 0);
  });

  test('a template whose placeholders do not resolve still yields a name', () => {
    const name = service.roomName('{nonexistent}', ada, 2);
    assert.ok(name.length > 0);
  });

  test('a missing display name falls back to the username', () => {
    assert.equal(service.roomName('{user}', { user: { username: 'ada' } }, 1), 'ada');
  });
});
