'use strict';

const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const { validateCsrf } = require('../lib/middleware');
const FONTS = require('../lib/fonts');
const { sendVerificationCode, sendCard, sendCardConfirmation } = require('../lib/emailService');
const { generateCard } = require('../lib/cardGenerator');
const { decodeMiiQr } = require('../lib/miiQr');
const {
  sendVerificationCodeViaDM,
  sendConfirmationViaDM,
  isUserOptedOut: isDiscordUserOptedOut,
  sendCardToDiscordUser
} = require('../lib/discordBot');
let config;
try {
  config = require('../config');
} catch {
  config = require('../config.example');
}

/**
 * Hash an email address for storage in the opt-out set.
 * Uses HMAC-SHA512 when a secret is configured, plain SHA-512 otherwise.
 * The email is lowercased internally before hashing.
 * @param {string} email
 * @returns {string} hex digest
 */
function hashEmail(email) {
  const normalized = email.trim().toLowerCase();
  const secret = config.optoutHashSecret;
  if (secret) {
    return crypto.createHmac('sha512', secret).update(normalized).digest('hex');
  }
  return crypto.createHash('sha512').update(normalized).digest('hex');
}

/**
 * Check card text against the OpenAI Moderation API.
 * Returns true if the text is flagged as inappropriate.
 * Silently returns false (never blocks) if the API key is not configured or the request fails.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function checkContentModeration(text) {
  if (!config.moderationApiKey || !text || !text.trim()) return false;
  try {
    const response = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.moderationApiKey}`
      },
      body: JSON.stringify({ input: text.trim() })
    });
    if (!response.ok) return false;
    const data = await response.json();
    return !!(data.results && data.results[0] && data.results[0].flagged);
  } catch {
    return false;
  }
}

// In-memory opt-out set for email addresses (no persistence)
const emailOptOuts = new Set();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (file.fieldname === 'cardImage') {
      const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      cb(null, allowed.includes(file.mimetype));
    } else if (file.fieldname === 'miiFile') {
      // Accept any file for Mii binary data
      cb(null, true);
    } else {
      cb(null, false);
    }
  }
});

const PRESETS_DIR = path.join(__dirname, '..', 'public', 'images', 'presets');

// Cache preset images once at startup to avoid repeated FS access on every request
let cachedPresets = null;
function getPresetImages() {
  if (cachedPresets !== null) return cachedPresets;
  try {
    cachedPresets = fs
      .readdirSync(PRESETS_DIR)
      .filter((f) => /\.(jpe?g|png|gif|webp)$/i.test(f))
      .map((f) => `/images/presets/${f}`);
  } catch {
    cachedPresets = [];
  }
  return cachedPresets;
}

function generateCode() {
  // Cryptographically secure 6-digit code (100000-999999)
  return String(crypto.randomInt(100000, 1000000));
}

// Maximum wrong code entries allowed per pending verification before the
// code is invalidated and a new one must be requested.
const MAX_CODE_ATTEMPTS = 5;

// ── GET / ────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.render('index', {
    fonts: FONTS,
    presets: getPresetImages(),
    error: req.session.formError || null,
    success: req.query.sent === '1',
    discordUser: req.session.discordUser || null,
    discordOAuthEnabled: !!(
      config.discord &&
      config.discord.enabled &&
      config.discord.clientId &&
      config.discord.clientSecret &&
      config.discord.redirectUri
    ),
    domain: config.domain,
    pending: req.session.pending || null
  });
  delete req.session.formError;
});

// ── POST /create ─────────────────────────────────────────────────────────────
const createLimiter = rateLimit({
  windowMs: 60_000, // 1 minute
  max: 5,
  message: 'Too many card submissions. Please wait a minute.',
  standardHeaders: true,
  legacyHeaders: false
});
// Window used by all mail/DM-sending throttles below.
const MAIL_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Build a rate limiter. When a custom keyGenerator is supplied we disable
 * express-rate-limit's built-in validations (they only understand IP-based
 * keys and would warn about our identity-based keys).
 */
function makeLimiter({ windowMs, max, message, keyGenerator }) {
  return rateLimit({
    windowMs,
    max,
    message,
    standardHeaders: true,
    legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator, validate: false } : {})
  });
}

// ── Throttles for verification-code delivery (prevents email/DM bombing) ──────
// Per-IP cap on requesting a new verification code.
const verifyRequestIpLimiter = makeLimiter({
  windowMs: MAIL_WINDOW_MS,
  max: 5,
  message: 'Too many verification requests. Please wait a few minutes and try again.'
});
// Per-target cap so one address/username can't be bombed from rotating IPs.
const verifyRequestTargetLimiter = makeLimiter({
  windowMs: MAIL_WINDOW_MS,
  max: 5,
  message: 'Too many verification requests for this recipient. Please wait a few minutes.',
  keyGenerator: (req) => {
    const p = req.session && req.session.pending;
    const target = p && (p.senderEmail || p.senderDiscordUserId || p.senderDiscord);
    return target ? `vreq:${String(target).toLowerCase()}` : `vreq-ip:${req.ip}`;
  }
});

// ── Throttles for the actual card send (prevents card/DM spam) ────────────────
// Per-IP cap on send attempts (also throttles verification-code brute force).
const sendIpLimiter = makeLimiter({
  windowMs: MAIL_WINDOW_MS,
  max: 10,
  message: 'Too many attempts. Please wait a few minutes and try again.'
});
// Per-recipient cap so a single victim can't be spammed from rotating IPs.
const sendRecipientLimiter = makeLimiter({
  windowMs: MAIL_WINDOW_MS,
  max: 5,
  message: 'Too many cards to this recipient. Please wait a few minutes.',
  keyGenerator: (req) => {
    const p = req.session && req.session.pending;
    const target = p && (p.recipientDiscord || p.recipientEmail);
    return target ? `send:${String(target).toLowerCase()}` : `send-ip:${req.ip}`;
  }
});

const uploadFields = upload.fields([
  { name: 'cardImage', maxCount: 1 },
  { name: 'miiFile', maxCount: 1 }
]);

router.post(
  '/create',
  createLimiter,
  (req, res, next) => {
    uploadFields(req, res, (err) => {
      if (err) return next(err);
      validateCsrf(req, res, next);
    });
  },
  async (req, res) => {
    try {
      const {
        deliveryMethod,
        recipientEmail,
        recipientDiscord,
        senderName,
        cardText,
        fontFamily,
        textColor,
        presetImage,
        senderEmail
      } = req.body;

      const cardImageFile = req.files && req.files.cardImage && req.files.cardImage[0];
      const miiFile = req.files && req.files.miiFile && req.files.miiFile[0];

      const usingDiscord = deliveryMethod === 'discord';

      // On a validation failure we redisplay the form. Refresh the session's
      // pending text fields with what was just submitted (keeping any existing
      // image/card data) so stale data from an earlier successful attempt
      // doesn't linger in the form - or worse, get sent - instead of this one.
      function redirectWithError(message) {
        req.session.formError = message;
        req.session.pending = {
          ...(req.session.pending || {}),
          recipientEmail: recipientEmail || null,
          recipientDiscord: recipientDiscord || null,
          senderName: (senderName || '').trim(),
          senderEmail: senderEmail || null,
          cardText: (cardText || '').slice(0, 500),
          fontFamily: fontFamily || 'RodinNTLG',
          textColor: textColor || '#111111',
          verifyViaDiscord: usingDiscord
        };
        return res.redirect('/');
      }

      // Discord method requires OAuth authorization
      if (usingDiscord) {
        const discordOAuthEnabled = !!(
          config.discord &&
          config.discord.enabled &&
          config.discord.clientId &&
          config.discord.clientSecret &&
          config.discord.redirectUri
        );
        if (discordOAuthEnabled && !req.session.discordUser) {
          return redirectWithError('You must log in with Discord before sending via Discord.');
        }
      }

      // Basic validation - name required for email mode; for Discord, always use OAuth session
      let effectiveSenderName;
      if (usingDiscord) {
        // Display name comes exclusively from the OAuth session
        effectiveSenderName =
          (req.session.discordUser ? req.session.discordUser.displayName : '') ||
          (senderName || '').trim() ||
          'Someone';
      } else {
        if (!senderName || senderName.trim().length === 0) {
          return redirectWithError('Sender name is required.');
        }
        effectiveSenderName = senderName.trim();
      }

      // For Discord, sender username comes exclusively from OAuth session
      const senderDiscordTrimmed =
        usingDiscord && req.session.discordUser ? req.session.discordUser.username : '';
      if (!usingDiscord) {
        if (!senderEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
          return redirectWithError('A valid sender email is required for verification.');
        }
      }

      if (!recipientEmail && !recipientDiscord) {
        return redirectWithError('Please enter a recipient email or Discord username.');
      }
      if (recipientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
        return redirectWithError('Please enter a valid recipient email address.');
      }

      // SFW check on card text via external moderation API (skipped if not configured)
      const textToCheck = (cardText || '').trim();
      if (textToCheck) {
        const flagged = await checkContentModeration(textToCheck);
        if (flagged) {
          return redirectWithError('Please keep your message appropriate.');
        }
      }

      // Image: uploaded file takes priority, then preset, then existing session image
      let imageBuffer = null;
      if (cardImageFile && cardImageFile.buffer) {
        imageBuffer = cardImageFile.buffer;
      } else if (presetImage) {
        const safeName = path.basename(presetImage);
        const presetPath = path.join(PRESETS_DIR, safeName);
        if (fs.existsSync(presetPath)) {
          imageBuffer = fs.readFileSync(presetPath);
        }
      } else if (req.session.pending && req.session.pending.originalImage) {
        imageBuffer = Buffer.from(req.session.pending.originalImage, 'base64');
      }

      if (!imageBuffer) {
        return redirectWithError('Please upload an image or select a preset.');
      }

      if (recipientEmail && emailOptOuts.has(hashEmail(recipientEmail))) {
        return redirectWithError('That recipient has opted out of receiving PictoCards.');
      }

      const cardId = (req.session.pending && req.session.pending.cardId) || uuidv4();

      // Mii: accept raw binary Mii data or a QR code image (decoded server-side)
      let miiData = null;
      if (miiFile && miiFile.buffer) {
        const buf = miiFile.buffer;
        const isImage =
          (miiFile.mimetype && miiFile.mimetype.startsWith('image/')) ||
          (buf[0] === 0xff && buf[1] === 0xd8) || // JPEG
          (buf[0] === 0x89 && buf[1] === 0x50) || // PNG
          (buf[0] === 0x47 && buf[1] === 0x49) || // GIF
          (buf[0] === 0x52 && buf[1] === 0x49); // WebP/RIFF
        if (isImage) {
          miiData = await decodeMiiQr(buf);
        } else {
          miiData = buf;
        }
      } else if (req.session.pending && req.session.pending.miiData) {
        // Reuse existing Mii data if no new file provided
        miiData = Buffer.from(req.session.pending.miiData, 'base64');
      }

      // Generate the card before showing the preview (before verification)
      const safeCardText = (cardText || '').slice(0, 500);
      const cardBuffer = await generateCard({
        imageBuffer,
        text: safeCardText,
        font: fontFamily || 'RodinNTLG',
        textColor: textColor || '#111111',
        senderName: effectiveSenderName,
        miiData,
        includeDate: true
      });

      // Store everything needed in session (no disk persistence)
      req.session.pending = {
        cardId,
        senderEmail: senderEmail || null,
        senderName: effectiveSenderName,
        senderDiscord: senderDiscordTrimmed || null,
        senderDiscordUserId: req.session.discordUser ? req.session.discordUser.id : null,
        verifyViaDiscord: usingDiscord,
        recipientEmail: recipientEmail || null,
        recipientDiscord: recipientDiscord || null,
        cardText: safeCardText,
        fontFamily: fontFamily || 'RodinNTLG',
        textColor: textColor || '#111111',
        miiData: miiData ? miiData.toString('base64') : null,
        originalImage: imageBuffer.toString('base64'),
        generatedCard: cardBuffer.toString('base64')
      };

      res.redirect('/preview');
    } catch (err) {
      console.error('[POST /create]', err);
      req.session.formError = 'Something went wrong. Please try again.';
      // Refresh pending text fields with this attempt's submission so the
      // re-shown form (and any later send) reflects what was just typed,
      // not a stale earlier attempt.
      req.session.pending = {
        ...(req.session.pending || {}),
        recipientEmail: req.body.recipientEmail || null,
        recipientDiscord: req.body.recipientDiscord || null,
        senderName: (req.body.senderName || '').trim(),
        senderEmail: req.body.senderEmail || null,
        cardText: (req.body.cardText || '').slice(0, 500),
        fontFamily: req.body.fontFamily || 'RodinNTLG',
        textColor: req.body.textColor || '#111111',
        verifyViaDiscord: req.body.deliveryMethod === 'discord'
      };
      res.redirect('/');
    }
  }
);

// ── GET /preview ──────────────────────────────────────────────────────────────
router.get('/preview', (req, res) => {
  const pending = req.session.pending;
  if (!pending || !pending.generatedCard) return res.redirect('/');
  const previewDataUrl = `data:image/png;base64,${pending.generatedCard}`;
  const sendError = req.session.previewSendError || null;
  delete req.session.previewSendError;
  res.render('preview', {
    previewDataUrl,
    senderName: pending.senderName,
    recipientEmail: pending.recipientEmail,
    recipientDiscord: pending.recipientDiscord,
    cardText: pending.cardText,
    sendError,
    canRetryDirectly: !!pending.codeVerified,
    domain: config.domain
  });
});

// ── POST /verify-request ──────────────────────────────────────────────────────
router.post('/verify-request', verifyRequestIpLimiter, verifyRequestTargetLimiter, async (req, res) => {
  const pending = req.session.pending;
  if (!pending) return res.redirect('/');

  try {
    const code = generateCode();
    pending.code = code;
    pending.codeExpiry = Date.now() + config.verificationCodeExpiry;
    pending.codeAttempts = 0;

    if (pending.verifyViaDiscord) {
      const dmResult = await sendVerificationCodeViaDM(
        pending.senderDiscord,
        code,
        pending.senderDiscordUserId
      );
      if (!dmResult.success) {
        req.session.previewSendError = `Could not send verification code via Discord: ${dmResult.error}`;
        return res.redirect('/preview');
      }
    } else {
      await sendVerificationCode(pending.senderEmail, code, pending.senderName);
    }
    res.redirect('/verify');
  } catch (err) {
    console.error('[POST /verify-request]', err);
    req.session.previewSendError = 'Could not send verification code. Please try again.';
    res.redirect('/preview');
  }
});

// ── GET /verify ──────────────────────────────────────────────────────────────
router.get('/verify', (req, res) => {
  if (!req.session.pending || !req.session.pending.code) return res.redirect('/');
  const { senderEmail, verifyViaDiscord, senderDiscord } = req.session.pending;
  res.render('verify', {
    error: null,
    email: senderEmail,
    verifyViaDiscord: !!verifyViaDiscord,
    discordUsername: senderDiscord || null,
    domain: config.domain
  });
});

// ── POST /verify ─────────────────────────────────────────────────────────────
router.post('/verify', sendIpLimiter, sendRecipientLimiter, async (req, res) => {
  const pending = req.session.pending;
  if (!pending) return res.redirect('/');

  const { code, retry } = req.body;

  // If this is a retry (Discord delivery failed but code was already verified)
  const isRetry = retry === '1' && pending.codeVerified;

  if (!isRetry) {
    if (Date.now() > pending.codeExpiry) {
      return res.render('verify', {
        error: 'Verification code expired. Please request a new one.',
        email: pending.senderEmail,
        verifyViaDiscord: !!pending.verifyViaDiscord,
        discordUsername: pending.senderDiscord || null,
        domain: config.domain
      });
    }

    if (!code || code.trim() !== pending.code) {
      pending.codeAttempts = (pending.codeAttempts || 0) + 1;
      // Too many wrong guesses: invalidate the code so a new one must be requested.
      if (pending.codeAttempts >= MAX_CODE_ATTEMPTS) {
        pending.code = null;
        pending.codeExpiry = 0;
        return res.render('verify', {
          error: 'Too many incorrect attempts. Please go back and request a new code.',
          email: pending.senderEmail,
          verifyViaDiscord: !!pending.verifyViaDiscord,
          discordUsername: pending.senderDiscord || null,
          domain: config.domain
        });
      }
      return res.render('verify', {
        error: 'Incorrect code. Please try again.',
        email: pending.senderEmail,
        verifyViaDiscord: !!pending.verifyViaDiscord,
        discordUsername: pending.senderDiscord || null,
        domain: config.domain
      });
    }

    // Mark code as verified for potential retry
    pending.codeVerified = true;
  }
  try {
    const cardBuffer = Buffer.from(pending.generatedCard, 'base64');

    if (pending.recipientDiscord) {
      const username = pending.recipientDiscord.trim();
      if (isDiscordUserOptedOut(username)) {
        req.session.formError = 'That Discord user has opted out of receiving PictoCards.';
        delete req.session.pending;
        return res.redirect('/');
      }
      const result = await sendCardToDiscordUser(
        username,
        pending.senderName,
        pending.cardText,
        cardBuffer,
        pending.senderDiscordUserId || null
      );
      if (!result.success) {
        req.session.previewSendError = `Could not deliver card: ${result.error}`;
        return res.redirect('/preview');
      }
      if (pending.senderDiscord || pending.senderDiscordUserId) {
        sendConfirmationViaDM(
          pending.senderDiscord,
          username,
          cardBuffer,
          pending.senderDiscordUserId
        ).catch((err) => console.error('[sendConfirmationViaDM]', err));
      }
    } else {
      await sendCard(
        pending.recipientEmail,
        pending.senderName,
        pending.cardText,
        cardBuffer,
        pending.senderEmail
      );
      if (pending.senderEmail) {
        sendCardConfirmation(
          pending.senderEmail,
          pending.senderName,
          pending.recipientEmail,
          cardBuffer
        ).catch((err) => console.error('[sendCardConfirmation]', err.message));
      }
    }

    delete req.session.pending;
    res.redirect('/?sent=1');
  } catch (err) {
    console.error('[POST /verify]', err);
    return res.render('verify', {
      error: 'Failed to send card. Please try again.',
      email: pending.senderEmail,
      verifyViaDiscord: !!pending.verifyViaDiscord,
      discordUsername: pending.senderDiscord || null,
      domain: config.domain
    });
  }
});

// ── POST /send ────────────────────────────────────────────────────────────────
router.post('/send', async (req, res) => {
  // Legacy: redirect to verify flow
  const pending = req.session.pending;
  if (!pending || !pending.generatedCard) return res.redirect('/');
  res.redirect('/verify');
});

// ── GET /tos ──────────────────────────────────────────────────────────────────
router.get('/tos', (_req, res) => {
  res.render('tos', { lastUpdated: '2026-03-09', domain: config.domain });
});

// ── GET /privacy ──────────────────────────────────────────────────────────────
router.get('/privacy', (_req, res) => {
  res.render('privacy', { lastUpdated: '2026-03-09', domain: config.domain });
});

module.exports = router;
module.exports.emailOptOuts = emailOptOuts;
module.exports.hashEmail = hashEmail;
