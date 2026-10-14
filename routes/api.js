'use strict';

// JSON API for clients that cannot run the web form, such as the PictoCard Wii
// homebrew app. There are no sessions, cookies or captchas here; instead every
// send is guarded by a signed proof-of-work challenge, per-IP and per-recipient
// rate limits, content moderation, opt-outs and (for email) a code sent to the
// sender's own address.

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const sharp = require('sharp');
const router = express.Router();

const FONTS = require('../lib/fonts');
const email = require('../lib/emailService');
const wiiMail = require('../lib/wiiMail');
const wc24 = require('../lib/wc24');
const { generateCard } = require('../lib/cardGenerator');
const { renderWiiLetter } = require('../lib/wiiPreview');
const { EXPRESSIONS, EXPRESSION_GROUPS, validateMiiData, renderMiiImage } = require('../lib/miiAssets');
const { renderWork, startRender, finishRender } = require('../lib/renderWork');
const { emailOptOuts, wiiOptOuts } = require('../lib/optouts');
const { checkContentModeration } = require('../lib/moderation');
const { safeEqual } = require('../lib/middleware');
const { issueChallenge, redeemChallenge, recordSend } = require('../lib/proofOfWork');
const { hashEmail } = require('./index');

let config;
try {
  config = require('../config');
} catch {
  config = require('../config.example');
}

const API_VERSION = 1;
const MAX_TEXT = 500;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 6000;
const MAX_IMAGE_PIXELS = 40_000_000;
const TICKET_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const MAX_TICKETS = 5000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WINDOW = 10 * 60 * 1000;

// Pending email sends waiting for the sender's verification code.
const tickets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of tickets) if (t.expires < now) tickets.delete(id);
}, 60_000).unref();

const enabled = () => (config.api ? config.api.enabled !== false : true);

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Identity-keyed limiters (recipient, sender) only count accepted requests, so
// a typo does not lock someone out; the per-IP limiters count everything.
function limiter(windowMs, max, message, key) {
  return rateLimit({
    windowMs,
    max,
    message: { error: message },
    standardHeaders: true,
    legacyHeaders: false,
    ...(key ? { keyGenerator: key, validate: false, skipFailedRequests: true } : {})
  });
}

const text = (v, max = MAX_TEXT) => {
  const s = typeof v === 'string' ? v.replace(/\r\n?/g, '\n') : '';
  if (s.length > max) throw new ApiError(422, `Messages can contain up to ${max} characters. Please shorten yours.`);
  return s;
};
const digits = (v) => String(v || '').replace(/[\s-]/g, '');

function decodeBase64(value, field) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new ApiError(422, `The ${field} is not valid Base64.`);
  }
  return Buffer.from(value, 'base64');
}

async function readImage(value) {
  const buffer = decodeBase64(value, 'picture');
  if (!buffer) return null;
  if (buffer.length > MAX_IMAGE_BYTES) throw new ApiError(413, 'Pictures must be under 10 MB.');
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height || meta.width > MAX_IMAGE_DIMENSION || meta.height > MAX_IMAGE_DIMENSION ||
        meta.width * meta.height > MAX_IMAGE_PIXELS) throw new Error('too large');
  } catch {
    throw new ApiError(422, 'That picture is too large or is not a JPEG, PNG, GIF or WebP image.');
  }
  return buffer;
}

function readCardMii(value) {
  const buffer = decodeBase64(value, 'Mii');
  if (!buffer) return null;
  try {
    return validateMiiData(buffer);
  } catch (error) {
    throw new ApiError(422, error.message);
  }
}

function readWiiMii(value) {
  const buffer = decodeBase64(value, 'Mii');
  if (!buffer) return null;
  const mii = wiiMail.validateMii(buffer);
  if (!mii) throw new ApiError(422, 'The Mii face must be a Wii Mii (74 bytes, or 76 with the checksum).');
  return mii;
}

const PLACEHOLDER = Buffer.from(`
  <svg xmlns="http://www.w3.org/2000/svg" width="640" height="640">
    <rect width="640" height="640" fill="#2b2d31"/>
    <text x="320" y="320" text-anchor="middle" fill="#dcdcdf" font-size="28">Choose your card image</text>
  </svg>
`);

/** Normalise the card fields shared by preview and send. */
async function readDraft(body) {
  const method = body.method === 'wii' ? 'wii' : 'email';
  const background = body.background === 'dark' ? 'dark' : 'light';
  const font = FONTS.some((f) => f.family === body.font) ? body.font : 'rodinntlg';
  const color = /^#[0-9a-f]{6}$/i.test(body.textColor || '') ? body.textColor
    : background === 'dark' ? '#f5f5f7' : '#111111';
  const letterhead = typeof body.letterhead === 'string' && body.letterhead ? body.letterhead : '';
  if (letterhead && !wiiMail.findLetterhead(letterhead)) throw new ApiError(422, 'Unknown letterhead.');
  return {
    method,
    senderName: text(body.senderName, 64).replace(/[\r\n\t]+/g, ' ').trim(),
    cardText: text(body.cardText),
    wiiCardText: text(body.wiiCardText),
    font,
    textColor: color,
    background,
    miiExpression: EXPRESSIONS.includes(body.miiExpression) ? body.miiExpression : 'normal',
    cardType: body.cardType === 'doodle' ? 'doodle' : 'card',
    wiiAttach: ['image', 'card'].includes(body.wiiAttach) ? body.wiiAttach : 'none',
    letterhead,
    image: await readImage(body.image),
    mii: readCardMii(body.mii),
    wiiMii: method === 'wii' ? readWiiMii(body.wiiMii) : null
  };
}

function renderCard(draft, { placeholder = false, signed = false } = {}) {
  const wii = draft.method === 'wii';
  return generateCard({
    doodle: draft.cardType === 'doodle' && !!draft.image,
    imageBuffer: draft.image || (placeholder ? PLACEHOLDER : null),
    text: wii ? draft.wiiCardText.trim() || draft.cardText : draft.cardText,
    font: draft.font,
    textColor: draft.textColor,
    background: draft.background,
    senderName: signed ? draft.senderName || 'Someone' : undefined,
    miiData: draft.mii,
    miiExpression: draft.miiExpression,
    includeDate: true
  });
}

/** The baseline JPEG attached to Wii mail, or null. */
async function wiiAttachment(draft, options) {
  if (draft.wiiAttach === 'image') {
    if (!draft.image) return null;
    return wiiMail.toBaselineJpeg(draft.image);
  }
  if (draft.wiiAttach === 'card') return wiiMail.toBaselineJpeg(await renderCard(draft, options));
  return null;
}

// Small baseline JPEGs that the Wii can decode and show quickly.
const forScreen = (input, width = 600, height = 440) => sharp(input)
  .flatten({ background: '#ffffff' })
  .resize({ width, height, fit: 'inside', withoutEnlargement: true })
  .jpeg({ quality: 82, progressive: false, chromaSubsampling: '4:2:0' })
  .toBuffer();

async function moderate(draft) {
  const checked = [draft.cardText.trim(), draft.method === 'wii' ? draft.wiiCardText.trim() : '']
    .filter(Boolean).join('\n');
  if (checked && (await checkContentModeration(checked))) throw new ApiError(422, 'Please keep your message appropriate.');
}

function requirePow(req, purpose) {
  const reason = redeemChallenge(req.ip, purpose, req.body && req.body.pow);
  if (reason) throw new ApiError(403, reason);
}

/** Wrap an async handler so ApiErrors become JSON responses. */
const handle = (fn) => async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await fn(req, res);
  } catch (error) {
    if (error instanceof ApiError) return res.status(error.status).json({ error: error.message });
    if (['CARD_INPUT', 'TEXT_OVERFLOW'].includes(error.code)) return res.status(422).json({ error: error.message });
    if (error.code === 'MII_SERVICE') return res.status(503).json({ error: error.message });
    console.error(`[api ${req.path}]`, error);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};

// Body parsing for this router only: pictures travel as Base64 in the JSON.
router.use(express.json({ limit: '16mb' }));
router.use((err, _req, res, next) => {
  if (!err) return next();
  res.status(err.status || 400).json({ error: err.type === 'entity.too.large'
    ? 'That request is too large. Choose a smaller picture.' : 'The request body is not valid JSON.' });
});
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!enabled()) return res.status(503).json({ error: 'The PictoCard API is turned off right now.' });
  if (req.method === 'POST' && !req.is('application/json')) {
    return res.status(415).json({ error: 'Send the request as application/json.' });
  }
  next();
});

// ── GET /api/v1/meta ──────────────────────────────────────────────────────────
// Everything a client needs to draw its form.
router.get('/meta', limiter(60_000, 30, 'Too many requests. Please wait a minute.'), (_req, res) => {
  const cfg = wc24.wc24Config();
  res.json({
    name: 'PictoCard',
    apiVersion: API_VERSION,
    minClientVersion: (config.api && config.api.minClientVersion) || '1.0.0',
    domain: config.domain,
    wiiEnabled: !!cfg,
    pictocardWiiNumber: cfg ? cfg.sender : null,
    maxTextLength: MAX_TEXT,
    cardTypes: ['card', 'doodle'],
    maxImageBytes: MAX_IMAGE_BYTES,
    fonts: FONTS.map((f) => ({ id: f.family, name: f.name })),
    letterheads: wiiMail.letterheadGroups().flatMap((g) => g.items.map((l) => ({ id: l.id, name: l.name, group: g.group }))),
    expressions: EXPRESSION_GROUPS.flatMap((g) => g.items.map(([id, name]) => ({ id, name })))
  });
});

// ── POST /api/v1/challenge ────────────────────────────────────────────────────
router.post('/challenge', limiter(60_000, 20, 'Too many requests. Please wait a minute.'), handle(async (req, res) => {
  const purpose = req.body && req.body.purpose === 'friend' ? 'friend' : 'send';
  res.json(issueChallenge(req.ip, purpose));
}));

// ── POST /api/v1/preview ──────────────────────────────────────────────────────
// Card (and, for Wii mail, the letter pages) as small JPEGs.
router.post('/preview', limiter(60_000, 30, 'Preview updates are paused. Try again in a minute.'), renderWork,
  handle(async (req, res) => {
    if (!startRender(req, res)) return;
    try {
      const draft = await readDraft(req.body || {});
      const wii = draft.method === 'wii';
      let card = null;
      if (!wii || draft.wiiAttach === 'card') card = await renderCard(draft, { placeholder: true });
      else if (draft.wiiAttach === 'image' && draft.image) card = draft.image;
      let letter = [];
      if (wii) {
        const jpeg = card ? await wiiMail.toBaselineJpeg(card) : null;
        const native = await renderWiiLetter({
          senderName: draft.senderName, text: draft.cardText, letterhead: draft.letterhead, mii: draft.wiiMii, jpeg
        });
        letter = await Promise.all(native.pages.map(async (page) =>
          (await forScreen(Buffer.from(page.split(',')[1], 'base64'), 512, 376)).toString('base64')));
      }
      res.json({
        card: card ? (await forScreen(card)).toString('base64') : null,
        letter,
        needsImage: wii && draft.wiiAttach === 'image' && !draft.image
      });
    } finally {
      finishRender(req);
    }
  }));

// ── POST /api/v1/mii-faces ────────────────────────────────────────────────────
// Rendered faces for a list of Miis (Arian Kordi's renderer), so a client can
// show them in its Mii picker. A face that cannot be rendered comes back null.
const MAX_FACES = 16;
router.post('/mii-faces', limiter(60_000, 40, 'Too many Mii previews. Please wait a minute.'), handle(async (req, res) => {
  const list = Array.isArray(req.body && req.body.miis) ? req.body.miis.slice(0, MAX_FACES) : [];
  const size = Math.min(96, Math.max(24, Number(req.body && req.body.size) || 48));
  const faces = await Promise.all(list.map(async (value) => {
    try {
      const image = await renderMiiImage(validateMiiData(decodeBase64(value, 'Mii')), size);
      return image.toString('base64');
    } catch {
      return null;
    }
  }));
  res.json({ faces });
}));

// ── POST /api/v1/send ─────────────────────────────────────────────────────────
const sendIpLimiter = limiter(WINDOW, 10, 'Too many attempts. Please wait a few minutes and try again.');
const recipientKey = (req) => {
  const b = req.body || {};
  const target = b.method === 'wii' ? digits(b.recipientWii) : String(b.recipientEmail || '').trim().toLowerCase();
  return target ? `api-send:${target}` : `api-send-ip:${req.ip}`;
};
const sendRecipientLimiter = limiter(WINDOW, 5, 'Too many cards to this recipient. Please wait a few minutes.', recipientKey);
const senderKey = (req) => {
  const b = req.body || {};
  return b.method === 'wii' ? `api-sender-ip:${req.ip}` : `api-sender:${String(b.senderEmail || '').trim().toLowerCase()}`;
};
const senderLimiter = limiter(WINDOW, 5, 'Too many verification requests. Please wait a few minutes.', senderKey);

router.post('/send', sendIpLimiter, sendRecipientLimiter, senderLimiter, renderWork, handle(async (req, res) => {
  if (!startRender(req, res)) return;
  try {
    const body = req.body || {};
    const draft = await readDraft(body);
    if (draft.method === 'wii') return await sendWii(req, res, draft, body);

    const recipientEmail = String(body.recipientEmail || '').trim();
    const senderEmail = String(body.senderEmail || '').trim();
    if (!draft.senderName) throw new ApiError(422, 'Your name is required.');
    if (!EMAIL_RE.test(recipientEmail) || recipientEmail.length > 254) {
      throw new ApiError(422, 'Please enter a valid recipient email address.');
    }
    if (!EMAIL_RE.test(senderEmail) || senderEmail.length > 254) {
      throw new ApiError(422, 'A valid sender email is required for verification.');
    }
    if (!draft.image) {
      throw new ApiError(422, draft.cardType === 'doodle' ? 'Please draw a doodle for your card.' : 'Please choose a picture for your card.');
    }
    requirePow(req, 'send');
    if (emailOptOuts.has(hashEmail(recipientEmail))) {
      throw new ApiError(422, 'That recipient has opted out of receiving PictoCards.');
    }
    await moderate(draft);

    const card = await renderCard(draft, { signed: true });
    if (tickets.size >= MAX_TICKETS) throw new ApiError(503, 'PictoCard is busy. Please try again shortly.');
    const id = crypto.randomBytes(18).toString('base64url');
    const code = String(crypto.randomInt(100000, 1000000));
    tickets.set(id, {
      ip: req.ip, code, attempts: 0, expires: Date.now() + TICKET_TTL_MS,
      card, recipientEmail, senderEmail, senderName: draft.senderName, cardText: draft.cardText
    });
    try {
      await email.sendVerificationCode(senderEmail, code, draft.senderName);
    } catch (error) {
      tickets.delete(id);
      throw error;
    }
    res.json({ status: 'verify', ticket: id, email: senderEmail, expiresIn: TICKET_TTL_MS / 1000 });
  } finally {
    finishRender(req);
  }
}));

async function sendWii(req, res, draft, body) {
  if (!wc24.wc24Config()) throw new ApiError(503, "Wii delivery isn't set up yet. Please check back soon.");
  const recipient = digits(body.recipientWii);
  if (!wc24.isFriendCode(recipient)) throw new ApiError(422, 'Enter the 16-digit Wii Number.');
  if (!wc24.isValidWiiNumber(recipient)) throw new ApiError(422, "That doesn't look like a valid Wii Number. Please check it for typos.");
  // The Wii app may send a picture on its own; the website always asks for a message.
  const pictureOnly = draft.wiiAttach === 'image' && !!draft.image && !draft.cardText.trim();
  if (!draft.cardText.trim() && !pictureOnly) throw new ApiError(422, 'A message is required for Wii mail.');
  if (draft.wiiAttach === 'image' && !draft.image) throw new ApiError(422, 'Please choose a picture to attach.');
  if (draft.wiiAttach === 'card' && !draft.image) {
    throw new ApiError(422, 'Please choose a picture for the PictoCard.');
  }
  requirePow(req, 'send');
  if (wiiOptOuts.has(recipient)) throw new ApiError(422, 'That Wii has opted out of receiving PictoCards.');
  await moderate(draft);
  const senderName = draft.senderName || 'Someone';
  const jpeg = await wiiAttachment(draft, { signed: true });
  try {
    await wc24.sendWiiMail({
      recipient,
      senderName,
      text: draft.cardText,
      pictureOnly,
      mii: draft.wiiMii,
      jpeg,
      letterheadArc: draft.letterhead ? wiiMail.readLetterheadArc(draft.letterhead) : null
    });
  } catch (error) {
    console.error('[api send] wii FAILED', recipient, error.message);
    throw new ApiError(502, error.code === 'WC24_UNCERTAIN'
      ? 'Wii delivery could not be confirmed. Check the Wii Message Board before sending again.'
      : 'Could not deliver the card to that Wii. Check the Wii Number and that PictoCard is in its address book.');
  }
  recordSend(req.ip);
  console.log(`[api send] wii ok recipient=${recipient}`);
  res.json({ status: 'sent' });
}

// ── POST /api/v1/verify ───────────────────────────────────────────────────────
const verifyLimiter = limiter(WINDOW, 15, 'Too many attempts. Please wait a few minutes and try again.');
router.post('/verify', verifyLimiter, handle(async (req, res) => {
  const body = req.body || {};
  const ticket = typeof body.ticket === 'string' ? tickets.get(body.ticket) : null;
  if (!ticket || ticket.expires < Date.now() || ticket.ip !== req.ip) {
    throw new ApiError(410, 'This card expired. Please send it again.');
  }
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!safeEqual(code, ticket.code)) {
    ticket.attempts++;
    if (ticket.attempts >= MAX_CODE_ATTEMPTS) {
      tickets.delete(body.ticket);
      throw new ApiError(410, 'Too many incorrect attempts. Please send the card again.');
    }
    throw new ApiError(422, 'Incorrect code. Please try again.');
  }
  tickets.delete(body.ticket);
  if (emailOptOuts.has(hashEmail(ticket.recipientEmail))) {
    throw new ApiError(422, 'That recipient has opted out of receiving PictoCards.');
  }
  await email.sendCard(ticket.recipientEmail, ticket.senderName, ticket.cardText, ticket.card, ticket.senderEmail);
  email.sendCardConfirmation(ticket.senderEmail, ticket.senderName, ticket.recipientEmail, ticket.card)
    .catch((error) => console.error('[api sendCardConfirmation]', error.message));
  recordSend(req.ip);
  console.log(`[api send] email ok recipient=${ticket.recipientEmail}`);
  res.json({ status: 'sent' });
}));

// ── POST /api/v1/wii-friend ───────────────────────────────────────────────────
// Same as the /wii page: PictoCard sends this Wii a friend request.
router.post('/wii-friend', limiter(WINDOW, 5, 'Too many requests. Please wait a few minutes and try again.'),
  handle(async (req, res) => {
    if (!wc24.wc24Config()) throw new ApiError(503, "Wii delivery isn't set up yet. Please check back soon.");
    const code = digits(req.body && req.body.wiiNumber);
    if (!wc24.isFriendCode(code)) throw new ApiError(422, 'Enter your 16-digit Wii Number.');
    if (!wc24.isValidWiiNumber(code)) throw new ApiError(422, "That doesn't look like a valid Wii Number. Please check it for typos.");
    requirePow(req, 'friend');
    try {
      const result = await wc24.requestFriend(code);
      res.json({ status: result === 'already' ? 'already' : 'sent' });
    } catch (error) {
      console.error('[api wii-friend]', error.message);
      throw new ApiError(502, error.code === 'WC24_UNCERTAIN'
        ? 'The friend request could not be confirmed. Check your Wii address book before trying again.'
        : 'Could not send the friend request. Please try again later.');
    }
  }));

router.use((_req, res) => res.status(404).json({ error: 'Unknown API endpoint.' }));

module.exports = router;
module.exports.tickets = tickets;
