'use strict';

// Persistent opt-out lists. Email addresses are stored hashed, Wii Numbers and
// Discord usernames as plain values. Stored in data/optouts.json so opt-outs
// survive restarts.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'optouts.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

const state = load();

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error('[optouts] could not save:', err.message);
  }
}

function list(kind, normalize = (v) => v) {
  const set = new Set((state[kind] || []).map(String));
  const persist = () => {
    state[kind] = [...set];
    save();
  };
  return {
    has: (v) => set.has(normalize(v)),
    add: (v) => {
      set.add(normalize(v));
      persist();
    },
    delete: (v) => {
      set.delete(normalize(v));
      persist();
    }
  };
}

const emailOptOuts = list('email'); // values are already hashed by the caller
const wiiOptOuts = list('wii', (v) => String(v).replace(/[\s-]/g, ''));
const discordOptOuts = list('discord', (v) => String(v).trim().toLowerCase());

module.exports = { emailOptOuts, wiiOptOuts, discordOptOuts };
