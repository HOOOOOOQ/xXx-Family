/**
 * src/services/welcomeService.js
 * ---------------------------------------------------------------------------
 * Welcome / goodbye / auto-role / rejoin / milestone logic.
 *
 * Hard rules this service enforces:
 *   - **Disabled means disabled.** A guild with no configuration gets nothing;
 *     nothing is ever sent to a server that did not opt in.
 *   - **Bots are ignored** unless the guild explicitly asks for them.
 *   - **Role hierarchy is respected.** A role at or above the bot's highest role
 *     is skipped, because Discord would reject it anyway (and a bot granting
 *     roles above itself is a privilege-escalation vector).
 *   - **Nothing throws out of here.** A welcome message must never be the reason
 *     a member join fails to be processed.
 *   - Every send is audited through LoggingService.
 */

import { getLogger } from '../utils/logger.js';
import { renderTemplate, findUnknownPlaceholders } from '../utils/templates.js';
import { brandEmbed } from '../utils/embeds.js';
import { COLORS, LIMITS } from '../config/constants.js';
import { formatDuration, discordTimestamp } from '../utils/format.js';
import { DEFAULT_WELCOME_CONFIG } from '../database/models/WelcomeConfig.js';
import { DEFAULT_GOODBYE_CONFIG } from '../database/models/GoodbyeConfig.js';

/**
 * Tracks when a member left so a quick return can be greeted as "welcome back".
 *
 * In-memory on purpose: it is a UX nicety, not a source of truth, and it must
 * not cost a database write on every leave. The consequence is documented —
 * after a restart a returning member is welcomed as new.
 */
export class LeaveTracker {
  /** @param {number} [maxWindowMs] */
  constructor(maxWindowMs = 7 * 24 * 60 * 60 * 1000) {
    /** @type {Map<string, number>} `${guildId}:${userId}` -> leftAt epoch ms */
    this.entries = new Map();
    this.maxWindowMs = maxWindowMs;
  }

  /** @param {string} guildId @param {string} userId */
  markLeave(guildId, userId) {
    this.entries.set(`${guildId}:${userId}`, Date.now());
    this.#sweep();
  }

  /**
   * Consume a recorded leave.
   * @param {string} guildId
   * @param {string} userId
   * @param {number} windowMs
   * @returns {{ rejoined:boolean, leftAt:number|null, awayMs:number|null }}
   */
  consume(guildId, userId, windowMs) {
    const key = `${guildId}:${userId}`;
    const leftAt = this.entries.get(key) ?? null;
    this.entries.delete(key);
    if (!leftAt) return { rejoined: false, leftAt: null, awayMs: null };
    const awayMs = Date.now() - leftAt;
    return { rejoined: awayMs <= windowMs, leftAt, awayMs };
  }

  #sweep() {
    if (this.entries.size < 500) return;
    const cutoff = Date.now() - this.maxWindowMs;
    for (const [key, at] of this.entries) if (at < cutoff) this.entries.delete(key);
  }

  get size() {
    return this.entries.size;
  }
}

export class WelcomeService {
  /**
   * @param {object} [deps]
   * @param {object} [deps.models]            WelcomeConfig / GoodbyeConfig
   * @param {import('./settingsService.js').SettingsService} [deps.settings]
   * @param {import('./loggingService.js').LoggingService} [deps.logging]
   * @param {import('./localeService.js').LocaleService} [deps.localeService]
   * @param {(id:string)=>Promise<any>} [deps.resolveChannel]
   * @param {LeaveTracker} [deps.leaveTracker]
   * @param {() => boolean} [deps.isDbReady]
   */
  constructor(deps = {}) {
    this.models = deps.models ?? {};
    this.settings = deps.settings ?? null;
    this.logging = deps.logging ?? null;
    this.localeService = deps.localeService ?? null;
    this.resolveChannel = deps.resolveChannel ?? (async () => null);
    this.leaveTracker = deps.leaveTracker ?? new LeaveTracker();
    this.isDbReady = deps.isDbReady ?? (() => true);
    this.logger = (deps.logger ?? getLogger()).child('welcome');
    this.metrics = deps.metrics ?? null;
  }

  /** @returns {Promise<typeof DEFAULT_WELCOME_CONFIG>} */
  async getWelcomeConfig(guildId) {
    if (!this.isDbReady() || !this.models.WelcomeConfig) return { ...DEFAULT_WELCOME_CONFIG, guildId };
    const doc = await this.models.WelcomeConfig.findOne({ guildId }).lean().catch(() => null);
    if (!doc) return { ...DEFAULT_WELCOME_CONFIG, guildId };
    return { ...DEFAULT_WELCOME_CONFIG, ...doc, embed: { ...DEFAULT_WELCOME_CONFIG.embed, ...(doc.embed ?? {}) }, dm: { ...DEFAULT_WELCOME_CONFIG.dm, ...(doc.dm ?? {}) }, rejoin: { ...DEFAULT_WELCOME_CONFIG.rejoin, ...(doc.rejoin ?? {}) }, milestones: { ...DEFAULT_WELCOME_CONFIG.milestones, ...(doc.milestones ?? {}) }, card: { ...DEFAULT_WELCOME_CONFIG.card, ...(doc.card ?? {}) } };
  }

  /** @returns {Promise<typeof DEFAULT_GOODBYE_CONFIG>} */
  async getGoodbyeConfig(guildId) {
    if (!this.isDbReady() || !this.models.GoodbyeConfig) return { ...DEFAULT_GOODBYE_CONFIG, guildId };
    const doc = await this.models.GoodbyeConfig.findOne({ guildId }).lean().catch(() => null);
    if (!doc) return { ...DEFAULT_GOODBYE_CONFIG, guildId };
    return { ...DEFAULT_GOODBYE_CONFIG, ...doc, embed: { ...DEFAULT_GOODBYE_CONFIG.embed, ...(doc.embed ?? {}) } };
  }

  /**
   * Build the placeholder values available to every template.
   * @param {import('discord.js').GuildMember} member
   * @param {object} [extra]
   * @returns {Record<string, unknown>}
   */
  buildTemplateValues(member, extra = {}) {
    const guild = member.guild;
    const user = member.user ?? member;
    const createdMs = user.createdTimestamp ?? null;
    const joinedMs = member.joinedTimestamp ?? null;

    return {
      user: {
        mention: `<@${user.id}>`,
        name: user.displayName ?? user.username ?? 'unknown',
        tag: user.username ?? 'unknown',
        id: user.id,
        avatar: user.displayAvatarURL?.({ size: 256 }) ?? null,
        created: createdMs ? discordTimestamp(createdMs, 'R') : null,
        joined: joinedMs ? discordTimestamp(joinedMs, 'R') : null,
        accountAge: createdMs ? formatDuration(Date.now() - createdMs, extra.t ?? ((k) => k), { maxUnits: 2 }) : null,
        bot: Boolean(user.bot),
      },
      server: {
        name: guild?.name ?? 'unknown',
        id: guild?.id ?? null,
        memberCount: guild?.memberCount ?? null,
        icon: guild?.iconURL?.() ?? null,
      },
      memberCount: guild?.memberCount ?? null,
      inviter: extra.inviter ?? null,
      duration: extra.duration ?? null,
      ...extra.extra,
    };
  }

  /**
   * Welcome a member who just joined.
   *
   * @param {import('discord.js').GuildMember} member
   * @returns {Promise<{ sent:number, roles:string[], dm:boolean, skipped?:string, rejoin:boolean, milestone:boolean }>}
   */
  async welcomeMember(member) {
    const guild = member.guild;
    const config = await this.getWelcomeConfig(guild.id);

    if (!config.enabled) return { sent: 0, roles: [], dm: false, skipped: 'disabled', rejoin: false, milestone: false };
    if (member.user?.bot && !config.includeBots) {
      return { sent: 0, roles: [], dm: false, skipped: 'bot', rejoin: false, milestone: false };
    }

    const rejoin = config.rejoin.detect
      ? this.leaveTracker.consume(guild.id, member.id, config.rejoin.windowMinutes * 60_000)
      : { rejoined: false, leftAt: null, awayMs: null };

    const memberCount = guild.memberCount ?? 0;
    const milestone =
      config.milestones.enabled && config.milestones.every > 0 && memberCount % config.milestones.every === 0;

    const localeContext = await this.#locale(guild, config.language);
    const t = localeContext.t;
    const values = this.buildTemplateValues(member, { t, extra: { awayMs: rejoin.awayMs } });

    // Unknown placeholders are logged once so an admin can fix the template
    // instead of wondering why the message looks broken.
    const template = config.message ?? t('common:welcome.message');
    const unknown = findUnknownPlaceholders(template, values);
    if (unknown.length) this.logger.warn('Welcome template has unknown placeholders', { guildId: guild.id, unknown });

    const key = milestone ? 'common:welcome.milestone' : rejoin.rejoined ? 'common:welcome.rejoin' : 'common:welcome.message';
    const text = renderTemplate(config.message ?? t(key), values, { maxLength: LIMITS.messageContent });

    const sent = await this.#sendToChannels(config.channelIds, text, config.embed, {
      t,
      dir: localeContext.dir,
      values,
      member,
      fallbackTitle: 'common:welcome.title',
      color: COLORS.success,
    });

    const roles = await this.#applyAutoRoles(member, config);
    const dm = await this.#sendDm(member, config, values, t);

    await this.#audit(guild.id, 'member.join', {
      member,
      locale: localeContext.locale,
      delivered: sent > 0,
      reason: rejoin.rejoined ? 'rejoin' : milestone ? 'milestone' : null,
      evidence: { memberCount, autoRoles: roles, dm, rejoin: rejoin.rejoined, milestone },
    });

    this.metrics?.increment(rejoin.rejoined ? 'welcome.rejoin' : 'welcome.sent');
    await this.#bumpCounter('WelcomeConfig', guild.id);

    return { sent, roles, dm, rejoin: rejoin.rejoined, milestone };
  }

  /**
   * Say goodbye to a member who left.
   * @param {import('discord.js').GuildMember|import('discord.js').User} memberOrUser
   * @param {object} [options]
   * @param {boolean} [options.removed] the member was kicked or banned
   */
  async farewellMember(memberOrUser, options = {}) {
    const guild = memberOrUser.guild;
    if (!guild) return { sent: 0, skipped: 'no guild context' };

    const config = await this.getGoodbyeConfig(guild.id);
    // Always remember the leave, even when goodbye messages are off, so rejoin
    // detection keeps working.
    this.leaveTracker.markLeave(guild.id, memberOrUser.id);

    if (!config.enabled) return { sent: 0, skipped: 'disabled' };
    if (memberOrUser.bot && !config.includeBots) return { sent: 0, skipped: 'bot' };
    if (options.removed && config.skipOnRemoval) return { sent: 0, skipped: 'removed' };

    const localeContext = await this.#locale(guild, config.language);
    const t = localeContext.t;
    const stayedMs = memberOrUser.joinedTimestamp ? Date.now() - memberOrUser.joinedTimestamp : null;
    const values = this.buildTemplateValues(memberOrUser, {
      t,
      duration: config.showDuration && stayedMs !== null ? formatDuration(stayedMs, t, { maxUnits: 2 }) : null,
    });

    const key = options.removed ? 'common:goodbye.removed' : 'common:goodbye.message';
    let text = renderTemplate(config.message ?? t(key), values, { maxLength: LIMITS.messageContent });
    if (!options.removed && config.showDuration && values.duration) {
      // The duration line is rendered by the template engine, not by i18next
      // interpolation: welcome/goodbye strings are admin-editable templates, so
      // they must all use the single-brace `{placeholder}` syntax. The rest of
      // the locale files use i18next's `{{value}}` syntax for programmatic
      // strings — keeping the two apart is deliberate, not an inconsistency.
      text = `${text}\n${renderTemplate(t('common:goodbye.duration'), values, { maxLength: 200 })}`;
    }

    const sent = await this.#sendToChannels(config.channelId ? [config.channelId] : [], text, config.embed, {
      t,
      dir: localeContext.dir,
      values,
      member: memberOrUser,
      fallbackTitle: 'common:goodbye.title',
      color: COLORS.silver,
    });

    await this.#audit(guild.id, 'member.leave', {
      member: memberOrUser,
      locale: localeContext.locale,
      delivered: sent > 0,
      reason: options.removed ? 'removed' : null,
      evidence: { memberCount: guild.memberCount ?? null, stayedMs },
    });

    this.metrics?.increment('goodbye.sent');
    await this.#bumpCounter('GoodbyeConfig', guild.id);
    return { sent };
  }

  /** Resolve the locale: explicit welcome-language override, then the guild. */
  async #locale(guild, override) {
    if (this.localeService) {
      try {
        if (override) return this.localeService.buildContext(override, 'override');
        return await this.localeService.resolveForGuild(guild.id);
      } catch (err) {
        this.logger.warn('Locale resolution failed for welcome', { guildId: guild.id, reason: err.message });
      }
    }
    const { getLocaleContext } = await import('./i18nService.js');
    return getLocaleContext(override ?? 'en-US');
  }

  /**
   * Send to every configured channel.
   *
   * The message text goes in exactly ONE place: into the embed description when
   * the embed is enabled, otherwise into the message content. Sending both made
   * every welcome message appear twice in Discord.
   *
   * `text` is already rendered by the caller and is used verbatim — re-rendering
   * it would let a member's display name containing `{user.name}` be expanded.
   * Only the admin-supplied `embed.description` is rendered here.
   *
   * @returns {Promise<number>} number of channels the message reached
   */
  async #sendToChannels(channelIds, text, embedConfig, ctx) {
    if (!channelIds?.length) return 0;
    let sent = 0;

    const useEmbed = Boolean(embedConfig?.enabled);
    const avatar = ctx.member?.user?.displayAvatarURL?.({ size: 256 }) ?? ctx.member?.displayAvatarURL?.({ size: 256 });

    const embed = useEmbed
      ? brandEmbed({
          t: ctx.t,
          dir: ctx.dir,
          color: embedConfig.color ?? ctx.color,
          title: embedConfig.title ? renderTemplate(embedConfig.title, ctx.values) : ctx.t(ctx.fallbackTitle),
          description: embedConfig.description ? renderTemplate(embedConfig.description, ctx.values) : text,
          thumbnail: embedConfig.showAvatar ? avatar ?? undefined : undefined,
          image: embedConfig.image ?? undefined,
        })
      : null;

    // One place, always: with an embed the text lives in the embed description,
    // without one it lives in the message content.
    const payload = useEmbed ? { content: null, embeds: [embed] } : { content: text, embeds: [] };

    for (const channelId of channelIds) {
      try {
        const channel = await this.resolveChannel(channelId);
        if (!channel?.isTextBased?.()) {
          this.logger.warn('Welcome channel is not usable', { channelId });
          continue;
        }
        await channel.send(payload);
        sent += 1;
      } catch (err) {
        this.logger.warn('Could not send a welcome/goodbye message', { channelId, reason: err.message });
      }
    }
    return sent;
  }

  /**
   * Grant the configured auto roles, skipping anything at or above the bot's
   * own highest role.
   * @returns {Promise<string[]>} role ids actually granted
   */
  async #applyAutoRoles(member, config) {
    if (!config.autoRoles?.length) return [];
    if (!member?.roles?.add) return [];

    const granted = [];
    for (const roleId of config.autoRoles) {
      try {
        if (member.roles.cache?.has(roleId)) {
          granted.push(roleId);
          continue;
        }
        const role = member.guild.roles.cache.get(roleId);
        if (!role) {
          this.logger.warn('Auto role no longer exists', { guildId: member.guild.id, roleId });
          continue;
        }
        const me = member.guild.members.me;
        if (me && role.position >= me.roles.highest.position) {
          this.logger.warn('Skipping auto role above the bot hierarchy', {
            guildId: member.guild.id,
            roleId,
            rolePosition: role.position,
            botPosition: me.roles.highest.position,
          });
          continue;
        }
        await member.roles.add(roleId, 'xXx Family auto role');
        granted.push(roleId);
      } catch (err) {
        this.logger.warn('Could not grant an auto role', { roleId, reason: err.message });
      }
    }
    return granted;
  }

  /** @returns {Promise<boolean>} whether the DM was delivered */
  async #sendDm(member, config, values, t) {
    if (!config.dm?.enabled) return false;
    try {
      const text = renderTemplate(config.dm.message ?? t('common:welcome.dm'), values, { maxLength: LIMITS.messageContent });
      await member.send(text);
      return true;
    } catch (err) {
      // Closed DMs are the common case; a warning is enough.
      this.logger.debug('Welcome DM not delivered', { userId: member.id, reason: err.message });
      return false;
    }
  }

  async #audit(guildId, type, data) {
    if (!this.logging) return;
    try {
      await this.logging.log({
        guildId,
        type,
        target: { id: data.member.id, label: data.member.user?.username ?? data.member.displayName ?? null },
        reason: data.reason ?? null,
        locale: data.locale,
        evidence: data.evidence,
      });
    } catch (err) {
      this.logger.warn('Could not write the welcome audit record', { reason: err.message });
    }
  }

  /** Best-effort usage counter; never allowed to break the welcome flow. */
  async #bumpCounter(modelName, guildId) {
    const model = this.models?.[modelName];
    if (!model || !this.isDbReady()) return;
    await model.updateOne({ guildId }, { $inc: { 'meta.totalSent': 1 }, $set: { 'meta.lastTriggeredAt': new Date() } }).catch(() => null);
  }
}

export const welcomeService = new WelcomeService();

export default welcomeService;
