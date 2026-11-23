# 05 — Testing and QA

**588 tests, all passing.** Built on Node's own test runner (`node:test`) — no test framework to
install, which matters on Termux.

```bash
npm test                 # everything
npm run test:unit        # 11 unit files
npm run test:integration # 3 integration files
npm run locales:verify   # translation gate
npm run doctor           # environment gate
```

Each test file runs in its own process, so the i18n singleton and Mongoose state cannot leak between
suites.

---

## What is covered

**588 tests: 473 unit + 115 integration across 29 files.** The per-file counts below add up to that
total, so a file that regresses is visible rather than hidden in a green suite.


### Unit (`tests/unit/`)

| File | Covers |
|---|---|
| `config.test.js` | env defaults, locale lists, production requirements, rejection of bad `PORT`/`DEPLOY_GUILD_ID`/locales, Discord↔internal locale mapping |
| `redact.test.js` | credential keys, registered secrets, connection strings, Maps/Sets/cycles/Errors, depth + array truncation, no input mutation |
| `logger.test.js` | JSON + pretty output, levels, child bindings, redaction, `errorFrom`, bounded ring buffer, runtime reconfigure |
| `errors.test.js` | hierarchy, expose rules, `toJSON` never leaking server messages, Discord REST classification, primitives |
| `cacheManager.test.js` | TTL, LRU eviction, prefix delete, hit rate, read-through, **in-flight de-duplication**, no caching of failures |
| `rateLimiter.test.js` | token bucket refill, per-key isolation, eviction, `Retry-After`, cooldown manager, and all eight guard rules |
| `i18n.test.js` | 10 locales loaded, per-locale strings, interpolation, **plural rules per language**, fallbacks, resolution priority, Discord localization output |
| `commandLoader.test.js` | validation failures, duplicate names, non-strict mode, missing directory, localized payloads for roots/subcommands/shared options/choices |
| `moduleLoader.test.js` | dependency ordering, **cycle detection**, unknown dependency, phase ordering, failing-module isolation, reverse-order shutdown, real `core` module boot |
| `settingsService.test.js` | defaults, cache hits, invalidation, resets, **degraded mode with zero DB queries**, user settings, module toggles, override precedence |
| `format.test.js` | duration formatting + unit caps, locale number formats, byte sizes, Discord timestamps, RTL marks, chunking, markdown escaping, embed truncation |
| `templates.test.js` | `{placeholder}` template rendering, missing-key behaviour, strict vs. lenient modes, length caps |
| `welcomeService.test.js` | welcome/goodbye rendering, auto roles, rejoin detection, degraded mode |
| `boosterService.test.js` | boost detection from `premiumSince` diffs, announcements, milestone math, `monthsBetween`, duration formatting |
| `loggingService.test.js` | channel resolution, payload shaping, delivery failures, filtering, metric accounting |
| `loggingEvents.test.js` | each logging event handler's mapping of a Discord payload to a log entry |
| `permissionService.test.js` | `has`, `highestPosition`, `canModerate` verdicts (self/owner/hierarchy), `assertCan` i18n routing, `canManageRole` |
| `moderationService.test.js` | validation **before** any Discord call, ban/kick/timeout/warn/purge/slowmode, case numbering, degraded mode still acting |
| `automodService.test.js` | every rule's matching, ranked actions, sliding-window spam counting, whitelist, **stateless preview mode**, word-boundary + regex escaping |
| `tempVoiceService.test.js` | create-on-join, name templates, **rollback when the move fails**, grace-period cleanup, `reconcile`, lock/unlock override semantics, ownership transfer |
| `ticketService.test.js` | open/claim/close/rate, **atomic claim guards**, transcript building, secret redaction in transcripts, participant overwrites, priority, stats, reconcile |

### Integration (`tests/integration/`)

| File | Covers |
|---|---|
| `api.test.js` | real HTTP against the Express app: `/health`, `/health/live`, `/health/ready` (503 on critical failure), check timeouts, `/api/v1/*`, `/metrics`, security headers, CORS allow-list, preflight, structured 404, body-size rejection, rate limiting |
| `interaction.test.js` | the **real** interaction handler with a fake interaction: `/ping` `/uptime` `/help` `/language` in English, Indonesian and Arabic; the category select menu; localized permission and cooldown errors; stack-trace leakage; module gating |
| `locales.test.js` | key parity, orphan keys, placeholder contracts, plural fallback keys, RTL/Discord-code invariants, "not just a copy of English", and builder↔`en-US` description sync |
| `welcome.test.js` | the **real** client boot (`initialize({ connectDatabase, loadEvents })`) with welcome enabled: join/leave events, role assignment, config writes |
| `mod.test.js` | every `/mod` subcommand against the real interaction handler: permission refusals, hierarchy guards, localized errors, cooldown resets |
| `automod.test.js` | `/automod` configuration round-trips through `settingsService`, rule edits, whitelist, and the `/automod test` preview |

### Scripts as gates

- `npm run locales:verify` — exit 1 on any parity/constraint problem.
- `npm run deploy:commands:dry` — validates the exact registration payload (including every localized
  name and option) **without calling Discord**, so CI and Termux pre-flight can check it offline.
- `npm run doctor` — 28 environment checks, exit 1 on failure.

---

## Testing without Discord or MongoDB

The suite never needs network access:

- **No gateway**: `tests/helpers/fakeInteraction.js` models exactly the interaction surface the
  production code touches. Anything new the handler starts using throws loudly instead of returning
  `undefined` silently.
- **No MongoDB**: `settingsService` takes injected models; the tests use an in-memory fake that logs
  every query, which is how "no query may be issued while offline" is proven.
- **No Discord API**: `--dry-run` builds and validates the payload locally.

This is deliberate. A test that requires credentials is a test nobody runs.

---

## Bugs the suite actually caught

These were found by writing the tests, not by review — each one was a real defect:

| Defect | Found by |
|---|---|
| `new XxxFamilyClient()` threw `TypeError: Cannot set property readyAt` (discord.js defines it as getter-only) — the bot could not start at all | `interaction.test.js` |
| Every command failed to load: `SlashCommandBuilder.toJSON()` requires a description | `npm run doctor` |
| `ENABLED_LOCALES` collapsed to a single locale — `.default()` wrapped around `.transform()` short-circuits it in Zod 4 | `config.test.js` |
| `ModuleManager.status()` returned `[]` for programmatically registered modules (read a stale `bootOrder`) | `moduleLoader.test.js` |
| `escapeMarkdown` did not escape `@`, so `@everyone` in user text would ping | `format.test.js` |
| Missing-key telemetry never fired (i18next only calls `missingKeyHandler` when `saveMissing` is on) | `i18n.test.js` |
| `LocaleService` held its own settings reference, making locale resolution untestable | `interaction.test.js` |
| Arabic `availableCount` had no plain fallback key | `locales:verify` |
| The deploy validator's duplicated regex wrongly rejected valid Japanese/Korean names | `deploy:commands:dry` |

## Writing a new test

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('describes the behaviour, not the implementation', async () => {
  assert.equal(actual, expected);
});
```

Conventions:

- Prefer `assert/strict`.
- Name the test after the behaviour a user would notice.
- For interaction code, use `createFakeInteraction()` and assert on `interaction.__calls.reply[0]`.
- If a test needs MongoDB or Discord, it belongs in a separate, clearly-labelled suite — not in the
  default run.
