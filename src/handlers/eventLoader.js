/**
 * src/handlers/eventLoader.js
 * ---------------------------------------------------------------------------
 * Discord event registration.
 *
 * An event file default-exports:
 *   export default {
 *     name: Events.InteractionCreate,   // or a plain string
 *     once: false,
 *     async execute(client, ...args) { … }
 *   };
 *
 * Every handler is wrapped so a throw becomes a structured log entry plus a
 * localized reply (when an interaction is involved) instead of an unhandled
 * rejection that would take the process down.
 */

import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { ValidationError } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';

/**
 * Validate an event module.
 * @param {object} event
 * @param {string} file
 */
export function validateEvent(event, file) {
  const where = `event file "${file}"`;
  if (!event || typeof event !== 'object') throw new ValidationError(`${where} does not default-export an object`);
  if (typeof event.name !== 'string' || event.name.length === 0) {
    throw new ValidationError(`${where} is missing a "name"`);
  }
  if (typeof event.execute !== 'function') throw new ValidationError(`${where} is missing an execute() function`);
  return { ...event, once: Boolean(event.once) };
}

/**
 * @param {string} directory
 * @param {object} [options]
 * @param {boolean} [options.strict]
 * @returns {Promise<{ events: object[], errors: { file:string, message:string }[] }>}
 */
export async function loadEvents(directory, options = {}) {
  const logger = getLogger().child('events');
  const strict = options.strict ?? true;
  const events = [];
  const errors = [];

  const files = (
    await readdir(directory, { withFileTypes: true }).catch((err) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    })
  )
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js') && !entry.name.startsWith('_'))
    .map((entry) => join(directory, entry.name))
    .sort();

  for (const file of files) {
    const rel = relative(process.cwd(), file);
    try {
      const mod = await import(`file://${file}`);
      // A file may export one event as `default`, or several as named exports
      // (used to keep the shard lifecycle events together in shard.js).
      const candidates = [];
      if (mod.default && typeof mod.default === 'object') candidates.push(mod.default);
      for (const [key, value] of Object.entries(mod)) {
        if (key === 'default') continue;
        if (value && typeof value === 'object' && typeof value.name === 'string' && typeof value.execute === 'function') {
          candidates.push(value);
        }
      }
      if (!candidates.length) throw new ValidationError(`event file "${rel}" exports no event object`);
      for (const candidate of candidates) events.push(validateEvent(candidate, rel));
    } catch (err) {
      errors.push({ file: rel, message: err.message });
      logger.errorFrom(err, 'Failed to load event', { file: rel });
      if (strict) throw err;
    }
  }

  logger.info('Events loaded', { count: events.length, names: events.map((e) => e.name) });
  return { events, errors };
}

/**
 * Bind loaded events to a client.
 * @param {import('discord.js').Client} client
 * @param {object[]} events
 * @returns {number} number of listeners registered
 */
export function registerEvents(client, events) {
  const logger = getLogger().child('events');
  let count = 0;

  for (const event of events) {
    const listener = async (...args) => {
      try {
        await event.execute(client, ...args);
      } catch (err) {
        logger.errorFrom(err, 'Event handler threw', { event: event.name });
        // Surface client-level failures on the client's own error channel so
        // the process-wide handler can decide whether to restart.
        client.emit?.('handlerError', err, { event: event.name });
      }
    };

    if (event.once) client.once(event.name, listener);
    else client.on(event.name, listener);
    count += 1;
  }

  return count;
}
