/**
 * src/database/models/UserSettings.js
 * ---------------------------------------------------------------------------
 * Per-user preferences that follow a member across every server.
 * `language` is the explicit choice made with `/language set`; `null` means
 * "no personal preference — fall back to the resolution chain".
 */

import mongoose from 'mongoose';

import { LOCALE_CODES, isSupportedLocale } from '../../config/locales.js';

const { Schema } = mongoose;

const UserSettingsSchema = new Schema(
  {
    /** Discord user snowflake as a string. */
    userId: { type: String, required: true, unique: true, index: true, trim: true },
    username: { type: String, default: null, trim: true, maxlength: 100 },

    /** Explicit personal language, or null to inherit. */
    language: {
      type: String,
      default: null,
      validate: {
        validator: (value) => value === null || isSupportedLocale(value),
        message: (props) => `"${props.value}" is not a supported locale. Allowed: ${LOCALE_CODES.join(', ')}`,
      },
    },

    preferences: {
      /** Dashboard theme preference: `cyberpunk` | `midnight` | `system`. */
      theme: { type: String, enum: ['cyberpunk', 'midnight', 'system'], default: 'cyberpunk' },
      /** IANA timezone, used by reminders/announcements from Phase 7. */
      timezone: { type: String, default: null, trim: true, maxlength: 64 },
      /** Whether the bot may DM this user (welcome DM, streak reminders…). */
      allowDirectMessages: { type: Boolean, default: true },
      /** Privacy: keep conversation history for the AI assistant. */
      keepAiHistory: { type: Boolean, default: false },
    },

    meta: {
      firstSeenAt: { type: Date, default: Date.now },
      lastSeenAt: { type: Date, default: Date.now },
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

UserSettingsSchema.index({ userId: 1 }, { unique: true, name: 'uniq_user' });
UserSettingsSchema.index({ language: 1 }, { name: 'idx_language' });

UserSettingsSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    userId: this.userId,
    username: this.username,
    language: this.language,
    preferences: this.preferences,
    updatedAt: this.updatedAt,
  };
};

export default mongoose.models.UserSettings || mongoose.model('UserSettings', UserSettingsSchema);
