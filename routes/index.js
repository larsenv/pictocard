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
const { validateCsrf, safeEqual } = require('../lib/middleware');
const {
  renderWork, startRender, finishRender, singleSubmission, uploadStorage, MAX_FILE_BYTES
} = require('../lib/renderWork');

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
const { sendVerificationCode, sendCard, sendCardConfirmation, prepareCardAttachment } = require('../lib/emailService');
const { generateCard } = require('../lib/cardGenerator');
const { downloadImage } = require('../lib/imageImport');
const { decodeMiiQr } = require('../lib/miiQr');
const { EXPRESSIONS, EXPRESSION_GROUPS, importCardMii, parseMiiData, validateMiiData, renderMiiImage } = require('../lib/miiAssets');

// Submitted expression, else the one already chosen, else normal
function miiExpressionOf(req) {
  const submitted = req.body?.miiExpression;
  if (EXPRESSIONS.includes(submitted)) return submitted;
  const previous = req.session.pending?.miiExpression;
  return EXPRESSIONS.includes(previous) ? previous : 'normal';
}
const wiiMail = require('../lib/wiiMail');
const { renderWiiLetter } = require('../lib/wiiPreview');
const { sendWiiMail, sendText: sendWiiText, wc24Config, isFriendCode, isValidWiiNumber } = require('../lib/wc24');
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

const { checkContentModeration } = require('../lib/moderation');

const { emailOptOuts, wiiOptOuts } = require('../lib/optouts');

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: MAX_FILE_BYTES, files: 4, fields: 32, fieldSize: 4096, parts: 36 },
  fileFilter: (_req, file, cb) => {
    if (file.fieldname === 'cardImage') {
      const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      cb(null, allowed.includes(file.mimetype));
    } else if (file.fieldname === 'wiiImage') {
      cb(null, ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype));
    } else if (['miiFile', 'wiiMii', 'miiImportFile'].includes(file.fieldname)) {
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

function formDraft(req) {
  const body = req.body || {};
  const text = (key) => typeof body[key] === 'string' ? body[key] : '';
  const method = text('deliveryMethod');
  const previous = req.session.pending || {};
  const submittedBackground = text('cardBackground');
  const cardBackground = ['light', 'dark'].includes(submittedBackground)
    ? submittedBackground : previous.cardBackground === 'dark' ? 'dark' : 'light';
  return {
    originalImage: req.draftAssets?.originalImage ?? previous.originalImage ?? null,
    miiData: req.draftAssets?.miiData !== undefined ? req.draftAssets.miiData : retainedCardMii(req),
    miiExpression: miiExpressionOf(req),
    recipientEmail: method === 'email' ? text('recipientEmail').trim() || null : null,
    recipientDiscord: method === 'discord' ? text('recipientDiscord').trim().replace(/^@/, '') || null : null,
    senderName: text('senderName').trim(),
    senderEmail: method === 'email' ? text('senderEmail').trim() || null : null,
    cardText: text('cardText').replace(/\r\n?/g, '\n'),
    fontFamily: text('fontFamily') || previous.fontFamily || 'rodinntlg',
    textColor: text('textColor') || (!submittedBackground && previous.textColor) || (cardBackground === 'dark' ? '#f5f5f7' : '#111111'),
    cardBackground,
    verifyViaDiscord: method === 'discord',
    wiiTab: method === 'wii',
    recipientWii: method === 'wii' ? text('recipientWii') || null : null,
    senderWii: method === 'wii' ? text('senderWii') || null : null,
    wiiAttach: ['image', 'card'].includes(text('wiiAttach')) ? text('wiiAttach') : 'none',
    wiiCardText: text('wiiCardText').replace(/\r\n?/g, '\n'),
    letterhead: text('letterhead'),
    wiiMiiData: req.draftAssets?.wiiMiiData ?? previous.wiiMiiData ?? previous.wii?.mii ?? null,
    wiiImage: req.draftAssets?.wiiImage ?? previous.wiiImage ?? null
  };
}

const FAQ = [
  {
    "q": "What is PictoCard?",
    "a": "PictoCard is a free service for creating and sending custom picture greeting cards. Upload a photo, write a message, pick a font and color, and deliver the card by email, as a Discord DM, or to a Nintendo Wii Message Board."
  },
  {
    "q": "Can I send a message to a Wii Message Board?",
    "a": "Yes. Enter the recipient's 16-digit Wii Number on the Send to a Wii tab. The Wii must first add PictoCard to its address book, which is a one-time friend request you can send from the Add PictoCard to your Wii page. Letters can include a Mii face, a picture, a PictoCard and a Wii letterhead."
  },
  {
    "q": "Is PictoCard free?",
    "a": "Yes. PictoCard is free and open source, with no account needed to send by email or to a Wii."
  },
  {
    "q": "How do I send a card on Discord?",
    "a": "Log in with Discord, invite the PictoCard bot to a server you share with the recipient, then enter their username on the Send via Discord tab. Signed-in Discord users do not need a verification code."
  },
  {
    "q": "Is PictoCard an alternative to Apple iCards?",
    "a": "PictoCard is inspired by the simplicity of Apple's iCards: your own image, your own text, beautiful fonts and no clutter, delivered by email, Discord or Wii."
  },
  {
    "q": "Can I send PictoCards from my Wii?",
    "a": "Yes. PictoCard for Wii is a free Homebrew Channel app. Pick any photo from your SD card, add a Mii from your Wii, and send the card by email or to a Wii Message Board. Download it from the PictoCard for Wii page."
  },
  {
    "q": "How do I stop receiving PictoCards?",
    "a": "Use the Opt Out page to opt out your email address, your Wii Number or your Discord account. You can opt back in any time."
  }
];

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
    wiiEnabled: !!wc24Config(),
    miiExpressionGroups: EXPRESSION_GROUPS,
    miiExpression: EXPRESSIONS.includes(req.session.pending?.miiExpression) ? req.session.pending.miiExpression : 'normal',
    faq: FAQ
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

const PREVIEW_PLACEHOLDER = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="640" height="640">
    <rect width="640" height="640" fill="#2b2d31"/>
    <text x="320" y="320" text-anchor="middle" fill="#dcdcdf" font-size="28">
      Choose your card image
    </text>
  </svg>
`);

function cardInputError(message) {
  const error = new Error(message);
  error.code = 'CARD_INPUT';
  return error;
}

async function readImage(req, field, stored, preset = '') {
  const file = req.files?.[field]?.[0];
  let buffer = file?.buffer || null;
  if (!buffer && preset) {
    const filename = path.join(PRESETS_DIR, path.basename(preset));
    if (fs.existsSync(filename)) buffer = fs.readFileSync(filename);
  }
  if (!buffer && req.session.pending?.[stored]) {
    buffer = Buffer.from(req.session.pending[stored], 'base64');
  }
  if (buffer && !(await isImageWithinLimits(buffer))) {
    throw cardInputError('That image is too large or invalid. Please use one under 6000×6000 pixels.');
  }
  return buffer;
}

async function readCardMii(req) {
  const file = req.files?.miiFile?.[0];
  if (!file) {
    const submitted = req.body?.cardMiiData;
    if (typeof submitted === 'string' && submitted && submitted !== 'remove') return parseMiiData(submitted);
    const stored = retainedCardMii(req);
    return stored ? parseMiiData(stored) : null;
  }
  const buffer = file.buffer;
  const isImage = file.mimetype.startsWith('image/') ||
    (buffer[0] === 0xff && buffer[1] === 0xd8) ||
    (buffer[0] === 0x89 && buffer[1] === 0x50) ||
    (buffer[0] === 0x47 && buffer[1] === 0x49) ||
    (buffer[0] === 0x52 && buffer[1] === 0x49);
  if (!isImage) return validateMiiData(buffer);
  if (!(await isImageWithinLimits(buffer))) throw cardInputError('That Mii QR image is too large or invalid.');
  const mii = await decodeMiiQr(buffer);
  if (!mii) throw cardInputError('Could not read a Mii QR code from that image. Please choose another file.');
  return mii;
}

async function preserveDraftAssets(req) {
  req.draftAssets = {};
  for (const [field, stored, preset] of [
    ['cardImage', 'originalImage', req.body?.presetImage],
    ['wiiImage', 'wiiImage', '']
  ]) {
    if (req.files?.[field]?.[0] || preset) {
      const buffer = await readImage(req, field, stored, preset);
      if (buffer) req.draftAssets[stored] = buffer.toString('base64');
    }
  }
  if (req.files?.wiiMii?.[0]) req.draftAssets.wiiMiiData = readWiiMii(req).toString('base64');
  if (req.files?.miiFile?.[0] || req.body?.cardMiiData) {
    const mii = await readCardMii(req);
    req.draftAssets.miiData = mii ? mii.toString('base64') : null;
  }
}

function retainedCardMii(req) {
  const submitted = req.body?.cardMiiData;
  if (submitted === 'remove') return null;
  if (typeof submitted === 'string' && submitted) {
    try { return parseMiiData(submitted).toString('base64'); } catch { return null; }
  }
  return req.session.pending?.miiData || null;
}

router.post('/mii-import', rateLimit({ windowMs: 60_000, max: 30 }), renderWork,
  (req, res, next) => upload.single('miiImportFile')(req, res, (error) => {
    validateCsrf(req, res, () => {
      if (error) return res.status(400).json({ error: 'Choose a Mii file under 10 MB.' });
      next();
    });
  }), async (req, res) => {
    if (!startRender(req, res)) return;
    res.set('Cache-Control', 'no-store');
    try {
      const { source, value } = req.body;
      if (source === 'qr' && req.file && !(await isImageWithinLimits(req.file.buffer))) {
        throw cardInputError('That QR image is too large or invalid.');
      }
      const mii = await importCardMii({ source, value, file: req.file?.buffer });
      const image = await renderMiiImage(mii.data, 128);
      res.json({ data: mii.data.toString('base64'), name: mii.name,
        image: `data:image/png;base64,${image.toString('base64')}` });
    } catch (error) {
      if (error.code !== 'CARD_INPUT') console.error('[mii-import]', error.message);
      res.status(error.code === 'CARD_INPUT' ? 422 : 503).json({ error: ['CARD_INPUT', 'MII_SERVICE'].includes(error.code)
        ? error.message : 'Could not load that Mii. Please try again.' });
    } finally {
      finishRender(req);
    }
  });

function readWiiMii(req) {
  const file = req.files?.wiiMii?.[0];
  if (file) {
    const mii = wiiMail.validateMii(file.buffer);
    if (!mii) throw cardInputError('The Mii face must be a Wii Mii file (74 bytes, or 76 with the checksum).');
    return mii;
  }
  const stored = req.session.pending?.wiiMiiData;
  return stored ? Buffer.from(stored, 'base64') : null;
}

const IMPORT_TYPES = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

// Fetch a picture from a URL so it doesn't have to be uploaded by hand. The
// bytes go back to the page, which puts them in the picture field like a file.
router.post('/image-import', rateLimit({ windowMs: 60_000, max: 20 }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const buffer = await downloadImage(req.body && req.body.url);
    if (!(await isImageWithinLimits(buffer))) {
      throw cardInputError('That link is not an image, or it is larger than 6000×6000 pixels.');
    }
    const { format } = await sharp(buffer).metadata();
    const type = IMPORT_TYPES[format];
    if (!type) throw cardInputError('Only JPEG, PNG, GIF or WebP images can be imported.');
    res.type(type).send(buffer);
  } catch (error) {
    const known = ['IMAGE_IMPORT', 'CARD_INPUT'].includes(error.code);
    if (!known) console.error('[image-import]', error.message);
    res.status(known ? 422 : 500).json({
      error: known ? error.message : 'Could not import that image. Please try again.'
    });
  }
});

// Small Mii face image in a chosen expression, for the picker's thumbnail.
router.get('/mii-face', rateLimit({ windowMs: 60_000, max: 60 }), renderWork, async (req, res) => {
  if (!startRender(req, res)) return;
  try {
    const expression = EXPRESSIONS.includes(req.query.expression) ? req.query.expression : 'normal';
    const data = parseMiiData(String(req.query.data || '').replace(/ /g, '+'));
    const image = await renderMiiImage(data, 128, expression);
    res.set('Cache-Control', 'private, max-age=3600').type('image/png').send(image);
  } catch (error) {
    res.status(error.code === 'CARD_INPUT' ? 422 : 503).end();
  } finally {
    finishRender(req);
  }
});

router.get('/form-token', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ csrfToken: res.locals.csrfToken });
});

router.post('/card-preview', rateLimit({
  windowMs: 60_000,
  max: 60,
  message: { error: 'Preview updates are temporarily paused. Try again in a minute.' }
}), renderWork, (req, res, next) => {
  uploadFields(req, res, (error) => {
    validateCsrf(req, res, () => {
      if (error) return res.status(400).json({ error: error.code === 'LIMIT_UPLOAD_BYTES'
        ? error.message : 'Could not read the upload. Choose a file under 10 MB.' });
      next();
    });
  });
}, async (req, res) => {
  if (!startRender(req, res)) return;
  res.set('Cache-Control', 'no-store');
  try {
    const draft = formDraft(req);
    if (draft.cardText.length > 500 || draft.wiiCardText.length > 500) {
      const error = cardInputError('Messages can contain up to 500 characters. Please shorten yours.');
      error.code = 'TEXT_OVERFLOW';
      throw error;
    }
    const wii = draft.wiiTab;
    const attach = draft.wiiAttach;
    const jpeg = wii || !draft.verifyViaDiscord;
    let buffer = null;
    if (wii && attach === 'image') {
      const source = await readImage(req, 'wiiImage', 'wiiImage');
      if (source) buffer = await wiiMail.toBaselineJpeg(source);
    } else if (!wii || attach === 'card') {
      const source = await readImage(req, 'cardImage', 'originalImage', req.body.presetImage);
      buffer = await generateCard({
        imageBuffer: source || PREVIEW_PLACEHOLDER,
        text: wii ? draft.wiiCardText.trim() || draft.cardText : draft.cardText,
        font: draft.fontFamily,
        textColor: draft.textColor,
        background: draft.cardBackground,
        miiData: await readCardMii(req),
        miiExpression: draft.miiExpression,
        includeDate: true
      });
      if (wii) buffer = await wiiMail.toBaselineJpeg(buffer);
      else if (jpeg) buffer = await prepareCardAttachment(buffer);
    }
    const letterhead = wiiMail.findLetterhead(draft.letterhead);
    const native = wii ? await renderWiiLetter({
      senderName: draft.senderName,
      text: draft.cardText,
      letterhead: draft.letterhead,
      mii: readWiiMii(req),
      jpeg: buffer
    }) : null;
    res.json({
      image: buffer ? `data:image/${jpeg ? 'jpeg' : 'png'};base64,${buffer.toString('base64')}` : null,
      wii,
      native,
      text: wii ? wiiMail.wordWrap(draft.cardText) : '',
      letterhead: wii ? letterhead?.preview || '/images/letterheads/default.png' : null,
      needsImage: wii && attach === 'image' && !buffer
    });
  } catch (error) {
    const expected = ['TEXT_OVERFLOW', 'CARD_INPUT'].includes(error.code);
    if (!expected) console.error('[card-preview]', error.message);
    res.status(expected ? 422 : error.code === 'MII_SERVICE' ? 503 : 500).json({
      error: expected || error.code === 'MII_SERVICE' ? error.message : 'Could not update the preview. Please try another image.',
      textOverflow: error.code === 'TEXT_OVERFLOW',
      textField: req.body.deliveryMethod === 'wii' && req.body.wiiAttach === 'card' &&
        typeof req.body.wiiCardText === 'string' && req.body.wiiCardText.trim()
        ? 'wiiCardText' : 'cardText'
    });
  } finally {
    finishRender(req);
  }
});

/**
 * Wii tab of POST /create: validates the Wii-specific fields (74-byte Mii,
 * baseline-JPEG attachment or PictoCard, letterhead) and stores the pending mail.
 */
async function createWiiPending(req, res, o) {
  const { redirectWithError } = o;
  const previous = req.session.pending || {};
  let imageBuffer = null;
  let picture = null;
  let cardMii = null;

  // Mii: only the 74-byte Wii format
  const mii = readWiiMii(req);

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
    picture = await readImage(req, 'wiiImage', 'wiiImage');
    if (!picture) return redirectWithError('Please choose a picture to attach.');
    jpeg = await wiiMail.toBaselineJpeg(picture);
  } else if (attach === 'card') {
    imageBuffer = await readImage(req, 'cardImage', 'originalImage', o.presetImage);
    if (!imageBuffer) return redirectWithError('Please upload an image or select a preset for the PictoCard.');
    // Mii on the PictoCard: 3DS/Wii U QR code image or raw Mii data, as in the email flow
    cardMii = await readCardMii(req);
    const card = await generateCard({
      imageBuffer,
      // Own card text if given, otherwise the letter's message
      text: (o.wiiCardText || '').trim() || o.cardText || '',
      font: o.fontFamily || 'rodinntlg',
      textColor: o.textColor || (o.cardBackground === 'dark' ? '#f5f5f7' : '#111111'),
      background: o.cardBackground,
      senderName: o.effectiveSenderName,
      miiData: cardMii,
      miiExpression: o.miiExpression,
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
    cardText: o.cardText || '',
    fontFamily: o.fontFamily || 'rodinntlg',
    textColor: o.textColor || (o.cardBackground === 'dark' ? '#f5f5f7' : '#111111'),
    cardBackground: o.cardBackground || 'light',
    wiiTab: true,
    wiiAttach: attach,
    wiiCardText: o.wiiCardText || '',
    miiExpression: o.miiExpression || 'normal',
    letterhead: letterheadId,
    wiiMiiData: mii ? mii.toString('base64') : previous.wiiMiiData || null,
    wiiImage: picture ? picture.toString('base64') : previous.wiiImage || null,
    originalImage: imageBuffer ? imageBuffer.toString('base64') : previous.originalImage || null,
    miiData: attach === 'card' ? cardMii?.toString('base64') || null : retainedCardMii(req),
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
  singleSubmission,
  renderWork,
  (req, res, next) => {
    uploadFields(req, res, (err) => {
      validateCsrf(req, res, () => {
        if (!err) return next();
        req.session.pending = formDraft(req);
        if (!(err instanceof multer.MulterError)) return next(err);
        req.session.formError = err.code === 'LIMIT_UPLOAD_BYTES' ? err.message : err.code === 'LIMIT_FILE_SIZE'
          ? 'That file is too large. Please choose one under 10 MB.'
          : 'Could not accept the upload. Please choose your files again.';
        res.redirect('/');
      });
    });
  },
  async (req, res) => {
    if (!startRender(req, res)) return;
    try {
      await preserveDraftAssets(req);
      const {
        deliveryMethod,
        recipientEmail: submittedEmail,
        recipientDiscord: submittedDiscord,
        senderName,
        cardText: submittedText,
        fontFamily: submittedFont,
        textColor: submittedColor,
        cardBackground: submittedBackground,
        presetImage,
        senderEmail,
        recipientWii,
        senderWii,
        wiiCardText: submittedCardText,
        wiiAttach,
        letterhead
      } = req.body || {};

      const usingDiscord = deliveryMethod === 'discord';
      const usingWii = deliveryMethod === 'wii';
      const cardBackground = formDraft(req).cardBackground;
      const fontFamily = submittedFont || req.session.pending?.fontFamily || 'rodinntlg';
      const textColor = submittedColor || (!submittedBackground && req.session.pending?.textColor) ||
        (cardBackground === 'dark' ? '#f5f5f7' : '#111111');
      const cardText = typeof submittedText === 'string' ? submittedText.replace(/\r\n?/g, '\n') : '';
      const wiiCardText = typeof submittedCardText === 'string' ? submittedCardText.replace(/\r\n?/g, '\n') : '';
      const recipientEmail = deliveryMethod === 'email' ? submittedEmail : null;
      const recipientDiscord = usingDiscord && typeof submittedDiscord === 'string'
        ? submittedDiscord.trim().replace(/^@/, '') : null;

      // A failed edit keeps reusable uploads but invalidates the old sendable card.
      function redirectWithError(message) {
        req.session.formError = message;
        req.session.pending = formDraft(req);
        return res.redirect('/');
      }

      if (!['email', 'discord', 'wii'].includes(deliveryMethod)) {
        return redirectWithError('Please select a delivery method.');
      }
      if (cardText.length > 500 || wiiCardText.length > 500) {
        return redirectWithError('Messages can contain up to 500 characters. Please shorten yours.');
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
        if (!isValidWiiNumber(wiiCode)) return redirectWithError("That doesn't look like a valid Wii Number. Please check it for typos.");
        if (wiiOptOuts.has(wiiCode)) return redirectWithError('That Wii has opted out of receiving PictoCards.');
        if (!(cardText || '').trim()) return redirectWithError('A message is required for Wii mail.');
      } else if (!recipientEmail && !recipientDiscord) {
        return redirectWithError('Please enter a recipient email or Discord username.');
      }
      if (recipientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
        return redirectWithError('Please enter a valid recipient email address.');
      }

      // SFW check on card text via external moderation API (skipped if not configured)
      const textToCheck = [(cardText || '').trim(), usingWii ? (wiiCardText || '').trim() : ''].filter(Boolean).join('\n');
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
          wiiCardText,
          fontFamily,
          textColor,
          cardBackground,
          miiExpression: miiExpressionOf(req),
          presetImage,
          wiiAttach,
          letterhead
        });
      }

      const imageBuffer = await readImage(req, 'cardImage', 'originalImage', presetImage);

      if (!imageBuffer) {
        return redirectWithError('Please upload an image or select a preset.');
      }

      if (recipientEmail && emailOptOuts.has(hashEmail(recipientEmail))) {
        return redirectWithError('That recipient has opted out of receiving PictoCards.');
      }

      const cardId = (req.session.pending && req.session.pending.cardId) || uuidv4();

      const miiData = await readCardMii(req);

      // Generate the card before showing the preview (before verification)
      const cardBuffer = await generateCard({
        imageBuffer,
        text: cardText,
        font: fontFamily || 'rodinntlg',
        textColor: textColor || (cardBackground === 'dark' ? '#f5f5f7' : '#111111'),
        background: cardBackground,
        senderName: effectiveSenderName,
        miiData,
        miiExpression: miiExpressionOf(req),
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
        cardText,
        fontFamily: fontFamily || 'rodinntlg',
        textColor: textColor || (cardBackground === 'dark' ? '#f5f5f7' : '#111111'),
        miiData: miiData ? miiData.toString('base64') : null,
        miiExpression: miiExpressionOf(req),
        originalImage: imageBuffer.toString('base64'),
        generatedCard: cardBuffer.toString('base64'),
        cardBackground
      };

      // A Discord user signed in through OAuth has already proven who they are,
      // so no verification code is sent to them.
      if (usingDiscord && req.session.discordUser) {
        req.session.pending.codeVerified = true;
        req.session.pending.skipVerify = true;
      }

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
      req.session.formError = ['TEXT_OVERFLOW', 'CARD_INPUT', 'MII_SERVICE'].includes(err.code)
        ? err.message : 'Something went wrong. Please try again.';
      req.session.pending = formDraft(req);
      res.redirect('/');
    } finally {
      finishRender(req);
    }
  }
);

// ── GET /preview ──────────────────────────────────────────────────────────────
router.get('/preview', async (req, res) => {
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
  let previewDataUrl = pending.wii
    ? pending.wii.jpeg
      ? `data:image/jpeg;base64,${pending.wii.jpeg}`
      : null
    : pending.recipientDiscord
      ? `data:image/png;base64,${pending.generatedCard}`
      : null;
  const sendBlocked = ['sending', 'uncertain'].includes(pending.wiiDelivery);
  const sendError = req.session.previewSendError || (sendBlocked
    ? 'Wii delivery could not be confirmed. Check the Wii Message Board before creating another send.' : null);
  delete req.session.previewSendError;
  if (!pending.wii && !pending.recipientDiscord) {
    const buffer = await prepareCardAttachment(Buffer.from(pending.generatedCard, 'base64'));
    previewDataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;
  }
  if (wii) {
    wii.native = await renderWiiLetter({
      senderName: pending.senderName,
      text: pending.cardText,
      letterhead: pending.wii.letterhead,
      mii: pending.wii.mii ? Buffer.from(pending.wii.mii, 'base64') : null,
      jpeg: pending.wii.jpeg ? Buffer.from(pending.wii.jpeg, 'base64') : null
    });
  }
  res.render('preview', {
    previewDataUrl,
    senderName: pending.senderName,
    recipientEmail: pending.recipientEmail,
    recipientDiscord: pending.recipientDiscord,
    cardText: pending.cardText,
    wii,
    sendError,
    canRetryDirectly: !!pending.codeVerified && !sendBlocked,
    sendBlocked,
    skipVerify: !!pending.skipVerify,
    domain: config.domain
  });
});

// ── POST /verify-request ──────────────────────────────────────────────────────
router.post('/verify-request', verifyRequestIpLimiter, verifyRequestTargetLimiter, async (req, res) => {
  const pending = req.session.pending;
  if (!pending || !(pending.generatedCard || pending.wii)) return res.redirect('/');

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

function saveSession(req) {
  if (!req.session.save) return Promise.resolve();
  return new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
}

// ── POST /verify ─────────────────────────────────────────────────────────────
router.post('/verify', sendIpLimiter, sendRecipientLimiter, singleSubmission, async (req, res) => {
  if (!startRender(req, res)) return;
  try {
    const pending = req.session.pending;
    if (!pending || !(pending.generatedCard || pending.wii)) return res.redirect('/');

    if (['sending', 'uncertain'].includes(pending.wiiDelivery)) return res.redirect('/preview');

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

      if (typeof code !== 'string' || !pending.code || !safeEqual(code.trim(), pending.code)) {
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
        if (wiiOptOuts.has(pending.recipientWii)) {
          req.session.formError = 'That Wii has opted out of receiving PictoCards.';
          delete req.session.pending;
          return res.redirect('/');
        }
        try {
          pending.wiiDelivery = 'sending';
          await saveSession(req);
          await sendWiiMail({
            recipient: pending.recipientWii,
            senderName: pending.senderName,
            text: pending.cardText,
            mii: pending.wii.mii ? Buffer.from(pending.wii.mii, 'base64') : null,
            jpeg: pending.wii.jpeg ? Buffer.from(pending.wii.jpeg, 'base64') : null,
            letterheadArc: pending.wii.letterhead ? wiiMail.readLetterheadArc(pending.wii.letterhead) : null
          });
        } catch (err) {
          console.error('[Send] wii FAILED', pending.recipientWii, err.message);
          pending.wiiDelivery = err.code === 'WC24_UNCERTAIN' ? 'uncertain' : 'rejected';
          req.session.previewSendError = pending.wiiDelivery === 'uncertain'
            ? 'Wii delivery could not be confirmed. Check the Wii Message Board before creating another send.'
            : 'Could not deliver the card to that Wii. Check the Wii Number and that PictoCard is in its address book.';
          await saveSession(req);
          return res.redirect('/preview');
        }
        console.log(`[Send] wii ok recipient=${pending.recipientWii}`);
        delete req.session.pending;
        await saveSession(req);
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
        console.log(`[Send] discord ok recipient=${username}`);
        if (pending.senderDiscord || pending.senderDiscordUserId) {
          sendConfirmationViaDM(
            pending.senderDiscord,
            username,
            cardBuffer,
            pending.senderDiscordUserId
          ).catch((err) => console.error('[sendConfirmationViaDM]', err));
        }
      } else {
        if (emailOptOuts.has(hashEmail(pending.recipientEmail))) {
          req.session.formError = 'That recipient has opted out of receiving PictoCards.';
          delete req.session.pending;
          return res.redirect('/');
        }
        await sendCard(
          pending.recipientEmail,
          pending.senderName,
          pending.cardText,
          cardBuffer,
          pending.senderEmail
        );
        console.log(`[Send] email ok recipient=${pending.recipientEmail}`);
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
  } finally {
    finishRender(req);
  }
});

// ── POST /send ────────────────────────────────────────────────────────────────
router.post('/send', async (req, res) => {
  // Legacy: redirect to verify flow
  const pending = req.session.pending;
  if (!pending || !(pending.generatedCard || pending.wii)) return res.redirect('/');
  res.redirect('/verify');
});

// ── GET /wii-app ──────────────────────────────────────────────────────────────
// The Homebrew Channel app (github.com/larsenv/PictoCard-Wii). Downloads come
// from the repository's rolling "latest" release, which its CI publishes.
router.get('/wii-app', (_req, res) => {
  const app = config.wiiApp || {};
  const repo = app.repo || 'https://github.com/larsenv/PictoCard-Wii';
  res.render('wii-app', {
    domain: config.domain,
    version: app.version || '1.0.0',
    sourceUrl: repo,
    releasesUrl: `${repo}/releases`,
    downloadUrl: app.downloadUrl || `${repo}/releases/latest/download/PictoCard-Wii.zip`
  });
});

// ── GET /tos ──────────────────────────────────────────────────────────────────
router.get('/tos', (_req, res) => {
  res.render('tos', { lastUpdated: '2026-03-09', domain: config.domain });
});

// ── GET /privacy ──────────────────────────────────────────────────────────────
router.get('/privacy', (_req, res) => {
  res.render('privacy', { lastUpdated: '2026-10-12', domain: config.domain });
});

module.exports = router;
module.exports.emailOptOuts = emailOptOuts;
module.exports.hashEmail = hashEmail;
