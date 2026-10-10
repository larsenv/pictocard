'use strict';

// Building blocks for Wii Message Board mail: baseline JPEG conversion, Mii
// validation, letterhead lookup and the multipart mail itself.
// Formats follow WiiLink24/Mail-Admin (mail layout, X-WiiFace, letterhead part)
// and WiiLink24/Mail-Server (baseline JPEG conversion).

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const CRLF = '\r\n';
const MII_SIZE = 74; // RFLCharData, the only Mii format accepted
const MAX_MAIL_SIZE = 1578040; // largest mail the Wii/KD accepts
const MAX_IMAGE_DIMENSION = 8192;
const MAX_TEXT_CHARS = 500;

const LETTERHEAD_DIR = path.join(__dirname, '..', 'data', 'letterheads');
const LETTERHEAD_PREVIEW_URL = '/images/letterheads';

// ── Mii ──────────────────────────────────────────────────────────────────────
/**
 * 74 bytes is RFLCharData. A 76-byte Wii Mii (RFLStoreData) carries 2 extra
 * checksum bytes at the end, which are cut off.
 * @returns {Buffer|null} the 74-byte Mii, or null for any other size
 */
function validateMii(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length === MII_SIZE + 2) return buffer.subarray(0, MII_SIZE);
  return buffer.length === MII_SIZE ? buffer : null;
}

// ── Baseline JPEG ────────────────────────────────────────────────────────────
// The Wii cannot decode progressive JPEGs. Walk the JPEG markers: SOF0/SOF1 are
// baseline/extended-sequential, SOF2 is progressive.
function jpegKind(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xc0 || marker === 0xc1) return 'baseline';
    if (marker >= 0xc2 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return 'other';
    if (marker === 0xda) return null; // start of scan without a frame header
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/**
 * Convert any supported image into a baseline JPEG the Wii can display.
 * Already-baseline JPEGs within limits are passed through untouched; everything
 * else (PNG/GIF/WebP/progressive JPEG) is re-encoded as baseline, 4:2:0, with
 * transparency flattened to white and EXIF orientation applied.
 * Output is kept under maxBytes by lowering quality, then dimensions.
 * @param {Buffer} input
 * @param {number} [maxBytes]
 * @returns {Promise<Buffer>}
 */
async function toBaselineJpeg(input, maxBytes = 900 * 1024) {
  const meta = await sharp(input).metadata();
  const fits = Math.max(meta.width || 0, meta.height || 0) <= MAX_IMAGE_DIMENSION;
  if (jpegKind(input) === 'baseline' && fits && !(meta.orientation > 1) && input.length <= maxBytes) {
    return input;
  }

  let scale = 1;
  for (let attempt = 0; attempt < 8; attempt++) {
    for (const quality of [90, 80, 70, 60]) {
      let pipeline = sharp(input).rotate().flatten({ background: '#ffffff' });
      pipeline = pipeline.resize({
        width: Math.min(MAX_IMAGE_DIMENSION, Math.max(1, Math.round((meta.width || 1) * scale))),
        height: Math.min(MAX_IMAGE_DIMENSION, Math.max(1, Math.round((meta.height || 1) * scale))),
        fit: 'inside',
        withoutEnlargement: true
      });
      const out = await pipeline
        .jpeg({ quality, progressive: false, chromaSubsampling: '4:2:0', mozjpeg: false })
        .toBuffer();
      if (out.length <= maxBytes) return out;
    }
    scale *= 0.75;
  }
  throw new Error('Image is too large to send to a Wii');
}

// ── Letterheads ──────────────────────────────────────────────────────────────
let manifestCache = null;
function letterheads() {
  if (manifestCache) return manifestCache;
  try {
    manifestCache = JSON.parse(fs.readFileSync(path.join(LETTERHEAD_DIR, 'manifest.json'), 'utf8')).map(
      (l) => ({ ...l, preview: `${LETTERHEAD_PREVIEW_URL}/${l.id}.png` })
    );
  } catch {
    manifestCache = [];
  }
  return manifestCache;
}

/** Letterheads grouped for the gallery: [{ group, items: [...] }] */
function letterheadGroups() {
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const groups = new Map();
  const sorted = [...letterheads()].sort(
    (x, y) => collator.compare(x.group, y.group) || collator.compare(x.name, y.name)
  );
  for (const l of sorted) {
    if (!groups.has(l.group)) groups.set(l.group, []);
    groups.get(l.group).push(l);
  }
  return [...groups].map(([group, items]) => ({ group, items }));
}

function findLetterhead(id) {
  return letterheads().find((l) => l.id === id) || null;
}

function readLetterheadArc(id) {
  const l = findLetterhead(id);
  return l ? fs.readFileSync(path.join(LETTERHEAD_DIR, `${l.id}.arc`)) : null;
}

// ── Mail ─────────────────────────────────────────────────────────────────────
function b64(buf, width = 76) {
  const s = buf.toString('base64');
  const lines = [];
  for (let i = 0; i < s.length; i += width) lines.push(s.slice(i, i + width));
  return lines.join(CRLF);
}

const utf16be = (str) => Buffer.from(str, 'utf16le').swap16();

function fileBase64Part(contentType, filename, data) {
  return [
    `Content-Type: ${contentType};`,
    ` name=${filename}`,
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment;',
    ` filename=${filename}`,
    '',
    b64(data),
    '',
    ''
  ].join(CRLF);
}

/**
 * Build a Wii Message Board mail ready for send.cgi.
 *
 * Layout follows a letter captured from a real Wii (headers, order, Date and
 * Message-Id formats, X-Wii-AppId/X-Wii-Cmd, trailing blank lines), plus
 * X-Wii-AltName/X-WiiFace/X-Wii-MB-NoReply as DoujinSoft and Mail-Admin send.
 * Text is UTF-16BE then base64, all CRLF. Text-only letters are a
 * single text/plain part like Nintendo's; with a picture and/or letterhead the
 * mail becomes multipart/mixed (WiiLink Mail-Admin layout).
 *
 * @param {{sender:string, server:string}} cfg
 * @param {object} o
 * @param {string} o.recipient  16-digit Wii number
 * @param {string} o.senderName name shown as the sender (X-Wii-AltName)
 * @param {string} o.text       message body (required)
 * @param {Buffer} [o.mii]      74-byte Mii shown as the sender's face
 * @param {Buffer} [o.jpeg]     baseline JPEG attachment
 * @param {Buffer} [o.letterheadArc]
 */
function buildWiiMail(cfg, o) {
  const text = String(o.text || '').trim().slice(0, MAX_TEXT_CHARS).replace(/\r?\n/g, CRLF);
  if (!text) throw new Error('Message text is required');
  const clean = (s) => String(s || '').replace(/[\r\n\t]+/g, ' ').trim();

  const from = `w${cfg.sender}@${cfg.server}`;
  const to = `w${o.recipient}@${cfg.server}`;
  const multipart = !!(o.jpeg || o.letterheadArc);
  const boundary = `Boundary-NWC24-${Date.now().toString(16).toUpperCase()}${Math.floor(Math.random() * 0xffff)
    .toString(16)
    .toUpperCase()}`;
  // Date/Message-Id mimic a letter composed on a real Wii (captured from one).
  const now = new Date();
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][now.getUTCMonth()];
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getUTCDate()} ${month} ${now.getUTCFullYear()} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} -0000`;
  const messageId = `<${require('crypto').randomBytes(15).toString('hex').toUpperCase()}@${cfg.server}>`;

  const headers = [
    `MAIL FROM: ${from}`,
    `RCPT TO: ${to}`,
    'DATA',
    `Date: ${date}`,
    `From: ${from}`,
    `To: ${to}`,
    `Message-Id: ${messageId}`,
    'X-Wii-AppId: 2-48414541-0001',
    'X-Wii-Cmd: 00044001'
  ];
  const name = clean(o.senderName);
  // One unbroken line: no folding inside X-Wii-AltName
  if (name) headers.push(`X-Wii-AltName: ${utf16be(name).toString('base64')}`);
  headers.push('X-Wii-MB-NoReply: 1');
  if (o.mii) {
    // First header line is 67 characters long including the key, then folded.
    const face = o.mii.toString('base64');
    const cut = 67 - 'X-WiiFace: '.length;
    headers.push(`X-WiiFace: ${face.slice(0, cut)}${CRLF} ${face.slice(cut)}`);
  }
  headers.push('MIME-Version: 1.0');
  if (multipart) {
    headers.push(`Content-Type: multipart/mixed;${CRLF} boundary="${boundary}"`);
  } else {
    headers.push('Content-Type: text/plain; charset=utf-16be', 'Content-Transfer-Encoding: base64');
  }
  headers.push('');

  let mail;
  if (!multipart) {
    mail = headers.join(CRLF) + CRLF + b64(utf16be(text)) + CRLF + CRLF + CRLF;
  } else {
    const parts = [
      ['Content-Type: text/plain; charset=utf-16be', 'Content-Transfer-Encoding: base64', '', b64(utf16be(text)), '', ''].join(
        CRLF
      )
    ];
    if (o.jpeg) parts.push(fileBase64Part('image/jpeg', 'image.jpg', o.jpeg));
    if (o.letterheadArc) parts.push(fileBase64Part('application/x-wii-msgboard', 'letterhead.arc', o.letterheadArc));
    mail = headers.join(CRLF) + CRLF + parts.map((p) => `--${boundary}${CRLF}${p}`).join('') + `--${boundary}--${CRLF}`;
  }
  if (Buffer.byteLength(mail) > MAX_MAIL_SIZE) throw new Error('Mail is too large for a Wii');
  return mail;
}

/** Inspect a send.cgi reply. @returns {{ok:boolean, message:string}} */
function parseSendReply(reply) {
  const text = String(reply || '');
  const top = /^cd=(\d+)/m.exec(text);
  const mailErr = [...text.matchAll(/^cd(\d+)=(\d+)/gm)].find((m) => m[2] !== '100');
  const msg =
    (mailErr && (new RegExp(`^msg${mailErr[1]}=(.*)$`, 'm').exec(text) || [])[1]) ||
    (/^msg=(.*)$/m.exec(text) || [])[1] ||
    '';
  if (!top || top[1] !== '100' || mailErr) return { ok: false, message: msg || 'Mail server rejected the mail' };
  return { ok: true, message: msg };
}

module.exports = {
  MII_SIZE,
  MAX_MAIL_SIZE,
  validateMii,
  jpegKind,
  toBaselineJpeg,
  letterheads,
  letterheadGroups,
  findLetterhead,
  readLetterheadArc,
  buildWiiMail,
  parseSendReply
};
