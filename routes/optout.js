'use strict';

const express = require('express');
const router = express.Router();
const { emailOptOuts } = require('./index');

// ── GET /optout ───────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.render('optout', {
    success: req.query.done === '1',
    error: null,
    email: ''
  });
});

// ── POST /optout ──────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const { email } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.render('optout', {
      success: false,
      error: 'Please enter a valid email address.',
      email: email || ''
    });
  }

  emailOptOuts.add(email.trim().toLowerCase());
  res.redirect('/optout?done=1');
});

module.exports = router;
