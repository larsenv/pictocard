'use strict';

const Sentry = require('@sentry/node');

// Initialise Sentry early — before any other require — so it can instrument imports.
// Set the SENTRY_DSN environment variable to enable error reporting.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    // Disable performance tracing — only capture exceptions
    tracesSampleRate: 0
  });
}

const express = require('express');
const session = require('express-session');
const path = require('path');
const { rateLimit, csrf } = require('./lib/middleware');

let config;
try {
  config = require('./config');
} catch {
  config = require('./config.example');
}

const { initBot } = require('./lib/discordBot');

const app = express();

// ── View engine ──────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Trust reverse-proxy headers (needed for req.ip behind nginx/Caddy)
app.set('trust proxy', 1);

// ── Body parsers ─────────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ── Sessions (in-memory, no persistent storage) ──────────────────────────────
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    // Set secure:true when the app is served over HTTPS (production).
    // Behind a reverse proxy, ensure trust proxy is enabled above.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 60 * 1000 // 30 minutes
  }
}));

// ── CSRF protection (all state-changing routes) ───────────────────────────────
app.use(csrf());

// ── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/', require('./routes/index'));
app.use('/discord', require('./routes/discord'));
app.use('/optout', require('./routes/optout'));

// ── 404 ──────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).send('<h1 style="font-family:sans-serif;color:#DCDCDF;background:#1A1A1E;padding:40px;">404 – Page not found. <a href="/" style="color:#5865f2;">Go home</a></h1>');
});

// ── Error handler ─────────────────────────────────────────────────────────────
// Sentry must capture the error before the generic handler sends a response.
if (process.env.SENTRY_DSN) {
  app.use(Sentry.expressErrorHandler());
}

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).send('<h1 style="font-family:sans-serif;color:#DCDCDF;background:#1A1A1E;padding:40px;">Something went wrong. <a href="/" style="color:#5865f2;">Go home</a></h1>');
});

// ── Start ─────────────────────────────────────────────────────────────────────
const port = config.port || 3000;
app.listen(port, () => {
  console.log(`PictoCard listening on http://localhost:${port}`);
});

// Initialise Discord bot (no-op if disabled)
initBot().catch(err => console.error('[Discord] init failed:', err.message));

module.exports = app;
