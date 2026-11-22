/**
 * src/middleware/cooldownManager.js
 * ---------------------------------------------------------------------------
 * Per-user command cooldowns, plus the permission/guild gating that runs before
 * any command body executes. Keeping these together means a command file only
 * declares its requirements; enforcement lives in one audited place.
 */

import { PermissionFlagsBits } from 'discord.js';

import { getLogger } from '../utils/logger.js';
import { PermissionDeniedError, RateLimitError } from '../utils/errors.js';
import { TokenBucket } from './rateLimiter.js';

/** Owner/admin bypass list — moderators should not lock themselves out. */
const BYPASS_PERMISSIONS = [PermissionFlagsBits.Administrator];

export class CooldownManager {
  /** @param {object} [options] @param {number} [options.maxKeys] */
  constructor(options = {}) {
    /** @type {Map<string, TokenBucket>} */
    this.buckets = new Map();
    this.maxKeys = options.maxKeys ?? 20_000;
  }

  #key(userId, commandName) {
    return `${userId}:${commandName}`;
  }

  /**
   * Consume one use.
   * @param {string} userId
   * @param {string} commandName
   * @param {number} cooldownMs
   * @returns {{ allowed:boolean, retryAfterMs:number|null, remaining:number }}
   */
  consume(userId, commandName, cooldownMs) {
    if (!cooldownMs || cooldownMs <= 0) return { allowed: true, retryAfterMs: null, remaining: 0 };
    const key = this.#key(userId, commandName);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket({ capacity: 1, refillMs: cooldownMs });
      this.buckets.set(key, bucket);
      while (this.buckets.size > this.maxKeys) {
        const oldest = this.buckets.keys().next().value;
        if (oldest === undefined) break;
        this.buckets.delete(oldest);
      }
    }
    return bucket.take(1);
  }

  /** Give the use back (used when a command aborts before doing real work). */
  refund(userId, commandName, cooldownMs) {
    if (!cooldownMs || cooldownMs <= 0) return false;
    const key = this.#key(userId, commandName);
    const bucket = this.buckets.get(key);
    if (!bucket) return false;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + 1);
    return true;
  }

  /** @param {string} userId @param {string} [commandName] */
  reset(userId, commandName) {
    if (commandName) return this.buckets.delete(this.#key(userId, commandName));
    let removed = 0;
    for (const key of this.buckets.keys()) {
      if (key.startsWith(`${userId}:`)) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed > 0;
  }

  /** @returns {{ keys:number }} */
  stats() {
    return { keys: this.buckets.size };
  }
}

export const cooldownManager = new CooldownManager();

/**
 * Enforce every pre-execution rule for a command.
 * Throws a localized AppError the interaction handler turns into a reply.
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {import('../handlers/commandLoader.js').CommandModule} command
 * @param {object} [deps]
 * @param {CooldownManager} [deps.cooldowns]
 * @param {string[]} [deps.ownerIds]
 */
export function enforceCommandGuards(interaction, command, deps = {}) {
  const logger = getLogger().child('guards');
  const cooldowns = deps.cooldowns ?? cooldownManager;
  const ownerIds = deps.ownerIds ?? [];

  const isOwner = ownerIds.includes(interaction.user?.id) || interaction.user?.id === interaction.client?.user?.id;

  if (command.guildOnly && !interaction.inGuild()) {
    throw new PermissionDeniedError('Command requires a guild context', { i18nKey: 'errors:guildOnly' });
  }
  if (command.dmOnly && interaction.inGuild()) {
    throw new PermissionDeniedError('Command requires a DM context', { i18nKey: 'errors:guildOnly' });
  }
  if (command.nsfwOnly && interaction.inGuild() && interaction.channel?.nsfw === false) {
    throw new PermissionDeniedError('Command requires an age-restricted channel', { i18nKey: 'errors:nsfwOnly' });
  }
  if (command.ownerOnly && !isOwner) {
    throw new PermissionDeniedError('Owner-only command', { i18nKey: 'errors:ownerOnly' });
  }

  // Permission checks only apply to members inside a guild.
  if (interaction.inGuild() && interaction.member?.permissions) {
    const memberPermissions = interaction.member.permissions;
    const hasBypass = BYPASS_PERMISSIONS.some((flag) => memberPermissions.has(flag));

    if (!hasBypass && command.userPermissions?.length) {
      const missing = command.userPermissions.filter((permission) => !memberPermissions.has(permission));
      if (missing.length) {
        throw new PermissionDeniedError(`Missing user permissions: ${missing.join(', ')}`, {
          i18nKey: 'errors:missingPermissions',
          details: { permissions: missing.join(', ') },
        });
      }
    }

    if (interaction.guild?.members?.me && command.botPermissions?.length) {
      const me = interaction.guild.members.me;
      const missing = command.botPermissions.filter((permission) => !me.permissions.has(permission));
      if (missing.length) {
        logger.warn('Bot is missing permissions for command', { command: command.name, missing });
        throw new PermissionDeniedError(`Missing bot permissions: ${missing.join(', ')}`, {
          i18nKey: 'errors:missingPermissionsBot',
          details: { permissions: missing.join(', ') },
        });
      }
    }
  }

  const cooldown = cooldowns.consume(interaction.user.id, command.name, command.cooldown ?? 0);
  if (!cooldown.allowed) {
    throw new RateLimitError(`Cooldown active for ${command.name}`, {
      i18nKey: 'errors:cooldown',
      retryAfterMs: cooldown.retryAfterMs,
      details: { seconds: Math.ceil((cooldown.retryAfterMs ?? 0) / 1000) },
    });
  }
}
