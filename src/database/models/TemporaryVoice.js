/**
 * src/database/models/TemporaryVoice.js
 * ---------------------------------------------------------------------------
 * One document per live temporary voice room.
 *
 * This exists so the bot knows which channels it owns. Without it, a restart
 * would orphan every room the bot had created — they would linger forever with
 * nobody to clean them up, which is the single most common complaint about
 * join-to-create bots.
 *
 * On boot the service reconciles this collection against the guild's real
 * channels and deletes the rooms Discord no longer has.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

const TemporaryVoiceSchema = new Schema(
  {
    guildId: { type: String, required: true, index: true, trim: true },
    channelId: { type: String, required: true, index: true, trim: true },
    categoryId: { type: String, default: null, trim: true },
    /** The member who created the room by joining the trigger. */
    ownerId: { type: String, required: true, index: true, trim: true },
    ownerLabel: { type: String, default: null, trim: true, maxlength: 200 },
    name: { type: String, default: null, trim: true, maxlength: 100 },

    locked: { type: Boolean, default: false },
    isPrivate: { type: Boolean, default: false },
    userLimit: { type: Number, default: 0, min: 0, max: 99 },

    /** When the room last held anyone. Used for the empty grace period. */
    lastOccupiedAt: { type: Date, default: Date.now },
    /** Members explicitly allowed in while the room is private. */
    allowedUserIds: { type: [String], default: [] },

    /** Set once cleanup has started, so two reconciles cannot both delete it. */
    deleting: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false },
);

TemporaryVoiceSchema.index({ guildId: 1, channelId: 1 }, { unique: true, name: 'uniq_guild_channel' });
/** "How many rooms does this member own?" — enforced against maxOwnedPerUser. */
TemporaryVoiceSchema.index({ guildId: 1, ownerId: 1 }, { name: 'idx_guild_owner' });
/** Reconciliation on boot and the empty-room sweep. */
TemporaryVoiceSchema.index({ guildId: 1, lastOccupiedAt: 1 }, { name: 'idx_guild_occupied' });

export default mongoose.models.TemporaryVoice || mongoose.model('TemporaryVoice', TemporaryVoiceSchema);
