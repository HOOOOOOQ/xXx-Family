/**
 * src/bot/commands/admin/automod.js
 * ---------------------------------------------------------------------------
 * /automod — configuration for the message scanner.
 *
 *   /automod view                       show the current rules
 *   /automod enable | disable           switch screening on or off
 *   /automod rule <rule> <enabled> [action] [threshold] [word]
 *   /automod whitelist <role> [remove]  exempt a role from screening
 *   /automod test <text>                preview what a message would trigger
 *
 * `/automod test` exists because the cost of a mis-tuned rule is silent: the
 * rule deletes legitimate messages and nobody knows until someone complains.
 * Letting an admin run a sample message through the real scanner first turns
 * that into something they can see.
 */

import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

import { COLORS } from '../../../config/constants.js';
import { brandEmbed } from '../../../utils/embeds.js';
import { PermissionDeniedError, ValidationError } from '../../../utils/errors.js';
import { AUTOMOD_RULES, AUTOMOD_ACTIONS, DEFAULT_AUTOMOD_CONFIG } from '../../../services/automodService.js';

function requireGuild(interaction) {
  if (!interaction.inGuild()) {
    throw new PermissionDeniedError('Automod configuration requires a server', { i18nKey: 'errors:guildOnly' });
  }
}

function requireManageGuild(interaction) {
  requireGuild(interaction);
  if (!interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new PermissionDeniedError('ManageGuild is required to configure automod', {
      i18nKey: 'errors:missingPermissions',
      details: { permissions: 'ManageGuild' },
    });
  }
}

/** Short human label for a rule, kept out of the locale files because the
 *  rule names are identifiers an admin types verbatim. */
const RULE_LABELS = Object.freeze({
  spam: 'Repeated messages',
  mentions: 'Mention spam',
  links: 'Links',
  invites: 'Discord invites',
  caps: 'Excessive capitals',
  words: 'Banned words',
  repeats: 'Duplicate messages',
});

function ruleLabel(rule) {
  return RULE_LABELS[rule] ?? rule;
}

/** Render the configuration panel. */
function configEmbed({ t, dir, config }) {
  const lines = AUTOMOD_RULES.map((rule) => {
    const entry = config.rules[rule];
    const state = entry.enabled ? '✅' : '⬜';
    const parts = [`${state} \`${rule}\` — ${ruleLabel(rule)}`];
    if (entry.enabled) {
      const details = [];
      if (entry.threshold !== undefined) details.push(`${t('common:moderation.panel.threshold')}: ${entry.threshold}`);
      if (entry.minLength !== undefined) details.push(`min length: ${entry.minLength}`);
      if (entry.windowMs !== undefined) details.push(`window: ${Math.round(entry.windowMs / 1000)}s`);
      if (Array.isArray(entry.list)) details.push(`words: ${entry.list.length}`);
      details.push(`${t('common:moderation.panel.action')}: ${entry.action}`);
      parts.push(`   ${details.join(' · ')}`);
    }
    return parts.join('\n');
  });

  const whitelist = config.whitelistRoleIds.length
    ? config.whitelistRoleIds.map((id) => `<@&${id}>`).join(' ')
    : t('common:moderation.panel.noWhitelist');

  return brandEmbed({
    t,
    dir,
    variant: config.enabled ? 'success' : 'info',
    color: config.enabled ? COLORS.success : COLORS.silverDim,
    title: `🤖 ${t('common:moderation.panel.automod')}`,
    description: `${t('common:moderation.panel.automodStatus')}: **${
      config.enabled ? t('common:moderation.panel.enabled') : t('common:moderation.panel.disabled')
    }**\n\n${lines.join('\n')}`,
    fields: [{ name: t('common:moderation.panel.whitelist'), value: whitelist, inline: false }],
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('automod')
    .setDescription('Configure automatic message screening.')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub.setName('view').setDescription('Show the current automod rules.'))
    .addSubcommand((sub) => sub.setName('enable').setDescription('Turn automatic screening on.'))
    .addSubcommand((sub) => sub.setName('disable').setDescription('Turn automatic screening off.'))
    .addSubcommand((sub) =>
      sub
        .setName('rule')
        .setDescription('Configure one automod rule.')
        .addStringOption((option) =>
          option
            .setName('rule')
            .setDescription('Which rule to configure.')
            .setRequired(true)
            .addChoices(...AUTOMOD_RULES.map((rule) => ({ name: `${rule} — ${ruleLabel(rule)}`, value: rule }))),
        )
        .addBooleanOption((option) => option.setName('enabled').setDescription('Turn this rule on or off.').setRequired(true))
        .addStringOption((option) =>
          option
            .setName('action')
            .setDescription('What to do when the rule fires.')
            .addChoices(...AUTOMOD_ACTIONS.map((action) => ({ name: action, value: action }))),
        )
        .addIntegerOption((option) =>
          option.setName('threshold').setDescription('How many hits before it fires (spam, mentions, caps, repeats).').setMinValue(1),
        )
        .addStringOption((option) =>
          option.setName('word').setDescription('For the words rule: add this word. Prefix with - to remove it.'),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('whitelist')
        .setDescription('Exempt a role from screening.')
        .addRoleOption((option) => option.setName('role').setDescription('The role to exempt.').setRequired(true))
        .addBooleanOption((option) => option.setName('remove').setDescription('Remove the exemption instead of adding it.')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('test')
        .setDescription('Check what a sample message would trigger. Nothing is deleted.')
        .addStringOption((option) => option.setName('text').setDescription('The message to test.').setRequired(true)),
    ),

  category: 'admin',
  cooldown: 3000,

  async execute(interaction, { client, t, dir }) {
    requireGuild(interaction);
    const subcommand = interaction.options.getSubcommand();
    const automod = client.automod;

    if (!automod) {
      throw new ValidationError('The automod module is not running', {
        i18nKey: 'errors:validation',
        details: { reason: 'automod unavailable' },
      });
    }

    // `test` is read-only: it runs the scanner and deletes nothing, so it does
    // not need ManageGuild.
    if (subcommand !== 'test') requireManageGuild(interaction);

    const config = await automod.getConfig(interaction.guildId);

    switch (subcommand) {
      case 'view': {
        await interaction.reply({ embeds: [configEmbed({ t, dir, config })], flags: MessageFlags.Ephemeral });
        return;
      }

      case 'enable':
      case 'disable': {
        const enabled = subcommand === 'enable';
        // Persist the whole block, not just the flag: setAutomodConfig replaces
        // the automod document, so sending { enabled } alone would discard every
        // rule and whitelist entry an admin had configured. Toggling the module
        // off and back on must not reset their tuning.
        await client.settings.setAutomodConfig(interaction.guildId, {
          enabled,
          rules: config.rules,
          whitelistRoleIds: config.whitelistRoleIds,
        });
        const next = { ...config, enabled };
        await interaction.reply({
          embeds: [
            brandEmbed({
              t,
              dir,
              variant: enabled ? 'success' : 'info',
              color: enabled ? COLORS.success : COLORS.silverDim,
              title: `🤖 ${t('common:moderation.panel.automod')}`,
              description: `${t('common:moderation.panel.automodStatus')}: **${
                enabled ? t('common:moderation.panel.enabled') : t('common:moderation.panel.disabled')
              }**`,
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      case 'rule': {
        const rule = interaction.options.getString('rule');
        const enabled = interaction.options.getBoolean('enabled');
        const action = interaction.options.getString('action');
        const threshold = interaction.options.getInteger('threshold');
        const word = interaction.options.getString('word');

        if (!AUTOMOD_RULES.includes(rule)) {
          throw new ValidationError(`Unknown automod rule "${rule}"`, {
            i18nKey: 'errors:validation',
            details: { reason: rule },
          });
        }

        // Build the rule from what exists, changing only what was supplied, so
        // an admin toggling one rule cannot wipe another rule's word list.
        const next = { ...config.rules[rule], enabled };
        if (action) {
          if (!AUTOMOD_ACTIONS.includes(action)) {
            throw new ValidationError(`Unknown automod action "${action}"`, {
              i18nKey: 'errors:validation',
              details: { reason: action },
            });
          }
          next.action = action;
        }
        if (threshold !== null && threshold !== undefined) next.threshold = threshold;

        if (word !== null && word !== undefined) {
          if (rule !== 'words') {
            throw new ValidationError('The word option only applies to the words rule', {
              i18nKey: 'errors:validation',
              details: { reason: 'word option is for the words rule only' },
            });
          }
          const list = new Set(next.list ?? []);
          if (word.startsWith('-')) {
            list.delete(word.slice(1).trim().toLowerCase());
          } else {
            const value = word.trim().toLowerCase();
            if (!value) {
              throw new ValidationError('Provide a word to add or remove', {
                i18nKey: 'errors:validation',
                details: { reason: 'empty word' },
              });
            }
            list.add(value);
          }
          next.list = [...list];
        }

        await client.settings.setAutomodConfig(interaction.guildId, {
          enabled: config.enabled,
          whitelistRoleIds: config.whitelistRoleIds,
          rules: { ...config.rules, [rule]: next },
        });

        const merged = automod.effectiveConfig({
          enabled: config.enabled,
          whitelistRoleIds: config.whitelistRoleIds,
          rules: { ...config.rules, [rule]: next },
        });
        await interaction.reply({ embeds: [configEmbed({ t, dir, config: merged })], flags: MessageFlags.Ephemeral });
        return;
      }

      case 'whitelist': {
        const role = interaction.options.getRole('role');
        const remove = interaction.options.getBoolean('remove') ?? false;
        if (!role) {
          throw new ValidationError('Choose a role to exempt', {
            i18nKey: 'errors:validation',
            details: { reason: 'no role given' },
          });
        }

        const current = new Set(config.whitelistRoleIds);
        if (remove) current.delete(role.id);
        else current.add(role.id);

        await client.settings.setAutomodConfig(interaction.guildId, {
          enabled: config.enabled,
          whitelistRoleIds: [...current],
          rules: config.rules,
        });

        const merged = automod.effectiveConfig({
          enabled: config.enabled,
          whitelistRoleIds: [...current],
          rules: config.rules,
        });
        await interaction.reply({ embeds: [configEmbed({ t, dir, config: merged })], flags: MessageFlags.Ephemeral });
        return;
      }

      case 'test': {
        const text = interaction.options.getString('text');
        // The scanner reads mentions from the message object, not from the
        // text, so a preview models the counts a real message would carry.
        const sample = {
          content: text,
          guild: { id: interaction.guildId },
          author: { id: interaction.user.id, bot: false },
          mentions: { users: { size: (text.match(/<@\d+>/g) ?? []).length }, roles: { size: (text.match(/<@&\d+>/g) ?? []).length } },
        };

        // track:false — a preview must not count toward the user's real spam or
        // repeat windows, or testing a rule could get the admin flagged by it.
        const verdict = automod.scan(sample, config, { track: false });

        const summary = verdict.matched.length
          ? verdict.matched.map((rule) => `⚠️ \`${rule}\` — ${ruleLabel(rule)}`).join('\n')
          : '✅ Nothing matched.';

        await interaction.reply({
          embeds: [
            brandEmbed({
              t,
              dir,
              variant: verdict.matched.length ? 'warning' : 'success',
              color: verdict.matched.length ? COLORS.warning : COLORS.success,
              title: `🔎 ${t('common:moderation.panel.automod')} — test`,
              description: `${summary}\n\n**${t('common:moderation.panel.action')}:** ${verdict.action ?? '—'}`,
            }),
          ],
          flags: MessageFlags.Ephemeral,
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

export { configEmbed, ruleLabel, RULE_LABELS, DEFAULT_AUTOMOD_CONFIG };
