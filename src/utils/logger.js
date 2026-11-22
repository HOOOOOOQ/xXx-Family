/**
 * src/utils/logger.js
 * ---------------------------------------------------------------------------
 * Structured logger.
 *
 * Two output formats, chosen with LOG_FORMAT:
 *   - `json`   one JSON object per line — what Termux/PM2/log aggregators want
 *   - `pretty` colourised human output for the terminal
 *
 * Every record carries: ts, level, name, msg and any structured fields.
 * Secrets are scrubbed before anything is written (see utils/redact.js).
 * No external dependency, so it behaves identically on Android Termux.
 */

import { redact, registerSecret } from './redact.js';

export const LOG_LEVELS = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 100,
});

const LEVEL_LABEL = Object.freeze({
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
});

const ANSI = Object.freeze({
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  grey: '\u001b[90m',
  cyan: '\u001b[36m',
  purple: '\u001b[35m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
});

const LEVEL_COLOR = {
  10: ANSI.dim,
  20: ANSI.cyan,
  30: ANSI.green,
  40: ANSI.yellow,
  50: ANSI.red,
  60: `${ANSI.bold}${ANSI.red}`,
};

const RESERVED_KEYS = new Set(['msg', 'message', 'level', 'name', 'ts', 'time']);

function clockLabel(date) {
  return date.toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function stringifyFields(fields) {
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value === null) {
      parts.push(`${key}=null`);
      continue;
    }
    const rendered = typeof value === 'string' ? value : JSON.stringify(value);
    parts.push(`${key}=${/\s|"/.test(rendered) ? JSON.stringify(rendered) : rendered}`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/**
 * @typedef {object} LoggerOptions
 * @property {string} [name]
 * @property {string} [level]      minimum level name
 * @property {'json'|'pretty'} [format]
 * @property {(line:string, record:object)=>void} [sink] custom writer (tests)
 * @property {boolean} [color]     force colours on/off
 * @property {Record<string, unknown>} [bindings]
 */

export class Logger {
  /** @param {LoggerOptions} [options] */
  constructor(options = {}) {
    this.name = options.name ?? 'app';
    this.levelName = options.level ?? 'info';
    this.minLevel = LOG_LEVELS[this.levelName] ?? LOG_LEVELS.info;
    this.format = options.format === 'json' ? 'json' : 'pretty';
    this.sink = options.sink ?? null;
    this.bindings = options.bindings ?? {};
    this.useColor = options.color ?? (process.stdout.isTTY === true && this.format === 'pretty');
    this.records = []; // in-memory ring buffer, exposed on /health for debugging
    this.maxBuffered = options.maxBuffered ?? 100;
  }

  /** @param {LoggerOptions} [overrides] @returns {Logger} */
  configure(overrides = {}) {
    if (overrides.level && LOG_LEVELS[overrides.level] !== undefined) {
      this.levelName = overrides.level;
      this.minLevel = LOG_LEVELS[overrides.level];
    }
    if (overrides.format === 'json' || overrides.format === 'pretty') this.format = overrides.format;
    if (typeof overrides.color === 'boolean') this.useColor = overrides.color;
    return this;
  }

  /**
   * Scoped child logger. Bindings are inherited and merged.
   * @param {Record<string, unknown>|string} bindingsOrName
   * @param {Record<string, unknown>} [extraBindings]
   * @returns {Logger}
   */
  child(bindingsOrName, extraBindings = {}) {
    const bindings =
      typeof bindingsOrName === 'string'
        ? { ...extraBindings, scope: bindingsOrName }
        : { ...bindingsOrName, ...extraBindings };
    const child = new Logger({
      name: bindings.scope ? `${this.name}:${bindings.scope}` : this.name,
      level: this.levelName,
      format: this.format,
      sink: this.sink,
      color: this.useColor,
      bindings: { ...this.bindings, ...bindings },
      maxBuffered: this.maxBuffered,
    });
    delete child.bindings.scope;
    child.records = this.records; // shared ring buffer
    return child;
  }

  /** @param {string} levelName @returns {boolean} */
  isLevelEnabled(levelName) {
    return (LOG_LEVELS[levelName] ?? LOG_LEVELS.info) >= this.minLevel;
  }

  #write(levelName, message, fields) {
    const level = LOG_LEVELS[levelName];
    if (level < this.minLevel) return;

    const now = new Date();
    const record = {
      ts: now.toISOString(),
      level: levelName,
      name: this.name,
      msg: redact(message),
    };
    if (Object.keys(this.bindings).length) Object.assign(record, redact(this.bindings));
    if (fields && Object.keys(fields).length) Object.assign(record, redact(fields));

    this.records.push(record);
    if (this.records.length > this.maxBuffered) this.records.splice(0, this.records.length - this.maxBuffered);

    const line =
      this.format === 'json'
        ? JSON.stringify(record)
        : this.#prettify(record, now, fields ?? {});

    if (this.sink) {
      this.sink(line, record);
      return;
    }
    const stream = level >= LOG_LEVELS.error ? process.stderr : process.stdout;
    stream.write(`${line}\n`);
  }

  #prettify(record, now, rawFields) {
    const c = this.useColor ? LEVEL_COLOR[LOG_LEVELS[record.level]] ?? '' : '';
    const end = this.useColor ? ANSI.reset : '';
    const dim = this.useColor ? ANSI.grey : '';
    const purple = this.useColor ? ANSI.purple : '';
    const label = (LEVEL_LABEL[LOG_LEVELS[record.level]] ?? record.level.toUpperCase()).padEnd(5);

    const fields = {};
    for (const [k, v] of Object.entries(rawFields)) if (!RESERVED_KEYS.has(k)) fields[k] = redact(v);

    return (
      `${dim}${clockLabel(now)}${end} ${c}${label}${end} ` +
      `${purple}[${record.name}]${end} ${record.msg}${stringifyFields(fields)}`
    );
  }

  trace(msg, fields) { this.#write('trace', msg, fields); }
  debug(msg, fields) { this.#write('debug', msg, fields); }
  info(msg, fields) { this.#write('info', msg, fields); }
  warn(msg, fields) { this.#write('warn', msg, fields); }
  error(msg, fields) { this.#write('error', msg, fields); }
  fatal(msg, fields) { this.#write('fatal', msg, fields); }

  /**
   * Log an Error with its stack (stack is truncated + redacted).
   * @param {unknown} err
   * @param {string} [message]
   * @param {Record<string, unknown>} [fields]
   */
  errorFrom(err, message = 'Unhandled error', fields = {}) {
    const base = err instanceof Error ? err : new Error(String(err));
    this.error(message, {
      ...fields,
      errorName: base.name,
      errorMessage: base.message,
      errorCode: base.code,
      stack: base.stack ? String(base.stack).split('\n').slice(0, 8).join('\n') : undefined,
    });
  }

  /** @returns {object[]} most recent records (newest last). */
  recent(count = 20) {
    return this.records.slice(-count);
  }
}

let rootLogger = null;

/**
 * Get (or lazily create) the process-wide root logger.
 * @param {Partial<LoggerOptions>} [options]
 * @returns {Logger}
 */
export function getLogger(options = {}) {
  if (!rootLogger) {
    rootLogger = new Logger({
      name: options.name ?? 'xxx-family',
      level: options.level ?? process.env.LOG_LEVEL ?? 'info',
      format: options.format === 'json' ? 'json' : options.format === 'pretty' ? 'pretty' : process.env.LOG_FORMAT === 'json' ? 'json' : 'pretty',
      maxBuffered: options.maxBuffered ?? 100,
    });
  } else if (options.level || options.format) {
    rootLogger.configure(options);
  }
  return rootLogger;
}

/** Replace the root logger (used by the boot sequence and by tests). */
export function setLogger(logger) {
  rootLogger = logger;
  return rootLogger;
}

/** Convenience: register secrets on the root logger at boot. */
export { registerSecret };

export default getLogger;
