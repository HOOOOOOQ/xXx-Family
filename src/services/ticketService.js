/**
 * src/services/ticketService.js
 * ---------------------------------------------------------------------------
 * The ticket lifecycle: open → claim → close, with a transcript.
 *
 * A ticket is a real Discord channel, so most of the work here is keeping two
 * things in agreement: the channel Discord has, and the record in MongoDB.
 * Every method that touches one touches the other, and the ones that can fail
 * are ordered so the database is never left claiming a channel exists when it
 * does not.
 *
 * The transcript is built from the recorded messages rather than from Discord's
 * API, because a closed ticket's channel is deleted — if the transcript depended
 * on the channel, closing a ticket would destroy its own record.
 */

import { ChannelType, PermissionFlagsBits } from 'discord.js';

import { DatabaseError, ValidationError, NotFoundError } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';
import { redact } from '../utils/redact.js';
import { toEffective, DEFAULT_TICKET_CONFIG } from '../database/models/TicketConfig.js';
import { COUNTER_SCOPES } from '../database/models/Counter.js';

/** How long a closing ticket stays visible before its channel is removed. */
export const CLOSE_DELAY_MS = 5000;

export class TicketService {
  /**
   * channelId -> guildId, for every ticket this process knows about.
   *
   * Kept so `isTicketChannel` can answer from memory. It is a cache, not the
   * source of truth: the record in Mongo is. It is filled when a ticket opens,
   * when a ticket is looked up, and wholesale when `reconcile` runs at boot.
   */
  #knownChannels = new Map();

  /**
   * @param {object} [deps]
   * @param {object} [deps.models] TicketConfig / Ticket / Counter
   * @param {() => boolean} [deps.isDbReady]
   * @param {(id:string) => Promise<object|null>} [deps.resolveChannel]
   */
  constructor(deps = {}) {
    this.models = deps.models ?? {};
    this.isDbReady = deps.isDbReady ?? (() => true);
    this.resolveChannel = deps.resolveChannel ?? (async () => null);
    this.logger = (deps.logger ?? getLogger()).child('tickets');
    this.metrics = deps.metrics ?? null;
    this.localeService = deps.localeService ?? null;
  }

  /** @returns {Promise<object>} the effective config for a guild */
  async getConfig(guildId) {
    const model = this.models.TicketConfig;
    if (!model || !this.isDbReady()) return toEffective(null);
    const doc = await model.findOne({ guildId }).lean().catch((err) => {
      this.logger.errorFrom(err, 'Could not read the ticket config', { guildId });
      return null;
    });
    return toEffective(doc);
  }

  /** @throws {DatabaseError} without a database */
  async saveConfig(guildId, patch) {
    const model = this.models.TicketConfig;
    if (!model || !this.isDbReady()) {
      throw new DatabaseError('Ticket settings cannot be saved while the database is offline', {
        i18nKey: 'errors:database',
      });
    }
    await model.findOneAndUpdate(
      { guildId },
      { $set: patch, $setOnInsert: { guildId } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return this.getConfig(guildId);
  }

  /**
   * Check whether a member may open a ticket right now.
   *
   * Done as its own step so the command can explain *why* before creating
   * anything — creating a channel and then refusing is the worst of both.
   *
   * @returns {Promise<{ allowed:boolean, reason?:string, seconds?:number }>}
   */
  async canOpen(guildId, userId) {
    const config = await this.getConfig(guildId);
    if (!config.enabled) return { allowed: false, reason: 'disabled' };

    const model = this.models.Ticket;
    if (!model || !this.isDbReady()) return { allowed: false, reason: 'database' };

    const openCount = await model
      .countDocuments({ guildId, openerId: userId, status: { $in: ['open', 'claimed'] } })
      .catch(() => 0);
    if (openCount >= config.maxOpenPerUser) {
      return { allowed: false, reason: 'max-open', count: openCount };
    }

    if (config.cooldownSeconds > 0) {
      const latest = await model
        .findOne({ guildId, openerId: userId })
        .sort({ createdAt: -1 })
        .lean()
        .catch(() => null);
      if (latest?.createdAt) {
        const elapsed = (Date.now() - new Date(latest.createdAt).getTime()) / 1000;
        if (elapsed < config.cooldownSeconds) {
          return { allowed: false, reason: 'cooldown', seconds: Math.ceil(config.cooldownSeconds - elapsed) };
        }
      }
    }

    return { allowed: true, config };
  }

  /**
   * Open a ticket: create the channel, record it, and post the opener.
   *
   * @returns {Promise<{ ok:boolean, ticket?:object, reason?:string }>}
   */
  async open({ guild, member, categoryId = 'support', subject = null, locale = null }) {
    const gate = await this.canOpen(guild.id, member.id);
    if (!gate.allowed) return { ok: false, reason: gate.reason, seconds: gate.seconds };

    const config = gate.config;
    const category = config.categories.find((c) => c.id === categoryId) ?? config.categories[0];
    if (!category) {
      return { ok: false, reason: 'no-categories' };
    }

    const number = await this.#nextNumber(guild.id);
    const name = `ticket-${number}`;

    let channel;
    try {
      channel = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: config.categoryId ?? undefined,
        topic: subject ? String(subject).slice(0, 200) : undefined,
        permissionOverwrites: [
          // The opener can see their own ticket.
          { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          // Staff can see every ticket.
          ...(config.staffRoleId
            ? [{ id: config.staffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }]
            : []),
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        ],
      });
    } catch (err) {
      this.logger.errorFrom(err, 'Could not create a ticket channel', { guildId: guild.id });
      return { ok: false, reason: 'channel-failed' };
    }

    let ticket;
    try {
      ticket = await this.#recordTicket({
        guildId: guild.id,
        number,
        channelId: channel.id,
        openerId: member.id,
        openerLabel: member.user?.username ?? null,
        categoryId: category.id,
        subject: subject ? String(subject).slice(0, 200) : null,
        locale,
      });
    } catch (err) {
      // The channel exists but there is no record of it. Delete it rather than
      // leaving an untracked channel that nobody can close through the bot.
      this.logger.errorFrom(err, 'Could not record a ticket — deleting its channel', {
        guildId: guild.id,
        number,
      });
      await channel.delete('Ticket record could not be saved').catch(() => null);
      return { ok: false, reason: 'record-failed' };
    }

    this.#knownChannels.set(channel.id, guild.id);

    const greeting = await this.#greeting({ guild, member, ticket, config, category, locale });
    try {
      await channel.send(greeting);
    } catch (err) {
      // The ticket still works; only the greeting is missing.
      this.logger.warn('Could not post the ticket greeting', { channelId: channel.id, reason: err.message });
    }

    if (config.staffRoleId) {
      await this.#notifyStaff(channel, config, member, ticket, locale);
    }

    this.metrics?.increment('tickets.opened');
    return { ok: true, ticket, channel, category };
  }

  /** Claim a ticket so two staff do not both answer it. */
  async claim({ guildId, channelId, moderator }) {
    const ticket = await this.#findByChannel(guildId, channelId);
    if (!ticket) throw new NotFoundError('This channel is not a ticket', { i18nKey: 'errors:notFound' });
    if (ticket.status === 'closed') return { ok: false, reason: 'closed' };
    if (ticket.claimedById === moderator.id) return { ok: false, reason: 'already-yours' };

    // findOneAndUpdate with a status guard makes the claim atomic: if two staff
    // click at once, exactly one wins instead of both thinking they own it.
    const updated = await this.#atomicUpdate(
      { guildId, channelId, status: { $ne: 'closed' }, claimedById: null },
      { $set: { claimedById: moderator.id, claimedAt: new Date(), status: 'claimed' } },
    );
    if (!updated) return { ok: false, reason: 'already-claimed' };

    this.metrics?.increment('tickets.claimed');
    return { ok: true, ticket: updated };
  }

  /**
   * Close a ticket, write its transcript, then delete the channel.
   *
   * @param {object} [options.deleteChannel] default true
   */
  async close({ guild, channelId, closedBy, reason = null, deleteChannel = true, locale = null }) {
    const ticket = await this.#findByChannel(guild.id, channelId);
    if (!ticket) throw new NotFoundError('This channel is not a ticket', { i18nKey: 'errors:notFound' });
    if (ticket.status === 'closed') return { ok: false, reason: 'already-closed' };

    // Claim it first so a second close cannot race and produce two transcripts.
    const updated = await this.#atomicUpdate(
      { guildId: guild.id, channelId, status: { $ne: 'closed' } },
      {
        $set: {
          status: 'closed',
          closedAt: new Date(),
          closedById: closedBy?.id ?? null,
          closeReason: reason ? String(reason).slice(0, 1000) : null,
        },
      },
    );
    if (!updated) return { ok: false, reason: 'already-closed' };

    const transcript = this.buildTranscript(updated, locale);

    const channel = await this.resolveChannel(channelId).catch(() => null);
    if (channel?.send) {
      await channel.send(transcript.closing).catch((err) => {
        this.logger.warn('Could not post the closing message', { channelId, reason: err.message });
      });
    }

    const posted = await this.#postTranscript(guild, updated, transcript);
    if (posted) {
      await this.#update(updated.guildId, updated.number, { transcriptPostedAt: new Date() });
    }

    if (deleteChannel && channel?.delete) {
      // A short delay so the closing message is actually seen before the
      // channel disappears.
      setTimeout(() => {
        channel.delete('Ticket closed').catch((err) => {
          this.logger.warn('Could not delete a closed ticket channel', {
            channelId,
            reason: err.message,
          });
        });
      }, CLOSE_DELAY_MS).unref?.();
    }

    // The transcript is complete; any later message in the channel is not part
    // of it, so stop spending a lookup on this channel.
    this.#knownChannels.delete(channelId);

    this.metrics?.increment('tickets.closed');
    return { ok: true, ticket: updated, transcript, transcriptPosted: posted };
  }

  /** Record a rating once the ticket is closed. */
  async rate({ guildId, channelId, userId, rating, comment = null }) {
    const value = Number(rating);
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new ValidationError('The rating must be between 1 and 5', {
        i18nKey: 'errors:validation',
        details: { reason: 'rating must be 1-5' },
      });
    }

    const ticket = await this.#findByChannel(guildId, channelId);
    if (!ticket) throw new NotFoundError('This channel is not a ticket', { i18nKey: 'errors:notFound' });
    // Only the person who opened it can judge how it went.
    if (ticket.openerId !== userId) return { ok: false, reason: 'not-opener' };
    if (ticket.rating) return { ok: false, reason: 'already-rated' };

    const updated = await this.#atomicUpdate(
      { guildId, channelId, openerId: userId, rating: null },
      { $set: { rating: value, ratingComment: comment ? String(comment).slice(0, 1000) : null } },
    );
    if (!updated) return { ok: false, reason: 'already-rated' };

    this.metrics?.increment('tickets.rated');
    return { ok: true, rating: value };
  }

  /**
   * Whether a channel is a known ticket, checked without touching the database.
   *
   * messageCreate is the hottest path in the bot. Transcripts have to be
   * recorded there, but a Mongo round trip per guild message just to discover
   * it is not inside a ticket is not acceptable. This set makes the common case
   * a hash lookup, and is repopulated on boot by `reconcile`.
   */
  isTicketChannel(channelId) {
    return this.#knownChannels.has(channelId);
  }

  /** Number of ticket channels currently tracked in memory. */
  trackedChannels() {
    return this.#knownChannels.size;
  }

  /** Append a message to the transcript. */
  async recordMessage({ guildId, channelId, message, isStaff = false }) {
    const ticket = await this.#findByChannel(guildId, channelId);
    if (!ticket || ticket.status === 'closed') return null;
    if (message.author?.bot) return null;

    const content = message.content ? String(message.content).slice(0, 4000) : null;
    if (!content) return null;

    return this.#pushMessage(guildId, ticket.number, {
      authorId: message.author.id,
      authorLabel: message.author.username ?? null,
      isStaff: Boolean(isStaff),
      // The transcript is a stored record, so it gets the same scrubbing the
      // audit log does.
      content: redact(content),
      createdAt: new Date(),
    });
  }

  /** Add a member to a ticket. */
  async addParticipant({ guild, channelId, actor, target }) {
    const ticket = await this.#findByChannel(guild.id, channelId);
    if (!ticket) throw new NotFoundError('This channel is not a ticket', { i18nKey: 'errors:notFound' });
    if (ticket.status === 'closed') return { ok: false, reason: 'closed' };

    const channel = await this.resolveChannel(channelId).catch(() => null);
    if (!channel) return { ok: false, reason: 'missing-channel' };

    try {
      await channel.permissionOverwrites.edit(target.id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      }, { reason: `Added to ticket #${ticket.number} by ${actor?.user?.username ?? 'staff'}` });
    } catch (err) {
      return { ok: false, reason: 'discord-rejected' };
    }

    await this.#update(guild.id, ticket.number, { $addToSet: { participantIds: target.id } });
    return { ok: true };
  }

  /** Change the priority. Staff only. */
  async setPriority({ guildId, channelId, priority }) {
    const allowed = ['low', 'normal', 'high', 'urgent'];
    if (!allowed.includes(priority)) {
      throw new ValidationError(`Unknown priority "${priority}"`, {
        i18nKey: 'errors:validation',
        details: { reason: priority },
      });
    }
    const ticket = await this.#findByChannel(guildId, channelId);
    if (!ticket) throw new NotFoundError('This channel is not a ticket', { i18nKey: 'errors:notFound' });
    if (ticket.status === 'closed') return { ok: false, reason: 'closed' };

    await this.#update(guildId, ticket.number, { $set: { priority } });
    return { ok: true, priority };
  }

  /**
   * Build the transcript payload for a ticket.
   *
   * Returned rather than sent, so it can be unit-tested and reused by the
   * dashboard without a Discord connection.
   */
  buildTranscript(ticket, locale = null) {
    const messages = Array.isArray(ticket.messages) ? ticket.messages : [];
    const lines = messages.map((m) => {
      const when = m.createdAt ? new Date(m.createdAt).toISOString() : '';
      const who = m.authorLabel ?? m.authorId;
      const tag = m.isStaff ? ' [staff]' : '';
      return `[${when}] ${who}${tag}: ${m.content ?? ''}`;
    });

    return {
      number: ticket.number,
      guildId: ticket.guildId,
      opener: ticket.openerLabel ?? ticket.openerId,
      category: ticket.categoryId,
      subject: ticket.subject ?? null,
      status: ticket.status,
      claimedBy: ticket.claimedById,
      rating: ticket.rating ?? null,
      createdAt: ticket.createdAt,
      closedAt: ticket.closedAt,
      messageCount: messages.length,
      text: lines.join('\n'),
      locale: locale ?? ticket.locale ?? null,
      closing: null,
    };
  }

  /** The staff-facing queue: open tickets, oldest first. */
  async listOpen(guildId, { limit = 25 } = {}) {
    const model = this.models.Ticket;
    if (!model || !this.isDbReady()) return [];
    return model
      .find({ guildId, status: { $in: ['open', 'claimed'] } })
      .sort({ createdAt: 1 })
      .limit(Math.min(Math.max(1, Number(limit) || 25), 100))
      .lean()
      .catch(() => []);
  }

  /** Aggregate numbers for /ticket stats. */
  async getStats(guildId) {
    const model = this.models.Ticket;
    if (!model || !this.isDbReady()) {
      return { total: 0, open: 0, claimed: 0, closed: 0, rated: 0, averageRating: null };
    }

    const [total, open, claimed, closed, ratedRows] = await Promise.all([
      model.countDocuments({ guildId }).catch(() => 0),
      model.countDocuments({ guildId, status: 'open' }).catch(() => 0),
      model.countDocuments({ guildId, status: 'claimed' }).catch(() => 0),
      model.countDocuments({ guildId, status: 'closed' }).catch(() => 0),
      model.find({ guildId, rating: { $ne: null } }).select('rating').lean().catch(() => []),
    ]);

    const ratings = ratedRows.map((r) => r.rating).filter((n) => Number.isFinite(n));
    const averageRating = ratings.length
      ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
      : null;

    return { total, open, claimed, closed, rated: ratings.length, averageRating };
  }

  /** Look a ticket up by its number. */
  async findByNumber(guildId, number) {
    const model = this.models.Ticket;
    if (!model || !this.isDbReady()) return null;
    return model.findOne({ guildId, number: Number(number) }).lean().catch(() => null);
  }

  /** Reconcile after a restart: drop records whose channel is gone. */
  async reconcile(guild) {
    const model = this.models.Ticket;
    if (!model || !this.isDbReady() || !guild) return { stale: 0 };

    const rows = await model
      .find({ guildId: guild.id, status: { $in: ['open', 'claimed'] } })
      .select('number channelId')
      .lean()
      .catch(() => []);

    let stale = 0;
    for (const row of rows) {
      if (!row.channelId) continue;
      const channel = await guild.channels.fetch(row.channelId).catch(() => null);
      if (!channel) {
        // The channel is gone, so the ticket cannot be worked. Closing it keeps
        // the record instead of leaving a ticket stuck open forever.
        await model.updateOne(
          { guildId: guild.id, number: row.number },
          { $set: { status: 'closed', closedAt: new Date(), closeReason: 'channel-missing' } },
        );
        this.#knownChannels.delete(row.channelId);
        stale += 1;
      } else {
        // Repopulating here is what lets messageCreate record transcripts after
        // a restart without a database read per message.
        this.#knownChannels.set(row.channelId, guild.id);
      }
    }

    if (stale) this.logger.info('Tickets reconciled', { guildId: guild.id, stale });
    return { stale };
  }

  /** Drop all cached channels for a guild (leaving the guild, or a reset). */
  forgetGuild(guildId) {
    let removed = 0;
    for (const [channelId, id] of this.#knownChannels) {
      if (id === guildId) {
        this.#knownChannels.delete(channelId);
        removed += 1;
      }
    }
    return removed;
  }

  // --- internals -----------------------------------------------------------

  async #nextNumber(guildId) {
    const Counter = this.models.Counter;
    if (!Counter || !this.isDbReady()) {
      // Without an atomic counter, fall back to a timestamp-based number. Two
      // tickets in the same millisecond are extremely unlikely, and a wrong
      // number is better than refusing to open a ticket at all.
      this.logger.warn('Counter unavailable — using a fallback ticket number', { guildId });
      return Date.now() % 1_000_000;
    }
    return Counter.next(COUNTER_SCOPES.ticket, guildId);
  }

  async #recordTicket(data) {
    const model = this.models.Ticket;
    if (!model || !this.isDbReady()) {
      throw new DatabaseError('Tickets cannot be created while the database is offline', {
        i18nKey: 'errors:database',
      });
    }
    return model.create(data);
  }

  async #findByChannel(guildId, channelId) {
    const model = this.models.Ticket;
    if (!model || !this.isDbReady()) return null;
    const row = await model.findOne({ guildId, channelId }).lean().catch(() => null);
    if (row) this.#knownChannels.set(channelId, guildId);
    return row;
  }

  /**
   * Update only if the filter still matches, returning the new document.
   * Used for claim/close/rate so two concurrent callers cannot both succeed.
   */
  async #atomicUpdate(filter, update) {
    const model = this.models.Ticket;
    if (!model || !this.isDbReady()) return null;
    return model.findOneAndUpdate(filter, update, { new: true }).catch((err) => {
      this.logger.errorFrom(err, 'Ticket update failed', { filter: redact(filter) });
      return null;
    });
  }

  async #update(guildId, number, update) {
    const model = this.models.Ticket;
    if (!model || !this.isDbReady()) return null;
    return model.updateOne({ guildId, number }, update).catch(() => null);
  }

  async #pushMessage(guildId, number, entry) {
    return this.#update(guildId, number, { $push: { messages: entry } });
  }

  async #greeting({ guild, member, ticket, config, category, locale }) {
    const ctx = await this.#locale(guild.id, locale);
    const t = ctx.t;
    const label = this.categoryLabel(category, t);
    const staffPing = config.staffRoleId ? `<@&${config.staffRoleId}>` : '';
    return {
      content: staffPing || undefined,
      embeds: [
        {
          color: 0x7c3aed,
          title: `${category.emoji ?? '🎫'} ${t('common:tickets.panel.title')} #${ticket.number}`,
          description: t('common:tickets.panel.opened', {
            user: `<@${member.id}>`,
            category: label,
          }),
          fields: ticket.subject
            ? [{ name: t('common:tickets.panel.subject'), value: String(ticket.subject), inline: false }]
            : [],
          footer: { text: t('common:tickets.panel.hint') },
          timestamp: new Date().toISOString(),
        },
      ],
    };
  }

  async #notifyStaff(channel, config, member, ticket, locale) {
    if (!config.staffRoleId) return;
    const ctx = await this.#locale(channel.guild?.id, locale);
    try {
      await channel.send({
        content: `<@&${config.staffRoleId}> — ${ctx.t('common:tickets.panel.staffNotice', {
          user: member.user?.username ?? member.id,
          number: String(ticket.number),
        })}`,
      });
    } catch (err) {
      this.logger.warn('Could not notify staff about a new ticket', { reason: err.message });
    }
  }

  /** Post the transcript to the configured channel. */
  async #postTranscript(guild, ticket, transcript) {
    const config = await this.getConfig(guild.id);
    if (!config.transcriptChannelId) return false;
    const channel = await this.resolveChannel(config.transcriptChannelId).catch(() => null);
    if (!channel?.send) return false;

    const ctx = await this.#locale(guild.id, ticket.locale);
    const summary = [
      `**#${ticket.number}** — ${ticket.subject ?? ctx.t('common:tickets.panel.noSubject')}`,
      `${ctx.t('common:tickets.panel.opener')}: ${ticket.openerLabel ?? ticket.openerId}`,
      `${ctx.t('common:tickets.panel.messages')}: ${transcript.messageCount}`,
      ticket.rating ? `${ctx.t('common:tickets.panel.rating')}: ${ticket.rating}/5` : null,
    ]
      .filter(Boolean)
      .join('\n');

    try {
      await channel.send({
        embeds: [{ color: 0x94a3b8, title: `📄 ${ctx.t('common:tickets.panel.transcript')} #${ticket.number}`, description: summary }],
        // The transcript body can exceed the message limit; the attachment is
        // the complete record and the embed is the summary.
        files: transcript.text
          ? [{ name: `ticket-${ticket.number}.txt`, attachment: Buffer.from(transcript.text, 'utf8') }]
          : [],
      });
      return true;
    } catch (err) {
      this.logger.warn('Could not post a ticket transcript', {
        number: ticket.number,
        reason: err.message,
      });
      return false;
    }
  }

  /** Resolve the label for a category, falling back to its raw id. */
  categoryLabel(category, t) {
    if (!category) return null;
    if (category.label) return category.label;
    if (category.labelKey && typeof t === 'function') {
      const translated = t(category.labelKey);
      // i18next returns the key itself when a translation is missing; showing
      // "tickets:categories.support" to a user is worse than the raw id.
      if (translated && translated !== category.labelKey) return translated;
    }
    return category.id;
  }

  async #locale(guildId, override) {
    if (this.localeService) {
      try {
        if (override) return this.localeService.buildContext(override, 'override');
        return await this.localeService.resolveForGuild(guildId);
      } catch (err) {
        this.logger.warn('Could not resolve the ticket locale', { reason: err.message });
      }
    }
    const { getLocaleContext } = await import('./i18nService.js');
    return getLocaleContext(override ?? 'en-US');
  }
}

export const ticketService = new TicketService();

export { DEFAULT_TICKET_CONFIG };

export default ticketService;
