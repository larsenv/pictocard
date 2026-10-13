'use strict';

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { emailOptOuts, hashEmail } = require('./index');
const { wiiOptOuts, discordOptOuts } = require('../lib/optouts');
const { safeEqual } = require('../lib/middleware');
const { sendOptoutConfirmation, sendOptoutVerificationCode } = require('../lib/emailService');
const { sendText: sendWiiText, wc24Config, isFriendCode } = require('../lib/wc24');
let config;
try {
  config = require('../config');
} catch {
  config = require('../config.example');
}

const CODE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const MAIL_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CODE_ATTEMPTS = 5;

function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function makeLimiter({ windowMs, max, message, keyGenerator }) {
  return rateLimit({
    windowMs,
    max,
    message,
    standardHeaders: true,
    legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator, validate: false } : {})
  });
}

// Per-IP cap on requesting an opt-out/opt-in verification email.
const requestIpLimiter = makeLimiter({
  windowMs: MAIL_WINDOW_MS,
  max: 5,
  message: 'Too many requests. Please wait a few minutes and try again.'
});
// Per-address cap so a single mailbox can't be bombed from rotating IPs.
const requestTargetLimiter = makeLimiter({
  windowMs: MAIL_WINDOW_MS,
  max: 5,
  message: 'Too many requests for this address. Please wait a few minutes.',
  keyGenerator: (req) => {
    const b = req.body || {};
    const target = b.method === 'wii' ? String(b.wii || '').replace(/[\s-]/g, '') : b.email;
    return target ? `optout:${String(target).trim().toLowerCase()}` : `optout-ip:${req.ip}`;
  }
});
// Per-IP cap on code submission (throttles brute-force of the 6-digit code).
const verifyIpLimiter = makeLimiter({
  windowMs: MAIL_WINDOW_MS,
  max: 10,
  message: 'Too many attempts. Please wait a few minutes and try again.'
});

const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const cleanWii = (v) => String(v || '').replace(/[\s-]/g, '');
const prettyWii = (v) => cleanWii(v).replace(/(\d{4})(?=\d)/g, '$1 ');

// Render the page. `view` overrides the defaults below.
function show(req, res, view = {}) {
  const method = ['email', 'wii', 'discord'].includes(view.method) ? view.method : 'email';
  const action = view.action === 'optin' ? 'optin' : 'optout';
  res.render('optout', {
    step: 'form',
    method,
    action,
    success: false,
    doneAction: action,
    doneMethod: method,
    error: null,
    target: '',
    domain: config.domain,
    wiiEnabled: !!wc24Config(),
    discordUser: (req.session && req.session.discordUser) || null,
    discordOAuthEnabled: !!(
      config.discord &&
      config.discord.enabled &&
      config.discord.clientId &&
      config.discord.clientSecret &&
      config.discord.redirectUri
    ),
    discordOptedOut: !!(
      req.session &&
      req.session.discordUser &&
      discordOptOuts.has(req.session.discordUser.username)
    ),
    ...view
  });
}

function applyChoice(method, target, action) {
  if (method === 'wii') {
    if (action === 'optin') wiiOptOuts.delete(target);
    else wiiOptOuts.add(target);
  } else if (method === 'discord') {
    if (action === 'optin') discordOptOuts.delete(target);
    else discordOptOuts.add(target);
  } else {
    const hash = hashEmail(target);
    if (action === 'optin') emailOptOuts.delete(hash);
    else emailOptOuts.add(hash);
  }
  console.log(`[Optout] ${method} ${action}`);
}

// ── GET /optout ───────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  show(req, res, {
    method: req.query.method,
    action: req.query.action,
    success: req.query.done === '1',
    doneAction: req.query.doneAction === 'optin' ? 'optin' : 'optout',
    doneMethod: req.query.doneMethod
  });
});

// ── POST /optout/request ──────────────────────────────────────────────────────
// Collect the email address or Wii Number + action, send a verification code, show code entry form
router.post('/request', requestIpLimiter, requestTargetLimiter, async (req, res) => {
  const body = req.body || {};
  const method = body.method === 'wii' ? 'wii' : 'email';
  const action = body.action === 'optin' ? 'optin' : 'optout';
  const raw = method === 'wii' ? cleanWii(body.wii) : String(body.email || '').trim();

  if (method === 'email' && !VALID_EMAIL.test(raw)) {
    return show(req, res, { method, action, error: 'Please enter a valid email address.', target: raw });
  }
  if (method === 'wii') {
    if (!wc24Config()) {
      return show(req, res, { method, action, error: "Wii delivery isn't set up yet. Please check back soon." });
    }
    if (!isFriendCode(raw)) {
      return show(req, res, { method, action, error: 'Enter your 16-digit Wii Number.', target: raw });
    }
  }

  const code = generateCode();
  req.session.optoutPending = {
    method,
    target: method === 'email' ? raw.toLowerCase() : raw,
    action,
    code,
    expires: Date.now() + CODE_EXPIRY_MS,
    attempts: 0
  };

  try {
    if (method === 'wii') {
      await sendWiiText(
        raw,
        `Your PictoCard verification code to ${action === 'optin' ? 'opt back in' : 'opt out'} is ${code}. It expires in 10 minutes. If you did not request this, ignore this letter.`
      );
      console.log('[Optout] verification code sent to a Wii');
    } else {
      await sendOptoutVerificationCode(raw, code, action);
    }
  } catch (err) {
    console.error('[Optout] could not send verification code:', err.message);
    delete req.session.optoutPending;
    return show(req, res, {
      method,
      action,
      error: `Failed to send the verification ${method === 'wii' ? 'letter' : 'email'}. Please try again.`,
      target: raw
    });
  }

  show(req, res, { step: 'verify', method, action, target: method === 'wii' ? prettyWii(raw) : raw });
});

// ── POST /optout/verify ───────────────────────────────────────────────────────
// Check code and perform the opt-out/opt-in action
router.post('/verify', verifyIpLimiter, async (req, res) => {
  const { code } = req.body || {};
  const pending = req.session.optoutPending;

  if (!pending || Date.now() > pending.expires) {
    delete req.session.optoutPending;
    return show(req, res, {
      method: pending && pending.method,
      action: pending && pending.action,
      error: 'Verification code expired. Please start again.'
    });
  }

  if (typeof code !== 'string' || !pending.code || !safeEqual(code.trim(), pending.code)) {
    pending.attempts = (pending.attempts || 0) + 1;
    // Too many wrong guesses: discard the pending request entirely.
    if (pending.attempts >= MAX_CODE_ATTEMPTS) {
      delete req.session.optoutPending;
      return show(req, res, {
        method: pending.method,
        action: pending.action,
        error: 'Too many incorrect attempts. Please start again.'
      });
    }
    return show(req, res, {
      step: 'verify',
      method: pending.method,
      action: pending.action,
      error: 'Incorrect verification code. Please try again.',
      target: pending.method === 'wii' ? prettyWii(pending.target) : pending.target
    });
  }

  const { method, target, action } = pending;
  delete req.session.optoutPending;

  applyChoice(method, target, action);
  if (method === 'email' && action === 'optout') {
    sendOptoutConfirmation(target).catch((err) => console.error('[sendOptoutConfirmation]', err.message));
  }

  res.redirect(`/optout?done=1&doneAction=${action}&doneMethod=${method}`);
});

// ── POST /optout/discord ──────────────────────────────────────────────────────
// A Discord user signed in with OAuth has already proven who they are: no code.
router.post('/discord', (req, res) => {
  const user = req.session.discordUser;
  const action = (req.body || {}).action === 'optin' ? 'optin' : 'optout';
  if (!user) {
    return show(req, res, { method: 'discord', action, error: 'Log in with Discord first.' });
  }
  applyChoice('discord', user.username, action);
  res.redirect(`/optout?done=1&doneAction=${action}&doneMethod=discord`);
});

module.exports = router;
