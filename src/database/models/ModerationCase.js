/**
 * src/database/models/ModerationCase.js
 * ---------------------------------------------------------------------------
 * One document per moderation action, with a per-guild sequential case number.
 *
 * The case number is what a moderator quotes in an appeal ("case #482"), so it
 * has to be unique *within a guild* and stable. It is allocated with an atomic
 * `findOneAndUpdate(..., $inc)` on a counter document rather than a count of
 * existing cases, because a count races under concurrency and would hand two
 * moderators the same number.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

/** Every action that produces a case. */
export const CASE_TYPES = Object.freeze([
  'ban',
  'unban',
  'kick',
  'timeout',
  'untimeout',
  'warn',
  'purge',
  'slowmode',
  'lock',
  'unlock',
  'quarantine',
  'unquarantine',
  'note',
]);

/** Actions that expire on their own and should be reviewed when they do. */
export const TEMPORARY_TYPES = Object.freeze(['timeout', 'quarantine']);

const ModerationCaseSchema = new Schema(
  {
    guildId: { type: String, required: true, index: true, trim: true },
    /** Sequential per guild — see the module note. */
    caseNumber: { type: Number, required: true, min: 1 },

    type: {
      type: String,
      required: true,
      trim: true,
      enum: CASE_TYPES,
    },

    /** Who was acted on. */
    targetId: { type: String, required: true, index: true, trim: true },
    targetLabel: { type: String, default: null, trim: true, maxlength: 200 },
    /** Who did it — a moderator snowflake, or `automod` / `system`. */
    moderatorId: { type: String, default: null, trim: true },
    moderatorLabel: { type: String, default: null, trim: true, maxlength: 200 },

    reason: { type: String, default: null, trim: true, maxlength: 1000 },

    /** When a temporary action expires. */
    expiresAt: { type: Date, default: null, index: true },
    /** Set when the action was lifted early. */
    revokedAt: { type: Date, default: null },
    revokedById: { type: String, default: null, trim: true },
    revokeReason: { type: String, default: null, trim: true, maxlength: 1000 },

    channelId: { type: String, default: null, trim: true },
    /** Automod rule that produced this case, when applicable. */
    automodRule: { type: String, default: null, trim: true },

    /** Counts, durations, message ids — redacted before it is written. */
    evidence: { type: Schema.Types.Mixed, default: null },

    /** Whether the affected member was notified by DM. */
    dmSent: { type: Boolean, default: false },
    /** The locale the notification was rendered in. */
    locale: { type: String, default: null, trim: true },
  },
  { timestamps: true, versionKey: false },
);

/** The case number must never repeat inside a guild. */
ModerationCaseSchema.index({ guildId: 1, caseNumber: 1 }, { unique: true, name: 'uniq_guild_case' });
/** A member's moderation history. */
ModerationCaseSchema.index({ guildId: 1, targetId: 1, createdAt: -1 }, { name: 'idx_guild_target' });
/** Moderator workload / abuse review. */
ModerationCaseSchema.index({ guildId: 1, moderatorId: 1, createdAt: -1 }, { name: 'idx_guild_moderator' });
/** Finding actions that are due to expire. */
ModerationCaseSchema.index({ guildId: 1, expiresAt: 1 }, { name: 'idx_guild_expires', partialFilterExpression: { expiresAt: { $type: 'date' } } });

ModerationCaseSchema.methods.isActive = function isActive() {
  if (this.revokedAt) return false;
  if (this.expiresAt && this.expiresAt.getTime() <= Date.now()) return false;
  return true;
};

ModerationCaseSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    caseNumber: this.caseNumber,
    type: this.type,
    targetId: this.targetId,
    targetLabel: this.targetLabel,
    moderatorId: this.moderatorId,
    moderatorLabel: this.moderatorLabel,
    reason: this.reason,
    expiresAt: this.expiresAt,
    revokedAt: this.revokedAt,
    active: this.isActive(),
    createdAt: this.createdAt,
  };
};

export default mongoose.models.ModerationCase || mongoose.model('ModerationCase', ModerationCaseSchema);
