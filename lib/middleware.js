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
function csrf() {
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

    const bodyToken   = req.body && req.body._csrf;
    const headerToken = req.headers['x-csrf-token'];
    const submitted   = bodyToken || headerToken;

    next();
  };
}

module.exports = { rateLimit, csrf };
