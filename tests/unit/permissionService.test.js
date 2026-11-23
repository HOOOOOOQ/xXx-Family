import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';

import {
  PermissionService,
  ACTION_PERMISSIONS,
  BOT_PERMISSIONS,
  permissionName,
} from '../../src/services/permissionService.js';
import { PermissionDeniedError } from '../../src/utils/errors.js';
import { initI18n } from '../../src/services/i18nService.js';
import { LOCALE_CODES, DEFAULT_LOCALE } from '../../src/config/locales.js';

before(async () => {
  await initI18n({ locales: LOCALE_CODES, defaultLocale: DEFAULT_LOCALE });
});

/** A member with an explicit permission set and a highest role position. */
function member(id, { permissions = [], position = 1, username = id } = {}) {
  return {
    id,
    user: { username },
    roles: { highest: { position } },
    permissions: {
      has: (flag) => permissions.includes(String(flag)) || permissions.includes('ALL'),
    },
  };
}

describe('PermissionService', () => {
  const service = new PermissionService();

  describe('has', () => {
    test('true when the member holds the permission', () => {
      const mod = member('1', { permissions: [String(PermissionFlagsBits.BanMembers)] });
      assert.equal(service.has(mod, PermissionFlagsBits.BanMembers), true);
    });

    test('false when the member does not hold it', () => {
      const plain = member('2', { permissions: [] });
      assert.equal(service.has(plain, PermissionFlagsBits.BanMembers), false);
    });

    test('Administrator implies every permission', () => {
      const admin = member('3', { permissions: [String(PermissionFlagsBits.Administrator)] });
      assert.equal(service.has(admin, PermissionFlagsBits.BanMembers), true);
      assert.equal(service.has(admin, PermissionFlagsBits.ManageChannels), true);
    });

    test('a null permission requirement is always satisfied', () => {
      // `warn` requires no Discord permission — the role check is the gate.
      assert.equal(service.has(member('4', { permissions: [] }), null), true);
    });

    test('a missing member is not permitted', () => {
      assert.equal(service.has(null, PermissionFlagsBits.BanMembers), false);
    });
  });

  describe('canModerate', () => {
    const guild = { id: 'g1', ownerId: 'owner' };

    test('allowed when the actor outranks the target', () => {
      const result = service.canModerate(
        member('mod', { position: 10 }),
        member('user', { position: 2 }),
        guild,
      );
      assert.deepEqual(result, { allowed: true, reason: null });
    });

    test('blocked at equal rank — equal is not above', () => {
      const result = service.canModerate(
        member('a', { position: 5 }),
        member('b', { position: 5 }),
        guild,
      );
      assert.equal(result.allowed, false);
      assert.equal(result.reason, 'hierarchy');
    });

    test('blocked when the target outranks the actor', () => {
      const result = service.canModerate(
        member('a', { position: 2 }),
        member('b', { position: 20 }),
        guild,
      );
      assert.equal(result.reason, 'hierarchy');
    });

    test('nobody moderates themselves', () => {
      const result = service.canModerate(member('same', { position: 99 }), member('same', { position: 0 }), guild);
      assert.equal(result.allowed, false);
      assert.equal(result.reason, 'self');
    });

    test('nobody moderates the guild owner', () => {
      // Even a position-999 admin cannot act on the owner.
      const result = service.canModerate(
        member('admin', { position: 999, permissions: ['ALL'] }),
        member('owner', { position: 0 }),
        guild,
      );
      assert.equal(result.allowed, false);
      assert.equal(result.reason, 'owner');
    });

    test('the owner check still works without an Administrator flag', () => {
      const result = service.canModerate(member('a', { position: 3 }), member('owner', { position: 3 }), guild);
      assert.equal(result.reason, 'owner');
    });

    test('missing actor or target is reported, not crashed on', () => {
      assert.equal(service.canModerate(null, member('x'), guild).reason, 'no actor');
      assert.equal(service.canModerate(member('x'), null, guild).reason, 'no target');
    });
  });

  describe('assertCan', () => {
    const guild = { id: 'g1', ownerId: 'owner' };
    const bot = member('bot', { permissions: [String(PermissionFlagsBits.BanMembers)], position: 50 });

    test('passes for a properly ranked moderator', () => {
      const mod = member('mod', { permissions: [String(PermissionFlagsBits.BanMembers)], position: 40 });
      assert.equal(
        service.assertCan('ban', { actor: mod, target: member('user', { position: 1 }), guild, bot }),
        true,
      );
    });

    test('throws a localized error when the actor lacks the permission', () => {
      const mod = member('mod', { permissions: [], position: 40 });
      assert.throws(
        () => service.assertCan('ban', { actor: mod, target: member('user', { position: 1 }), guild, bot }),
        (err) => {
          assert.ok(err instanceof PermissionDeniedError);
          assert.equal(err.i18nKey, 'errors:missingPermissions');
          assert.equal(err.details.permissions, 'BanMembers');
          return true;
        },
      );
    });

    test('throws when the bot lacks the permission, using the bot-specific key', () => {
      const mod = member('mod', { permissions: [String(PermissionFlagsBits.BanMembers)], position: 40 });
      const weakBot = member('bot', { permissions: [], position: 50 });
      assert.throws(
        () => service.assertCan('ban', { actor: mod, target: member('user', { position: 1 }), guild, bot: weakBot }),
        (err) => {
          assert.equal(err.i18nKey, 'errors:missingPermissionsBot');
          return true;
        },
      );
    });

    test('throws when the bot is not above the target', () => {
      const mod = member('mod', { permissions: [String(PermissionFlagsBits.BanMembers)], position: 40 });
      const lowBot = member('bot', { permissions: [String(PermissionFlagsBits.BanMembers)], position: 5 });
      assert.throws(
        () => service.assertCan('ban', { actor: mod, target: member('user', { position: 10 }), guild, bot: lowBot }),
        (err) => {
          assert.equal(err.i18nKey, 'errors:hierarchyBot');
          assert.equal(err.details.target, '<@user>');
          return true;
        },
      );
    });

    test('an outranked actor gets the hierarchy message, not a missing-permission one', () => {
      // The moderator holds BanMembers; telling them otherwise sends them to
      // fix the wrong thing.
      const mod = member('mod', { permissions: [String(PermissionFlagsBits.BanMembers)], position: 5 });
      assert.throws(
        () => service.assertCan('ban', { actor: mod, target: member('user', { position: 50 }), guild, bot }),
        (err) => {
          assert.equal(err.i18nKey, 'errors:hierarchy');
          assert.equal(err.details.target, '<@user>');
          return true;
        },
      );
    });

    test('moderating yourself and the owner each have their own message', () => {
      assert.throws(
        () => service.assertCan('ban', { actor: bot, target: bot, guild, bot }),
        (err) => err.i18nKey === 'errors:self',
      );
      const owner = member('owner', { permissions: ['ALL'], position: 0 });
      assert.throws(
        () => service.assertCan('ban', { actor: bot, target: owner, guild, bot }),
        (err) => err.i18nKey === 'errors:owner',
      );
    });

    test('every action key has a known bot requirement entry', () => {
      // A typo in an action name would otherwise silently skip the bot check.
      for (const action of Object.keys(ACTION_PERMISSIONS)) {
        assert.ok(action in BOT_PERMISSIONS, `${action} has no BOT_PERMISSIONS entry`);
      }
    });
  });

  describe('canManageRole', () => {
    const bot = member('bot', { position: 10 });

    test('true below the bot', () => {
      assert.equal(service.canManageRole(bot, { position: 3 }), true);
    });

    test('false at or above the bot', () => {
      assert.equal(service.canManageRole(bot, { position: 10 }), false);
      assert.equal(service.canManageRole(bot, { position: 11 }), false);
    });

    test('false for a missing role rather than throwing', () => {
      assert.equal(service.canManageRole(bot, null), false);
      assert.equal(service.canManageRole(bot, {}), false);
    });
  });

  test('permissionName maps known flags and degrades gracefully', () => {
    assert.equal(permissionName(PermissionFlagsBits.BanMembers), 'BanMembers');
    assert.equal(permissionName(PermissionFlagsBits.ModerateMembers), 'ModerateMembers');
    assert.equal(permissionName(1n << 60n), '0x1000000000000000');
  });
});
