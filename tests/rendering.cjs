'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const canvas = require('canvas');
const undici = require('undici');
const createCanvas = canvas.createCanvas;
let draws = [];
let emojiUrls = [];

canvas.createCanvas = (...args) => {
  const result = createCanvas(...args);
  const ctx = result.getContext('2d');
  const fillText = ctx.fillText.bind(ctx);
  ctx.fillText = (text, x, y, ...rest) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      const metrics = ctx.measureText(text);
      draws.push({ text, x, y, right: x + metrics.width,
        bottom: y + metrics.actualBoundingBoxDescent, width: result.width, height: result.height });
    }
    return fillText(text, x, y, ...rest);
  };
  return result;
};
undici.fetch = async (url) => { emojiUrls.push(url); return { ok: false }; };

const { generateCard } = require('../lib/cardGenerator');
const fonts = require('../lib/fonts');
const imageBuffer = fs.readFileSync(path.join(__dirname, '..', 'public', 'images', 'logo.png'));

test('light and dark backgrounds change only the text panel', async () => {
  const sharp = require('sharp');
  const source = await sharp({ create: { width: 100, height: 200, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const sample = async (background) => {
    const output = await generateCard({ imageBuffer: source, text: '', background, includeDate: false });
    const { data, info } = await sharp(output).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = (x, y) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
    return { margin: pixel(0, 320), text: pixel(info.width - 10, 320) };
  };
  assert.deepEqual(await sample('light'), { margin: [26, 26, 30], text: [255, 255, 255] });
  assert.deepEqual(await sample('dark'), { margin: [26, 26, 30], text: [26, 26, 30] });
});

test('long messages stay complete or get a clear overflow error in every font', async () => {
  for (const font of fonts) {
    draws = [];
    let text = 'hello '.repeat(83);
    let image;
    try {
      image = await generateCard({ imageBuffer, text, font: font.family });
    } catch (error) {
      assert.equal(error.code, 'TEXT_OVERFLOW', font.name);
      draws = [];
      text = 'hello '.repeat(40);
      image = await generateCard({ imageBuffer, text, font: font.family });
    }
    assert.ok(image.length > 0);
    assert.equal(draws.map((draw) => draw.text).join(''), text, font.name);
    for (const draw of draws) {
      assert.ok(draw.x >= 0 && draw.right <= draw.width, `${font.name}: text fits horizontally`);
      assert.ok(draw.y >= 0 && draw.bottom <= draw.height, `${font.name}: text fits vertically`);
    }
  }
});

test('blank lines remain visible in the rendered message', async () => {
  draws = [];
  await generateCard({ imageBuffer, text: 'First\n\nLast', font: 'rodinntlg' });
  const first = draws.find((draw) => draw.text === 'First');
  const last = draws.find((draw) => draw.text === 'Last');
  assert.ok(last.y - first.y > 80);
});

test('messages that cannot fit are rejected without clipping', async () => {
  await assert.rejects(generateCard({ imageBuffer, text: 'a\n'.repeat(200) }), /line breaks/);
  await assert.rejects(generateCard({ imageBuffer, text: 'a'.repeat(501) }), /500 characters/);
});

test('joined emoji are rendered as one symbol', async () => {
  draws = [];
  emojiUrls = [];
  await generateCard({ imageBuffer, text: '👩🏽‍💻' });
  assert.equal(emojiUrls.length, 1);
  assert.match(emojiUrls[0], /1f469-1f3fd-200d-1f4bb\.png$/);
  assert.equal(draws.map((draw) => draw.text).join(''), '👩🏽‍💻');
});
