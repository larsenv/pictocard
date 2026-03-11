'use strict';

const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { emailOptOuts, hashEmail } = require('./index');
const { sendOptoutConfirmation, sendOptoutVerificationCode } = require('../lib/emailService');

const CODE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── GET /optout ───────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.render('optout', {
    step: 'form',
    action: req.query.action === 'optin' ? 'optin' : 'optout',
    success: req.query.done === '1',
    doneAction: req.query.doneAction || 'optout',
    error: null,
    email: ''
  });
});

// ── POST /optout/request ──────────────────────────────────────────────────────
// Collect email + action, send verification code, show code entry form
router.post('/request', async (req, res) => {
  const { email, action } = req.body;
  const safeAction = action === 'optin' ? 'optin' : 'optout';

  if (!email || !VALID_EMAIL.test(email.trim())) {
    return res.render('optout', {
      step: 'form',
      action: safeAction,
      success: false,
      doneAction: safeAction,
      error: 'Please enter a valid email address.',
      email: email || ''
    });
  }

  const code = generateCode();
  req.session.optoutPending = {
    email: email.trim().toLowerCase(),
    action: safeAction,
    code,
    expires: Date.now() + CODE_EXPIRY_MS
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
      email: email.trim()
    });
  }

  res.render('optout', {
    step: 'verify',
    action: safeAction,
    success: false,
    doneAction: safeAction,
    error: null,
    email: email.trim()
  });
});

// ── POST /optout/verify ───────────────────────────────────────────────────────
// Check code and perform the opt-out/opt-in action
router.post('/verify', async (req, res) => {
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
      email: ''
    });
  }

  if (!code || code.trim() !== pending.code) {
    return res.render('optout', {
      step: 'verify',
      action: pending.action,
      success: false,
      doneAction: pending.action,
      error: 'Incorrect verification code. Please try again.',
      email: pending.email
    });
  }

  const { email, action } = pending;
  delete req.session.optoutPending;

  const emailHash = hashEmail(email);
  if (action === 'optin') {
    emailOptOuts.delete(emailHash);
  } else {
    emailOptOuts.add(emailHash);
    sendOptoutConfirmation(email)
      .catch(err => console.error('[sendOptoutConfirmation]', err.message));
  }

  res.redirect(`/optout?done=1&doneAction=${action}`);
});

module.exports = router;
