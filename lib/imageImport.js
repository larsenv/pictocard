'use strict';

// Download an image from a user-supplied URL. The server makes the request, so
// it must never be steered at internal services: only http(s) on public
// addresses, re-checked on every redirect and at DNS-resolution time.

const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;

function importError(message) {
  const error = new Error(message);
  error.code = 'IMAGE_IMPORT';
  return error;
}

function isPrivateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateV4(mapped[1]);
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff');
}

// Resolve and refuse private addresses; used as the socket's DNS lookup so the
// address that is checked is the address that is connected to.
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
      return callback(importError('That address is not allowed.'));
    }
    if (options && options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function parseUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw importError('Enter a full image URL starting with http:// or https://.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw importError('Enter a full image URL starting with http:// or https://.');
  }
  if (url.username || url.password) throw importError('URLs with a username or password are not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isPrivateAddress(host)) throw importError('That address is not allowed.');
  return url;
}

function request(url) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method: 'GET',
        lookup: safeLookup,
        timeout: TIMEOUT_MS,
        headers: { 'User-Agent': 'PictoCard image import', Accept: 'image/*' }
      },
      resolve
    );
    req.on('timeout', () => req.destroy(importError('That server took too long to respond.')));
    req.on('error', (err) =>
      reject(err.code === 'IMAGE_IMPORT' ? err : importError('Could not download that URL.'))
    );
    req.end();
  });
}

/**
 * @param {string} rawUrl
 * @returns {Promise<Buffer>} the downloaded bytes (not yet validated as an image)
 */
async function downloadImage(rawUrl) {
  let url = parseUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await request(url);
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      if (hop === MAX_REDIRECTS) throw importError('Too many redirects.');
      url = parseUrl(new URL(res.headers.location, url).toString());
      continue;
    }
    if (res.statusCode !== 200) {
      res.resume();
      throw importError(`That server answered with an error (${res.statusCode}).`);
    }
    const length = Number(res.headers['content-length']);
    if (length > MAX_BYTES) {
      res.destroy();
      throw importError('That image is larger than 10 MB.');
    }
    return await new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      res.setTimeout(TIMEOUT_MS, () => res.destroy(importError('The download took too long.')));
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          res.destroy(importError('That image is larger than 10 MB.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', (err) =>
        reject(err.code === 'IMAGE_IMPORT' ? err : importError('The download was interrupted.'))
      );
      res.on('close', () => {
        if (!res.complete && size <= MAX_BYTES) reject(importError('The download was interrupted.'));
      });
    });
  }
  throw importError('Too many redirects.');
}

module.exports = { downloadImage, isPrivateAddress, MAX_BYTES };
