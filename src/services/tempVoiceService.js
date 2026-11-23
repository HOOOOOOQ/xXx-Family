/**
 * src/services/tempVoiceService.js
 * ---------------------------------------------------------------------------
 * Join-to-create temporary voice rooms.
 *
 * The flow:
 *   member joins the trigger channel
 *     → create a private voice channel
 *     → move the member into it
 *     → record ownership in TemporaryVoice
 *   last member leaves
 *     → after the grace period, delete the channel and the record
 *
 * Two things this service is careful about:
 *
 * 1. ORPHANS. Every room is written to the database, so a restart can reconcile
 *    against what Discord still has and clean up rooms whose owners are gone.
 *    A join-to-create bot that loses track of its channels leaves a server
 *    littered with dead rooms forever.
 *
 * 2. THE MOVE. If the bot cannot move the member (missing MoveMembers, or the
 *    channel vanished), the room it just created must be deleted again. Leaving
 *    an empty room behind on every failed move is how servers end up with
 *    hundreds of them.
 */

import { ChannelType, PermissionFlagsBits } from 'discord.js';

import { DatabaseError } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';
import { renderTemplate } from '../utils/templates.js';
import { toEffective, DEFAULT_TEMPVOICE_CONFIG } from '../database/models/TempVoiceConfig.js';

export class TempVoiceService {
  /**
   * @param {object} [deps]
   * @param {object} [deps.models] TempVoiceConfig / TemporaryVoice
   * @param {() => boolean} [deps.isDbReady]
   */
  constructor(deps = {}) {
    this.models = deps.models ?? {};
    this.isDbReady = deps.isDbReady ?? (() => true);
    this.logger = (deps.logger ?? getLogger()).child('tempvoice');
    this.metrics = deps.metrics ?? null;
    /** guildId -> Set<channelId> of rooms awaiting the empty-grace sweep. */
    this.#pending = new Map();
    /** channelId -> timeout handle, so a returning member cancels the sweep. */
    this.#timers = new Map();
  }

  #pending;
  #timers;

  /** @returns {Promise<object>} the effective config for a guild */
  async getConfig(guildId) {
    const model = this.models.TempVoiceConfig;
    if (!model || !this.isDbReady()) return { ...DEFAULT_TEMPVOICE_CONFIG };
    const doc = await model.findOne({ guildId }).lean().catch((err) => {
      this.logger.errorFrom(err, 'Could not read the temp voice config', { guildId });
      return null;
    });
    return toEffective(doc);
  }

  /** Persist a config patch. @throws {DatabaseError} without a database. */
  async saveConfig(guildId, patch) {
    const model = this.models.TempVoiceConfig;
    if (!model || !this.isDbReady()) {
      throw new DatabaseError('Temporary voice settings cannot be saved while the database is offline', {
        i18nKey: 'errors:database',
      });
    }
    await model.findOneAndUpdate(
      { guildId },
      { $set: patch, $setOnInsert: { guildId } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return this.getConfig(guildId);
  }

  /**
   * Handle a voice state change.
   *
   * Cheap checks happen in the caller; by the time we get here we know this is
   * a real join, leave or move.
   *
   * @returns {Promise<{ action:string|null, channelId?:string }>}
   */
  async handleVoiceUpdate(member, oldChannelId, newChannelId, guild) {
    if (!member || !guild) return { action: null };
    // The bot's own moves are not members joining.
    if (member.id === guild.client?.user?.id) return { action: null };

    const config = await this.getConfig(guild.id);
    if (!config.enabled || !config.triggerChannelId) return { action: null };

    const result = {};

    // Leaving (or moving out of) a room we own: maybe clean it up.
    if (oldChannelId && oldChannelId !== newChannelId) {
      const cleaned = await this.#maybeCleanup(guild, oldChannelId, config);
      if (cleaned) result.left = oldChannelId;
    }

    // Joining the trigger: create a room.
    if (newChannelId === config.triggerChannelId) {
      const created = await this.#createRoom(member, guild, config);
      if (created) {
        this.metrics?.increment('tempvoice.created');
        return { action: 'created', channelId: created };
      }
      return { action: 'failed', ...result };
    }

    // Joining (or moving into) a room we own: cancel any pending cleanup.
    if (newChannelId) {
      const owned = await this.#findRoom(guild.id, newChannelId);
      if (owned) {
        this.#cancelCleanup(newChannelId);
        await this.#markOccupied(guild.id, newChannelId);
        result.action = result.action ?? 'occupied';
      }
    }

    return result;
  }

  /**
   * Create a room for a member and move them into it.
   * @returns {Promise<string|null>} the new channel id, or null on failure
   */
  async #createRoom(member, guild, config) {
    const owned = await this.#countOwned(guild.id, member.id);
    if (owned >= config.maxOwnedPerUser) {
      this.logger.debug('Member already owns the maximum number of rooms', {
        guildId: guild.id,
        userId: member.id,
        owned,
      });
      return null;
    }

    const name = this.roomName(config.roomName, member, owned + 1);

    let channel;
    try {
      channel = await guild.channels.create({
        name,
        type: ChannelType.GuildVoice,
        parent: config.categoryId ?? undefined,
        userLimit: config.userLimit,
        bitrate: config.bitrate ?? undefined,
        permissionOverwrites: [
          // The owner always gets in and can manage their own room.
          {
            id: member.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.Connect,
              PermissionFlagsBits.Speak,
              PermissionFlagsBits.ManageChannels,
            ],
          },
          {
            id: guild.roles.everyone.id,
            // A private room hides from everyone; a non-private one is visible
            // but still needs Connect to be usable by the owner.
            deny: config.startPrivate ? [PermissionFlagsBits.ViewChannel] : [],
          },
        ],
      });
    } catch (err) {
      this.logger.errorFrom(err, 'Could not create a temporary voice channel', { guildId: guild.id });
      return null;
    }

    // The move is the part that actually delivers the feature. If it fails the
    // room is useless, so it comes back down rather than sitting there empty.
    try {
      await member.voice.setChannel(channel, 'Temporary voice room created');
    } catch (err) {
      this.logger.warn('Could not move the member into their room — deleting it', {
        guildId: guild.id,
        userId: member.id,
        reason: err.message,
      });
      await channel.delete('Temporary room: could not move the owner in').catch(() => null);
      this.metrics?.increment('tempvoice.moveFailed');
      return null;
    }

    await this.#recordRoom({
      guildId: guild.id,
      channelId: channel.id,
      categoryId: config.categoryId,
      ownerId: member.id,
      ownerLabel: member.user?.username ?? null,
      name,
      locked: config.startLocked,
      isPrivate: config.startPrivate,
      userLimit: config.userLimit,
    });

    return channel.id;
  }

  /**
   * Delete a room when it has been empty for the grace period.
   *
   * A short grace period matters: people do drop and rejoin within seconds, and
   * deleting the room on the first blip is the most annoying thing a
   * join-to-create bot can do.
   */
  #maybeCleanup(guild, channelId, config) {
    if (this.#timers.has(channelId)) return Promise.resolve(false);

    const grace = Math.max(0, config.emptyGraceMs ?? 0);
    if (grace === 0) return this.#destroyRoom(guild, channelId);

    return new Promise((resolve) => {
      const handle = setTimeout(() => {
        this.#timers.delete(channelId);
        this.#destroyRoom(guild, channelId)
          .then(resolve)
          .catch((err) => {
            this.logger.errorFrom(err, 'Cleanup failed', { channelId });
            resolve(false);
          });
      }, grace);
      // Never hold the event loop open for a cleanup timer.
      handle.unref?.();
      this.#timers.set(channelId, handle);
      const set = this.#pending.get(guild.id) ?? new Set();
      set.add(channelId);
      this.#pending.set(guild.id, set);
      resolve(true);
    });
  }

  #cancelCleanup(channelId) {
    const handle = this.#timers.get(channelId);
    if (handle) {
      clearTimeout(handle);
      this.#timers.delete(channelId);
    }
  }

  /**
   * Delete the channel and its record.
   * @returns {Promise<boolean>} whether a room was destroyed
   */
  async #destroyRoom(guild, channelId) {
    const model = this.models.TemporaryVoice;
    const room = await this.#findRoom(guild.id, channelId);
    if (!room) return false;

    // Mark first: if two sweeps race, only one proceeds.
    if (model && this.isDbReady()) {
      const claimed = await model
        .findOneAndUpdate({ guildId: guild.id, channelId, deleting: false }, { $set: { deleting: true } }, { new: true })
        .catch(() => null);
      if (!claimed) return false;
    }

    try {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (channel?.deletable !== false) {
        await channel?.delete('Temporary voice room emptied').catch((err) => {
          this.logger.warn('Could not delete an empty temporary room', {
            channelId,
            reason: err.message,
          });
        });
      }
    } finally {
      // The record goes either way: if Discord no longer has the channel,
      // keeping the row would only make the next reconcile try again forever.
      await this.#removeRoom(guild.id, channelId);
    }

    this.metrics?.increment('tempvoice.deleted');
    this.logger.info('Temporary voice room cleaned up', { guildId: guild.id, channelId });
    return true;
  }

  /**
   * Reconcile stored rooms against what the guild actually has.
   *
   * Run on guildCreate and on boot. Deletes records for channels Discord no
   * longer has, and deletes channels the bot owns that are empty.
   *
   * @returns {Promise<{ stale:number, emptied:number }>}
   */
  async reconcile(guild) {
    const model = this.models.TemporaryVoice;
    if (!model || !this.isDbReady() || !guild) return { stale: 0, emptied: 0 };

    const config = await this.getConfig(guild.id);
    const rows = await model.find({ guildId: guild.id }).lean().catch(() => []);
    let stale = 0;
    let emptied = 0;

    for (const row of rows) {
      const channel = await guild.channels.fetch(row.channelId).catch(() => null);
      if (!channel) {
        await this.#removeRoom(guild.id, row.channelId);
        stale += 1;
        continue;
      }
      const occupied = channel.members?.size ?? 0;
      if (occupied === 0) {
        const destroyed = await this.#destroyRoom(guild, row.channelId);
        if (destroyed) emptied += 1;
      } else {
        await this.#markOccupied(guild.id, row.channelId);
      }
    }

    if (stale || emptied) {
      this.logger.info('Temporary voice reconciled', { guildId: guild.id, stale, emptied });
    }
    return { stale, emptied, configured: config.enabled };
  }

  /**
   * Rename a room. Only the owner or a moderator with ManageChannels may.
   */
  async rename({ guild, channelId, member, name }) {
    const room = await this.#findRoom(guild.id, channelId);
    if (!room) return { ok: false, reason: 'not-a-temp-room' };
    const isOwner = room.ownerId === member.id;
    const canManage = member.permissions?.has?.(PermissionFlagsBits.ManageChannels);
    if (!isOwner && !canManage) return { ok: false, reason: 'not-owner' };

    const clean = String(name).trim().slice(0, 100);
    if (!clean) return { ok: false, reason: 'empty-name' };

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) return { ok: false, reason: 'missing-channel' };

    try {
      await channel.setName(clean, 'Temporary room renamed');
    } catch (err) {
      this.logger.warn('Could not rename a temporary room', { channelId, reason: err.message });
      return { ok: false, reason: 'discord-rejected' };
    }

    await this.#updateRoom(guild.id, channelId, { name: clean });
    return { ok: true, name: clean };
  }

  /** Set the member limit. 0 means unlimited. */
  async setLimit({ guild, channelId, member, limit }) {
    const room = await this.#findRoom(guild.id, channelId);
    if (!room) return { ok: false, reason: 'not-a-temp-room' };
    if (room.ownerId !== member.id && !member.permissions?.has?.(PermissionFlagsBits.ManageChannels)) {
      return { ok: false, reason: 'not-owner' };
    }
    const value = Number(limit);
    if (!Number.isInteger(value) || value < 0 || value > 99) return { ok: false, reason: 'invalid-limit' };

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) return { ok: false, reason: 'missing-channel' };
    try {
      await channel.setUserLimit(value, 'Temporary room limit changed');
    } catch (err) {
      return { ok: false, reason: 'discord-rejected' };
    }
    await this.#updateRoom(guild.id, channelId, { userLimit: value });
    return { ok: true, limit: value };
  }

  /** Lock: only the owner and explicitly allowed members may connect. */
  async setLocked({ guild, channelId, member, locked }) {
    const room = await this.#findRoom(guild.id, channelId);
    if (!room) return { ok: false, reason: 'not-a-temp-room' };
    if (room.ownerId !== member.id && !member.permissions?.has?.(PermissionFlagsBits.ManageChannels)) {
      return { ok: false, reason: 'not-owner' };
    }
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) return { ok: false, reason: 'missing-channel' };

    try {
      await channel.permissionOverwrites.edit(guild.roles.everyone.id, {
        Connect: locked ? false : null,
      }, { reason: locked ? 'Temporary room locked' : 'Temporary room unlocked' });
    } catch (err) {
      this.logger.warn('Could not change the lock on a temporary room', {
        channelId,
        reason: err.message,
      });
      return { ok: false, reason: 'discord-rejected' };
    }

    await this.#updateRoom(guild.id, channelId, { locked: Boolean(locked) });
    return { ok: true, locked: Boolean(locked) };
  }

  /** Transfer ownership to another member currently in the room. */
  async transferOwnership({ guild, channelId, member, newOwnerId }) {
    const room = await this.#findRoom(guild.id, channelId);
    if (!room) return { ok: false, reason: 'not-a-temp-room' };
    if (room.ownerId !== member.id && !member.permissions?.has?.(PermissionFlagsBits.ManageChannels)) {
      return { ok: false, reason: 'not-owner' };
    }
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) return { ok: false, reason: 'missing-channel' };

    const target = channel.members?.get?.(newOwnerId);
    if (!target) return { ok: false, reason: 'not-in-room' };

    // The new owner needs the same rights the creator was given, or they will
    // inherit a room they cannot manage.
    try {
      await channel.permissionOverwrites.edit(newOwnerId, {
        ViewChannel: true,
        Connect: true,
        Speak: true,
        ManageChannels: true,
      }, { reason: 'Temporary room ownership transferred' });
    } catch (err) {
      return { ok: false, reason: 'discord-rejected' };
    }

    await this.#updateRoom(guild.id, channelId, {
      ownerId: newOwnerId,
      ownerLabel: target.user?.username ?? null,
    });
    return { ok: true, ownerId: newOwnerId };
  }

  /**
   * Render the room name template.
   * `{user}` is the display name, `{number}` is the owner's room ordinal.
   */
  roomName(template, member, ordinal = 1) {
    const fallback = DEFAULT_TEMPVOICE_CONFIG.roomName;
    const text = typeof template === 'string' && template.trim() ? template : fallback;
    const rendered = renderTemplate(
      text,
      {
        user: member?.displayName ?? member?.user?.username ?? 'member',
        number: ordinal,
      },
      { strict: false, maxLength: 100 },
    );
    // Discord rejects an empty channel name; never let a bad template produce
    // one.
    return rendered.trim() || `Room ${ordinal}`;
  }

  // --- storage -------------------------------------------------------------

  async #findRoom(guildId, channelId) {
    const model = this.models.TemporaryVoice;
    if (!model || !this.isDbReady()) return null;
    return model.findOne({ guildId, channelId }).lean().catch(() => null);
  }

  async #countOwned(guildId, ownerId) {
    const model = this.models.TemporaryVoice;
    if (!model || !this.isDbReady()) return 0;
    return model.countDocuments({ guildId, ownerId }).catch(() => 0);
  }

  async #recordRoom(data) {
    const model = this.models.TemporaryVoice;
    if (!model || !this.isDbReady()) return null;
    try {
      return await model.create({ ...data, lastOccupiedAt: new Date() });
    } catch (err) {
      this.logger.errorFrom(err, 'Could not record a temporary voice room', {
        channelId: data.channelId,
      });
      return null;
    }
  }

  async #updateRoom(guildId, channelId, patch) {
    const model = this.models.TemporaryVoice;
    if (!model || !this.isDbReady()) return null;
    return model.updateOne({ guildId, channelId }, { $set: patch }).catch(() => null);
  }

  async #markOccupied(guildId, channelId) {
    return this.#updateRoom(guildId, channelId, { lastOccupiedAt: new Date() });
  }

  async #removeRoom(guildId, channelId) {
    const model = this.models.TemporaryVoice;
    this.#cancelCleanup(channelId);
    this.#pending.get(guildId)?.delete(channelId);
    if (!model || !this.isDbReady()) return null;
    return model.deleteOne({ guildId, channelId }).catch(() => null);
  }

  /** Rooms the service is currently tracking for one guild. */
  async listRooms(guildId) {
    const model = this.models.TemporaryVoice;
    if (!model || !this.isDbReady()) return [];
    return model.find({ guildId }).lean().catch(() => []);
  }

  /** Drop every timer for a guild (used on guildDelete and in tests). */
  forgetGuild(guildId) {
    for (const channelId of this.#pending.get(guildId) ?? []) this.#cancelCleanup(channelId);
    this.#pending.delete(guildId);
  }

  /** Rooms with a cleanup timer running. Exposed for the health probe. */
  pendingCleanups() {
    return this.#timers.size;
  }
}

export const tempVoiceService = new TempVoiceService();

export default tempVoiceService;
