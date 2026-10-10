'use strict';

// Cloudflare Turnstile helpers. Keys come from config.turnstile or the
// TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY env vars. When no secret is set the
// check is skipped (opt-in, like content moderation).

let config;
try {
  config = require('../config');
} catch {
  config = require('../config.example');
}

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function keys() {
  const t = config.turnstile || {};
  return {
    siteKey: process.env.TURNSTILE_SITE_KEY || t.siteKey || '',
    secretKey: process.env.TURNSTILE_SECRET_KEY || t.secretKey || ''
  };
}

const isEnabled = () => !!(keys().siteKey && keys().secretKey);
const siteKey = () => (isEnabled() ? keys().siteKey : '');

/**
 * Validate the token the widget put in the `cf-turnstile-response` field.
 * Fails closed when enabled; always passes when disabled.
 */
async function verifyTurnstile(token, ip) {
  if (!isEnabled()) return true;
  if (!token || typeof token !== 'string' || token.length > 2048) return false;
  try {
    const body = new URLSearchParams({ secret: keys().secretKey, response: token });
    if (ip) body.set('remoteip', ip);
    const res = await fetch(VERIFY_URL, { method: 'POST', body });
    if (!res.ok) return false;
    return !!(await res.json()).success;
  } catch (err) {
    console.error('[Turnstile] verify failed:', err.message);
    return false;
  }
}

module.exports = { verifyTurnstile, isEnabled, siteKey };
