/**
 * src/database/models/AuditLog.js
 * ---------------------------------------------------------------------------
 * Searchable, retention-bounded record of everything the bot did or observed.
 *
 * Two separate outputs live behind one service:
 *   1. the **log channel** embed a moderator reads in Discord
 *   2. this **audit record**, which is what `/moderation history` and the
 *      dashboard's Audit Logs page query later
 *
 * Retention is enforced by MongoDB itself through a TTL index, so old records
 * cannot accumulate forever on a free Atlas tier.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

/** Event categories. Kept as a plain list so the dashboard can enumerate it. */
export const AUDIT_TYPES = Object.freeze([
  // members
  'member.join',
  'member.leave',
  'member.ban',
  'member.unban',
  'member.kick',
  'member.timeout',
  'member.timeout.remove',
  'member.warn',
  'member.role.add',
  'member.role.remove',
  'member.nickname',
  // messages
  'message.delete',
  'message.edit',
  'message.purge',
  // channels
  'channel.create',
  'channel.delete',
  'channel.lock',
  'channel.unlock',
  'channel.slowmode',
  // voice
  'voice.join',
  'voice.leave',
  'voice.create',
  'voice.delete',
  // booster
  'booster.start',
  'booster.end',
  // automation
  'automod.action',
  'ticket.action',
  'invite.create',
  'invite.delete',
  // system
  'command.use',
  'config.change',
  'dashboard.action',
  'system.error',
  'system.start',
  'system.stop',
]);

const AuditLogSchema = new Schema(
  {
    guildId: { type: String, required: true, index: true, trim: true },
    /** One of AUDIT_TYPES. Stored as a free string so later phases can add types
     *  without a migration, but validated against the known list by default. */
    type: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator: (value) => AUDIT_TYPES.includes(value),
        message: (props) => `"${props.value}" is not a known audit type`,
      },
    },

    /** Who caused it — a user snowflake, or `bot`/`system`. */
    actorId: { type: String, default: null, trim: true },
    actorLabel: { type: String, default: null, trim: true, maxlength: 200 },
    /** Who it happened to. */
    targetId: { type: String, default: null, trim: true },
    targetLabel: { type: String, default: null, trim: true, maxlength: 200 },

    channelId: { type: String, default: null, trim: true },
    /** Moderation case number, when the entry belongs to a case (Phase 3). */
    caseId: { type: String, default: null, trim: true },

    reason: { type: String, default: null, trim: true, maxlength: 1000 },
    /**
     * Structured evidence (message content, before/after values, counts).
     * Callers must not put credentials in here — the redactor covers logs, not
     * the database, so this is a documented contract.
     */
    evidence: { type: Schema.Types.Mixed, default: null },

    /** Locale the log embed was rendered in, for auditability. */
    locale: { type: String, default: null, trim: true },
    /** Whether the Discord embed was actually delivered. */
    delivered: { type: Boolean, default: false },
    deliveryError: { type: String, default: null, trim: true, maxlength: 500 },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

/** Search paths used by the moderation history and dashboard queries. */
AuditLogSchema.index({ guildId: 1, createdAt: -1 }, { name: 'idx_guild_time' });
AuditLogSchema.index({ guildId: 1, type: 1, createdAt: -1 }, { name: 'idx_guild_type_time' });
AuditLogSchema.index({ guildId: 1, targetId: 1, createdAt: -1 }, { name: 'idx_guild_target_time' });
AuditLogSchema.index({ guildId: 1, actorId: 1, createdAt: -1 }, { name: 'idx_guild_actor_time' });

/**
 * Retention: documents expire 90 days after creation. MongoDB deletes them in
 * the background — no cron job, no cleanup script, works on the free tier.
 */
AuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60, name: 'ttl_created_at' });

AuditLogSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: String(this._id),
    guildId: this.guildId,
    type: this.type,
    actorId: this.actorId,
    actorLabel: this.actorLabel,
    targetId: this.targetId,
    targetLabel: this.targetLabel,
    channelId: this.channelId,
    caseId: this.caseId,
    reason: this.reason,
    locale: this.locale,
    delivered: this.delivered,
    createdAt: this.createdAt,
  };
};

export default mongoose.models.AuditLog || mongoose.model('AuditLog', AuditLogSchema);
