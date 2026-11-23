/**
 * src/services/moderationService.js
 * ---------------------------------------------------------------------------
 * Every moderation action the bot performs goes through here.
 *
 * One path for all of them, in this order:
 *   1. permission + hierarchy gate (PermissionService)
 *   2. the Discord API call
 *   3. a moderation case (the human-quotable record)
 *   4. an audit-log entry
 *   5. an optional DM to the affected member
 *
 * That order matters. The case is written *after* the API call succeeds, so a
 * rejected ban never leaves a case claiming it happened — a case record that
 * does not correspond to reality is worse than no record.
 *
 * This service calls methods on the guild/member/channel objects it is handed
 * rather than reaching for a client, which is what makes it testable with fakes
 * and keeps it usable from automod, the API and the dashboard alike.
 */

import { PermissionDeniedError, ValidationError, ExternalServiceError } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';
import { redact } from '../utils/redact.js';
import { renderTemplate } from '../utils/templates.js';
import { LIMITS } from '../config/constants.js';
import { PermissionService, permissionService } from './permissionService.js';
import { COUNTER_SCOPES } from '../database/models/Counter.js';

/** Default time-to-live for a timeout, in milliseconds (1 hour). */
export const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
/** Discord's hard maximum for a timeout. */
export const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
/** How much history a ban removes by default (0 days = keep everything). */
export const DEFAULT_BAN_DELETE_DAYS = 0;
/** Purge bounds: Discord's bulkDelete only reaches 14 days back. */
export const MIN_PURGE = 1;
export const MAX_PURGE = 100;

export class ModerationService {
  /**
   * @param {object} [deps]
   * @param {object} [deps.models] ModerationCase / Counter
   * @param {import('./loggingService.js').LoggingService} [deps.logging]
   * @param {import('./localeService.js').LocaleService} [deps.localeService]
   * @param {PermissionService} [deps.permissions]
   * @param {() => boolean} [deps.isDbReady]
   */
  constructor(deps = {}) {
    this.models = deps.models ?? {};
    this.logging = deps.logging ?? null;
    this.localeService = deps.localeService ?? null;
    this.permissions = deps.permissions ?? permissionService;
    this.isDbReady = deps.isDbReady ?? (() => true);
    this.logger = (deps.logger ?? getLogger()).child('moderation');
    this.metrics = deps.metrics ?? null;
  }

  /**
   * Ban a member.
   * @returns {Promise<{ caseNumber:number|null, dmSent:boolean }>}
   */
  async ban({ guild, target, moderator, reason = null, deleteMessageDays = DEFAULT_BAN_DELETE_DAYS, notify = true, locale = null }) {
    this.permissions.assertCan('ban', { actor: moderator, target, guild, bot: guild?.members?.me });

    if (deleteMessageDays < 0 || deleteMessageDays > 7) {
      throw new ValidationError('deleteMessageDays must be between 0 and 7', {
        i18nKey: 'errors:validation',
        details: { reason: 'deleteMessageDays must be between 0 and 7' },
      });
    }

    await this.#discordCall(
      () => guild.members.ban(target.id ?? target, { deleteMessageSeconds: deleteMessageDays * 86400, reason: this.#auditReason(reason, moderator) }),
      'ban',
    );

    this.metrics?.increment('moderation.ban');
    return this.#finalize({
      guild,
      type: 'ban',
      target,
      moderator,
      reason,
      locale,
      notify,
      auditType: 'member.ban',
      evidence: { deleteMessageDays },
    });
  }

  /** @returns {Promise<{ caseNumber:number|null, dmSent:boolean }>} */
  async unban({ guild, userId, moderator, reason = null, locale = null }) {
    this.permissions.assertCan('unban', { actor: moderator, guild, bot: guild?.members?.me });

    await this.#discordCall(() => guild.bans.remove(userId, this.#auditReason(reason, moderator)), 'unban');

    this.metrics?.increment('moderation.unban');
    return this.#finalize({
      guild,
      type: 'unban',
      target: { id: userId, user: { username: null } },
      moderator,
      reason,
      locale,
      notify: false,
      auditType: 'member.unban',
      evidence: null,
    });
  }

  /** @returns {Promise<{ caseNumber:number|null, dmSent:boolean }>} */
  async kick({ guild, target, moderator, reason = null, notify = true, locale = null }) {
    this.permissions.assertCan('kick', { actor: moderator, target, guild, bot: guild?.members?.me });

    // A member who cannot be kicked (already left) must not produce a case.
    await this.#discordCall(() => target.kick(this.#auditReason(reason, moderator)), 'kick');

    this.metrics?.increment('moderation.kick');
    return this.#finalize({ guild, type: 'kick', target, moderator, reason, locale, notify, auditType: 'member.kick' });
  }

  /**
   * Time a member out.
   * @param {number} [durationMs]
   */
  async timeout({ guild, target, moderator, reason = null, durationMs = DEFAULT_TIMEOUT_MS, notify = true, locale = null }) {
    this.permissions.assertCan('timeout', { actor: moderator, target, guild, bot: guild?.members?.me });

    const ms = Number(durationMs);
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new ValidationError('Timeout duration must be a positive number of milliseconds', {
        i18nKey: 'errors:validation',
        details: { reason: 'duration must be positive' },
      });
    }
    // Discord rejects anything above 28 days; clamping silently would make the
    // case record disagree with what actually happened.
    if (ms > MAX_TIMEOUT_MS) {
      throw new ValidationError('Timeout cannot exceed 28 days', {
        i18nKey: 'errors:validation',
        details: { reason: 'maximum timeout is 28 days' },
      });
    }

    await this.#discordCall(() => target.disableCommunicationUntil(Date.now() + ms, this.#auditReason(reason, moderator)), 'timeout');

    this.metrics?.increment('moderation.timeout');
    return this.#finalize({
      guild,
      type: 'timeout',
      target,
      moderator,
      reason,
      locale,
      notify,
      auditType: 'member.timeout',
      expiresAt: new Date(Date.now() + ms),
      evidence: { durationMs: ms },
    });
  }

  /** @returns {Promise<{ caseNumber:number|null, dmSent:boolean }>} */
  async untimeout({ guild, target, moderator, reason = null, locale = null }) {
    this.permissions.assertCan('untimeout', { actor: moderator, target, guild, bot: guild?.members?.me });
    await this.#discordCall(() => target.disableCommunicationUntil(null, this.#auditReason(reason, moderator)), 'untimeout');

    this.metrics?.increment('moderation.untimeout');
    return this.#finalize({
      guild,
      type: 'untimeout',
      target,
      moderator,
      reason,
      locale,
      notify: false,
      auditType: 'member.timeout.remove',
    });
  }

  /**
   * Warn a member.
   *
   * A warning is a case with `type: 'warn'` — there is no separate Warning
   * collection, because two records of the same warning would drift apart and
   * nobody could say which was true.
   */
  async warn({ guild, target, moderator, reason = null, notify = true, locale = null }) {
    if (!reason || !String(reason).trim()) {
      throw new ValidationError('A warning requires a reason', {
        i18nKey: 'errors:validation',
        details: { reason: 'a reason is required' },
      });
    }

    this.permissions.assertCan('warn', { actor: moderator, target, guild, bot: guild?.members?.me });

    this.metrics?.increment('moderation.warn');
    return this.#finalize({ guild, type: 'warn', target, moderator, reason, locale, notify, auditType: 'member.warn' });
  }

  /**
   * Bulk-delete messages.
   * @returns {Promise<{ caseNumber:number|null, deleted:number }>}
   */
  async purge({ guild, channel, moderator, count = 10, filterUserId = null, reason = null, locale = null }) {
    this.permissions.assertCan('purge', { actor: moderator, guild, bot: guild?.members?.me });

    const wanted = Number(count);
    if (!Number.isFinite(wanted) || wanted < MIN_PURGE || wanted > MAX_PURGE) {
      throw new ValidationError(`Purge count must be between ${MIN_PURGE} and ${MAX_PURGE}`, {
        i18nKey: 'errors:validation',
        details: { reason: `count must be between ${MIN_PURGE} and ${MAX_PURGE}` },
      });
    }

    // fetch() must be awaited before filtering: a lazy Collection would return
    // an empty set and the purge would silently delete nothing.
    const fetched = await channel.messages.fetch({ limit: Math.min(wanted * (filterUserId ? 5 : 1), 100) });
    const selected = [...fetched.values()].filter((message) => {
      // Discord cannot bulk-delete messages older than 14 days.
      if (Date.now() - message.createdTimestamp > 14 * 86400_000) return false;
      if (filterUserId && message.author?.id !== filterUserId) return false;
      return true;
    }).slice(0, wanted);

    const deleted = selected.length ? (await this.#discordCall(() => channel.bulkDelete(selected, true), 'purge'))?.size ?? 0 : 0;

    this.metrics?.increment('moderation.purge');
    const result = await this.#finalize({
      guild,
      type: 'purge',
      target: { id: filterUserId ?? channel.id, user: { username: filterUserId ? null : channel.name } },
      moderator,
      reason,
      locale,
      notify: false,
      auditType: 'message.purge',
      channelId: channel.id,
      // Only metadata is kept. Storing deleted message bodies is the
      // "unnecessary sensitive data" the logging policy forbids.
      evidence: { requested: wanted, deleted, filteredByUser: filterUserId },
    });

    return { ...result, deleted };
  }

  /** @returns {Promise<{ caseNumber:number|null, seconds:number }>} */
  async slowmode({ guild, channel, moderator, seconds = 0, reason = null, locale = null }) {
    this.permissions.assertCan('slowmode', { actor: moderator, guild, bot: guild?.members?.me });

    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0 || value > 21600) {
      throw new ValidationError('Slowmode must be between 0 and 21600 seconds', {
        i18nKey: 'errors:validation',
        details: { reason: 'slowmode must be between 0 and 21600 seconds' },
      });
    }

    await this.#discordCall(() => channel.setRateLimitPerUser(value, this.#auditReason(reason, moderator)), 'slowmode');

    this.metrics?.increment('moderation.slowmode');
    const result = await this.#finalize({
      guild,
      type: 'slowmode',
      target: { id: channel.id, user: { username: channel.name } },
      moderator,
      reason,
      locale,
      notify: false,
      auditType: 'channel.slowmode',
      channelId: channel.id,
      evidence: { seconds: value },
    });
    return { ...result, seconds: value };
  }

  /**
   * Lock a channel by denying SendMessages to @everyone.
   * @returns {Promise<{ caseNumber:number|null }>}
   */
  async lock({ guild, channel, moderator, reason = null, locale = null }) {
    this.permissions.assertCan('lock', { actor: moderator, guild, bot: guild?.members?.me });
    return this.#setLock({ guild, channel, moderator, reason, locale, locked: true });
  }

  /** @returns {Promise<{ caseNumber:number|null }>} */
  async unlock({ guild, channel, moderator, reason = null, locale = null }) {
    this.permissions.assertCan('unlock', { actor: moderator, guild, bot: guild?.members?.me });
    return this.#setLock({ guild, channel, moderator, reason, locale, locked: false });
  }

  async #setLock({ guild, channel, moderator, reason, locale, locked }) {
    const everyone = guild.roles.everyone;
    if (!everyone) {
      throw new ExternalServiceError('Could not resolve the @everyone role for this guild', {
        i18nKey: 'errors:discord',
      });
    }

    // null removes the override entirely; false denies. Removing rather than
    // allowing means an unlock restores whatever the category intended.
    await this.#discordCall(
      () =>
        channel.permissionOverwrites.edit(everyone.id, { SendMessages: locked ? false : null }, {
          reason: this.#auditReason(reason, moderator),
        }),
      locked ? 'lock' : 'unlock',
    );

    this.metrics?.increment(locked ? 'moderation.lock' : 'moderation.unlock');
    return this.#finalize({
      guild,
      type: locked ? 'lock' : 'unlock',
      target: { id: channel.id, user: { username: channel.name } },
      moderator,
      reason,
      locale,
      notify: false,
      auditType: locked ? 'channel.lock' : 'channel.unlock',
      channelId: channel.id,
    });
  }

  /**
   * A member's moderation history.
   * @returns {Promise<{ total:number, entries:object[] }>}
   */
  async getHistory(guildId, targetId, { limit = 20, page = 1 } = {}) {
    const model = this.models.ModerationCase;
    if (!model || !this.isDbReady()) return { total: 0, entries: [] };

    const safeLimit = Math.min(Math.max(1, Number(limit) || 20), 100);
    const safePage = Math.max(1, Number(page) || 1);

    const filter = { guildId, targetId };
    const [total, rows] = await Promise.all([
      model.countDocuments(filter).catch(() => 0),
      model
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((safePage - 1) * safeLimit)
        .limit(safeLimit)
        .lean()
        .catch(() => []),
    ]);

    return {
      total,
      page: safePage,
      pages: Math.max(1, Math.ceil(total / safeLimit)),
      entries: rows.map((row) => ({
        caseNumber: row.caseNumber,
        type: row.type,
        reason: row.reason,
        moderatorId: row.moderatorId,
        moderatorLabel: row.moderatorLabel,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
        createdAt: row.createdAt,
      })),
    };
  }

  /**
   * Revoke an action (lift a timeout, record an appealed ban).
   * @returns {Promise<boolean>} whether a case was found and marked
   */
  async revokeCase({ guildId, caseNumber, moderator, reason = null }) {
    const model = this.models.ModerationCase;
    if (!model || !this.isDbReady()) return false;

    const updated = await model
      .findOneAndUpdate(
        { guildId, caseNumber, revokedAt: null },
        { $set: { revokedAt: new Date(), revokedById: moderator?.id ?? null, revokeReason: reason } },
        { new: true },
      )
      .catch((err) => {
        this.logger.errorFrom(err, 'Could not revoke a case', { guildId, caseNumber });
        return null;
      });

    if (!updated) return false;

    this.metrics?.increment('moderation.revoked');
    await this.#audit(guildId, updated.type, {
      targetId: updated.targetId,
      targetLabel: updated.targetLabel,
      moderator,
      reason: reason ?? 'case revoked',
      caseNumber: updated.caseNumber,
      evidence: { revoked: true },
    });
    return true;
  }

  /** Shared tail: case record, audit entry, optional DM. */
  async #finalize({ guild, type, target, moderator, reason, locale, notify, auditType, channelId = null, expiresAt = null, evidence = null }) {
    const caseNumber = await this.#createCase({
      guildId: guild.id,
      type,
      target,
      moderator,
      reason,
      channelId,
      expiresAt,
      evidence,
    });

    await this.#audit(guild.id, auditType, {
      targetId: target?.id ?? null,
      targetLabel: target?.user?.username ?? target?.username ?? null,
      moderator,
      reason,
      caseNumber,
      channelId,
      evidence,
    });

    const dmSent = notify ? await this.#notify(target, { type, reason, guild, moderator, locale }) : false;

    if (caseNumber && this.models.ModerationCase && this.isDbReady()) {
      await this.models.ModerationCase
        .updateOne({ guildId: guild.id, caseNumber }, { $set: { dmSent } })
        .catch(() => null);
    }

    return { caseNumber, dmSent };
  }

  /** Allocate the case number atomically, then write the case. */
  async #createCase({ guildId, type, target, moderator, reason, channelId, expiresAt, evidence }) {
    const { ModerationCase, Counter } = this.models;
    if (!ModerationCase || !Counter || !this.isDbReady()) {
      // No database: the action still happened, so it must still be reported.
      this.logger.warn('Moderation case not recorded — database offline', { guildId, type });
      return null;
    }

    try {
      const caseNumber = await Counter.next(COUNTER_SCOPES.moderationCase, guildId);
      await ModerationCase.create({
        guildId,
        caseNumber,
        type,
        targetId: target?.id ?? null,
        targetLabel: target?.user?.username ?? target?.username ?? null,
        moderatorId: moderator?.id ?? null,
        moderatorLabel: moderator?.user?.username ?? null,
        reason: reason ? String(reason).slice(0, 1000) : null,
        expiresAt,
        channelId,
        // The database is not covered by the log redactor, so scrub here too.
        evidence: evidence ? redact(evidence) : null,
      });
      return caseNumber;
    } catch (err) {
      this.logger.errorFrom(err, 'Could not create a moderation case', { guildId, type });
      return null;
    }
  }

  async #audit(guildId, type, data) {
    if (!this.logging) return;
    try {
      await this.logging.log({
        guildId,
        type,
        actor: data.moderator ? { id: data.moderator.id, label: data.moderator.user?.username ?? null } : undefined,
        target: data.targetId ? { id: data.targetId, label: data.targetLabel ?? null } : undefined,
        channelId: data.channelId ?? null,
        reason: data.reason ?? null,
        evidence: data.evidence ? { ...data.evidence, caseNumber: data.caseNumber } : { caseNumber: data.caseNumber },
      });
    } catch (err) {
      this.logger.warn('Could not write the moderation audit record', { reason: err.message });
    }
  }

  /**
   * Tell the affected member what happened. A closed DM channel is the common
   * case and is not an error worth surfacing.
   * @returns {Promise<boolean>}
   */
  async #notify(target, { type, reason, guild, moderator, locale }) {
    if (!target?.send) return false;
    try {
      const ctx = await this.#locale(guild, locale);
      const t = ctx.t;
      const values = {
        server: { name: guild.name },
        moderator: { name: moderator?.user?.username ?? 'unknown' },
        reason: reason ?? t('common:moderation.noReason'),
      };
      const text = renderTemplate(t(`common:moderation.dm.${type}`), values, { maxLength: LIMITS.messageContent });
      await target.send(text);
      return true;
    } catch (err) {
      this.logger.debug('Moderation DM not delivered', { userId: target.id, reason: err.message });
      return false;
    }
  }

  async #locale(guild, override) {
    if (this.localeService) {
      try {
        if (override) return this.localeService.buildContext(override, 'override');
        return await this.localeService.resolveForGuild(guild.id);
      } catch (err) {
        this.logger.warn('Could not resolve the moderation locale', { reason: err.message });
      }
    }
    const { getLocaleContext } = await import('./i18nService.js');
    return getLocaleContext(override ?? 'en-US');
  }

  /**
   * Wrap a Discord API call so a failure becomes a typed error with the Discord
   * code attached, instead of an opaque 500.
   */
  async #discordCall(fn, action) {
    try {
      return await fn();
    } catch (err) {
      // 403/404 here are almost always a race: the member left, or a role was
      // deleted between the permission check and the call.
      this.logger.warn('Discord rejected a moderation action', {
        action,
        status: err.status,
        code: err.code,
        reason: err.message,
      });
      throw new ExternalServiceError(`Discord rejected the ${action}: ${err.message}`, {
        i18nKey: 'errors:discord',
        cause: err,
        expose: err.status === 403 || err.status === 404,
        details: { status: err.status, discordCode: err.code },
      });
    }
  }

  /** Discord's audit log accepts a reason plus an optional user attribution. */
  #auditReason(reason, moderator) {
    const who = moderator?.user?.username ? ` (${moderator.user.username})` : '';
    return reason ? `${reason}${who}`.slice(0, 512) : `xXx Family${who}`.slice(0, 512);
  }
}

export const moderationService = new ModerationService();

export { PermissionDeniedError };

export default moderationService;
