import { SlashCommandBuilder, MessageFlags, InteractionContextType } from 'discord.js';

import { BRAND } from '../../../config/constants.js';
import { brandEmbed } from '../../../utils/embeds.js';
import { formatDuration, formatBytes, discordTimestamp } from '../../../utils/format.js';
import { getDatabaseHealth } from '../../../database/connection.js';

/**
 * /uptime — process, gateway and database state in one embed.
 * Also the fastest way for a Termux user to confirm the bot is really alive.
 */
export default {
  data: new SlashCommandBuilder().setName('uptime')
    .setDescription('Show how long xXx Family has been running.')
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM),
  category: 'utility',
  cooldown: 3000,

  async execute(interaction, { t, dir }) {
    const client = interaction.client;
    const db = getDatabaseHealth();
    const memory = process.memoryUsage();
    const startedAt = client.bootedAt ?? new Date(Date.now() - Math.round(process.uptime() * 1000));

    const embed = brandEmbed({
      t,
      dir,
      title: `⏱️ ${t('commands:responses.uptimeTitle')}`,
      description: `${BRAND.name} v${BRAND.version} — ${BRAND.edition}`,
      fields: [
        { name: t('common:fields.uptime'), value: formatDuration(process.uptime() * 1000, t), inline: true },
        { name: t('common:fields.startedAt'), value: discordTimestamp(startedAt, 'R'), inline: true },
        { name: t('common:fields.version'), value: BRAND.version, inline: true },
        {
          name: t('common:fields.database'),
          value: t(`common:status.${db.status === 'connected' ? 'online' : db.status === 'unconfigured' ? 'unknown' : 'degraded'}`),
          inline: true,
        },
        { name: t('common:fields.guilds'), value: String(client.guilds.cache.size), inline: true },
        { name: t('common:fields.commands'), value: String(client.commands.size), inline: true },
        { name: t('common:fields.memory'), value: formatBytes(memory.rss), inline: true },
        { name: t('common:fields.node'), value: process.version, inline: true },
        {
          name: t('common:fields.shard'),
          value: `${client.shard?.ids?.[0] ?? 0}${client.shard?.count ? `/${client.shard.count}` : ''}`,
          inline: true,
        },
      ],
    });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
