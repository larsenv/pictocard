'use strict';

const multer = require('multer');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 2 * MAX_FILE_BYTES;
const MAX_RENDER_REQUESTS = 2;
let activeRenders = 0;
const submissions = new Set();

function releaseOnCompletion(req, res, release) {
  let released = false;
  const done = () => {
    if (released) return;
    released = true;
    release();
  };
  res.once('finish', done);
  res.once('close', () => { if (!req.rendering) done(); });
  return done;
}

function renderWork(req, res, next) {
  if (activeRenders >= MAX_RENDER_REQUESTS) {
    res.set('Retry-After', '2');
    return res.status(429).json({ error: 'Card rendering is busy. Please try again shortly.' });
  }
  activeRenders++;
  req.releaseRender = releaseOnCompletion(req, res, () => { activeRenders--; });
  next();
}

function startRender(req, res) {
  if (res.destroyed) {
    req.releaseRender?.();
    req.releaseSubmission?.();
    return false;
  }
  req.rendering = true;
  return true;
}

function finishRender(req) {
  req.rendering = false;
  if (req.res.destroyed) {
    req.releaseRender?.();
    req.releaseSubmission?.();
  }
}

function singleSubmission(req, res, next) {
  const key = req.sessionID || req.session;
  if (submissions.has(key)) {
    return res.status(409).send('A card submission is already in progress. Please wait for it to finish.');
  }
  submissions.add(key);
  req.releaseSubmission = releaseOnCompletion(req, res, () => submissions.delete(key));
  next();
}

// Count bytes across all accepted files, before adding each chunk to memory.
const uploadStorage = {
  _handleFile(req, file, callback) {
    const chunks = [];
    let size = 0;
    let failed = false;
    file.stream.on('data', (chunk) => {
      if (failed) return;
      req.uploadBytes = (req.uploadBytes || 0) + chunk.length;
      if (req.uploadBytes > MAX_UPLOAD_BYTES) {
        failed = true;
        chunks.length = 0;
        const error = new multer.MulterError('LIMIT_FILE_SIZE', file.fieldname);
        error.code = 'LIMIT_UPLOAD_BYTES';
        error.message = 'Combined uploads must be under 20 MB.';
        callback(error);
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    file.stream.once('error', (error) => {
      if (!failed) {
        failed = true;
        callback(error);
      }
    });
    file.stream.once('end', () => {
      if (!failed) callback(null, { buffer: Buffer.concat(chunks), size });
    });
  },
  _removeFile(_req, file, callback) {
    delete file.buffer;
    callback(null);
  }
};

module.exports = {
  renderWork, startRender, finishRender, singleSubmission, uploadStorage, MAX_FILE_BYTES
};
