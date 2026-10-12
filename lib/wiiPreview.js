'use strict';

const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');
const wiiMail = require('./wiiMail');
const { MiiToStudio } = require('./miiToStudio.mjs');

const WIDTH = 512;
const HEIGHT = 376;
const TEXT_X = 48;
const TEXT_Y = 166;
const TEXT_WIDTH = 416;
const LINE_HEIGHT = 42;
const PAGE_LINES = 4;
const faceCache = new Map();

registerFont(path.join(__dirname, '..', 'data', 'fonts', 'greco.ttf'), { family: 'Wii Greco' });
registerFont(path.join(__dirname, '..', 'data', 'fonts', 'rodinntlg-header.ttf'), {
  family: 'Wii Rodin'
});

async function faceImage(mii) {
  if (!mii) return null;
  const key = mii.toString('hex');
  if (faceCache.has(key)) return faceCache.get(key);
  const render = (async () => {
    const converter = new MiiToStudio();
    if (!converter.fromAnyMiiData(mii.length, mii) || !converter.isValid()) return null;
    try {
      const url = new URL(converter.getImageUrl(128, false));
      url.searchParams.set('type', 'fflmakeicon');
      url.searchParams.set('shaderType', 'wiiu');
      url.searchParams.set('resourceType', 'middle');
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return null;
      return await loadImage(Buffer.from(await response.arrayBuffer()));
    } catch {
      return null;
    }
  })();
  if (faceCache.size >= 64) faceCache.delete(faceCache.keys().next().value);
  faceCache.set(key, render);
  return render;
}

function textLines(ctx, text) {
  const lines = [];
  // Start with the same hard line breaks written into the outgoing Wii mail.
  for (const line of wiiMail.wordWrap(text.trim()).split(/\r?\n/)) {
    let current = '';
    for (const character of Array.from(line)) {
      if (current && ctx.measureText(current + character).width > TEXT_WIDTH) {
        lines.push(current);
        current = '';
      }
      current += character;
    }
    lines.push(current);
  }
  return lines;
}

function thumbnail(ctx, image) {
  const scale = Math.min(64 / image.width, 64 / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  const rect = { x: WIDTH - 24 - width - 8, y: 66, width: width + 8, height: height + 18 };
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.shadowColor = 'transparent';
  ctx.drawImage(image, rect.x + 4, rect.y + 4, width, height);
  ctx.restore();
  return rect;
}

async function renderWiiLetter({ senderName = '', text = '', letterhead = '', mii = null, jpeg = null }) {
  const id = wiiMail.findLetterhead(letterhead)?.id || 'default';
  const paper = await loadImage(path.join(__dirname, '..', 'public', 'images', 'wii-letters', `${id}.png`));
  const face = await faceImage(mii);
  const attachment = jpeg ? await loadImage(jpeg) : null;
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.font = '20px "Wii Greco"';
  const lines = textLines(ctx, text);
  const pages = [];
  let attachmentRect = null;
  for (let offset = 0; offset < lines.length; offset += PAGE_LINES) {
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.drawImage(paper, 0, 0, WIDTH, HEIGHT);
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.font = '20px "Wii Rodin"';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(senderName).replace(/[\r\n\t]+/g, ' ').trim() || 'Someone', WIDTH / 2, 34, 360);
    ctx.restore();
    if (face) {
      const scale = Math.min(48 / face.width, 64 / face.height);
      ctx.drawImage(face, 40, 72, face.width * scale, face.height * scale);
    }
    if (attachment) attachmentRect = thumbnail(ctx, attachment);
    ctx.save();
    ctx.fillStyle = '#454545';
    ctx.font = '20px "Wii Greco"';
    ctx.textBaseline = 'top';
    for (let index = 0; index < PAGE_LINES && offset + index < lines.length; index++) {
      ctx.fillText(lines[offset + index], TEXT_X, TEXT_Y + index * LINE_HEIGHT);
    }
    ctx.restore();
    pages.push(`data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`);
  }
  return { pages, attachmentRect, faceUnavailable: !!mii && !face };
}

module.exports = { renderWiiLetter };
