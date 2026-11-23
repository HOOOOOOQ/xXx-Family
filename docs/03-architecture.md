# 03 — Architecture

111 source files, ~9,200 lines of JavaScript (Phase 1). Everything is ESM (`"type": "module"`), no
TypeScript build step, no native dependencies — so the same code runs on Android Termux and on a VPS.

---

## Boot order

`src/bot/index.js` owns the process; `src/bot/client.js` owns the bot. The order is explicit because
later steps depend on earlier ones:

```
1. initConfig()          read .env, validate, register secrets with the redactor
2. Logger                structured logging (level + format from config)
3. process handlers      unhandledRejection / uncaughtException / warning
4. initI18n()            load every locale — must precede anything user-visible
5. connectDatabase()     retries with backoff; failure is non-fatal (degraded mode)
6. loadCommands()        validate each command, then call command.register(client)
7. loadEvents()          validate and bind gateway listeners
8. modules.discover()    + modules.boot() in dependency order
9. registerHealthChecks()
10. startApiServer()     Express on 0.0.0.0:PORT
11. client.login()       gateway connection
```

A failure in 5 is logged and recorded in `client.loadErrors`; a failure in 6–8 aborts the boot in
production (`strict: true`) so a broken command can never ship silently.

### Shutdown

`SIGINT` / `SIGTERM` / `SIGHUP` → modules stop in reverse order → gateway destroyed → MongoDB
disconnected → cache sweeper stopped → i18n torn down → `process.exit(0)`. A timer
(`SHUTDOWN_TIMEOUT_MS`, default 10 s) forces `exit(1)` if any step hangs. Verified end-to-end: the log
ends with `Shutdown complete` → `Goodbye` and the process exits 0.

---

## The four loaders

| Loader | Path | Contract |
|---|---|---|
| Commands | `src/bot/commands/**.js` | default-export `{ data, execute, … }` |
| Events | `src/bot/events/*.js` | default-export `{ name, once?, execute }` (named exports allowed) |
| Modules | `src/bot/modules/<name>/index.js` | default-export `{ name, phase, dependencies, init?, start?, stop? }` |
| Components | registered at runtime | `client.registerComponent(namespace, handler)` |

Each loader **validates before it registers**. A missing `execute()`, a bad command name or a duplicate
name throws at boot with the file path in the message, rather than failing at 3 a.m. inside a live
interaction. In production this is fatal; in development the error is collected into `loadErrors` and
surfaced on `/health`.

### Command contract

```js
import { SlashCommandBuilder, MessageFlags } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check the bot, gateway and database latency.'), // must match en-US/commands.json
  category: 'utility',          // also the GuildSettings.moduleToggles key
  cooldown: 3000,               // ms, per user per command
  guildOnly: false,
  dmOnly: false,
  nsfwOnly: false,
  ownerOnly: false,
  userPermissions: ['ManageGuild'],   // Discord permission names
  botPermissions: ['SendMessages'],
  i18nKey: 'ping',              // key inside the `commands` namespace (defaults to the name)

  async register(client) {      // optional: wire component namespaces once at boot
    client.registerComponent('help', async (interaction, ctx) => { /* … */ });
  },

  async execute(interaction, ctx) {
    // ctx: { client, command, t, locale, localeContext, dir, settings, startedAt, logger }
    await interaction.reply({ content: ctx.t('commands:responses.pong'), flags: MessageFlags.Ephemeral });
  },
};
```

**Rule: never build a user-visible string by concatenation.** Use `ctx.t('namespace:key', { vars })`.
The bound translator `ctx.t` is pinned to one locale, so a reply cannot accidentally mix languages.

`ctx.dir` is `'ltr'` or `'rtl'`; pass it to `brandEmbed({ dir })` so Arabic renders correctly.

### Module contract

```js
export default {
  name: 'welcome',              // kebab-case, unique
  version: '1.0.0',
  phase: 2,                     // boot ordering hint
  dependencies: ['core'],       // booted first; cycles are detected and rejected
  configKey: 'welcome',         // GuildSettings.moduleToggles key

  async init(ctx) {},           // wire listeners, warm caches
  async start(ctx) { /* ctx: { client, config, settings, localeService, health, metrics, logger } */ },
  async stop(ctx) {},           // release timers, sockets, subscriptions
};
```

A module that throws during `init`/`start` is marked `failed` and **isolated** — the rest of the bot
keeps running and the failure is visible in `client.modules.status()` and on `/health`. Covered by
`tests/unit/moduleLoader.test.js`.

### Component routing

Custom IDs use `<module>:<action>[:payload]`. The interaction handler splits the ID, looks the namespace
up in `client.components` (or `client.modals`), resolves the locale, and calls the handler with
`{ client, action, payload, t, locale, dir, logger }`. An unknown namespace produces a localized
"interaction no longer valid" reply instead of a silent drop.

---

## Interaction flow

```
interactionCreate
  └─ InteractionHandler.handle()
       ├─ isChatInputCommand → find command
       │    ├─ localeService.resolveForInteraction()   → { locale, source, dir, t }
       │    ├─ enforceCommandGuards()                  → guild/DM/NSFW/owner/permissions/cooldown
       │    ├─ settings.isModuleEnabled(category)      → per-guild module gate
       │    ├─ command.execute(interaction, ctx)
       │    └─ metrics.recordCommand(name, durationMs)
       ├─ isAutocomplete → command.autocomplete()
       ├─ isButton / isAnySelectMenu → component router
       └─ isModalSubmit → modal router
  └─ any throw → handleInteractionError()
```

`handleInteractionError()` is the only place that turns an error into a reply. It always sends a
localized `errors:*` message, always logs the technical detail, and never leaks a stack trace — asserted
in `tests/integration/interaction.test.js` ("a failing command never leaks a stack trace to the user").

### Guards

`enforceCommandGuards()` checks, in order: guild-only, DM-only, NSFW-only, owner-only, member
permissions (Administrator bypasses), **bot** permissions, then cooldown. Each failure throws an
`AppError` with an `i18nKey`, so the user sees a translated explanation and the log keeps the detail.

---

## Data layer

`src/database/connection.js` owns the Mongoose connection: bounded exponential backoff on connect,
lifecycle events wired to the logger, a **real `ping`** for health (never a guessed "connected" flag),
and graceful disconnect.

Phase 1 models (`src/database/models/`):

| Model | Purpose | Indexes |
|---|---|---|
| `GuildSettings` | guild language, module toggles, feature config, reserved channels | unique `guildId` |
| `UserSettings` | personal language, theme, timezone, DM/AI privacy flags | unique `userId`, `language` |
| `LanguageOverride` | per channel / role / module language overrides | unique `(guildId, scope, scopeId, module)` |

`models/index.js` also declares the 27 collections planned for Phases 2–9, so the roadmap is explicit
rather than implied.

Every module reads configuration through `SettingsService`, never through Mongoose directly. That gives
one cache in front of MongoDB, one definition of "default", and a **degraded mode**: when MongoDB is
unreachable, defaults are served and writes fail loudly with a localized error instead of throwing
inside an event handler.

Snowflakes are stored as **strings** — Discord IDs exceed `Number.MAX_SAFE_INTEGER`.

---

## Caching

`CacheManager` (`src/services/cacheManager.js`) is a TTL + LRU cache with a `wrap()` read-through
helper that **de-duplicates concurrent loads**, so a burst of events in a large guild cannot stampede
the database. Covered by `tests/unit/cacheManager.test.js`.

Settings are cached for 120 s (15–30 s in degraded mode); language overrides for 60 s. Writes invalidate
the affected keys immediately.

---

## Health, metrics, logging

- **Health**: modules register named probes; `/health` runs them concurrently with a per-probe timeout
  so one hung dependency cannot hang the endpoint. `critical: true` probes decide readiness.
- **Metrics**: in-process counters — command counts, average/max duration, errors, cache hit rate,
  memory. No external metrics stack required.
- **Logging**: `json` (one object per line) or `pretty` (colourised). Every record is redacted. Levels
  from `trace` to `fatal`; a bounded in-memory ring buffer backs the `/health` debug view.

---

## Sharding

Nothing assumes a single process: guild-scoped work is always keyed by `guildId`, shard events are
handled (`shardReady`, `shardReconnecting`, `shardResume`, `shardDisconnect`, `shardError`), and
`/health` reports `shardId`. When the guild count requires it, run `ShardingManager` over
`src/bot/index.js` without changing module code.

## Where Phase 2+ plugs in

| New thing | Where it goes |
|---|---|
| A feature (welcome, tickets, economy…) | `src/bot/modules/<name>/index.js` + its own model |
| A slash command | `src/bot/commands/<category>/<name>.js` |
| A gateway event | `src/bot/events/<name>.js` |
| A translation key | all 10 `src/locales/<locale>/<ns>.json` files (gate: `npm run locales:verify`) |
| A dashboard page | `dashboard/app/**` (Phase 8) |
| An API route | `src/api/routes/<name>.js` + one `app.use()` in `src/api/server.js` |
