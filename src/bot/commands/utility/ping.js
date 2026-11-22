import { SlashCommandBuilder, MessageFlags, InteractionContextType } from 'discord.js';

import { pingDatabase } from '../../../database/connection.js';
import { brandEmbed } from '../../../utils/embeds.js';
import { COLORS } from '../../../config/constants.js';

/**
 * /ping — latency report.
 *
 * Three independent measurements so a slow reply can be attributed:
 *   round trip : Discord → bot → Discord (interaction acknowledgement)
 *   gateway    : websocket heartbeat ping
 *   database   : a real MongoDB `ping` command
 */
export default {
  data: new SlashCommandBuilder().setName('ping')
    .setDescription('Check the bot, gateway and database latency.')
    .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM),
  category: 'utility',
  cooldown: 3000,

  async execute(interaction, { t, dir }) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const roundTripMs = Math.max(0, Date.now() - interaction.createdTimestamp);

    const gatewayMs = interaction.client.ws.ping;
    const db = await pingDatabase();

    const embed = brandEmbed({
      t,
      dir,
      title: `📡 ${t('commands:responses.pingTitle')}`,
      color: COLORS.neon,
      fields: [
        { name: t('common:fields.roundtrip'), value: `\`${roundTripMs} ms\``, inline: true },
        {
          name: t('common:fields.gateway'),
          value: Number.isFinite(gatewayMs) ? `\`${Math.round(gatewayMs)} ms\`` : `\`${t('common:unknown')}\``,
          inline: true,
        },
        {
          name: t('common:fields.database'),
          value: db.ok ? `\`${Math.round(db.latencyMs)} ms\`` : `\`${t('common:status.offline')}\``,
          inline: true,
        },
      ],
    });

    await interaction.editReply({ embeds: [embed] });
  },
};
