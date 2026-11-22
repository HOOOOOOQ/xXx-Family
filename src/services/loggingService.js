/**
 * src/services/loggingService.js
 * ---------------------------------------------------------------------------
 * One entry point for every log the ecosystem produces.
 *
 * Design rules:
 *   - **Delivery never throws.** A missing channel, a revoked permission or a
 *     deleted guild must not break the action being logged (a ban failing
 *     because the log channel is gone would be a serious bug).
 *   - **The audit record is written even when delivery fails**, with
 *     `delivered: false` and the reason, so "the log did not appear" is
 *     diagnosable instead of silent.
 *   - **Rendering is the caller's job.** The caller passes an already-localized
 *     embed, so this service never needs to know which language to use and can
 *     never mix languages.
 *   - Filters are per guild and per type, read from GuildSettings.
 */

import { PermissionFlagsBits } from 'discord.js';

import { getLogger } from '../utils/logger.js';
import { redact } from '../utils/redact.js';
import AuditLog from '../database/models/AuditLog.js';

/** Types that are on by default even before a server configures anything. */
export const DEFAULT_LOG_TYPES = Object.freeze([
  'member.join',
  'member.leave',
  'member.ban',
  'member.unban',
  'member.kick',
  'message.delete',
  'config.change',
  'system.error',
]);

export class LoggingService {
  /**
   * @param {object} [deps]
   * @param {object} [deps.models]
   * @param {import('./settingsService.js').SettingsService} [deps.settings]
   * @param {(channelId:string)=>Promise<import('discord.js').TextChannel|null>} [deps.resolveChannel]
   * @param {() => boolean} [deps.isDbReady]
   */
  constructor(deps = {}) {
    this.settings = deps.settings ?? null;
    this.resolveChannel = deps.resolveChannel ?? (async () => null);
    this.isDbReady = deps.isDbReady ?? (() => true);
    this.model = deps.model ?? AuditLog;
    this.logger = (deps.logger ?? getLogger()).child('logging');
    this.metrics = deps.metrics ?? null;
  }

  /**
   * Whether a guild wants this type logged.
   * Unknown types default to enabled so a new phase works before anyone
   * configures it; an explicit `false` disables.
   *
   * @param {object|null} guildSettings
   * @param {string} type
   * @returns {boolean}
   */
  isTypeEnabled(guildSettings, type) {
    const logging = guildSettings?.features?.logging;
    if (!logging || typeof logging !== 'object') return true;
    if (Array.isArray(logging.disabledTypes) && logging.disabledTypes.includes(type)) return false;
    if (logging.types && typeof logging.types === 'object' && type in logging.types) {
      return Boolean(logging.types[type]);
    }
    return true;
  }

  /**
   * Log one event.
   *
   * @param {object} entry
   * @param {string} entry.guildId
   * @param {string} entry.type            one of AUDIT_TYPES
   * @param {object} [entry.embed]         already-localized EmbedBuilder
   * @param {{ id?:string, label?:string }} [entry.actor]
   * @param {{ id?:string, label?:string }} [entry.target]
   * @param {string} [entry.channelId]     channel the event happened in
   * @param {string} [entry.reason]
   * @param {Record<string, unknown>} [entry.evidence]
   * @param {string} [entry.locale]        locale the embed was rendered in
   * @param {string} [entry.logChannelId]  override the configured log channel
   * @returns {Promise<{ recorded:boolean, delivered:boolean, id:string|null, error:string|null, skipped?:string }>}
   */
  async log(entry) {
    const { guildId, type } = entry;
    if (!guildId) return { recorded: false, delivered: false, id: null, error: 'guildId is required' };
    if (!type) return { recorded: false, delivered: false, id: null, error: 'type is required' };

    const guildSettings = this.settings ? await this.settings.getGuildSettings(guildId).catch(() => null) : null;

    if (!this.isTypeEnabled(guildSettings, type)) {
      return { recorded: false, delivered: false, id: null, error: null, skipped: 'filtered' };
    }

    const logChannelId = entry.logChannelId ?? guildSettings?.channels?.logs ?? null;
    const delivery = await this.#deliver(logChannelId, entry);

    const record = await this.#record(entry, delivery);
    this.metrics?.increment(`logs.${type}`);

    return record;
  }

  /** @returns {Promise<{ delivered:boolean, error:string|null }>} */
  async #deliver(logChannelId, entry) {
    if (!logChannelId) return { delivered: false, error: 'no log channel configured' };
    if (!entry.embed) return { delivered: false, error: 'no embed provided' };

    try {
      const channel = await this.resolveChannel(logChannelId);
      if (!channel) return { delivered: false, error: 'log channel not found' };
      if (channel.isTextBased?.() === false) return { delivered: false, error: 'log channel is not text-based' };

      const me = channel.guild?.members?.me;
      if (me && !channel.permissionsFor?.(me)?.has(PermissionFlagsBits.SendMessages)) {
        return { delivered: false, error: 'missing SendMessages in the log channel' };
      }

      await channel.send({ embeds: [entry.embed] });
      return { delivered: true, error: null };
    } catch (err) {
      this.logger.warn('Could not deliver a log embed', { type: entry.type, reason: err.message });
      return { delivered: false, error: err.message.slice(0, 500) };
    }
  }

  /** @returns {Promise<{ recorded:boolean, delivered:boolean, id:string|null, error:string|null }>} */
  async #record(entry, delivery) {
    if (!this.isDbReady()) {
      this.logger.debug('Audit record skipped — database offline', { type: entry.type });
      return { recorded: false, delivered: delivery.delivered, id: null, error: delivery.error };
    }

    try {
      const doc = await this.model.create({
        guildId: entry.guildId,
        type: entry.type,
        actorId: entry.actor?.id ?? null,
        actorLabel: entry.actor?.label ?? null,
        targetId: entry.target?.id ?? null,
        targetLabel: entry.target?.label ?? null,
        channelId: entry.channelId ?? null,
        caseId: entry.caseId ?? null,
        reason: entry.reason?.slice(0, 1000) ?? null,
        // The database is not covered by the log redactor, so scrub here too.
        evidence: entry.evidence ? redact(entry.evidence) : null,
        locale: entry.locale ?? null,
        delivered: delivery.delivered,
        deliveryError: delivery.error,
      });
      return { recorded: true, delivered: delivery.delivered, id: String(doc._id), error: delivery.error };
    } catch (err) {
      this.logger.errorFrom(err, 'Could not write the audit record', { type: entry.type });
      return { recorded: false, delivered: delivery.delivered, id: null, error: err.message };
    }
  }

  /**
   * Query the audit trail (moderation history, dashboard).
   * @param {object} query
   * @param {string} query.guildId
   * @param {string|string[]} [query.type]
   * @param {string} [query.targetId]
   * @param {string} [query.actorId]
   * @param {number} [query.limit]
   * @param {number} [query.page] 1-based
   */
  async search({ guildId, type, targetId, actorId, limit = 20, page = 1 }) {
    if (!guildId) throw new Error('guildId is required');
    if (!this.isDbReady()) return { total: 0, page, pages: 0, entries: [] };

    const filter = { guildId };
    if (type) filter.type = Array.isArray(type) ? { $in: type } : type;
    if (targetId) filter.targetId = targetId;
    if (actorId) filter.actorId = actorId;

    const safeLimit = Math.min(Math.max(1, Number(limit) || 20), 100);
    const safePage = Math.max(1, Number(page) || 1);

    const [total, rows] = await Promise.all([
      this.model.countDocuments(filter),
      this.model
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((safePage - 1) * safeLimit)
        .limit(safeLimit)
        .lean(),
    ]);

    return {
      total,
      page: safePage,
      pages: Math.max(1, Math.ceil(total / safeLimit)),
      entries: rows.map((row) => ({
        id: String(row._id),
        type: row.type,
        actorId: row.actorId,
        actorLabel: row.actorLabel,
        targetId: row.targetId,
        targetLabel: row.targetLabel,
        channelId: row.channelId,
        reason: row.reason,
        locale: row.locale,
        delivered: row.delivered,
        createdAt: row.createdAt,
      })),
    };
  }
}

export const loggingService = new LoggingService();

export default loggingService;
