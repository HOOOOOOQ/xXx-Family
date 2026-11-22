#!/usr/bin/env node
/**
 * scripts/health-check.js
 * ---------------------------------------------------------------------------
 * Query a running instance and print its health report.
 *
 *   node scripts/health-check.js
 *   HEALTH_URL=http://127.0.0.1:4000/health node scripts/health-check.js
 *
 * Exit code 0 when ready, 1 otherwise — usable directly as a Termux watchdog
 * probe (`cron`/`termux-job-scheduler`).
 */

import { initConfig } from '../src/config/index.js';

async function main() {
  const config = initConfig();
  const url = process.env.HEALTH_URL ?? `${config.api.baseUrl}/health`;

  let response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (err) {
    console.error(`Cannot reach ${url}: ${err.message}`);
    console.error('Is the bot running? Start it with `npm start`.');
    process.exit(1);
  }

  const body = await response.json().catch(() => null);
  if (!body) {
    console.error(`Unexpected response from ${url}: HTTP ${response.status}`);
    process.exit(1);
  }

  console.log(`\n${url} — HTTP ${response.status}`);
  console.log(`  status : ${body.status}`);
  console.log(`  uptime : ${formatMs(body.uptimeMs)}`);
  console.log(`  version: ${body.version}\n`);
  for (const [name, check] of Object.entries(body.checks ?? {})) {
    const icon = check.status === 'ok' ? '✓' : check.status === 'degraded' ? '!' : '✗';
    const extra = check.error ? ` — ${check.error}` : check.status === 'degraded' && check.reason ? ` — ${check.reason}` : '';
    console.log(`  ${icon} ${name.padEnd(12)} ${check.status}${extra}`);
  }
  console.log('');

  process.exit(body.ready === false ? 1 : 0);
}

function formatMs(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`;
}

main();
