'use strict';

/**
 * Decode a Mii QR code image into raw Mii binary data (Buffer).
 *
 * Supports Mii QR codes from:
 *  - Nintendo 3DS / Wii U (8-byte nonce + AES-128-CCM encrypted 88-byte payload)
 *  - Switch / Wii / DS (Arian's mii-unsecure API is used as fallback)
 *
 * Strategy:
 *  1. Decode QR code from image using jsqr + canvas pixel data
 *  2. AES-128-CCM decrypt the 96-byte payload (8-byte nonce + 88-byte ciphertext)
 *  3. Return the decrypted 96-byte Mii binary to be passed into the MiiToStudio converter
 *
 * Uses canvas (already a dependency) instead of sharp to avoid the
 * macOS libgio-2.0 dylib conflict between canvas and sharp.
 */

const { handleDecryption } = require('./qrHandle');
const crypto = require('crypto');
const { createCanvas, loadImage } = require('canvas');
const jsQR = require('jsqr');
const { fetch, FormData } = require('undici');

// Blob is a Node.js global since v18; undici does not export it

const MII_API_BASE = 'https://mii-unsecure.ariankordi.net';

/**
 * AES-128 key used to encrypt all 3DS / Wii U Mii QR code payloads.
 * Source: https://www.3dbrew.org/wiki/Mii_QR_codes
 */
const QR_KEY = Buffer.from([
  0x59, 0xFC, 0x81, 0x7E, 0x64, 0x46, 0xEA, 0x61,
  0x90, 0x34, 0x7B, 0x20, 0xE9, 0xBD, 0xCE, 0x52
]);

/**
 * Decrypt a 3DS / Wii U Mii QR payload using AES-128-CCM (CTR component).
 *
 * QR format (96 bytes total):
 *   bytes  0– 7 : nonce (8 bytes)
 *   bytes  8–95 : AES-128-CCM encrypted Mii data (88 bytes)
 *
 * CCM uses CTR mode for encryption.  The CTR IV for message bytes is:
 *   byte 0      : 0x02  (flags = L−1 for L=3, nonce_len=12)
 *   bytes 1–12  : nonce (8 original bytes + 4 zero-padding bytes)
 *   bytes 13–15 : counter = 1 (big-endian, 3 bytes)
 *
 * After decryption the Mii binary is reconstructed as:
 *   plaintext[0:12] + nonce[0:8] + plaintext[12:]  →  96 bytes of FFLStoreData
 *
 * @param {Buffer} rawQrBytes  Exactly 96 bytes from the QR code payload
 * @returns {Buffer|null}  96-byte decrypted Mii binary, or null on error
 */
async function decryptMiiQrPayload(buf) {
  const dat = {
    bytes: new Uint8Array(buf)
  };
  const dec = await handleDecryption(dat);
  console.log(dec);
  return dec;
}

/**
 * Attempt to decode a QR code from an image buffer using jsqr.
 * Returns the decoded bytes as a Buffer, or null on failure.
 * @param {Buffer} imageBuffer
 * @returns {Promise<Buffer|null>}
 */
async function decodeQrWithJsQr(imageBuffer) {
  try {
    console.log(`[miiQr] loading image (${imageBuffer.length} bytes) for jsqr scan`);
    const img = await loadImage(imageBuffer);
    console.log(`[miiQr] image loaded: ${img.width}x${img.height}`);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, img.width, img.height);

    const code = jsQR(imageData.data, img.width, img.height);
    if (!code) {
      console.log('[miiQr] jsqr: no QR code found in image');
      return null;
    }

    // Use binaryData (Uint8ClampedArray of raw bytes) when available — binary
    // QR payloads contain bytes like 0x00 that are lost in a JS string.
    // jsqr 1.4.0+ always populates binaryData; the latin1 fallback is a
    // safety net for unexpected older builds.
    if (!code.binaryData) {
      console.log('[miiQr] jsqr: binaryData unavailable, falling back to latin1 string decode (may lose null bytes)');
    }
    const bytes = code.binaryData
      ? Buffer.from(code.binaryData)
      : Buffer.from(code.data, 'latin1');
    console.log(`[miiQr] jsqr: QR code found, payload length=${bytes.length}`);

    // 3DS / Wii U Mii QR payloads are AES-128-CCM encrypted:
    //   bytes  0– 7 : nonce (8 bytes)
    //   bytes  8–95 : ciphertext (88 bytes)
    // Total = 96 bytes.  Decrypt to recover the 96-byte FFLStoreData binary.
    if (bytes.length === 112) {
      console.log('[miiQr] 112-byte payload detected — attempting AES-CCM decrypt (3DS/Wii U QR format)');
      const decrypted = decryptMiiQrPayload(bytes);
      if (decrypted) {
        console.log(`[miiQr] AES-CCM decrypt succeeded → ${decrypted.length} bytes`);
        return decrypted;
      }
      console.log('[miiQr] AES-CCM decrypt failed, returning raw QR bytes');
    }
    return bytes;
  } catch (err) {
    console.log(`[miiQr] jsqr: error during decode: ${String(err.message || err).replace(/[\r\n]/g, ' ').slice(0, 200)}`);
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
    console.log(`[miiQr] trying mii-unsecure API fallback (${imageBuffer.length} bytes)`);
    const form = new FormData();
    form.append('image', new Blob([imageBuffer], { type: 'image/png' }), 'qr.png');

    const response = await fetch(
      `${MII_API_BASE}/mii_data`,
      {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(8000),
        headers: { 'Accept': 'application/octet-stream' }
      }
    );
    console.log(`[miiQr] mii-unsecure API response: status=${response.status}`);
    if (!response.ok) return null;
    const data = await response.arrayBuffer();
    if (data.byteLength > 0) {
      console.log(`[miiQr] mii-unsecure API returned ${data.byteLength} bytes`);
      return Buffer.from(data);
    }
    console.log('[miiQr] mii-unsecure API returned empty response');
    return null;
  } catch (err) {
    console.log(`[miiQr] mii-unsecure API error: ${String(err.message || err).replace(/[\r\n]/g, ' ').slice(0, 200)}`);
    return null;
  }
}

/**
 * Decode a Mii QR code image and return the raw Mii binary data as a Buffer.
 * Returns null if decoding failed or the file doesn't contain a valid Mii QR code.
 *
 * @param {Buffer} imageBuffer  - Raw image file (JPEG, PNG, WebP, etc.)
 * @returns {Promise<Buffer|null>}  Raw Mii binary bytes, or null if decoding failed
 */
async function decodeMiiQr(imageBuffer) {
  // Try local QR decode first (fast, works for 3DS / Wii U)
  const localBytes = await decodeQrWithJsQr(imageBuffer);
  // 3DS/Wii U FFLStoreData Miis are 96 bytes; Wii Miis are 74 bytes.
  // Accept anything >= 74 to cover both formats.
  if (localBytes && localBytes.length >= 74) {
    console.log(`[miiQr] local jsqr decode succeeded (${localBytes.length} bytes >= 74)`);
    return localBytes;
  }
  if (localBytes) {
    console.log(`[miiQr] local jsqr result too short (${localBytes.length} bytes < 74), trying API`);
  }

  // Fallback: use Arian's API (handles Switch NFP and other formats)
  const apiBytes = await decodeQrWithMiiApi(imageBuffer);
  if (apiBytes && apiBytes.length >= 74) {
    console.log(`[miiQr] API decode succeeded (${apiBytes.length} bytes >= 74)`);
    return apiBytes;
  }
  if (apiBytes) {
    console.log(`[miiQr] API result too short (${apiBytes.length} bytes < 74)`);
  }

  console.log('[miiQr] all decode attempts failed, returning null');
  return null;
}

module.exports = { decodeMiiQr };
