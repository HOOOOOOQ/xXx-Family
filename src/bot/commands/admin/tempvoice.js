/**
 * src/bot/commands/admin/tempvoice.js
 * ---------------------------------------------------------------------------
 * /tempvoice — configure join-to-create, and manage your own room.
 *
 * Configuration (ManageGuild):
 *   view · enable · disable · trigger · category · roomname · defaultlimit
 *   · privacy · grace
 *
 * Room control (the room owner, from inside the room):
 *   rename · roomlimit · lock · unlock · transfer
 *
 * The two halves live in one command on purpose: a room owner is not a server
 * admin, so each branch checks its own authority rather than the command
 * carrying a blanket default permission.
 */

import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';

import { COLORS } from '../../../config/constants.js';
import { brandEmbed } from '../../../utils/embeds.js';
import { PermissionDeniedError, ValidationError } from '../../../utils/errors.js';
import { DEFAULT_TEMPVOICE_CONFIG } from '../../../database/models/TempVoiceConfig.js';

/** Room-control subcommands — the owner may use these without ManageGuild. */
const ROOM_SUBCOMMANDS = new Set(['rename', 'roomlimit', 'lock', 'unlock', 'transfer']);

function requireGuild(interaction) {
  if (!interaction.inGuild()) {
    throw new PermissionDeniedError('Temporary voice requires a server', { i18nKey: 'errors:guildOnly' });
  }
}

function requireManageGuild(interaction) {
  if (!interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new PermissionDeniedError('ManageGuild is required to configure temporary voice', {
      i18nKey: 'errors:missingPermissions',
      details: { permissions: 'ManageGuild' },
    });
  }
}

/**
 * The member's current voice channel, for room-control subcommands.
 *
 * These are only meaningful from inside a temporary room; anywhere else the
 * service would just report "not a temp room", which is a worse answer than
 * "you are not in a voice channel".
 */
function requireVoiceChannel(interaction) {
  const channelId = interaction.member?.voice?.channelId;
  if (!channelId) {
    throw new ValidationError('Join your temporary voice room first', {
      i18nKey: 'errors:validation',
      details: { reason: 'you are not in a voice channel' },
    });
  }
  return channelId;
}

function configEmbed({ t, dir, config, guild }) {
  const yes = '✅';
  const no = '⬜';
  const lines = [
    `**${t('common:tempVoice.trigger')}:** ${config.triggerChannelId ? `<#${config.triggerChannelId}>` : t('common:tempVoice.notSet')}`,
    `**${t('common:tempVoice.category')}:** ${config.categoryId ? `<#${config.categoryId}>` : t('common:tempVoice.notSet')}`,
    `**${t('common:tempVoice.roomName')}:** \`${config.roomName}\``,
    `**${t('common:tempVoice.userLimit')}:** ${config.userLimit === 0 ? t('common:tempVoice.unlimited') : config.userLimit}`,
    `**${t('common:tempVoice.privacy')}:** ${config.startPrivate ? t('common:tempVoice.private') : t('common:tempVoice.open')}`,
    `**${t('common:tempVoice.startLocked')}:** ${config.startLocked ? yes : no}`,
    `**${t('common:tempVoice.grace')}:** ${Math.round((config.emptyGraceMs ?? 0) / 1000)}s`,
    `**${t('common:tempVoice.maxOwned')}:** ${config.maxOwnedPerUser}`,
  ];

  return brandEmbed({
    t,
    dir,
    variant: config.enabled ? 'success' : 'info',
    color: config.enabled ? COLORS.success : COLORS.silverDim,
    title: `🎙️ ${t('common:tempVoice.title')} — ${guild.name}`,
    description: `${t('common:tempVoice.status')}: **${
      config.enabled ? t('common:tempVoice.enabled') : t('common:tempVoice.disabled')
    }**\n\n${lines.join('\n')}`,
    footer: `${t('common:tempVoice.placeholders')}: {user} {number}`,
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('tempvoice')
    .setDescription('Join-to-create temporary voice rooms.')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub.setName('view').setDescription('Show the temporary voice configuration.'))
    .addSubcommand((sub) => sub.setName('enable').setDescription('Turn join-to-create on.'))
    .addSubcommand((sub) => sub.setName('disable').setDescription('Turn join-to-create off.'))
    .addSubcommand((sub) =>
      sub
        .setName('trigger')
        .setDescription('Set the channel that creates a room when joined.')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('The trigger channel. Choose none to clear.')
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('category')
        .setDescription('Set the category new rooms are created in.')
        .addChannelOption((option) =>
          option.setName('channel').setDescription('The category. Choose none to clear.').addChannelTypes(ChannelType.GuildCategory),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('roomname')
        .setDescription('Set the room name template. Placeholders: {user} {number}')
        .addStringOption((option) => option.setName('template').setDescription('The template, e.g. {user}\'s room').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('defaultlimit')
        .setDescription('Set the default member limit for new rooms.')
        .addIntegerOption((option) =>
          option.setName('limit').setDescription('0 for unlimited.').setRequired(true).setMinValue(0).setMaxValue(99),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('privacy')
        .setDescription('Choose whether new rooms start hidden.')
        .addBooleanOption((option) => option.setName('private').setDescription('True to hide new rooms.').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('grace')
        .setDescription('How long an empty room survives before deletion.')
        .addIntegerOption((option) =>
          option.setName('seconds').setDescription('Seconds to wait. 0 deletes immediately.').setRequired(true).setMinValue(0).setMaxValue(3600),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('rename')
        .setDescription('Rename your temporary room.')
        .addStringOption((option) => option.setName('name').setDescription('The new name.').setRequired(true).setMaxLength(100)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('roomlimit')
        .setDescription('Change the member limit of your temporary room.')
        .addIntegerOption((option) =>
          option.setName('limit').setDescription('0 for unlimited.').setRequired(true).setMinValue(0).setMaxValue(99),
        ),
    )
    .addSubcommand((sub) => sub.setName('lock').setDescription('Stop others from joining your temporary room.'))
    .addSubcommand((sub) => sub.setName('unlock').setDescription('Let others join your temporary room again.'))
    .addSubcommand((sub) =>
      sub
        .setName('transfer')
        .setDescription('Give your temporary room to another member in it.')
        .addUserOption((option) => option.setName('user').setDescription('The new owner.').setRequired(true)),
    ),

  category: 'admin',
  cooldown: 3000,

  async execute(interaction, { client, t, dir }) {
    requireGuild(interaction);

    const subcommand = interaction.options.getSubcommand();
    const tempVoice = client.tempVoice;
    const guild = interaction.guild;

    if (!tempVoice) {
      throw new ValidationError('The temporary voice module is not running', {
        i18nKey: 'errors:validation',
        details: { reason: 'temp voice unavailable' },
      });
    }

    // Room control checks ownership inside the service; configuration needs
    // ManageGuild up front.
    if (!ROOM_SUBCOMMANDS.has(subcommand)) requireManageGuild(interaction);

    const config = await tempVoice.getConfig(guild.id);

    const reply = (payload) => interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    const replyConfig = (next) => reply({ embeds: [configEmbed({ t, dir, config: next, guild })] });

    switch (subcommand) {
      case 'view':
        await replyConfig(config);
        return;

      case 'enable':
      case 'disable': {
        const enabled = subcommand === 'enable';
        // Turning it on with no trigger channel would look like it worked and
        // then do nothing at all, so refuse.
        if (enabled && !config.triggerChannelId) {
          throw new ValidationError('Set a trigger channel before enabling temporary voice', {
            i18nKey: 'errors:validation',
            details: { reason: 'no trigger channel is set' },
          });
        }
        await replyConfig(await tempVoice.saveConfig(guild.id, { enabled }));
        return;
      }

      case 'trigger': {
        const channel = interaction.options.getChannel('channel');
        await replyConfig(await tempVoice.saveConfig(guild.id, { triggerChannelId: channel?.id ?? null }));
        return;
      }

      case 'category': {
        const category = interaction.options.getChannel('channel');
        await replyConfig(await tempVoice.saveConfig(guild.id, { categoryId: category?.id ?? null }));
        return;
      }

      case 'roomname': {
        const template = interaction.options.getString('template');
        // Render it once here so a typo is caught now, not the next time
        // somebody joins the trigger and gets a room called "{usr}'s room".
        const preview = tempVoice.roomName(template, interaction.member, 1);
        const next = await tempVoice.saveConfig(guild.id, { roomName: template.slice(0, 100) });
        await reply({
          embeds: [
            brandEmbed({
              t,
              dir,
              variant: 'success',
              title: `🎙️ ${t('common:tempVoice.saved')}`,
              description: `${t('common:tempVoice.preview')}: **${preview}**`,
            }),
            configEmbed({ t, dir, config: next, guild }),
          ],
        });
        return;
      }

      case 'defaultlimit':
        await replyConfig(await tempVoice.saveConfig(guild.id, { userLimit: interaction.options.getInteger('limit') }));
        return;

      case 'privacy': {
        const isPrivate = interaction.options.getBoolean('private');
        await replyConfig(await tempVoice.saveConfig(guild.id, { startPrivate: isPrivate }));
        return;
      }

      case 'grace': {
        const seconds = interaction.options.getInteger('seconds');
        await replyConfig(await tempVoice.saveConfig(guild.id, { emptyGraceMs: seconds * 1000 }));
        return;
      }

      case 'rename': {
        const channelId = requireVoiceChannel(interaction);
        const result = await tempVoice.rename({
          guild,
          channelId,
          member: interaction.member,
          name: interaction.options.getString('name'),
        });
        await reply({ embeds: [roomResultEmbed({ t, dir, result, ok: result.ok, detail: result.name })] });
        return;
      }

      case 'roomlimit': {
        const channelId = requireVoiceChannel(interaction);
        const result = await tempVoice.setLimit({
          guild,
          channelId,
          member: interaction.member,
          limit: interaction.options.getInteger('limit'),
        });
        await reply({
          embeds: [
            roomResultEmbed({
              t,
              dir,
              result,
              ok: result.ok,
              detail: result.ok ? (result.limit === 0 ? t('common:tempVoice.unlimited') : String(result.limit)) : null,
            }),
          ],
        });
        return;
      }

      case 'lock':
      case 'unlock': {
        const channelId = requireVoiceChannel(interaction);
        const locked = subcommand === 'lock';
        const result = await tempVoice.setLocked({ guild, channelId, member: interaction.member, locked });
        await reply({ embeds: [roomResultEmbed({ t, dir, result, ok: result.ok })] });
        return;
      }

      case 'transfer': {
        const channelId = requireVoiceChannel(interaction);
        const user = interaction.options.getUser('user');
        const result = await tempVoice.transferOwnership({
          guild,
          channelId,
          member: interaction.member,
          newOwnerId: user.id,
        });
        await reply({
          embeds: [roomResultEmbed({ t, dir, result, ok: result.ok, detail: result.ok ? `<@${result.ownerId}>` : null })],
        });
        return;
      }

      default:
        throw new ValidationError(`Unknown subcommand "${subcommand}"`, {
          i18nKey: 'errors:validation',
          details: { reason: subcommand },
        });
    }
  },
};

/**
 * Turn a service result into a message.
 *
 * Every failure the service can report gets its own text, because "that did not
 * work" tells a room owner nothing about what to do next.
 */
function roomResultEmbed({ t, dir, result, ok, detail = null }) {
  if (ok) {
    return brandEmbed({
      t,
      dir,
      variant: 'success',
      color: COLORS.success,
      title: `🎙️ ${t('common:tempVoice.done')}`,
      description: detail ? String(detail) : t('common:tempVoice.saved'),
    });
  }

  const keyByReason = {
    'not-a-temp-room': 'common:tempVoice.errors.notTempRoom',
    'not-owner': 'common:tempVoice.errors.notOwner',
    'empty-name': 'common:tempVoice.errors.emptyName',
    'invalid-limit': 'common:tempVoice.errors.invalidLimit',
    'missing-channel': 'common:tempVoice.errors.missingChannel',
    'not-in-room': 'common:tempVoice.errors.notInRoom',
    'discord-rejected': 'common:tempVoice.errors.discordRejected',
  };
  const key = keyByReason[result.reason] ?? 'common:tempVoice.errors.unknown';

  return brandEmbed({
    t,
    dir,
    variant: 'error',
    color: COLORS.danger,
    title: `🎙️ ${t('common:tempVoice.title')}`,
    description: t(key),
  });
}

export { configEmbed, roomResultEmbed, ROOM_SUBCOMMANDS, DEFAULT_TEMPVOICE_CONFIG };
