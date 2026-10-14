'use strict';

const { createCanvas, loadImage, registerFont } = require('canvas');
const sharp = require('sharp');
const { fetch: undiciFetch } = require('undici');
const path = require('path');
const fs = require('fs');
const FONTS = require('./fonts');
const { renderMiiImage } = require('./miiAssets');

const FONTS_DIR = path.join(__dirname, '..', 'data', 'fonts');
const MAX_CARD_HEIGHT = 1920;
const MIN_CARD_HEIGHT = 640;
// Image section width as a multiple of card height (clamps narrow/wide images)
const MIN_IMAGE_ASPECT = 0.6;
const MAX_IMAGE_ASPECT = 2.2;
// Reference dimensions at 1920px card height.
// Font reference produces 25px at 516px card height; text section 938px wide.
// All layout sizes scale proportionally with card height using these references.
const TEXT_SECTION_REF_WIDTH = 938;
const TEXT_SECTION_REF_HEIGHT = 1920;
const SEPARATOR_COLOR = '#3a3d42';
const BG_COLOR = '#1A1A1E';
const MAX_TEXT_CHARS = 500;

let config;
try {
  config = require('../config');
} catch {
  config = require('../config.example');
}

const TWEMOJI_BASE = (
  config.twemojiCdnBase || 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72'
).replace(/\/$/, '');

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
        // Font file present but failed to register - not fatal
      }
    }
  }
}
registerAvailableFonts();
registerFont(path.join(FONTS_DIR, 'rodinntlg-bold.ttf'), { family: 'rodinntlg', weight: 'bold' });

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
  const emojiRegex = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/u;
  const tokens = [];
  const segments = new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text);
  for (const { segment } of segments) {
    if (emojiRegex.test(segment)) {
      tokens.push({ type: 'emoji', value: segment });
    } else if (tokens.at(-1)?.type === 'text') {
      tokens.at(-1).value += segment;
    } else {
      tokens.push({ type: 'text', value: segment });
    }
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
          lines.push(currentLine);
          currentLine = [];
          currentWidth = 0;
          continue;
        }
        const wordWidth = ctx.measureText(word).width;
        if (currentWidth + wordWidth > maxWidth && currentLine.length > 0) {
          flush();
        }
        // Hard-break single words that are too wide
        if (wordWidth > maxWidth) {
          let remaining = Array.from(word);
          while (remaining.length > 0) {
            let breakAt = remaining.length;
            while (breakAt > 1 && ctx.measureText(remaining.slice(0, breakAt).join('')).width > maxWidth) {
              breakAt--;
            }
            const segment = remaining.slice(0, breakAt).join('');
            currentLine.push({
              type: 'text',
              value: segment,
              width: ctx.measureText(segment).width
            });
            currentWidth += ctx.measureText(segment).width;
            remaining = remaining.slice(breakAt);
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

/**
 * A doodle card is the drawing itself: no text, Mii or background around it.
 * Flattened onto white and capped in size like any other card.
 */
async function renderDoodle(imageBuffer) {
  let meta;
  try {
    meta = await sharp(imageBuffer).metadata();
  } catch {
    meta = null;
  }
  if (!meta || !meta.width || !meta.height) {
    const err = new Error('That doodle could not be read. Please draw it again.');
    err.code = 'CARD_INPUT';
    throw err;
  }
  return sharp(imageBuffer)
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize({ width: MAX_CARD_HEIGHT, height: MAX_CARD_HEIGHT, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
}

async function generateCard({
  doodle,
  imageBuffer,
  text,
  font,
  textColor,
  background,
  senderName,
  miiData,
  miiExpression,
  includeDate
}) {
  if (doodle) return renderDoodle(imageBuffer);
  text = typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : '';
  if (text.length > MAX_TEXT_CHARS) {
    const err = new Error('Messages can contain up to 500 characters. Please shorten yours.');
    err.code = 'TEXT_OVERFLOW';
    throw err;
  }
  // ---- Determine canvas dimensions ----
  // Natural size, respecting EXIF orientation (sharp reports pre-rotation dims).
  const meta = await sharp(imageBuffer).metadata();
  const swap = meta.orientation >= 5;
  const naturalW = (swap ? meta.height : meta.width) || 1;
  const naturalH = (swap ? meta.width : meta.height) || 1;

  // Card height follows the image height, but is kept within sane bounds so
  // tiny images don't produce an unreadably small card and huge ones stay light.
  const cardHeight = Math.round(Math.min(MAX_CARD_HEIGHT, Math.max(MIN_CARD_HEIGHT, naturalH)));

  // The image section is sized from the image's aspect ratio, clamped so very
  // narrow or very wide images keep a balanced card. The image is fitted
  // (never cropped or stretched) inside this box and centred on the dark background.
  const aspect = naturalW / naturalH;
  const imgSectionWidth = Math.round(
    cardHeight * Math.min(MAX_IMAGE_ASPECT, Math.max(MIN_IMAGE_ASPECT, aspect))
  );
  const fit = Math.min(imgSectionWidth / naturalW, cardHeight / naturalH);
  const drawW = Math.max(1, Math.round(naturalW * fit));
  const drawH = Math.max(1, Math.round(naturalH * fit));
  // Resample with sharp (Lanczos) rather than canvas so both big and small
  // images scale cleanly.
  const uploadedImage = await loadImage(
    await sharp(imageBuffer)
      .rotate()
      .resize(drawW, drawH, { kernel: 'lanczos3', fit: 'fill' })
      .png()
      .toBuffer()
  );

  const SEPARATOR_W = 3;
  const TEXT_SECTION_WIDTH = Math.round(
    (TEXT_SECTION_REF_WIDTH * cardHeight) / TEXT_SECTION_REF_HEIGHT
  );
  const cardWidth = imgSectionWidth + SEPARATOR_W + TEXT_SECTION_WIDTH;

  // ---- Create canvas ----
  const canvas = createCanvas(cardWidth, cardHeight);
  const ctx = canvas.getContext('2d');

  // Dark background fills everything first; text section will be overdrawn in white.
  ctx.fillStyle = BG_COLOR;
  ctx.fillRect(0, 0, cardWidth, cardHeight);

  // ---- Draw uploaded image (left section, fitted, no cropping) ----
  ctx.drawImage(
    uploadedImage,
    Math.round((imgSectionWidth - drawW) / 2),
    Math.round((cardHeight - drawH) / 2),
    drawW,
    drawH
  );

  // ---- Vertical separator ----
  ctx.fillStyle = SEPARATOR_COLOR;
  ctx.fillRect(imgSectionWidth, 0, SEPARATOR_W, cardHeight);

  // ---- White background for text section ----
  const textSectionLeft = imgSectionWidth + SEPARATOR_W;
  ctx.fillStyle = background === 'dark' ? BG_COLOR : '#ffffff';
  ctx.fillRect(textSectionLeft, 0, TEXT_SECTION_WIDTH, cardHeight);

  // Scale factor relative to the 1920px reference height - used for all layout sizes
  const heightScale = cardHeight / TEXT_SECTION_REF_HEIGHT;

  // ---- Date stamp (top-right of text section) ----
  if (includeDate !== false) {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const dateFontSize = Math.round(43 * heightScale);
    const dateMargin = Math.round(30 * heightScale);
    ctx.save();
    ctx.font = `bold ${dateFontSize}px "rodinntlg"`;
    ctx.fillStyle = background === 'dark' ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.45)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(dateStr, cardWidth - dateMargin, dateMargin);
    ctx.restore();
  }

  // ---- Text section ----
  const chosenFontDef = FONTS.find((f) => f.family === font);
  const chosenFont = chosenFontDef ? font : 'Whitney, Helvetica, sans-serif';
  const fontWeight = chosenFontDef && chosenFontDef.weight ? chosenFontDef.weight : 'normal';
  // Font size scales with card height from the 1920px reference.
  const initialFontSize = Math.round(93 * heightScale);
  let fontSize = initialFontSize;
  let lineHeight;
  const resolvedTextColor =
    textColor && /^#[0-9a-fA-F]{3,8}$/.test(textColor) ? textColor
      : background === 'dark' ? '#f5f5f7' : '#111111';

  // Text padding within the text section, scales with height
  const textPadding = Math.round(73 * heightScale);
  const textRightEdge = cardWidth - textPadding;
  const textWrapWidth = TEXT_SECTION_WIDTH - textPadding * 2;

  let miiImage = null;
  let miiW = 0;
  let miiH = 0;
  if (miiData) {
    miiW = Math.round(412 * heightScale);
    miiImage = await loadImage(await renderMiiImage(miiData, miiW, miiExpression));
    const scale = Math.min(miiW / miiImage.width, cardHeight * 0.25 / miiImage.height);
    miiW = Math.round(miiImage.width * scale);
    miiH = Math.round(miiImage.height * scale);
  }
  const textTop = Math.round(170 * heightScale); // well below the date stamp
  const textBottom = cardHeight - textPadding - (miiImage ? miiH + textPadding : 0);
  const tokens = tokenizeText(text);
  let lines;
  const minimumFontSize = Math.max(1, Math.round(initialFontSize * 0.55));
  for (; fontSize >= minimumFontSize; fontSize--) {
    ctx.font = `${fontWeight} ${fontSize}px "${chosenFont}", Whitney, Helvetica, sans-serif`;
    lineHeight = fontSize * 1.45;
    lines = wrapTokensToLines(ctx, tokens, textWrapWidth, fontSize);
    const lineFits = lines.every((line) => line.reduce((width, token) => width + token.width, 0) <= textWrapWidth);
    if (lineFits && lines.length * lineHeight <= textBottom - textTop) break;
  }
  if (fontSize < minimumFontSize) {
    const err = new Error(`This message needs more space in ${chosenFontDef?.name || 'this font'}. Shorten it, choose another font, or remove some line breaks.`);
    err.code = 'TEXT_OVERFLOW';
    throw err;
  }
  ctx.fillStyle = resolvedTextColor;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';

  // Pre-fetch emoji images
  const emojiCache = new Map();
  for (const line of lines) {
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
  let cursorY = textTop;
  for (const line of lines) {
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
  if (miiImage) {
    ctx.drawImage(miiImage, cardWidth - miiW - textPadding, cardHeight - miiH - textPadding, miiW, miiH);
  }

  return canvas.toBuffer('image/png');
}

module.exports = { generateCard };
