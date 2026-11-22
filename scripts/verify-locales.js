#!/usr/bin/env node
/**
 * scripts/verify-locales.js
 * ---------------------------------------------------------------------------
 * Locale QA gate.
 *
 * Checks every locale against the en-US reference:
 *   1. every namespace file exists and is valid JSON
 *   2. the key set is identical (no missing / no orphan keys)
 *   3. interpolation placeholders are a subset of the reference ones (no typos
 *      that would leak raw `{{var}}` into a Discord message)
 *   4. command names/descriptions satisfy Discord's hard limits
 *
 * Exit code 1 on any problem, so it can gate CI.
 *   node scripts/verify-locales.js [--json]
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDiscordCommandName } from '../src/services/i18nService.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES_DIR = join(ROOT, 'src', 'locales');
const NAMESPACES = ['common', 'commands', 'errors', 'components'];
const REFERENCE = 'en-US';

const asJson = process.argv.includes('--json');

function flatten(value, prefix = '', out = new Map()) {
  if (value === null || typeof value !== 'object') {
    out.set(prefix, typeof value === 'string' ? value : JSON.stringify(value));
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

function placeholders(value) {
  const set = new Set();
  for (const match of String(value).matchAll(/{{\s*([\w.]+)\s*}}/g)) set.add(match[1]);
  return [...set].sort();
}

function readBundles(locale) {
  const bundles = {};
  for (const ns of NAMESPACES) {
    const file = join(LOCALES_DIR, locale, `${ns}.json`);
    if (!existsSync(file)) throw new Error(`missing file ${file}`);
    bundles[ns] = JSON.parse(readFileSync(file, 'utf8'));
  }
  return bundles;
}

const problems = [];
const summary = [];

const localeDirs = readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const referenceBundles = readBundles(REFERENCE);
const referenceFlat = new Map();
for (const ns of NAMESPACES) {
  for (const [key, value] of flatten(referenceBundles[ns])) referenceFlat.set(`${ns}:${key}`, value);
}

for (const locale of localeDirs) {
  const issues = [];
  let keyCount = 0;
  let bundles;
  try {
    bundles = readBundles(locale);
  } catch (err) {
    problems.push({ locale, issue: `load: ${err.message}` });
    continue;
  }

  const flat = new Map();
  for (const ns of NAMESPACES) {
    for (const [key, value] of flatten(bundles[ns])) flat.set(`${ns}:${key}`, value);
  }
  keyCount = flat.size;

  for (const [key, referenceValue] of referenceFlat) {
    if (!flat.has(key)) {
      issues.push(`missing key ${key}`);
      continue;
    }
    if (locale !== REFERENCE && typeof referenceValue === 'string') {
      // Placeholders used by the translation must be a SUBSET of the reference
      // ones. An unknown placeholder means a typo that would leak raw `{{x}}`
      // into Discord; a missing one is legitimate because some grammars drop
      // the numeral (Arabic singular/dual: "لغة واحدة متاحة").
      const expected = placeholders(referenceValue);
      const actual = placeholders(flat.get(key));
      const unknown = actual.filter((p) => !expected.includes(p));
      if (unknown.length) {
        issues.push(`unknown placeholder ${key}: [${unknown}] not in reference [${expected}]`);
      }
    }
  }

  for (const key of flat.keys()) {
    // Arabic legitimately carries extra plural forms (zero/two/few/many).
    const isExtraPlural = /_(zero|two|few|many)$/.test(key);
    const referenceHasBase =
      referenceFlat.has(key) || referenceFlat.has(key.replace(/_(zero|two|few|many|one|other)$/, ''));
    if (!referenceFlat.has(key) && !(isExtraPlural && referenceHasBase)) {
      issues.push(`orphan key ${key}`);
    }
  }

  // Discord hard limits for the `commands` namespace, checked with the same
  // validator the bot itself uses so the two can never drift apart.
  const commands = bundles.commands;
  const walkCommands = (node, path) => {
    if (node && typeof node === 'object' && typeof node.name === 'string') {
      if (!isDiscordCommandName(node.name)) {
        issues.push(`command name "${path}" invalid for Discord: "${node.name}"`);
      }
    }
    if (node && typeof node === 'object' && typeof node.description === 'string') {
      const d = node.description;
      if (d.length < 1 || d.length > 100) issues.push(`command description "${path}" length ${d.length} outside 1..100`);
    }
    for (const [k, v] of Object.entries(node ?? {})) {
      if (v && typeof v === 'object') walkCommands(v, `${path}.${k}`);
    }
  };
  for (const [key, value] of Object.entries(commands)) walkCommands(value, key);

  summary.push({ locale, keys: keyCount, issues: issues.length });
  for (const issue of issues) problems.push({ locale, issue });
}

if (asJson) {
  process.stdout.write(`${JSON.stringify({ reference: REFERENCE, summary, problems }, null, 2)}\n`);
} else {
  console.log(`Locale QA — reference: ${REFERENCE}, locales: ${localeDirs.length}`);
  for (const row of summary) {
    console.log(`  ${row.locale.padEnd(6)} ${String(row.keys).padStart(4)} keys  ${row.issues ? `✗ ${row.issues} issue(s)` : '✓ ok'}`);
  }
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems.slice(0, 60)) console.error(`  • [${p.locale}] ${p.issue}`);
  if (problems.length > 60) console.error(`  … and ${problems.length - 60} more`);
  process.exit(1);
}
console.log('\nAll locales are complete and consistent.');
