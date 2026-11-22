/**
 * src/database/models/LanguageOverride.js
 * ---------------------------------------------------------------------------
 * Narrow language overrides, so one channel or one module can speak a
 * different language than the rest of the server — required for international
 * servers that run e.g. `#indonesia` next to `#english`.
 *
 * scope:
 *   - `channel` → every message emitted into that channel uses `language`
 *   - `module`  → every message produced by that module uses `language`
 *   - `role`    → members holding that role are answered in `language`
 */

import mongoose from 'mongoose';

import { LOCALE_CODES, isSupportedLocale } from '../../config/locales.js';

const { Schema } = mongoose;

const LanguageOverrideSchema = new Schema(
  {
    guildId: { type: String, required: true, trim: true },
    scope: { type: String, enum: ['channel', 'module', 'role'], required: true },
    /** Channel / role snowflake, or module name for `scope: 'module'`. */
    scopeId: { type: String, required: true, trim: true },
    module: { type: String, default: null, trim: true, lowercase: true },
    language: {
      type: String,
      required: true,
      validate: {
        validator: isSupportedLocale,
        message: (props) => `"${props.value}" is not a supported locale. Allowed: ${LOCALE_CODES.join(', ')}`,
      },
    },
    priority: { type: Number, default: 0, min: 0, max: 100 },
    enabled: { type: Boolean, default: true },
    createdBy: { type: String, default: null, trim: true },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

LanguageOverrideSchema.index(
  { guildId: 1, scope: 1, scopeId: 1, module: 1 },
  { unique: true, name: 'uniq_override' },
);
LanguageOverrideSchema.index({ guildId: 1, enabled: 1 }, { name: 'idx_guild_enabled' });

LanguageOverrideSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: String(this._id),
    guildId: this.guildId,
    scope: this.scope,
    scopeId: this.scopeId,
    module: this.module,
    language: this.language,
    priority: this.priority,
    enabled: this.enabled,
  };
};

export default mongoose.models.LanguageOverride ||
  mongoose.model('LanguageOverride', LanguageOverrideSchema);
