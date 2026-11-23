/**
 * src/bot/commands/admin/ticket.js
 * ---------------------------------------------------------------------------
 * /ticket — open and manage support tickets, and configure the panel.
 *
 * Configuration (ManageGuild):
 *   view · enable · disable · panel · staffrole · transcript · category
 *   · cooldown · maxopen
 *
 * Anyone:
 *   open · close · stats
 *
 * Staff (the configured staff role, or ManageMessages):
 *   claim · add · priority
 *
 * Opening a ticket creates a real channel, so it is rate limited twice over:
 * the command cooldown here, and the per-user ticket cooldown in the service,
 * which is the one that actually stops someone spamming channels into
 * existence.
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
import { DEFAULT_TICKET_CONFIG } from '../../../database/models/TicketConfig.js';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

function requireGuild(interaction) {
  if (!interaction.inGuild()) {
    throw new PermissionDeniedError('Tickets require a server', { i18nKey: 'errors:guildOnly' });
  }
}

function requireManageGuild(interaction) {
  if (!interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new PermissionDeniedError('ManageGuild is required to configure tickets', {
      i18nKey: 'errors:missingPermissions',
      details: { permissions: 'ManageGuild' },
    });
  }
}

/**
 * Whether the member counts as staff.
 *
 * The staff role is the configured one; ManageMessages is accepted as a
 * fallback so a server that has not set a staff role can still moderate its
 * tickets rather than being locked out of its own system.
 */
function isStaff(member, staffRoleId) {
  if (!member) return false;
  if (staffRoleId && member.roles?.cache?.has?.(staffRoleId)) return true;
  if (staffRoleId && Array.isArray(member.roles?.valueOf?.()) && member.roles.valueOf().includes(staffRoleId)) return true;
  return Boolean(member.permissions?.has?.(PermissionFlagsBits.ManageMessages));
}

function requireStaff(interaction, config, t) {
  if (!isStaff(interaction.member, config.staffRoleId)) {
    throw new PermissionDeniedError('That action is for staff', {
      i18nKey: 'errors:missingPermissions',
      details: { permissions: t('common:tickets.panel.notStaff') },
    });
  }
}

function configEmbed({ t, dir, config }) {
  const lines = [
    `**${t('common:tickets.panel.status')}:** ${config.enabled ? t('common:tickets.panel.enabled') : t('common:tickets.panel.disabledState')}`,
    `**${t('common:tickets.panel.panelChannel')}:** ${config.panelChannelId ? `<#${config.panelChannelId}>` : t('common:tickets.panel.notSet')}`,
    `**${t('common:tickets.panel.staffRole')}:** ${config.staffRoleId ? `<@&${config.staffRoleId}>` : t('common:tickets.panel.notSet')}`,
    `**${t('common:tickets.panel.transcriptChannel')}:** ${config.transcriptChannelId ? `<#${config.transcriptChannelId}>` : t('common:tickets.panel.notSet')}`,
    `**${t('common:tickets.panel.maxOpenSetting')}:** ${config.maxOpenPerUser}`,
    `**${t('common:tickets.panel.cooldownSetting')}:** ${config.cooldownSeconds}s`,
    `**${t('common:tickets.panel.requireSubject')}:** ${config.requireSubject ? '✅' : '⬜'}`,
  ];

  return brandEmbed({
    t,
    dir,
    variant: config.enabled ? 'success' : 'info',
    color: config.enabled ? COLORS.success : COLORS.silverDim,
    title: `🎫 ${t('common:tickets.panel.title')}`,
    description: lines.join('\n'),
    fields: [
      {
        name: t('common:tickets.panel.category'),
        value: config.categories.map((c) => `${c.emoji ?? '🎫'} \`${c.id}\``).join('\n'),
        inline: false,
      },
    ],
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Support tickets: open one, or manage the system.')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('open')
        .setDescription('Open a new ticket.')
        .addStringOption((option) => option.setName('subject').setDescription('What you need help with.'))
        .addStringOption((option) => option.setName('category').setDescription('The kind of ticket.')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('close')
        .setDescription('Close this ticket.')
        .addStringOption((option) => option.setName('reason').setDescription('Why it is being closed.')),
    )
    .addSubcommand((sub) => sub.setName('claim').setDescription('Claim this ticket so nobody else answers it.'))
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add a member to this ticket.')
        .addUserOption((option) => option.setName('user').setDescription('The member to add.').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('priority')
        .setDescription('Set the priority of this ticket.')
        .addStringOption((option) =>
          option
            .setName('level')
            .setDescription('How urgent it is.')
            .setRequired(true)
            .addChoices(...PRIORITIES.map((p) => ({ name: p, value: p }))),
        ),
    )
    .addSubcommand((sub) => sub.setName('stats').setDescription('Show ticket statistics for this server.'))
    .addSubcommand((sub) => sub.setName('view').setDescription('Show the ticket configuration.'))
    .addSubcommand((sub) => sub.setName('enable').setDescription('Turn the ticket system on.'))
    .addSubcommand((sub) => sub.setName('disable').setDescription('Turn the ticket system off.'))
    .addSubcommand((sub) =>
      sub
        .setName('panel')
        .setDescription('Post the ticket panel in a channel.')
        .addChannelOption((option) =>
          option.setName('channel').setDescription('Where to post it. Defaults to this channel.').addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('staffrole')
        .setDescription('Set the role that can see and answer tickets.')
        .addRoleOption((option) => option.setName('role').setDescription('The staff role. Choose none to clear.')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('transcript')
        .setDescription('Set where closed ticket transcripts are posted.')
        .addChannelOption((option) =>
          option.setName('channel').setDescription('The transcript channel. Choose none to clear.').addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('cooldown')
        .setDescription('Set how long a member waits between opening tickets.')
        .addIntegerOption((option) =>
          option.setName('seconds').setDescription('Seconds. 0 disables the wait.').setRequired(true).setMinValue(0).setMaxValue(86400),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('maxopen')
        .setDescription('Set how many tickets one member may hold open.')
        .addIntegerOption((option) =>
          option.setName('count').setDescription('Number of tickets.').setRequired(true).setMinValue(1).setMaxValue(10),
        ),
    ),

  category: 'admin',
  cooldown: 5000,

  /**
   * Wire the panel buttons. Called once during client init.
   *
   * The custom id carries the category (`ticket:open:<category>`) so a single
   * handler serves every button on the panel.
   */
  async register(client) {
    client.registerComponent('ticket', async (interaction, ctx) => {
      const { t, dir } = ctx;
      // payload is everything after the namespace, e.g. "open:support".
      const [action, categoryId] = String(ctx.payload ?? '').split(':');

      if (action !== 'open' || !interaction.inGuild()) {
        await interaction.reply({
          embeds: [
            brandEmbed({
              t,
              dir,
              variant: 'error',
              title: `🎫 ${t('common:tickets.panel.title')}`,
              description: t('errors:generic'),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // Deferred: creating a channel can outlast Discord's acknowledgement
      // window, and a button that appears to hang looks broken.
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const result = await client.tickets.open({
        guild: interaction.guild,
        member: interaction.member,
        categoryId,
        locale: interaction.locale,
      });

      if (!result.ok) {
        const description =
          result.reason === 'cooldown'
            ? t('common:tickets.panel.cooldown', { seconds: String(result.seconds ?? 0) })
            : result.reason === 'max-open'
              ? t('common:tickets.panel.maxOpen')
              : result.reason === 'disabled'
                ? t('common:tickets.panel.disabled')
                : t('errors:generic');

        await interaction.editReply({
          embeds: [
            brandEmbed({
              t,
              dir,
              variant: 'error',
              title: `🎫 ${t('common:tickets.panel.title')}`,
              description,
            }),
          ],
        });
        return;
      }

      await interaction.editReply({
        embeds: [
          brandEmbed({
            t,
            dir,
            variant: 'success',
            title: `🎫 ${t('common:tickets.panel.title')} #${result.ticket.number}`,
            description: `<#${result.channel.id}>`,
          }),
        ],
      });
    });
  },

  async execute(interaction, { client, t, dir }) {
    requireGuild(interaction);

    const subcommand = interaction.options.getSubcommand();
    const tickets = client.tickets;
    const guild = interaction.guild;

    if (!tickets) {
      throw new ValidationError('The ticket module is not running', {
        i18nKey: 'errors:validation',
        details: { reason: 'tickets unavailable' },
      });
    }

    const CONFIG_SUBCOMMANDS = new Set(['view', 'enable', 'disable', 'panel', 'staffrole', 'transcript', 'cooldown', 'maxopen']);
    if (CONFIG_SUBCOMMANDS.has(subcommand)) requireManageGuild(interaction);

    const config = await tickets.getConfig(guild.id);
    const reply = (payload) => interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    const replyConfig = (next) => reply({ embeds: [configEmbed({ t, dir, config: next })] });

    switch (subcommand) {
      case 'open': {
        // Deferred: creating a channel and posting into it can take longer
        // than Discord's 3-second acknowledgement window.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const subject = interaction.options.getString('subject');
        const requested = interaction.options.getString('category');

        if (config.requireSubject && !subject) {
          await interaction.editReply({
            embeds: [
              brandEmbed({
                t,
                dir,
                variant: 'error',
                title: `🎫 ${t('common:tickets.panel.title')}`,
                description: t('common:tickets.panel.subject'),
              }),
            ],
          });
          return;
        }

        // Only offer categories the panel actually has; an invented id would
        // create a ticket nobody can route.
        if (requested && !config.categories.some((c) => c.id === requested)) {
          throw new ValidationError(`Unknown ticket category "${requested}"`, {
            i18nKey: 'errors:validation',
            details: { reason: requested },
          });
        }

        const result = await tickets.open({
          guild,
          member: interaction.member,
          categoryId: requested ?? config.categories[0]?.id,
          subject,
          locale: interaction.locale,
        });

        if (!result.ok) {
          const messageKey = {
            disabled: 'common:tickets.panel.disabled',
            'max-open': 'common:tickets.panel.maxOpen',
            'channel-failed': 'errors:discord',
            'record-failed': 'errors:database',
            database: 'errors:database',
            'no-categories': 'errors:validation',
          }[result.reason] ?? 'errors:generic';

          await interaction.editReply({
            embeds: [
              brandEmbed({
                t,
                dir,
                variant: 'error',
                title: `🎫 ${t('common:tickets.panel.title')}`,
                description:
                  result.reason === 'cooldown'
                    ? t('common:tickets.panel.cooldown', { seconds: String(result.seconds ?? 0) })
                    : t(messageKey),
              }),
            ],
          });
          return;
        }

        await interaction.editReply({
          embeds: [
            brandEmbed({
              t,
              dir,
              variant: 'success',
              title: `🎫 ${t('common:tickets.panel.title')} #${result.ticket.number}`,
              description: `<#${result.channel.id}>`,
            }),
          ],
        });
        return;
      }

      case 'close': {
        const result = await tickets.close({
          guild,
          channelId: interaction.channelId,
          closedBy: interaction.member,
          reason: interaction.options.getString('reason'),
          locale: interaction.locale,
        });
        if (!result.ok) {
          await reply({
            embeds: [
              brandEmbed({
                t,
                dir,
                variant: 'error',
                title: `🎫 ${t('common:tickets.panel.closedTitle')}`,
                description: t('common:tickets.panel.alreadyClosed'),
              }),
            ],
          });
          return;
        }
        await reply({
          embeds: [
            brandEmbed({
              t,
              dir,
              variant: 'success',
              title: `🎫 ${t('common:tickets.panel.closedTitle')}`,
              description: t('common:tickets.panel.closed'),
            }),
          ],
        });
        return;
      }

      case 'claim': {
        requireStaff(interaction, config, t);
        const result = await tickets.claim({
          guildId: guild.id,
          channelId: interaction.channelId,
          moderator: interaction.member,
        });
        const keyByReason = {
          closed: 'common:tickets.panel.alreadyClosed',
          'already-claimed': 'common:tickets.panel.alreadyClaimed',
          'already-yours': 'common:tickets.panel.yours',
        };
        await reply({
          embeds: [
            brandEmbed({
              t,
              dir,
              variant: result.ok ? 'success' : 'error',
              color: result.ok ? COLORS.success : COLORS.warning,
              title: `🎫 ${t('common:tickets.panel.title')}`,
              description: result.ok
                ? t('common:tickets.panel.claimed', { user: `<@${interaction.user.id}>` })
                : t(keyByReason[result.reason] ?? 'errors:generic'),
            }),
          ],
        });
        return;
      }

      case 'add': {
        requireStaff(interaction, config, t);
        const user = interaction.options.getUser('user');
        const target = await guild.members.fetch(user.id).catch(() => null);
        if (!target) {
          throw new ValidationError('That user is not in this server', {
            i18nKey: 'errors:validation',
            details: { reason: 'user is not a member' },
          });
        }
        const result = await tickets.addParticipant({
          guild,
          channelId: interaction.channelId,
          actor: interaction.member,
          target,
        });
        await reply({
          embeds: [
            brandEmbed({
              t,
              dir,
              variant: result.ok ? 'success' : 'error',
              title: `🎫 ${t('common:tickets.panel.title')}`,
              description: result.ok
                ? t('common:tickets.panel.added', { user: `<@${target.id}>` })
                : t('common:tickets.panel.alreadyClosed'),
            }),
          ],
        });
        return;
      }

      case 'priority': {
        requireStaff(interaction, config, t);
        const level = interaction.options.getString('level');
        const result = await tickets.setPriority({
          guildId: guild.id,
          channelId: interaction.channelId,
          priority: level,
        });
        await reply({
          embeds: [
            brandEmbed({
              t,
              dir,
              variant: result.ok ? 'success' : 'error',
              title: `🎫 ${t('common:tickets.panel.priority')}`,
              description: result.ok
                ? t('common:tickets.panel.prioritySet', { priority: level })
                : t('common:tickets.panel.alreadyClosed'),
            }),
          ],
        });
        return;
      }

      case 'stats': {
        const stats = await tickets.getStats(guild.id);
        const lines = [
          `**${t('common:tickets.panel.total')}:** ${stats.total}`,
          `**${t('common:tickets.panel.open')}:** ${stats.open}`,
          `**${t('common:tickets.panel.claimedCount')}:** ${stats.claimed}`,
          `**${t('common:tickets.panel.closedCount')}:** ${stats.closed}`,
          `**${t('common:tickets.panel.rating')}:** ${
            stats.averageRating === null ? t('common:tickets.panel.none') : `${stats.averageRating}/5 (${stats.rated})`
          }`,
        ];
        await reply({
          embeds: [
            brandEmbed({
              t,
              dir,
              variant: 'info',
              title: `📊 ${t('common:tickets.panel.stats')}`,
              description: lines.join('\n'),
            }),
          ],
        });
        return;
      }

      case 'view':
        await replyConfig(config);
        return;

      case 'enable':
      case 'disable': {
        const enabled = subcommand === 'enable';
        await replyConfig(await tickets.saveConfig(guild.id, { enabled }));
        return;
      }

      case 'panel': {
        const channel = interaction.options.getChannel('channel') ?? interaction.channel;
        await tickets.saveConfig(guild.id, { panelChannelId: channel.id });

        const buttons = config.categories.map((c) => ({
          type: 2, // Button
          style: 1, // Primary
          label: tickets.categoryLabel(c, t).slice(0, 80),
          emoji: c.emoji ? { name: c.emoji } : undefined,
          custom_id: `ticket:open:${c.id}`,
        }));

        await channel.send({
          embeds: [
            brandEmbed({
              t,
              dir,
              variant: 'info',
              title: `🎫 ${t('common:tickets.panel.title')}`,
              description: t('common:tickets.panel.hint'),
            }),
          ],
          components: buttons.length ? [{ type: 1, components: buttons.slice(0, 5) }] : [],
        });

        await reply({
          embeds: [
            brandEmbed({
              t,
              dir,
              variant: 'success',
              title: `🎫 ${t('common:tickets.panel.title')}`,
              description: t('common:tickets.panel.panelPosted'),
            }),
          ],
        });
        return;
      }

      case 'staffrole': {
        const role = interaction.options.getRole('role');
        await replyConfig(await tickets.saveConfig(guild.id, { staffRoleId: role?.id ?? null }));
        return;
      }

      case 'transcript': {
        const channel = interaction.options.getChannel('channel');
        await replyConfig(await tickets.saveConfig(guild.id, { transcriptChannelId: channel?.id ?? null }));
        return;
      }

      case 'cooldown':
        await replyConfig(await tickets.saveConfig(guild.id, { cooldownSeconds: interaction.options.getInteger('seconds') }));
        return;

      case 'maxopen':
        await replyConfig(await tickets.saveConfig(guild.id, { maxOpenPerUser: interaction.options.getInteger('count') }));
        return;

      default:
        throw new ValidationError(`Unknown subcommand "${subcommand}"`, {
          i18nKey: 'errors:validation',
          details: { reason: subcommand },
        });
    }
  },
};

export { configEmbed, isStaff, PRIORITIES, DEFAULT_TICKET_CONFIG };
