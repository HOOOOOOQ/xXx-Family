/**
 * src/middleware/http/cors.js
 * ---------------------------------------------------------------------------
 * Allow-list CORS. The dashboard origin comes from configuration; nothing is
 * reflected back blindly, because the API will carry session cookies in Phase 8.
 */

/** @param {string[]} allowedOrigins */
export function cors(allowedOrigins = []) {
  const allowed = new Set(allowedOrigins.filter(Boolean));

  return function corsMiddleware(req, res, next) {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-CSRF-Token');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

export default cors;
