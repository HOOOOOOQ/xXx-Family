/**
 * src/middleware/http/errorHandler.js
 * ---------------------------------------------------------------------------
 * Terminal Express error handler.
 *
 * The response body never contains a stack trace, a Mongo error string or a
 * secret: only the error code, a safe message and the translation key the
 * dashboard should render.
 */

import { getLogger } from '../../utils/logger.js';
import { isAppError, normalizeError } from '../../utils/errors.js';

/** 404 for unknown API routes. */
export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'ERR_NOT_FOUND', message: `Route ${req.method} ${req.path} does not exist`, i18nKey: 'errors:notFound' },
  });
}

/** eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity */
export function errorHandler(err, req, res, next) {
  const logger = getLogger().child('http-error');
  const normalized = normalizeError(err);

  logger.errorFrom(err, 'API request failed', {
    method: req.method,
    path: req.originalUrl ?? req.url,
    code: normalized.code,
    statusCode: normalized.statusCode,
    ip: req.ip,
  });

  const statusCode = Number.isInteger(normalized.statusCode) ? normalized.statusCode : 500;
  res.status(statusCode).json({
    error: {
      code: normalized.code,
      message: isAppError(err) && err.expose ? err.message : 'Internal server error',
      i18nKey: normalized.i18nKey,
      ...(isAppError(err) && err.details ? { details: err.details } : {}),
    },
  });
}

export default errorHandler;
