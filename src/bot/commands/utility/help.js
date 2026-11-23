import {
  ActionRowBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
  InteractionContextType,
} from 'discord.js';

import { COLORS } from '../../../config/constants.js';
import { brandEmbed } from '../../../utils/embeds.js';
import { truncate } from '../../../utils/format.js';

const CATEGORY_EMOJI = {
  utility: '🛠️',
  admin: '🛡️',
  moderation: '⚖️',
  community: '🌐',
  economy: '💰',
  games: '🎮',
  ai: '🤖',
  general: '📦',
};

/**
 * Build the help embed. `category` narrows the list; the localized command name
 * comes from the `commands` namespace so the directory is never English-only.
 */
function buildHelpEmbed(client, t, { category = null, command = null, dir = 'ltr' } = {}) {
  const all = [...client.commands.values()].sort((a, b) => a.name.localeCompare(b.name));

  if (command) {
    const entry = all.find((c) => c.name === command || t(`commands:${c.i18nKey}.name`) === command);
    if (!entry) return brandEmbed({ t, dir, title: '❓', description: t('errors:commandNotFound'), variant: 'warning' });

    const localizedName = t(`commands:${entry.i18nKey}.name`);
    const localizedDescription = t(`commands:${entry.i18nKey}.description`);
    return brandEmbed({
      t,
      dir,
      color: COLORS.neon,
      title: `/${localizedName}`,
      description: localizedDescription,
      fields: [
        { name: t('commands:responses.helpCategory'), value: `${CATEGORY_EMOJI[entry.category] ?? '📦'} ${entry.category}`, inline: true },
        {
          name: t('commands:responses.helpCooldown'),
          value: `${entry.cooldown / 1000}s`,
          inline: true,
        },
        {
          name: t('commands:responses.helpPermissions'),
          value: entry.userPermissions.length ? entry.userPermissions.join(', ') : t('commands:responses.helpEveryone'),
          inline: true,
        },
      ],
    });
  }

  const filtered = category ? all.filter((c) => c.category === category) : all;
  if (!filtered.length) {
    return brandEmbed({ t, dir, title: t('commands:responses.helpTitle'), description: t('commands:responses.helpNoCommands'), variant: 'warning' });
  }

  const grouped = new Map();
  for (const entry of filtered) {
    if (!grouped.has(entry.category)) grouped.set(entry.category, []);
    grouped.get(entry.category).push(entry);
  }

  const fields = [...grouped.entries()].map(([name, entries]) => ({
    name: `${CATEGORY_EMOJI[name] ?? '📦'} ${name.toUpperCase()}`,
    value: truncate(
      entries
        .map((entry) => `\`/${t(`commands:${entry.i18nKey}.name`)}\` — ${t(`commands:${entry.i18nKey}.description`)}`)
        .join('\n'),
      1024,
    ),
    inline: false,
  }));

  return brandEmbed({
    t,
    dir,
    color: COLORS.neon,
    title: `📚 ${t('commands:responses.helpTitle')}`,
    description: t('commands:responses.helpDescription'),
    fields: fields.slice(0, 25),
  });
}

function buildCategoryRow(client, t, activeCategory) {
  const categories = [...new Set([...client.commands.values()].map((c) => c.category))].sort();
  if (categories.length <= 1) return null;

  const select = new StringSelectMenuBuilder()
    .setCustomId('help:category')
    .setPlaceholder(t('components:selects.categoryPlaceholder'))
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      categories.slice(0, 25).map((category) => ({
        label: `${CATEGORY_EMOJI[category] ?? '📦'} ${category}`,
        value: category,
        description: `${client.commands.filter((c) => c.category === category).size} commands`,
      })),
    );

  if (activeCategory && categories.includes(activeCategory)) select.setDefaultValues?.([activeCategory]);
  return new ActionRowBuilder().addComponents(select);
}

export default {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show every command or the details of a single command.')
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM)
    .addStringOption((option) =>
      option.setName('command').setDescription('The command you want details for.').setRequired(false),
    ),
  category: 'utility',
  cooldown: 3000,

  /** Wire the category filter component. Called once during client init. */
  async register(client) {
    client.registerComponent('help', async (interaction, ctx) => {
      const category = interaction.isStringSelectMenu() ? interaction.values[0] : ctx.payload;
      const embed = buildHelpEmbed(client, ctx.t, { category, dir: ctx.dir });
      const row = buildCategoryRow(client, ctx.t, category);
      await interaction.update({ embeds: [embed], components: row ? [row] : [] });
    });
  },

  async execute(interaction, { client, t, dir }) {
    const requested = interaction.options.getString('command');
    const embed = buildHelpEmbed(client, t, { command: requested, dir });
    const row = requested ? null : buildCategoryRow(client, t, null);

    await interaction.reply({
      embeds: [embed],
      components: row ? [row] : [],
      flags: MessageFlags.Ephemeral,
    });
  },
};

export { buildHelpEmbed, buildCategoryRow };
