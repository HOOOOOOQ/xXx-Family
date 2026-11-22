# Roadmap — honest status

The specification defines nine phases. **Only Phase 1 is implemented.** Everything below is the plan;
nothing in Phases 2–9 exists in this repository yet.

---

## ✅ Phase 1 — Platform core (complete)

| Deliverable | Status | Evidence |
|---|---|---|
| Repository + Node.js configuration | ✅ | `package.json`, `.gitignore`, `.env.example` |
| Discord client + boot sequence | ✅ | `src/bot/client.js`, `src/bot/index.js` |
| MongoDB connection manager | ✅ | `src/database/connection.js` (retries, ping health, graceful close) |
| Command loader | ✅ | `src/handlers/commandLoader.js` + 5 commands |
| Event handler | ✅ | `src/handlers/eventLoader.js` + 14 events |
| Module/plugin manager | ✅ | `src/handlers/moduleLoader.js` + `core` module |
| Logger + secret redaction | ✅ | `src/utils/logger.js`, `src/utils/redact.js` |
| Error handling contract | ✅ | `src/utils/errors.js`, `src/middleware/interactionErrorHandler.js` |
| Internationalization (10 locales) | ✅ | `src/locales/**` (40 files), `i18nService`, `localeService` |
| Health checks | ✅ | `/health`, `/health/live`, `/health/ready`, `/metrics` |
| Testing | ✅ | 200 tests passing |

Commands shipped: `/ping`, `/uptime`, `/help`, `/language`, `/settings`.

## ⬜ Phase 2 — Onboarding and presence

Welcome, goodbye, auto roles, booster system, logging.

*Not started.* Planned shape:
`src/bot/modules/{welcome,goodbye,booster,logging}/index.js`, models `WelcomeConfig`, `GoodbyeConfig`,
`BoosterRecord`, `AuditLog`. The module contract, event loader and i18n keys are ready for it.

## ⬜ Phase 3 — Moderation and security

Ban/kick/timeout/warn/purge/slowmode/lockdown, automod (anti-spam, anti-flood, anti-raid,
anti-phishing, anti-invite, mass-mention, bad words, duplicates), quarantine, whitelist/blacklist,
evidence logging.

*Not started.* `PermissionFlagsBits` handling, role-hierarchy validation and the guard pipeline already
exist in `src/middleware/cooldownManager.js`; the automod message pipeline needs `MessageContent`
(already requested in `REQUIRED_INTENTS`).

## ⬜ Phase 4 — Voice, tickets, anonymous, streaks

Join-to-create temporary voice, the ticket system with HTML transcripts, anonymous submissions, streaks.

*Not started.* Needs `GuildVoiceStates` (requested) and models `TemporaryVoice`, `Ticket`,
`TicketMessage`, `AnonymousSubmission`, `Streak`.

## ⬜ Phase 5 — Identity, XP, economy

Member profiles, the xXx Family digital member card, XP/levels/rank cards, wallet/bank/shop/inventory,
achievements, quests.

*Not started.* Rank cards need a canvas renderer — a dependency decision still open (native
`@napi-rs/canvas` vs. an SVG-to-PNG service; the former has no Termux prebuilt for every device).

## ⬜ Phase 6 — AI, games, tools, community

xXx AI assistant with provider fallback and quotas, the game centre, the tools centre, community
management.

*Not started.* `AI_PROVIDER` / `AI_API_KEY` are reserved in the config and deliberately unused.

## ⬜ Phase 7 — Automation

Announcement scheduler, custom tags and auto-responses, giveaways, music.

*Not started.* The scheduler and background-task queue are **not** built yet — Phase 1 only has the
`core` module's self-check interval. Music playback requires a provider decision (no unauthorized
source scraping).

## ⬜ Phase 8 — Web dashboard

Next.js dashboard with Discord OAuth2, the 35 planned pages, internationalized cyberpunk UI.

*Not started.* The API side is ready: `GET /api/v1/status`, `/api/v1/locales`, `/api/v1/commands`,
CORS allow-list, rate limiting and hardened headers all exist. `SESSION_SECRET`,
`DISCORD_CLIENT_SECRET` and `DISCORD_REDIRECT_URI` are already in the config schema. Session handling,
CSRF and role-based dashboard access are **not** implemented.

## ⬜ Phase 9 — Hardening

Security audit, performance optimisation, full documentation, Termux packaging.

*Partially covered early:* secret redaction, error-contract tests, input validation via Zod, rate
limiting and the doctor/health gates are already in place. A dedicated penetration pass and load test
are still pending.

---

## Deferred decisions

| Decision | Why it is open |
|---|---|
| Rank-card renderer | Native canvas vs. SVG service on Termux |
| Music provider | Must be an authorized playback source; no scraping |
| Sharding trigger | `ShardingManager` is ready to adopt, but no guild count justifies it yet |
| Dashboard hosting | Termux-local vs. Vercel vs. VPS — affects OAuth2 redirect URIs |

## How to verify any claim in this document

```bash
npm test                        # 200 tests
npm run doctor                  # 28 environment checks
npm run locales:verify          # 10 locales × 4 namespaces
npm run deploy:commands:dry     # exact Discord payload, validated offline
npm start && npm run health     # live health report
```
