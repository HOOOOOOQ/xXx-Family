/**
 * src/utils/embeds.js
 * ---------------------------------------------------------------------------
 * Embed builders. Every embed the bot sends is produced here, which is what
 * keeps the Premium Cyberpunk identity (black canvas, purple neon, silver
 * accents) and the localization rules consistent across all 20+ modules.
 */

import { EmbedBuilder } from 'discord.js';

import { BRAND, COLORS, EMBED_COLORS } from '../config/constants.js';
import { applyDirection, truncate } from './format.js';

/**
 * @typedef {object} BrandEmbedOptions
 * @property {(key:string, options?:Record<string, unknown>) => string} [t] bound translator
 * @property {string} [title]
 * @property {string} [description]
 * @property {number} [color]
 * @property {'default'|'success'|'error'|'warning'|'info'|'neutral'} [variant]
 * @property {{ name:string, value:string, inline?:boolean }[]} [fields]
 * @property {string} [footer]
 * @property {string} [thumbnail]
 * @property {string} [image]
 * @property {string} [authorName]
 * @property {string} [authorIcon]
 * @property {'ltr'|'rtl'} [dir]
 */

/**
 * @param {BrandEmbedOptions} [options]
 * @returns {EmbedBuilder}
 */
export function brandEmbed(options = {}) {
  const {
    t,
    title,
    description,
    color,
    variant = 'default',
    fields = [],
    footer,
    thumbnail,
    image,
    authorName,
    authorIcon,
    dir = 'ltr',
  } = options;

  const embed = new EmbedBuilder().setColor(color ?? EMBED_COLORS[variant] ?? EMBED_COLORS.default);

  if (title) embed.setTitle(truncate(applyDirection(title, dir), 256));
  if (description) embed.setDescription(truncate(applyDirection(description, dir), 4096));
  if (thumbnail) embed.setThumbnail(thumbnail);
  if (image) embed.setImage(image);
  if (authorName) embed.setAuthor({ name: truncate(authorName, 256), ...(authorIcon ? { iconURL: authorIcon } : {}) });

  for (const field of fields.slice(0, 25)) {
    embed.addFields({
      name: truncate(applyDirection(field.name, dir), 256),
      value: truncate(applyDirection(field.value, dir), 1024),
      inline: Boolean(field.inline),
    });
  }

  embed.setFooter({
    text: truncate(footer ?? t?.('common:footer.poweredBy') ?? BRAND.footer, 2048),
  });
  embed.setTimestamp();

  return embed;
}

/** Success embed (green). */
export const successEmbed = (options) => brandEmbed({ ...options, variant: 'success' });

/** Error embed (red). */
export const errorEmbed = (options) => brandEmbed({ ...options, variant: 'error' });

/** Informational embed (blue). */
export const infoEmbed = (options) => brandEmbed({ ...options, variant: 'info' });

/** Warning embed (amber). */
export const warningEmbed = (options) => brandEmbed({ ...options, variant: 'warning' });

/**
 * The error embed shown to a user when a command fails. The message is the
 * localized `errors:*` key, never the raw exception text.
 * @param {object} params
 * @param {(key:string, options?:Record<string, unknown>) => string} params.t
 * @param {string} params.i18nKey
 * @param {Record<string, unknown>} [params.values]
 */
export function localizedErrorEmbed({ t, i18nKey, values = {}, dir = 'ltr', description = null }) {
  return errorEmbed({
    t,
    title: '⚠️',
    // A pre-resolved description wins so the embed can never disagree with the
    // message the caller already decided on.
    description: description ?? t(i18nKey, values),
    dir,
  });
}

/** Raw colour palette, exposed for cards and canvases. */
export { COLORS, BRAND };
