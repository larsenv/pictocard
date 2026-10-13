'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { csrf } = require('../lib/middleware');
const config = require('../config.example');
const nativeFetch = global.fetch;
global.fetch = async (...args) => String(args[0]).startsWith('https://mii-unsecure.ariankordi.net')
  ? { ok: false } : nativeFetch(...args);
const image = fs.readFileSync(path.join(__dirname, '..', 'public', 'images', 'logo.png'));
let sentCards = 0;
let verificationRequests = 0;
let fixtureNumber = 0;

const email = require('../lib/emailService');
email.sendCard = async () => { sentCards++; };
email.sendCardConfirmation = async () => {};
email.sendVerificationCode = async () => { verificationRequests++; };

const routes = require('../routes/index');
const discordRoutes = require('../routes/discord');
const wc24 = require('../lib/wc24');
let activeConfig;
try {
  activeConfig = require('../config');
} catch {
  activeConfig = config;
}

async function fixture(t, pending = null) {
  const state = { csrfToken: 'test-token', pending };
  const app = express();
  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = state;
    next();
  });
  app.use(csrf({ multipartPaths: ['/create', '/card-preview', '/mii-import'] }));
  app.use('/', routes);
  app.use('/discord', discordRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ip = `192.0.2.${++fixtureNumber}`;
  return {
    state,
    request: (url, options = {}) => nativeFetch(base + url, {
      redirect: 'manual', ...options, headers: { 'X-Forwarded-For': ip, ...options.headers }
    })
  };
}

function readyCard() {
  return {
    generatedCard: image.toString('base64'),
    originalImage: image.toString('base64'),
    codeVerified: true,
    skipVerify: true,
    senderName: 'Alex',
    senderEmail: 'alex@example.com',
    recipientEmail: 'friend@example.com',
    cardText: 'Original message'
  };
}

test('a failed edit invalidates the old card and its verification', async (t) => {
  const f = await fixture(t, readyCard());
  const body = new FormData();
  for (const [key, value] of Object.entries({
    _csrf: 'test-token', deliveryMethod: 'email', senderName: '',
    senderEmail: 'alex@example.com', recipientEmail: 'new@example.com', cardText: 'Edited message'
  })) body.append(key, value);
  const response = await f.request('/create', { method: 'POST', body });
  assert.equal(response.headers.get('location'), '/');
  assert.equal(f.state.pending.cardText, 'Edited message');
  assert.equal(f.state.pending.originalImage, image.toString('base64'));
  assert.ok(!f.state.pending.generatedCard);
  assert.equal(f.state.pending.codeVerified, undefined);
  const before = sentCards;
  const retry = await f.request('/verify', {
    method: 'POST', body: new URLSearchParams({ _csrf: 'test-token', retry: '1' })
  });
  assert.equal(retry.headers.get('location'), '/');
  assert.equal(sentCards, before);
});

test('live previews use the final renderer and never change the pending card', async (t) => {
  const original = readyCard();
  const f = await fixture(t, structuredClone(original));
  const fields = {
    _csrf: 'test-token', deliveryMethod: 'email', senderName: 'Alex', senderEmail: 'alex@example.com',
    recipientEmail: 'friend@example.com', cardText: 'hello '.repeat(83), fontFamily: 'rodinntlg', textColor: '#334455'
  };
  const preview = await f.request('/card-preview', { method: 'POST', body: new URLSearchParams(fields) });
  assert.equal(preview.status, 200);
  const result = await preview.json();
  assert.match(result.image, /^data:image\/jpeg;base64,/);
  assert.deepEqual(f.state.pending, original);
  const created = await f.request('/create', { method: 'POST', body: new URLSearchParams(fields) });
  assert.equal(created.headers.get('location'), '/preview');
  const delivered = await email.prepareCardAttachment(Buffer.from(f.state.pending.generatedCard, 'base64'));
  assert.equal(result.image, `data:image/jpeg;base64,${delivered.toString('base64')}`);
});

test('preview overflow gives a useful error instead of a truncated card', async (t) => {
  const f = await fixture(t);
  const response = await f.request('/card-preview', {
    method: 'POST', body: new URLSearchParams({ _csrf: 'test-token', cardText: 'a\n'.repeat(200) })
  });
  assert.equal(response.status, 422);
  const result = await response.json();
  assert.equal(result.textOverflow, true);
  assert.match(result.error, /line breaks/);
  assert.equal(f.state.pending, null);
});

function enableWii(t) {
  const keys = ['WII_NUMBER', 'WC24_SERVER', 'WC24_PASSWORD'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { WII_NUMBER: '1111222233334444', WC24_SERVER: 'example.invalid', WC24_PASSWORD: 'test' });
  t.after(() => keys.forEach((key) => {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }));
}

function wiiBody(attach, text = 'Hello Wii') {
  const body = new FormData();
  for (const [key, value] of Object.entries({
    _csrf: 'test-token', deliveryMethod: 'wii', recipientWii: '5555666677778888',
    cardText: text, wiiCardText: 'Separate card text', wiiAttach: attach, letterhead: 'and-kensaku'
  })) body.append(key, value);
  return body;
}

test('Wii picture edits retain the picture, face, and letterhead', async (t) => {
  enableWii(t);
  const f = await fixture(t);
  const body = wiiBody('image');
  body.append('wiiImage', new Blob([image], { type: 'image/png' }), 'logo.png');
  body.append('wiiMii', new Blob([Buffer.alloc(74)]), 'face.mii');
  const preview = await (await f.request('/card-preview', { method: 'POST', body })).json();
  assert.equal(f.state.pending, null);
  const first = await f.request('/create', { method: 'POST', body });
  assert.equal(first.headers.get('location'), '/preview');
  const original = structuredClone(f.state.pending);
  assert.equal(preview.image, `data:image/jpeg;base64,${original.wii.jpeg}`);
  const form = await (await f.request('/')).text();
  assert.match(form, /value="image" checked/);
  assert.match(form, /value="and-kensaku" checked/);
  assert.match(form, /Separate card text/);
  const edited = await f.request('/create', { method: 'POST', body: wiiBody('image', 'Edited Wii message') });
  assert.equal(edited.headers.get('location'), '/preview');
  assert.equal(f.state.pending.wii.jpeg, original.wii.jpeg);
  assert.equal(f.state.pending.wii.mii, original.wii.mii);
  assert.equal(f.state.pending.wii.letterhead, 'and-kensaku');
  assert.equal(f.state.pending.cardText, 'Edited Wii message');
});

test('Wii PictoCard edits reuse the card image and preserve separate card text', async (t) => {
  enableWii(t);
  const f = await fixture(t);
  const body = wiiBody('card');
  body.append('cardImage', new Blob([image], { type: 'image/png' }), 'logo.png');
  const preview = await (await f.request('/card-preview', { method: 'POST', body })).json();
  await f.request('/create', { method: 'POST', body });
  assert.equal(f.state.pending.wii.attach, 'card');
  const original = f.state.pending.wii.jpeg;
  assert.equal(preview.image, `data:image/jpeg;base64,${original}`);
  const edited = wiiBody('card');
  edited.set('wiiCardText', 'Updated card text');
  const result = await f.request('/create', { method: 'POST', body: edited });
  assert.equal(result.headers.get('location'), '/preview');
  assert.equal(f.state.pending.originalImage, image.toString('base64'));
  assert.equal(f.state.pending.wiiCardText, 'Updated card text');
  assert.notEqual(f.state.pending.wii.jpeg, original);
});

test('multipart verification requests cannot skip CSRF validation', async (t) => {
  const f = await fixture(t, readyCard());
  const before = verificationRequests;
  const response = await f.request('/verify-request', { method: 'POST', body: new FormData() });
  assert.equal(response.status, 403);
  assert.equal(verificationRequests, before);
});

test('a rejected upload invalidates the old card and gives a form error', async (t) => {
  const f = await fixture(t, readyCard());
  const body = new FormData();
  body.append('_csrf', 'test-token');
  body.append('deliveryMethod', 'email');
  body.append('unexpectedImage', new Blob([image], { type: 'image/png' }), 'logo.png');
  const response = await f.request('/create', { method: 'POST', body });
  assert.equal(response.headers.get('location'), '/');
  assert.match(f.state.formError, /upload/i);
  assert.ok(!f.state.pending.generatedCard);
  assert.equal(f.state.pending.codeVerified, undefined);
});

test('uploads still require a valid CSRF token after parsing', async (t) => {
  const f = await fixture(t);
  const body = new FormData();
  body.append('deliveryMethod', 'email');
  const response = await f.request('/create/', { method: 'POST', body });
  assert.equal(response.status, 403);
  assert.equal(f.state.pending, null);
});

test('an inactive recipient cannot override the selected delivery method', async (t) => {
  const f = await fixture(t);
  const body = new FormData();
  for (const [key, value] of Object.entries({
    _csrf: 'test-token', deliveryMethod: 'email', senderName: 'Alex',
    senderEmail: 'alex@example.com', recipientEmail: 'friend@example.com',
    recipientDiscord: 'stale-recipient', cardText: 'Hello'
  })) body.append(key, value);
  body.append('cardImage', new Blob([image], { type: 'image/png' }), 'logo.png');
  const response = await f.request('/create', { method: 'POST', body });
  assert.equal(response.headers.get('location'), '/preview');
  assert.equal(f.state.pending.recipientEmail, 'friend@example.com');
  assert.equal(f.state.pending.recipientDiscord, null);
});

test('an email opt-out made after preview still prevents delivery', async (t) => {
  const f = await fixture(t, readyCard());
  const hash = routes.hashEmail('friend@example.com');
  routes.emailOptOuts.add(hash);
  t.after(() => routes.emailOptOuts.delete(hash));
  const before = sentCards;
  const response = await f.request('/verify', {
    method: 'POST', body: new URLSearchParams({ _csrf: 'test-token', retry: '1' })
  });
  assert.equal(response.headers.get('location'), '/');
  assert.equal(sentCards, before);
  assert.match(f.state.formError, /opted out/);
  assert.equal(f.state.pending, undefined);
});

test('Discord authorization requires a matching one-time state', async (t) => {
  const original = activeConfig.discord;
  activeConfig.discord = {
    enabled: true, clientId: 'test-id', clientSecret: 'test-secret',
    redirectUri: 'http://localhost/discord/callback'
  };
  t.after(() => { activeConfig.discord = original; });
  let requests = 0;
  mock.method(global, 'fetch', async () => {
    requests++;
    return { ok: true, json: async () => ({ access_token: 'token', id: '123', username: 'alex' }) };
  });
  t.after(() => mock.restoreAll());
  const f = await fixture(t);
  const login = await f.request('/discord');
  const state = new URL(login.headers.get('location')).searchParams.get('state');
  assert.ok(state);
  await f.request('/discord/callback?code=test-code&state=wrong');
  assert.equal(requests, 0);
  assert.equal(f.state.discordUser, undefined);

  const again = await f.request('/discord');
  const freshState = new URL(again.headers.get('location')).searchParams.get('state');
  await f.request(`/discord/callback?code=test-code&state=${freshState}`);
  assert.equal(requests, 2);
  assert.equal(f.state.discordUser.username, 'alex');
  await f.request(`/discord/callback?code=test-code&state=${freshState}`);
  assert.equal(requests, 2);
});

test('a rejected Wii friend request is never recorded as sent', async (t) => {
  const env = { ...process.env };
  Object.assign(process.env, { WII_NUMBER: '1111222233334444', WC24_SERVER: 'example.invalid', WC24_PASSWORD: 'test' });
  t.after(() => {
    for (const key of ['WII_NUMBER', 'WC24_SERVER', 'WC24_PASSWORD']) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    mock.restoreAll();
  });
  const read = fs.readFileSync;
  const write = fs.writeFileSync;
  let writes = 0;
  mock.method(fs, 'readFileSync', (file, ...args) => {
    if (String(file).endsWith('wc24-friends.json')) return '[]';
    return read(file, ...args);
  });
  mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (String(file).endsWith('wc24-friends.json')) { writes++; return; }
    return write(file, ...args);
  });
  mock.method(global, 'fetch', async () => ({
    ok: true,
    arrayBuffer: async () => Buffer.from('cd=100\ncd1=200\nmsg1=Rejected\n')
  }));
  await assert.rejects(wc24.requestFriend('5555666677778888'), /Rejected/);
  assert.equal(writes, 0);
});

test('card Mii imports require CSRF, retain raw data through edits, and can be removed', async (t) => {
  const sample = Buffer.from('AwAAQKBBOMSghAAA27iHMb5gKyoqQgAAWS1KAGEAcwBtAGkAbgBlAAAAAAAAABw3EhB7ASFuQxwNZMcYAAgegg0AMEGzW4JtAABvAHMAaQBnAG8AbgBhAGwAAAAAAJA6', 'base64');
  mock.method(global, 'fetch', async (url) => {
    assert.match(String(url), /^https:\/\/mii-unsecure\.ariankordi\.net\/miis\/image\.png/);
    assert.equal(new URL(url).searchParams.get('data'), sample.toString('hex'));
    return { ok: true, arrayBuffer: async () => image };
  });
  t.after(() => mock.restoreAll());
  const f = await fixture(t, readyCard());
  const denied = new FormData();
  denied.append('source', 'data');
  denied.append('value', sample.toString('base64'));
  assert.equal((await f.request('/mii-import', { method: 'POST', body: denied })).status, 403);
  denied.append('_csrf', 'test-token');
  const loaded = await f.request('/mii-import', { method: 'POST', body: denied });
  assert.equal(loaded.status, 200);
  assert.equal((await loaded.json()).data, sample.toString('base64'));
  const fields = { _csrf: 'test-token', deliveryMethod: 'email', senderName: 'Alex', senderEmail: 'alex@example.com',
    recipientEmail: 'friend@example.com', cardText: 'Hello', cardMiiData: sample.toString('base64') };
  assert.equal((await f.request('/create', { method: 'POST', body: new URLSearchParams(fields) })).headers.get('location'), '/preview');
  assert.equal(f.state.pending.miiData, sample.toString('base64'));
  fields.senderName = '';
  await f.request('/create', { method: 'POST', body: new URLSearchParams(fields) });
  assert.equal(f.state.pending.miiData, sample.toString('base64'));
  fields.senderName = 'Alex';
  fields.cardMiiData = 'remove';
  await f.request('/create', { method: 'POST', body: new URLSearchParams(fields) });
  assert.equal(f.state.pending.miiData, null);
});

test('validation errors retain new uploads and presets instead of older images', async (t) => {
  const sharp = require('sharp');
  const replacement = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const f = await fixture(t, readyCard());
  const body = new FormData();
  body.set('_csrf', 'test-token');
  body.set('deliveryMethod', 'email');
  body.set('senderName', '');
  body.set('cardText', 'New message');
  body.set('cardImage', new Blob([replacement], { type: 'image/png' }), 'new.png');
  body.set('miiFile', new Blob([Buffer.alloc(96, 17)]), 'new.ffsd');
  await f.request('/create', { method: 'POST', body });
  assert.equal(f.state.pending.originalImage, replacement.toString('base64'));
  assert.equal(f.state.pending.miiData, Buffer.alloc(96, 17).toString('base64'));
  assert.equal(f.state.pending.generatedCard, undefined);

  const directory = path.join(__dirname, '..', 'public', 'images', 'presets');
  fs.mkdirSync(directory, { recursive: true });
  const preset = path.join(directory, `validation-${process.pid}.png`);
  fs.writeFileSync(preset, image);
  t.after(() => fs.unlinkSync(preset));
  body.delete('cardImage');
  body.delete('miiFile');
  body.set('presetImage', `/images/presets/${path.basename(preset)}`);
  await f.request('/create', { method: 'POST', body });
  assert.equal(f.state.pending.originalImage, image.toString('base64'));
});

test('removing a Mii from a Wii PictoCard stays removed after editing', async (t) => {
  enableWii(t);
  const previous = { ...readyCard(), miiData: Buffer.alloc(96, 19).toString('base64') };
  const f = await fixture(t, previous);
  const body = wiiBody('card');
  body.set('cardMiiData', 'remove');
  const response = await f.request('/create', { method: 'POST', body });
  assert.equal(response.headers.get('location'), '/preview');
  assert.equal(f.state.pending.miiData, null);
  const edited = await f.request('/create', { method: 'POST', body: wiiBody('card') });
  assert.equal(edited.headers.get('location'), '/preview');
  assert.equal(f.state.pending.miiData, null);
});

test('Wii drafts retain omitted background and font preferences', async (t) => {
  enableWii(t);
  const f = await fixture(t, { ...readyCard(), cardBackground: 'dark', textColor: '#ff3344', fontFamily: 'splatfont2' });
  await f.request('/create', { method: 'POST', body: wiiBody('none') });
  assert.equal(f.state.pending.cardBackground, 'dark');
  assert.equal(f.state.pending.textColor, '#ff3344');
  assert.equal(f.state.pending.fontFamily, 'splatfont2');
  await f.request('/create', { method: 'POST', body: wiiBody('card') });
  assert.equal(f.state.pending.cardBackground, 'dark');
});

test('overlapping submissions cannot replace an in-flight draft', async (t) => {
  const saved = activeConfig.moderationApiKey;
  activeConfig.moderationApiKey = 'test-key';
  t.after(() => { activeConfig.moderationApiKey = saved; mock.restoreAll(); });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let release;
  const pause = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  mock.method(global, 'fetch', async (url) => {
    assert.equal(String(url), 'https://api.openai.com/v1/moderations');
    entered();
    await pause;
    return { ok: true, json: async () => ({ results: [{ flagged: false }] }) };
  });
  const f = await fixture(t, readyCard());
  const fields = { _csrf: 'test-token', deliveryMethod: 'email', senderName: 'Alex', senderEmail: 'alex@example.com',
    recipientEmail: 'first@example.com', cardText: 'First submission' };
  const first = f.request('/create', { method: 'POST', body: new URLSearchParams(fields) });
  await started;
  const second = await f.request('/create', { method: 'POST', body: new URLSearchParams({ ...fields, recipientEmail: 'second@example.com' }) });
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).headers.get('location'), '/preview');
  assert.equal(f.state.pending.recipientEmail, 'first@example.com');
});

test('preview work is bounded across requests and slots are released afterwards', async (t) => {
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let release;
  const pause = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  mock.method(global, 'fetch', async () => {
    if (++calls === 2) entered();
    await pause;
    return { ok: true, arrayBuffer: async () => image };
  });
  t.after(() => { release(); mock.restoreAll(); });
  const f = await fixture(t);
  const importMii = (byte) => f.request('/mii-import', { method: 'POST', body: new URLSearchParams({
    _csrf: 'test-token', source: 'data', value: Buffer.alloc(96, byte).toString('base64')
  }) });
  const first = importMii(61);
  const second = importMii(62);
  await started;
  const busy = await f.request('/card-preview', { method: 'POST', body: new URLSearchParams({ _csrf: 'test-token' }) });
  assert.equal(busy.status, 429);
  assert.match((await busy.json()).error, /busy/);
  release();
  assert.deepEqual((await Promise.all([first, second])).map((response) => response.status), [200, 200]);
  const recovered = await f.request('/card-preview', { method: 'POST', body: new URLSearchParams({ _csrf: 'test-token' }) });
  assert.equal(recovered.status, 200);
});

test('multipart preview uploads have an aggregate byte limit', async (t) => {
  const f = await fixture(t);
  const body = new FormData();
  body.set('_csrf', 'test-token');
  const file = Buffer.alloc(9 * 1024 * 1024);
  for (const field of ['cardImage', 'wiiImage', 'miiFile']) {
    body.set(field, new Blob([file], { type: 'image/png' }), `${field}.png`);
  }
  const response = await f.request('/card-preview', { method: 'POST', body });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /upload/);
});

test('Mii service outages return a service error while invalid data stays an input error', async (t) => {
  mock.method(global, 'fetch', async () => ({ ok: false, status: 503 }));
  t.after(() => mock.restoreAll());
  const f = await fixture(t);
  const request = (value) => f.request('/mii-import', { method: 'POST', body: new URLSearchParams({ _csrf: 'test-token', source: 'data', value }) });
  const outage = await request(Buffer.alloc(96, 91).toString('base64'));
  assert.equal(outage.status, 503);
  assert.match((await outage.json()).error, /rendering is unavailable/);
  assert.equal((await request('00')).status, 422);
});

test('two Discord login flows retain separate one-time states', async (t) => {
  const saved = activeConfig.discord;
  activeConfig.discord = { enabled: true, clientId: 'test-id', clientSecret: 'test-secret', redirectUri: 'http://localhost/discord/callback' };
  let requests = 0;
  mock.method(global, 'fetch', async () => {
    requests++;
    return { ok: true, json: async () => ({ access_token: 'token', id: '123', username: 'alex' }) };
  });
  t.after(() => { activeConfig.discord = saved; mock.restoreAll(); });
  const f = await fixture(t);
  const states = [];
  for (let i = 0; i < 2; i++) {
    const response = await f.request('/discord');
    states.push(new URL(response.headers.get('location')).searchParams.get('state'));
  }
  await f.request('/discord/callback?code=test-code&state=wrong');
  for (const state of states) {
    await f.request(`/discord/callback?code=test-code&state=${state}`);
    assert.equal(f.state.discordUser.username, 'alex');
  }
  assert.equal(requests, 4);
  await f.request(`/discord/callback?code=test-code&state=${states[0]}`);
  assert.equal(requests, 4);
});

test('uncertain Wii delivery cannot resend the same pending card', async (t) => {
  enableWii(t);
  let requests = 0;
  mock.method(global, 'fetch', async () => { requests++; return { ok: false, status: 503 }; });
  t.after(() => mock.restoreAll());
  const f = await fixture(t, { ...readyCard(), recipientWii: '5555666677778888', wii: { attach: 'none', mii: null, jpeg: null, letterhead: '' } });
  const send = () => f.request('/verify', { method: 'POST', body: new URLSearchParams({ _csrf: 'test-token', retry: '1' }) });
  assert.equal((await send()).headers.get('location'), '/preview');
  assert.equal(f.state.pending.wiiDelivery, 'uncertain');
  assert.equal(requests, 1);
  await send();
  assert.equal(requests, 1);
  const preview = await (await f.request('/preview')).text();
  assert.match(preview, /Check the Wii Message Board/);
  assert.doesNotMatch(preview, /<form action="\/verify"/);
});

test('WC24 requests apply a deadline and preserve uncertain timeout outcomes', async (t) => {
  enableWii(t);
  const controller = new AbortController();
  mock.method(AbortSignal, 'timeout', (duration) => { assert.ok(duration > 0 && duration <= 30_000); return controller.signal; });
  mock.method(global, 'fetch', async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    setImmediate(() => controller.abort(new DOMException('Timed out', 'TimeoutError')));
  }));
  t.after(() => mock.restoreAll());
  await assert.rejects(wc24.requestFriend('5555666677778888'), (error) => error.code === 'WC24_UNCERTAIN' && error.cause.name === 'TimeoutError');
});

test('overlapping Discord callbacks cannot restore consumed states in cloned sessions', { timeout: 5000 }, async (t) => {
  const session = require('express-session');
  const saved = activeConfig.discord;
  activeConfig.discord = { enabled: true, clientId: 'test-id', clientSecret: 'test-secret', redirectUri: 'http://localhost/discord/callback' };
  let release;
  const pause = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let tokens = 0;
  let requests = 0;
  mock.method(global, 'fetch', async (url) => {
    requests++;
    if (String(url).endsWith('/oauth2/token') && ++tokens === 1) { entered(); await pause; }
    return { ok: true, json: async () => ({ access_token: 'token', id: '123', username: 'alex' }) };
  });
  t.after(() => { release(); activeConfig.discord = saved; mock.restoreAll(); });
  const app = express();
  app.use(session({ secret: 'fixture-secret', resave: false, saveUninitialized: false }));
  app.use(csrf());
  app.use('/discord', discordRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const request = async (url) => {
    const response = await nativeFetch(base + url, { redirect: 'manual', headers: { Cookie: cookie } });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  };
  const states = [];
  for (let i = 0; i < 2; i++) {
    const response = await request('/discord');
    states.push(new URL(response.headers.get('location')).searchParams.get('state'));
  }
  const first = request(`/discord/callback?code=first&state=${states[0]}`);
  await started;
  await request(`/discord/callback?code=second&state=${states[1]}`);
  release();
  await first;
  assert.equal(requests, 4);
  for (const state of states) await request(`/discord/callback?code=replay&state=${state}`);
  assert.equal(requests, 4);
});
