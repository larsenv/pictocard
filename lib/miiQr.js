'use strict';

const crypto = require('crypto');
const { createCanvas, loadImage } = require('canvas');
const jsQR = require('jsqr');
const { fetch, FormData } = require('undici');

const MII_API_BASE = 'https://mii-unsecure.ariankordi.net';

// AES-128 key for 3DS/Wii U Mii QR codes
const QR_KEY = Buffer.from([
  0x59, 0xFC, 0x81, 0x7E, 0x64, 0x46, 0xEA, 0x61,
  0x90, 0x34, 0x7B, 0x20, 0xE9, 0xBD, 0xCE, 0x52
]);

/**
 * Decrypt a 3DS/Wii U Mii QR payload (AES-128-CCM, CTR portion).
 * Format: 8-byte nonce + 88-byte ciphertext = 96 bytes total.
 * Result: content[0:12] + nonce[0:8] + content[12:] = 96-byte FFLStoreData.
 * @param {Buffer} rawQrBytes  96+ bytes from QR code (only first 96 are used)
 * @returns {Buffer|null}
 */
function decryptMiiQrPayload(rawQrBytes) {
  if (!rawQrBytes || rawQrBytes.length < 96) return null;
  try {
    const nonce8 = rawQrBytes.slice(0, 8);
    const ciphertext = rawQrBytes.slice(8, 96);
    // CTR IV: flags(0x02) + nonce(8) + zero-pad(4) + counter(3) = 16 bytes
    const iv = Buffer.alloc(16);
    iv[0] = 0x02;
    nonce8.copy(iv, 1);
    iv[15] = 0x01;
    const decipher = crypto.createDecipheriv('aes-128-ctr', QR_KEY, iv);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return Buffer.concat([decrypted.slice(0, 12), nonce8, decrypted.slice(12)]);
  } catch {
    return null;
  }
}

/**
 * Decode a Mii QR code image and return raw Mii binary data.
 * Returns null if decoding failed.
 * @param {Buffer} imageBuffer  Raw image file (JPEG, PNG, etc.)
 * @returns {Promise<Buffer|null>}
 */
async function decodeMiiQr(imageBuffer) {
  // Try local QR decode first (jsqr + canvas)
  try {
    const img = await loadImage(imageBuffer);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, img.width, img.height);
    const code = jsQR(imageData.data, img.width, img.height);
    if (code) {
      const bytes = code.binaryData
        ? Buffer.from(code.binaryData)
        : Buffer.from(code.data, 'latin1');
      if (bytes.length >= 96) {
        const decrypted = decryptMiiQrPayload(bytes);
        if (decrypted) return decrypted;
      }
      // Return raw bytes for Wii/Switch/DS formats, or as fallback if decrypt failed
      if (bytes.length >= 74) return bytes;
    }
  } catch {}

  // Fallback: Arian's mii-unsecure API (handles Switch NFP and other formats)
  try {
    const form = new FormData();
    form.append('image', new Blob([imageBuffer], { type: 'image/png' }), 'qr.png');
    const response = await fetch(`${MII_API_BASE}/mii_data`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(8000),
      headers: { 'Accept': 'application/octet-stream' }
    });
    if (response.ok) {
      const data = await response.arrayBuffer();
      if (data.byteLength >= 74) return Buffer.from(data);
    }
  } catch {}

  return null;
}

module.exports = { decodeMiiQr };
