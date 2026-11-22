# 04 — Internationalization

This is the system the whole product is built around. It is **not** runtime string translation: every
user-visible string is a key in a structured JSON file, per locale, per namespace.

```
src/locales/
├── en-US/  ├── en-GB/  ├── id-ID/  ├── es-ES/  ├── pt-BR/
├── fr-FR/  ├── de-DE/  ├── ja-JP/  ├── ko-KR/  └── ar/
     └── common.json     shared labels, status words, field names, time units
     └── commands.json   command names, descriptions, option names, response text
     └── errors.json     every error a user can see
     └── components.json buttons, select menus, modals
```

40 files, ~147 keys per locale. English is the reference; the QA gate enforces parity.

---

## Two code systems — do not mix them

| Internal code | Discord API code | Notes |
|---|---|---|
| `en-US` | `en-US` | |
| `en-GB` | `en-GB` | |
| `id-ID` | **`id`** | Discord uses `id`, not `id-ID` |
| `es-ES` | `es-ES` | |
| `pt-BR` | `pt-BR` | |
| `fr-FR` | `fr` | |
| `de-DE` | `de` | |
| `ja-JP` | `ja` | |
| `ko-KR` | `ko` | |
| `ar` | **none** | Discord does not accept Arabic in `name_localizations` |

Discord supports exactly 32 locales for command localization (verified against
`Object.values(Locale)` in discord.js 14.28.1). Sending an unsupported code makes Discord reject the
**entire** registration payload — so `commandLocalizations()` maps our codes and silently skips the
unsupported ones. Arabic still gets fully translated messages, embeds, buttons and modals; only the
slash-command *name* stays in the default language.

`fromDiscordLocale()` converts incoming `interaction.locale` / `interaction.guildLocale` to internal
codes, including loose matches (`en-AU` → `en-US`, `es-419` → `es-ES`). Unknown locales return `null`
and fall through the chain.

## Resolution order

`LocaleService.resolveForInteraction()` (see `src/services/localeService.js`):

1. a channel/role/module **override** (`LanguageOverride` collection)
2. the member's **stored preference** (`/language set`)
3. the member's **Discord client locale**
4. the **guild's configured default** (`/language server`)
5. the guild's Discord community locale
6. `DEFAULT_LANGUAGE`, then `en-US`

The result is `{ locale, source, dir, t }`. `source` is rendered back to the user by
`/language user` so a moderator can see *why* a member is seeing Japanese.

Every reply-producing path uses the returned bound translator `t`. Because it is pinned to one locale,
a single message can never mix languages — asserted by
`tests/integration/interaction.test.js` ("must not mix languages").

## Adding a locale

1. Register it in `src/config/locales.js`:
   ```js
   { code: 'vi-VN', name: 'Vietnamese', nativeName: 'Tiếng Việt', discord: 'vi', flag: '🇻🇳', rtl: false, primary: false }
   ```
   Set `discord: null` if Discord does not support it.
2. Copy the four namespace files:
   ```bash
   cp -r src/locales/en-US src/locales/vi-VN
   ```
3. Translate **every** value. The QA gate rejects missing keys, orphan keys and unknown placeholders.
4. Verify:
   ```bash
   npm run locales:verify
   npm test
   ```

That is all — commands, embeds, buttons, errors and the API pick it up automatically.

## Translation rules

1. **Never concatenate.** `t('common:time.days', { count: 3 })`, not `` `${days} days` ``. Word order
   and unit words differ per language.
2. **Plurals use ICU-ish suffixes.** Provide `_other` at minimum, plus the plain key as the fallback.
   Arabic needs `_zero _one _two _few _many _other`; Japanese and Korean only need `_other`.
3. **Interpolation names are a contract.** `{{user}}`, `{{language}}`, `{{seconds}}` must exist in the
   locales that use them. Introducing a *new* placeholder is a QA failure; omitting one is allowed
   (Arabic's singular form grammatically drops the numeral).
4. **Keep command names short.** Discord: 1–32 chars, no spaces, no uppercase for the default name.
   Localized names may use any Unicode letter (`bahasa`, `idioma`, `げんご`, `언어`).
5. **Descriptions ≤ 100 chars.** Enforced by the gate for all 10 locales.
6. **Keep the builder in sync with `en-US`.** `SlashCommandBuilder` requires a description, so the
   canonical English text lives in the builder *and* in `en-US/commands.json`. A drift test
   (`tests/integration/locales.test.js`) fails if they diverge.

## Writing a localized embed

```js
import { brandEmbed } from '../../utils/embeds.js';

await interaction.reply({
  embeds: [
    brandEmbed({
      t: ctx.t,
      dir: ctx.dir,                       // 'rtl' prefixes an RLM so Arabic renders correctly
      variant: 'success',                 // default | success | error | warning | info | neutral
      title: ctx.t('common:language.title'),
      description: ctx.t('common:language.updatedPersonal', { language: 'Bahasa Indonesia' }),
      fields: [{ name: ctx.t('common:language.source'), value: ctx.t('common:language.sourceUser') }],
    }),
  ],
});
```

`brandEmbed` enforces the Premium Cyberpunk palette, truncates to Discord's limits (256 / 4096 / 1024 /
25 fields) and applies the footer from `common:footer.poweredBy`.

## Localized components

```js
new StringSelectMenuBuilder()
  .setCustomId('language:select:user')
  .setPlaceholder(t('components:selects.languagePlaceholder'))
  .addOptions(LOCALES.map((l) => ({
    label: `${l.flag} ${l.nativeName}`,     // language pickers always show native names
    value: l.code,
    description: `${l.name} • ${l.code}`,
  })));
```

Labels, placeholders, buttons and modal text all come from `components.json`.

## Runtime telemetry

Missing keys are recorded per locale (`saveMissing` is on with no backend attached, so nothing is
written anywhere) and exposed on `/health`:

```json
"i18n": { "status": "ok", "localeCount": 10, "missingKeys": 0 }
```

A non-zero number means some code path asked for a key the locale files do not define — fix the key or
add the translation. The static gate (`npm run locales:verify`) catches the same class of problem
before it ever ships.
