#!/usr/bin/env node
/**
 * scripts/deploy-commands.js
 * ---------------------------------------------------------------------------
 * Register slash commands with Discord, including every localization.
 *
 *   node scripts/deploy-commands.js              # global (up to 1h to appear)
 *   DEPLOY_GUILD_ID=123 node scripts/deploy-commands.js   # instant, one guild
 *
 * Locale handling: each command's localized names/descriptions are produced by
 * `localizeCommandPayload()` from the `commands` translation namespace. Locales
 * Discord does not accept (Arabic) are skipped, and any option without a
 * translation is left to Discord's default — so this script never fails because
 * of i18n.
 */

import { REST, Routes } from 'discord.js';

import { initConfig } from '../src/config/index.js';
import { Logger, setLogger, getLogger } from '../src/utils/logger.js';
import { initI18n, isDiscordCommandName } from '../src/services/i18nService.js';
import { loadCommands, localizeCommandPayload } from '../src/handlers/commandLoader.js';
import { join } from 'node:path';

async function main() {
  const config = initConfig();
  const dryRun = process.argv.includes('--dry-run');
  // In dry-run mode stdout carries only the JSON payload, so every log line is
  // written to stderr. That makes `--dry-run > payload.json` safe to pipe.
  setLogger(
    new Logger({
      name: 'deploy-commands',
      level: config.logging.level,
      format: config.logging.format,
      ...(dryRun ? { sink: (line) => process.stderr.write(`${line}\n`) } : {}),
    }),
  );
  const logger = getLogger();

  if (!config.discord.token || !config.discord.clientId) {
    logger.fatal('DISCORD_TOKEN and DISCORD_CLIENT_ID are required to deploy commands');
    process.exit(1);
  }

  await initI18n({
    locales: [...config.i18n.enabledLocales],
    defaultLocale: config.i18n.defaultLocale,
    localesDir: config.paths.locales,
  });

  const { commands, errors } = await loadCommands(join(config.paths.src, 'bot', 'commands'), { strict: true });
  if (errors.length) {
    logger.fatal('Some commands failed validation — nothing was deployed', { errors });
    process.exit(1);
  }

  const payloads = [...commands.values()].map((command) => localizeCommandPayload(command));
  const rest = new REST({ version: '10' }).setToken(config.discord.token);

  const guildId = process.env.DEPLOY_GUILD_ID || config.discord.deployGuildId;
  const route = guildId
    ? Routes.applicationGuildCommands(config.discord.clientId, guildId)
    : Routes.applicationCommands(config.discord.clientId);

  // --dry-run validates and prints the exact payload without calling Discord,
  // so the localization wiring can be checked offline (CI, Termux pre-flight).
  if (dryRun) {
    const problems = [];
    const walk = (node, label) => {
      // The default name must be lowercase ASCII; localized names may use any
      // Unicode letter (げんご, 언어, Bahasa…). Both use Discord's own pattern.
      if (!isDiscordCommandName(node.name, { requireLowercaseAscii: label === 'root' })) {
        problems.push(`${label}: invalid command name "${node.name}"`);
      }
      if (!node.description || node.description.length > 100) {
        problems.push(`${label}: invalid description (${node.description?.length ?? 0} chars)`);
      }
      for (const [locale, name] of Object.entries(node.name_localizations ?? {})) {
        if (!isDiscordCommandName(name)) problems.push(`${label}[${locale}]: invalid localized name "${name}"`);
      }
      for (const option of node.options ?? []) walk(option, `${label}>${option.name}`);
      for (const choice of node.choices ?? []) {
        for (const [locale, name] of Object.entries(choice.name_localizations ?? {})) {
          if (!isDiscordCommandName(name)) problems.push(`${label}>choice[${locale}]: invalid "${name}"`);
        }
      }
    };
    for (const payload of payloads) walk(payload, payload.name);
    process.stdout.write(`${JSON.stringify({ count: payloads.length, problems, payload: payloads }, null, 2)}\n`);
    if (problems.length) {
      logger.fatal('Dry run found invalid payload entries', { problems });
      process.exit(1);
    }
    logger.info('Dry run passed — payload is valid', { count: payloads.length });
    process.exit(0);
  }

  logger.info(`Deploying ${payloads.length} command(s)`, {
    scope: guildId ? `guild ${guildId}` : 'global',
    commands: payloads.map((p) => p.name),
  });

  try {
    const started = Date.now();
    const response = await rest.put(route, { body: payloads });
    const deployed = Array.isArray(response) ? response : [];
    logger.info('Deployment complete', {
      count: deployed.length,
      durationMs: Date.now() - started,
      scope: guildId ? `guild ${guildId}` : 'global',
      localized: deployed.map((command) => ({
        name: command.name,
        locales: Object.keys(command.name_localizations ?? {}).length,
      })),
    });
    process.exit(0);
  } catch (err) {
    logger.errorFrom(err, 'Deployment failed', {
      status: err.status,
      code: err.code,
      errors: err.rawError?.errors ?? undefined,
    });
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`[deploy-commands] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
