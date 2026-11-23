/**
 * src/database/models/Ticket.js
 * ---------------------------------------------------------------------------
 * One document per ticket. The number is per-guild and sequential, allocated
 * through the Counter collection so two members opening a ticket at the same
 * moment cannot both get #12.
 *
 * A ticket keeps its transcript inline rather than in a separate collection:
 * the messages belong to exactly one ticket, are only ever read as a whole,
 * and a separate collection would need its own lifecycle to stay in step.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

export const TICKET_STATUSES = Object.freeze(['open', 'claimed', 'closed']);

export const TICKET_PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);

const TicketMessageSchema = new Schema(
  {
    authorId: { type: String, required: true, trim: true },
    authorLabel: { type: String, default: null, trim: true, maxlength: 200 },
    /** Whether the author was staff when they wrote it. */
    isStaff: { type: Boolean, default: false },
    content: { type: String, default: null, trim: true, maxlength: 4000 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const TicketSchema = new Schema(
  {
    guildId: { type: String, required: true, index: true, trim: true },
    /** Sequential within the guild — what people quote in conversation. */
    number: { type: Number, required: true, min: 1 },
    channelId: { type: String, default: null, index: true, trim: true },

    openerId: { type: String, required: true, index: true, trim: true },
    openerLabel: { type: String, default: null, trim: true, maxlength: 200 },

    categoryId: { type: String, default: 'support', trim: true, maxlength: 40 },
    subject: { type: String, default: null, trim: true, maxlength: 200 },

    status: { type: String, default: 'open', enum: TICKET_STATUSES, index: true },
    priority: { type: String, default: 'normal', enum: TICKET_PRIORITIES },

    /** Who is handling it. */
    claimedById: { type: String, default: null, trim: true },
    claimedAt: { type: Date, default: null },

    closedAt: { type: Date, default: null },
    closedById: { type: String, default: null, trim: true },
    closeReason: { type: String, default: null, trim: true, maxlength: 1000 },

    /** 1-5 once the opener rates the outcome. */
    rating: { type: Number, default: null, min: 1, max: 5 },
    ratingComment: { type: String, default: null, trim: true, maxlength: 1000 },

    messages: { type: [TicketMessageSchema], default: [] },

    /** Members added to the ticket beyond the opener and staff. */
    participantIds: { type: [String], default: [] },

    locale: { type: String, default: null, trim: true },
  },
  { timestamps: true, versionKey: false },
);

TicketSchema.index({ guildId: 1, number: 1 }, { unique: true, name: 'uniq_guild_number' });
/** "How many open tickets does this member have?" */
TicketSchema.index({ guildId: 1, openerId: 1, status: 1 }, { name: 'idx_guild_opener_status' });
/** Staff queue: oldest open ticket first. */
TicketSchema.index({ guildId: 1, status: 1, createdAt: 1 }, { name: 'idx_guild_status_time' });

TicketSchema.methods.isOpen = function isOpen() {
  return this.status === 'open' || this.status === 'claimed';
};

TicketSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    number: this.number,
    status: this.status,
    priority: this.priority,
    categoryId: this.categoryId,
    subject: this.subject,
    openerId: this.openerId,
    openerLabel: this.openerLabel,
    claimedById: this.claimedById,
    rating: this.rating,
    createdAt: this.createdAt,
    closedAt: this.closedAt,
  };
};

export default mongoose.models.Ticket || mongoose.model('Ticket', TicketSchema);
