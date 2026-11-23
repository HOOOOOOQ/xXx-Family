/**
 * src/services/boosterService.js
 * ---------------------------------------------------------------------------
 * Server boosting: announcements, the booster role, milestone rewards,
 * leaderboard and history.
 *
 * Discord gives us only `member.premiumSince` on a `guildMemberUpdate`, and
 * clears it the moment a boost ends. Everything durable therefore has to be
 * reconstructed here and stored in BoosterRecord.
 *
 * Rules:
 *   - the booster role is only ever granted when it is below the bot's highest
 *     role; otherwise Discord rejects it and the "thank you" message would be
 *     a lie
 *   - milestone rewards are granted from `totalMonths` and recorded in
 *     `rewardsClaimed`, so re-boosting cannot farm the same reward twice
 *   - nothing throws: a failed announcement must not break the member update
 */

import { getLogger } from '../utils/logger.js';
import { renderTemplate } from '../utils/templates.js';
import { brandEmbed } from '../utils/embeds.js';
import { COLORS, LIMITS } from '../config/constants.js';
import { formatDuration, discordTimestamp } from '../utils/format.js';
import { DatabaseError } from '../utils/errors.js';
import { monthsBetween } from '../database/models/BoosterRecord.js';
import { DEFAULT_BOOSTER_CONFIG } from '../database/models/BoosterConfig.js';

export class BoosterService {
  /**
   * @param {object} [deps]
   * @param {object} [deps.models]  BoosterConfig / BoosterRecord
   * @param {import('./loggingService.js').LoggingService} [deps.logging]
   * @param {import('./localeService.js').LocaleService} [deps.localeService]
   * @param {(id:string)=>Promise<any>} [deps.resolveChannel]
   * @param {() => boolean} [deps.isDbReady]
   */
  constructor(deps = {}) {
    this.models = deps.models ?? {};
    this.logging = deps.logging ?? null;
    this.localeService = deps.localeService ?? null;
    this.resolveChannel = deps.resolveChannel ?? (async () => null);
    this.isDbReady = deps.isDbReady ?? (() => true);
    this.logger = (deps.logger ?? getLogger()).child('booster');
    this.metrics = deps.metrics ?? null;
  }

  /** @returns {Promise<typeof DEFAULT_BOOSTER_CONFIG>} */
  async getConfig(guildId) {
    if (!this.isDbReady() || !this.models.BoosterConfig) return { ...DEFAULT_BOOSTER_CONFIG, guildId };
    const doc = await this.models.BoosterConfig.findOne({ guildId }).lean().catch(() => null);
    if (!doc) return { ...DEFAULT_BOOSTER_CONFIG, guildId };
    return {
      ...DEFAULT_BOOSTER_CONFIG,
      ...doc,
      messages: { ...DEFAULT_BOOSTER_CONFIG.messages, ...(doc.messages ?? {}) },
      embed: { ...DEFAULT_BOOSTER_CONFIG.embed, ...(doc.embed ?? {}) },
      role: { ...DEFAULT_BOOSTER_CONFIG.role, ...(doc.role ?? {}) },
      dm: { ...DEFAULT_BOOSTER_CONFIG.dm, ...(doc.dm ?? {}) },
      leaderboard: { ...DEFAULT_BOOSTER_CONFIG.leaderboard, ...(doc.leaderboard ?? {}) },
      rewards: doc.rewards ?? [],
    };
  }

  /**
   * React to a boost starting or ending.
   *
   * @param {import('discord.js').GuildMember} member
   * @param {Date|null} previousSince value of premiumSince before the update
   * @param {Date|null} currentSince  value after
   * @returns {Promise<{ action:'start'|'end'|null, months?:number, rewards?:string[], announced?:boolean }>}
   */
  async handleBoostChange(member, previousSince, currentSince) {
    const wasBoosting = Boolean(previousSince);
    const isBoosting = Boolean(currentSince);
    if (wasBoosting === isBoosting) return { action: null };

    // A member who was already boosting and is still boosting, but with a new
    // `premiumSince` (a renewal), is not a new booster.
    if (wasBoosting && isBoosting) return { action: null };

    return isBoosting
      ? this.#handleStart(member, currentSince)
      : this.#handleEnd(member, previousSince);
  }

  /** @returns {Promise<{ action:'start', announced:boolean, roleGranted:boolean }>} */
  async #handleStart(member, since) {
    const guild = member.guild;
    this.metrics?.increment('booster.start');

    const record = await this.#recordStart(guild.id, member, since);
    const config = await this.getConfig(guild.id);

    const roleGranted = await this.#grantBoosterRole(member, config);
    const announced = await this.#announce(member, config, 'start', { since });
    const dmed = await this.#dm(member, config, 'start');

    await this.#audit(guild, 'booster.start', member, {
      months: 0,
      streaks: record?.streaks ?? 1,
      roleGranted,
      announced,
      dmed,
    });

    return { action: 'start', announced, roleGranted };
  }

  /** @returns {Promise<{ action:'end', months:number, rewards:string[], announced:boolean }>} */
  async #handleEnd(member, since) {
    const guild = member.guild;
    this.metrics?.increment('booster.end');

    const months = monthsBetween(since ?? new Date());
    const { totalMonths, claimed } = await this.#recordEnd(guild.id, member, months);

    const config = await this.getConfig(guild.id);
    if (config.role.revokeOnEnd) await this.#revokeBoosterRole(member, config);

    // Milestone rewards are granted when the streak ends, because that is the
    // first moment the final length is known.
    const rewards = await this.#grantRewards(member, config, totalMonths, claimed);
    const announced = await this.#announce(member, config, 'end', { months, totalMonths });

    await this.#audit(guild, 'booster.end', member, { months, totalMonths, rewards, announced });

    return { action: 'end', months, rewards, announced };
  }

  /** Upsert the live record, incrementing the streak count on a re-boost. */
  async #recordStart(guildId, member, since) {
    const model = this.models.BoosterRecord;
    if (!model || !this.isDbReady()) return null;

    try {
      const existing = await model.findOne({ guildId, userId: member.id }).lean();
      if (existing?.current) return existing;

      return await model.findOneAndUpdate(
        { guildId, userId: member.id },
        {
          $set: {
            guildId,
            userId: member.id,
            username: member.user?.username ?? null,
            since,
            until: null,
            current: true,
            'meta.lastSeenAt': new Date(),
            'meta.notifiedEnd': false,
          },
          $inc: { streaks: 1 },
          $setOnInsert: { totalMonths: 0, rewardsClaimed: [] },
        },
        { upsert: true, new: true },
      ).lean();
    } catch (err) {
      this.logger.errorFrom(err, 'Could not record a boost start', { guildId, userId: member.id });
      return null;
    }
  }

  /**
   * Close the live record and fold this streak into the lifetime total.
   *
   * Returns the thresholds already claimed so the caller can grant only the new
   * ones — without that, re-boosting would farm every milestone again.
   * @returns {Promise<{ totalMonths:number, claimed:number[] }>}
   */
  async #recordEnd(guildId, member, months) {
    const model = this.models.BoosterRecord;
    if (!model || !this.isDbReady()) return { totalMonths: months, claimed: [] };

    try {
      const existing = await model.findOne({ guildId, userId: member.id }).lean();
      if (!existing) return { totalMonths: months, claimed: [] };

      await model.updateOne(
        { guildId, userId: member.id },
        {
          $set: { until: new Date(), current: false, 'meta.lastSeenAt': new Date() },
          $inc: { totalMonths: months },
        },
      );

      return {
        totalMonths: (existing.totalMonths ?? 0) + months,
        claimed: existing.rewardsClaimed ?? [],
      };
    } catch (err) {
      this.logger.errorFrom(err, 'Could not record a boost end', { guildId, userId: member.id });
      return { totalMonths: months, claimed: [] };
    }
  }

  /**
   * Grant every milestone reward whose threshold has been reached and which has
   * not already been claimed.
   * @param {number[]} [claimed] month thresholds already handed out
   * @returns {Promise<string[]>} role ids actually granted
   */
  async #grantRewards(member, config, totalMonths, claimed = []) {
    if (!config.rewards?.length) return [];
    const already = new Set(claimed);
    const granted = [];

    for (const reward of config.rewards) {
      if (totalMonths < reward.months) continue;
      if (already.has(reward.months)) continue;

      const ok = await this.#grantRole(member, reward.roleId, `xXx Family booster reward (${reward.months} months)`);
      if (ok) {
        granted.push(reward.roleId);
        await this.#markRewardClaimed(member.guild.id, member.id, reward.months);
      }
    }

    return granted;
  }

  /** @returns {Promise<boolean>} */
  async #grantBoosterRole(member, config) {
    if (!config.role?.id) return false;
    return this.#grantRole(member, config.role.id, 'xXx Family booster role');
  }

  /** @returns {Promise<boolean>} */
  async #grantRole(member, roleId, reason) {
    if (!roleId || !member?.roles?.add) return false;
    try {
      if (member.roles.cache?.has(roleId)) return true;

      const role = member.guild.roles.cache?.get(roleId);
      const me = member.guild.members.me;
      if (me && role && role.position >= me.roles.highest.position) {
        this.logger.warn('Skipping a booster role above the bot hierarchy', {
          guildId: member.guild.id,
          roleId,
          rolePosition: role.position,
          botPosition: me.roles.highest.position,
        });
        return false;
      }

      await member.roles.add(roleId, reason);
      return true;
    } catch (err) {
      this.logger.warn('Could not grant a booster role', { roleId, reason: err.message });
      return false;
    }
  }

  async #revokeBoosterRole(member, config) {
    if (!config.role?.id || !member?.roles?.remove) return false;
    try {
      if (!member.roles.cache?.has(config.role.id)) return false;
      await member.roles.remove(config.role.id, 'xXx Family boost ended');
      return true;
    } catch (err) {
      this.logger.warn('Could not revoke the booster role', { reason: err.message });
      return false;
    }
  }

  async #markRewardClaimed(guildId, userId, months) {
    const model = this.models.BoosterRecord;
    if (!model || !this.isDbReady()) return;
    await model
      .updateOne({ guildId, userId: userId }, { $addToSet: { rewardsClaimed: months } })
      .catch((err) => this.logger.warn('Could not mark a reward claimed', { months, reason: err.message }));
  }

  /**
   * Announce a boost start or end.
   * @returns {Promise<boolean>} whether the message was delivered
   */
  async #announce(member, config, kind, extra = {}) {
    if (!config.enabled || !config.channelId) return false;

    try {
      const ctx = await this.#locale(member.guild, config.language);
      const t = ctx.t;
      const values = this.#templateValues(member, t, extra);

      const key = kind === 'start' ? 'common:booster.start' : 'common:booster.end';
      const text = renderTemplate(config.messages[kind] ?? t(key), values, { maxLength: LIMITS.messageContent });

      const embed = config.embed?.enabled
        ? brandEmbed({
            t,
            dir: ctx.dir,
            color: config.embed.color ?? (kind === 'start' ? COLORS.neon : COLORS.silver),
            title: t(kind === 'start' ? 'common:booster.titleStart' : 'common:booster.titleEnd'),
            description: text,
            thumbnail: config.embed.showAvatar ? member.user?.displayAvatarURL?.({ size: 256 }) ?? undefined : undefined,
          })
        : null;

      const channel = await this.resolveChannel(config.channelId);
      if (!channel?.isTextBased?.()) {
        this.logger.warn('Booster channel is not usable', { channelId: config.channelId });
        return false;
      }

      await channel.send({ content: embed ? null : text, embeds: embed ? [embed] : [] });

      const model = this.models.BoosterConfig;
      if (model && this.isDbReady()) {
        await model.updateOne({ guildId: member.guild.id }, { $inc: { 'meta.totalAnnounced': 1 } }).catch(() => null);
      }
      this.metrics?.increment(`booster.announced.${kind}`);
      return true;
    } catch (err) {
      this.logger.warn('Could not announce a boost', { kind, reason: err.message });
      return false;
    }
  }

  /** @returns {Promise<boolean>} */
  async #dm(member, config, kind) {
    if (!config.dm?.enabled || kind !== 'start') return false;
    try {
      const ctx = await this.#locale(member.guild, config.language);
      const values = this.#templateValues(member, ctx.t, {});
      const text = renderTemplate(config.dm.message ?? ctx.t('common:booster.dm'), values, {
        maxLength: LIMITS.messageContent,
      });
      await member.send(text);
      return true;
    } catch (err) {
      this.logger.debug('Booster DM not delivered', { userId: member.id, reason: err.message });
      return false;
    }
  }

  #templateValues(member, t, extra = {}) {
    const guild = member.guild;
    const since = extra.since ?? member.premiumSince ?? null;
    return {
      user: {
        mention: `<@${member.id}>`,
        name: member.user?.displayName ?? member.user?.username ?? 'unknown',
        avatar: member.user?.displayAvatarURL?.({ size: 256 }) ?? null,
      },
      server: {
        name: guild?.name ?? 'unknown',
        boostCount: guild?.premiumSubscriptionCount ?? 0,
        boostTier: guild?.premiumTier ?? 0,
      },
      months: extra.months ?? 0,
      totalMonths: extra.totalMonths ?? 0,
      since: since ? discordTimestamp(since, 'R') : null,
      duration: extra.months ? formatDuration(extra.months * 30 * 86400_000, t, { maxUnits: 2 }) : null,
    };
  }

  async #locale(guild, override) {
    if (this.localeService) {
      try {
        if (override) return this.localeService.buildContext(override, 'override');
        return await this.localeService.resolveForGuild(guild.id);
      } catch (err) {
        this.logger.warn('Could not resolve the booster locale', { reason: err.message });
      }
    }
    const { getLocaleContext } = await import('./i18nService.js');
    return getLocaleContext(override ?? 'en-US');
  }

  async #audit(guild, type, member, evidence) {
    if (!this.logging) return;
    try {
      await this.logging.log({
        guildId: guild.id,
        type,
        target: { id: member.id, label: member.user?.username ?? null },
        evidence,
      });
    } catch (err) {
      this.logger.warn('Could not write the booster audit record', { reason: err.message });
    }
  }

  /**
   * Current boosters, longest first.
   * @returns {Promise<{ userId:string, username:string|null, since:Date, months:number }[]>}
   */
  async getLeaderboard(guildId, limit = 10) {
    const model = this.models.BoosterRecord;
    if (!model || !this.isDbReady()) return [];

    const safeLimit = Math.min(Math.max(1, Number(limit) || 10), 25);
    const rows = await model
      .find({ guildId, current: true })
      .sort({ since: 1 })
      .limit(safeLimit)
      .lean()
      .catch((err) => {
        this.logger.warn('Could not read the booster leaderboard', { reason: err.message });
        return [];
      });

    return rows.map((row) => ({
      userId: row.userId,
      username: row.username,
      since: row.since,
      months: monthsBetween(row.since),
    }));
  }

  /** @returns {Promise<{ boosters:number, lifetime:number, totalMonths:number, tier:number|null, boostCount:number|null }>} */
  async getStats(guildId, guild = null) {
    const model = this.models.BoosterRecord;
    if (!model || !this.isDbReady()) {
      return {
        boosters: 0,
        lifetime: 0,
        totalMonths: 0,
        tier: guild?.premiumTier ?? null,
        boostCount: guild?.premiumSubscriptionCount ?? null,
      };
    }

    const [boosters, lifetime, months] = await Promise.all([
      model.countDocuments({ guildId, current: true }).catch(() => 0),
      model.countDocuments({ guildId }).catch(() => 0),
      model.aggregate([{ $match: { guildId } }, { $group: { _id: null, total: { $sum: '$totalMonths' } } }]).catch(() => []),
    ]);

    return {
      boosters,
      lifetime,
      totalMonths: months[0]?.total ?? 0,
      tier: guild?.premiumTier ?? null,
      boostCount: guild?.premiumSubscriptionCount ?? null,
    };
  }

  /**
   * One member's boost history in this guild.
   * @returns {Promise<{ since:Date, until:Date|null, current:boolean, months:number }[]>}
   */
  async getHistory(guildId, userId) {
    const model = this.models.BoosterRecord;
    if (!model || !this.isDbReady()) return [];
    const rows = await model.find({ guildId, userId: userId }).sort({ since: -1 }).lean().catch(() => []);
    return rows.map((row) => ({
      since: row.since,
      until: row.until,
      current: row.current,
      months: monthsBetween(row.since, row.until ?? new Date()),
    }));
  }

  /** @returns {Promise<object>} the effective config after the update */
  async saveConfig(guildId, patch, updatedBy = null) {
    const model = this.models?.BoosterConfig;
    if (!model) throw new DatabaseError('BoosterConfig is not available', { i18nKey: 'errors:database' });
    if (!this.isDbReady()) {
      throw new DatabaseError('Booster configuration requires a database connection', { i18nKey: 'errors:database' });
    }

    const set = { ...patch };
    if (updatedBy) set['meta.updatedBy'] = updatedBy;

    await model.findOneAndUpdate({ guildId }, { $set: set, $setOnInsert: { guildId } }, { upsert: true, new: true });
    this.logger.info('Booster configuration updated', { guildId, keys: Object.keys(patch), updatedBy });
    return this.getConfig(guildId);
  }
}

export const boosterService = new BoosterService();

export default boosterService;
