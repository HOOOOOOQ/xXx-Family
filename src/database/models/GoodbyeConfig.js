/**
 * src/database/models/GoodbyeConfig.js
 * ---------------------------------------------------------------------------
 * Leave messages. Deliberately smaller than WelcomeConfig: there are no auto
 * roles or cards to configure, but the same template engine and the same
 * "null means use the localized default" rule apply.
 */

import mongoose from 'mongoose';

import { isSupportedLocale, LOCALE_CODES } from '../../config/locales.js';

const { Schema } = mongoose;

const GoodbyeConfigSchema = new Schema(
  {
    guildId: { type: String, required: true, unique: true, index: true, trim: true },
    enabled: { type: Boolean, default: false },

    channelId: { type: String, default: null, trim: true, match: [/^\d{15,25}$/, 'channelId must be a snowflake'] },

    /** Null = the localized default message. */
    message: { type: String, default: null, trim: true, maxlength: 2000 },
    embed: {
      enabled: { type: Boolean, default: true },
      title: { type: String, default: null, trim: true, maxlength: 256 },
      description: { type: String, default: null, trim: true, maxlength: 4096 },
      color: { type: Number, default: null, min: 0, max: 0xffffff },
      showAvatar: { type: Boolean, default: true },
    },

    /**
     * Skip the message for a member who was kicked or banned — most servers do
     * not want "sad to see you go" after a ban.
     */
    skipOnRemoval: { type: Boolean, default: true },
    includeBots: { type: Boolean, default: false },
    /** Report how long the member stayed. */
    showDuration: { type: Boolean, default: true },

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
      totalSent: { type: Number, default: 0, min: 0 },
    },
  },
  { timestamps: true, versionKey: false },
);

GoodbyeConfigSchema.index({ guildId: 1 }, { unique: true, name: 'uniq_guild' });

GoodbyeConfigSchema.methods.toEffective = function toEffective() {
  return {
    guildId: this.guildId,
    enabled: this.enabled,
    channelId: this.channelId ?? null,
    message: this.message ?? null,
    embed: { enabled: true, showAvatar: true, title: null, description: null, color: null, ...(this.embed?.toObject?.() ?? this.embed ?? {}) },
    skipOnRemoval: this.skipOnRemoval ?? true,
    includeBots: this.includeBots ?? false,
    showDuration: this.showDuration ?? true,
    language: this.language ?? null,
  };
};

export const DEFAULT_GOODBYE_CONFIG = Object.freeze({
  enabled: false,
  channelId: null,
  message: null,
  embed: { enabled: true, showAvatar: true, title: null, description: null, color: null },
  skipOnRemoval: true,
  includeBots: false,
  showDuration: true,
  language: null,
});

export default mongoose.models.GoodbyeConfig || mongoose.model('GoodbyeConfig', GoodbyeConfigSchema);
