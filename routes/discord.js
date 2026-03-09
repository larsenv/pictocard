'use strict';

const express = require('express');
const router = express.Router();
const axios = require('axios');

let config;
try {
  config = require('../config');
} catch {
  config = require('../config.example');
}

const discordEnabled = config.discord && config.discord.enabled;

// ── GET /discord ──────────────────────────────────────────────────────────────
router.get('/', (_req, res) => {
  if (!discordEnabled) {
    return res.redirect('/?discord_disabled=1');
  }
  // Redirect to Discord OAuth2
  const params = new URLSearchParams({
    client_id: config.discord.clientId,
    redirect_uri: config.discord.redirectUri,
    response_type: 'code',
    scope: 'identify'
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

// ── GET /discord/callback ─────────────────────────────────────────────────────
router.get('/callback', async (req, res) => {
  if (!discordEnabled) return res.redirect('/');

  const { code } = req.query;
  if (!code) return res.redirect('/');

  try {
    // Exchange code for token
    const tokenRes = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: config.discord.clientId,
        client_secret: config.discord.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.discord.redirectUri
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token } = tokenRes.data;

    // Fetch the authenticated user's profile
    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    req.session.discordUser = {
      id: userRes.data.id,
      username: userRes.data.username,
      discriminator: userRes.data.discriminator,
      avatar: userRes.data.avatar
    };

    res.redirect('/');
  } catch (err) {
    console.error('[Discord OAuth] callback error:', err.message);
    res.redirect('/?discord_error=1');
  }
});

// ── GET /discord/logout ───────────────────────────────────────────────────────
router.get('/logout', (req, res) => {
  delete req.session.discordUser;
  res.redirect('/');
});

module.exports = router;
