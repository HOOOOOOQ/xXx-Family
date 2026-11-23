/**
 * src/services/permissionService.js
 * ---------------------------------------------------------------------------
 * One place that decides whether an action is allowed.
 *
 * Discord will reject most of these anyway, but letting the call through
 * produces a Discord error the user cannot act on. Checking first means the
 * moderator is told *which* rule they hit, in their own language.
 *
 * The rules enforced here, in order:
 *   1. the actor must have the Discord permission the action requires
 *   2. the actor must outrank the target (role hierarchy)
 *   3. the bot must outrank the target and hold the permission itself
 *   4. nobody moderates the guild owner
 *
 * Nothing in here calls the Discord API — it is pure logic over the objects it
 * is handed, which is what makes it testable without a gateway.
 */

import { PermissionFlagsBits } from 'discord.js';

import { PermissionDeniedError } from '../utils/errors.js';

/** What each moderation action requires of the person running it. */
export const ACTION_PERMISSIONS = Object.freeze({
  ban: PermissionFlagsBits.BanMembers,
  unban: PermissionFlagsBits.BanMembers,
  kick: PermissionFlagsBits.KickMembers,
  timeout: PermissionFlagsBits.ModerateMembers,
  untimeout: PermissionFlagsBits.ModerateMembers,
  warn: PermissionFlagsBits.ModerateMembers,
  purge: PermissionFlagsBits.ManageMessages,
  slowmode: PermissionFlagsBits.ManageChannels,
  lock: PermissionFlagsBits.ManageChannels,
  unlock: PermissionFlagsBits.ManageChannels,
  quarantine: PermissionFlagsBits.ModerateMembers,
});

/** What the bot itself needs for the same actions. */
export const BOT_PERMISSIONS = Object.freeze({
  ban: PermissionFlagsBits.BanMembers,
  unban: PermissionFlagsBits.BanMembers,
  kick: PermissionFlagsBits.KickMembers,
  timeout: PermissionFlagsBits.ModerateMembers,
  untimeout: PermissionFlagsBits.ModerateMembers,
  warn: null,
  purge: PermissionFlagsBits.ManageMessages,
  slowmode: PermissionFlagsBits.ManageChannels,
  lock: PermissionFlagsBits.ManageChannels,
  unlock: PermissionFlagsBits.ManageChannels,
  quarantine: PermissionFlagsBits.ManageRoles,
});

/** Human-readable permission names for messages and logs. */
export const PERMISSION_NAMES = Object.freeze({
  [String(PermissionFlagsBits.BanMembers)]: 'BanMembers',
  [String(PermissionFlagsBits.KickMembers)]: 'KickMembers',
  [String(PermissionFlagsBits.ModerateMembers)]: 'ModerateMembers',
  [String(PermissionFlagsBits.ManageMessages)]: 'ManageMessages',
  [String(PermissionFlagsBits.ManageChannels)]: 'ManageChannels',
  [String(PermissionFlagsBits.ManageRoles)]: 'ManageRoles',
  [String(PermissionFlagsBits.ManageGuild)]: 'ManageGuild',
  [String(PermissionFlagsBits.Administrator)]: 'Administrator',
});

/** @param {bigint} flag */
export function permissionName(flag) {
  return PERMISSION_NAMES[String(flag)] ?? `0x${flag?.toString?.(16) ?? flag}`;
}

export class PermissionService {
  constructor(deps = {}) {
    this.logger = deps.logger ?? null;
  }

  /** Highest role position for a member, or -1 when unknown. */
  highestPosition(member) {
    const highest = member?.roles?.highest;
    return typeof highest?.position === 'number' ? highest.position : -1;
  }

  /** @param {bigint} permission */
  has(member, permission) {
    if (!permission) return true;
    const perms = member?.permissions;
    if (!perms) return false;
    // Administrator implicitly grants everything.
    if (perms.has?.(PermissionFlagsBits.Administrator)) return true;
    return Boolean(perms.has?.(permission));
  }

  /**
   * Can `actor` act on `target`?
   *
   * @returns {{ allowed:boolean, reason:string|null }}
   */
  canModerate(actor, target, guild) {
    if (!actor) return { allowed: false, reason: 'no actor' };
    if (!target) return { allowed: false, reason: 'no target' };
    if (actor.id === target.id) return { allowed: false, reason: 'self' };

    // The owner outranks every role, including Administrator.
    if (guild?.ownerId && target.id === guild.ownerId) {
      return { allowed: false, reason: 'owner' };
    }

    const actorPos = this.highestPosition(actor);
    const targetPos = this.highestPosition(target);
    if (actorPos <= targetPos) return { allowed: false, reason: 'hierarchy' };

    return { allowed: true, reason: null };
  }

  /**
   * Full gate for a moderation action. Throws a localized PermissionDeniedError
   * on the first rule that fails, so callers stay one-liners.
   *
   * @param {string} action key of ACTION_PERMISSIONS
   * @param {object} ctx
   * @param {object} ctx.actor   GuildMember running the command
   * @param {object} [ctx.target] GuildMember being acted on
   * @param {object} [ctx.guild]
   * @param {object} [ctx.bot]   the bot's own GuildMember
   * @throws {PermissionDeniedError}
   */
  assertCan(action, { actor, target = null, guild = null, bot = null }) {
    const required = ACTION_PERMISSIONS[action];
    if (!this.has(actor, required)) {
      throw new PermissionDeniedError(`Missing ${permissionName(required)} for ${action}`, {
        i18nKey: 'errors:missingPermissions',
        details: { permissions: permissionName(required), action },
      });
    }

    if (target) {
      const check = this.canModerate(actor, target, guild);
      if (!check.allowed) {
        // Each reason gets its own message: telling a moderator they are
        // "missing ModerateMembers" when they hold it and are simply
        // outranked sends them off fixing the wrong thing.
        const keyByReason = {
          self: 'errors:self',
          owner: 'errors:owner',
          hierarchy: 'errors:hierarchy',
        };
        const i18nKey = keyByReason[check.reason] ?? 'errors:missingPermissions';
        const details =
          i18nKey === 'errors:missingPermissions'
            ? { permissions: permissionName(required), action }
            : { target: `<@${target.id}>`, action };
        throw new PermissionDeniedError(`Cannot ${action} this member (${check.reason})`, {
          i18nKey,
          details,
        });
      }
    }

    const botRequired = BOT_PERMISSIONS[action];
    if (botRequired && !this.has(bot, botRequired)) {
      throw new PermissionDeniedError(`The bot is missing ${permissionName(botRequired)} for ${action}`, {
        i18nKey: 'errors:missingPermissionsBot',
        details: { permissions: permissionName(botRequired), action },
      });
    }

    if (target && bot) {
      const botPos = this.highestPosition(bot);
      const targetPos = this.highestPosition(target);
      if (botPos <= targetPos) {
        throw new PermissionDeniedError(
          `The bot cannot ${action} this member — their highest role is at or above the bot's`,
          {
            i18nKey: 'errors:hierarchyBot',
            details: { target: `<@${target.id}>`, action },
          },
        );
      }
    }

    return true;
  }

  /**
   * Can the bot manage this role? Used before granting or revoking anything.
   * @returns {boolean}
   */
  canManageRole(bot, role) {
    if (!role) return false;
    const botPos = this.highestPosition(bot);
    return botPos > (typeof role.position === 'number' ? role.position : Number.POSITIVE_INFINITY);
  }
}

export const permissionService = new PermissionService();

export default permissionService;
