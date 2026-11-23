/**
 * src/database/models/Counter.js
 * ---------------------------------------------------------------------------
 * Atomic per-scope counters.
 *
 * Used for moderation case numbers, ticket numbers and anonymous submission
 * ids — anywhere a human-visible sequence must be unique and gap-free enough to
 * be quotable.
 *
 * Allocation is a single `findOneAndUpdate(..., $inc)` with `upsert`, which
 * MongoDB applies atomically. Doing this with `countDocuments()` instead would
 * hand two concurrent callers the same number.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

const CounterSchema = new Schema(
  {
    /** What the counter is for, e.g. `moderation-case`. */
    scope: { type: String, required: true, trim: true },
    /** Usually a guild id, so each server counts independently. */
    key: { type: String, required: true, trim: true },
    value: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, versionKey: false },
);

CounterSchema.index({ scope: 1, key: 1 }, { unique: true, name: 'uniq_scope_key' });

/**
 * Allocate the next value for a scope/key pair.
 * @param {string} scope
 * @param {string} key
 * @returns {Promise<number>} the newly allocated number (1-based)
 */
CounterSchema.statics.next = async function next(scope, key) {
  const doc = await this.findOneAndUpdate(
    { scope, key },
    { $inc: { value: 1 }, $setOnInsert: { scope, key } },
    { upsert: true, new: true },
  );
  return doc.value;
};

/** Current value without allocating. */
CounterSchema.statics.peek = async function peek(scope, key) {
  const doc = await this.findOne({ scope, key }).lean();
  return doc?.value ?? 0;
};

export const COUNTER_SCOPES = Object.freeze({
  moderationCase: 'moderation-case',
  ticket: 'ticket',
  submission: 'submission',
});

export default mongoose.models.Counter || mongoose.model('Counter', CounterSchema);
