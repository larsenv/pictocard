'use strict';

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { emailOptOuts, hashEmail } = require('./index');
const { sendOptoutConfirmation, sendOptoutVerificationCode } = require('../lib/emailService');
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
    const email = req.body && req.body.email;
    return email ? `optout:${String(email).trim().toLowerCase()}` : `optout-ip:${req.ip}`;
  }
});
// Per-IP cap on code submission (throttles brute-force of the 6-digit code).
const verifyIpLimiter = makeLimiter({
  windowMs: MAIL_WINDOW_MS,
  max: 10,
  message: 'Too many attempts. Please wait a few minutes and try again.'
});

const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── GET /optout ───────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.render('optout', {
    step: 'form',
    action: req.query.action === 'optin' ? 'optin' : 'optout',
    success: req.query.done === '1',
    doneAction: req.query.doneAction || 'optout',
    error: null,
    email: '',
    domain: config.domain
  });
});

// ── POST /optout/request ──────────────────────────────────────────────────────
// Collect email + action, send verification code, show code entry form
router.post('/request', requestIpLimiter, requestTargetLimiter, async (req, res) => {
  const { email, action } = req.body;
  const safeAction = action === 'optin' ? 'optin' : 'optout';

  if (!email || !VALID_EMAIL.test(email.trim())) {
    return res.render('optout', {
      step: 'form',
      action: safeAction,
      success: false,
      doneAction: safeAction,
      error: 'Please enter a valid email address.',
      email: email || '',
      domain: config.domain
    });
  }

  const code = generateCode();
  req.session.optoutPending = {
    email: email.trim().toLowerCase(),
    action: safeAction,
    code,
    expires: Date.now() + CODE_EXPIRY_MS,
    attempts: 0
  };

  try {
    await sendOptoutVerificationCode(email.trim(), code, safeAction);
  } catch (err) {
    console.error('[sendOptoutVerificationCode]', err.message);
    return res.render('optout', {
      step: 'form',
      action: safeAction,
      success: false,
      doneAction: safeAction,
      error: 'Failed to send verification email. Please try again.',
      email: email.trim(),
      domain: config.domain
    });
  }

  res.render('optout', {
    step: 'verify',
    action: safeAction,
    success: false,
    doneAction: safeAction,
    error: null,
    email: email.trim(),
    domain: config.domain
  });
});

// ── POST /optout/verify ───────────────────────────────────────────────────────
// Check code and perform the opt-out/opt-in action
router.post('/verify', verifyIpLimiter, async (req, res) => {
  const { code } = req.body;
  const pending = req.session.optoutPending;

  if (!pending || Date.now() > pending.expires) {
    delete req.session.optoutPending;
    return res.render('optout', {
      step: 'form',
      action: 'optout',
      success: false,
      doneAction: 'optout',
      error: 'Verification code expired. Please start again.',
      email: '',
      domain: config.domain
    });
  }

  if (!code || code.trim() !== pending.code) {
    pending.attempts = (pending.attempts || 0) + 1;
    // Too many wrong guesses: discard the pending request entirely.
    if (pending.attempts >= MAX_CODE_ATTEMPTS) {
      delete req.session.optoutPending;
      return res.render('optout', {
        step: 'form',
        action: 'optout',
        success: false,
        doneAction: 'optout',
        error: 'Too many incorrect attempts. Please start again.',
        email: '',
        domain: config.domain
      });
    }
    return res.render('optout', {
      step: 'verify',
      action: pending.action,
      success: false,
      doneAction: pending.action,
      error: 'Incorrect verification code. Please try again.',
      email: pending.email,
      domain: config.domain
    });
  }

  const { email, action } = pending;
  delete req.session.optoutPending;

  const emailHash = hashEmail(email);
  if (action === 'optin') {
    emailOptOuts.delete(emailHash);
  } else {
    emailOptOuts.add(emailHash);
    sendOptoutConfirmation(email).catch((err) =>
      console.error('[sendOptoutConfirmation]', err.message)
    );
  }

  res.redirect(`/optout?done=1&doneAction=${action}`);
});

module.exports = router;
