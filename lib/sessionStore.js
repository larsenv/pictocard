'use strict';

// In-memory session store with limits. express-session's own MemoryStore only
// drops an expired session when it is next touched, so sessions that were
// abandoned mid-flow (each holding base64 copies of the uploaded picture and
// the rendered card) would pile up until the process ran out of memory. This
// store sweeps expired sessions on a timer and caps both the number of
// sessions and the bytes they hold, evicting the least recently saved first.

const { Store } = require('express-session');

class BoundedMemoryStore extends Store {
  /**
   * @param {object} [options]
   * @param {number} [options.maxSessions] most sessions kept at once
   * @param {number} [options.maxBytes] most serialised session bytes kept at once
   * @param {number} [options.ttlMs] lifetime for a session whose cookie has no expiry
   * @param {number} [options.sweepMs] how often expired sessions are removed
   */
  constructor({ maxSessions = 5000, maxBytes = 512 * 1024 * 1024, ttlMs = 30 * 60 * 1000, sweepMs = 60_000 } = {}) {
    super();
    this.sessions = new Map(); // sid -> { data, size, expires }
    this.bytes = 0;
    this.maxSessions = maxSessions;
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
    this.timer = setInterval(() => this.sweep(), sweepMs);
    this.timer.unref();
  }

  expiryOf(session) {
    const expires = session && session.cookie && session.cookie.expires;
    const at = expires ? new Date(expires).getTime() : NaN;
    return Number.isFinite(at) ? at : Date.now() + this.ttlMs;
  }

  remove(sid) {
    const entry = this.sessions.get(sid);
    if (!entry) return;
    this.sessions.delete(sid);
    this.bytes -= entry.size;
  }

  sweep() {
    const now = Date.now();
    for (const [sid, entry] of this.sessions) {
      if (entry.expires <= now) this.remove(sid);
    }
  }

  get(sid, callback) {
    const entry = this.sessions.get(sid);
    if (!entry) return callback(null, null);
    if (entry.expires <= Date.now()) {
      this.remove(sid);
      return callback(null, null);
    }
    try {
      callback(null, JSON.parse(entry.data));
    } catch (error) {
      this.remove(sid);
      callback(error);
    }
  }

  set(sid, session, callback) {
    let data;
    try {
      data = JSON.stringify(session);
    } catch (error) {
      return callback(error);
    }
    const size = Buffer.byteLength(data);
    if (size > this.maxBytes) {
      return callback(new Error('Session is too large to store'));
    }
    this.remove(sid);
    // Maps keep insertion order, so the first key is the least recently saved.
    while (this.sessions.size >= this.maxSessions || this.bytes + size > this.maxBytes) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    this.sessions.set(sid, { data, size, expires: this.expiryOf(session) });
    this.bytes += size;
    callback(null);
  }

  touch(sid, session, callback) {
    const entry = this.sessions.get(sid);
    if (entry) entry.expires = this.expiryOf(session);
    callback(null);
  }

  destroy(sid, callback) {
    this.remove(sid);
    callback(null);
  }

  length(callback) {
    callback(null, this.sessions.size);
  }

  clear(callback) {
    this.sessions.clear();
    this.bytes = 0;
    callback(null);
  }

  all(callback) {
    const out = {};
    for (const [sid, entry] of this.sessions) {
      try {
        out[sid] = JSON.parse(entry.data);
      } catch {
        // skip unreadable entries
      }
    }
    callback(null, out);
  }
}

module.exports = { BoundedMemoryStore };
