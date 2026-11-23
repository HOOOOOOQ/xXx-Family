/**
 * src/utils/redact.js
 * ---------------------------------------------------------------------------
 * Secret scrubbing used by the logger, the API error handler and every log
 * line written by the moderation / audit systems.
 *
 * Two mechanisms, both applied:
 *   1. Key based  — object keys that look like a credential are replaced.
 *   2. Value based — any registered secret string (Discord token, Mongo
 *      password, session secret…) found inside an arbitrary string is masked,
 *      which catches secrets pasted into a message body or an error string.
 */

const REDACTED = '[REDACTED]';

/** Object keys that always get redacted (case insensitive, substring match). */
const SENSITIVE_KEY_PATTERNS = [
  'token',
  'secret',
  'password',
  'passwd',
  'authorization',
  'auth',
  'cookie',
  'session',
  'credential',
  'apikey',
  'api_key',
  'access_key',
  'private_key',
  'privatekey',
  'mongo_uri',
  'mongodb_uri',
  'connectionstring',
  'refresh',
  'otp',
  'pin',
];

/** Keys that only look sensitive but carry no secret — never redact these. */
const SAFE_KEY_ALLOWLIST = new Set([
  'authored',
  'author',
  'authorid',
  'authority',
  'authenticated', // boolean flag, not a credential
  'sessionid',
  'sessionId',
  'tokencount',
  'tokens',
  'tokenusage',
]);

/** Live secret values registered at boot (token, passwords, …). */
const registeredSecrets = new Set();

/**
 * Register a value so it is masked wherever it appears in a log line.
 * Values shorter than 8 chars are ignored to avoid masking ordinary words.
 * @param {string|null|undefined} value
 */
export function registerSecret(value) {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length < 8) return;
  registeredSecrets.add(trimmed);
}

/** Forget every registered secret (used by tests). */
export function clearSecrets() {
  registeredSecrets.clear();
}

/** @returns {number} how many secret values are currently registered. */
export function registeredSecretCount() {
  return registeredSecrets.size;
}

/**
 * Mask a raw string: known secrets plus obvious `scheme://user:pass@` URIs.
 * @param {string} input
 * @returns {string}
 */
export function redactString(input) {
  if (typeof input !== 'string' || input.length === 0) return input;
  let out = input;

  // mongodb+srv://user:password@host  /  https://user:token@host
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)([^@\s/]+)(@)/gi, (_m, a, _b, c) => `${a}${REDACTED}${c}`);

  for (const secret of registeredSecrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** @param {string} key */
function isSensitiveKey(key) {
  const lower = String(key).toLowerCase();
  if (SAFE_KEY_ALLOWLIST.has(lower)) return false;
  return SENSITIVE_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Deep-clone `value` with every credential removed.
 * Never mutates the input. Cycles and deep nesting are handled safely.
 *
 * @param {unknown} value
 * @param {object} [options]
 * @param {number} [options.maxDepth]
 * @param {number} [options.maxArrayLength]
 * @returns {unknown}
 */
export function redact(value, options = {}) {
  const maxDepth = options.maxDepth ?? 6;
  const maxArrayLength = options.maxArrayLength ?? 50;
  const seen = new WeakSet();

  const walk = (node, depth) => {
    if (node === null || node === undefined) return node;

    const type = typeof node;
    if (type === 'string') return redactString(node);
    if (type === 'number' || type === 'boolean' || type === 'bigint') return node;
    if (type === 'function') return '[Function]';
    if (type === 'symbol') return node.toString();

    if (node instanceof Error) {
      if (depth >= maxDepth) return `[${node.name}]`;
      return {
        name: node.name,
        message: redactString(node.message ?? ''),
        ...(node.code ? { code: node.code } : {}),
        ...(node.stack ? { stack: redactString(String(node.stack).split('\n').slice(0, 6).join('\n')) } : {}),
      };
    }

    if (type !== 'object') return String(node);

    if (seen.has(node)) return '[Circular]';
    if (depth >= maxDepth) return '[Truncated]';
    seen.add(node);

    if (Array.isArray(node)) {
      const sliced = node.slice(0, maxArrayLength);
      const out = sliced.map((item) => walk(item, depth + 1));
      if (node.length > maxArrayLength) out.push(`… +${node.length - maxArrayLength} more`);
      return out;
    }

    if (node instanceof Map) {
      const out = {};
      let i = 0;
      for (const [k, v] of node) {
        if (i++ >= maxArrayLength) break;
        out[String(k)] = isSensitiveKey(k) ? REDACTED : walk(v, depth + 1);
      }
      return out;
    }

    if (node instanceof Set) return [...node].slice(0, maxArrayLength).map((v) => walk(v, depth + 1));

    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (isSensitiveKey(k)) {
        out[k] = REDACTED;
        continue;
      }
      out[k] = walk(v, depth + 1);
    }
    return out;
  };

  return walk(value, 0);
}

export default redact;
