/**
 * src/api/standalone.js
 * ---------------------------------------------------------------------------
 * Run the Express API on its own — no Discord gateway.
 *
 * Useful on Termux when the dashboard is being developed, and for the health
 * endpoint in environments where only HTTP is reachable:
 *
 *   npm run start:api
 */

import { initConfig } from '../config/index.js';
import { getLogger, setLogger, Logger } from '../utils/logger.js';
import { initI18n } from '../services/i18nService.js';
import { connectDatabase, disconnectDatabase, getDatabaseHealth, pingDatabase } from '../database/connection.js';
import '../database/models/index.js';
import { startApiServer } from './server.js';
import { healthService } from '../services/healthService.js';

async function main() {
  const config = initConfig();
  setLogger(new Logger({ name: 'xxx-family-api', level: config.logging.level, format: config.logging.format }));
  const logger = getLogger().child('api-standalone');

  await initI18n({ locales: [...config.i18n.enabledLocales], defaultLocale: config.i18n.defaultLocale, localesDir: config.paths.locales });

  try {
    const result = await connectDatabase({ uri: config.database.uri, options: config.database.options });
    if (result.skipped) logger.warn('MONGODB_URI not set — status endpoints will report an unconfigured database');
  } catch (err) {
    logger.errorFrom(err, 'MongoDB connection failed — starting anyway');
  }

  healthService.register('process', () => ({
    status: 'ok',
    pid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1000),
    memoryMb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
  }));
  healthService.register('database', async () => {
    const health = getDatabaseHealth();
    if (!health.enabled) return { status: 'degraded', ...health };
    const ping = await pingDatabase();
    return { status: ping.ok ? 'ok' : 'error', ...health, ping };
  });
  healthService.register('discord', () => ({ status: 'degraded', ready: false, note: 'gateway disabled in API-only mode' }));

  const { url, close } = await startApiServer({ config, client: null });
  logger.info('API listening', { url, port: config.api.port });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down API', { signal });
    await close();
    await disconnectDatabase();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console -- last resort before the logger exists
  console.error('Failed to start the API:', err);
  process.exit(1);
});
