'use strict';

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const maboii = require('maboii');
const { importCardMii, parseMiiData, renderMiiImage } = require('../lib/miiAssets');
const { decryptMiiQrPayload } = require('../lib/miiQr');
const sample = Buffer.from('AwAAQKBBOMSghAAA27iHMb5gKyoqQgAAWS1KAGEAcwBtAGkAbgBlAAAAAAAAABw3EhB7ASFuQxwNZMcYAAgegg0AMEGzW4JtAABvAHMAaQBnAG8AbgBhAGwAAAAAAJA6', 'base64');
const image = fs.readFileSync('public/images/logo.png');

function wrapQr(data) {
  const nonce = Buffer.concat([data.subarray(12, 20), Buffer.alloc(4)]);
  const content = Buffer.concat([data.subarray(0, 12), data.subarray(20), Buffer.alloc(8)]);
  const cipher = crypto.createCipheriv('aes-128-ccm', Buffer.from('59fc817e6446ea6190347b20e9bdce52', 'hex'), nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.alloc(0), { plaintextLength: content.length });
  const encrypted = Buffer.concat([cipher.update(content), cipher.final()]);
  return Buffer.concat([data.subarray(12, 20), encrypted.subarray(0, 88), cipher.getAuthTag()]);
}

test('data imports preserve original bytes and never fetch pasted URLs', async () => {
  assert.deepEqual(parseMiiData(sample.toString('base64')), sample);
  assert.deepEqual(parseMiiData(sample.toString('hex')), sample);
  assert.deepEqual(parseMiiData(`https://studio.mii.nintendo.com/miis/image.png?data=${sample.toString('hex')}`), sample);
  assert.deepEqual((await importCardMii({ source: 'file', file: sample })).data, sample);
  for (const size of [46, 47, 48, 68, 74, 76, 88, 92, 104, 106, 336]) {
    assert.equal((await importCardMii({ source: 'file', file: Buffer.alloc(size) })).data.length, size);
  }
  assert.throws(() => parseMiiData('https://example.com/private'), /not valid/);
  assert.throws(() => parseMiiData('file:///etc/passwd'), /not valid/);
  assert.throws(() => parseMiiData('00'), /not supported/);
});

test('NNID and PNID lookups use the correct fixed service and preserve profile data', async (t) => {
  const urls = [];
  mock.method(global, 'fetch', async (url) => {
    urls.push(String(url));
    return { ok: true, json: async () => ({ data: sample.toString('base64'), name: 'Jasmine' }) };
  });
  t.after(() => mock.restoreAll());
  for (const source of ['nnid', 'pnid']) {
    const result = await importCardMii({ source, value: 'JasmineChlora' });
    assert.equal(result.name, 'Jasmine');
    assert.deepEqual(result.data, sample);
  }
  assert.equal(urls[0], 'https://mii-unsecure.ariankordi.net/mii_data/JasmineChlora');
  assert.equal(urls[1], 'https://mii-unsecure.ariankordi.net/mii_data/JasmineChlora?api_id=1');
  await assert.rejects(importCardMii({ source: 'nnid', value: '../invalid' }), /Enter an ID/);
});

test('QR decryption authenticates ordinary and enhanced Switch 2 payloads', () => {
  const qr = wrapQr(sample);
  assert.deepEqual(decryptMiiQrPayload(qr), sample);
  const bad = Buffer.from(qr);
  bad[20] ^= 1;
  assert.equal(decryptMiiQrPayload(bad), null);
  const nonce = Buffer.concat([qr.subarray(0, 8), Buffer.alloc(4)]);
  const extra = Buffer.from([1, 8, 19, 24, 7, 28, 56, 67, 3, 0, 0, 0, 0, 0, 0]);
  const cipher = crypto.createCipheriv('aes-128-ccm', Buffer.from('a93cb12e94861ac1d074bb6019fd0e92', 'hex'), nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.alloc(0), { plaintextLength: extra.length });
  const encrypted = Buffer.concat([cipher.update(extra), cipher.final()]);
  const enhanced = Buffer.concat([qr, Buffer.from([0x11]), encrypted, cipher.getAuthTag()]);
  assert.deepEqual(decryptMiiQrPayload(enhanced), Buffer.concat([sample, Buffer.from([0x11]), extra.subarray(0, 9)]));
  enhanced[130] ^= 1;
  assert.equal(decryptMiiQrPayload(enhanced), null);
});

test('amiibo imports retain extended colors from encrypted and decrypted dumps', async () => {
  const keyData = Buffer.from('HRZLN1typVcouR1ktqPCBXVuZml4ZWQgaW5mb3MAAA7bS54/RSePOX7/m0+5kwAABEkX3Ha0lkDW+Dk5lg+u1O85L6qyFCiqIftU5UUFR2Z/dS0oc6IAF/74XAV1kEttbG9ja2VkIHNlY3JldAAAEP3IoHaUuJ5MR9N96M5cdMEESRfcdrSWQNb4OTmWD67U7zkvqrIUKKoh+1TlRQVHZg==', 'base64');
  const plain = Buffer.alloc(540);
  plain[40] = 0xa5;
  sample.copy(plain, 76);
  const extra = Buffer.from([8, 28, 19, 40, 52, 6, 1, 0]);
  extra.copy(plain, 188);
  const expected = Buffer.concat([sample, extra]);
  assert.deepEqual((await importCardMii({ source: 'amiibo', file: plain })).data, expected);
  const encrypted = Buffer.from(maboii.pack(maboii.loadMasterKeys([...keyData]), [...plain]));
  for (const length of [532, 540]) {
    assert.deepEqual((await importCardMii({ source: 'amiibo', file: encrypted.subarray(0, length) })).data, expected);
  }
  await assert.rejects(importCardMii({ source: 'amiibo', file: Buffer.alloc(540) }), /could not be decrypted/);
});

test('renderer failures remain errors and can recover without silently dropping a Mii', async (t) => {
  let available = false;
  mock.method(global, 'fetch', async () => ({ ok: available, status: 503, arrayBuffer: async () => image }));
  t.after(() => mock.restoreAll());
  await assert.rejects(renderMiiImage(sample, 129), /rendering is unavailable/);
  available = true;
  assert.deepEqual(await renderMiiImage(sample, 129), image);
});
