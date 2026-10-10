'use strict';

const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const sharp = require('sharp');
const { validateCsrf } = require('../lib/middleware');

// Reject decompression bombs: images whose pixel dimensions blow up memory/CPU
// even though the compressed file is under the multer size limit.
const MAX_IMAGE_DIMENSION = 6000; // px per side
const MAX_IMAGE_PIXELS = 40_000_000; // 40 megapixels

/**
 * Cheaply read image header metadata (no full decode) and confirm the pixel
 * dimensions are within safe bounds.
 * @param {Buffer} buffer
 * @returns {Promise<boolean>}
 */
async function isImageWithinLimits(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) return false;
    if (meta.width > MAX_IMAGE_DIMENSION || meta.height > MAX_IMAGE_DIMENSION) return false;
    if (meta.width * meta.height > MAX_IMAGE_PIXELS) return false;
    return true;
  } catch {
    return false;
  }
}
const FONTS = require('../lib/fonts');
const { sendVerificationCode, sendCard, sendCardConfirmation } = require('../lib/emailService');
const { generateCard } = require('../lib/cardGenerator');
const { decodeMiiQr } = require('../lib/miiQr');
const wiiMail = require('../lib/wiiMail');
const { sendWiiMail, sendText: sendWiiText, wc24Config, isFriendCode } = require('../lib/wc24');
const { verifyTurnstile, siteKey: turnstileSiteKey } = require('../lib/turnstile');
const { isVerified: isEmailVerified, markVerified: markEmailVerified } = require('../lib/verifiedEmails');
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
    } else if (file.fieldname === 'wiiImage') {
      cb(null, ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype));
    } else if (file.fieldname === 'miiFile' || file.fieldname === 'wiiMii') {
      // Accept any file for Mii binary data (wiiMii is validated to exactly 74 bytes later)
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
    pending: req.session.pending || null,
    turnstileSiteKey: turnstileSiteKey(),
    letterheadGroups: wiiMail.letterheadGroups(),
    wiiEnabled: !!wc24Config()
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
    const target = p && (p.senderEmail || p.senderWii || p.senderDiscordUserId || p.senderDiscord);
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
    const target = p && (p.recipientDiscord || p.recipientEmail || p.recipientWii);
    return target ? `send:${String(target).toLowerCase()}` : `send-ip:${req.ip}`;
  }
});

const uploadFields = upload.fields([
  { name: 'cardImage', maxCount: 1 },
  { name: 'miiFile', maxCount: 1 },
  { name: 'wiiMii', maxCount: 1 },
  { name: 'wiiImage', maxCount: 1 }
]);

/**
 * Wii tab of POST /create: validates the Wii-specific fields (74-byte Mii,
 * baseline-JPEG attachment or PictoCard, letterhead) and stores the pending mail.
 */
async function createWiiPending(req, res, o) {
  const { redirectWithError } = o;
  const files = req.files || {};

  // Mii: only the 74-byte Wii format
  let mii = null;
  const miiFile = files.wiiMii && files.wiiMii[0];
  if (miiFile) {
    mii = wiiMail.validateMii(miiFile.buffer);
    if (!mii) return redirectWithError('The Mii must be a Wii Mii file of exactly 74 bytes.');
  }

  // Letterhead (optional)
  let letterheadId = '';
  if (o.letterhead) {
    if (!wiiMail.findLetterhead(o.letterhead)) return redirectWithError('Unknown letterhead.');
    letterheadId = o.letterhead;
  }

  // Attachment (optional): an uploaded picture or the generated PictoCard
  const attach = ['image', 'card'].includes(o.wiiAttach) ? o.wiiAttach : 'none';
  let jpeg = null;
  if (attach === 'image') {
    const f = files.wiiImage && files.wiiImage[0];
    const source = f ? f.buffer : null;
    if (!source) return redirectWithError('Please choose a picture to attach.');
    if (!(await isImageWithinLimits(source))) {
      return redirectWithError('That image is too large or not a valid image. Please use one under 6000×6000 pixels.');
    }
    jpeg = await wiiMail.toBaselineJpeg(source);
  } else if (attach === 'card') {
    let imageBuffer = null;
    const f = files.cardImage && files.cardImage[0];
    if (f && f.buffer) {
      if (!(await isImageWithinLimits(f.buffer))) {
        return redirectWithError('That image is too large or not a valid image. Please use one under 6000×6000 pixels.');
      }
      imageBuffer = f.buffer;
    } else if (o.presetImage) {
      const presetPath = path.join(PRESETS_DIR, path.basename(o.presetImage));
      if (fs.existsSync(presetPath)) imageBuffer = fs.readFileSync(presetPath);
    }
    if (!imageBuffer) return redirectWithError('Please upload an image or select a preset for the PictoCard.');
    const card = await generateCard({
      imageBuffer,
      text: (o.cardText || '').slice(0, 500),
      font: o.fontFamily || 'RodinNTLG',
      textColor: o.textColor || '#111111',
      senderName: o.effectiveSenderName,
      miiData: null, // the Mii travels in the mail header instead
      includeDate: true
    });
    jpeg = await wiiMail.toBaselineJpeg(card);
  }

  req.session.pending = {
    cardId: uuidv4(),
    senderEmail: null,
    senderWii: o.senderWiiCode || null,
    senderName: o.effectiveSenderName,
    senderDiscord: null,
    senderDiscordUserId: req.session.discordUser ? req.session.discordUser.id : null,
    verifyViaDiscord: false,
    recipientEmail: null,
    recipientDiscord: null,
    recipientWii: o.wiiCode,
    cardText: (o.cardText || '').slice(0, 500),
    fontFamily: o.fontFamily || 'RodinNTLG',
    textColor: o.textColor || '#111111',
    wiiTab: true,
    wii: {
      mii: mii ? mii.toString('base64') : null,
      attach,
      jpeg: jpeg ? jpeg.toString('base64') : null,
      letterhead: letterheadId
    }
  };

  // Wii mail has no verification step (Turnstile and rate limits guard it)
  req.session.pending.codeVerified = true;
  req.session.pending.skipVerify = true;
  return res.redirect('/preview');
}

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
        senderEmail,
        recipientWii,
        senderWii,
        wiiAttach,
        letterhead
      } = req.body || {};

      const cardImageFile = req.files && req.files.cardImage && req.files.cardImage[0];
      const miiFile = req.files && req.files.miiFile && req.files.miiFile[0];

      const usingDiscord = deliveryMethod === 'discord';
      const usingWii = deliveryMethod === 'wii';

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
          verifyViaDiscord: usingDiscord,
          wiiTab: usingWii,
          recipientWii: recipientWii || null,
          senderWii: senderWii || null
        };
        return res.redirect('/');
      }

      // Turnstile captcha guards every submission (email and Discord alike).
      if (!(await verifyTurnstile(req.body && req.body['cf-turnstile-response'], req.ip))) {
        return redirectWithError('Captcha verification failed. Please try again.');
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
      } else if (usingWii) {
        // Wii mail only needs a Wii Number; the name is optional
        effectiveSenderName = (senderName || '').trim() || 'Someone';
      } else {
        if (!senderName || senderName.trim().length === 0) {
          return redirectWithError('Sender name is required.');
        }
        effectiveSenderName = senderName.trim();
      }

      // For Discord, sender username comes exclusively from OAuth session
      const senderDiscordTrimmed =
        usingDiscord && req.session.discordUser ? req.session.discordUser.username : '';
      if (!usingDiscord && !usingWii) {
        if (!senderEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
          return redirectWithError('A valid sender email is required for verification.');
        }
      }

      const senderWiiCode = usingWii ? String(senderWii || '').replace(/[\s-]/g, '') : '';
      const wiiCode = usingWii ? String(recipientWii || '').replace(/[\s-]/g, '') : '';
      if (usingWii) {
        if (!wc24Config()) return redirectWithError("Wii delivery isn't set up yet. Please check back soon.");
        if (!isFriendCode(wiiCode)) return redirectWithError('Enter the 16-digit Wii Number.');
        if (senderWiiCode && !isFriendCode(senderWiiCode)) return redirectWithError('Your Wii Number must be 16 digits.');
        if (!(cardText || '').trim()) return redirectWithError('A message is required for Wii mail.');
      } else if (!recipientEmail && !recipientDiscord) {
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

      if (usingWii) {
        return await createWiiPending(req, res, {
          redirectWithError,
          wiiCode,
          senderWiiCode,
          effectiveSenderName,
          cardText,
          fontFamily,
          textColor,
          presetImage,
          wiiAttach,
          letterhead
        });
      }

      // Image: uploaded file takes priority, then preset, then existing session image
      let imageBuffer = null;
      if (cardImageFile && cardImageFile.buffer) {
        if (!(await isImageWithinLimits(cardImageFile.buffer))) {
          return redirectWithError(
            'That image is too large or not a valid image. Please use one under 6000×6000 pixels.'
          );
        }
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
          if (!(await isImageWithinLimits(buf))) {
            return redirectWithError(
              'That Mii QR image is too large or invalid. Please use one under 6000×6000 pixels.'
            );
          }
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

      // Email verification is a one-time step: a signed-in Discord user who has
      // already verified this sender address may skip the emailed code. The
      // Turnstile check above is the guard on this path.
      if (
        !usingDiscord &&
        req.session.discordUser &&
        isEmailVerified(req.session.discordUser.id, senderEmail)
      ) {
        req.session.pending.codeVerified = true;
        req.session.pending.skipVerify = true;
      }

      res.redirect('/preview');
    } catch (err) {
      console.error('[POST /create]', err);
      req.session.formError = 'Something went wrong. Please try again.';
      // Refresh pending text fields with this attempt's submission so the
      // re-shown form (and any later send) reflects what was just typed,
      // not a stale earlier attempt.
      const body = req.body || {};
      req.session.pending = {
        ...(req.session.pending || {}),
        recipientEmail: body.recipientEmail || null,
        recipientDiscord: body.recipientDiscord || null,
        senderName: (body.senderName || '').trim(),
        senderEmail: body.senderEmail || null,
        cardText: (body.cardText || '').slice(0, 500),
        fontFamily: body.fontFamily || 'RodinNTLG',
        textColor: body.textColor || '#111111',
        verifyViaDiscord: body.deliveryMethod === 'discord',
        wiiTab: body.deliveryMethod === 'wii',
        recipientWii: body.recipientWii || null,
        senderWii: body.senderWii || null
      };
      res.redirect('/');
    }
  }
);

// ── GET /preview ──────────────────────────────────────────────────────────────
router.get('/preview', (req, res) => {
  const pending = req.session.pending;
  if (!pending || !(pending.generatedCard || pending.wii)) return res.redirect('/');
  const wii = pending.wii
    ? {
        recipient: pending.recipientWii,
        hasMii: !!pending.wii.mii,
        attach: pending.wii.attach,
        letterhead: wiiMail.findLetterhead(pending.wii.letterhead)
      }
    : null;
  const previewDataUrl = pending.wii
    ? pending.wii.jpeg
      ? `data:image/jpeg;base64,${pending.wii.jpeg}`
      : null
    : `data:image/png;base64,${pending.generatedCard}`;
  const sendError = req.session.previewSendError || null;
  delete req.session.previewSendError;
  res.render('preview', {
    previewDataUrl,
    senderName: pending.senderName,
    recipientEmail: pending.recipientEmail,
    recipientDiscord: pending.recipientDiscord,
    cardText: pending.cardText,
    wii,
    sendError,
    canRetryDirectly: !!pending.codeVerified,
    skipVerify: !!pending.skipVerify,
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
    } else if (pending.wii) {
      await sendWiiText(
        pending.senderWii,
        `Your PictoCard verification code is ${code}. It expires in 10 minutes. If you did not request this, ignore this letter.`
      );
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
    verifyViaWii: !!req.session.pending.senderWii,
    wiiNumber: req.session.pending.senderWii || null,
    discordUsername: senderDiscord || null,
    domain: config.domain
  });
});

// ── POST /verify ─────────────────────────────────────────────────────────────
router.post('/verify', sendIpLimiter, sendRecipientLimiter, async (req, res) => {
  const pending = req.session.pending;
  if (!pending) return res.redirect('/');

  const { code, retry } = req.body || {};

  // If this is a retry (Discord delivery failed but code was already verified)
  const isRetry = retry === '1' && pending.codeVerified;

  if (!isRetry) {
    if (Date.now() > pending.codeExpiry) {
      return res.render('verify', {
        error: 'Verification code expired. Please request a new one.',
        email: pending.senderEmail,
        verifyViaDiscord: !!pending.verifyViaDiscord,
        verifyViaWii: !!pending.senderWii,
        wiiNumber: pending.senderWii || null,
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
        verifyViaWii: !!pending.senderWii,
        wiiNumber: pending.senderWii || null,
          discordUsername: pending.senderDiscord || null,
          domain: config.domain
        });
      }
      return res.render('verify', {
        error: 'Incorrect code. Please try again.',
        email: pending.senderEmail,
        verifyViaDiscord: !!pending.verifyViaDiscord,
        verifyViaWii: !!pending.senderWii,
        wiiNumber: pending.senderWii || null,
        discordUsername: pending.senderDiscord || null,
        domain: config.domain
      });
    }

    // Mark code as verified for potential retry
    pending.codeVerified = true;
    // Remember the address for this Discord account so it is a one-time step
    if (!pending.verifyViaDiscord && req.session.discordUser) {
      try {
        markEmailVerified(
          req.session.discordUser.id,
          pending.wii ? `wii:${pending.senderWii}` : pending.senderEmail
        );
      } catch (err) {
        console.error('[verifiedEmails]', err.message);
      }
    }
  }
  try {
    if (pending.wii) {
      try {
        await sendWiiMail({
          recipient: pending.recipientWii,
          senderName: pending.senderName,
          text: pending.cardText,
          mii: pending.wii.mii ? Buffer.from(pending.wii.mii, 'base64') : null,
          jpeg: pending.wii.jpeg ? Buffer.from(pending.wii.jpeg, 'base64') : null,
          letterheadArc: pending.wii.letterhead ? wiiMail.readLetterheadArc(pending.wii.letterhead) : null
        });
      } catch (err) {
        console.error('[Wii mail]', err.message);
        req.session.previewSendError = 'Could not deliver the card to that Wii. Check the Wii Number and that PictoCard is in its address book.';
        return res.redirect('/preview');
      }
      delete req.session.pending;
      return res.redirect('/?sent=1');
    }

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
        verifyViaWii: !!pending.senderWii,
        wiiNumber: pending.senderWii || null,
      discordUsername: pending.senderDiscord || null,
      domain: config.domain
    });
  }
});

// ── POST /send ────────────────────────────────────────────────────────────────
router.post('/send', async (req, res) => {
  // Legacy: redirect to verify flow
  const pending = req.session.pending;
  if (!pending || !(pending.generatedCard || pending.wii)) return res.redirect('/');
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
