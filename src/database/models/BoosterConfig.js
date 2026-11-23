/**
 * src/database/models/BoosterConfig.js
 * ---------------------------------------------------------------------------
 * Per-guild booster configuration.
 *
 * Same conventions as WelcomeConfig: a `null` template means "use the
 * localized default", so an unconfigured server still gets messages in its own
 * language, and the template engine (not i18next interpolation) renders them.
 */

import mongoose from 'mongoose';

import { isSupportedLocale, LOCALE_CODES } from '../../config/locales.js';

const { Schema } = mongoose;

const BoosterConfigSchema = new Schema(
  {
    guildId: { type: String, required: true, unique: true, index: true, trim: true },
    enabled: { type: Boolean, default: false },

    /** Where boost announcements go. */
    channelId: { type: String, default: null, trim: true, match: [/^\d{15,25}$/, 'channelId must be a snowflake'] },

    /** Custom templates; null means the localized default. */
    messages: {
      start: { type: String, default: null, trim: true, maxlength: 2000 },
      end: { type: String, default: null, trim: true, maxlength: 2000 },
      milestone: { type: String, default: null, trim: true, maxlength: 2000 },
    },

    embed: {
      enabled: { type: Boolean, default: true },
      color: { type: Number, default: null, min: 0, max: 0xffffff },
      showAvatar: { type: Boolean, default: true },
    },

    /** Role granted while boosting, revoked when the boost ends. */
    role: {
      id: { type: String, default: null, trim: true, match: [/^\d{15,25}$/, null] },
      revokeOnEnd: { type: Boolean, default: true },
    },

    /** Thank the booster in DMs as well. */
    dm: { enabled: { type: Boolean, default: false }, message: { type: String, default: null, trim: true, maxlength: 2000 } },

    /**
     * Milestone rewards: months -> role id. A booster reaching 3 months gets
     * the 3-month role, and keeps it; rewardsClaimed stops double granting.
     */
    rewards: {
      type: [
        {
          _id: false,
          months: { type: Number, required: true, min: 1, max: 240 },
          roleId: { type: String, required: true, trim: true, match: /^\d{15,25}$/ },
          label: { type: String, default: null, trim: true, maxlength: 100 },
        },
      ],
      default: [],
    },

    /** Announce when the server reaches a new boost tier. */
    tierAnnouncements: { type: Boolean, default: true },

    /** Show the booster count in periodic announcements. */
    leaderboard: {
      enabled: { type: Boolean, default: true },
      /** How many rows to show. */
      limit: { type: Number, default: 10, min: 1, max: 25 },
    },

    language: {
      type: String,
      default: null,
      validate: {
        validator: (value) => value === null || isSupportedLocale(value),
        message: (props) => `"${props.value}" is not supported. Allowed: ${LOCALE_CODES.join(', ')}`,
      },
    },

    meta: {
      updatedBy: { type: String, default: null, trim: true },
      totalAnnounced: { type: Number, default: 0, min: 0 },
    },
  },
  { timestamps: true, versionKey: false },
);

BoosterConfigSchema.index({ guildId: 1 }, { unique: true, name: 'uniq_guild' });

BoosterConfigSchema.methods.toEffective = function toEffective() {
  const pick = (value, fallback) => value?.toObject?.() ?? value ?? fallback;
  return {
    guildId: this.guildId,
    enabled: this.enabled,
    channelId: this.channelId ?? null,
    messages: { start: null, end: null, milestone: null, ...pick(this.messages, {}) },
    embed: { enabled: true, color: null, showAvatar: true, ...pick(this.embed, {}) },
    role: { id: null, revokeOnEnd: true, ...pick(this.role, {}) },
    dm: { enabled: false, message: null, ...pick(this.dm, {}) },
    rewards: (this.rewards ?? []).map((r) => ({ months: r.months, roleId: r.roleId, label: r.label ?? null })),
    tierAnnouncements: this.tierAnnouncements ?? true,
    leaderboard: { enabled: true, limit: 10, ...pick(this.leaderboard, {}) },
    language: this.language ?? null,
  };
};

export const DEFAULT_BOOSTER_CONFIG = Object.freeze({
  enabled: false,
  channelId: null,
  messages: { start: null, end: null, milestone: null },
  embed: { enabled: true, color: null, showAvatar: true },
  role: { id: null, revokeOnEnd: true },
  dm: { enabled: false, message: null },
  rewards: [],
  tierAnnouncements: true,
  leaderboard: { enabled: true, limit: 10 },
  language: null,
});

export default mongoose.models.BoosterConfig || mongoose.model('BoosterConfig', BoosterConfigSchema);
