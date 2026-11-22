#!/usr/bin/env node
/**
 * scripts/doctor.js
 * ---------------------------------------------------------------------------
 * Pre-flight diagnostics. Run this first on a fresh Termux install:
 *
 *   node scripts/doctor.js
 *
 * It checks the things that actually stop the bot from starting — Node version,
 * dependencies, environment, translation files, command/event/module loading —
 * without touching the Discord API, so it works offline.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { initConfig, ROOT_DIR } from '../src/config/index.js';
import { Logger, setLogger, getLogger } from '../src/utils/logger.js';
import { LOCALE_CODES } from '../src/config/locales.js';
import { NAMESPACES } from '../src/services/i18nService.js';
import { loadCommands } from '../src/handlers/commandLoader.js';
import { loadEvents } from '../src/handlers/eventLoader.js';

const results = [];
/** @param {string} name @param {'ok'|'warn'|'fail'} status @param {string} detail */
function check(name, status, detail) {
  results.push({ name, status, detail });
}

async function main() {
  const config = initConfig();
  setLogger(new Logger({ name: 'doctor', level: 'error', format: config.logging.format }));
  const logger = getLogger();

  // 1. Runtime
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  check(
    'Node.js version',
    nodeMajor >= 20 ? 'ok' : 'fail',
    `${process.version} (>= 20 required)`,
  );
  check('Platform', 'ok', `${process.platform} ${process.arch} — Termux reports "android"/"linux"`);

  // 2. Dependencies
  const requiredPackages = ['discord.js', 'mongoose', 'i18next', 'express', 'dotenv', 'zod'];
  for (const pkg of requiredPackages) {
    try {
      const pkgJson = JSON.parse(
        await import('node:fs/promises').then((fs) => fs.readFile(join(ROOT_DIR, 'node_modules', pkg, 'package.json'), 'utf8')),
      );
      check(`package:${pkg}`, 'ok', pkgJson.version);
    } catch {
      check(`package:${pkg}`, 'fail', 'not installed — run `npm install`');
    }
  }

  // 3. Environment
  const envFile = join(ROOT_DIR, '.env');
  check('.env file', existsSync(envFile) ? 'ok' : 'warn', existsSync(envFile) ? envFile : 'missing — run `cp .env.example .env`');
  check('DISCORD_TOKEN', config.discord.token ? 'ok' : 'warn', config.discord.token ? `set (${config.discord.token.length} chars)` : 'not set');
  check('DISCORD_CLIENT_ID', config.discord.clientId ? 'ok' : 'warn', config.discord.clientId ?? 'not set');
  check('MONGODB_URI', config.database.uri ? 'ok' : 'warn', config.database.uri ? `set (host: ${safeHost(config.database.uri)})` : 'not set — bot runs without persistence');
  check('SESSION_SECRET', config.api.sessionSecret ? 'ok' : 'warn', config.api.sessionSecret ? `set (${config.api.sessionSecret.length} chars)` : 'not set — required for the dashboard');
  check('NODE_ENV', config.env === 'production' && config.missingRequired.length ? 'fail' : 'ok', `${config.env}${config.missingRequired.length ? ` — missing: ${config.missingRequired.join(', ')}` : ''}`);

  // 4. Translations
  for (const locale of LOCALE_CODES) {
    const missing = NAMESPACES.filter((ns) => !existsSync(join(config.paths.locales, locale, `${ns}.json`)));
    check(`locale:${locale}`, missing.length ? 'fail' : 'ok', missing.length ? `missing: ${missing.join(', ')}` : `${NAMESPACES.length}/${NAMESPACES.length} namespaces`);
  }

  // 5. Bot surface
  try {
    const { commands, errors } = await loadCommands(join(config.paths.src, 'bot', 'commands'), { strict: false });
    check('commands', errors.length ? 'warn' : 'ok', `${commands.size} loaded${errors.length ? `, ${errors.length} failed` : ''}`);
    for (const error of errors) logger.error('command load error', error);
  } catch (err) {
    check('commands', 'fail', err.message);
  }

  try {
    const { events, errors } = await loadEvents(join(config.paths.src, 'bot', 'events'), { strict: false });
    check('events', errors.length ? 'warn' : 'ok', `${events.length} loaded${errors.length ? `, ${errors.length} failed` : ''}`);
  } catch (err) {
    check('events', 'fail', err.message);
  }

  const modulesDir = join(config.paths.src, 'bot', 'modules');
  const modules = existsSync(modulesDir) ? readdirSync(modulesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
  check('modules', 'ok', modules.length ? modules.join(', ') : 'none yet');

  // 6. Port
  check('API port', 'ok', `${config.api.host}:${config.api.port}`);

  // Report
  const icon = { ok: '✓', warn: '!', fail: '✗' };
  console.log('\nxXx Family — doctor report\n');
  for (const row of results) {
    console.log(`  ${icon[row.status]} ${row.name.padEnd(22)} ${row.detail}`);
  }
  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  console.log(`\n  ${results.length} checks — ${failed} failing, ${warned} warnings\n`);
  process.exit(failed ? 1 : 0);
}

function safeHost(uri) {
  try {
    return new URL(String(uri).replace(/^mongodb(\+srv)?:\/\//, 'http://')).hostname;
  } catch {
    return 'unparseable URI';
  }
}

main().catch((err) => {
  process.stderr.write(`[doctor] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
