/**
 * src/api/routes/health.js
 * ---------------------------------------------------------------------------
 * Liveness / readiness / full health.
 *
 *   GET /health        full report (503 when a critical check fails)
 *   GET /health/live   process alive — always 200 if we can answer
 *   GET /health/ready  ready to serve — what Termux/PM2/a proxy should gate on
 */

import { Router } from 'express';

/** @param {object} deps @param {import('../../services/healthService.js').HealthService} deps.health */
export function createHealthRouter({ health }) {
  const router = Router();

  router.get('/health', async (req, res, next) => {
    try {
      const report = await health.run();
      res.status(report.ready ? 200 : 503).json(report);
    } catch (err) {
      next(err);
    }
  });

  router.get('/health/live', (req, res) => {
    res.json({ status: 'alive', uptimeMs: Math.round(process.uptime() * 1000), pid: process.pid });
  });

  router.get('/health/ready', async (req, res, next) => {
    try {
      const report = await health.run({ deep: false });
      res.status(report.ready ? 200 : 503).json({
        status: report.status,
        ready: report.ready,
        checks: report.checks,
        timestamp: report.timestamp,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default createHealthRouter;
