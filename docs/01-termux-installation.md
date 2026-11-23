# 01 — Termux installation (Android)

xXx Family runs on Android through [Termux](https://termux.dev) without a local MongoDB server: all
data lives in MongoDB Atlas, so the phone only needs Node.js.

---

## 1. Install Termux

Install Termux **from F-Droid or GitHub**, not from the Play Store — the Play Store build is outdated
and its package repositories no longer update.

```bash
pkg update && pkg upgrade -y
pkg install -y nodejs-lts git python nano
```

Verify:

```bash
node -v        # >= 20.x  (LTS)
npm -v
git --version
```

> **Why Python?** `node-gyp` needs it if a native module ever has to compile. xXx Family itself has no
> native dependencies, so this is only insurance.

### Optional: keep the process alive

Android kills background processes aggressively.

```bash
pkg install -y termux-services
termux-wake-lock          # prevents deep sleep while the bot runs
```

## 2. Get the code

```bash
cd ~
git clone https://github.com/HOOOOOOQ/xXx-Family.git
cd xXx-Family
npm install --no-audit --no-fund
```

If `npm install` is slow, that is normal on a phone. Use `--no-audit --no-fund` to skip the extra
network round-trips.

## 3. Configure

```bash
cp .env.example .env
nano .env
```

Fill in at minimum:

```ini
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/xxxfamily
DEFAULT_LANGUAGE=id-ID
```

Full reference: [02-configuration.md](02-configuration.md).

`.env` is git-ignored. Never commit it, never paste it into a chat.

## 4. Pre-flight check

```bash
npm run doctor
```

Expected output on a fresh install:

```
  ✓ Node.js version        v22.x.x (>= 20 required)
  ✓ Platform               android arm64 — Termux reports "android"/"linux"
  ✓ package:discord.js     14.28.1
  ...
  ✓ .env file              /data/data/com.termux/files/home/xXx-Family/.env
  ✓ DISCORD_TOKEN          set (70 chars)
  ✓ MONGODB_URI            set (host: cluster0.xxxxx.mongodb.net)
  ✓ locale:en-US           4/4 namespaces
  ...
  28 checks — 0 failing, 0 warnings
```

Anything marked `✗` must be fixed before starting. Warnings (`!`) are survivable but mean a feature is
disabled — for example no `MONGODB_URI` means settings will not be saved.

Then verify Atlas connectivity:

```bash
npm run db:check
```

If this fails, the phone's IP is almost certainly not allowed in Atlas. See
[06-troubleshooting.md](06-troubleshooting.md#mongodb).

## 5. Register slash commands

```bash
# Validate the payload offline first — no API call, prints what would be sent:
npm run deploy:commands:dry

# Instant registration to one guild (best while testing):
DEPLOY_GUILD_ID=123456789012345678 npm run deploy:commands:guild

# Global registration (can take up to an hour to appear everywhere):
npm run deploy:commands
```

## 6. Run

Foreground (see logs directly):

```bash
npm start
```

Background with `nohup`:

```bash
mkdir -p logs
nohup npm start > logs/bot.log 2>&1 &
echo $! > logs/bot.pid
```

Check health from another Termux session:

```bash
npm run health
# or
curl -s http://127.0.0.1:4000/health
```

Stop it:

```bash
kill -TERM "$(cat logs/bot.pid)"
```

The bot shuts down gracefully: modules stop, the gateway closes, MongoDB disconnects, then the process
exits 0. A hard deadline (`SHUTDOWN_TIMEOUT_MS`, default 10 s) forces an exit if anything hangs.

### Auto-restart loop

A minimal watchdog — no extra packages needed:

```bash
cat > run-forever.sh <<'SH'
#!/data/data/com.termux/files/usr/bin/bash
cd "$(dirname "$0")"
while true; do
  echo "[$(date -Is)] starting bot"
  node src/bot/index.js
  code=$?
  echo "[$(date -Is)] exited with $code, restarting in 5s"
  [ "$code" = "0" ] && break          # clean shutdown = stay down
  sleep 5
done
SH
chmod +x run-forever.sh
./run-forever.sh
```

For a proper supervisor, `pkg install pm2` also works:

```bash
npm install -g pm2
pm2 start src/bot/index.js --name xxx-family
pm2 save
```

## 7. Running the dashboard later (Phase 8)

The Next.js dashboard will be a separate process on port 3000:

```bash
npm run start:api     # Express API only, port 4000
# later: cd dashboard && npm run dev
```

Both must run for OAuth2 login to work, and `DASHBOARD_URL` / `API_BASE_URL` / `DISCORD_REDIRECT_URI`
must match exactly what is registered in the Discord Developer Portal.

---

## Termux-specific gotchas

| Symptom | Cause | Fix |
|---|---|---|
| Bot dies when the screen turns off | Android doze | `termux-wake-lock`, disable battery optimisation for Termux |
| `EACCES` on `npm install -g` | Global prefix is root-owned | `npm config set prefix ~/.npm-global` and add it to `PATH` |
| Bot stops after a few minutes | Termux killed the process | Use the watchdog script or `pm2` |
| `getaddrinfo EAI_AGAIN` | No DNS / mobile network flap | Retry; check `ping 8.8.8.8` |
| Port already in use | A previous instance is alive | `pkill -f "src/bot/index.js"` or change `PORT` |
| Very slow first start | Cold npm cache / low RAM | Normal. Check `/metrics` `memory.rssMb` |

## Resource expectations

On a mid-range phone the running bot sits around **100–130 MB RSS** with 5 commands and one module
(measured: `rssMb: 121.7` on `/health`). Each later phase adds modules; watch `/metrics` after Phase 5
(economy/XP) and Phase 7 (music), which are the heaviest.
