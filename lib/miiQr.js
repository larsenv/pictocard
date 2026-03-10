'use strict';

/**
 * Decode a Mii QR code image into raw Mii binary data (Buffer).
 *
 * Supports Mii QR codes from:
 *  - Nintendo 3DS / Wii U (encode raw 96-byte FFSD Mii binary in the QR payload)
 *  - Switch / Wii / DS (Arian's mii-unsecure API is used as fallback)
 *
 * Strategy:
 *  1. Decode QR code from image using jsqr + canvas pixel data
 *  2. Return raw bytes as a Buffer to be base64-encoded for the render API
 *
 * Uses canvas (already a dependency) instead of sharp to avoid the
 * macOS libgio-2.0 dylib conflict between canvas and sharp.
 */

const { createCanvas, loadImage } = require('canvas');
const jsQR  = require('jsqr');
const axios = require('axios');

const MII_API_BASE = 'https://mii-unsecure.ariankordi.net';

/**
 * Attempt to decode a QR code from an image buffer using jsqr.
 * Returns the decoded bytes as a Buffer, or null on failure.
 * @param {Buffer} imageBuffer
 * @returns {Promise<Buffer|null>}
 */
async function decodeQrWithJsQr(imageBuffer) {
  try {
    const img = await loadImage(imageBuffer);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, img.width, img.height);

    const code = jsQR(imageData.data, img.width, img.height);
    if (!code) return null;

    // The QR payload for 3DS/Wii U Miis is binary; jsqr returns a string
    // with the raw bytes mapped 1:1.  Recover the binary via latin1 encoding.
    const bytes = Buffer.from(code.data, 'latin1');
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Ask Arian's mii-unsecure API to resolve a QR code image into Mii binary.
 * This covers platforms whose QR format jsqr alone may not handle (e.g. Switch NFP).
 * @param {Buffer} imageBuffer
 * @returns {Promise<Buffer|null>}
 */
async function decodeQrWithMiiApi(imageBuffer) {
  try {
    const { FormData, Blob } = require('undici');
    const form = new FormData();
    form.append('image', new Blob([imageBuffer], { type: 'image/png' }), 'qr.png');

    const response = await axios.post(
      `${MII_API_BASE}/mii_data`,
      form,
      {
        timeout: 8000,
        responseType: 'arraybuffer',
        headers: { 'Accept': 'application/octet-stream' }
      }
    );
    if (response.data && response.data.byteLength > 0) {
      return Buffer.from(response.data);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Decode a Mii QR code image and return the Mii binary data as a base64 string
 * suitable for use with the mii-unsecure render API.
 *
 * @param {Buffer} imageBuffer  - Raw image file (JPEG, PNG, WebP, etc.)
 * @returns {Promise<string|null>}  base64 Mii data, or null if decoding failed
 */
async function decodeMiiQr(imageBuffer) {
  // Try local QR decode first (fast, works for 3DS / Wii U)
  const localBytes = await decodeQrWithJsQr(imageBuffer);
  // 3DS/Wii FFSD Miis are 96 bytes; DS Miis (Mii Maker format) are 74 bytes.
  // Accept anything >= 74 to cover both formats.
  if (localBytes && localBytes.length >= 74) {
    return localBytes.toString('base64');
  }

  // Fallback: use Arian's API (handles Switch NFP and other formats)
  const apiBytes = await decodeQrWithMiiApi(imageBuffer);
  if (apiBytes && apiBytes.length >= 74) {
    return apiBytes.toString('base64');
  }

  return null;
}

module.exports = { decodeMiiQr };
