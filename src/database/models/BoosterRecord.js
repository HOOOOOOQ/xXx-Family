/**
 * src/database/models/BoosterRecord.js
 * ---------------------------------------------------------------------------
 * One document per member per guild that has ever boosted.
 *
 * Discord exposes `premiumSince` on a member but keeps no history: the moment
 * someone stops boosting, the information is gone. This collection is what
 * makes "boosted for 8 months" and the booster leaderboard possible at all.
 *
 * `current: true` marks an active booster; `until` is set when they stop. The
 * document is never deleted, so the history survives.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

const BoosterRecordSchema = new Schema(
  {
    guildId: { type: String, required: true, index: true, trim: true },
    userId: { type: String, required: true, index: true, trim: true },
    username: { type: String, default: null, trim: true, maxlength: 200 },

    /** When this boost streak started. */
    since: { type: Date, required: true },
    /** Null while still boosting. */
    until: { type: Date, default: null },
    current: { type: Boolean, default: true, index: true },

    /**
     * Total months across every streak. Updated when a streak ends, because
     * that is the only moment the final length is known for certain.
     */
    totalMonths: { type: Number, default: 0, min: 0 },

    /** How many separate boost streaks this member has had here. */
    streaks: { type: Number, default: 1, min: 1 },

    /**
     * Rewards already handed out, keyed by month threshold. Prevents the same
     * milestone reward being granted twice after a re-boost.
     */
    rewardsClaimed: {
      type: [Number],
      default: [],
    },

    meta: {
      lastSeenAt: { type: Date, default: null },
      notifiedStart: { type: Boolean, default: false },
      notifiedEnd: { type: Boolean, default: false },
    },
  },
  { timestamps: true, versionKey: false },
);

/** A member can only have one live record per guild. */
BoosterRecordSchema.index({ guildId: 1, userId: 1 }, { unique: true, name: 'uniq_guild_user' });
/** Leaderboard: current boosters, longest first. */
BoosterRecordSchema.index({ guildId: 1, current: 1, since: 1 }, { name: 'idx_leaderboard' });
/** History: one member's streaks over time. */
BoosterRecordSchema.index({ guildId: 1, userId: 1, since: -1 }, { name: 'idx_history' });

/**
 * Whole months between two dates, floored.
 *
 * `null`/`undefined` must yield 0, not 692: `new Date(null)` is the Unix epoch,
 * which is a perfectly valid timestamp as far as Date is concerned, so the
 * guard has to come before the conversion.
 */
export function monthsBetween(from, to = new Date()) {
  if (from === null || from === undefined || from === '') return 0;
  const start = new Date(from).getTime();
  const end = to === null || to === undefined ? Date.now() : new Date(to).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.floor((end - start) / (30 * 24 * 60 * 60 * 1000));
}

BoosterRecordSchema.methods.monthsBoosted = function monthsBoosted() {
  return monthsBetween(this.since, this.until ?? new Date());
};

BoosterRecordSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    userId: this.userId,
    username: this.username,
    since: this.since,
    until: this.until,
    current: this.current,
    months: this.monthsBoosted(),
    totalMonths: this.totalMonths,
    streaks: this.streaks,
  };
};

export default mongoose.models.BoosterRecord || mongoose.model('BoosterRecord', BoosterRecordSchema);
