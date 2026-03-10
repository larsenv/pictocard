'use strict';

const { createCanvas, loadImage, registerFont } = require('canvas');
const { fetch: undiciFetch } = require('undici');
const path = require('path');
const fs = require('fs');
const FONTS = require('./fonts');
const miistudio = require('./miiStudio');

const FONTS_DIR = path.join(__dirname, '..', 'data', 'fonts');
const MAX_CARD_HEIGHT = 1920;
const TEXT_SECTION_RATIO = 203 / 416; // text section width : card height
const SEPARATOR_COLOR = '#3a3d42';
const BG_COLOR = '#1A1A1E';
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
        const opts = { family: font.family };
        if (font.weight) opts.weight = font.weight;
        registerFont(fontPath, opts);
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
    const response = await undiciFetch(url, {
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return null;
    const data = await response.arrayBuffer();
    return Buffer.from(data);
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

async function generateCard({ imageBuffer, text, font, textColor, senderName, miiData, includeDate }) {
  // ---- Determine canvas dimensions ----
  const uploadedImage = await loadImage(imageBuffer);

  // Downscale image if it exceeds the max height; otherwise use natural height.
  const scaleFactor = Math.min(1, MAX_CARD_HEIGHT / uploadedImage.height);
  const cardHeight = Math.round(uploadedImage.height * scaleFactor);
  const imgSectionWidth = Math.round(uploadedImage.width * scaleFactor);

  const SEPARATOR_W = 3;
  const TEXT_SECTION_WIDTH = Math.round(cardHeight * TEXT_SECTION_RATIO);
  const cardWidth = imgSectionWidth + SEPARATOR_W + TEXT_SECTION_WIDTH;

  // ---- Create canvas ----
  const canvas = createCanvas(cardWidth, cardHeight);
  const ctx = canvas.getContext('2d');

  // Dark background fills everything first; text section will be overdrawn in white.
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, cardWidth, cardHeight);

  // ---- Draw uploaded image (left section, no cropping) ----
  ctx.drawImage(uploadedImage, 0, 0, imgSectionWidth, cardHeight);

  // ---- Vertical separator ----
  ctx.fillStyle = SEPARATOR_COLOR;
  ctx.fillRect(imgSectionWidth, 0, SEPARATOR_W, cardHeight);

  // ---- White background for text section ----
  const textSectionLeft = imgSectionWidth + SEPARATOR_W;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(textSectionLeft, 0, TEXT_SECTION_WIDTH, cardHeight);

  // ---- Date stamp (top-right of text section) ----
  if (includeDate !== false) {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    ctx.save();
    ctx.font = 'bold 28px Whitney, Helvetica, sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(dateStr, cardWidth - 20, 20);
    ctx.restore();
  }

  // ---- Text section ----
  const chosenFontDef = FONTS.find(f => f.family === font);
  const chosenFont = chosenFontDef ? font : 'Whitney, Helvetica, sans-serif';
  const fontWeight = (chosenFontDef && chosenFontDef.weight) ? chosenFontDef.weight : 'normal';
  const fontSize = 66;
  const lineHeight = fontSize * 1.45;
  const resolvedTextColor = textColor && /^#[0-9a-fA-F]{3,8}$/.test(textColor) ? textColor : '#111111';

  // Text padding within the 938px section
  const textPadding = 48;
  const textRightEdge = cardWidth - textPadding;
  const textWrapWidth = TEXT_SECTION_WIDTH - textPadding * 2;

  ctx.font = `${fontWeight} ${fontSize}px "${chosenFont}", Whitney, Helvetica, sans-serif`;
  ctx.fillStyle = resolvedTextColor;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';

  // Truncate text before tokenizing
  const safeText = (text || '').slice(0, MAX_TEXT_CHARS);
  const tokens = tokenizeText(safeText);
  const lines = wrapTokensToLines(ctx, tokens, textWrapWidth, fontSize);
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

  // Render lines right-aligned within the text section
  let cursorY = 64;
  for (const line of limitedLines) {
    let lineWidth = 0;
    for (const token of line) {
      lineWidth += token.type === 'emoji' ? fontSize : ctx.measureText(token.value).width;
    }

    // Start x so that the line ends at textRightEdge
    let cursorX = textRightEdge - lineWidth;

    for (const token of line) {
      const tokenW = token.type === 'emoji' ? fontSize : ctx.measureText(token.value).width;
      if (token.type === 'emoji') {
        const img = emojiCache.get(token.value);
        if (img) {
          ctx.drawImage(img, cursorX, cursorY, fontSize, fontSize);
        } else {
          ctx.save();
          ctx.textAlign = 'left';
          ctx.fillStyle = resolvedTextColor;
          ctx.fillText(token.value, cursorX, cursorY);
          ctx.restore();
        }
      } else {
        ctx.save();
        ctx.textAlign = 'left';
        ctx.fillStyle = resolvedTextColor;
        ctx.fillText(token.value, cursorX, cursorY);
        ctx.restore();
      }
      cursorX += tokenW;
    }
    cursorY += lineHeight;
  }

  // ---- Mii (bottom-right corner of text section) ----
  if (miiData) {
    const converter = new miistudio.MiiToStudio();

    // 2. Load the data into the instance
    const result = converter.fromAnyMiiData(miiData.length, miiData);

    // 3. Check if conversion worked, then get the URL from the CONVERTER
    if (result) {
        const miiUrl = converter.getImageUrl(170, false);
        const miiBuf = await fetchImageBuffer(miiUrl);
        if (miiBuf) {
          try {
            const miiImg = await loadImage(miiBuf);
            const miiW = 170;
            const miiH = Math.round((miiImg.height / miiImg.width) * miiW);
            ctx.drawImage(miiImg, cardWidth - miiW + 25, cardHeight - miiH - 7, miiW, miiH);
          } catch {
            // Mii render failed - not fatal
          }
        }
      }
    }

  return canvas.toBuffer('image/png');
}

module.exports = { generateCard };
