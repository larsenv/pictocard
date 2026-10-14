'use strict';
require('./instrument.js');
const Sentry = require('@sentry/node');
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { rateLimit, csrf } = require('./lib/middleware');

let config;
try {
  config = require('./config');
} catch {
  config = require('./config.example');
}

const { initBot } = require('./lib/discordBot');
const { startPolling: startWc24 } = require('./lib/wc24');

const app = express();

// ── View engine ──────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
const viewsPath = path.join(__dirname, 'views');
app.set('views', viewsPath);
app.use((req, res, next) => {
  res.locals.currentPath = req.path.replace(/\/+$/, '').toLowerCase() || '/';
  next();
});

// Verify views directory exists at startup
if (!fs.existsSync(viewsPath)) {
  console.error(`[Fatal] Views directory not found at: ${viewsPath}`);
}

// Trust reverse-proxy headers so req.ip is the visitor. Production runs behind
// Cloudflare and then Caddy, so two hops: with one, req.ip is whichever
// Cloudflare edge forwarded the request, which changes between requests and
// breaks per-IP rate limits and the API's IP-bound anti-spam challenges.
app.set('trust proxy', config.trustProxy ?? 2);

app.disable('x-powered-by');

// Views build URLs as `${domain}/path`, so a trailing slash in the config
// would produce `//` (e.g. https://pictocard.net//apple-touch-icon.png).
config.domain = String(config.domain || '').trim().replace(/\/+$/, '');

// A shipped placeholder secret would let anyone forge session cookies.
const DEFAULT_SECRETS = ['change-this-to-a-random-string', '', undefined];
if (DEFAULT_SECRETS.includes(config.sessionSecret)) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[Fatal] sessionSecret is not set. Set a long random value in config.js.');
    process.exit(1);
  }
  console.warn('[Security] sessionSecret is the example value - set a real one before deploying.');
}

// ── Security headers ─────────────────────────────────────────────────────────
// Scripts must come from this site (or Turnstile) or carry the per-request nonce.
app.use((_req, res, next) => {
  const nonce = require('crypto').randomBytes(16).toString('base64');
  res.locals.nonce = nonce;
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}' https://challenges.cloudflare.com`,
      "script-src-attr 'none'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      'frame-src https://challenges.cloudflare.com',
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin'
  });
  if (process.env.NODE_ENV === 'production') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// ── JSON API (Wii client) ────────────────────────────────────────────────────
// Mounted before the form parsers, sessions and CSRF: it has its own JSON
// parser and uses proof-of-work challenges instead of cookies and captchas.
app.use('/api/v1', require('./routes/api'));

// ── Body parsers ─────────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ── Sessions (in-memory, no persistent storage) ──────────────────────────────
app.use(
  session({
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
  })
);

// ── CSRF protection (all state-changing routes) ───────────────────────────────
app.use(csrf({ multipartPaths: ['/create', '/card-preview', '/mii-import'] }));

// ── robots.txt and sitemap.xml (built from the configured domain) ───────────
const SITEMAP_PAGES = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/wii', changefreq: 'monthly', priority: '0.7' },
  { path: '/wii-app', changefreq: 'monthly', priority: '0.7' },
  { path: '/optout', changefreq: 'monthly', priority: '0.3' },
  { path: '/tos', changefreq: 'monthly', priority: '0.3' },
  { path: '/privacy', changefreq: 'monthly', priority: '0.3' }
];
const AI_CRAWLERS = [
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot',
  'PerplexityBot', 'Google-Extended', 'Applebot-Extended'
];

app.get('/robots.txt', (_req, res) => {
  const lines = ['User-agent: *'];
  for (const p of ['/api/', '/preview', '/verify', '/discord', '/create', '/verify-request', '/card-preview', '/mii-import', '/image-import']) {
    lines.push(`Disallow: ${p}`);
  }
  lines.push('Allow: /', '', '# AI search and answer engines are welcome to read and cite the public pages');
  for (const bot of AI_CRAWLERS) lines.push(`User-agent: ${bot}`, 'Allow: /');
  lines.push('', `Sitemap: ${config.domain}/sitemap.xml`, '');
  res.type('text/plain').send(lines.join('\n'));
});

app.get('/sitemap.xml', (_req, res) => {
  const urls = SITEMAP_PAGES.map(
    (p) => `  <url>
    <loc>${config.domain}${p.path === '/' ? '/' : p.path}</loc>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`
  ).join('\n');
  res
    .type('application/xml')
    .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
});

// ── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/', require('./routes/index'));
app.use('/discord', require('./routes/discord'));
app.use('/optout', require('./routes/optout'));
app.use('/wii', require('./routes/wii'));

// ── 404 ──────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res
    .status(404)
    .send(
      '<h1 style="font-family:sans-serif;color:#DCDCDF;background:#1A1A1E;padding:40px;">404 - Page not found. <a href="/" style="color:#5865f2;">Go home</a></h1>'
    );
});

// ── Sentry Error Handling ────────────────────────────────────────────────────
Sentry.setupExpressErrorHandler(app);

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  Sentry.captureException(err);
  console.error(err);
  res
    .status(500)
    .send(
      '<h1 style="font-family:sans-serif;color:#DCDCDF;background:#1A1A1E;padding:40px;">Something went wrong. <a href="/" style="color:#5865f2;">Go home</a></h1>'
    );
});

// ── Start ─────────────────────────────────────────────────────────────────────
const port = Number(process.env.PORT || config.port || 3000);
app.listen(port, () => {
  console.log(`PictoCard listening on http://localhost:${port}`);
});

// Initialise Discord bot (no-op if disabled)
initBot().catch((err) => console.error('[Discord] init failed:', err.message));

// Poll WiiConnect24 for incoming Wii mail (no-op if WC24 env vars are unset)
startWc24();

module.exports = app;
