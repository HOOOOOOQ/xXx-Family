/**
 * src/middleware/http/requestLogger.js — one structured line per request.
 */

import { getLogger } from '../../utils/logger.js';

export function requestLogger() {
  const logger = getLogger().child('http');

  return function requestLoggerMiddleware(req, res, next) {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Math.round((Number(process.hrtime.bigint() - started) / 1e6) * 100) / 100;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
      logger[level]('request', {
        method: req.method,
        path: req.originalUrl ?? req.url,
        status: res.statusCode,
        durationMs,
        ip: req.ip,
      });
    });
    next();
  };
}

export default requestLogger;
