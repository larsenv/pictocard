'use strict';

const express = require('express');
const { randomBytes } = require('crypto');
const router = express.Router();
const pendingStates = new Map();
const OAUTH_EXPIRY_MS = 10 * 60 * 1000;

function activeStates(key) {
  return (pendingStates.get(key) || []).filter((entry) => entry.expires > Date.now());
}
setInterval(() => {
  for (const key of pendingStates.keys()) {
    const states = activeStates(key);
    if (states.length) pendingStates.set(key, states);
    else pendingStates.delete(key);
  }
}, 60_000).unref();

let config;
try {
  config = require('../config');
} catch {
  config = require('../config.example');
}

function discordEnabled() {
  return !!(
    config.discord &&
    config.discord.enabled &&
    config.discord.clientId &&
    config.discord.clientSecret &&
    config.discord.redirectUri
  );
}

// ── GET /discord ──────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  if (!discordEnabled()) {
    return res.redirect('/?discord_disabled=1');
  }
  const state = randomBytes(24).toString('hex');
  const now = Date.now();
  const key = req.sessionID || req.session;
  const states = activeStates(key);
  states.push({ value: state, expires: now + OAUTH_EXPIRY_MS });
  pendingStates.set(key, states.slice(-8));
  // Redirect to Discord OAuth2 with identify scope to retrieve display name
  const params = new URLSearchParams({
    client_id: config.discord.clientId,
    redirect_uri: config.discord.redirectUri,
    response_type: 'code',
    scope: 'identify',
    state
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

// ── GET /discord/callback ─────────────────────────────────────────────────────
router.get('/callback', async (req, res) => {
  if (!discordEnabled()) return res.redirect('/');

  const { code, state } = req.query;
  const key = req.sessionID || req.session;
  const states = activeStates(key);
  const expectedState = states.find((entry) => entry.value === state);
  // Consume independently of session saves: concurrent callbacks must not restore a used state.
  pendingStates.set(key, states.filter((entry) => entry.value !== state));
  if (
    typeof code !== 'string' || !code ||
    typeof state !== 'string' || !expectedState || state !== expectedState.value
  ) return res.redirect('/?discord_error=1');

  try {
    // Exchange code for token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.discord.clientId,
        client_secret: config.discord.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.discord.redirectUri
      })
    });

    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
    const tokenData = await tokenRes.json();
    const { access_token } = tokenData;

    // Fetch the authenticated user's profile
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    if (!userRes.ok) throw new Error(`User fetch failed: ${userRes.status}`);
    const user = await userRes.json();

    // global_name is the display name on the new username system;
    // fall back to username for older accounts
    const displayName = user.global_name || user.username;

    req.session.discordUser = {
      id: user.id,
      username: user.username,
      displayName
    };

    res.redirect('/');
  } catch (err) {
    console.error('[Discord OAuth] callback error:', err.message);
    res.redirect('/?discord_error=1');
  }
});

// ── GET /discord/logout ───────────────────────────────────────────────────────
router.get('/logout', (req, res) => {
  pendingStates.delete(req.sessionID || req.session);
  delete req.session.discordUser;
  res.redirect('/');
});

module.exports = router;
