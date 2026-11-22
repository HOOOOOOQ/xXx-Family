# 02 — Configuration

Every setting is an environment variable, loaded and validated in **one** place
(`src/config/index.js`). Nothing reads `process.env` directly — so an invalid value fails at boot with
an actionable message instead of breaking later.

```bash
cp .env.example .env
```

---

## 1. Discord Developer Portal

1. Go to <https://discord.com/developers/applications> → **New Application** → name it `xXx Family`.
2. **General Information** → copy the **Application ID** → `DISCORD_CLIENT_ID`.
3. **Bot** → **Reset Token** → copy → `DISCORD_TOKEN`.
4. **Bot → Privileged Gateway Intents** — enable:
   - `SERVER MEMBERS INTENT` (welcome/goodbye, member cards, role assignment)
   - `MESSAGE CONTENT INTENT` (automod, tags, anti-spam, AI context)
   - `PRESENCE INTENT` only if you later need activity-based features
5. **OAuth2** → copy the **Client Secret** → `DISCORD_CLIENT_SECRET`.
6. **OAuth2 → Redirects** → add exactly:
   ```
   http://localhost:3000/api/auth/callback
   ```
   and the same URL for your production dashboard. Then set `DISCORD_REDIRECT_URI` to the identical
   string — a trailing slash mismatch is the #1 cause of `redirect_uri_mismatch`.
7. **Installation / OAuth2 URL generator** — scopes `bot applications.commands`, permissions:

   | Permission | Needed for |
   |---|---|
   | View Channels, Send Messages, Embed Links, Attach Files | everything |
   | Read Message History | transcripts, logging |
   | Manage Roles | auto roles, member cards, ticket roles |
   | Manage Channels | temporary voice, ticket channels |
   | Kick Members, Ban Members, Moderate Members | moderation (Phase 3) |
   | Manage Messages | purge, automod |
   | Manage Threads | tickets |
   | Create Instant Invite | invite tracking |
   | Manage Events | events, giveaways |
   | Connect, Speak, Mute Members, Move Members, Deafen Members | temporary voice, music |
   | Use External Emojis, Add Reactions | games, giveaways |
   | Manage Webhooks | welcome/goodbye, logging |

   > Permission requirements are already enforced by `enforceCommandGuards()` in
   > `src/middleware/cooldownManager.js` (member permissions, bot permissions, Administrator bypass).
   > **Role-hierarchy checks are not implemented yet** — they arrive with the moderation module in
   > Phase 3.

## 2. MongoDB Atlas

No local MongoDB server is required — and none is supported.

1. <https://cloud.mongodb.com> → create a free **M0** cluster.
2. **Database Access** → add a user with `Read and write to any database`.
3. **Network Access** → add your IP, or `0.0.0.0/0` for a phone on a mobile network (see the security
   note below).
4. **Connect → Drivers** → copy the SRV string and set:
   ```ini
   MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/xxxfamily?retryWrites=true&w=majority
   ```
   URL-encode special characters in the password (`@` → `%40`, `#` → `%23`).

Verify with `npm run db:check` — it pings the server, syncs indexes and lists collections.

**Security:** `0.0.0.0/0` means anyone with the credentials can connect. On a phone with a changing IP
it is often the only practical option; compensate with a strong, unique password and a dedicated Atlas
user. Atlas also supports IP access lists per project, so rotate them if you can.

**Backup:** Atlas free tier keeps continuous backups for 2 days. For anything you care about, enable a
scheduled snapshot or export with `mongodump` before schema migrations.

## 3. Variable reference

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DISCORD_TOKEN` | production | — | Bot token. Never commit. |
| `DISCORD_CLIENT_ID` | for deploying commands | — | Application ID |
| `DISCORD_CLIENT_SECRET` | Phase 8 | — | OAuth2 client secret |
| `DISCORD_REDIRECT_URI` | Phase 8 | `http://localhost:3000/api/auth/callback` | Must match the portal exactly |
| `DEPLOY_GUILD_ID` | no | *(global)* | Snowflake → instant guild-scoped registration |
| `MONGODB_URI` | recommended | — | Atlas SRV string. Absent ⇒ degraded mode |
| `SESSION_SECRET` | Phase 8 | — | 64+ random chars. See generator below |
| `DASHBOARD_URL` | no | `http://localhost:3000` | Public dashboard URL |
| `API_BASE_URL` | no | `http://localhost:4000` | Public API URL |
| `PORT` | no | `4000` | API port |
| `HOST` | no | `0.0.0.0` | Bind address. Keep `0.0.0.0` for previews/Termux |
| `NODE_ENV` | no | `development` | `development` \| `production` \| `test` |
| `DEFAULT_LANGUAGE` | no | `en-US` | Final fallback locale |
| `ENABLED_LOCALES` | no | *all 10* | Comma-separated subset, e.g. `id-ID,en-US` |
| `AI_PROVIDER` | Phase 6 | — | Reserved |
| `AI_API_KEY` | Phase 6 | — | Reserved |
| `LOG_LEVEL` | no | `info` | `trace` `debug` `info` `warn` `error` `fatal` `silent` |
| `LOG_FORMAT` | no | `pretty` | `pretty` \| `json` |
| `OWNER_IDS` | no | — | Comma-separated snowflakes allowed to run owner-only commands |
| `CORS_ORIGINS` | no | `DASHBOARD_URL` | Comma-separated browser origins allowed to call the API |
| `ENABLE_API` | no | `true` | Set `false` to run the gateway only |
| `SHUTDOWN_TIMEOUT_MS` | no | `10000` | Hard deadline before a forced exit |

Generate a session secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### Production behaviour

With `NODE_ENV=production` the config validator lists what is missing
(`DISCORD_TOKEN`, `MONGODB_URI`, `SESSION_SECRET`) and `src/bot/index.js` **refuses to start** rather
than booting half-configured. In development the same problems are logged as errors and the bot
continues, so you can work on one piece at a time.

## 4. What the validator rejects

These all fail at boot with a specific message — verified by `tests/unit/config.test.js`:

- `DEFAULT_LANGUAGE=xx-XX` → *"DEFAULT_LANGUAGE must be one of en-US, en-GB, id-ID, …"*
- `ENABLED_LOCALES=en-US,xx-XX` → *"ENABLED_LOCALES contains an unsupported locale"*
- `PORT=not-a-port`, `PORT=70000`
- `DEPLOY_GUILD_ID=my-server` (must be a snowflake)

## 5. Secrets handling

- `.env` is in `.gitignore`; `.env.example` ships with empty values.
- At boot, `initConfig()` registers the token, client secret, session secret, AI key and the Atlas
  password with the redactor (`src/utils/redact.js`). Any of those strings appearing anywhere in a log
  line — including inside an error message — is replaced with `[REDACTED]`.
- Object keys that look like credentials (`token`, `password`, `authorization`, `cookie`, …) are
  redacted regardless of value.
- API error responses never include a stack trace or a server-side message for 5xx errors.

Test it yourself:

```bash
LOG_LEVEL=debug node -e "
import('./src/utils/logger.js').then(async ({ Logger, registerSecret }) => {
  registerSecret('MTAxMjM0NTY3ODkw.secret.value');
  new Logger({ name: 'demo', level: 'debug' }).info('boot', {
    token: 'MTAxMjM0NTY3ODkw.secret.value',
    uri: 'mongodb+srv://bot:hunter2@cluster.example.net/db',
    author: 'ada',
  });
});
"
```

## 6. Language configuration

`DEFAULT_LANGUAGE` is the **last** fallback, not the default everyone sees. Resolution order:

1. the member's stored preference (`/language set`)
2. the member's Discord client locale
3. the guild's configured default (`/language server`)
4. the guild's Discord community locale
5. `DEFAULT_LANGUAGE`, then `en-US`

Per-channel and per-module overrides live in the `LanguageOverride` collection (an `#indonesia` channel
inside an English server, for example). Details:
[04-internationalization.md](04-internationalization.md).
