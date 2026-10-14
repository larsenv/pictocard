'use strict';

// Proof-of-work challenges for API clients that cannot show a captcha (the Wii
// homebrew client). The server hands out a signed, short-lived challenge; the
// client must find a nonce so that SHA-256(challenge ":" nonce) starts with
// `difficulty` zero bits. Each challenge is bound to the requesting IP and a
// purpose, and can be redeemed once. Difficulty rises for IPs that keep sending.

const crypto = require('crypto');
const { safeEqual } = require('./middleware');

let config;
try {
  config = require('../config');
} catch {
  config = require('../config.example');
}

const settings = () => config.api || {};
const TTL_MS = 10 * 60 * 1000;
const RECENT_WINDOW_MS = 60 * 60 * 1000;
const MAX_EXTRA_BITS = 4;

// Signing key: configured, else derived from the session secret, else random
// per process (challenges then do not survive a restart, which is harmless).
const secret = settings().secret || (config.sessionSecret
  ? crypto.createHash('sha256').update(`pictocard-api:${config.sessionSecret}`).digest()
  : crypto.randomBytes(32));

const redeemed = new Map(); // challenge id -> expiry
const recent = new Map(); // ip -> [timestamps of completed sends]

setInterval(() => {
  const now = Date.now();
  for (const [id, exp] of redeemed) if (exp < now) redeemed.delete(id);
  for (const [ip, times] of recent) {
    const kept = times.filter((t) => now - t < RECENT_WINDOW_MS);
    if (kept.length) recent.set(ip, kept);
    else recent.delete(ip);
  }
}, 60_000).unref();

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');
const ipTag = (ip) => crypto.createHmac('sha256', secret).update(`ip:${ip}`).digest('base64url').slice(0, 16);

function baseDifficulty() {
  const bits = Number(settings().powDifficulty);
  return Number.isInteger(bits) && bits >= 0 && bits <= 32 ? bits : 18;
}

function difficultyFor(ip) {
  const sends = (recent.get(ip) || []).filter((t) => Date.now() - t < RECENT_WINDOW_MS).length;
  return Math.min(32, baseDifficulty() + Math.min(MAX_EXTRA_BITS, Math.floor(sends / 2)));
}

/** Issue a challenge for `purpose` ('send' or 'friend') bound to this IP. */
function issueChallenge(ip, purpose) {
  const difficulty = difficultyFor(ip);
  const expires = Date.now() + TTL_MS;
  const payload = b64url(JSON.stringify({
    id: crypto.randomBytes(12).toString('hex'), p: purpose, d: difficulty, e: expires, ip: ipTag(ip)
  }));
  return { challenge: `${payload}.${sign(payload)}`, difficulty, expires };
}

function leadingZeroBits(hash) {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/**
 * Check a solved challenge and mark it used. Returns null when it is valid,
 * otherwise a short reason for the client.
 */
function redeemChallenge(ip, purpose, pow) {
  const challenge = pow && typeof pow.challenge === 'string' ? pow.challenge : '';
  const nonce = pow && typeof pow.nonce === 'string' ? pow.nonce : '';
  if (!challenge || challenge.length > 512 || !/^[A-Za-z0-9]{1,32}$/.test(nonce)) {
    return 'The anti-spam check is missing. Please try again.';
  }
  const [payload, signature] = challenge.split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return 'The anti-spam check is invalid.';
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return 'The anti-spam check is invalid.';
  }
  if (data.p !== purpose || data.ip !== ipTag(ip)) return 'The anti-spam check is invalid.';
  if (!(data.e > Date.now())) return 'The anti-spam check expired. Please try again.';
  if (redeemed.has(data.id)) return 'The anti-spam check was already used. Please try again.';
  const hash = crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest();
  if (leadingZeroBits(hash) < data.d) return 'The anti-spam check was not solved.';
  redeemed.set(data.id, data.e);
  return null;
}

/** Record a completed send so the next challenges for this IP get harder. */
function recordSend(ip) {
  const times = recent.get(ip) || [];
  times.push(Date.now());
  recent.set(ip, times);
}

module.exports = { issueChallenge, redeemChallenge, recordSend, leadingZeroBits, difficultyFor };
