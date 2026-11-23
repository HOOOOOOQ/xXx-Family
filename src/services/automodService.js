/**
 * src/services/automodService.js
 * ---------------------------------------------------------------------------
 * Message screening that runs before a human moderator sees anything.
 *
 * Complements Discord's own AutoMod rather than replacing it: these rules cover
 * behaviour Discord does not model — repeated identical messages, mention spam,
 * excessive caps — and they produce a moderation case, so a moderator can see
 * why a message disappeared.
 *
 * The scanner is a pure function: `scan(message, config)` returns the rules it
 * matched and never touches the network. Enforcement is a separate method, so
 * the rules can be tested exhaustively without a gateway and reused from the
 * dashboard's rule-preview UI.
 *
 * Deliberately absent: content-based moderation of opinions, and any rule that
 * inspects DMs. Private channels are out of scope by design.
 */

import { getLogger } from '../utils/logger.js';

/** Rule kinds the scanner understands. */
export const AUTOMOD_RULES = Object.freeze([
  'spam',
  'mentions',
  'links',
  'invites',
  'caps',
  'words',
  'repeats',
]);

/** What automod may do when a rule fires. */
export const AUTOMOD_ACTIONS = Object.freeze(['delete', 'warn', 'timeout']);

export const DEFAULT_AUTOMOD_CONFIG = Object.freeze({
  enabled: false,
  /** Roles that are never screened. */
  whitelistRoleIds: Object.freeze([]),
  rules: Object.freeze({
    spam: Object.freeze({ enabled: true, threshold: 4, windowMs: 10_000, action: 'delete' }),
    mentions: Object.freeze({ enabled: true, threshold: 6, action: 'delete' }),
    links: Object.freeze({ enabled: false, action: 'delete' }),
    invites: Object.freeze({ enabled: true, action: 'delete' }),
    caps: Object.freeze({ enabled: true, threshold: 70, minLength: 20, action: 'delete' }),
    words: Object.freeze({ enabled: false, list: Object.freeze([]), action: 'delete' }),
    repeats: Object.freeze({ enabled: false, threshold: 3, action: 'delete' }),
  }),
});

/** Matches a Discord invite link in any of its common spellings. */
const INVITE_RE = /\b(?:discord(?:\.gg|app\.com\/invite|\.com\/invite)\/)[\w-]{2,}\b/i;
/** Any http(s) link. */
const LINK_RE = /\bhttps?:\/\/[^\s<>"']{4,}/i;

/**
 * Letters are what caps-ratio is measured against. Digits, punctuation and
 * emoji are excluded so "LMAOOO123!!" is judged on its letters, and so a
 * message of pure emoji is never treated as shouting.
 */
const LETTER_RE = /\p{L}/gu;

export class AutomodService {
  /** guildId:userId -> message timestamps, for the spam window. */
  #recent = new Map();

  /** guildId:userId -> last message content, for repeated-message spam. */
  #last = new Map();

  /** guildId:userId -> consecutive repeat count. */
  #repeatCounts = new Map();

  /**
   * @param {object} [deps]
   * @param {import('./moderationService.js').ModerationService} [deps.moderation]
   * @param {import('./settingsService.js').SettingsService} [deps.settings]
   */
  constructor(deps = {}) {
    this.moderation = deps.moderation ?? null;
    this.settings = deps.settings ?? null;
    this.logger = (deps.logger ?? getLogger()).child('automod');
    this.metrics = deps.metrics ?? null;
  }

  /** Merge stored config over the defaults, tolerating partial documents. */
  effectiveConfig(stored) {
    const base = DEFAULT_AUTOMOD_CONFIG;
    if (!stored) return base;
    const rules = {};
    for (const key of AUTOMOD_RULES) {
      rules[key] = { ...base.rules[key], ...(stored.rules?.[key] ?? {}) };
      if (rules[key].list) rules[key].list = [...rules[key].list];
    }
    return {
      enabled: stored.enabled ?? base.enabled,
      whitelistRoleIds: [...(stored.whitelistRoleIds ?? base.whitelistRoleIds)],
      rules,
    };
  }

  /** @returns {Promise<object>} the effective config for a guild */
  async getConfig(guildId) {
    if (!this.settings) return DEFAULT_AUTOMOD_CONFIG;
    const stored = await this.settings.getAutomodConfig?.(guildId).catch(() => null);
    return this.effectiveConfig(stored);
  }

  /**
   * Screen one message.
   *
   * @param {object} message a discord.js Message
   * @param {object} config from effectiveConfig()
   * @returns {{ matched:string[], action:string|null, details:object }}
   */
  scan(message, config) {
    const matched = [];
    const details = {};

    const content = message?.content ?? '';
    const guildId = message?.guild?.id ?? message?.guildId ?? 'unknown';
    const userId = message?.author?.id ?? 'unknown';

    // A webhook, bot or system message is never screened — a bot posting a
    // long line of text is not spam.
    if (message?.author?.bot || message?.webhookId || message?.system) {
      return { matched, action: null, details: {}, skipped: 'author' };
    }

    const rules = config?.rules ?? {};

    if (rules.invites?.enabled && INVITE_RE.test(content)) {
      matched.push('invites');
    }

    if (rules.links?.enabled && LINK_RE.test(content)) {
      matched.push('links');
    }

    const mentions = message?.mentions?.users?.size ?? 0;
    const roleMentions = message?.mentions?.roles?.size ?? 0;
    const totalMentions = mentions + roleMentions;
    if (rules.mentions?.enabled && totalMentions > rules.mentions.threshold) {
      matched.push('mentions');
      details.mentions = totalMentions;
    }

    if (rules.caps?.enabled && content.length >= (rules.caps.minLength ?? 20)) {
      const letters = content.match(LETTER_RE) ?? [];
      // Guard against a message with no letters at all (emoji, numbers), where
      // the ratio would otherwise be 0/0 = NaN.
      if (letters.length > 0) {
        const upper = letters.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length;
        const ratio = Math.round((upper / letters.length) * 100);
        if (ratio >= (rules.caps.threshold ?? 70)) {
          matched.push('caps');
          details.capsRatio = ratio;
        }
      }
    }

    if (rules.words?.enabled && Array.isArray(rules.words.list) && rules.words.list.length > 0) {
      const haystack = content.toLowerCase();
      const hits = rules.words.list.filter((word) => {
        if (!word) return false;
        // Word boundaries, so "ass" does not catch "assignment".
        const pattern = new RegExp(`(?:^|[^\\p{L}])${escapeRegex(String(word).toLowerCase())}(?:$|[^\\p{L}])`, 'iu');
        return pattern.test(haystack);
      });
      if (hits.length > 0) {
        matched.push('words');
        details.words = hits.length;
      }
    }

    if (rules.repeats?.enabled) {
      const key = `${guildId}:${userId}`;
      const previous = this.#last.get(key);
      const trimmed = content.trim().toLowerCase();
      if (trimmed.length > 0 && trimmed === previous) {
        const count = (this.#repeatCounts.get(key) ?? 1) + 1;
        this.#repeatCounts.set(key, count);
        if (count >= (rules.repeats.threshold ?? 3)) {
          matched.push('repeats');
          details.repeats = count;
        }
      } else {
        this.#repeatCounts.set(key, 1);
      }
      this.#last.set(key, trimmed || null);
    }

    if (rules.spam?.enabled) {
      const key = `${guildId}:${userId}`;
      const now = Date.now();
      const window = (this.#recent.get(key) ?? []).filter((ts) => now - ts < (rules.spam.windowMs ?? 10_000));
      window.push(now);
      this.#recent.set(key, window);
      if (window.length >= (rules.spam.threshold ?? 4)) {
        matched.push('spam');
        details.messages = window.length;
        details.windowMs = rules.spam.windowMs ?? 10_000;
      }
    }

    if (matched.length === 0) return { matched, action: null, details };

    // The strictest action among the rules that fired wins.
    const action = this.#strictestAction(matched.map((name) => rules[name]?.action));
    return { matched, action, details };
  }

  #strictestAction(actions) {
    const present = new Set(actions.filter(Boolean));
    if (present.has('timeout')) return 'timeout';
    if (present.has('warn')) return 'warn';
    if (present.has('delete')) return 'delete';
    return 'delete';
  }

  /**
   * Screen and, when a rule fires, enforce.
   * @returns {Promise<{ matched:string[], action:string|null, enforced:boolean }>}
   */
  async process(message, { config = null, moderator = null } = {}) {
    const resolved = config ?? (await this.getConfig(message?.guild?.id));

    if (!resolved.enabled) return { matched: [], action: null, enforced: false, skipped: 'disabled' };

    if (this.#isWhitelisted(message, resolved)) {
      return { matched: [], action: null, enforced: false, skipped: 'whitelisted' };
    }

    const verdict = this.scan(message, resolved);
    if (!verdict.action) return { ...verdict, enforced: false };

    const enforced = await this.#enforce(message, verdict, moderator);
    this.metrics?.increment(`automod.${verdict.action}`);

    return { ...verdict, enforced };
  }

  /**
   * Carry out the action. Every step is best-effort: failing to delete one
   * message must not stop the rest of the scan, and it must never throw into
   * the messageCreate handler.
   * @returns {Promise<boolean>} whether anything was actually done
   */
  async #enforce(message, verdict, moderator) {
    let didSomething = false;

    if (message?.deletable && message?.delete) {
      try {
        await message.delete();
        didSomething = true;
      } catch (err) {
        this.logger.warn('Could not delete a flagged message', {
          messageId: message.id,
          reason: err.message,
        });
      }
    }

    if (verdict.action === 'delete') return didSomething;

    // warn and timeout need a moderation record, which needs a service.
    if (!this.moderation || !message.guild || !message.member) {
      this.logger.warn('Automod could not enforce beyond deletion — moderation service unavailable');
      return didSomething;
    }

    try {
      if (verdict.action === 'warn') {
        await this.moderation.warn({
          guild: message.guild,
          target: message.member,
          moderator: moderator ?? null,
          reason: `Automod: ${verdict.matched.join(', ')}`,
          notify: false,
        });
        didSomething = true;
      } else if (verdict.action === 'timeout') {
        // Short and non-negotiable: automod must not lock someone out for hours
        // on a false positive.
        await this.moderation.timeout({
          guild: message.guild,
          target: message.member,
          moderator: moderator ?? null,
          reason: `Automod: ${verdict.matched.join(', ')}`,
          durationMs: 5 * 60 * 1000,
          notify: false,
        });
        didSomething = true;
      }
    } catch (err) {
      // Most likely a hierarchy problem: automod must not throw because it
      // tried to warn a member above the bot.
      this.logger.warn('Automod enforcement failed', {
        action: verdict.action,
        userId: message.member?.id,
        reason: err.message,
      });
    }

    return didSomething;
  }

  #isWhitelisted(message, config) {
    const roleIds = message?.member?.roles?.cache?.keyArray?.() ?? [];
    // `cache` may be absent in a partial payload; fall back to a plain array.
    const ids = roleIds.length ? roleIds : (message?.member?.roles?.valueOf?.() ?? []);
    return config.whitelistRoleIds.some((id) => ids.includes(id));
  }

  /** Drop stale tracking state for a member (used on leave and in tests). */
  forget(guildId, userId) {
    const key = `${guildId}:${userId}`;
    this.#recent.delete(key);
    this.#last.delete(key);
    this.#repeatCounts.delete(key);
  }

  /** Drop all tracking state for a guild (used on guildDelete). */
  forgetGuild(guildId) {
    const prefix = `${guildId}:`;
    for (const store of [this.#recent, this.#last, this.#repeatCounts]) {
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) store.delete(key);
      }
    }
  }

  /** How many members are currently being tracked. Exposed for the health probe. */
  trackedMembers() {
    return this.#recent.size;
  }
}

/** Escape a string for use inside a RegExp. */
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const automodService = new AutomodService();

export default automodService;
