'use strict';

const { createCanvas, loadImage, registerFont } = require('canvas');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const FONTS = require('./fonts');

const FONTS_DIR = path.join(__dirname, '..', 'data', 'fonts');
const CARD_HEIGHT = 1920;
const TEXT_SECTION_WIDTH = 938;
const MIN_CARD_WIDTH = 938;
const MAX_CARD_WIDTH = 2560;
const SEPARATOR_COLOR = '#3a3d42';
const BG_COLOR = '#1A1A1E';
const TEXT_COLOR = '#DCDCDF';
const MAX_LINES = 20;
const MAX_TEXT_CHARS = 500;

let config;
try {
  config = require('../config');
} catch {
  config = require('../config.example');
}

const TWEMOJI_BASE = (config.twemojiCdnBase || 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72').replace(/\/$/, '');

// Register fonts that exist on disk
function registerAvailableFonts() {
  for (const font of FONTS) {
    const fontPath = path.join(FONTS_DIR, font.file);
    if (fs.existsSync(fontPath)) {
      try {
        registerFont(fontPath, { family: font.family });
      } catch (err) {
        // Font file present but failed to register – not fatal
      }
    }
  }
}
registerAvailableFonts();

// Fetch an image buffer from a URL, return null on failure
async function fetchImageBuffer(url) {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 5000
    });
    return Buffer.from(response.data);
  } catch {
    return null;
  }
}

// Return the Unicode codepoint(s) for an emoji character as a twemoji hex string
function emojiToTwemojiCode(emoji) {
  const codePoints = [];
  let i = 0;
  while (i < emoji.length) {
    const code = emoji.codePointAt(i);
    codePoints.push(code.toString(16));
    i += code > 0xffff ? 2 : 1;
  }
  // Filter out variation selectors (fe0f) unless it's the only code point
  const filtered = codePoints.filter((cp, idx) => !(cp === 'fe0f' && codePoints.length > 1));
  return filtered.join('-');
}

// Split text into segments of plain text and emoji
function tokenizeText(text) {
  const emojiRegex = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;
  const tokens = [];
  let lastIndex = 0;
  let match;
  while ((match = emojiRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    tokens.push({ type: 'emoji', value: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    tokens.push({ type: 'text', value: text.slice(lastIndex) });
  }
  return tokens;
}

// Wrap tokens into lines that fit within maxWidth pixels
function wrapTokensToLines(ctx, tokens, maxWidth, fontSize) {
  const emojiSize = fontSize;
  const lines = [];
  let currentLine = [];
  let currentWidth = 0;

  const flush = () => {
    if (currentLine.length > 0) {
      lines.push(currentLine);
      currentLine = [];
      currentWidth = 0;
    }
  };

  for (const token of tokens) {
    if (token.type === 'emoji') {
      const w = emojiSize;
      if (currentWidth + w > maxWidth && currentLine.length > 0) {
        flush();
      }
      currentLine.push({ ...token, width: w });
      currentWidth += w;
    } else {
      // Split plain text into words
      const words = token.value.split(/(\n| )/);
      for (const word of words) {
        if (word === '\n') {
          flush();
          continue;
        }
        const wordWidth = ctx.measureText(word).width;
        if (currentWidth + wordWidth > maxWidth && currentLine.length > 0) {
          flush();
        }
        // Hard-break single words that are too wide
        if (wordWidth > maxWidth) {
          let remaining = word;
          while (remaining.length > 0) {
            let breakAt = remaining.length;
            while (breakAt > 0 && ctx.measureText(remaining.slice(0, breakAt)).width > maxWidth) {
              breakAt--;
            }
            const segment = remaining.slice(0, breakAt) || remaining[0];
            currentLine.push({ type: 'text', value: segment, width: ctx.measureText(segment).width });
            currentWidth += ctx.measureText(segment).width;
            remaining = remaining.slice(segment.length);
            if (remaining.length > 0) flush();
          }
        } else {
          currentLine.push({ type: 'text', value: word, width: wordWidth });
          currentWidth += wordWidth;
        }
      }
    }
  }
  flush();
  return lines;
}

async function generateCard({ imageBuffer, text, font, senderName, miiData, includeDate }) {
  // ---- Determine canvas dimensions ----
  const uploadedImage = await loadImage(imageBuffer);
  const imgAspect = uploadedImage.width / uploadedImage.height;

  // Scale image so height fills the "image section" which is the top portion of the 1920px tall card.
  // We want the image to be as wide as the card, so derive the card width from the aspect ratio.
  // Image section height = card height * ~0.6 for a balanced look.
  const imageSectionHeightRatio = 0.60;
  const imageSectionHeight = Math.round(CARD_HEIGHT * imageSectionHeightRatio);
  let cardWidth = Math.round(imageSectionHeight * imgAspect);
  cardWidth = Math.max(MIN_CARD_WIDTH, Math.min(MAX_CARD_WIDTH, cardWidth));

  // ---- Create canvas ----
  const canvas = createCanvas(cardWidth, CARD_HEIGHT);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, cardWidth, CARD_HEIGHT);

  // ---- Draw uploaded image (top section) ----
  // Fit image into the image section, centred
  const scale = Math.min(cardWidth / uploadedImage.width, imageSectionHeight / uploadedImage.height);
  const drawW = uploadedImage.width * scale;
  const drawH = uploadedImage.height * scale;
  const imgX = (cardWidth - drawW) / 2;
  const imgY = (imageSectionHeight - drawH) / 2;
  ctx.drawImage(uploadedImage, imgX, imgY, drawW, drawH);

  // ---- Separator line ----
  ctx.strokeStyle = SEPARATOR_COLOR;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, imageSectionHeight);
  ctx.lineTo(cardWidth, imageSectionHeight);
  ctx.stroke();

  // ---- Date stamp (top-right of card image area) ----
  if (includeDate !== false) {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    ctx.save();
    ctx.font = 'bold 28px Whitney, Helvetica, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(dateStr, cardWidth - 16, 14);
    ctx.restore();
  }

  // ---- Text section ----
  const chosenFont = FONTS.find(f => f.family === font) ? font : 'Whitney, Helvetica, sans-serif';
  const fontSize = 42;
  const lineHeight = fontSize * 1.4;
  const textSectionTop = imageSectionHeight + 10;
  const textX = (cardWidth - TEXT_SECTION_WIDTH) / 2;

  ctx.font = `${fontSize}px "${chosenFont}", Whitney, Helvetica, sans-serif`;
  ctx.fillStyle = TEXT_COLOR;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  // Truncate text before tokenizing
  const safeText = (text || '').slice(0, MAX_TEXT_CHARS);
  const tokens = tokenizeText(safeText);
  const lines = wrapTokensToLines(ctx, tokens, TEXT_SECTION_WIDTH, fontSize);
  const limitedLines = lines.slice(0, MAX_LINES);

  // Pre-fetch emoji images
  const emojiCache = new Map();
  for (const line of limitedLines) {
    for (const token of line) {
      if (token.type === 'emoji' && !emojiCache.has(token.value)) {
        const code = emojiToTwemojiCode(token.value);
        const url = `${TWEMOJI_BASE}/${code}.png`;
        const buf = await fetchImageBuffer(url);
        emojiCache.set(token.value, buf ? await loadImage(buf) : null);
      }
    }
  }

  // Render lines
  let cursorY = textSectionTop + 20;
  for (const line of limitedLines) {
    let cursorX = textX;
    for (const token of line) {
      if (token.type === 'emoji') {
        const img = emojiCache.get(token.value);
        if (img) {
          ctx.drawImage(img, cursorX, cursorY, fontSize, fontSize);
        } else {
          ctx.fillText(token.value, cursorX, cursorY);
        }
        cursorX += fontSize;
      } else {
        ctx.fillStyle = TEXT_COLOR;
        ctx.fillText(token.value, cursorX, cursorY);
        cursorX += ctx.measureText(token.value).width;
      }
    }
    cursorY += lineHeight;
  }

  // ---- Sender name (bottom of text section) ----
  if (senderName) {
    ctx.save();
    ctx.font = `italic ${fontSize}px "${chosenFont}", Whitney, Helvetica, sans-serif`;
    ctx.fillStyle = '#a0a0a8';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`— ${senderName}`, textX + TEXT_SECTION_WIDTH, CARD_HEIGHT - 24);
    ctx.restore();
  }

  // ---- Mii (bottom-right corner) ----
  if (miiData) {
    const miiUrl = `https://mii-unsecure.ariankordi.net/mii_renders?data=${encodeURIComponent(miiData)}&type=face&width=270&shaderType=0&mipmapOff=true`;
    const miiBuf = await fetchImageBuffer(miiUrl);
    if (miiBuf) {
      try {
        const miiImg = await loadImage(miiBuf);
        const miiW = 270;
        const miiH = Math.round((miiImg.height / miiImg.width) * miiW);
        ctx.drawImage(miiImg, cardWidth - miiW - 16, CARD_HEIGHT - miiH - 16, miiW, miiH);
      } catch {
        // Mii render failed – not fatal
      }
    }
  }

  return canvas.toBuffer('image/png');
}

module.exports = { generateCard };
