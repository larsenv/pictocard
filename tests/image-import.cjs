'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { downloadImage, isPrivateAddress } = require('../lib/imageImport');

test('private and internal addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', '64:ff9b::7f00:1', '2002:7f00:1::1', '0:0:0:0:0:0:0:1', 'ff02::1', 'fe80::1%en0']) {
    assert.ok(isPrivateAddress(ip), ip);
  }
  for (const ip of ['8.8.8.8', '140.82.112.3', '2606:4700::1111', '::ffff:808:808', '2001:db8::1']) assert.ok(!isPrivateAddress(ip), ip);
});

test('downloadImage refuses unsafe URLs before connecting', async () => {
  for (const url of ['ftp://example.com/a.png', 'not a url', 'http://127.0.0.1/a.png', 'http://[::1]/a.png', 'http://user:pw@example.com/a.png', 'http://localhost/a.png']) {
    await assert.rejects(downloadImage(url), { code: 'IMAGE_IMPORT' }, url);
  }
});
