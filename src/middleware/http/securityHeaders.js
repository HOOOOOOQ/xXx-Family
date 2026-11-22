/**
 * src/middleware/http/securityHeaders.js
 * ---------------------------------------------------------------------------
 * Minimal, dependency-free security headers. A full CSP belongs to the
 * dashboard (Phase 8); this protects the JSON API and the health endpoints.
 */

/** @param {object} [options] @param {string[]} [options.corsOrigins] */
export function securityHeaders(options = {}) {
  return function securityHeadersMiddleware(req, res, next) {
    res.removeHeader?.('X-Powered-By');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-XSS-Protection', '0'); // deliberately off: modern browsers rely on CSP
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
}

export default securityHeaders;
