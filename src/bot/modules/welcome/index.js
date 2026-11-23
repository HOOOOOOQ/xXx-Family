/**
 * src/bot/modules/welcome/index.js
 * ---------------------------------------------------------------------------
 * The `welcome` module — the first feature module, and the pattern the later
 * ones follow.
 *
 * It owns very little on purpose. The behaviour lives in WelcomeService so it
 * can be unit tested without a gateway; this file only:
 *   - declares the module's identity, phase and dependencies
 *   - exposes a health probe (a module with no config in any guild is healthy,
 *     a module that cannot read its own collection is not)
 *   - counts what it does, so /metrics can show it is alive
 *
 * The events that trigger it (guildMemberAdd / guildMemberRemove) are loaded by
 * the event loader, not registered here — keeping events declarative means they
 * work whether or not the module boots, and the service itself refuses to act
 * when the guild has not enabled the feature.
 */

import { HEALTH_STATUS } from '../../../services/healthService.js';

let stats = { startedAt: null };

export default {
  name: 'welcome',
  version: '1.0.0',
  phase: 2,
  dependencies: ['core'],
  configKey: 'welcome',

  async init(ctx) {
    const { health, client } = ctx;

    health.register(
      'welcome',
      () => {
        // Nothing to probe when the module never started.
        if (!stats.startedAt) {
          return { status: HEALTH_STATUS.DEGRADED, ready: false, reason: 'not started' };
        }
        return {
          status: HEALTH_STATUS.OK,
          ready: true,
          rejoinEntries: client.welcome?.leaveTracker?.size ?? 0,
          since: stats.startedAt,
        };
      },
      // A broken welcome feature is not a reason to take the whole bot out of
      // rotation, so it is explicitly non-critical.
      { critical: false },
    );
  },

  async start(ctx) {
    stats = { startedAt: new Date().toISOString() };
    ctx.logger?.info('Welcome module started');
  },

  async stop(ctx) {
    stats = { startedAt: null };
    ctx.logger?.debug('Welcome module stopped');
  },
};

/** Exposed for tests. */
export function __welcomeStats() {
  return { ...stats };
}
