/**
 * src/database/models/WelcomeConfig.js
 * ---------------------------------------------------------------------------
 * Everything the welcome system needs, in one small document per guild.
 *
 * Design notes:
 *   - `message`/`embed.description` are **templates** (see utils/templates.js).
 *     `null` means "use the localized default", which is what keeps a fresh
 *     server's welcome message in the server's own language.
 *   - `channelIds` is an array because international servers commonly run one
 *     welcome channel per language.
 *   - Bots are ignored by default: a server full of webhook bots should not
 *     spam its own welcome channel.
 */

import mongoose from 'mongoose';

import { isSupportedLocale, LOCALE_CODES } from '../../config/locales.js';

const { Schema } = mongoose;

/** Shape shared by the welcome and goodbye embed blocks. */
const EmbedConfig = {
  enabled: { type: Boolean, default: true },
  title: { type: String, default: null, trim: true, maxlength: 256 },
  description: { type: String, default: null, trim: true, maxlength: 4096 },
  /** Discord colour integer, or null for the brand purple. */
  color: { type: Number, default: null, min: 0, max: 0xffffff },
  /** Show the member's avatar in the embed thumbnail. */
  showAvatar: { type: Boolean, default: true },
  image: { type: String, default: null, trim: true, maxlength: 500 },
};

const WelcomeConfigSchema = new Schema(
  {
    guildId: { type: String, required: true, unique: true, index: true, trim: true },
    enabled: { type: Boolean, default: false },

    /** One or more channels; the message is sent to each of them. */
    channelIds: {
      type: [{ type: String, trim: true, match: /^\d{15,25}$/ }],
      default: [],
    },

    /** Plain-text template sent above/instead of the embed. Null = localized default. */
    message: { type: String, default: null, trim: true, maxlength: 2000 },
    embed: { type: EmbedConfig, default: () => ({}) },

    /** Generated welcome card (rendered in Phase 5; configuration stored now). */
    card: {
      enabled: { type: Boolean, default: false },
      background: { type: String, default: null, trim: true, maxlength: 500 },
      primaryColor: { type: String, default: '#a855f7', trim: true, maxlength: 9 },
    },

    /** Roles granted on join, in order. Hierarchy is validated at runtime. */
    autoRoles: {
      type: [{ type: String, trim: true, match: /^\d{15,25}$/ }],
      default: [],
    },
    /** Grant auto roles again to a member who rejoins. */
    reapplyRolesOnRejoin: { type: Boolean, default: true },

    dm: {
      enabled: { type: Boolean, default: false },
      message: { type: String, default: null, trim: true, maxlength: 2000 },
    },

    /** Welcome bots too. Off by default. */
    includeBots: { type: Boolean, default: false },

    rejoin: {
      /** Detect a member who left and came back and say "welcome back". */
      detect: { type: Boolean, default: true },
      /** Minutes after leaving that a return still counts as a rejoin. */
      windowMinutes: { type: Number, default: 60, min: 1, max: 43200 },
    },

    milestones: {
      enabled: { type: Boolean, default: true },
      /** Announce every Nth member (100, 200, …). */
      every: { type: Number, default: 100, min: 1, max: 100000 },
    },

    /** Optional per-guild language for welcome messages only. */
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
      lastTriggeredAt: { type: Date, default: null },
      totalSent: { type: Number, default: 0, min: 0 },
    },
  },
  { timestamps: true, versionKey: false },
);

WelcomeConfigSchema.index({ guildId: 1 }, { unique: true, name: 'uniq_guild' });

/**
 * The effective configuration, with defaults filled in.
 * Used by the service so callers never have to null-check nested paths.
 */
WelcomeConfigSchema.methods.toEffective = function toEffective() {
  return {
    guildId: this.guildId,
    enabled: this.enabled,
    channelIds: this.channelIds ?? [],
    message: this.message ?? null,
    embed: { enabled: true, showAvatar: true, title: null, description: null, color: null, image: null, ...(this.embed?.toObject?.() ?? this.embed ?? {}) },
    card: { enabled: false, background: null, primaryColor: '#a855f7', ...(this.card?.toObject?.() ?? this.card ?? {}) },
    autoRoles: this.autoRoles ?? [],
    reapplyRolesOnRejoin: this.reapplyRolesOnRejoin ?? true,
    dm: { enabled: false, message: null, ...(this.dm?.toObject?.() ?? this.dm ?? {}) },
    includeBots: this.includeBots ?? false,
    rejoin: { detect: true, windowMinutes: 60, ...(this.rejoin?.toObject?.() ?? this.rejoin ?? {}) },
    milestones: { enabled: true, every: 100, ...(this.milestones?.toObject?.() ?? this.milestones ?? {}) },
    language: this.language ?? null,
  };
};

/** Configuration used when a guild has no document at all. */
export const DEFAULT_WELCOME_CONFIG = Object.freeze({
  enabled: false,
  channelIds: [],
  message: null,
  embed: { enabled: true, showAvatar: true, title: null, description: null, color: null, image: null },
  card: { enabled: false, background: null, primaryColor: '#a855f7' },
  autoRoles: [],
  reapplyRolesOnRejoin: true,
  dm: { enabled: false, message: null },
  includeBots: false,
  rejoin: { detect: true, windowMinutes: 60 },
  milestones: { enabled: true, every: 100 },
  language: null,
});

export default mongoose.models.WelcomeConfig || mongoose.model('WelcomeConfig', WelcomeConfigSchema);
