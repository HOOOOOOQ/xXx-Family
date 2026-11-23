/**
 * src/bot/modules/core/index.js
 * ---------------------------------------------------------------------------
 * The `core` module — the reference implementation of the plugin contract that
 * every later phase (welcome, tickets, economy, AI…) copies.
 *
 * Responsibilities in Phase 1:
 *   - expose translation-engine health on /health
 *   - run a periodic self-check so a degrading dependency shows up in the logs
 *     before a user notices it
 *   - keep the guild settings cache warm for the guilds we are in
 */

import { getDatabaseHealth, pingDatabase } from '../../../database/connection.js';
import { getLoadedLocales, getMissingKeys, isI18nReady } from '../../../services/i18nService.js';
import { HEALTH_STATUS } from '../../../services/healthService.js';

/** Self-check interval: long enough to be quiet, short enough to be useful. */
const SELF_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Cache warm-up: refresh settings for a bounded number of guilds per tick. */
const WARM_BATCH = 25;

let timer = null;

export default {
  name: 'core',
  version: '1.0.0',
  phase: 1,
  dependencies: [],
  configKey: 'core',

  async init(ctx) {
    const { health } = ctx;

    health.register('i18n', () => {
      const loaded = getLoadedLocales();
      const missing = getMissingKeys();
      const missingCount = Object.values(missing).reduce((total, keys) => total + Object.keys(keys).length, 0);
      return {
        status: isI18nReady() && loaded.length > 0 ? HEALTH_STATUS.OK : HEALTH_STATUS.ERROR,
        ready: isI18nReady(),
        locales: loaded,
        localeCount: loaded.length,
        missingKeys: missingCount,
      };
    });
  },

  async start(ctx) {
    const { client, logger, settings } = ctx;

    timer = setInterval(async () => {
      try {
        const db = getDatabaseHealth();
        const ping = db.enabled ? await pingDatabase() : { ok: false };
        const cacheStats = settings.stats();

        logger.debug('Self-check', {
          database: db.status,
          dbPingMs: ping.latencyMs ?? null,
          cache: cacheStats,
          guilds: client.guilds?.cache?.size ?? 0,
          memoryMb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
        });

        if (db.enabled && !ping.ok) {
          logger.warn('Database ping failed during self-check', { reason: ping.error, status: db.status });
        }

        // Warm the settings cache for the guilds we serve (bounded per tick).
        const guildIds = [...(client.guilds?.cache?.keys?.() ?? [])].slice(0, WARM_BATCH);
        for (const guildId of guildIds) {
          await settings.getGuildSettings(guildId).catch(() => null);
        }
      } catch (err) {
        logger.errorFrom(err, 'Self-check failed');
      }
    }, SELF_CHECK_INTERVAL_MS);

    // Never hold the event loop open on Termux just for housekeeping.
    timer.unref?.();
  },

  async stop(ctx) {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    ctx.logger?.debug('Core module stopped');
  },
};
