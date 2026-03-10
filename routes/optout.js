'use strict';

const express = require('express');
const router = express.Router();
const { emailOptOuts } = require('./index');
const { sendOptoutConfirmation } = require('../lib/emailService');

// ── GET /optout ───────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.render('optout', {
    success: req.query.done === '1',
    error: null,
    email: ''
  });
});

// ── POST /optout ──────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { email } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.render('optout', {
      success: false,
      error: 'Please enter a valid email address.',
      email: email || ''
    });
  }

  emailOptOuts.add(email.trim().toLowerCase());

  // Send confirmation email (fire-and-forget)
  sendOptoutConfirmation(email.trim())
    .catch(err => console.error('[sendOptoutConfirmation]', err.message));

  res.redirect('/optout?done=1');
});

module.exports = router;
