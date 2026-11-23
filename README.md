# xXx Family

**International All-in-One Discord Community Ecosystem — Premium Cyberpunk Edition**

`v1.0.0` · Node.js LTS · discord.js v14 · MongoDB Atlas · Express · i18next · Next.js dashboard (Phase 8)

xXx Family is a modular Discord platform built for **international** communities: moderation, community
management, entertainment, AI assistance, automation and a web dashboard — all rendered in the member's
own language.

> **Phase status — read this first.** This repository contains **Phases 1–3 complete** and **Phase 4
> partly complete**: the platform core, welcome/goodbye, booster, logging, moderation, automod,
> temporary voice and tickets. Anonymous submissions, streaks and Phases 5–9 are **not implemented
> yet** and are listed with honest status in [docs/ROADMAP.md](docs/ROADMAP.md). Nothing here is a
> placeholder pretending to be finished — what exists, runs, and is covered by tests.

---

## What is built

| Area | Status | Where |
|---|---|---|
| Discord client + boot sequence | ✅ working | `src/bot/client.js`, `src/bot/index.js` |
| 10-language i18n system (40 translation files) | ✅ working | `src/locales/`, `src/services/i18nService.js` |
| Locale resolution (user → Discord → guild → default) | ✅ working | `src/services/localeService.js` |
| MongoDB connection manager + models | ✅ working | `src/database/` |
| Guild/user settings with cache + degraded mode | ✅ working | `src/services/settingsService.js` |
| Dynamic command loader + localized registration | ✅ working | `src/handlers/commandLoader.js` |
| Event handler (26 gateway events) | ✅ working | `src/bot/events/` |
| Plugin/module manager (dependencies, isolation) | ✅ working | `src/handlers/moduleLoader.js` |
| Interaction router + guards + error contract | ✅ working | `src/handlers/interactionHandler.js`, `src/middleware/` |
| Rate limiting + per-command cooldowns | ✅ working | `src/middleware/rateLimiter.js` |
| Structured logging + secret redaction | ✅ working | `src/utils/logger.js`, `src/utils/redact.js` |
| Health / liveness / readiness / metrics API | ✅ working | `src/api/`, `src/services/healthService.js` |
| Graceful shutdown (SIGINT/SIGTERM/SIGHUP) | ✅ working | `src/bot/index.js` |
| Test suite — **588 tests, all passing** | ✅ working | `tests/` |
| Commands shipped (11) | `/ping` `/uptime` `/help` `/language` `/settings` `/welcome` `/booster` `/mod` `/automod` `/tempvoice` `/ticket` | `src/bot/commands/` |

### Phases 2–4 — community subsystems

| Area | Status | Where |
|---|---|---|
| Welcome / goodbye + auto roles | ✅ working | `src/services/welcomeService.js`, `/welcome` |
| Booster tracking + leaderboard | ✅ working | `src/services/boosterService.js`, `/booster` |
| Structured logging across 19 event types | ✅ working | `src/services/loggingService.js`, `logging` module |
| Moderation (11 actions) + case records | ✅ working | `src/services/moderationService.js`, `/mod` |
| Permission + role-hierarchy enforcement | ✅ working | `src/services/permissionService.js` |
| Automod (spam, flood, phishing, invites, words) | ✅ working | `src/services/automodService.js`, `/automod` |
| Temporary voice (join-to-create) | ✅ working | `src/services/tempVoiceService.js`, `/tempvoice` |
| Tickets: open → claim → close, transcripts | ✅ working | `src/services/ticketService.js`, `/ticket` |
| Modules running | 7 (`core`, `booster`, `logging`, `welcome`, `moderation`, `tempvoice`, `tickets`) | `src/bot/modules/` |
| Registered models | 14 collections | `src/database/models/` |

**Not built yet:** anonymous submissions and streaks (rest of Phase 4), XP/levels/economy/profiles,
the digital member card, the AI assistant, games, tools, giveaways, music and the web dashboard.
[docs/ROADMAP.md](docs/ROADMAP.md) states the status of each.

## Supported languages

| Code | Language | Native | Discord code |
|---|---|---|---|
| `en-US` | English (US) | English (US) | `en-US` |
| `en-GB` | English (UK) | English (UK) | `en-GB` |
| `id-ID` | Indonesian | Bahasa Indonesia | `id` |
| `es-ES` | Spanish | Español | `es-ES` |
| `pt-BR` | Portuguese (BR) | Português (Brasil) | `pt-BR` |
| `fr-FR` | French | Français | `fr` |
| `de-DE` | German | Deutsch | `de` |
| `ja-JP` | Japanese | 日本語 | `ja` |
| `ko-KR` | Korean | 한국어 | `ko` |
| `ar` | Arabic | العربية | *not supported by Discord* |

Arabic is fully translated for messages, embeds, buttons and the dashboard, but Discord's API does not
accept `ar` inside `name_localizations`, so it is automatically skipped during command registration
rather than breaking the whole payload. See [docs/04-internationalization.md](docs/04-internationalization.md).

---

## Quick start

```bash
# 1. install
npm install

# 2. configure
cp .env.example .env        # then edit .env — see docs/02-configuration.md

# 3. check the environment (no network needed)
npm run doctor

# 4. verify the database connection (needs MONGODB_URI)
npm run db:check

# 5. register slash commands (validate offline first)
npm run deploy:commands:dry          # prints + validates the payload, no API call
npm run deploy:commands              # global (up to 1h to propagate)
DEPLOY_GUILD_ID=123... npm run deploy:commands:guild   # instant, one guild

# 6. run
npm start

# 7. in another terminal
npm run health
```

Without `DISCORD_TOKEN` the process still starts the HTTP API and logs a warning — useful while
building the dashboard. Without `MONGODB_URI` it runs in **degraded mode**: commands work, settings are
served from defaults and nothing is persisted (this is reported honestly on `/health`).

## Scripts

| Command | Purpose |
|---|---|
| `npm start` | Run the bot + API |
| `npm run start:api` | Run only the Express API (no gateway) |
| `npm run dev` | Run with `--watch` |
| `npm test` | Full test suite (588 tests) |
| `npm run test:unit` / `test:integration` | Split runs |
| `npm run doctor` | Pre-flight environment diagnostics |
| `npm run db:check` | MongoDB connection + index verification |
| `npm run locales:verify` | Locale parity + Discord constraint gate |
| `npm run deploy:commands:dry` | Validate the registration payload offline |
| `npm run deploy:commands` | Register slash commands with Discord |
| `npm run health` | Query a running instance's health report |

## HTTP endpoints

| Route | Purpose |
|---|---|
| `GET /` | Service identity + endpoint list |
| `GET /health` | Full health report (503 if a critical check fails) |
| `GET /health/live` | Liveness — always 200 if the process answers |
| `GET /health/ready` | Readiness — what a process manager should gate restarts on |
| `GET /metrics` | Command/interaction counters + memory + cache stats |
| `GET /api/v1/status` | Bot, i18n and module state (no secrets) |
| `GET /api/v1/locales` | Locale metadata for the dashboard |
| `GET /api/v1/commands` | Registered command inventory |

## Project structure

```
src/
├── bot/
│   ├── index.js            # process entry: signals, boot, shutdown deadline
│   ├── client.js           # XxxFamilyClient — registries + boot sequence
│   ├── commands/           # admin/ utility/ (slash commands)
│   ├── events/             # 26 gateway event handlers
│   └── modules/            # plugin modules (core/ …)
├── handlers/               # command/event/module/interaction loaders
├── services/               # i18n, locale, settings, cache, health, metrics
├── middleware/             # rate limits, cooldowns, guards, http middleware
├── database/               # connection manager + Mongoose models
├── locales/<10 locales>/   # common, commands, errors, components
├── api/                    # Express app, health + status routes
├── config/                 # validated env, brand constants, locale registry
└── utils/                  # logger, redaction, errors, embeds, formatting
scripts/                    # doctor, db-check, deploy, verify-locales, health-check
tests/                      # unit + integration (588 tests)
docs/                       # installation, configuration, architecture, roadmap
```

Full tree and conventions: [docs/03-architecture.md](docs/03-architecture.md)

## Documentation

- [docs/01-termux-installation.md](docs/01-termux-installation.md) — Android Termux setup and running
- [docs/02-configuration.md](docs/02-configuration.md) — environment, Discord portal, MongoDB Atlas, OAuth2, permissions
- [docs/03-architecture.md](docs/03-architecture.md) — module system, command contract, boot order
- [docs/04-internationalization.md](docs/04-internationalization.md) — the i18n system and adding a locale
- [docs/05-testing-and-qa.md](docs/05-testing-and-qa.md) — test strategy and QA gates
- [docs/06-troubleshooting.md](docs/06-troubleshooting.md) — common failures and fixes
- [docs/ROADMAP.md](docs/ROADMAP.md) — Phases 2–9 with honest status

## Security notes

- Secrets live only in `.env` (git-ignored). `.env.example` ships with empty values.
- Every log line passes through the redactor: tokens, passwords, connection-string credentials and any
  registered secret are replaced with `[REDACTED]` before they reach a file or terminal.
- Users only ever see localized `errors:*` messages — never a stack trace or an internal message.
- The API sets hardened headers, an allow-list CORS policy and rate limits. Session/CSRF protection
  arrives with the dashboard in Phase 8.

## License

MIT
