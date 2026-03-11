'use strict';

const crypto = require('crypto');
const { createCanvas, loadImage } = require('canvas');
const jsQR = require('jsqr');

/**
 * AES-128 key for 3DS/Wii U Mii QR code encryption.
 * Also known as the slot 0x31 key: https://www.3dbrew.org/wiki/PSPXI:EncryptDecryptAes#Key_Types
 */
const QR_KEY = Buffer.from([
  0x59, 0xFC, 0x81, 0x7E, 0x64, 0x46, 0xEA, 0x61,
  0x90, 0x34, 0x7B, 0x20, 0xE9, 0xBD, 0xCE, 0x52
]);

/**
 * Decrypt a 3DS/Wii U Mii QR code payload (AES-128-CCM, CTR portion).
 * Format: 8-byte nonce + 88-byte ciphertext + 16-byte tag = 112 bytes.
 * @param {Buffer} rawQrBytes 112+ bytes from QR code (only first 112 are used)
 * @returns {Buffer|null} 96-byte FFLStoreData.
 */
function decryptMiiQrPayload(rawQrBytes) {
  if (!rawQrBytes || rawQrBytes.length < 112) return null;
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
    if (code && code.binaryData) { // Mii QR codes are always binary.
      const bytes = Buffer.from(code.binaryData);
      // Mii QR codes are always encrypted.
      return decryptMiiQrPayload(bytes);
    }
  } catch {}

  return null;
}

module.exports = { decodeMiiQr };
