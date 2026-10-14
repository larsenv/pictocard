'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { api, pairs } = require('../routes/pictochat');

async function fixture(t) {
  const app = express();
  app.use('/api/v1/pictochat', api);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/pictochat`;
  return (path, body) => fetch(base + path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

const TOKEN = 'P1_eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.test-token_value';

test('a solved captcha reaches the Wii once', async (t) => {
  const call = await fixture(t);
  const pair = await (await call('/pair', {})).json();
  assert.match(pair.code, /^[A-Z0-9]{6}$/);
  assert.ok(pair.url.endsWith(`/pictochat/${pair.code}`));

  assert.equal((await call(`/pair/${pair.code}`)).status, 202);
  assert.equal((await call(`/pair/${pair.code.toLowerCase()}`, { token: TOKEN })).status, 200);
  const got = await call(`/pair/${pair.code}`);
  assert.equal(got.status, 200);
  assert.equal((await got.json()).token, TOKEN);
  assert.equal((await call(`/pair/${pair.code}`)).status, 404);
});

test('bad tokens and unknown codes are refused', async (t) => {
  const call = await fixture(t);
  const { code } = await (await call('/pair', {})).json();
  assert.equal((await call(`/pair/${code}`, { token: 'short' })).status, 422);
  assert.equal((await call(`/pair/${code}`, { token: 'has spaces in it and more text' })).status, 422);
  assert.equal((await call('/pair/AAAAAA', { token: TOKEN })).status, 404);
  assert.equal((await call('/pair/AAAAAA')).status, 404);
});

test('expired codes are gone', async (t) => {
  const call = await fixture(t);
  const { code } = await (await call('/pair', {})).json();
  pairs.get(code).expires = Date.now() - 1;
  assert.equal((await call(`/pair/${code}`, { token: TOKEN })).status, 404);
  assert.equal((await call(`/pair/${code}`)).status, 404);
});
