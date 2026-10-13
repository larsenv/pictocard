'use strict';

const { randomBytes } = require('crypto');

/**
 * Minimal in-memory rate limiter middleware.
 *
 * @param {object} opts
 * @param {number} opts.windowMs   - Rolling window length in milliseconds
 * @param {number} opts.max        - Maximum requests allowed per window per IP
 * @param {string} [opts.message]  - Message to send when limit is exceeded
 */
function rateLimit({ windowMs, max, message = 'Too many requests. Please try again later.' } = {}) {
  const hits = new Map(); // ip -> { count, resetAt }

  // Periodically clean up expired entries to avoid unbounded memory growth
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of hits.entries()) {
      if (now >= data.resetAt) hits.delete(ip);
    }
  }, windowMs).unref();

  // Allow the interval to be cleared in tests
  rateLimit._intervals = rateLimit._intervals || [];
  rateLimit._intervals.push(cleanupInterval);

  return function rateLimitMiddleware(req, res, next) {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = hits.get(ip);

    if (!entry || now >= entry.resetAt) {
      hits.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).send(message);
    }
    next();
  };
}

/**
 * CSRF protection middleware (synchroniser token pattern).
 *
 * - On GET requests: generates a token (if absent), stores it in the session,
 *   and exposes it as `res.locals.csrfToken`.
 * - On state-changing requests (POST/PUT/PATCH/DELETE): validates the token
 *   submitted as `req.body._csrf` or the `X-CSRF-Token` header.
 *
 * Requires express-session to be configured before this middleware.
 */
function csrf({ multipartPaths = [] } = {}) {
  return function csrfMiddleware(req, res, next) {
    // Ensure a token exists in the session
    if (!req.session.csrfToken) {
      req.session.csrfToken = randomBytes(24).toString('hex');
    }

    // Always expose to views
    res.locals.csrfToken = req.session.csrfToken;

    const method = req.method.toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      return next();
    }

    // Only upload routes may defer validation until after their multipart parser.
    const contentType = req.headers['content-type'] || '';
    if (
      method === 'POST' &&
      contentType.includes('multipart/form-data') &&
      multipartPaths.includes(req.path.replace(/\/$/, ''))
    ) {
      return next();
    }

    const bodyToken = req.body && req.body._csrf;
    const headerToken = req.headers['x-csrf-token'];
    const submitted = bodyToken || headerToken;

    if (!submitted || !req.session.csrfToken || !safeEqual(submitted, req.session.csrfToken)) {
      return res.status(403).send('Invalid CSRF token.');
    }

    next();
  };
}

/**
 * Manual CSRF validation helper for routes that parse their own bodies (like multer).
 */
function validateCsrf(req, res, next) {
  const bodyToken = req.body && req.body._csrf;
  const headerToken = req.headers['x-csrf-token'];
  const submitted = bodyToken || headerToken;

  if (!submitted || !req.session.csrfToken || !safeEqual(submitted, req.session.csrfToken)) {
    return res.status(403).send('Invalid CSRF token.');
  }
  next();
}

/** Constant-time string comparison (for codes and tokens). */
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && require('crypto').timingSafeEqual(x, y);
}

module.exports = { rateLimit, csrf, validateCsrf, safeEqual };
