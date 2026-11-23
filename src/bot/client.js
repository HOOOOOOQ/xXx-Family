/**
 * src/bot/client.js
 * ---------------------------------------------------------------------------
 * The xXx Family client.
 *
 * Owns the boot sequence and the registries every other part of the ecosystem
 * talks to: commands, components, modules, cooldowns, metrics, health checks,
 * settings and locale resolution.
 *
 * Boot order matters and is explicit:
 *   config → logger → i18n → database → commands/events/modules → login → API
 *
 * Sharding-ready: nothing here assumes a single process. Guild-scoped work is
 * always keyed by `guildId`, and `client.shard` is used when present.
 */

import { Collection, Client, GatewayIntentBits, Options, Partials } from 'discord.js';
import { join } from 'node:path';

import { getConfig } from '../config/index.js';
import { DEFAULT_PRESENCE } from '../config/constants.js';
import { getLogger } from '../utils/logger.js';
import { ConfigError } from '../utils/errors.js';

import {
  connectDatabase,
  disconnectDatabase,
  getDatabaseHealth,
  isDatabaseConfigured,
  pingDatabase,
} from '../database/connection.js';
import { models } from '../database/models/index.js';

import { initI18n, shutdownI18n } from '../services/i18nService.js';
import { settingsService } from '../services/settingsService.js';
import { LocaleService, localeService } from '../services/localeService.js';
import { LoggingService } from '../services/loggingService.js';
import { WelcomeService } from '../services/welcomeService.js';
import { healthService } from '../services/healthService.js';
import { metrics } from '../services/metrics.js';
import { settingsCache } from '../services/cacheManager.js';

import { loadCommands, localizeCommandPayload } from '../handlers/commandLoader.js';
import { loadEvents, registerEvents } from '../handlers/eventLoader.js';
import { ModuleManager } from '../handlers/moduleLoader.js';
import { InteractionHandler } from '../handlers/interactionHandler.js';
import { CooldownManager } from '../middleware/cooldownManager.js';

/** Intents the Phase 1+ feature set needs. Privileged ones must be enabled in the Developer Portal. */
export const REQUIRED_INTENTS =
  GatewayIntentBits.Guilds |
  GatewayIntentBits.GuildMembers |
  GatewayIntentBits.GuildMessages |
  GatewayIntentBits.MessageContent |
  GatewayIntentBits.GuildVoiceStates |
  GatewayIntentBits.GuildInvites |
  GatewayIntentBits.GuildScheduledEvents |
  GatewayIntentBits.GuildMessageReactions;

export class XxxFamilyClient extends Client {
  /**
   * @param {object} [config] validated config (defaults to getConfig())
   * @param {object} [overrides] extra Client options
   * @param {object} [deps] injectable services (tests / API-only mode)
   * @param {import('../services/settingsService.js').SettingsService} [deps.settings]
   */
  constructor(config = getConfig(), overrides = {}, deps = {}) {
    super({
      intents: REQUIRED_INTENTS,
      partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User, Partials.Reaction],
      allowedMentions: { parse: ['users', 'roles'], repliedUser: false },
      makeCache: Options.cacheWithLimits({
        ...Options.DefaultMakeCacheSettings,
        MessageManager: 100,
        PresenceManager: 0,
      }),
      ...overrides,
    });

    this.config = config;
    this.logger = getLogger().child('client');

    /** @type {Collection<string, import('../handlers/commandLoader.js').CommandModule>} */
    this.commands = new Collection();
    /** @type {Map<string, Function>} component handlers, keyed by customId namespace */
    this.components = new Map();
    /** @type {Map<string, Function>} modal handlers, keyed by customId namespace */
    this.modals = new Map();

    this.cooldowns = new CooldownManager();
    this.modules = new ModuleManager({ logger: this.logger });
    this.health = healthService;
    this.metrics = metrics;
    // One settings service per client, shared with the locale resolver so there
    // is a single source of truth (and a single seam to inject in tests).
    this.settings = deps.settings ?? settingsService;
    this.localeService = new LocaleService({ settings: this.settings, config, logger: this.logger });

    // Logging + welcome are constructed here (not used as the module-level
    // singletons) so they share THIS client's settings service, models and
    // channel resolver. Channel resolution goes through the client cache first
    // and only fetches on a miss.
    const resolveChannel = async (channelId) => {
      if (!channelId) return null;
      return this.channels.cache.get(channelId) ?? (await this.channels.fetch(channelId).catch(() => null));
    };

    this.logging =
      deps.logging ??
      new LoggingService({
        settings: this.settings,
        localeService: this.localeService,
        resolveChannel,
        isDbReady: () => isDatabaseConfigured(),
        logger: this.logger,
        metrics: this.metrics,
      });

    this.welcome =
      deps.welcome ??
      new WelcomeService({
        models,
        settings: this.settings,
        logging: this.logging,
        localeService: this.localeService,
        resolveChannel,
        isDbReady: () => isDatabaseConfigured(),
        logger: this.logger,
        metrics: this.metrics,
      });

    this.interactionHandler = new InteractionHandler({ client: this });
    this.cacheStore = settingsCache;

    this.bootedAt = null;
    // NOTE: discord.js defines `readyAt`/`readyTimestamp` as getter-only
    // properties on Client, so the gateway timestamp is tracked under our own
    // name. Assigning `this.readyAt` throws a TypeError at construction.
    this.gatewayReadyAt = null;
    this.loadErrors = [];
    this.shutdownReason = null;
  }

  /**
   * Register a component (button / select menu) namespace.
   * @param {string} namespace first segment of the custom id
   * @param {Function} handler
   */
  registerComponent(namespace, handler) {
    if (typeof handler !== 'function') throw new TypeError('component handler must be a function');
    this.components.set(namespace, handler);
    return this;
  }

  /**
   * Register a modal submit namespace.
   * @param {string} namespace
   * @param {Function} handler
   */
  registerModal(namespace, handler) {
    if (typeof handler !== 'function') throw new TypeError('modal handler must be a function');
    this.modals.set(namespace, handler);
    return this;
  }

  /**
   * Everything that must happen before `login()`.
   * @param {object} [options]
   * @param {boolean} [options.loadCommands]
   * @param {boolean} [options.loadEvents]
   * @param {boolean} [options.loadModules]
   * @param {boolean} [options.connectDatabase]
   */
  async initialize(options = {}) {
    const {
      loadCommands: shouldLoadCommands = true,
      loadEvents: shouldLoadEvents = true,
      loadModules: shouldLoadModules = true,
      connectDatabase: shouldConnectDatabase = true,
    } = options;

    this.logger.info('Initialising xXx Family', {
      version: this.config.isProduction ? 'production' : this.config.env,
      locales: this.config.i18n.enabledLocales,
    });

    // 1. Translations — every later step produces user visible strings.
    await initI18n({
      locales: [...this.config.i18n.enabledLocales],
      defaultLocale: this.config.i18n.defaultLocale,
      localesDir: this.config.paths.locales,
    });

    // 2. Database (optional but recommended).
    if (shouldConnectDatabase) {
      try {
        const result = await connectDatabase({ uri: this.config.database.uri, options: this.config.database.options });
        if (result.skipped) this.logger.warn('Running without MongoDB — settings will not persist');
      } catch (err) {
        // Not fatal: the bot can serve commands that do not need storage.
        this.logger.errorFrom(err, 'MongoDB connection failed — continuing in degraded mode');
        this.loadErrors.push({ stage: 'database', message: err.message });
      }
    }

    // 3. Commands.
    if (shouldLoadCommands) {
      const { commands, errors } = await loadCommands(join(this.config.paths.src, 'bot', 'commands'), {
        strict: this.config.isProduction,
      });
      this.commands = commands;
      this.loadErrors.push(...errors.map((e) => ({ stage: 'commands', ...e })));

      // Commands may wire their own component namespaces (help select, language
      // picker…). Failures are reported, never fatal.
      for (const command of this.commands.values()) {
        if (typeof command.register !== 'function') continue;
        try {
          await command.register(this);
        } catch (err) {
          this.logger.errorFrom(err, 'Command register() failed', { command: command.name });
          this.loadErrors.push({ stage: 'commands', file: command.__file, message: err.message });
        }
      }
    }

    // 4. Events.
    if (shouldLoadEvents) {
      const { events, errors } = await loadEvents(join(this.config.paths.src, 'bot', 'events'), {
        strict: this.config.isProduction,
      });
      this.events = events;
      this.loadErrors.push(...errors.map((e) => ({ stage: 'events', ...e })));
      registerEvents(this, events);
    }

    // 5. Feature modules (plugin manager).
    if (shouldLoadModules) {
      await this.modules.discover(join(this.config.paths.src, 'bot', 'modules'));
      const result = await this.modules.boot({
        client: this,
        config: this.config,
        settings: this.settings,
        localeService: this.localeService,
        logging: this.logging,
        welcome: this.welcome,
        health: this.health,
        metrics: this.metrics,
      });
      if (result.failed.length) this.loadErrors.push(...result.failed.map((f) => ({ stage: 'modules', ...f })));
    }

    // 6. Health probes.
    this.registerHealthChecks();

    this.bootedAt = new Date();
    this.logger.info('Initialisation complete', {
      commands: this.commands.size,
      components: this.components.size,
      modules: this.modules.size,
      loadErrors: this.loadErrors.length,
    });
    return this;
  }

  /** Wire the default health probes. */
  registerHealthChecks() {
    this.health.register('process', () => ({
      status: 'ok',
      pid: process.pid,
      nodeVersion: process.version,
      memoryMb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
      uptimeMs: Math.round(process.uptime() * 1000),
    }));

    this.health.register(
      'database',
      async () => {
        const health = getDatabaseHealth();
        if (!health.enabled) return { status: 'degraded', ...health };
        const ping = await pingDatabase();
        return { status: ping.ok ? 'ok' : 'error', ...health, ping };
      },
      { critical: false },
    );

    this.health.register('discord', () => ({
      status: this.isReady() ? 'ok' : 'degraded',
      ready: this.isReady(),
      pingMs: this.ws?.ping ?? null,
      guilds: this.guilds?.cache?.size ?? 0,
      shardId: this.shard?.ids?.[0] ?? 0,
    }));

    this.health.register('runtime', () => ({
      status: this.loadErrors.length ? 'degraded' : 'ok',
      commands: this.commands.size,
      components: this.components.size,
      modules: this.modules.status(),
      loadErrors: this.loadErrors,
      cache: this.cacheStore.stats(),
    }));
  }

  /**
   * Log in to Discord and start serving.
   * @param {object} [options]
   * @param {boolean} [options.initialize] run initialize() first (default true)
   */
  async start(options = {}) {
    if (!this.config.discord.token) {
      throw new ConfigError('DISCORD_TOKEN is not set — cannot log in to Discord.');
    }
    if (options.initialize !== false && !this.bootedAt) await this.initialize();

    this.on('ready', () => {
      this.gatewayReadyAt = new Date();
      try {
        this.user?.setPresence(DEFAULT_PRESENCE);
      } catch (err) {
        this.logger.warn('Could not set presence', { reason: err.message });
      }
    });

    await this.login(this.config.discord.token);
    return this;
  }

  /**
   * Graceful shutdown: modules → gateway → database → caches.
   * @param {string} [reason]
   */
  async stop(reason = 'shutdown') {
    if (this.shutdownReason) return { reason: this.shutdownReason, alreadyStopping: true };
    this.shutdownReason = reason;
    this.logger.info('Shutting down', { reason });

    await this.modules.shutdown().catch((err) => this.logger.errorFrom(err, 'Module shutdown failed'));

    try {
      if (this.isReady() || this.ws?.status !== undefined) await this.destroy();
    } catch (err) {
      this.logger.warn('Discord destroy failed', { reason: err.message });
    }

    await disconnectDatabase().catch((err) => this.logger.errorFrom(err, 'Database disconnect failed'));
    this.cacheStore.stopSweeper();
    await shutdownI18n().catch(() => {});

    this.logger.info('Shutdown complete');
    return { reason, clean: true };
  }

  /**
   * Serialized command payloads with every localization attached — used by
   * `scripts/deploy-commands.js`.
   * @returns {object[]}
   */
  buildCommandPayloads() {
    return [...this.commands.values()].map((command) => localizeCommandPayload(command));
  }
}

export default XxxFamilyClient;
