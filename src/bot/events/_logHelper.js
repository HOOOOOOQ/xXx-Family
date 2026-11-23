/**
 * src/bot/events/_logHelper.js
 * ---------------------------------------------------------------------------
 * Shared scaffolding for the logging events.
 *
 * Every logging event has the same two obligations and the same two failure
 * modes, so they are written once here:
 *
 *   1. never throw into the gateway — a logging event that throws would abort
 *      discord.js's event dispatch and can take other listeners with it
 *   2. never log the bot's own actions as if a member did them, and never log
 *      ephemeral/system noise the guild did not ask for
 *
 * Files starting with `_` are not loaded as events by the event loader.
 */

import { getLogger } from '../../utils/logger.js';

/**
 * Run a logging event body safely.
 *
 * Swallowing is the right behaviour — a logging listener must never abort
 * discord.js's event dispatch — but a swallowed error is otherwise invisible,
 * and a bug here (a TypeError in a rarely-taken branch) would silently stop a
 * category of logs forever. So the failure is recorded as a metric and a
 * warning, and surfaced on the logging health probe.
 *
 * @param {import('../client.js').XxxFamilyClient} client
 * @param {string} label  event name for logs
 * @param {() => Promise<unknown>} fn
 */
export async function safeLog(client, label, fn) {
  if (!client?.logging) return;
  try {
    await fn();
  } catch (err) {
    client.metrics?.increment('logging.eventErrors');
    client.metrics?.increment(`logging.eventErrors.${label}`);
    getLogger().child('logging').warn('Logging event failed', { event: label, reason: err.message });
  }
}

/**
 * `true` when the message should not appear in logs.
 *
 * System messages, messages from the bot itself, and interactions we created
 * (buttons/components) are noise; a webhook message from another bot is not.
 * @param {import('discord.js').Message|{system?:boolean, author?:{bot?:boolean}}|null} message
 * @param {string} [clientUserId]
 */
export function shouldSkipMessage(message, clientUserId) {
  if (!message) return true;
  if (message.system) return true;
  if (clientUserId && message.author?.id === clientUserId) return true;
  return false;
}

export default safeLog;
