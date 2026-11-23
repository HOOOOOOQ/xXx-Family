import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  AutomodService,
  AUTOMOD_RULES,
  AUTOMOD_ACTIONS,
  DEFAULT_AUTOMOD_CONFIG,
} from '../../src/services/automodService.js';

/** A minimal message that carries everything the scanner reads. */
function msg(content, { authorId = 'u1', guildId = 'g1', bot = false, mentions = [], roles = [], webhookId = null, system = false } = {}) {
  return {
    id: `m${Math.random().toString(36).slice(2)}`,
    content,
    system,
    webhookId,
    guild: { id: guildId },
    author: { id: authorId, bot },
    mentions: { users: { size: mentions.length }, roles: { size: roles.length } },
    member: { id: authorId, roles: { cache: { keyArray: () => [] } } },
    deletable: true,
    deleted: false,
    async delete() {
      this.deleted = true;
    },
  };
}

/** Config with a single rule enabled, everything else off. */
function only(rule, overrides = {}) {
  const config = {
    enabled: true,
    whitelistRoleIds: [],
    rules: Object.fromEntries(AUTOMOD_RULES.map((name) => [name, { ...DEFAULT_AUTOMOD_CONFIG.rules[name], enabled: false }])),
  };
  config.rules[rule] = { ...DEFAULT_AUTOMOD_CONFIG.rules[rule], enabled: true, ...overrides };
  return config;
}

describe('AutomodService.scan', () => {
  let service;
  beforeEach(() => {
    service = new AutomodService();
  });

  describe('skipped senders', () => {
    test('bot messages are never screened', () => {
      const config = only('links');
      const result = service.scan(msg('see https://example.com', { bot: true }), config);
      assert.deepEqual(result.matched, []);
      assert.equal(result.skipped, 'author');
    });

    test('webhook messages are never screened', () => {
      const result = service.scan(msg('https://example.com', { webhookId: 'wh1' }), only('links'));
      assert.equal(result.skipped, 'author');
    });

    test('system messages are never screened', () => {
      const result = service.scan(msg('joined the server', { system: true }), only('links'));
      assert.equal(result.skipped, 'author');
    });
  });

  describe('invites', () => {
    test('catches the common invite spellings', () => {
      const config = only('invites');
      for (const text of [
        'join discord.gg/abcdef',
        'discord.com/invite/abcdef',
        'discordapp.com/invite/abcdef',
        'check DISCORD.GG/ABCDEF',
      ]) {
        assert.ok(service.scan(msg(text), config).matched.includes('invites'), `missed: ${text}`);
      }
    });

    test('does not fire on an ordinary mention of the word', () => {
      const result = service.scan(msg('I love discord.gg', ), only('invites'));
      assert.deepEqual(result.matched, []);
    });

    test('a normal link is not an invite', () => {
      const result = service.scan(msg('https://github.com/example/repo'), only('invites'));
      assert.deepEqual(result.matched, []);
    });
  });

  describe('links', () => {
    test('catches http and https links', () => {
      const config = only('links');
      assert.ok(service.scan(msg('go to https://example.com/page'), config).matched.includes('links'));
      assert.ok(service.scan(msg('http://example.com'), config).matched.includes('links'));
    });

    test('bare domains without a scheme are not links', () => {
      assert.deepEqual(service.scan(msg('visit example.com sometime'), only('links')).matched, []);
    });
  });

  describe('mentions', () => {
    test('fires above the threshold', () => {
      const config = only('mentions', { threshold: 3 });
      const result = service.scan(msg('hi', { mentions: ['a', 'b', 'c', 'd'] }), config);
      assert.deepEqual(result.matched, ['mentions']);
      assert.equal(result.details.mentions, 4);
    });

    test('does not fire at exactly the threshold', () => {
      const config = only('mentions', { threshold: 3 });
      assert.deepEqual(service.scan(msg('hi', { mentions: ['a', 'b', 'c'] }), config).matched, []);
    });

    test('role mentions count too', () => {
      const config = only('mentions', { threshold: 2 });
      const result = service.scan(msg('hi', { mentions: ['a'], roles: ['b', 'c'] }), config);
      assert.deepEqual(result.matched, ['mentions']);
      assert.equal(result.details.mentions, 3);
    });

    test('a missing mentions collection does not crash the scan', () => {
      const message = msg('hi');
      delete message.mentions;
      assert.deepEqual(service.scan(message, only('mentions', { threshold: 1 })).matched, []);
    });
  });

  describe('caps', () => {
    test('fires on shouting', () => {
      const config = only('caps', { threshold: 70, minLength: 20 });
      const result = service.scan(msg('THIS IS AN ENORMOUS SHOUTING MESSAGE'), config);
      assert.deepEqual(result.matched, ['caps']);
      assert.equal(result.details.capsRatio, 100);
    });

    test('normal prose does not fire', () => {
      const config = only('caps', { threshold: 70, minLength: 20 });
      assert.deepEqual(service.scan(msg('this is a perfectly ordinary sentence'), config).matched, []);
    });

    test('short messages are exempt even when fully capitalised', () => {
      const config = only('caps', { threshold: 70, minLength: 20 });
      assert.deepEqual(service.scan(msg('LOL OK'), config).matched, []);
    });

    test('emoji and numbers do not count as shouting', () => {
      // The ratio is measured over letters only; without that guard this would
      // be 0/0 = NaN, and NaN >= 70 is false, so it passed by accident.
      const config = only('caps', { threshold: 70, minLength: 20 });
      const result = service.scan(msg('1234567890 1234567890 !!!!!! ??????'), config);
      assert.deepEqual(result.matched, []);
      assert.equal(result.details.capsRatio, undefined);
    });

    test('a mostly-lowercase message with one capital word does not fire', () => {
      const config = only('caps', { threshold: 70, minLength: 20 });
      const result = service.scan(msg('i really did not expect THAT to happen at all'), config);
      assert.deepEqual(result.matched, []);
    });
  });

  describe('words', () => {
    test('matches a banned word', () => {
      const config = only('words', { list: ['badword', 'other'] });
      assert.deepEqual(service.scan(msg('this is a badword here'), config).matched, ['words']);
    });

    test('matches regardless of case', () => {
      const config = only('words', { list: ['badword'] });
      assert.deepEqual(service.scan(msg('BADWORD!'), config).matched, ['words']);
    });

    test('a substring is not a match', () => {
      // "ass" must not catch "assignment"; that false positive is what makes
      // word lists unusable.
      const config = only('words', { list: ['ass'] });
      assert.deepEqual(service.scan(msg('please finish the assignment today'), config).matched, []);
    });

    test('a word at the start or end of the message matches', () => {
      const config = only('words', { list: ['badword'] });
      assert.deepEqual(service.scan(msg('badword at the start'), config).matched, ['words']);
      assert.deepEqual(service.scan(msg('it ends with badword'), config).matched, ['words']);
    });

    test('a regex metacharacter in the list is treated literally', () => {
      const config = only('words', { list: ['a.c'] });
      assert.deepEqual(service.scan(msg('a.c is flagged'), config).matched, ['words']);
      // The "." must not act as a wildcard.
      assert.deepEqual(service.scan(msg('abc is not flagged'), config).matched, []);
    });

    test('an empty list never fires', () => {
      assert.deepEqual(service.scan(msg('anything at all'), only('words', { list: [] })).matched, []);
    });
  });

  describe('spam', () => {
    test('fires once the window fills', () => {
      const config = only('spam', { threshold: 3, windowMs: 10_000 });
      assert.deepEqual(service.scan(msg('a'), config).matched, []);
      assert.deepEqual(service.scan(msg('b'), config).matched, []);
      const third = service.scan(msg('c'), config);
      assert.deepEqual(third.matched, ['spam']);
      assert.equal(third.details.messages, 3);
    });

    test('different users do not share a counter', () => {
      const config = only('spam', { threshold: 2, windowMs: 10_000 });
      service.scan(msg('a', { authorId: 'u1' }), config);
      const other = service.scan(msg('b', { authorId: 'u2' }), config);
      assert.deepEqual(other.matched, [], 'u2 must not be flagged for u1’s messages');
    });

    test('different guilds do not share a counter', () => {
      const config = only('spam', { threshold: 2, windowMs: 10_000 });
      service.scan(msg('a', { guildId: 'g1' }), config);
      const other = service.scan(msg('b', { guildId: 'g2' }), config);
      assert.deepEqual(other.matched, []);
    });

    test('forget() clears a member’s history', () => {
      const config = only('spam', { threshold: 2, windowMs: 10_000 });
      service.scan(msg('a'), config);
      service.forget('g1', 'u1');
      assert.deepEqual(service.scan(msg('b'), config).matched, []);
    });

    test('forgetGuild() clears only that guild', () => {
      const config = only('spam', { threshold: 2, windowMs: 10_000 });
      service.scan(msg('a', { guildId: 'g1' }), config);
      service.scan(msg('a', { guildId: 'g2' }), config);
      service.forgetGuild('g1');
      assert.equal(service.trackedMembers(), 1);
    });
  });

  describe('repeats', () => {
    test('fires when the same message is sent repeatedly', () => {
      const config = only('repeats', { threshold: 3 });
      assert.deepEqual(service.scan(msg('same thing'), config).matched, []);
      assert.deepEqual(service.scan(msg('same thing'), config).matched, []);
      assert.deepEqual(service.scan(msg('same thing'), config).matched, ['repeats']);
    });

    test('a different message resets the counter', () => {
      const config = only('repeats', { threshold: 3 });
      service.scan(msg('same thing'), config);
      service.scan(msg('same thing'), config);
      service.scan(msg('something else'), config);
      assert.deepEqual(service.scan(msg('same thing'), config).matched, []);
    });

    test('matching ignores surrounding whitespace and case', () => {
      const config = only('repeats', { threshold: 2 });
      service.scan(msg('  Same Thing  '), config);
      assert.deepEqual(service.scan(msg('same thing'), config).matched, ['repeats']);
    });

    test('an empty message never counts as a repeat', () => {
      const config = only('repeats', { threshold: 2 });
      service.scan(msg('   '), config);
      assert.deepEqual(service.scan(msg('   '), config).matched, []);
    });
  });

  describe('action selection', () => {
    test('the strictest action among the matched rules wins', () => {
      const config = {
        enabled: true,
        whitelistRoleIds: [],
        rules: {
          invites: { enabled: true, action: 'delete' },
          mentions: { enabled: true, threshold: 1, action: 'timeout' },
          spam: { enabled: false },
          links: { enabled: false },
          caps: { enabled: false },
          words: { enabled: false },
          repeats: { enabled: false },
        },
      };
      const result = service.scan(msg('discord.gg/abc', { mentions: ['a', 'b'] }), config);
      assert.deepEqual(result.matched.sort(), ['invites', 'mentions']);
      assert.equal(result.action, 'timeout');
    });

    test('warn beats delete', () => {
      const config = only('links', { action: 'warn' });
      assert.equal(service.scan(msg('https://example.com/x'), config).action, 'warn');
    });

    test('no match means no action', () => {
      assert.equal(service.scan(msg('hello there'), only('links')).action, null);
    });
  });
});

describe('AutomodService.process', () => {
  let moderation;
  let service;

  beforeEach(() => {
    moderation = {
      calls: [],
      async warn(args) {
        this.calls.push({ action: 'warn', ...args });
        return { caseNumber: 1 };
      },
      async timeout(args) {
        this.calls.push({ action: 'timeout', ...args });
        return { caseNumber: 2 };
      },
    };
    service = new AutomodService({ moderation });
  });

  test('does nothing when the guild has automod disabled', async () => {
    // `enabled: false` belongs on the config, not the rule: disabling one rule
    // is not the same as turning the module off for the server.
    const config = only('links');
    config.enabled = false;

    const result = await service.process(msg('https://example.com/x'), { config });

    assert.equal(result.skipped, 'disabled');
    assert.equal(result.enforced, false);
  });

  test('whitelisted roles are not screened', async () => {
    const message = msg('https://example.com/x');
    message.member.roles.cache.keyArray = () => ['role-1'];
    const config = only('links');
    config.whitelistRoleIds = ['role-1'];

    const result = await service.process(message, { config });

    assert.equal(result.skipped, 'whitelisted');
    assert.equal(message.deleted, false);
  });

  test('a delete action removes the message', async () => {
    const message = msg('https://example.com/x');
    const result = await service.process(message, { config: only('links') });

    assert.equal(message.deleted, true);
    assert.equal(result.enforced, true);
    assert.equal(moderation.calls.length, 0);
  });

  test('a warn action deletes and records a warning', async () => {
    const message = msg('https://example.com/x');
    await service.process(message, { config: only('links', { action: 'warn' }) });

    assert.equal(message.deleted, true);
    assert.equal(moderation.calls.length, 1);
    assert.equal(moderation.calls[0].action, 'warn');
    assert.match(moderation.calls[0].reason, /Automod: links/);
    assert.equal(moderation.calls[0].notify, false, 'automod must not DM on a false positive risk');
  });

  test('a timeout action is short', async () => {
    const message = msg('https://example.com/x');
    await service.process(message, { config: only('links', { action: 'timeout' }) });

    assert.equal(moderation.calls[0].action, 'timeout');
    assert.equal(moderation.calls[0].durationMs, 5 * 60 * 1000);
  });

  test('an undeletable message still escalates to a warning', async () => {
    // A message in a channel the bot cannot write to must not silently pass.
    const message = msg('https://example.com/x');
    message.deletable = false;
    const result = await service.process(message, { config: only('links', { action: 'warn' }) });

    assert.equal(result.enforced, true);
    assert.equal(moderation.calls.length, 1);
  });

  test('a failed delete does not throw or stop escalation', async () => {
    const message = msg('https://example.com/x');
    message.delete = async () => {
      throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
    };

    const result = await service.process(message, { config: only('links', { action: 'warn' }) });

    assert.equal(moderation.calls.length, 1, 'the warning must still be recorded');
    assert.equal(result.enforced, true);
  });

  test('a failed moderation call is contained', async () => {
    // The usual cause is hierarchy: automod must not throw because the bot
    // cannot moderate the member it flagged.
    moderation.warn = async () => {
      throw new Error('Missing Permissions');
    };
    const message = msg('https://example.com/x');

    const result = await service.process(message, { config: only('links', { action: 'warn' }) });

    assert.equal(result.matched.length, 1);
    assert.equal(result.enforced, true, 'the deletion still counted as enforcement');
  });

  test('without a moderation service it still deletes', async () => {
    const bare = new AutomodService();
    const message = msg('https://example.com/x');
    const result = await bare.process(message, { config: only('links', { action: 'warn' }) });

    assert.equal(message.deleted, true);
    assert.equal(result.enforced, true);
  });
});

describe('AutomodService.effectiveConfig', () => {
  const service = new AutomodService();

  test('returns the defaults for a null document', () => {
    assert.deepEqual(service.effectiveConfig(null), DEFAULT_AUTOMOD_CONFIG);
  });

  test('a partial document fills in the missing rules', () => {
    const config = service.effectiveConfig({ enabled: true, rules: { links: { enabled: true } } });
    assert.equal(config.enabled, true);
    assert.equal(config.rules.links.enabled, true);
    assert.equal(config.rules.links.action, 'delete', 'action must come from the defaults');
    assert.equal(config.rules.spam.enabled, true);
    assert.equal(config.rules.spam.threshold, 4);
  });

  test('a missing whitelist becomes an empty array, not undefined', () => {
    const config = service.effectiveConfig({ enabled: true });
    assert.deepEqual(config.whitelistRoleIds, []);
  });
});

describe('automod contracts', () => {
  test('every rule has a default', () => {
    for (const rule of AUTOMOD_RULES) {
      assert.ok(DEFAULT_AUTOMOD_CONFIG.rules[rule], `${rule} has no default`);
      assert.ok(AUTOMOD_ACTIONS.includes(DEFAULT_AUTOMOD_CONFIG.rules[rule].action), `${rule} has an unknown action`);
    }
  });

  test('automod is off by default', () => {
    // Screening members is a behaviour change; it must be opt-in.
    assert.equal(DEFAULT_AUTOMOD_CONFIG.enabled, false);
  });
});
