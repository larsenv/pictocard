'use strict';

const maboii = require('maboii');
const { decodeMiiQr } = require('./miiQr');
const API = 'https://mii-unsecure.ariankordi.net';
const MII_SIZES = new Set([46, 47, 48, 68, 72, 74, 76, 88, 92, 96, 104, 106, 336]);
const images = new Map();

function inputError(message) {
  const error = new Error(message);
  error.code = 'CARD_INPUT';
  return error;
}

function serviceError(message) {
  const error = new Error(message);
  error.code = 'MII_SERVICE';
  return error;
}

function validateMiiData(data) {
  if (!Buffer.isBuffer(data) || !MII_SIZES.has(data.length)) {
    throw inputError('That file is not supported Mii data. Choose a Wii, 3DS, Wii U, Switch, or Mii Studio file.');
  }
  return data;
}

function parseMiiData(value) {
  let data = String(value || '').trim();
  if (!data || data.length > 4096) throw inputError('Paste Mii data as hex, Base64, or a Mii Studio image URL.');
  if (/^https?:\/\//i.test(data)) {
    try { data = new URL(data).searchParams.get('data') || ''; }
    catch { throw inputError('That URL does not contain Mii data.'); }
  }
  data = data.replace(/\s+/g, '');
  if (/^(?:[a-f\d]{2})+$/i.test(data)) return validateMiiData(Buffer.from(data, 'hex'));
  if (/^[a-z\d+/]+={0,2}$/i.test(data) && data.length % 4 !== 1) {
    return validateMiiData(Buffer.from(data, 'base64'));
  }
  throw inputError('That Mii data is not valid hex or Base64.');
}

// Public key material used by the reference renderer's amiibo importer.
// https://github.com/Entrivax/maboii.js
const amiiboKeys = maboii.loadMasterKeys([...Buffer.from(
  'HRZLN1typVcouR1ktqPCBXVuZml4ZWQgaW5mb3MAAA7bS54/RSePOX7/m0+5kwAABEkX3Ha0lkDW+Dk5lg+u1O85L6qyFCiqIftU5UUFR2Z/dS0oc6IAF/74XAV1kEttbG9ja2VkIHNlY3JldAAAEP3IoHaUuJ5MR9N96M5cdMEESRfcdrSWQNb4OTmWD67U7zkvqrIUKKoh+1TlRQVHZg==',
  'base64')]);

function readAmiibo(data) {
  if (![532, 540].includes(data.length)) throw inputError('Choose a 532-byte or 540-byte amiibo dump.');
  const padded = Buffer.alloc(540);
  data.copy(padded);
  const result = maboii.unpack(amiiboKeys, [...padded]);
  const plain = result.result ? Buffer.from(result.unpacked) : data[40] === 0xa5 ? data : null;
  if (!plain) throw inputError('That amiibo dump could not be decrypted. Choose a dump from your amiibo.');
  const mii = plain.subarray(76, 172);
  // Switch owners store additional colors after the 3DS/Wii U Mii data.
  const hasExtension = plain[45] === 0 && plain.subarray(196, 216).every((byte) => byte === 0);
  return validateMiiData(hasExtension ? Buffer.concat([mii, plain.subarray(188, 196)]) : mii);
}

async function importCardMii({ source, value, file }) {
  if (source === 'nnid' || source === 'pnid') {
    const id = String(value || '').trim();
    if (!/^[a-z\d._-]{4,16}$/i.test(id)) throw inputError('Enter an ID between 4 and 16 letters, numbers, dots, dashes, or underscores.');
    const url = new URL(`${API}/mii_data/${encodeURIComponent(id)}`);
    if (source === 'pnid') url.searchParams.set('api_id', '1');
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (response.status === 404) throw inputError('No Mii was found for that ID.');
      if (!response.ok) throw serviceError('Mii lookup is unavailable. Try again or use a file.');
      const profile = await response.json();
      return { data: parseMiiData(profile.data || profile.studio_url_data), name: profile.name || id };
    } catch (error) {
      if (['CARD_INPUT', 'MII_SERVICE'].includes(error.code)) throw error;
      throw serviceError('Mii lookup is unavailable. Try again or use a file.');
    }
  }
  if (source === 'data') return { data: parseMiiData(value), name: 'Mii' };
  if (!file) throw inputError('Choose a file to load your Mii.');
  if (source === 'amiibo') return { data: readAmiibo(file), name: 'amiibo Mii' };
  if (source === 'qr') {
    const data = await decodeMiiQr(file);
    if (!data) throw inputError('Could not read a Mii QR code. Try a clearer image.');
    return { data: validateMiiData(data), name: 'QR Mii' };
  }
  if (source === 'file') {
    if (file.length === 532 || file.length === 540) return { data: readAmiibo(file), name: 'amiibo Mii' };
    return { data: validateMiiData(file), name: 'Mii' };
  }
  throw inputError('Choose a Mii source.');
}

async function renderMiiImage(data, width) {
  validateMiiData(data);
  const url = new URL(`${API}/miis/image.png`);
  url.searchParams.set('data', data.toString('hex'));
  url.searchParams.set('width', String(width));
  url.searchParams.set('type', 'face');
  const key = url.href;
  if (images.has(key)) return images.get(key);
  const render = (async () => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (response.status === 400) throw inputError('That Mii data is invalid. Load another Mii.');
      if (!response.ok) throw serviceError('Mii rendering is unavailable. Try again shortly or remove the Mii.');
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      images.delete(key);
      if (['CARD_INPUT', 'MII_SERVICE'].includes(error.code)) throw error;
      throw serviceError('Mii rendering is unavailable. Try again shortly or remove the Mii.');
    }
  })();
  if (images.size >= 64) images.delete(images.keys().next().value);
  images.set(key, render);
  return render;
}

module.exports = { importCardMii, parseMiiData, validateMiiData, renderMiiImage };
