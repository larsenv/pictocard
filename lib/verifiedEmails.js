'use strict';

// Remembers which email addresses a Discord account has already verified, so
// the emailed code is a one-time step for signed-in Discord users.
// Persisted as hashed addresses: { "<discordUserId>": ["<sha256 hex>", ...] }

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'verified-emails.json');
const MAX_PER_USER = 20;

let config;
try {
  config = require('../config');
} catch {
  config = require('../config.example');
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function hash(email) {
  const normalized = String(email).trim().toLowerCase();
  const secret = config.optoutHashSecret || config.sessionSecret || '';
  return crypto.createHmac('sha256', secret).update(normalized).digest('hex');
}

function isVerified(discordUserId, email) {
  if (!discordUserId || !email) return false;
  const list = load()[String(discordUserId)];
  return Array.isArray(list) && list.includes(hash(email));
}

function markVerified(discordUserId, email) {
  if (!discordUserId || !email) return;
  const all = load();
  const id = String(discordUserId);
  const list = new Set(all[id] || []);
  list.add(hash(email));
  all[id] = [...list].slice(-MAX_PER_USER);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all));
  fs.renameSync(tmp, FILE);
}

module.exports = { isVerified, markVerified };
