/**
 * src/config/index.js
 * ---------------------------------------------------------------------------
 * Environment loading + validation.
 *
 * The whole app reads configuration from here — never from `process.env`
 * directly — so there is exactly one place where secrets enter the process and
 * exactly one place where invalid configuration is rejected at boot.
 *
 * `loadConfig()` is pure and takes an env object, which makes it unit
 * testable without touching the real environment.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

import { ConfigError } from '../utils/errors.js';
import { registerSecret } from '../utils/redact.js';
import { DEFAULT_LOCALE, LOCALE_CODES, isSupportedLocale } from './locales.js';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = resolve(here, '..', '..');
export const SRC_DIR = join(ROOT_DIR, 'src');
export const LOCALES_DIR = join(SRC_DIR, 'locales');
export const DATA_DIR = join(ROOT_DIR, 'data');
export const LOG_DIR = join(ROOT_DIR, 'logs');

/** Load `.env` (no override of real environment variables). Idempotent. */
let envLoaded = false;
export function loadDotEnv({ quiet = false } = {}) {
  if (envLoaded) return { loaded: false };
  const path = join(ROOT_DIR, '.env');
  if (!existsSync(path)) {
    envLoaded = true;
    return { loaded: false, missing: true, path, quiet };
  }
  const parsed = dotenv.config({ path, override: false, quiet });
  envLoaded = true;
  return { loaded: !parsed.error, path, error: parsed.error?.message };
}

function splitList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

const localeListSchema = z
  .union([z.string(), z.array(z.string())])
  // The default must be applied BEFORE the transform: a `.default()` wrapped
  // around a transform short-circuits it and would yield the raw '' instead of
  // the full locale list.
  .default('')
  .transform((value) => {
    const list = Array.isArray(value) ? value : splitList(value);
    return list.length ? list : LOCALE_CODES;
  })
  .refine((list) => list.every(isSupportedLocale), {
    message: `ENABLED_LOCALES contains an unsupported locale. Allowed: ${LOCALE_CODES.join(', ')}`,
  });

/**
 * Zod schema for the environment.
 * Secrets are only *required* in production; in development/test the bot can
 * still boot (e.g. API-only mode, or the test suite) without them.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    DISCORD_TOKEN: z.string().trim().min(1).optional(),
    DISCORD_CLIENT_ID: z.string().trim().min(1).optional(),
    DISCORD_CLIENT_SECRET: z.string().trim().min(1).optional(),
    DISCORD_REDIRECT_URI: z.string().trim().url().default('http://localhost:3000/api/auth/callback'),
    DEPLOY_GUILD_ID: z.string().trim().regex(/^\d{15,25}$/, 'DEPLOY_GUILD_ID must be a snowflake').optional().or(z.literal('')),

    MONGODB_URI: z.string().trim().min(1).optional(),

    SESSION_SECRET: z.string().trim().min(1).optional(),
    DASHBOARD_URL: z.string().trim().url().default('http://localhost:3000'),
    API_BASE_URL: z.string().trim().url().default('http://localhost:4000'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    HOST: z.string().trim().default('0.0.0.0'),

    DEFAULT_LANGUAGE: z
      .string()
      .trim()
      .refine(isSupportedLocale, { message: `DEFAULT_LANGUAGE must be one of ${LOCALE_CODES.join(', ')}` })
      .default(DEFAULT_LOCALE),
    ENABLED_LOCALES: localeListSchema,

    AI_PROVIDER: z.string().trim().optional().or(z.literal('')),
    AI_API_KEY: z.string().trim().optional().or(z.literal('')),

    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
    LOG_FORMAT: z.enum(['pretty', 'json']).default('pretty'),

    OWNER_IDS: z.string().trim().optional().or(z.literal('')),
    CORS_ORIGINS: z.string().trim().optional().or(z.literal('')),

    ENABLE_API: z
      .string()
      .trim()
      .default('true')
      .transform((v) => !['0', 'false', 'no', 'off'].includes(v.toLowerCase())),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10000),
  })
  .transform((env) => {
    const isProduction = env.NODE_ENV === 'production';
    const missing = [];
    if (isProduction) {
      if (!env.DISCORD_TOKEN) missing.push('DISCORD_TOKEN');
      if (!env.MONGODB_URI) missing.push('MONGODB_URI');
      if (!env.SESSION_SECRET) missing.push('SESSION_SECRET');
    }
    return { ...env, isProduction, missingRequired: missing };
  });

/**
 * Validate a raw environment object.
 * @param {Record<string, string|undefined>} rawEnv
 * @returns {Readonly<ReturnType<typeof shapeConfig>>}
 * @throws {ConfigError} when the environment is invalid.
 */
export function loadConfig(rawEnv = process.env) {
  const result = envSchema.safeParse(rawEnv);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n${issues.join('\n')}`, {
      details: { issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
    });
  }
  return shapeConfig(result.data);
}

function shapeConfig(env) {
  const enabledLocales = Array.from(new Set([env.DEFAULT_LANGUAGE, ...env.ENABLED_LOCALES]));

  return Object.freeze({
    env: env.NODE_ENV,
    isProduction: env.isProduction,
    isTest: env.NODE_ENV === 'test',
    isDevelopment: env.NODE_ENV === 'development',
    missingRequired: env.missingRequired,

    paths: Object.freeze({ root: ROOT_DIR, src: SRC_DIR, locales: LOCALES_DIR, data: DATA_DIR, logs: LOG_DIR }),

    discord: Object.freeze({
      token: env.DISCORD_TOKEN ?? null,
      clientId: env.DISCORD_CLIENT_ID ?? null,
      clientSecret: env.DISCORD_CLIENT_SECRET ?? null,
      redirectUri: env.DISCORD_REDIRECT_URI,
      deployGuildId: env.DEPLOY_GUILD_ID || null,
      owners: splitList(env.OWNER_IDS),
    }),

    database: Object.freeze({
      uri: env.MONGODB_URI ?? null,
      enabled: Boolean(env.MONGODB_URI),
      options: Object.freeze({
        autoIndex: env.NODE_ENV !== 'production',
        serverSelectionTimeoutMS: 10000,
        maxPoolSize: 10,
        minPoolSize: 1,
        socketTimeoutMS: 45000,
        heartbeatFrequencyMS: 10000,
        retryWrites: true,
        retryReads: true,
        appName: 'xxx-family-bot',
      }),
    }),

    api: Object.freeze({
      enabled: env.ENABLE_API,
      host: env.HOST,
      port: env.PORT,
      baseUrl: env.API_BASE_URL,
      dashboardUrl: env.DASHBOARD_URL,
      sessionSecret: env.SESSION_SECRET ?? null,
      corsOrigins: splitList(env.CORS_ORIGINS).length
        ? splitList(env.CORS_ORIGINS)
        : [env.DASHBOARD_URL],
    }),

    i18n: Object.freeze({
      defaultLocale: env.DEFAULT_LANGUAGE,
      enabledLocales: Object.freeze(enabledLocales),
    }),

    ai: Object.freeze({ provider: env.AI_PROVIDER || null, apiKey: env.AI_API_KEY || null }),

    logging: Object.freeze({ level: env.LOG_LEVEL, format: env.LOG_FORMAT }),

    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  });
}

/**
 * Boot the configuration: read `.env`, validate, and register every secret so
 * the logger can scrub it from any output.
 * @param {Record<string,string|undefined>} [rawEnv]
 */
export function initConfig(rawEnv) {
  loadDotEnv();
  const config = loadConfig(rawEnv ?? process.env);

  registerSecret(config.discord.token);
  registerSecret(config.discord.clientSecret);
  registerSecret(config.api.sessionSecret);
  registerSecret(config.ai.apiKey);
  if (config.database.uri) {
    try {
      const password = new URL(config.database.uri.replace(/^mongodb(\+srv)?:\/\//, 'http://')).password;
      if (password) registerSecret(decodeURIComponent(password));
    } catch {
      /* a malformed URI is reported by the connection manager, not here */
    }
  }

  return config;
}

/** Process-wide config, populated by `initConfig()` (or by tests). */
let config = null;

/** @returns {ReturnType<typeof shapeConfig>} */
export function getConfig() {
  if (!config) config = initConfig();
  return config;
}

/** Override the process-wide config (tests / scripts). */
export function setConfig(next) {
  config = next;
  return config;
}

export default getConfig;
