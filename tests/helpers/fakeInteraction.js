/**
 * tests/helpers/fakeInteraction.js
 * ---------------------------------------------------------------------------
 * Minimal stand-in for a discord.js interaction.
 *
 * It implements exactly the surface the production code touches, so the real
 * interaction handler, guards and locale resolution can be executed in a test
 * without a gateway connection. Anything the handler starts using that is not
 * modelled here throws loudly instead of silently returning undefined.
 */

import { PermissionFlagsBits } from 'discord.js';

const notImplemented = (name) => {
  throw new Error(`fakeInteraction.${name} is not modelled by this test helper`);
};

export class FakePermissions {
  /** @param {bigint[]|'*'} granted */
  constructor(granted = '*') {
    this.granted = granted;
  }

  has(flag) {
    if (this.granted === '*') return true;
    return this.granted.includes(flag);
  }
}

export class FakeOptions {
  constructor(values = {}) {
    this.values = values;
  }

  getSubcommand() {
    if (this.values.__subcommand === undefined) notImplemented('getSubcommand');
    return this.values.__subcommand;
  }

  getString(name, required = false) {
    const value = this.values[name];
    if (value === undefined && required) throw new Error(`Missing required option "${name}"`);
    return value ?? null;
  }

  getBoolean(name) {
    return this.values[name] ?? null;
  }

  getChannel(name, required = false) {
    const value = this.values[name];
    if (value === undefined && required) throw new Error(`Missing required option "${name}"`);
    return value ?? null;
  }

  getRole(name, required = false) {
    const value = this.values[name];
    if (value === undefined && required) throw new Error(`Missing required option "${name}"`);
    return value ?? null;
  }

  getUser(name, required = false) {
    const value = this.values[name];
    if (value === undefined && required) throw new Error(`Missing required option "${name}"`);
    return value ?? null;
  }

  getMember(name, required = false) {
    const value = this.values[name];
    if (value === undefined && required) throw new Error(`Missing required option "${name}"`);
    return value ?? null;
  }

  getInteger(name, required = false) {
    const value = this.values[name];
    if (value === undefined && required) throw new Error(`Missing required option "${name}"`);
    return value ?? null;
  }

  getNumber(name, required = false) {
    return this.getInteger(name, required);
  }
}

/**
 * @param {object} [params]
 * @param {string} [params.commandName]
 * @param {string|null} [params.guildId]
 * @param {object} [params.options]
 * @param {bigint[]|'*'} [params.permissions]
 * @param {string} [params.locale]     Discord client locale of the user
 * @param {string} [params.guildLocale]
 * @param {string} [params.customId]
 * @param {string[]} [params.selectValues]
 * @param {object} [params.client]
 */
export function createFakeInteraction(params = {}) {
  const {
    commandName = 'ping',
    guildId = '111111111111111111',
    userId = '222222222222222222',
    options = {},
    permissions = '*',
    locale = 'en-US',
    guildLocale = 'en-US',
    customId = null,
    selectValues = [],
    client = null,
    kind = 'chatInput',
    /** Position of the bot's highest role — used for hierarchy checks. */
    botRolePosition = 10,
    /** Position of the acting member's highest role — used for hierarchy checks. */
    memberRolePosition = 5,
    /**
     * Replace the synthesised guild entirely. Moderation commands call
     * `guild.members.ban()` and read `guild.ownerId`, which the default
     * stub does not model.
     */
    guild = null,
    guildName = 'Test Guild',
    memberCount = 1284,
  } = params;

  const calls = { reply: [], editReply: [], followUp: [], update: [], deferReply: 0 };

  const interaction = {
    id: '900000000000000000',
    type: kind === 'chatInput' ? 2 : 3,
    commandName,
    customId,
    guildId,
    channelId: guildId ? '333333333333333333' : null,
    createdTimestamp: Date.now() - 12,
    locale,
    guildLocale: guildId ? guildLocale : null,
    user: {
      id: userId,
      username: 'tester',
      displayName: 'tester',
      tag: 'tester#0001',
      bot: false,
      createdTimestamp: Date.now() - 400 * 86400_000,
      displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/222/a.png',
    },
    member: guildId
      ? {
          id: userId,
          permissions: new FakePermissions(permissions),
          // `highest` is what every hierarchy check reads; a real GuildMember
          // always has it, so a helper without it makes the actor look like
          // position -1 and every moderation check fails for the wrong reason.
          roles: { cache: new Map(), highest: { position: memberRolePosition } },
          joinedTimestamp: Date.now() - 3600_000,
          send: async () => ({ id: 'dm-1' }),
          // A real GuildMember always carries its guild; code that reads
          // `member.guild.id` would otherwise crash only in production.
          get guild() {
            return interaction.guild;
          },
        }
      : null,
    guild: guildId
      ? (guild ?? {
          id: guildId,
          name: guildName,
          memberCount,
          iconURL: () => null,
          members: {
            me: {
              permissions: new FakePermissions('*'),
              roles: { highest: { position: botRolePosition } },
            },
          },
          roles: { cache: new Map(), everyone: { id: guildId, position: 0 } },
        })
      : null,
    channel: { id: '333333333333333333', nsfw: false },
    client: client ?? { ws: { ping: 42, status: 0 }, guilds: { cache: new Map() }, commands: new Map() },
    options: new FakeOptions(options),
    values: selectValues,

    inGuild: () => Boolean(guildId),
    isChatInputCommand: () => kind === 'chatInput',
    isAutocomplete: () => kind === 'autocomplete',
    isButton: () => kind === 'button',
    isAnySelectMenu: () => kind === 'selectMenu',
    isStringSelectMenu: () => kind === 'selectMenu',
    isModalSubmit: () => kind === 'modal',
    isContextMenuCommand: () => kind === 'contextMenu',
    isRepliable: () => true,

    get replied() {
      return calls.reply.length > 0;
    },
    get deferred() {
      return calls.deferReply > 0;
    },

    async reply(payload) {
      calls.reply.push(payload);
      return { id: 'reply-1' };
    },
    async deferReply(payload) {
      calls.deferReply += 1;
      calls.deferReplyPayload = payload;
      return { id: 'defer-1' };
    },
    async editReply(payload) {
      calls.editReply.push(payload);
      return { id: 'defer-1' };
    },
    async followUp(payload) {
      calls.followUp.push(payload);
      return { id: 'follow-1' };
    },
    async update(payload) {
      calls.update.push(payload);
      return { id: 'update-1' };
    },

    __calls: calls,
  };

  return interaction;
}

export { PermissionFlagsBits, notImplemented };
export default createFakeInteraction;
