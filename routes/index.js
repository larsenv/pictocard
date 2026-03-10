'use strict';

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

let config;
try {
  config = require('../config');
} catch {
  config = require('../config.example');
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
    success: req.query.sent === '1'
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
  { name: 'miiFile', maxCount: 1 }
]), async (req, res) => {
  try {
    const {
      recipientEmail,
      recipientDiscord,
      senderName,
      discordDisplayName,
      cardText,
      fontFamily,
      textColor,
      presetImage,
      senderEmail
    } = req.body;

    const cardImageFile = req.files && req.files.cardImage && req.files.cardImage[0];
    const miiFile = req.files && req.files.miiFile && req.files.miiFile[0];

    // Basic validation
    if (!senderName || senderName.trim().length === 0) {
      req.session.formError = 'Sender name is required.';
      return res.redirect('/');
    }
    if (!senderEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
      req.session.formError = 'A valid sender email is required for verification.';
      return res.redirect('/');
    }
    if (!recipientEmail && !recipientDiscord) {
      req.session.formError = 'Please enter a recipient email or Discord username.';
      return res.redirect('/');
    }
    if (recipientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
      req.session.formError = 'Please enter a valid recipient email address.';
      return res.redirect('/');
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

    if (recipientEmail && emailOptOuts.has(recipientEmail.toLowerCase())) {
      req.session.formError = 'That recipient has opted out of receiving PictoCards.';
      return res.redirect('/');
    }

    const code = generateCode();
    const cardId = uuidv4();

    // Mii: read from uploaded file buffer, encode to base64 for the API
    const miiData = miiFile ? miiFile.buffer.toString('base64') : null;

    // For Discord deliveries, prefer the dedicated display name; fall back to senderName
    const displayName = (recipientDiscord && discordDisplayName && discordDisplayName.trim())
      ? discordDisplayName.trim()
      : senderName.trim();

    // Store everything needed in session (no disk persistence)
    req.session.pending = {
      cardId,
      code,
      codeExpiry: Date.now() + config.verificationCodeExpiry,
      senderEmail,
      senderName: displayName,
      recipientEmail: recipientEmail || null,
      recipientDiscord: recipientDiscord || null,
      cardText: (cardText || '').slice(0, 500),
      fontFamily: fontFamily || 'RodinNTLG',
      textColor: textColor || '#111111',
      miiData,
      imageBuffer: imageBuffer.toString('base64')
    };

    await sendVerificationCode(senderEmail, code, senderName.trim());
    res.redirect('/verify');
  } catch (err) {
    console.error('[POST /create]', err);
    req.session.formError = 'Something went wrong. Please try again.';
    res.redirect('/');
  }
});

// ── GET /verify ──────────────────────────────────────────────────────────────
router.get('/verify', (req, res) => {
  if (!req.session.pending) return res.redirect('/');
  res.render('verify', { error: null, email: req.session.pending.senderEmail });
});

// ── POST /verify ─────────────────────────────────────────────────────────────
router.post('/verify', async (req, res) => {
  const pending = req.session.pending;
  if (!pending) return res.redirect('/');

  const { code } = req.body;

  if (Date.now() > pending.codeExpiry) {
    delete req.session.pending;
    return res.render('verify', {
      error: 'Verification code expired. Please start over.',
      email: pending.senderEmail
    });
  }

  if (!code || code.trim() !== pending.code) {
    return res.render('verify', {
      error: 'Incorrect code. Please try again.',
      email: pending.senderEmail
    });
  }

  try {
    const imageBuffer = Buffer.from(pending.imageBuffer, 'base64');
    const cardBuffer = await generateCard({
      imageBuffer,
      text: pending.cardText,
      font: pending.fontFamily,
      textColor: pending.textColor,
      senderName: pending.senderName,
      miiData: pending.miiData,
      includeDate: true
    });

    // Store generated card (base64) for the send step
    req.session.pending.generatedCard = cardBuffer.toString('base64');
    // No longer need the raw image buffer in session
    delete req.session.pending.imageBuffer;

    const previewDataUrl = `data:image/png;base64,${req.session.pending.generatedCard}`;
    res.render('preview', {
      previewDataUrl,
      senderName: pending.senderName,
      recipientEmail: pending.recipientEmail,
      recipientDiscord: pending.recipientDiscord,
      cardText: pending.cardText
    });
  } catch (err) {
    console.error('[POST /verify]', err);
    res.render('verify', {
      error: 'Failed to generate card. Please try again.',
      email: pending.senderEmail
    });
  }
});

// ── POST /send ────────────────────────────────────────────────────────────────
router.post('/send', async (req, res) => {
  const pending = req.session.pending;
  if (!pending || !pending.generatedCard) return res.redirect('/');

  try {
    const cardBuffer = Buffer.from(pending.generatedCard, 'base64');

    if (pending.recipientDiscord) {
      const { sendCardToDiscordUser, isUserOptedOut } = require('../lib/discordBot');
      const username = pending.recipientDiscord.trim();
      if (isUserOptedOut(username)) {
        req.session.formError = 'That Discord user has opted out of receiving PictoCards.';
        delete req.session.pending;
        return res.redirect('/');
      }
      const result = await sendCardToDiscordUser(
        username,
        pending.senderName,
        pending.cardText,
        cardBuffer
      );
      if (!result.success) {
        return res.render('preview', {
          previewDataUrl: `data:image/png;base64,${pending.generatedCard}`,
          senderName: pending.senderName,
          recipientEmail: pending.recipientEmail,
          recipientDiscord: pending.recipientDiscord,
          cardText: pending.cardText,
          sendError: result.error
        });
      }
    } else {
      await sendCard(pending.recipientEmail, pending.senderName, pending.cardText, cardBuffer);
      // Send a delivery confirmation to the sender (fire-and-forget, don't block on error)
      sendCardConfirmation(pending.senderEmail, pending.senderName, pending.recipientEmail)
        .catch(err => console.error('[sendCardConfirmation]', err.message));
    }

    delete req.session.pending;
    res.redirect('/?sent=1');
  } catch (err) {
    console.error('[POST /send]', err);
    res.render('preview', {
      previewDataUrl: `data:image/png;base64,${pending.generatedCard}`,
      senderName: pending.senderName,
      recipientEmail: pending.recipientEmail,
      recipientDiscord: pending.recipientDiscord,
      cardText: pending.cardText,
      sendError: 'Failed to send card. Please try again.'
    });
  }
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
