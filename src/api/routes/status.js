/**
 * src/api/routes/status.js
 * ---------------------------------------------------------------------------
 * Read-only status endpoints consumed by the dashboard (Phase 8) and by
 * `scripts/health-check.js`.
 *
 * Only non-sensitive data is exposed: no tokens, no secrets, no member data.
 */

import { Router } from 'express';

import { BRAND } from '../../config/constants.js';
import { LOCALES } from '../../config/locales.js';
import { getLoadedLocales } from '../../services/i18nService.js';

/**
 * @param {object} deps
 * @param {import('../../bot/client.js').XxxFamilyClient|null} [deps.client]
 */
export function createStatusRouter({ client = null, config = null } = {}) {
  const router = Router();

  router.get('/api/v1/status', (req, res) => {
    const loaded = getLoadedLocales();
    res.json({
      bot: {
        name: BRAND.name,
        version: BRAND.version,
        edition: BRAND.edition,
        tagline: BRAND.tagline,
        online: client?.isReady?.() ?? false,
        user: client?.user ? { id: client.user.id, username: client.user.username } : null,
        guilds: client?.guilds?.cache?.size ?? 0,
        commands: client?.commands?.size ?? 0,
        modules: client?.modules?.status?.() ?? [],
        shard: client?.shard?.ids?.[0] ?? 0,
        uptimeMs: client?.bootedAt ? Date.now() - client.bootedAt.getTime() : null,
      },
      i18n: {
        defaultLocale: config?.i18n?.defaultLocale ?? null,
        loadedLocales: loaded,
        localeCount: loaded.length,
      },
      api: { version: '1.0.0', timestamp: new Date().toISOString() },
    });
  });

  router.get('/api/v1/locales', (req, res) => {
    const loaded = new Set(getLoadedLocales());
    res.json({
      locales: LOCALES.map((locale) => ({
        code: locale.code,
        name: locale.name,
        nativeName: locale.nativeName,
        flag: locale.flag,
        rtl: locale.rtl,
        primary: locale.primary,
        discordCode: locale.discord,
        loaded: loaded.has(locale.code),
      })),
    });
  });

  router.get('/api/v1/commands', (req, res) => {
    const commands = [...(client?.commands?.values?.() ?? [])].map((command) => ({
      name: command.name,
      category: command.category,
      cooldownMs: command.cooldown,
      guildOnly: command.guildOnly,
      ownerOnly: command.ownerOnly,
      userPermissions: command.userPermissions,
    }));
    res.json({ count: commands.length, commands });
  });

  return router;
}

export default createStatusRouter;
