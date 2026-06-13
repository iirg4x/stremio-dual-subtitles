const DEFAULT_REDACT_KEYS = [
  'authorization',
  'token',
  'access_token',
  'refresh_token',
  'cookie',
  'set-cookie',
  'api_key',
  'apikey',
  'key',
  'password'
];

// Strip values of sensitive query params from URL-like strings before logging.
const SENSITIVE_QUERY_PARAM_RE =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|key|password)=([^&\s#]+)/gi;

function isDebugEnabled() {
  return process.env.DEBUG_MODE === 'true' || process.env.NEXT_PUBLIC_DEBUG_MODE === 'true';
}

function redactSecretsInString(str) {
  return str.replace(SENSITIVE_QUERY_PARAM_RE, (_, name) => `${name}=[REDACTED]`);
}

function sanitizeForLogging(data) {
  if (data == null) return data;
  if (typeof data === 'string') {
    const redacted = redactSecretsInString(data);
    return redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted;
  }
  if (Array.isArray(data)) {
    return data.map(sanitizeForLogging);
  }
  if (typeof data === 'object') {
    const sanitized = {};
    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();
      if (DEFAULT_REDACT_KEYS.includes(lowerKey)) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitizeForLogging(value);
      }
    }
    return sanitized;
  }
  return data;
}

// Errors and warnings are always emitted — production logs would otherwise be
// silent. Only verbose log/info calls are gated by DEBUG_MODE.
function createLogger(prefix) {
  return {
    log: (...args) => {
      if (!isDebugEnabled()) return;
      console.log(prefix, ...args.map(sanitizeForLogging));
    },
    info: (...args) => {
      if (!isDebugEnabled()) return;
      console.info(prefix, ...args.map(sanitizeForLogging));
    },
    warn: (...args) => {
      console.warn(prefix, ...args.map(sanitizeForLogging));
    },
    error: (...args) => {
      console.error(prefix, ...args.map(sanitizeForLogging));
    },
    apiRequest: (message, meta = {}) => {
      if (!isDebugEnabled()) return;
      console.log(`${prefix} ${message}`, sanitizeForLogging(meta));
    }
  };
}

const debug = createLogger('[debug]');
const debugServer = createLogger('[server]');

module.exports = {
  debug,
  debugServer,
  sanitizeForLogging
};
