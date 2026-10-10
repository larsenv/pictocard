'use strict';

// WiiConnect24 mail handling (receive, friend-request replies, send).
// Modelled on Difegue/DoujinSoft's WiiConnect24Api / MailItemParser: mail is
// pulled from and pushed to a WC24 mail server (e.g. WiiLink/RC24) over its
// mtw.<server>/cgi-bin/{send,receive,delete}.cgi endpoints.

const fs = require('fs');
const path = require('path');
const { simpleParser } = require('mailparser');
const wiiMail = require('./wiiMail');

// Optional .env support (Node >= 20.12). Real environment variables win.
for (const file of [process.env.WC24_ENV_FILE, path.join(__dirname, '..', '.env')]) {
  if (file && fs.existsSync(file) && typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(file);
    } catch (err) {
      console.error('[WC24] could not load env file:', err.message);
    }
  }
}

const FRIENDS_FILE = path.join(__dirname, '..', 'data', 'wc24-friends.json');
const SEND_CHUNK = 15; // DoujinSoft: max mails per send.cgi request
const CRLF = '\r\n';

function wc24Config() {
  const sender = process.env.WII_NUMBER;
  const server = process.env.WC24_SERVER;
  const password = process.env.WC24_PASSWORD;
  if (!sender || !server || !password) return null;
  return {
    sender,
    server,
    password,
    debug: /^true$/i.test(process.env.WC24_DEBUG || '')
  };
}

const isFriendCode = (c) => /^\d{16}$/.test(c || '');

// ── Friend list ──────────────────────────────────────────────────────────────
function loadFriends() {
  try {
    return new Set(JSON.parse(fs.readFileSync(FRIENDS_FILE, 'utf8')));
  } catch {
    return new Set();
  }
}

function saveFriend(code) {
  const friends = loadFriends();
  if (friends.has(code)) return false;
  friends.add(code);
  fs.mkdirSync(path.dirname(FRIENDS_FILE), { recursive: true });
  fs.writeFileSync(FRIENDS_FILE, JSON.stringify([...friends], null, 2));
  return true;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function post(cfg, endpoint, form) {
  const res = await fetch(`http://mtw.${cfg.server}/cgi-bin/${endpoint}.cgi`, {
    method: 'POST',
    body: form
  });
  return Buffer.from(await res.arrayBuffer());
}

function wrapBase64(buf) {
  return buf.toString('base64').replace(/(.{76})/g, '$1\n');
}

// ── Outgoing mail ────────────────────────────────────────────────────────────
function mailEnvelope(cfg, recipient, body) {
  const from = `w${cfg.sender}@${cfg.server}`;
  const to = `w${recipient}@${cfg.server}`;
  return `MAIL FROM: ${from}\nRCPT TO: ${to}\nDATA\nFrom: ${from}\nTo: ${to}\n${body}`;
}

/** WC24 "friend request" reply: the Wii adds our number to its address book. */
function friendRequestMail(cfg, recipient) {
  const boundary = 'Boundary-NWC24-03BEF8790066';
  const attachment = wrapBase64(Buffer.alloc(128));
  const body = [
    'Subject: WC24 Cmd Message',
    'X-Wii-AppId: 0-00000001-0001',
    'X-Wii-Cmd: 80010001',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed;\n boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=us-ascii',
    'Content-Transfer-Encoding: 7bit',
    '',
    'WC24 Cmd Message',
    `--${boundary}`,
    'Content-Type: application/octet-stream;\n name=a0000102.dat',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment;\n filename=a0000102.dat',
    '',
    attachment,
    '',
    `--${boundary}--`,
    ''
  ].join('\n');
  return mailEnvelope(cfg, recipient, body);
}

/** Plain text Wii mail (UTF-16BE body wrapped in base64, as the Wii expects). */
function textMail(cfg, recipient, message) {
  const boundary = 'Boundary-NWC24-PictoCard';
  const body = [
    'X-Wii-AppId: 2-48414541-0001',
    'X-Wii-Cmd: 00044001',
    'X-Wii-MB-NoReply: 1',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed;\n boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=us-ascii',
    'Content-Transfer-Encoding: 7bit',
    '',
    'PictoCard',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-16be',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(message, 'utf16le').swap16()),
    '',
    `--${boundary}--`,
    ''
  ].join('\n');
  return mailEnvelope(cfg, recipient, body);
}

async function sendMails(cfg, mails) {
  const out = [];
  for (let i = 0; i < mails.length; i += SEND_CHUNK) {
    const form = new FormData();
    form.append('mlid', `mlid=w${cfg.sender}${CRLF}passwd=${cfg.password}`);
    mails.slice(i, i + SEND_CHUNK).forEach((m, n) => form.append(`m${n + 1}`, m));
    const reply = (await post(cfg, 'send', form)).toString('utf8');
    if (cfg.debug) console.log('[WC24] send reply:', reply);
    out.push(reply);
    if (i + SEND_CHUNK < mails.length) await new Promise((r) => setTimeout(r, 1000));
  }
  return out;
}

/**
 * Send one mail to a Wii. If the Wii hasn't been added as a friend yet, a
 * (one-time) friend request goes out first in the same request so the Wii
 * accepts the mail that follows.
 */
async function deliver(cfg, recipient, mail) {
  if (!isFriendCode(recipient)) throw new Error('Invalid Wii friend code');
  const needsFriend = !loadFriends().has(recipient);
  const batch = needsFriend ? [friendRequestMail(cfg, recipient), mail] : [mail];
  const [reply] = await sendMails(cfg, batch);
  const result = wiiMail.parseSendReply(reply);
  if (!result.ok) throw new Error(result.message);
  if (needsFriend) saveFriend(recipient);
}

/** Plain text Wii mail (e.g. a verification code). */
async function sendText(recipient, message) {
  const cfg = wc24Config();
  if (!cfg) throw new Error('WC24 is not configured');
  await deliver(cfg, recipient, textMail(cfg, recipient, message));
}

/**
 * Web-initiated friend request: send the Wii a friend request, once per Wii.
 * @returns {Promise<'sent'|'already'>}
 */
async function requestFriend(recipient) {
  const cfg = wc24Config();
  if (!cfg) throw new Error('WC24 is not configured');
  if (!isFriendCode(recipient)) throw new Error('Invalid Wii friend code');
  if (loadFriends().has(recipient)) return 'already';
  await sendMails(cfg, [friendRequestMail(cfg, recipient)]);
  saveFriend(recipient);
  return 'sent';
}

/**
 * Deliver a card to a Wii Message Board.
 * @param {object} o see wiiMail.buildWiiMail (recipient, senderName, text, mii, jpeg, letterheadArc)
 */
async function sendWiiMail(o) {
  const cfg = wc24Config();
  if (!cfg) throw new Error('WC24 is not configured');
  await deliver(cfg, o.recipient, wiiMail.buildWiiMail(cfg, o));
}

// ── Incoming mail ────────────────────────────────────────────────────────────
function wiiCodeFrom(cfg, address) {
  const m = new RegExp(`^w(\\d{16})@${cfg.server.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i').exec(
    (address || '').trim()
  );
  return m ? m[1] : null;
}

/** Split the multipart/mixed blob receive.cgi returns into raw mail strings. */
function splitMails(raw) {
  const delimiter = raw.split(/\r?\n/, 1)[0];
  if (!delimiter.startsWith('--')) return [];
  return raw
    .split(delimiter)
    .filter((part) => !part.includes('This part is ignored') && part.trim().length >= 30 && part.trim() !== '--')
    .map((part) => part.replace(/^\s*Content-Type: text\/plain\s*\r?\n/i, '').replace(/^\r?\n/, ''));
}

async function handleMail(cfg, raw) {
  const mail = await simpleParser(raw);
  const from = mail.from && mail.from.value[0] && mail.from.value[0].address;
  const code = wiiCodeFrom(cfg, from);
  if (!code) {
    console.log('[WC24] ignoring mail not from a Wii:', from);
    return null;
  }

  const subject = mail.subject || '';
  if (subject.includes('WC24 Cmd Message')) {
    // Adding the Wii as a friend is a one-time thing: only the first request is answered.
    if (loadFriends().has(code)) {
      console.log(`[WC24] ${code} is already a friend - not replying again`);
      return null;
    }
    console.log(`[WC24] friend request from ${code}`);
    return { mail: friendRequestMail(cfg, code), friend: code };
  }

  // Keep a copy of the raw mail (capped) so real Wii-built letters can be used
  // as a reference for the format we send.
  try {
    const dir = path.join(__dirname, '..', 'data', 'wc24-received');
    fs.mkdirSync(dir, { recursive: true });
    const files = fs.readdirSync(dir).sort();
    while (files.length >= 20) fs.unlinkSync(path.join(dir, files.shift()));
    fs.writeFileSync(path.join(dir, `${Date.now()}-${code}.eml`), raw);
  } catch (err) {
    console.error('[WC24] could not store received mail:', err.message);
  }

  // PictoCard has no Wii-originated mail features yet: log and drop.
  console.log(`[WC24] dropped mail from ${code} (${subject || 'no subject'})`);
  return null;
}

/** Pull mail from the WC24 server, process it, reply, then clear the inbox. */
async function receiveMails() {
  const cfg = wc24Config();
  if (!cfg) throw new Error('WC24 is not configured');

  const form = new FormData();
  form.append('mlid', `w${cfg.sender}`);
  form.append('passwd', cfg.password);
  form.append('maxsize', '2000000');
  const raw = (await post(cfg, 'receive', form)).toString('utf8');
  if (cfg.debug) console.log('[WC24] receive reply:\n' + raw);

  const replies = [];
  for (const part of splitMails(raw)) {
    try {
      const reply = await handleMail(cfg, part);
      // A Wii can queue several requests; answer each friend code once per poll.
      if (reply && !replies.some((r) => r.friend === reply.friend)) replies.push(reply);
    } catch (err) {
      console.error('[WC24] could not process mail:', err.message);
    }
  }

  if (replies.length) {
    await sendMails(
      cfg,
      replies.map((r) => r.mail)
    );
    replies.forEach((r) => saveFriend(r.friend));
  }
  if (raw.trim()) await deleteMails(cfg);
  return { received: splitMails(raw).length, replies: replies.length };
}

async function deleteMails(cfg = wc24Config()) {
  const form = new FormData();
  form.append('mlid', `w${cfg.sender}`);
  form.append('passwd', cfg.password);
  form.append('delnum', '10'); // WiiLink ignores the value but requires it
  const reply = (await post(cfg, 'delete', form)).toString('utf8');
  if (cfg.debug) console.log('[WC24] delete reply:', reply);
}

/** Poll the WC24 inbox on an interval. No-op when WC24 env vars are missing. */
function startPolling(intervalMs = 60 * 1000) {
  if (!wc24Config()) {
    console.log('[WC24] disabled (set WII_NUMBER, WC24_SERVER, WC24_PASSWORD to enable)');
    return null;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await receiveMails();
    } catch (err) {
      console.error('[WC24] poll failed:', err.message);
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = {
  startPolling,
  receiveMails,
  sendText,
  requestFriend,
  sendWiiMail,
  loadFriends,
  wc24Config,
  isFriendCode
};
