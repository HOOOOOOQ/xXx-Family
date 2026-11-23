# 06 — Troubleshooting

Start with the two gates — they answer most questions without any guessing:

```bash
npm run doctor        # environment, dependencies, locales, loaders
npm run health        # live report from a running instance
```

`/health` tells you *why* it is degraded:

```json
{ "status": "degraded", "ready": true,
  "checks": { "database": { "status": "unconfigured" }, "discord": { "status": "degraded", "ready": false } } }
```

---

## Startup

### `Invalid environment configuration: …`

The validator rejects the environment before anything starts. The message names the variable:

```
• DEFAULT_LANGUAGE: DEFAULT_LANGUAGE must be one of en-US, en-GB, id-ID, es-ES, pt-BR, fr-FR, de-DE, ja-JP, ko-KR, ar
```

Common causes: a stray space or quote in `.env`, `ENABLED_LOCALES=Indonesian` instead of `id-ID`.

### `Refusing to start in production with missing configuration`

`NODE_ENV=production` requires `DISCORD_TOKEN`, `MONGODB_URI` and `SESSION_SECRET`. Either set them or
use `NODE_ENV=development` while working.

### `DISCORD_TOKEN is not set — the API is up but the bot is not connected`

Deliberate behaviour: the HTTP API still serves so the dashboard can be developed. Set `DISCORD_TOKEN`
to connect the gateway.

### `Used disallowed intents`

The bot requests privileged intents (`GuildMembers`, `MessageContent`, …). Enable them under
**Bot → Privileged Gateway Intents** in the Developer Portal, then restart.

### Bot connects but slash commands do not appear

1. Did you run `npm run deploy:commands`? Registration is separate from running the bot.
2. Global registration can take **up to an hour**. Use guild registration for instant feedback:
   ```bash
   DEPLOY_GUILD_ID=123456789012345678 npm run deploy:commands:guild
   ```
3. Was the bot invited with the `applications.commands` scope? Re-invite if not.
4. Check the payload is valid offline: `npm run deploy:commands:dry`.

### `Missing Access` / `Missing Permissions` on deploy

The token is for a bot that is not in that guild, or `DEPLOY_GUILD_ID` is wrong. Global registration
needs no guild membership.

---

## Database {#mongodb}

### `Cannot reach MongoDB` from `npm run db:check`

In order of likelihood:

1. **IP not allow-listed** in Atlas → Network Access → add your IP (or `0.0.0.0/0` on a mobile network).
2. **Wrong password / unescaped characters** — `@` must be `%40`, `#` must be `%23` in the URI.
3. **Cluster paused** — free M0 clusters sleep after 60 days of inactivity; resume it in Atlas.
4. **No DNS** — `ping 8.8.8.8` then `nslookup cluster0.xxxxx.mongodb.net`.

### The bot runs but `/language set` says it cannot save

That is degraded mode: no MongoDB connection, so writes are refused honestly instead of pretending to
succeed. `/health` will show `database.status` as `unconfigured`, `error` or `degraded`. Fix the URI and
restart — no data is lost because none was written.

### Settings seem to be ignored after a change

Settings are cached for up to 120 s. `/settings view` forces a refresh; restarting always works. Cache
statistics are on `/metrics` under `cache`.

---

## Runtime

### `EADDRINUSE: address already in use :::4000`

A previous instance is still alive.

```bash
pkill -f "src/bot/index.js"
# or use another port
PORT=4001 npm start
```

The bot logs this specifically and continues **without** the HTTP API rather than crashing, so the
gateway keeps serving.

### Commands work in English for a member who chose another language

Run `/language user` — it shows the applied locale **and its source**. Typical causes:

- the preference was saved while the database was offline (it was not saved at all)
- a channel or module override wins (`LanguageOverride` collection)
- the locale is not in `ENABLED_LOCALES`

### A command replies "This feature is currently under maintenance"

The guild disabled that command's category module. `/settings view` lists module states.

### Replies are correct but the text renders right-to-left wrongly

Arabic embeds are prefixed with a right-to-left mark by `brandEmbed({ dir })`. If you built an embed by
hand, pass `dir: ctx.dir`.

### The bot restarts on its own

`Events.Invalidated` (Discord dropped the session, usually after a token reset or a long network loss)
exits with code 1 so a process manager restarts it. The log line is
`Session invalidated by Discord — the client must restart`.

### Memory keeps growing

Check `/metrics` → `memory.rssMb` and `cache.size`. The settings cache is bounded (LRU, 10 000 entries);
if RSS grows without bound, it is a module leak — Phase 1's only module (`core`) clears its timer on
shutdown.

---

## Termux-specific

| Symptom | Fix |
|---|---|
| Bot dies when the screen locks | `termux-wake-lock`; disable battery optimisation for Termux |
| `npm install` fails with `EACCES` | `npm config set prefix ~/.npm-global`, add `~/.npm-global/bin` to `PATH` |
| `getaddrinfo EAI_AGAIN` | DNS flap on mobile data — retry, or switch network |
| Very high CPU at start | Cold npm cache on a phone; normal for the first run |
| `pm2` not found | `npm install -g pm2` after fixing the npm prefix |

---

## Getting useful logs

```bash
LOG_LEVEL=debug LOG_FORMAT=pretty npm start     # human readable, verbose
LOG_LEVEL=info  LOG_FORMAT=json   npm start     # machine parseable, one JSON object per line
```

Pipe JSON logs through `jq`:

```bash
LOG_FORMAT=json npm start 2>&1 | jq -c 'select(.level=="error")'
```

Secrets are redacted in every line, so logs are safe to share — but still check before posting.

---

## Reporting a problem

Include:

1. `npm run doctor` output
2. `curl -s http://127.0.0.1:4000/health | jq`
3. The last ~50 log lines with `LOG_LEVEL=debug`
4. Node version (`node -v`) and platform (`uname -a`)
