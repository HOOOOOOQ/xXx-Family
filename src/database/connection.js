/**
 * src/database/connection.js
 * ---------------------------------------------------------------------------
 * MongoDB Atlas connection manager (Mongoose).
 *
 * Termux friendly: no local MongoDB server is ever required, everything points
 * at an Atlas URI. The manager owns:
 *   - connect with bounded exponential backoff
 *   - lifecycle event wiring into the structured logger
 *   - a real `ping` based health probe (not a guessed "connected" flag)
 *   - graceful disconnect during shutdown
 *
 * The bot can still boot when `MONGODB_URI` is absent — in that mode settings
 * are served from cache/defaults and nothing is persisted. That state is
 * reported honestly through {@link getDatabaseHealth}.
 */

import mongoose from 'mongoose';

import { getLogger } from '../utils/logger.js';
import { DatabaseError } from '../utils/errors.js';

/** Mongoose connection state names, by numeric readyState. */
export const STATE_NAMES = Object.freeze({
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
});

const state = {
  enabled: false,
  uri: null,
  attempts: 0,
  lastError: null,
  lastConnectedAt: null,
  lastPingMs: null,
  pingedAt: null,
  listenersBound: false,
};

const log = () => getLogger().child('db');

function bindEvents(connection) {
  if (state.listenersBound) return;
  const logger = log();

  connection.on('connected', () => logger.debug('MongoDB connected'));
  connection.on('open', () => {
    state.lastConnectedAt = new Date().toISOString();
    state.lastError = null;
    logger.info('MongoDB connection open', { host: safeHost() });
  });
  connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  connection.on('reconnectFailed', () => logger.error('MongoDB reconnect failed'));
  connection.on('error', (err) => {
    state.lastError = err.message;
    logger.errorFrom(err, 'MongoDB connection error');
  });

  mongoose.set('debug', false);
  state.listenersBound = true;
}

function safeHost() {
  try {
    const url = new URL(String(state.uri).replace(/^mongodb(\+srv)?:\/\//, 'http://'));
    return url.hostname || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Open the connection. Resolves once Mongoose reports state `connected`.
 *
 * @param {object} [params]
 * @param {string} [params.uri]
 * @param {object} [params.options]
 * @param {number} [params.retries]
 * @param {number} [params.baseDelayMs]
 * @param {(ms:number)=>Promise<void>} [params.delay] injectable for tests
 * @returns {Promise<{ connected:boolean, skipped:boolean, attempts:number }>}
 */
export async function connectDatabase(params = {}) {
  const logger = log();
  const uri = params.uri ?? process.env.MONGODB_URI ?? null;

  if (!uri) {
    state.enabled = false;
    logger.warn('MONGODB_URI is not set — running without persistence. Settings will not be saved.');
    return { connected: false, skipped: true, attempts: 0 };
  }

  state.enabled = true;
  state.uri = uri;
  bindEvents(mongoose.connection);

  const retries = params.retries ?? 4;
  const baseDelayMs = params.baseDelayMs ?? 500;
  const delay = params.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    state.attempts = attempt;
    try {
      await mongoose.connect(uri, params.options ?? {
        autoIndex: process.env.NODE_ENV !== 'production',
        serverSelectionTimeoutMS: 10000,
        maxPoolSize: 10,
        minPoolSize: 1,
        socketTimeoutMS: 45000,
        retryWrites: true,
        retryReads: true,
        appName: 'xxx-family-bot',
      });
      logger.info('MongoDB ready', { attempt, host: safeHost() });
      state.lastError = null;
      return { connected: true, skipped: false, attempts: attempt };
    } catch (err) {
      lastError = err;
      state.lastError = err.message;
      const waitMs = Math.min(baseDelayMs * 2 ** (attempt - 1), 15000);
      logger.warn('MongoDB connection attempt failed', { attempt, retries, waitMs, reason: err.message });
      if (attempt < retries) await delay(waitMs);
    }
  }

  throw new DatabaseError(`Could not connect to MongoDB after ${retries} attempts: ${lastError?.message}`, {
    cause: lastError,
  });
}

/**
 * Round-trip probe. Sends a real `ping` to the server so `/health` never lies
 * about database availability.
 * @returns {Promise<{ ok:boolean, latencyMs:number|null, error?:string }>}
 */
export async function pingDatabase() {
  if (!state.enabled || mongoose.connection.readyState !== 1) {
    return { ok: false, latencyMs: null, error: state.enabled ? 'not connected' : 'not configured' };
  }
  const started = process.hrtime.bigint();
  try {
    await mongoose.connection.db.admin().ping();
    const latencyMs = Number(process.hrtime.bigint() - started) / 1e6;
    state.lastPingMs = Math.round(latencyMs * 100) / 100;
    state.pingedAt = new Date().toISOString();
    return { ok: true, latencyMs: state.lastPingMs };
  } catch (err) {
    return { ok: false, latencyMs: null, error: err.message };
  }
}

/**
 * Current connection health, safe to expose on `/health`.
 * @returns {{ enabled:boolean, status:'connected'|'connecting'|'disconnected'|'unconfigured'|'error', readyState:number, host:string, lastPingMs:number|null, lastError:string|null, lastConnectedAt:string|null, attempts:number }}
 */
export function getDatabaseHealth() {
  const readyState = mongoose.connection.readyState;
  const stateName = STATE_NAMES[readyState] ?? 'unknown';
  let status = stateName;
  if (!state.enabled) status = 'unconfigured';
  else if (stateName === 'disconnected' && state.lastError) status = 'error';

  return {
    enabled: state.enabled,
    status,
    readyState,
    host: state.enabled ? safeHost() : null,
    lastPingMs: state.lastPingMs,
    lastError: state.lastError,
    lastConnectedAt: state.lastConnectedAt,
    attempts: state.attempts,
    models: Object.keys(mongoose.models).length,
  };
}

/**
 * Close the connection cleanly (SIGTERM / SIGINT).
 * @param {number} [timeoutMs]
 */
export async function disconnectDatabase(timeoutMs = 8000) {
  if (!state.enabled) return { closed: false, reason: 'not configured' };
  const logger = log();
  try {
    await Promise.race([
      mongoose.disconnect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('disconnect timeout')), timeoutMs)),
    ]);
    logger.info('MongoDB connection closed');
    return { closed: true };
  } catch (err) {
    logger.errorFrom(err, 'MongoDB disconnect failed');
    return { closed: false, reason: err.message };
  }
}

/** @returns {import('mongoose').Mongoose} */
export function getMongoose() {
  return mongoose;
}

/** Reset module state (tests only). */
export function __resetDatabaseState() {
  Object.assign(state, {
    enabled: false,
    uri: null,
    attempts: 0,
    lastError: null,
    lastConnectedAt: null,
    lastPingMs: null,
    pingedAt: null,
    listenersBound: false,
  });
}
