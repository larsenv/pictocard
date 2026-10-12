'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { csrf } = require('../lib/middleware');
const config = require('../config.example');
const nativeFetch = global.fetch;
const image = fs.readFileSync(path.join(__dirname, '..', 'public', 'images', 'logo.png'));
let sentCards = 0;
let verificationRequests = 0;

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
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = state;
    next();
  });
  app.use(csrf({ multipartPaths: ['/create'] }));
  app.use('/', routes);
  app.use('/discord', discordRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    request: (url, options = {}) => nativeFetch(base + url, { redirect: 'manual', ...options })
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
