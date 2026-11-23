#!/usr/bin/env node
/**
 * scripts/db-check.js
 * ---------------------------------------------------------------------------
 * Verify the MongoDB Atlas connection and the schema/index state.
 *
 *   node scripts/db-check.js
 *
 * Exits non-zero when the connection or any model fails, so it can be used as a
 * pre-flight check before starting the bot on Termux.
 */

import mongoose from 'mongoose';

import { initConfig } from '../src/config/index.js';
import { Logger, setLogger, getLogger } from '../src/utils/logger.js';
import models, { PLANNED_MODELS } from '../src/database/models/index.js';
import { connectDatabase, disconnectDatabase, getDatabaseHealth, pingDatabase } from '../src/database/connection.js';

async function main() {
  const config = initConfig();
  setLogger(new Logger({ name: 'db-check', level: config.logging.level, format: config.logging.format }));
  const logger = getLogger();

  if (!config.database.uri) {
    logger.fatal('MONGODB_URI is not set. Copy .env.example to .env and fill in your Atlas URI.');
    process.exit(1);
  }

  try {
    await connectDatabase({ uri: config.database.uri, options: { ...config.database.options, autoIndex: true } });
  } catch (err) {
    logger.errorFrom(err, 'Cannot reach MongoDB');
    process.exit(1);
  }

  const ping = await pingDatabase();
  const health = getDatabaseHealth();
  logger.info('Connection', { status: health.status, host: health.host, pingMs: ping.latencyMs });

  if (!ping.ok) {
    logger.fatal('Database ping failed', { error: ping.error });
    await disconnectDatabase();
    process.exit(1);
  }

  // Ensure every declared index exists (safe to run repeatedly).
  for (const [name, model] of Object.entries(models)) {
    try {
      const indexes = await model.syncIndexes();
      const count = await model.estimatedDocumentCount();
      logger.info('Model ok', { model: name, indexesRebuilt: indexes.length, documents: count });
    } catch (err) {
      logger.errorFrom(err, 'Model failed', { model: name });
      await disconnectDatabase();
      process.exit(1);
    }
  }

  const collections = await mongoose.connection.db.listCollections().toArray();
  logger.info('Collections', {
    existing: collections.map((c) => c.name).sort(),
    plannedForLaterPhases: PLANNED_MODELS,
  });

  await disconnectDatabase();
  logger.info('Database check passed');
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[db-check] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
