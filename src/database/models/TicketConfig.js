/**
 * src/database/models/TicketConfig.js
 * ---------------------------------------------------------------------------
 * Ticket panel configuration for one guild: the categories a user can pick
 * from, where tickets are created, and who may see them.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

/** Built-in categories every server starts with. */
export const DEFAULT_TICKET_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'support', labelKey: 'common:tickets.categories.support', emoji: '🛠️' }),
  Object.freeze({ id: 'report', labelKey: 'common:tickets.categories.report', emoji: '🚨' }),
  Object.freeze({ id: 'partner', labelKey: 'common:tickets.categories.partner', emoji: '🤝' }),
]);

export const DEFAULT_TICKET_CONFIG = Object.freeze({
  enabled: false,
  /** The channel the ticket panel is posted in. */
  panelChannelId: null,
  /** Category new tickets are created under. */
  categoryId: null,
  /** Role pinged when a ticket opens. */
  staffRoleId: null,
  /** Channel ticket transcripts are posted to. */
  transcriptChannelId: null,
  /** How many open tickets one member may hold at once. */
  maxOpenPerUser: 1,
  /** Seconds a member must wait between opening tickets. */
  cooldownSeconds: 300,
  /** Categories offered on the panel. */
  categories: DEFAULT_TICKET_CATEGORIES,
  /** Ask for a subject when a ticket opens. */
  requireSubject: true,
});

export function toEffective(stored) {
  const base = DEFAULT_TICKET_CONFIG;
  if (!stored) return { ...base, categories: base.categories.map((c) => ({ ...c })) };
  return {
    enabled: stored.enabled ?? base.enabled,
    panelChannelId: stored.panelChannelId ?? base.panelChannelId,
    categoryId: stored.categoryId ?? base.categoryId,
    staffRoleId: stored.staffRoleId ?? base.staffRoleId,
    transcriptChannelId: stored.transcriptChannelId ?? base.transcriptChannelId,
    maxOpenPerUser: Number.isInteger(stored.maxOpenPerUser) ? stored.maxOpenPerUser : base.maxOpenPerUser,
    cooldownSeconds: Number.isFinite(stored.cooldownSeconds) ? stored.cooldownSeconds : base.cooldownSeconds,
    categories: Array.isArray(stored.categories) && stored.categories.length
      ? stored.categories.map((c) => ({ id: c.id, labelKey: c.labelKey ?? null, label: c.label ?? null, emoji: c.emoji ?? null }))
      : base.categories.map((c) => ({ ...c })),
    requireSubject: stored.requireSubject ?? base.requireSubject,
  };
}

const TicketCategorySchema = new Schema(
  {
    id: { type: String, required: true, trim: true, maxlength: 40 },
    /** Locale key used when no explicit label is set. */
    labelKey: { type: String, default: null, trim: true, maxlength: 120 },
    /** Explicit label, overriding the locale key. */
    label: { type: String, default: null, trim: true, maxlength: 80 },
    emoji: { type: String, default: null, trim: true, maxlength: 32 },
  },
  { _id: false },
);

const TicketConfigSchema = new Schema(
  {
    guildId: { type: String, required: true, unique: true, index: true, trim: true },
    enabled: { type: Boolean, default: false },
    panelChannelId: { type: String, default: null, trim: true },
    categoryId: { type: String, default: null, trim: true },
    staffRoleId: { type: String, default: null, trim: true },
    transcriptChannelId: { type: String, default: null, trim: true },
    maxOpenPerUser: { type: Number, default: 1, min: 1, max: 10 },
    cooldownSeconds: { type: Number, default: 300, min: 0, max: 86_400 },
    categories: {
      type: [TicketCategorySchema],
      default: () => DEFAULT_TICKET_CATEGORIES.map((c) => ({ ...c })),
      validate: {
        validator: (value) => Array.isArray(value) && value.length > 0 && value.length <= 25,
        message: 'A ticket panel needs between 1 and 25 categories',
      },
    },
    requireSubject: { type: Boolean, default: true },
  },
  { timestamps: true, versionKey: false },
);

/** Category ids must be unique within a guild, or the panel is ambiguous. */
TicketConfigSchema.index({ guildId: 1, 'categories.id': 1 }, { name: 'idx_guild_category' });

export default mongoose.models.TicketConfig || mongoose.model('TicketConfig', TicketConfigSchema);
