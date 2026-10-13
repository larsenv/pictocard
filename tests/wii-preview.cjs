'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderWiiLetter } = require('../lib/wiiPreview');
const wiiMail = require('../lib/wiiMail');
const face = Buffer.from('AwAAQKBBOMSghAAA27iHMb5gKyoqQgAAWS1KAGEAcwBtAGkAbgBlAAAAAAAAABw3EhB7ASFuQxwNZMcYAAgegg0AMEGzW4JtAABvAHMAaQBnAG8AbgBhAGwAAAAAAJA6', 'base64');

test('native previews are shipped for every selectable letterhead', async () => {
  const ids = ['', ...wiiMail.letterheads().map((letter) => letter.id)];
  for (const id of ids) {
    const file = path.join(__dirname, '..', 'public', 'images', 'wii-letters', `${id || 'default'}.png`);
    assert.equal(fs.existsSync(file), true, file);
  }
  const result = await renderWiiLetter({ text: 'Hello Wii' });
  assert.match(result.pages[0], /^data:image\/png;base64,/);
});

test('Wii faces recover after HTTP and image decoding failures', async (t) => {
  let mode = 'unavailable';
  let requests = 0;
  const image = fs.readFileSync(path.join(__dirname, '..', 'public', 'images', 'logo.png'));
  mock.method(global, 'fetch', async () => {
    requests++;
    return { ok: mode !== 'unavailable', arrayBuffer: async () => mode === 'invalid' ? Buffer.from('not an image') : image };
  });
  t.after(() => mock.restoreAll());
  const options = { text: 'Hello Wii', mii: face };
  assert.equal((await renderWiiLetter(options)).faceUnavailable, true);
  mode = 'invalid';
  assert.equal((await renderWiiLetter(options)).faceUnavailable, true);
  mode = 'available';
  assert.equal((await renderWiiLetter(options)).faceUnavailable, false);
  assert.equal(requests, 3);
  await renderWiiLetter(options);
  assert.equal(requests, 3);
});
