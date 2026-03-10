'use strict';

const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const FONTS = require('../lib/fonts');
const { sendVerificationCode, sendCard, sendCardConfirmation } = require('../lib/emailService');
const { generateCard } = require('../lib/cardGenerator');
const {
  sendVerificationCodeViaDM,
  sendConfirmationViaDM,
  isUserOptedOut: isDiscordUserOptedOut,
  sendCardToDiscordUser
} = require('../lib/discordBot');
const { decodeMiiQr } = require('../lib/miiQr');

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
        'Authorization': `Bearer ${config.moderationApiKey}`
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

/**
 * Detect if a buffer is an image file by checking magic bytes.
 * Used to decide whether to attempt QR code decoding on a Mii file upload.
 * @param {Buffer} buf
 * @returns {boolean}
 */
function looksLikeImage(buf) {
  if (!buf || buf.length < 4) return false;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
  // GIF: 47 49 46
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
  // WebP: 52 49 46 46 (RIFF)
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return true;
  return false;
}

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
    cachedPresets = fs.readdirSync(PRESETS_DIR)
      .filter(f => /\.(jpe?g|png|gif|webp)$/i.test(f))
      .map(f => `/images/presets/${f}`);
  } catch {
    cachedPresets = [];
  }
  return cachedPresets;
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ── GET / ────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.render('index', {
    fonts: FONTS,
    presets: getPresetImages(),
    error: req.session.formError || null,
    success: req.query.sent === '1',
    discordUser: req.session.discordUser || null,
    discordOAuthEnabled: !!(config.discord && config.discord.enabled &&
                            config.discord.clientId && config.discord.clientSecret &&
                            config.discord.redirectUri)
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
router.post('/create', createLimiter, upload.fields([
  { name: 'cardImage', maxCount: 1 },
  { name: 'miiFile',   maxCount: 1 }
]), async (req, res) => {
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
    const miiFile       = req.files && req.files.miiFile   && req.files.miiFile[0];

    const usingDiscord = deliveryMethod === 'discord';

    // Discord method requires OAuth authorization
    if (usingDiscord) {
      const discordOAuthEnabled = !!(config.discord && config.discord.enabled &&
                                     config.discord.clientId && config.discord.clientSecret &&
                                     config.discord.redirectUri);
      if (discordOAuthEnabled && !req.session.discordUser) {
        req.session.formError = 'You must log in with Discord before sending via Discord.';
        return res.redirect('/');
      }
    }

    // Basic validation - name required for email mode; for Discord, always use OAuth session
    let effectiveSenderName;
    if (usingDiscord) {
      // Display name comes exclusively from the OAuth session
      effectiveSenderName = (req.session.discordUser ? req.session.discordUser.displayName : '')
        || ((senderName || '').trim())
        || 'Someone';
    } else {
      if (!senderName || senderName.trim().length === 0) {
        req.session.formError = 'Sender name is required.';
        return res.redirect('/');
      }
      effectiveSenderName = senderName.trim();
    }

    // For Discord, sender username comes exclusively from OAuth session
    const senderDiscordTrimmed = usingDiscord && req.session.discordUser
      ? req.session.discordUser.username
      : '';
    if (!usingDiscord) {
      if (!senderEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
        req.session.formError = 'A valid sender email is required for verification.';
        return res.redirect('/');
      }
    }

    if (!recipientEmail && !recipientDiscord) {
      req.session.formError = 'Please enter a recipient email or Discord username.';
      return res.redirect('/');
    }
    if (recipientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      req.session.formError = 'Please enter a valid recipient email address.';
      return res.redirect('/');
    }

    // SFW check on card text via external moderation API (skipped if not configured)
    const textToCheck = (cardText || '').trim();
    if (textToCheck) {
      const flagged = await checkContentModeration(textToCheck);
      if (flagged) {
        req.session.formError = 'Please keep your message appropriate.';
        return res.redirect('/');
      }
    }

    // Image: uploaded file takes priority, then preset
    let imageBuffer = null;
    if (cardImageFile && cardImageFile.buffer) {
      imageBuffer = cardImageFile.buffer;
    } else if (presetImage) {
      const safeName = path.basename(presetImage);
      const presetPath = path.join(PRESETS_DIR, safeName);
      if (fs.existsSync(presetPath)) {
        imageBuffer = fs.readFileSync(presetPath);
      }
    }

    if (!imageBuffer) {
      req.session.formError = 'Please upload an image or select a preset.';
      return res.redirect('/');
    }

    if (recipientEmail && emailOptOuts.has(hashEmail(recipientEmail))) {
      req.session.formError = 'That recipient has opted out of receiving PictoCards.';
      return res.redirect('/');
    }

    const code = generateCode();
    const cardId = uuidv4();

    // Mii: use binary file upload
    let miiData = null;
    if (miiFile && miiFile.buffer) {
      const safeName = (miiFile.originalname || '').replace(/[\r\n\x00-\x1f]/g, '?').slice(0, 128);
      const isImage = looksLikeImage(miiFile.buffer)
        || (miiFile.mimetype && miiFile.mimetype.startsWith('image/'));
      console.log(`[mii] received miiFile: name=${safeName} size=${miiFile.buffer.length} mimetype=${miiFile.mimetype} isImage=${isImage}`);
      if (isImage) {
        // Image uploaded — try to decode as a Mii QR code
        console.log('[mii] detected image upload, attempting QR decode...');
        miiData = await decodeMiiQr(miiFile.buffer);
        if (miiData) {
          console.log(`[mii] QR decode succeeded, got ${miiData.length} bytes`);
        } else {
          console.log('[mii] QR decode failed or no Mii QR found in image');
        }
      } else {
        // Treat as raw Mii binary data
        console.log(`[mii] treating as raw binary Mii data (${miiFile.buffer.length} bytes)`);
        miiData = miiFile.buffer;
      }
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
      code,
      codeExpiry: Date.now() + config.verificationCodeExpiry,
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
      miiData,
      generatedCard: cardBuffer.toString('base64')
    };

    // Send verification code via Discord DM or email
    if (usingDiscord) {
      if (senderDiscordTrimmed || req.session.discordUser) {
        const oauthUserId = req.session.discordUser ? req.session.discordUser.id : null;
        const dmResult = await sendVerificationCodeViaDM(senderDiscordTrimmed, code, oauthUserId);
        if (!dmResult.success) {
          delete req.session.pending;
          req.session.formError = `Could not send verification code via Discord: ${dmResult.error}`;
          return res.redirect('/');
        }
      } else {
        // Discord mode but no senderDiscord and no OAuth session: cannot send verification
        req.session.formError = 'Enter your Discord username so the bot can DM you the verification code.';
        return res.redirect('/');
      }
    } else {
      await sendVerificationCode(senderEmail, code, effectiveSenderName);
    }

    res.redirect('/preview');
  } catch (err) {
    console.error('[POST /create]', err);
    req.session.formError = 'Something went wrong. Please try again.';
    res.redirect('/');
  }
});

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
    sendError
  });
});

// ── GET /verify ──────────────────────────────────────────────────────────────
router.get('/verify', (req, res) => {
  if (!req.session.pending) return res.redirect('/');
  const { senderEmail, verifyViaDiscord, senderDiscord } = req.session.pending;
  res.render('verify', {
    error: null,
    email: senderEmail,
    verifyViaDiscord: !!verifyViaDiscord,
    discordUsername: senderDiscord || null
  });
});

// ── POST /verify ─────────────────────────────────────────────────────────────
router.post('/verify', async (req, res) => {
  const pending = req.session.pending;
  if (!pending) return res.redirect('/');

  const { code, retry } = req.body;

  // If this is a retry (Discord delivery failed but code was already verified)
  const isRetry = retry === '1' && pending.codeVerified;

  if (!isRetry) {
    if (Date.now() > pending.codeExpiry) {
      delete req.session.pending;
      return res.render('verify', {
        error: 'Verification code expired. Please start over.',
        email: pending.senderEmail,
        verifyViaDiscord: !!pending.verifyViaDiscord,
        discordUsername: pending.senderDiscord || null
      });
    }

    if (!code || code.trim() !== pending.code) {
      return res.render('verify', {
        error: 'Incorrect code. Please try again.',
        email: pending.senderEmail,
        verifyViaDiscord: !!pending.verifyViaDiscord,
        discordUsername: pending.senderDiscord || null
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
        sendConfirmationViaDM(pending.senderDiscord, username, cardBuffer, pending.senderDiscordUserId)
          .catch(err => console.error('[sendConfirmationViaDM]', err));
      }
    } else {
      await sendCard(pending.recipientEmail, pending.senderName, pending.cardText, cardBuffer, pending.senderEmail);
      if (pending.senderEmail) {
        sendCardConfirmation(pending.senderEmail, pending.senderName, pending.recipientEmail, cardBuffer)
          .catch(err => console.error('[sendCardConfirmation]', err.message));
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
      discordUsername: pending.senderDiscord || null
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
  res.render('tos', { lastUpdated: '2026-03-09' });
});

// ── GET /privacy ──────────────────────────────────────────────────────────────
router.get('/privacy', (_req, res) => {
  res.render('privacy', { lastUpdated: '2026-03-09' });
});

module.exports = router;
module.exports.emailOptOuts = emailOptOuts;
module.exports.hashEmail = hashEmail;
