/**
 * src/bot/index.js
 * ---------------------------------------------------------------------------
 * Process entry point.
 *
 * Responsibilities that belong here and nowhere else:
 *   - install process-level error handlers BEFORE anything else can throw
 *   - load + validate configuration (fail fast with an actionable message)
 *   - boot the client, then the API
 *   - own graceful shutdown (SIGINT/SIGTERM) with a hard-exit deadline
 *
 * Run with: npm start   (Termux: `node src/bot/index.js`)
 */

import { initConfig } from '../config/index.js';
import { Logger, setLogger } from '../utils/logger.js';
import { XxxFamilyClient } from './client.js';
import { startApiServer } from '../api/server.js';
import { normalizeError } from '../utils/errors.js';

async function main() {
  // 1. Configuration first: everything else depends on it, including the logger.
  let config;
  try {
    config = initConfig();
  } catch (err) {
    // The logger is not configured yet, so write straight to stderr.
    process.stderr.write(`[xxx-family] fatal: ${err.message}\n`);
    process.exit(1);
  }

  const logger = setLogger(
    new Logger({ name: 'xxx-family', level: config.logging.level, format: config.logging.format }),
  );

  // 2. Process-level safety net.
  let fatalSeen = false;
  process.on('unhandledRejection', (reason) => {
    logger.errorFrom(reason, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.errorFrom(err, 'Uncaught exception');
    // Keep serving if we can, but never more than once per incident storm.
    if (!fatalSeen) {
      fatalSeen = true;
      logger.warn('Process is in an undefined state — consider a restart');
    }
  });
  process.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning') return;
    logger.warn('Node warning', { name: warning.name, message: warning.message });
  });

  if (config.missingRequired.length) {
    logger.error('Missing required environment variables', { missing: config.missingRequired });
    if (config.isProduction) {
      logger.fatal('Refusing to start in production with missing configuration');
      process.exit(1);
    }
  }

  // 3. Client.
  const client = new XxxFamilyClient(config);

  // 4. Graceful shutdown with a hard deadline.
  let stopping = false;
  let apiHandle = null;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info('Shutdown signal received', { signal });

    const hardExit = setTimeout(() => {
      logger.fatal('Shutdown timed out — forcing exit');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    hardExit.unref?.();

    try {
      await apiHandle?.close();
      await client.stop(signal);
      logger.info('Goodbye');
      process.exit(0);
    } catch (err) {
      logger.errorFrom(err, 'Shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // 5. Boot.
  try {
    await client.initialize();

    if (config.api.enabled) {
      try {
        apiHandle = await startApiServer({ client, config });
        logger.info('API listening', { url: apiHandle.url });
      } catch (err) {
        const normalized = normalizeError(err);
        if (normalized.statusCode === 500 && /EADDRINUSE/.test(String(err.code ?? err.message))) {
          logger.error('API port already in use — continuing without the HTTP API', {
            port: config.api.port,
            hint: 'Set PORT to a free port in .env',
          });
        } else {
          throw err;
        }
      }
    }

    if (!config.discord.token) {
      logger.warn('DISCORD_TOKEN is not set — the API is up but the bot is not connected to Discord');
      if (config.isProduction) {
        logger.fatal('DISCORD_TOKEN is required in production');
        process.exit(1);
      }
      return;
    }

    await client.login(config.discord.token);
  } catch (err) {
    logger.errorFrom(err, 'Boot failed');
    await client.stop('boot-failed').catch(() => {});
    await apiHandle?.close?.().catch(() => {});
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`[xxx-family] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
