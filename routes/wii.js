'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { verifyTurnstile, siteKey } = require('../lib/turnstile');
const { requestFriend, wc24Config, isFriendCode } = require('../lib/wc24');
let config;
try {
  config = require('../config');
} catch {
  config = require('../config.example');
}

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: 'Too many requests. Please wait a few minutes and try again.',
  standardHeaders: true,
  legacyHeaders: false
});

function render(res, extra = {}) {
  res.render('wii', {
    domain: config.domain,
    turnstileSiteKey: siteKey(),
    enabled: !!wc24Config(),
    pictocardWii: wc24Config() ? wc24Config().sender.replace(/(\d{4})(?=\d)/g, '$1 ') : null,
    error: null,
    message: null,
    ...extra
  });
}

// ── GET /wii ──────────────────────────────────────────────────────────────────
router.get('/', (_req, res) => render(res));

// ── POST /wii ─────────────────────────────────────────────────────────────────
// Sends the Wii a one-time friend request so it can receive PictoCards.
router.post('/', limiter, async (req, res) => {
  if (!wc24Config()) return render(res, { error: "Wii delivery isn't set up yet. Please check back soon." });

  const body = req.body || {};
  const code = String(body.friendCode || '').replace(/[\s-]/g, '');
  if (!isFriendCode(code)) {
    return render(res, { error: 'Enter your 16-digit Wii Number.' });
  }
  if (!(await verifyTurnstile(body['cf-turnstile-response'], req.ip))) {
    return render(res, { error: 'Captcha verification failed. Please try again.' });
  }

  try {
    const result = await requestFriend(code);
    render(res, {
      message:
        result === 'already'
          ? 'PictoCard has already been added to that Wii. Nothing more to do!'
          : 'Friend request sent! It will appear on your Wii after its next WiiConnect24 check.'
    });
  } catch (err) {
    console.error('[POST /wii]', err.message);
    render(res, { error: 'Could not send the friend request. Please try again later.' });
  }
});

module.exports = router;
