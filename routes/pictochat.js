'use strict';

// Captcha relay for PictoChat for Wii, a Homebrew Channel client for
// PictoChat Online (https://pict.chat). pict.chat asks every player to solve an
// hCaptcha before joining, which a Wii cannot run. Instead the Wii asks for a
// short pairing code, the player opens /pictochat/<code> on a phone or computer
// and solves pict.chat's captcha there, and the Wii picks up the token and
// hands it to pict.chat itself. Tokens are only relayed, never stored for
// longer than they are valid (hCaptcha tokens expire after two minutes).

const express = require('express');
const rateLimit = require('express-rate-limit');

let config;
try {
  config = require('../config');
} catch {
  config = require('../config.example');
}

// pict.chat's own hCaptcha site key, so the token is accepted by its server.
const PICTCHAT_SITE_KEY = '49043ad8-6b2d-4f6c-bfa5-a8c9f235e048';
const CODE_CHARS = 'ACDEFHJKLMNPQRTUVWXY34679'; // no 0/O, 1/I, 2/Z, 5/S, 8/B lookalikes
const CODE_LENGTH = 6;
const PAIR_TTL_MS = 10 * 60 * 1000;
const TOKEN_TTL_MS = 110 * 1000;
const MAX_PAIRS = 5000;
const TOKEN_RE = /^[A-Za-z0-9_.-]{20,8192}$/;

const siteKey = () => (config.pictochat && config.pictochat.hcaptchaSiteKey) || PICTCHAT_SITE_KEY;

// code -> { expires, token }
const pairs = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [code, p] of pairs) if (p.expires < now) pairs.delete(code);
}, 60_000).unref();

function newCode() {
  const bytes = require('crypto').randomBytes(CODE_LENGTH);
  let code = '';
  for (const b of bytes) code += CODE_CHARS[b % CODE_CHARS.length];
  return code;
}

const normalize = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const validCode = (code) => code.length === CODE_LENGTH && [...code].every((c) => CODE_CHARS.includes(c));

function limiter(windowMs, max, message) {
  return rateLimit({ windowMs, max, message: { error: message }, standardHeaders: true, legacyHeaders: false });
}

// ── JSON API (/api/v1/pictochat) ─────────────────────────────────────────────
const api = express.Router();
api.use(express.json({ limit: '16kb' }));

// The Wii asks for a code to show on screen.
api.post('/pair', limiter(10 * 60 * 1000, 20, 'Too many pairing codes. Please wait a few minutes.'), (_req, res) => {
  if (pairs.size >= MAX_PAIRS) return res.status(503).json({ error: 'Too many people are pairing right now. Try again soon.' });
  let code;
  do code = newCode(); while (pairs.has(code));
  pairs.set(code, { expires: Date.now() + PAIR_TTL_MS, token: null });
  res.json({ code, url: `${config.domain}/pictochat/${code}`, expiresIn: PAIR_TTL_MS / 1000 });
});

// The Wii polls until the captcha has been solved. A token is handed out once.
api.get('/pair/:code', limiter(60 * 1000, 90, 'Too many requests. Please wait a minute.'), (req, res) => {
  const code = normalize(req.params.code);
  const pair = pairs.get(code);
  if (!pair || pair.expires < Date.now()) {
    pairs.delete(code);
    return res.status(404).json({ error: 'This pairing code has expired.' });
  }
  if (!pair.token) return res.status(202).json({ pending: true });
  pairs.delete(code);
  res.json({ token: pair.token });
});

// The pairing page posts the solved captcha's token.
api.post('/pair/:code', limiter(10 * 60 * 1000, 30, 'Too many attempts. Please wait a few minutes.'), (req, res) => {
  const code = normalize(req.params.code);
  const pair = pairs.get(code);
  const token = req.body && req.body.token;
  if (!pair || pair.expires < Date.now()) return res.status(404).json({ error: 'That code has expired. Get a new one on your Wii.' });
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return res.status(422).json({ error: 'The captcha did not finish. Please try again.' });
  pair.token = token;
  pair.expires = Date.now() + TOKEN_TTL_MS;
  res.json({ ok: true });
});

// ── Pairing page (/pictochat) ────────────────────────────────────────────────
const page = express.Router();

// hCaptcha needs its own script, frame and connect sources on this page only.
function hcaptchaCsp(res) {
  const nonce = res.locals.nonce;
  const hc = 'https://hcaptcha.com https://*.hcaptcha.com';
  res.set('Content-Security-Policy', [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' ${hc}`,
    "script-src-attr 'none'",
    `style-src 'self' 'unsafe-inline' ${hc}`,
    `img-src 'self' data: blob: ${hc}`,
    "font-src 'self'",
    `connect-src 'self' ${hc}`,
    `frame-src ${hc}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '));
}

function render(res, code, expired = false) {
  hcaptchaCsp(res);
  res.render('pictochat', { domain: config.domain, code, expired, siteKey: siteKey() });
}

page.get('/', (req, res) => {
  const code = normalize(req.query.code);
  if (code) return res.redirect(`/pictochat/${code}`);
  render(res, null);
});

page.get('/:code', (req, res) => {
  const code = normalize(req.params.code);
  const pair = pairs.get(code);
  if (!validCode(code) || !pair || pair.expires < Date.now()) return render(res, null, !!code);
  render(res, code);
});

module.exports = { api, page, pairs, PICTCHAT_SITE_KEY };
