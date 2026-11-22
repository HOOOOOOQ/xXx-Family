/**
 * src/database/models/GuildSettings.js
 * ---------------------------------------------------------------------------
 * Cross-cutting configuration for one guild: language, module toggles and the
 * feature flags every later phase reads before doing any work.
 *
 * Feature-specific configuration (welcome cards, automod rules, ticket
 * panels…) lives in its own collection per module so a single document never
 * grows unbounded. This document stays small and is cached aggressively.
 */

import mongoose from 'mongoose';

import { LOCALE_CODES, isSupportedLocale } from '../../config/locales.js';

const { Schema } = mongoose;

/** Optional language: `null` means "inherit the bot default". */
const localeOrNull = {
  type: String,
  default: null,
  validate: {
    validator: (value) => value === null || isSupportedLocale(value),
    message: (props) => `"${props.value}" is not a supported locale. Allowed: ${LOCALE_CODES.join(', ')}`,
  },
};

const GuildSettingsSchema = new Schema(
  {
    /** Discord guild snowflake, stored as a string (snowflakes exceed 2^53). */
    guildId: { type: String, required: true, unique: true, index: true, trim: true },
    guildName: { type: String, default: null, trim: true, maxlength: 200 },
    ownerId: { type: String, default: null, trim: true },

    /** Guild default language. `null` = inherit DEFAULT_LANGUAGE. */
    language: localeOrNull,

    /**
     * Per-module on/off switches, e.g. `{ welcome: true, tickets: false }`.
     * A module that has no entry is treated as enabled-by-default.
     */
    moduleToggles: {
      type: Map,
      of: Boolean,
      default: () => new Map(),
    },

    /**
     * Free-form, schema-validated-per-phase feature configuration.
     * Kept as a subdocument placeholder so Phase 2+ can extend it without a
     * breaking migration.
     */
    features: {
      type: Map,
      of: Schema.Types.Mixed,
      default: () => new Map(),
    },

    /** Channels reserved for later phases (logging, announcements…). */
    channels: {
      logs: { type: String, default: null, trim: true },
      announcements: { type: String, default: null, trim: true },
      welcome: { type: String, default: null, trim: true },
    },

    meta: {
      createdBy: { type: String, default: 'system', trim: true },
      lastSyncedAt: { type: Date, default: null },
    },
  },
  {
    timestamps: true,
    versionKey: false,
    minimize: false,
  },
);

GuildSettingsSchema.index({ guildId: 1 }, { unique: true, name: 'uniq_guild' });
GuildSettingsSchema.index({ 'meta.lastSyncedAt': 1 }, { name: 'idx_last_synced' });

/**
 * Plain object form used by the API/dashboard (Map -> object).
 */
GuildSettingsSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    guildId: this.guildId,
    guildName: this.guildName,
    language: this.language,
    moduleToggles: Object.fromEntries(this.moduleToggles ?? []),
    features: Object.fromEntries(this.features ?? []),
    channels: this.channels,
    updatedAt: this.updatedAt,
  };
};

export default mongoose.models.GuildSettings || mongoose.model('GuildSettings', GuildSettingsSchema);
