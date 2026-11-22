import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'));

/**
 * Brand + visual identity. "Premium Cyberpunk": black canvas, purple neon,
 * silver accents. Every embed, card and dashboard surface reads from here so
 * the identity can never drift between modules.
 */
export const BRAND = Object.freeze({
  name: pkg.name === 'xxx-family' ? 'xXx Family' : pkg.name,
  package: pkg.name,
  version: pkg.version,
  tagline: 'International Community Ecosystem',
  edition: 'Premium Cyberpunk Edition',
  footer: 'xXx Family • International Community Ecosystem',
});

/**
 * Cyberpunk palette. `neon` is the signature purple, `silver` the metallic
 * accent, `void` the black background used by the dashboard and rank cards.
 */
export const COLORS = Object.freeze({
  neon: 0xa855f7, // purple neon
  neonDeep: 0x7c3aed,
  neonSoft: 0xc084fc,
  silver: 0xc0c6d4,
  silverDim: 0x8b93a7,
  void: 0x0a0a0f,
  voidSoft: 0x12121c,
  cyan: 0x22d3ee,
  success: 0x22c55e,
  warning: 0xf59e0b,
  danger: 0xef4444,
  info: 0x38bdf8,
});

/** Semantic embed colours. */
export const EMBED_COLORS = Object.freeze({
  default: COLORS.neon,
  success: COLORS.success,
  error: COLORS.danger,
  warning: COLORS.warning,
  info: COLORS.info,
  neutral: COLORS.silver,
});

/** Default bot presence (overridable per guild later via GuildSettings). */
export const DEFAULT_PRESENCE = Object.freeze({
  status: 'online',
  activities: [{ name: '/help • xXx Family', type: 3 /* Watching */ }],
});

/** Hard limits we enforce ourselves before Discord has to reject a payload. */
export const LIMITS = Object.freeze({
  embedDescription: 4096,
  embedTitle: 256,
  embedFields: 25,
  messageContent: 2000,
  embedTotal: 6000,
  componentLabel: 80,
  selectOptions: 25,
});

/** Cooldown defaults (ms) applied when a command does not declare its own. */
export const DEFAULT_COOLDOWNS = Object.freeze({
  normal: 3_000,
  elevated: 1_500,
  heavy: 10_000,
});
