/**
 * src/database/models/TempVoiceConfig.js
 * ---------------------------------------------------------------------------
 * Join-to-create configuration for one guild.
 *
 * A member joins the *trigger* channel and the bot immediately creates a
 * private voice channel for them, moves them into it, and deletes it when the
 * last person leaves. This document holds the trigger and the shape of the
 * rooms it produces.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

export const DEFAULT_TEMPVOICE_CONFIG = Object.freeze({
  enabled: false,
  /** The "join to create" channel. Joining it makes a room. */
  triggerChannelId: null,
  /** New rooms are created under this category. */
  categoryId: null,
  /** Default room name; {user} and {number} are substituted. */
  roomName: "{user}'s room",
  /** Default member limit. 0 means unlimited. */
  userLimit: 0,
  /** Bitrate in bps; null leaves Discord's default. */
  bitrate: null,
  /** Rooms start locked, visible only to their owner. */
  startLocked: false,
  /** Rooms start private (hidden from @everyone). */
  startPrivate: false,
  /** A room is deleted once it has been empty this long, in ms. */
  emptyGraceMs: 60_000,
  /** How many rooms one member may own at once. */
  maxOwnedPerUser: 1,
});

/**
 * Fill a stored document over the defaults.
 *
 * Written out rather than spread because a partial document must never be able
 * to introduce an `undefined` that later reads as "falsy but configured".
 */
export function toEffective(stored) {
  const base = DEFAULT_TEMPVOICE_CONFIG;
  if (!stored) return { ...base };
  return {
    enabled: stored.enabled ?? base.enabled,
    triggerChannelId: stored.triggerChannelId ?? base.triggerChannelId,
    categoryId: stored.categoryId ?? base.categoryId,
    roomName: stored.roomName ?? base.roomName,
    userLimit: Number.isInteger(stored.userLimit) ? stored.userLimit : base.userLimit,
    bitrate: stored.bitrate ?? base.bitrate,
    startLocked: stored.startLocked ?? base.startLocked,
    startPrivate: stored.startPrivate ?? base.startPrivate,
    emptyGraceMs: Number.isFinite(stored.emptyGraceMs) ? stored.emptyGraceMs : base.emptyGraceMs,
    maxOwnedPerUser: Number.isInteger(stored.maxOwnedPerUser) ? stored.maxOwnedPerUser : base.maxOwnedPerUser,
  };
}

const TempVoiceConfigSchema = new Schema(
  {
    guildId: { type: String, required: true, unique: true, index: true, trim: true },
    enabled: { type: Boolean, default: false },
    triggerChannelId: { type: String, default: null, trim: true },
    categoryId: { type: String, default: null, trim: true },
    roomName: {
      type: String,
      default: DEFAULT_TEMPVOICE_CONFIG.roomName,
      trim: true,
      maxlength: 100,
    },
    userLimit: {
      type: Number,
      default: 0,
      min: 0,
      // Discord caps a voice channel at 99 members.
      max: 99,
    },
    bitrate: {
      type: Number,
      default: null,
      // Discord's permitted range.
      min: 8000,
      max: 96000,
    },
    startLocked: { type: Boolean, default: false },
    startPrivate: { type: Boolean, default: false },
    emptyGraceMs: { type: Number, default: 60_000, min: 0, max: 3_600_000 },
    maxOwnedPerUser: { type: Number, default: 1, min: 1, max: 10 },
  },
  { timestamps: true, versionKey: false },
);

export default mongoose.models.TempVoiceConfig || mongoose.model('TempVoiceConfig', TempVoiceConfigSchema);
