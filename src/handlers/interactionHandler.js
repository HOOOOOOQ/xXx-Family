/**
 * src/handlers/interactionHandler.js
 * ---------------------------------------------------------------------------
 * Routes every Discord interaction to the right code path:
 *   chat input  → command module (+ guards + locale + metrics)
 *   autocomplete→ command.autocomplete()
 *   button/select/modal → component router (`<module>:<action>:<payload>`)
 *
 * This is the only place that knows how an interaction becomes a reply, which
 * is what makes "every reply is localized, every error is logged" enforceable
 * rather than aspirational.
 */

import { getLogger } from '../utils/logger.js';
import { NotFoundError } from '../utils/errors.js';
import { enforceCommandGuards } from '../middleware/cooldownManager.js';
import { handleInteractionError } from '../middleware/interactionErrorHandler.js';

export class InteractionHandler {
  /**
   * @param {object} deps
   * @param {import('../bot/client.js').XxxFamilyClient} deps.client
   */
  constructor(deps) {
    this.client = deps.client;
    this.logger = getLogger().child('interactions');
  }

  /**
   * @param {import('discord.js').Interaction} interaction
   */
  async handle(interaction) {
    try {
      if (interaction.isChatInputCommand()) return await this.handleCommand(interaction);
      if (interaction.isAutocomplete()) return await this.handleAutocomplete(interaction);
      if (interaction.isButton() || interaction.isAnySelectMenu()) return await this.handleComponent(interaction);
      if (interaction.isModalSubmit()) return await this.handleModal(interaction);
      if (interaction.isContextMenuCommand()) return await this.handleContextMenu(interaction);
      this.logger.debug('Unhandled interaction type', { type: interaction.type });
      return undefined;
    } catch (err) {
      const locale = interaction.__locale ?? null;
      const t = interaction.__t ?? null;
      await handleInteractionError(interaction, err, {
        command: interaction.commandName ?? interaction.customId,
        locale,
        t,
      });
      return undefined;
    }
  }

  /** @param {import('discord.js').ChatInputCommandInteraction} interaction */
  async handleCommand(interaction) {
    const command = this.client.commands.get(interaction.commandName);
    if (!command) {
      throw new NotFoundError(`Unknown command "${interaction.commandName}"`, { i18nKey: 'errors:commandNotFound' });
    }

    const started = process.hrtime.bigint();
    const localeContext = await this.client.localeService.resolveForInteraction(interaction, {
      moduleName: command.category,
      roleIds: interaction.inGuild() ? [...(interaction.member?.roles?.cache?.keys?.() ?? [])] : [],
    });

    // Exposed for the error handler so a failure is reported in the right language.
    interaction.__locale = localeContext.locale;
    interaction.__t = localeContext.t;

    enforceCommandGuards(interaction, command, {
      cooldowns: this.client.cooldowns,
      ownerIds: this.client.config.discord.owners,
    });

    const settings = await this.client.settings.getGuildSettings(interaction.guildId ?? null).catch(() => null);
    if (interaction.guildId && settings && !this.client.settings.isModuleEnabled(settings, command.category)) {
      this.logger.warn('Command blocked: module disabled for guild', {
        command: command.name,
        category: command.category,
        guildId: interaction.guildId,
      });
      throw new NotFoundError(`Module "${command.category}" is disabled on this server`, {
        i18nKey: 'errors:maintenance',
      });
    }

    const ctx = {
      client: this.client,
      command,
      t: localeContext.t,
      locale: localeContext.locale,
      localeContext,
      dir: localeContext.dir,
      settings,
      startedAt: started,
      logger: this.logger.child(command.name),
    };

    await command.execute(interaction, ctx);

    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    this.client.metrics.recordCommand(command.name, durationMs);
    this.logger.debug('Command executed', {
      command: command.name,
      guildId: interaction.guildId ?? 'dm',
      userId: interaction.user.id,
      locale: localeContext.locale,
      durationMs: Math.round(durationMs * 100) / 100,
    });
  }

  /** @param {import('discord.js').AutocompleteInteraction} interaction */
  async handleAutocomplete(interaction) {
    const command = this.client.commands.get(interaction.commandName);
    if (!command?.autocomplete) return;
    const localeContext = await this.client.localeService.resolveForInteraction(interaction);
    interaction.__locale = localeContext.locale;
    interaction.__t = localeContext.t;
    await command.autocomplete(interaction, {
      client: this.client,
      t: localeContext.t,
      locale: localeContext.locale,
      logger: this.logger.child(command.name),
    });
  }

  /**
   * Component routing. Custom ids use `<module>:<action>[:payload]`; a module
   * registers its namespace once at boot with `client.registerComponent()`.
   * @param {import('discord.js').ButtonInteraction|import('discord.js').AnySelectMenuInteraction} interaction
   */
  async handleComponent(interaction) {
    const [namespace, action, ...rest] = String(interaction.customId ?? '').split(':');
    const handler = this.client.components.get(namespace);
    if (!handler) {
      this.logger.warn('No component handler registered for namespace', {
        namespace,
        customId: interaction.customId,
      });
      throw new NotFoundError(`No handler for component namespace "${namespace}"`, {
        i18nKey: 'errors:unknownInteraction',
      });
    }
    const localeContext = await this.client.localeService.resolveForInteraction(interaction, {
      moduleName: namespace,
    });
    interaction.__locale = localeContext.locale;
    interaction.__t = localeContext.t;
    await handler(interaction, {
      client: this.client,
      action: action ?? null,
      payload: rest.join(':'),
      t: localeContext.t,
      locale: localeContext.locale,
      dir: localeContext.dir,
      logger: this.logger.child(namespace),
    });
  }

  /** @param {import('discord.js').ModalSubmitInteraction} interaction */
  async handleModal(interaction) {
    const [namespace, action, ...rest] = String(interaction.customId ?? '').split(':');
    const handler = this.client.modals.get(namespace);
    if (!handler) {
      throw new NotFoundError(`No handler for modal namespace "${namespace}"`, {
        i18nKey: 'errors:unknownInteraction',
      });
    }
    const localeContext = await this.client.localeService.resolveForInteraction(interaction, {
      moduleName: namespace,
    });
    interaction.__locale = localeContext.locale;
    interaction.__t = localeContext.t;
    await handler(interaction, {
      client: this.client,
      action: action ?? null,
      payload: rest.join(':'),
      t: localeContext.t,
      locale: localeContext.locale,
      dir: localeContext.dir,
      logger: this.logger.child(namespace),
    });
  }

  /** @param {import('discord.js').ContextMenuCommandInteraction} interaction */
  async handleContextMenu(interaction) {
    const command = this.client.commands.get(interaction.commandName);
    if (!command?.execute) {
      throw new NotFoundError(`Unknown context menu command "${interaction.commandName}"`, {
        i18nKey: 'errors:commandNotFound',
      });
    }
    await this.handleCommand(interaction);
  }
}

export default InteractionHandler;
