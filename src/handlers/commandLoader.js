/**
 * src/handlers/commandLoader.js
 * ---------------------------------------------------------------------------
 * Dynamic slash-command loader.
 *
 * Every file under `src/bot/commands/<category>/*.js` default-exports a command
 * module:
 *
 *   export default {
 *     data: new SlashCommandBuilder()…,   // structure only (no localized names)
 *     category: 'utility',
 *     cooldown: 3000,
 *     guildOnly: true,
 *     ownerOnly: false,
 *     userPermissions: ['ManageGuild'],
 *     botPermissions: ['SendMessages'],
 *     async execute(interaction, ctx) { … }
 *   };
 *
 * The loader validates that contract at boot (a broken command fails the boot
 * loudly instead of throwing at 3am inside an interaction) and attaches the
 * localized names/descriptions at registration time from the `commands`
 * translation namespace.
 */

import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { Collection } from 'discord.js';

import { ValidationError } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';
import { commandLocalizations, optionLocalizations } from '../services/i18nService.js';
import { DEFAULT_COOLDOWNS } from '../config/constants.js';

const COMMAND_NAME_RE = /^[a-z0-9][a-z0-9-_]{0,31}$/;

/**
 * @typedef {object} CommandModule
 * @property {object} data                       SlashCommandBuilder instance
 * @property {string} category
 * @property {number} [cooldown]
 * @property {boolean} [ownerOnly]
 * @property {boolean} [guildOnly]
 * @property {boolean} [dmOnly]
 * @property {boolean} [nsfwOnly]
 * @property {string[]} [userPermissions]
 * @property {string[]} [botPermissions]
 * @property {(interaction:any, ctx:any)=>Promise<void>} execute
 * @property {(interaction:any, ctx:any)=>Promise<void>} [autocomplete]
 */

/**
 * Validate one command module and normalise its defaults.
 * @param {CommandModule} command
 * @param {string} file
 * @returns {CommandModule}
 */
export function validateCommand(command, file) {
  const where = `command file "${file}"`;
  if (!command || typeof command !== 'object') {
    throw new ValidationError(`${where} does not default-export an object`);
  }
  if (!command.data || typeof command.data.toJSON !== 'function') {
    throw new ValidationError(`${where} is missing a valid "data" builder`);
  }

  const json = command.data.toJSON();
  const name = json?.name;
  if (typeof name !== 'string' || !COMMAND_NAME_RE.test(name)) {
    throw new ValidationError(`${where} has an invalid command name "${name}" (lowercase, 1-32, [a-z0-9-_])`);
  }
  if (typeof command.execute !== 'function') {
    throw new ValidationError(`${where} is missing an execute() function`);
  }
  if (command.autocomplete !== undefined && typeof command.autocomplete !== 'function') {
    throw new ValidationError(`${where} declares "autocomplete" but it is not a function`);
  }

  return {
    ...command,
    name,
    category: command.category ?? 'general',
    cooldown: command.cooldown ?? DEFAULT_COOLDOWNS.normal,
    ownerOnly: Boolean(command.ownerOnly),
    guildOnly: Boolean(command.guildOnly),
    dmOnly: Boolean(command.dmOnly),
    nsfwOnly: Boolean(command.nsfwOnly),
    userPermissions: command.userPermissions ?? [],
    botPermissions: command.botPermissions ?? [],
    i18nKey: command.i18nKey ?? name,
    __file: file,
  };
}

/**
 * Load every command from a directory tree.
 * @param {string} directory
 * @param {object} [options]
 * @param {boolean} [options.strict] throw on the first invalid command (default true)
 * @returns {Promise<{ commands: Collection<string, CommandModule>, errors: { file:string, message:string }[] }>}
 */
export async function loadCommands(directory, options = {}) {
  const logger = getLogger().child('commands');
  const strict = options.strict ?? true;
  const commands = new Collection();
  const errors = [];

  const files = [];
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch((err) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.startsWith('_')) files.push(full);
    }
  };
  await walk(directory);
  files.sort();

  for (const file of files) {
    const rel = relative(process.cwd(), file);
    try {
      const mod = await import(`file://${file}`);
      const command = validateCommand(mod.default ?? mod, rel);
      if (commands.has(command.name)) {
        throw new ValidationError(`duplicate command name "${command.name}" (already loaded from ${commands.get(command.name).__file})`);
      }
      commands.set(command.name, command);
      logger.debug('Loaded command', { name: command.name, category: command.category, file: rel });
    } catch (err) {
      errors.push({ file: rel, message: err.message });
      logger.errorFrom(err, 'Failed to load command', { file: rel });
      if (strict) throw err;
    }
  }

  logger.info('Commands loaded', { count: commands.size, categories: [...new Set([...commands.values()].map((c) => c.category))].length });
  return { commands, errors };
}

/**
 * Attach localized names/descriptions (root + every option + every subcommand)
 * so `/language set` reads "atur" for an Indonesian client and "definir" for a
 * Spanish one — while the *internal* name stays stable for routing.
 *
 * @param {CommandModule} command
 * @param {string} [baseKey] i18n key inside the `commands` namespace
 * @returns {object} plain JSON payload for the REST API
 */
export function localizeCommandPayload(command, baseKey = command.i18nKey ?? command.name) {
  const json = structuredClone(command.data.toJSON());
  const { nameLocalizations, descriptionLocalizations } = commandLocalizations(baseKey);

  if (Object.keys(nameLocalizations).length) json.name_localizations = nameLocalizations;
  if (Object.keys(descriptionLocalizations).length) json.description_localizations = descriptionLocalizations;

  /**
   * Apply localizations from the first key that the locale files actually
   * define. Options shared by several subcommands (e.g. the `language` choice
   * used by both `/language set` and `/language server`) are declared once at
   * `<command>.options.<name>` and picked up here through the fallback key.
   */
  const applyLocalized = (target, candidateKeys) => {
    for (const key of candidateKeys) {
      const localized = commandLocalizations(key);
      const hasNames = Object.keys(localized.nameLocalizations).length > 0;
      const hasDescriptions = Object.keys(localized.descriptionLocalizations).length > 0;
      if (hasNames || hasDescriptions) {
        if (hasNames) target.name_localizations = localized.nameLocalizations;
        if (hasDescriptions) target.description_localizations = localized.descriptionLocalizations;
        return true;
      }
    }
    return false;
  };

  const walkOptions = (options, keyPrefix, isSubcommandLevel = false) => {
    for (const option of options ?? []) {
      const nestedKey = `${keyPrefix}.options.${option.name}`;
      const sharedKey = `${baseKey}.options.${option.name}`;
      applyLocalized(option, isSubcommandLevel ? [nestedKey, sharedKey] : [nestedKey]);

      if (option.type === 2 /* SUB_COMMAND_GROUP */ || option.type === 1 /* SUB_COMMAND */) {
        walkOptions(option.options, nestedKey, true);
      }
      for (const choice of option.choices ?? []) {
        applyLocalized(choice, [`${nestedKey}.choices.${choice.name}`, `${sharedKey}.choices.${choice.name}`]);
      }
    }
  };
  walkOptions(json.options, baseKey, false);

  return json;
}

/** Re-exported for command files that want option localization directly. */
export { optionLocalizations };
