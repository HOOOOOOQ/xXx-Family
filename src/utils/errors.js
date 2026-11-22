/**
 * src/utils/errors.js
 * ---------------------------------------------------------------------------
 * Typed error hierarchy.
 *
 * Every error the ecosystem raises on purpose is an {@link AppError} carrying:
 *   - `code`       machine readable id (safe to log and to show in the UI)
 *   - `statusCode` HTTP status used by the API / dashboard
 *   - `i18nKey`    translation key so the *user* sees a localized message while
 *                  the log keeps the precise technical detail
 *   - `expose`     whether the raw message may be shown to an end user
 *
 * Unexpected errors stay plain `Error`s; helpers below classify them without
 * ever leaking stack traces or secrets to Discord or the dashboard.
 */

export class AppError extends Error {
  /**
   * @param {string} message Human readable, English, technical.
   * @param {object} [options]
   * @param {string} [options.code]
   * @param {number} [options.statusCode]
   * @param {string} [options.i18nKey]
   * @param {boolean} [options.expose]
   * @param {unknown} [options.cause]
   * @param {Record<string, unknown>} [options.details]
   */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? 'ERR_APP';
    this.statusCode = options.statusCode ?? 500;
    this.i18nKey = options.i18nKey ?? 'errors:generic';
    this.expose = options.expose ?? this.statusCode < 500;
    this.details = options.details ?? undefined;
    this.isAppError = true;
    Error.captureStackTrace?.(this, new.target);
  }

  /** Plain object form for API responses (never includes a stack). */
  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.expose ? this.message : 'Internal server error',
        i18nKey: this.i18nKey,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export class ConfigError extends AppError {
  constructor(message, options = {}) {
    super(message, { code: 'ERR_CONFIG', statusCode: 500, i18nKey: 'errors:config', expose: false, ...options });
  }
}

export class ValidationError extends AppError {
  constructor(message, options = {}) {
    super(message, { code: 'ERR_VALIDATION', statusCode: 400, i18nKey: 'errors:validation', ...options });
  }
}

export class AuthenticationError extends AppError {
  constructor(message, options = {}) {
    super(message, { code: 'ERR_AUTH', statusCode: 401, i18nKey: 'errors:unauthorized', ...options });
  }
}

export class PermissionDeniedError extends AppError {
  constructor(message, options = {}) {
    super(message, { code: 'ERR_PERMISSION', statusCode: 403, i18nKey: 'errors:missingPermissions', ...options });
  }
}

export class NotFoundError extends AppError {
  constructor(message, options = {}) {
    super(message, { code: 'ERR_NOT_FOUND', statusCode: 404, i18nKey: 'errors:notFound', ...options });
  }
}

export class ConflictError extends AppError {
  constructor(message, options = {}) {
    super(message, { code: 'ERR_CONFLICT', statusCode: 409, i18nKey: 'errors:conflict', ...options });
  }
}

export class RateLimitError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      code: 'ERR_RATE_LIMIT',
      statusCode: 429,
      i18nKey: 'errors:rateLimited',
      ...options,
    });
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export class DatabaseError extends AppError {
  constructor(message, options = {}) {
    super(message, { code: 'ERR_DATABASE', statusCode: 500, i18nKey: 'errors:database', expose: false, ...options });
  }
}

export class ExternalServiceError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      code: 'ERR_EXTERNAL',
      statusCode: 502,
      i18nKey: 'errors:externalService',
      expose: false,
      ...options,
    });
  }
}

export class NotImplementedError extends AppError {
  constructor(message, options = {}) {
    super(message, { code: 'ERR_NOT_IMPLEMENTED', statusCode: 501, i18nKey: 'errors:notImplemented', ...options });
  }
}

export class LocaleError extends AppError {
  constructor(message, options = {}) {
    super(message, { code: 'ERR_LOCALE', statusCode: 500, i18nKey: 'errors:locale', expose: false, ...options });
  }
}

/** @param {unknown} value */
export function isAppError(value) {
  return Boolean(value) && typeof value === 'object' && value.isAppError === true;
}

/**
 * Classify any thrown value into a safe shape.
 * @param {unknown} err
 * @returns {{ statusCode:number, code:string, message:string, i18nKey:string, expose:boolean, original:unknown }}
 */
export function normalizeError(err) {
  if (isAppError(err)) {
    return {
      statusCode: err.statusCode,
      code: err.code,
      message: err.message,
      i18nKey: err.i18nKey,
      expose: err.expose,
      original: err,
    };
  }
  // discord.js REST errors carry `status` and a Discord error code.
  if (err && typeof err === 'object' && typeof err.status === 'number') {
    return {
      statusCode: err.status,
      code: err.code ? `ERR_DISCORD_${err.code}` : 'ERR_DISCORD',
      message: String(err.message ?? 'Discord API error'),
      i18nKey: 'errors:discord',
      expose: false,
      original: err,
    };
  }
  return {
    statusCode: 500,
    code: 'ERR_INTERNAL',
    message: err instanceof Error ? err.message : String(err),
    i18nKey: 'errors:generic',
    expose: false,
    original: err,
  };
}
