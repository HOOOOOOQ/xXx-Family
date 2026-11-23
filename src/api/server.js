/**
 * src/api/server.js
 * ---------------------------------------------------------------------------
 * Express application factory.
 *
 * `createApp()` is pure — it never calls `listen()`. That is what lets the test
 * suite start the real API on an ephemeral port and hit it over HTTP, and lets
 * `src/api/standalone.js` run the API without the Discord gateway.
 */

import express from 'express';

import { BRAND } from '../config/constants.js';
import { getConfig } from '../config/index.js';
import { healthService } from '../services/healthService.js';
import { metrics } from '../services/metrics.js';

import { securityHeaders } from '../middleware/http/securityHeaders.js';
import { cors } from '../middleware/http/cors.js';
import { requestLogger } from '../middleware/http/requestLogger.js';
import { errorHandler, notFoundHandler } from '../middleware/http/errorHandler.js';
import { rateLimitMiddleware } from '../middleware/rateLimiter.js';

import { createHealthRouter } from './routes/health.js';
import { createStatusRouter } from './routes/status.js';

/**
 * @param {object} [deps]
 * @param {import('../bot/client.js').XxxFamilyClient|null} [deps.client]
 * @param {ReturnType<typeof getConfig>} [deps.config]
 * @param {import('../services/healthService.js').HealthService} [deps.health]
 * @returns {import('express').Express}
 */
export function createApp(deps = {}) {
  const config = deps.config ?? getConfig();
  const client = deps.client ?? null;
  const health = deps.health ?? healthService;

  const app = express();
  app.disable('x-powered-by');
  // Behind the Arena/Termux proxy the real client IP is in X-Forwarded-For.
  app.set('trust proxy', 1);

  app.use(securityHeaders({ corsOrigins: config.api.corsOrigins }));
  app.use(cors(config.api.corsOrigins));
  app.use(requestLogger());
  app.use(express.json({ limit: '256kb' }));
  app.use(
    express.urlencoded({
      extended: false,
      limit: '256kb',
    }),
  );

  // Public landing payload.
  app.get('/', (req, res) => {
    res.json({
      name: BRAND.name,
      tagline: BRAND.tagline,
      version: BRAND.version,
      edition: BRAND.edition,
      endpoints: ['/health', '/health/live', '/health/ready', '/metrics', '/api/v1/status', '/api/v1/locales', '/api/v1/commands'],
      dashboard: config.api.dashboardUrl,
      timestamp: new Date().toISOString(),
    });
  });

  app.use(createHealthRouter({ health }));

  app.get('/metrics', (req, res) => {
    res.json({
      ...metrics.snapshot(),
      cache: client?.cacheStore?.stats?.() ?? null,
      memory: {
        rssMb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
        heapUsedMb: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10,
      },
    });
  });

  // Slightly tighter limit on the API surface the dashboard will hammer.
  app.use(
    '/api',
    rateLimitMiddleware({
      capacity: 120,
      refillMs: 60_000,
      keyFor: (req) => `${req.ip ?? 'unknown'}`,
    }),
  );
  app.use(createStatusRouter({ client, config }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Start the HTTP server. Binds 0.0.0.0 so it is reachable from the browser and
 * from Termux's localhost forwarding.
 *
 * @param {object} [deps] same as {@link createApp}, plus:
 * @param {number} [deps.port]
 * @param {string} [deps.host]
 * @returns {Promise<{ app:import('express').Express, server:import('http').Server, port:number, url:string }>}
 */
export async function startApiServer(deps = {}) {
  const config = deps.config ?? getConfig();
  const app = createApp(deps);
  const port = deps.port ?? config.api.port;
  const host = deps.host ?? config.api.host;

  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(port, host, () => resolve(instance));
    instance.on('error', reject);
  });

  return {
    app,
    server,
    port,
    url: `http://${host}:${port}`,
    /** @returns {Promise<void>} */
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export default createApp;
