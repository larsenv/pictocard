'use strict';

const crypto = require('crypto');
const { createCanvas, loadImage } = require('canvas');
const jsQR = require('jsqr');

/**
 * AES-128 key for 3DS/Wii U Mii QR code encryption.
 * Also known as the slot 0x31 key: https://www.3dbrew.org/wiki/PSPXI:EncryptDecryptAes#Key_Types
 */
const QR_KEY = Buffer.from([
  0x59, 0xfc, 0x81, 0x7e, 0x64, 0x46, 0xea, 0x61, 0x90, 0x34, 0x7b, 0x20, 0xe9, 0xbd, 0xce, 0x52
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
    const nonce = Buffer.concat([nonce8, Buffer.alloc(4)]);
    const padded = Buffer.concat([decrypted, Buffer.alloc(8)]);
    const check = crypto.createCipheriv('aes-128-ccm', QR_KEY, nonce, { authTagLength: 16 });
    check.setAAD(Buffer.alloc(0), { plaintextLength: padded.length });
    check.update(padded);
    check.final();
    if (!crypto.timingSafeEqual(check.getAuthTag(), rawQrBytes.subarray(96, 112))) return null;
    const store = Buffer.concat([decrypted.slice(0, 12), nonce8, decrypted.slice(12)]);
    if (rawQrBytes.length === 144 && rawQrBytes[112] === 0x11) {
      const key = Buffer.from('a93cb12e94861ac1d074bb6019fd0e92', 'hex');
      const extension = crypto.createDecipheriv('aes-128-ccm', key, nonce, { authTagLength: 16 });
      extension.setAuthTag(rawQrBytes.subarray(128, 144));
      extension.setAAD(Buffer.alloc(0), { plaintextLength: 15 });
      const plain = Buffer.concat([extension.update(rawQrBytes.subarray(113, 128)), extension.final()]);
      if (plain[0] !== 1 || !plain.subarray(9).every((byte) => byte === 0)) return null;
      return Buffer.concat([store, rawQrBytes.subarray(112, 113), plain.subarray(0, 9)]);
    }
    if (rawQrBytes.length === 372) {
      const key = Buffer.from('30819f300d06092a864886f70d010101', 'hex');
      const extension = crypto.createDecipheriv('aes-128-ctr', key, rawQrBytes.subarray(112, 128));
      const plain = Buffer.concat([extension.update(rawQrBytes.subarray(128)), extension.final()]);
      const extra = plain.subarray(0, -4);
      const expected = plain.readUInt32LE(plain.length - 4);
      if (crc32(Buffer.concat([rawQrBytes.subarray(0, 112), extra])) !== expected) return null;
      return Buffer.concat([store, extra]);
    }
    return rawQrBytes.length === 112 ? store : null;
  } catch {
    return null;
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) * 0xedb88320);
  }
  return (crc ^ 0xffffffff) >>> 0;
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
    if (code && code.binaryData) {
      // Mii QR codes are always binary.
      const bytes = Buffer.from(code.binaryData);
      // Mii QR codes are always encrypted.
      return decryptMiiQrPayload(bytes);
    }
  } catch {}

  return null;
}

module.exports = { decodeMiiQr, decryptMiiQrPayload };
