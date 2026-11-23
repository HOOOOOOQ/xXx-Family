/**
 * src/middleware/interactionErrorHandler.js
 * ---------------------------------------------------------------------------
 * Single place that turns a thrown error into a Discord reply.
 *
 * Rules:
 *   - the user always sees a *localized* `errors:*` message, never a stack
 *   - AppErrors with `expose: true` may show their own message
 *   - the technical detail goes to the structured log, with secrets redacted
 *   - if the interaction was already acknowledged we edit, otherwise we reply
 *     (and if replying is impossible we fall back to a DM, then give up quietly)
 */

import { MessageFlags } from 'discord.js';

import { getLogger } from '../utils/logger.js';
import { isAppError, normalizeError, resolveUserMessage } from '../utils/errors.js';
import { localizedErrorEmbed } from '../utils/embeds.js';
import { getT } from '../services/i18nService.js';
import { DEFAULT_LOCALE } from '../config/locales.js';

/**
 * @param {import('discord.js').Interaction} interaction
 * @param {unknown} err
 * @param {object} [context]
 * @param {string} [context.command]
 * @param {(key:string, options?:Record<string, unknown>) => string} [context.t]
 * @param {string} [context.locale]
 */
export async function handleInteractionError(interaction, err, context = {}) {
  const logger = getLogger().child('interaction-error');
  const normalized = normalizeError(err);
  const locale = context.locale ?? DEFAULT_LOCALE;
  const t = context.t ?? getT(locale);

  logger.errorFrom(err, 'Interaction failed', {
    command: context.command ?? interaction?.commandName ?? null,
    interactionId: interaction?.id,
    guildId: interaction?.guildId ?? null,
    userId: interaction?.user?.id ?? null,
    errorCode: normalized.code,
    statusCode: normalized.statusCode,
  });

  const values = isAppError(err) && err.details ? err.details : {};
  // Resolve the user-facing string ONCE, then reuse it for the embed, so what
  // is logged as `description` is exactly what the member sees. It also makes a
  // raw `{{placeholder}}` impossible to send when `details` is incomplete.
  const description = resolveUserMessage(err, { t, i18nKey: normalized.i18nKey, values });
  const embed = localizedErrorEmbed({ t, i18nKey: normalized.i18nKey, values, description });

  const payload = { embeds: [embed], flags: MessageFlags.Ephemeral };

  try {
    if (!interaction || interaction.replied || interaction.deferred) {
      // Best effort: replace a deferred "thinking…" state with the error.
      const followUpPayload = { embeds: [embed], flags: MessageFlags.Ephemeral };
      if (interaction?.deferred && !interaction.replied) await interaction.editReply(followUpPayload);
      else if (interaction?.replied) await interaction.followUp(followUpPayload);
      return { delivered: Boolean(interaction), fallback: true, description };
    }

    if (interaction.isRepliable?.()) {
      await interaction.reply(payload);
      return { delivered: true, fallback: false, description };
    }
    return { delivered: false, fallback: false, description };
  } catch (replyError) {
    // The interaction token is probably expired (>3s / >15min). Log and move on.
    logger.warn('Could not deliver error reply', { reason: replyError.message });
    return { delivered: false, fallback: false, description };
  }
}

export default handleInteractionError;
