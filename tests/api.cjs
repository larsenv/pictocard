'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

let config;
try {
  config = require('../config');
} catch {
  config = require('../config.example');
}
config.api = { ...(config.api || {}), enabled: true, powDifficulty: 8 };

const nativeFetch = global.fetch;
global.fetch = async (...args) => String(args[0]).startsWith('https://mii-unsecure.ariankordi.net')
  ? { ok: false } : nativeFetch(...args);

const email = require('../lib/emailService');
const sent = { codes: [], cards: [] };
email.sendVerificationCode = async (to, code) => { sent.codes.push({ to, code }); };
email.sendCard = async (to) => { sent.cards.push(to); };
email.sendCardConfirmation = async () => {};

const api = require('../routes/api');
const { leadingZeroBits } = require('../lib/proofOfWork');
const picture = fs.readFileSync(path.join(__dirname, '..', 'public', 'images', 'logo.png')).toString('base64');
let ipNumber = 0;

async function fixture(t) {
  const app = express();
  app.set('trust proxy', 1);
  app.use('/api/v1', api);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const ip = `198.51.100.${++ipNumber}`;
  const call = async (route, body) => {
    const response = await nativeFetch(base + route, body === undefined
      ? { headers: { 'X-Forwarded-For': ip } }
      : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { call };
}

function solve({ challenge, difficulty }) {
  for (let n = 0; ; n++) {
    const nonce = n.toString(36);
    const hash = crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest();
    if (leadingZeroBits(hash) >= difficulty) return { challenge, nonce };
  }
}

const card = {
  method: 'email',
  senderName: 'Wii Tester',
  senderEmail: 'sender@example.com',
  recipientEmail: 'friend@example.com',
  cardText: 'Hello from the Wii!',
  font: 'rodinntlg',
  background: 'light',
  image: picture
};

test('meta lists fonts, letterheads and expressions', async (t) => {
  const { call } = await fixture(t);
  const { status, body } = await call('/meta');
  assert.equal(status, 200);
  assert.equal(body.apiVersion, 1);
  assert.ok(body.fonts.some((f) => f.id === 'rodinntlg'));
  assert.ok(body.letterheads.length > 0);
  assert.ok(body.expressions.some((e) => e.id === 'normal'));
});

test('preview returns a small JPEG card', async (t) => {
  const { call } = await fixture(t);
  const { status, body } = await call('/preview', card);
  assert.equal(status, 200);
  const jpeg = Buffer.from(body.card, 'base64');
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
});

test('email send needs a solved challenge, then the sender code', async (t) => {
  const { call } = await fixture(t);
  let res = await call('/send', card);
  assert.equal(res.status, 403);

  const challenge = (await call('/challenge', { purpose: 'send' })).body;
  res = await call('/send', { ...card, pow: { challenge: challenge.challenge, nonce: 'x' } });
  assert.equal(res.status, 403, 'unsolved challenge is rejected');

  const pow = solve(challenge);
  res = await call('/send', { ...card, pow });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'verify');
  const { code } = sent.codes.at(-1);

  const reused = await call('/send', { ...card, pow });
  assert.equal(reused.status, 403, 'a challenge works once');

  res = await call('/verify', { ticket: res.body.ticket, code: '000000' === code ? '111111' : '000000' });
  assert.equal(res.status, 422);
  const ticket = [...api.tickets.keys()].at(-1);
  res = await call('/verify', { ticket, code });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'sent');
  assert.equal(sent.cards.at(-1), 'friend@example.com');
});

test('challenges are bound to purpose', async (t) => {
  const { call } = await fixture(t);
  const pow = solve((await call('/challenge', { purpose: 'friend' })).body);
  const res = await call('/send', { ...card, pow });
  assert.equal(res.status, 403);
});

test('invalid input is reported as JSON', async (t) => {
  const { call } = await fixture(t);
  let res = await call('/send', { ...card, recipientEmail: 'nope' });
  assert.equal(res.status, 422);
  assert.match(res.body.error, /recipient email/);
  res = await call('/preview', { ...card, cardText: 'x'.repeat(501) });
  assert.equal(res.status, 422);
  res = await call('/preview', { ...card, image: '***' });
  assert.equal(res.status, 422);
});

test('a doodle card is the drawing alone, without the PictoCard layout', async (t) => {
  const sharp = require('sharp');
  const { call } = await fixture(t);
  const doodle = (await sharp({ create: { width: 300, height: 200, channels: 4, background: '#ff0000' } }).png().toBuffer()).toString('base64');
  const size = async (body) => {
    const { status, body: result } = await call('/preview', body);
    assert.equal(status, 200);
    return sharp(Buffer.from(result.card, 'base64')).metadata();
  };
  const plain = await size({ ...card, image: doodle, cardType: 'doodle' });
  assert.deepEqual([plain.width, plain.height], [300, 200]);
  const full = await size({ ...card, image: doodle });
  assert.ok(full.width > 300);
  const { status, body } = await call('/send', { ...card, image: undefined, cardType: 'doodle' });
  assert.equal(status, 422);
  assert.match(body.error, /draw a doodle/);
});

test('Wii mail needs a message unless the app sends a picture on its own', async () => {
  const sharp = require('sharp');
  const wiiMail = require('../lib/wiiMail');
  const cfg = { sender: '1111222233334444', server: 'example.invalid' };
  const jpeg = await wiiMail.toBaselineJpeg(await sharp({ create: { width: 64, height: 48, channels: 3, background: '#336699' } }).png().toBuffer());
  const base = { recipient: '5555666677778888', senderName: 'Wii', jpeg };
  assert.throws(() => wiiMail.buildWiiMail(cfg, { ...base, text: '' }), /Message text is required/);
  assert.ok(wiiMail.buildWiiMail(cfg, { ...base, text: '', pictureOnly: true }));
  assert.throws(() => wiiMail.buildWiiMail(cfg, { recipient: base.recipient, text: '', pictureOnly: true }), /Message text is required/);
});
