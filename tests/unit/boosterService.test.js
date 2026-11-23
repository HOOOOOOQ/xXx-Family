import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { BoosterService } from '../../src/services/boosterService.js';
import { monthsBetween } from '../../src/database/models/BoosterRecord.js';
import { LoggingService } from '../../src/services/loggingService.js';
import { LocaleService } from '../../src/services/localeService.js';
import { SettingsService } from '../../src/services/settingsService.js';
import { CacheManager } from '../../src/services/cacheManager.js';
import { initI18n } from '../../src/services/i18nService.js';
import { LOCALE_CODES } from '../../src/config/locales.js';
import { DEFAULT_BOOSTER_CONFIG } from '../../src/database/models/BoosterConfig.js';

const silentLogger = { child: () => silentLogger, debug() {}, info() {}, warn() {}, error() {}, errorFrom() {} };

const GUILD_ID = '111111111111111111';
const USER_ID = '444444444444444444';
const LOG_CHANNEL = '999999999999999999';
const BOOST_ROLE = '555555555555555555';
const REWARD_ROLE = '666666666666666666';

const DAY = 86400_000;

before(async () => {
  await initI18n({ locales: LOCALE_CODES, defaultLocale: 'en-US' });
});

/** In-memory stand-ins with the Mongoose surface the service uses. */
function createStores({ config = null, record = null } = {}) {
  const configRows = new Map(config ? [[GUILD_ID, config]] : []);
  const recordRows = new Map(record ? [[`${GUILD_ID}:${USER_ID}`, record]] : []);

  const BoosterConfig = {
    rows: configRows,
    findOne: ({ guildId }) => ({ lean: async () => configRows.get(guildId) ?? null }),
    findOneAndUpdate: async ({ guildId }, update) => {
      const current = configRows.get(guildId) ?? { guildId };
      const next = { ...current };
      for (const [path, value] of Object.entries(update.$set ?? {})) {
        if (path.includes('.')) {
          const [a, b] = path.split('.');
          next[a] = { ...(next[a] ?? {}), [b]: value };
        } else next[path] = value;
      }
      configRows.set(guildId, next);
      return next;
    },
    updateOne: async () => ({ acknowledged: true }),
  };

  const BoosterRecord = {
    rows: recordRows,
    findOne: ({ guildId, userId }) => ({ lean: async () => recordRows.get(`${guildId}:${userId}`) ?? null }),
    findOneAndUpdate: async ({ guildId, userId }, update) => {
      const key = `${guildId}:${userId}`;
      const current = recordRows.get(key) ?? { guildId, userId, totalMonths: 0, streaks: 0, rewardsClaimed: [] };
      const next = { ...current };
      for (const [path, value] of Object.entries(update.$set ?? {})) {
        if (path.includes('.')) {
          const [a, b] = path.split('.');
          next[a] = { ...(next[a] ?? {}), [b]: value };
        } else next[path] = value;
      }
      for (const [field, by] of Object.entries(update.$inc ?? {})) next[field] = (next[field] ?? 0) + by;
      recordRows.set(key, next);
      return { lean: () => next };
    },
    updateOne: async ({ guildId, userId }, update) => {
      const key = `${guildId}:${userId}`;
      const current = recordRows.get(key) ?? { guildId, userId };
      const next = { ...current };
      for (const [path, value] of Object.entries(update.$set ?? {})) next[path] = value;
      for (const [field, by] of Object.entries(update.$inc ?? {})) next[field] = (next[field] ?? 0) + by;
      for (const [field, value] of Object.entries(update.$addToSet ?? {})) {
        const list = new Set(next[field] ?? []);
        list.add(value);
        next[field] = [...list];
      }
      recordRows.set(key, next);
      return { acknowledged: true };
    },
    find: (filter) => {
      const matched = [...recordRows.values()]
        .filter((row) => row.guildId === filter.guildId && (filter.current === undefined || row.current === filter.current))
        .sort((a, b) => new Date(a.since) - new Date(b.since));
      const chain = {
        sort: () => chain,
        limit: () => chain,
        lean: async () => matched,
      };
      return chain;
    },
    countDocuments: async (filter) =>
      [...recordRows.values()].filter((row) => row.guildId === filter.guildId && (filter.current === undefined || row.current === filter.current)).length,
    aggregate: async () => [{ total: [...recordRows.values()].reduce((sum, r) => sum + (r.totalMonths ?? 0), 0) }],
  };

  return { models: { BoosterConfig, BoosterRecord }, configRows, recordRows };
}

function createChannel(id = LOG_CHANNEL) {
  const sent = [];
  return { sent, id, isTextBased: () => true, async send(payload) { sent.push(payload); return { id: 'm1' }; } };
}

function createMember({ boosting = false, rolePosition = 5, botPosition = 10, dmFails = false } = {}) {
  const added = [];
  const removed = [];
  const dms = [];
  const guildRoles = new Map([
    [BOOST_ROLE, { id: BOOST_ROLE, position: rolePosition }],
    [REWARD_ROLE, { id: REWARD_ROLE, position: rolePosition }],
    ['999999999999999998', { id: '999999999999999998', position: 99 }],
  ]);

  return {
    id: USER_ID,
    premiumSince: boosting ? new Date(Date.now() - 90 * DAY) : null,
    guild: {
      id: GUILD_ID,
      name: 'xXx Family',
      premiumSubscriptionCount: 14,
      premiumTier: 2,
      roles: { cache: guildRoles },
      members: { me: { roles: { highest: { position: botPosition } } } },
    },
    roles: {
      cache: new Map(boosting ? [[BOOST_ROLE, guildRoles.get(BOOST_ROLE)]] : []),
      async add(roleId) {
        added.push(roleId);
        this.cache.set(roleId, guildRoles.get(roleId) ?? { id: roleId, position: 1 });
      },
      async remove(roleId) {
        removed.push(roleId);
        this.cache.delete(roleId);
      },
    },
    user: { id: USER_ID, username: 'ada', displayName: 'Ada', displayAvatarURL: () => 'https://cdn/a.png' },
    async send(text) {
      if (dmFails) throw new Error('Cannot send messages to this user');
      dms.push(text);
    },
    __added: added,
    __removed: removed,
    __dms: dms,
  };
}

function createService({ config = null, record = null, dbReady = true, channel = createChannel() } = {}) {
  const { models, configRows, recordRows } = createStores({ config, record });
  const auditRows = [];

  const settings = new SettingsService({
    models: {
      GuildSettings: { findOne: () => ({ lean: () => ({ exec: async () => null }) }) },
      UserSettings: { findOne: () => ({ lean: () => ({ exec: async () => null }) }) },
      LanguageOverride: { find: () => ({ sort: () => ({ limit: () => ({ lean: () => ({ exec: async () => [] }) }) }) }) },
    },
    cache: new CacheManager({ autoSweep: false }),
    isDbReady: () => dbReady,
    logger: silentLogger,
  });

  const logging = new LoggingService({
    model: {
      create: async (doc) => (auditRows.push(doc), { _id: 'a1' }),
      countDocuments: async () => 0,
      find: () => ({ sort: () => ({ limit: () => ({ skip: () => ({ lean: async () => [] }) }) }) }),
    },
    settings,
    isDbReady: () => dbReady,
    resolveChannel: async () => null,
    logger: silentLogger,
  });

  const service = new BoosterService({
    models,
    logging,
    localeService: new LocaleService({ settings }),
    resolveChannel: async (id) => (id === LOG_CHANNEL ? channel : null),
    isDbReady: () => dbReady,
    logger: silentLogger,
  });

  return { service, channel, auditRows, configRows, recordRows };
}

const enabledConfig = (overrides = {}) => ({
  guildId: GUILD_ID,
  ...DEFAULT_BOOSTER_CONFIG,
  enabled: true,
  channelId: LOG_CHANNEL,
  ...overrides,
});

describe('monthsBetween', () => {
  test('counts whole months', () => {
    assert.equal(monthsBetween(new Date(Date.now() - 90 * DAY)), 3);
    assert.equal(monthsBetween(new Date(Date.now() - 10 * DAY)), 0);
    assert.equal(monthsBetween(new Date()), 0);
  });

  test('handles junk without throwing', () => {
    assert.equal(monthsBetween(null), 0);
    assert.equal(monthsBetween('not a date'), 0);
    assert.equal(monthsBetween(new Date(Date.now() + DAY)), 0, 'a future date is not negative months');
  });
});

describe('BoosterService — boost detection', () => {
  test('a new boost is recorded and announced', async () => {
    const { service, channel, auditRows, recordRows } = createService({ config: enabledConfig() });
    const member = createMember({ boosting: true });

    const result = await service.handleBoostChange(member, null, new Date());

    assert.equal(result.action, 'start');
    assert.equal(result.announced, true);
    assert.equal(channel.sent.length, 1);
    const embed = channel.sent[0].embeds[0].toJSON();
    assert.match(embed.description, /<@444444444444444444> just boosted \*\*xXx Family\*\*/);
    assert.match(embed.description, /\*\*14\*\* boosts \(Tier 2\)/);
    assert.equal(auditRows[0].type, 'booster.start');
    assert.equal(recordRows.get(`${GUILD_ID}:${USER_ID}`).current, true);
  });

  test('an ending boost closes the record and reports the length', async () => {
    const since = new Date(Date.now() - 90 * DAY);
    const { service, channel, auditRows, recordRows } = createService({
      config: enabledConfig(),
      record: { guildId: GUILD_ID, userId: USER_ID, since, current: true, totalMonths: 0, rewardsClaimed: [], streaks: 1 },
    });
    const member = createMember({ boosting: false });

    const result = await service.handleBoostChange(member, since, null);

    assert.equal(result.action, 'end');
    assert.equal(result.months, 3);
    assert.equal(recordRows.get(`${GUILD_ID}:${USER_ID}`).current, false);
    assert.equal(recordRows.get(`${GUILD_ID}:${USER_ID}`).totalMonths, 3);
    assert.equal(auditRows[0].type, 'booster.end');
    assert.match(channel.sent[0].embeds[0].toJSON().description, /boosted for 3mo/);
  });

  test('no change in boost state does nothing', async () => {
    const { service, channel } = createService({ config: enabledConfig() });
    assert.equal((await service.handleBoostChange(createMember({}), null, null)).action, null);
    assert.equal((await service.handleBoostChange(createMember({}), new Date(), new Date())).action, null);
    assert.equal(channel.sent.length, 0);
  });

  test('a disabled guild announces nothing but still keeps the record', async () => {
    const { service, channel, recordRows } = createService({ config: { ...enabledConfig(), enabled: false } });
    const result = await service.handleBoostChange(createMember({}), null, new Date());
    assert.equal(result.announced, false);
    assert.equal(channel.sent.length, 0);
    assert.equal(recordRows.get(`${GUILD_ID}:${USER_ID}`).current, true, 'history is kept regardless');
  });
});

describe('BoosterService — booster role', () => {
  test('grants the configured role on start and revokes it on end', async () => {
    const since = new Date(Date.now() - 60 * DAY);
    const { service } = createService({
      config: enabledConfig({ role: { id: BOOST_ROLE, revokeOnEnd: true } }),
      record: { guildId: GUILD_ID, userId: USER_ID, since, current: true, totalMonths: 0, rewardsClaimed: [] },
    });

    const starter = createMember({});
    await service.handleBoostChange(starter, null, new Date());
    assert.deepEqual(starter.__added, [BOOST_ROLE]);

    const leaver = createMember({ boosting: true });
    await service.handleBoostChange(leaver, since, null);
    assert.deepEqual(leaver.__removed, [BOOST_ROLE]);
  });

  test('refuses a booster role above the bot hierarchy', async () => {
    const { service } = createService({
      config: enabledConfig({ role: { id: '999999999999999998', revokeOnEnd: true } }),
    });
    const member = createMember({ rolePosition: 99 });
    const result = await service.handleBoostChange(member, null, new Date());
    assert.equal(result.roleGranted, false);
    assert.deepEqual(member.__added, []);
  });

  test('keeps the role when revokeOnEnd is off', async () => {
    const since = new Date(Date.now() - 60 * DAY);
    const { service } = createService({
      config: enabledConfig({ role: { id: BOOST_ROLE, revokeOnEnd: false } }),
      record: { guildId: GUILD_ID, userId: USER_ID, since, current: true, totalMonths: 0, rewardsClaimed: [] },
    });
    const member = createMember({ boosting: true });
    await service.handleBoostChange(member, since, null);
    assert.deepEqual(member.__removed, []);
  });
});

describe('BoosterService — milestone rewards', () => {
  const rewards = [{ months: 3, roleId: REWARD_ROLE, label: '3 months' }];

  test('grants a reward once the threshold is reached', async () => {
    const since = new Date(Date.now() - 100 * DAY);
    const { service, recordRows } = createService({
      config: enabledConfig({ rewards }),
      record: { guildId: GUILD_ID, userId: USER_ID, since, current: true, totalMonths: 0, rewardsClaimed: [] },
    });
    const member = createMember({});
    const result = await service.handleBoostChange(member, since, null);

    assert.deepEqual(result.rewards, [REWARD_ROLE]);
    assert.deepEqual(member.__added, [REWARD_ROLE]);
    assert.deepEqual(recordRows.get(`${GUILD_ID}:${USER_ID}`).rewardsClaimed, [3]);
  });

  test('does not grant below the threshold', async () => {
    const since = new Date(Date.now() - 30 * DAY);
    const { service } = createService({
      config: enabledConfig({ rewards }),
      record: { guildId: GUILD_ID, userId: USER_ID, since, current: true, totalMonths: 0, rewardsClaimed: [] },
    });
    const member = createMember({});
    const result = await service.handleBoostChange(member, since, null);
    assert.deepEqual(result.rewards, []);
  });

  test('never grants the same milestone twice', async () => {
    const since = new Date(Date.now() - 100 * DAY);
    const { service } = createService({
      config: enabledConfig({ rewards }),
      record: { guildId: GUILD_ID, userId: USER_ID, since, current: true, totalMonths: 0, rewardsClaimed: [3] },
    });
    const member = createMember({});
    const result = await service.handleBoostChange(member, since, null);
    assert.deepEqual(result.rewards, [], 'already claimed, so re-boosting cannot farm it');
    assert.deepEqual(member.__added, []);
  });
});

describe('BoosterService — localization', () => {
  test('an Indonesian server gets Indonesian announcements', async () => {
    const { service, channel } = createService({ config: enabledConfig({ language: 'id-ID' }) });
    await service.handleBoostChange(createMember({}), null, new Date());
    const embed = channel.sent[0].embeds[0].toJSON();
    assert.equal(embed.title, 'Booster baru!');
    assert.match(embed.description, /baru saja mem-boost \*\*xXx Family\*\*/);
    assert.ok(!JSON.stringify(embed).includes('just boosted'), 'must not mix languages');
  });

  test('the localized default templates render with no leftover placeholders', async () => {
    // Same class of bug the welcome templates had: a locale default with a
    // typo'd placeholder renders as literal text to the user.
    const { renderTemplate } = await import('../../src/utils/templates.js');
    const problems = [];
    for (const locale of LOCALE_CODES) {
      for (const key of ['booster.start', 'booster.end', 'booster.milestone', 'booster.dm']) {
        const template = (await import('../../src/services/i18nService.js')).translate(locale, `common:${key}`);
        const rendered = renderTemplate(
          template,
          {
            user: { mention: '<@1>', name: 'Ada', avatar: 'a' },
            server: { name: 'xXx Family', boostCount: 14, boostTier: 2 },
            months: 3,
            totalMonths: 3,
            since: '<t:1:R>',
            duration: '3mo',
          },
          { strict: false },
        );
        const leftovers = rendered.match(/\{[a-zA-Z][a-zA-Z0-9_.]*\}/g);
        if (leftovers) problems.push(`${locale} ${key}: ${leftovers.join(', ')}`);
      }
    }
    assert.deepEqual(problems, []);
  });
});

describe('BoosterService — queries', () => {
  test('the leaderboard lists current boosters only', async () => {
    const { service } = createService({});
    const rows = service.models.BoosterRecord.rows;
    rows.set(`${GUILD_ID}:a`, { guildId: GUILD_ID, userId: 'a', username: 'a', since: new Date(Date.now() - 200 * DAY), current: true, totalMonths: 6 });
    rows.set(`${GUILD_ID}:b`, { guildId: GUILD_ID, userId: 'b', username: 'b', since: new Date(Date.now() - 40 * DAY), current: true, totalMonths: 1 });
    rows.set(`${GUILD_ID}:c`, { guildId: GUILD_ID, userId: 'c', username: 'c', since: new Date(Date.now() - 900 * DAY), current: false, totalMonths: 30 });

    const board = await service.getLeaderboard(GUILD_ID, 10);
    assert.equal(board.length, 2, 'the expired booster must not appear');
    assert.equal(board[0].userId, 'a', 'longest first');
    assert.equal(board[0].months, 6);
  });

  test('stats aggregate current and lifetime counts', async () => {
    const { service } = createService({});
    service.models.BoosterRecord.rows.set(`${GUILD_ID}:a`, { guildId: GUILD_ID, userId: 'a', current: true, since: new Date(), totalMonths: 6 });
    service.models.BoosterRecord.rows.set(`${GUILD_ID}:b`, { guildId: GUILD_ID, userId: 'b', current: false, since: new Date(), totalMonths: 4 });

    const stats = await service.getStats(GUILD_ID, { premiumTier: 2, premiumSubscriptionCount: 14 });
    assert.equal(stats.boosters, 1);
    assert.equal(stats.lifetime, 2);
    assert.equal(stats.totalMonths, 10);
    assert.equal(stats.tier, 2);
  });

  test('queries degrade to empty results offline', async () => {
    const { service } = createService({ dbReady: false });
    assert.deepEqual(await service.getLeaderboard(GUILD_ID), []);
    assert.deepEqual(await service.getHistory(GUILD_ID, USER_ID), []);
    const stats = await service.getStats(GUILD_ID);
    assert.equal(stats.boosters, 0);
    assert.equal(stats.tier, null);
  });
});

describe('BoosterService — configuration', () => {
  test('saving without a database is refused, not faked', async () => {
    const { service } = createService({ dbReady: false });
    await assert.rejects(() => service.saveConfig(GUILD_ID, { enabled: true }), /database connection/i);
  });

  test('a dot-path patch updates a nested field only', async () => {
    const { service, configRows } = createService({ config: enabledConfig() });
    await service.saveConfig(GUILD_ID, { 'role.id': BOOST_ROLE }, 'admin-1');
    assert.equal(configRows.get(GUILD_ID).role.id, BOOST_ROLE);
    assert.equal(configRows.get(GUILD_ID).channelId, LOG_CHANNEL, 'other fields untouched');
    assert.equal(configRows.get(GUILD_ID).meta.updatedBy, 'admin-1');
  });

  test('a DM failure is reported, never thrown', async () => {
    const { service } = createService({ config: enabledConfig({ dm: { enabled: true, message: null } }) });
    const member = createMember({ dmFails: true });
    const result = await service.handleBoostChange(member, null, new Date());
    assert.equal(result.action, 'start');
    assert.deepEqual(member.__dms, []);
  });
});
