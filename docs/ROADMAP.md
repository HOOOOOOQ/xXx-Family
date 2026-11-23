# Roadmap — honest status

The specification defines nine phases. **Phases 1–3 are complete and Phase 4 is partly complete**
(temporary voice and tickets are built; anonymous submissions and streaks are not). Phases 5–9 are
plans, not code.

Everything marked ✅ below is verifiable in this repository with the commands at the bottom of this
document. Nothing is marked complete because it was designed.

---

## ✅ Phase 1 — Platform core (complete)

| Deliverable | Status | Evidence |
|---|---|---|
| Repository + Node.js configuration | ✅ | `package.json`, `.gitignore`, `.env.example` |
| Discord client + boot sequence | ✅ | `src/bot/client.js`, `src/bot/index.js` |
| MongoDB connection manager | ✅ | `src/database/connection.js` (retries, ping health, graceful close) |
| Command loader | ✅ | `src/handlers/commandLoader.js` + 11 commands |
| Event handler | ✅ | `src/handlers/eventLoader.js` + 26 events |
| Module/plugin manager | ✅ | `src/handlers/moduleLoader.js` + 7 modules |
| Logger + secret redaction | ✅ | `src/utils/logger.js`, `src/utils/redact.js` |
| Error handling contract | ✅ | `src/utils/errors.js`, `src/middleware/interactionErrorHandler.js` |
| Internationalization (10 locales) | ✅ | `src/locales/**` (40 files), `i18nService`, `localeService` |
| Health checks | ✅ | `/health`, `/health/live`, `/health/ready`, `/metrics` |
| Testing | ✅ | 588 tests passing across 124 suites |

Commands shipped: `/ping`, `/uptime`, `/help`, `/language`, `/settings`.

## ✅ Phase 2 — Onboarding and presence (complete)

| Deliverable | Status | Evidence |
|---|---|---|
| Welcome + goodbye | ✅ | `src/services/welcomeService.js`, `/welcome` (8 subcommands), `message`/`test` preview |
| Auto roles on join | ✅ | `/welcome roles`, `WelcomeConfig.autoRoleIds` |
| Rejoin handling | ✅ | welcome module tracks rejoins; reported in `/health` as `rejoinEntries` |
| Booster system | ✅ | `src/services/boosterService.js`, `/booster` (8 subcommands) |
| Boost detection | ✅ | `guildMemberUpdate` diff on `member.premiumSince` |
| Structured logging | ✅ | `src/services/loggingService.js`, `logging` module, 19 event files |
| Audit trail | ✅ | `AuditLog` model |

**Known gap (carried forward, intentional):** `inviteCreate`/`inviteDelete` and member
timeout add/remove have `logs.title`/`logs.desc` keys in all 10 locales but no event file consumes
them yet. The keys exist so the strings are not invented later; the events do not.

discord.js 14.28 emits no boost event, so `member.premiumSince` on `guildMemberUpdate` is the only
reliable signal. Discord clears that field almost immediately, which is why the diff must happen on
the same tick.

## ✅ Phase 3 — Moderation and security (complete)

| Deliverable | Status | Evidence |
|---|---|---|
| Permission service | ✅ | `src/services/permissionService.js` (hierarchy, role caps, self/owner guards) |
| Moderation actions | ✅ | `/mod` — ban, unban, kick, timeout, untimeout, warn, purge, slowmode, lock, unlock, history |
| Case records | ✅ | `ModerationCase`, sequential per-guild numbering via `Counter` |
| Automod | ✅ | `/automod` — view, enable, disable, rule, whitelist, test |
| Automod scanning | ✅ | `src/services/automodService.js` on `messageCreate` |
| Ranked responses | ✅ | `timeout > warn > delete`, 5-minute automod timeouts |

Ordering rule that is deliberate: **permission gate → Discord call → case record → audit → DM**. A
case is never written for an action that Discord rejected, so the audit trail cannot contain
phantom punishments.

**Note on `AutomodConfig`:** automod rules live inside the `GuildSettings` feature block rather than
in their own collection, so `AutomodConfig` remains in `PLANNED_MODELS`. That is a design choice, not
an omission — it keeps a server's automod and feature flags in one atomic write.

## 🔶 Phase 4 — Voice, tickets, anonymous, streaks (partly complete)

### ✅ 4A — Temporary voice (join-to-create)

| Deliverable | Status | Evidence |
|---|---|---|
| Join-to-create | ✅ | `src/services/tempVoiceService.js`, `voiceStateUpdate` hook |
| Room lifecycle | ✅ | create on trigger-channel join, delete when empty after a grace period |
| Room control | ✅ | `/tempvoice` — 14 subcommands incl. rename, lock/unlock, limit, transfer |
| Ownership cap | ✅ | `maxOwnedPerUser` enforced via `countDocuments` |
| Restart safety | ✅ | `reconcile()` on `guildCreate` and at module start |

Two rules worth knowing: a failed `member.voice.setChannel` **deletes the freshly created channel**
(so servers never accumulate dead rooms), and unlocking writes `{ Connect: null }` to remove the
override rather than granting everyone Connect.

### ✅ 4B — Tickets

| Deliverable | Status | Evidence |
|---|---|---|
| Models | ✅ | `TicketConfig`, `Ticket` (transcript stored inline) |
| Lifecycle | ✅ | `src/services/ticketService.js` — open, claim, close, rate, add, priority |
| Command | ✅ | `/ticket` — 14 subcommands |
| Panel buttons | ✅ | `client.registerComponent('ticket', …)`, custom id `ticket:open:<category>` |
| Transcripts | ✅ | Recorded on `messageCreate`, posted as a `.txt` attachment on close |
| Stats | ✅ | `/ticket stats` + `/health` `tickets` probe |

**Deliberate deviation from the original plan:** the spec said *HTML* transcripts. Transcripts are
plain text. A `.txt` attachment needs no escaping pass, cannot become an injection vector, and opens
anywhere — HTML would have meant a renderer plus an escaping audit for no user-visible gain. If an
HTML export is wanted later, `buildTranscript()` already returns a structured object it can render
from.

**Design notes.** `TicketMessage` is not a separate collection: transcript lines live inside the
`Ticket` document. They belong to exactly one ticket, are only ever read as a whole, and a separate
collection would need its own lifecycle to stay in step with deletes. Claim, close and rate all use
`findOneAndUpdate` with a status guard, so two staff clicking at once cannot both win.

### ⬜ 4C — Anonymous submissions

*Not started.* Needs `AnonymousSubmission` and a relay that never stores the sender alongside the
content, or the anonymity is decorative.

### ⬜ 4D — Streaks

*Not started.* Needs `Streak` and a definition of what counts as activity.

## ⬜ Phase 5 — Identity, XP, economy

Member profiles, the xXx Family digital member card, XP/levels/rank cards, wallet/bank/shop/inventory,
achievements, quests.

*Not started.* Rank cards need a canvas renderer — a dependency decision still open (native
`@napi-rs/canvas` vs. an SVG-to-PNG service; the former has no Termux prebuilt for every device).
The member card must not imitate a government ID or request national identity numbers.

## ⬜ Phase 6 — AI, games, tools, community

xXx AI assistant with provider fallback and quotas, the game centre, the tools centre, community
management.

*Not started.* `AI_PROVIDER` / `AI_API_KEY` are reserved in the config and deliberately unused. The AI
assistant must respect Discord permissions and never surface private-channel content. No real-money
gambling in the game centre.

## ⬜ Phase 7 — Automation

Announcement scheduler, custom tags and auto-responses, giveaways, music.

*Not started.* The scheduler and background-task queue are **not** built yet — only the `core`
module's self-check interval and the temp-voice cleanup timers exist. Music playback requires a
provider decision (no unauthorized source scraping).

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

## Current inventory

| | Count |
|---|---|
| Commands | 11 |
| Events | 26 |
| Modules | 7 (`core`, `booster`, `logging`, `welcome`, `moderation`, `tempvoice`, `tickets`) |
| Registered models | 14 |
| Planned models | 18 |
| Locales | 10 × 4 namespaces, 655 keys each (`ar` 659) |
| Tests | 588 across 124 suites |

Registered models: `GuildSettings`, `UserSettings`, `LanguageOverride`, `AuditLog`, `WelcomeConfig`,
`GoodbyeConfig`, `BoosterConfig`, `BoosterRecord`, `ModerationCase`, `Counter`, `TempVoiceConfig`,
`TemporaryVoice`, `TicketConfig`, `Ticket`.

## Deferred decisions

| Decision | Why it is open |
|---|---|
| Rank-card renderer | Native canvas vs. SVG service on Termux |
| Music provider | Must be an authorized playback source; no scraping |
| Sharding trigger | `ShardingManager` is ready to adopt, but no guild count justifies it yet |
| Dashboard hosting | Termux-local vs. Vercel vs. VPS — affects OAuth2 redirect URIs |
| Transcript format | Shipped as plain text; an HTML/PDF export would render from `buildTranscript()` |

## How to verify any claim in this document

```bash
npm test                        # 588 tests
npm run doctor                  # 28 environment checks — 0 failing, 5 warnings
npm run locales:verify          # 10 locales × 4 namespaces
npm run deploy:commands:dry     # exact Discord payload, validated offline
LOG_LEVEL=info PORT=4199 ENABLE_API=true node src/bot/index.js
curl -s localhost:4199/health   # 7 module probes incl. `tickets`
curl -s localhost:4199/metrics  # gauges incl. `tickets.trackedChannels`
```

The bot runs and self-reports without `DISCORD_TOKEN` or `MONGODB_URI`; `/health` then reports
`degraded` with `ready: true` and `database: unconfigured`. That is the intended offline posture, not
a failure.
