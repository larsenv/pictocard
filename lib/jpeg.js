'use strict';

const sharp = require('sharp');

// mozjpeg-tuned, but strictly baseline (sequential) so the Wii can decode it.
// optimiseScans would force progressive output, so it stays off; Huffman table
// optimisation, trellis quantisation and deringing still shrink the file.
const BASELINE_OPTIONS = {
  progressive: false,
  chromaSubsampling: '4:2:0',
  optimiseScans: false,
  optimiseCoding: true,
  trellisQuantisation: true,
  overshootDeringing: true,
  quantisationTable: 3
};

/**
 * Encode a sharp pipeline as the smallest practical baseline JPEG.
 * Metadata (EXIF, ICC, XMP) is dropped: sharp strips it unless withMetadata is used.
 * @param {import('sharp').Sharp} pipeline
 * @param {number} quality 1-100
 * @returns {Promise<Buffer>}
 */
function encodeBaselineJpeg(pipeline, quality) {
  return pipeline.jpeg({ ...BASELINE_OPTIONS, quality }).toBuffer();
}

/**
 * Re-encode any image buffer as a compact baseline JPEG, flattened onto white
 * with EXIF orientation applied.
 */
function compressToBaselineJpeg(input, quality = 80) {
  return encodeBaselineJpeg(sharp(input).rotate().flatten({ background: '#ffffff' }), quality);
}

module.exports = { encodeBaselineJpeg, compressToBaselineJpeg };
