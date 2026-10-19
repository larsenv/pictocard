'use strict';

// Builds the Nintendo Channel letterhead with the Wii logo as LetterForm .arc archives from
// scripts/assets/nintendo-channel-sheet.png (letter artwork + envelope icon pairs),
// with the channel's sound.bns (scripts/assets/sound.bns) in the archive root.
//
//   node scripts/build-nintendo-channel-letterheads.js
//
// Needs nintoolbox (wszst + wimgt on PATH) and ndspy_lz10. Outputs, per letterhead:
//   data/letterheads/<id>.arc, public/images/letterheads/<id>.png,
//   public/images/wii-letters/<id>.png, and an entry in data/letterheads/manifest.json

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SOUND = path.join(__dirname, 'assets', 'sound.bns');
const SHEET = path.join(__dirname, 'assets', 'nintendo-channel-sheet.png');
const ARC_DIR = path.join(ROOT, 'data', 'letterheads');
const PREVIEW_DIR = path.join(ROOT, 'public', 'images', 'letterheads');
const NATIVE_DIR = path.join(ROOT, 'public', 'images', 'wii-letters');

const W = 512;
const H = 376;
const TILES = {
  a: [0, 0, 64, 144], b: [64, 0, 384, 144], c: [448, 0, 64, 144],
  d: [0, 144, 64, 168], e: [64, 144, 384, 168], f: [448, 144, 64, 168],
  g: [0, 312, 64, 64], h: [64, 312, 384, 64], i: [448, 312, 64, 64]
};
// Stock thumbnail size (my_LetterS_b)
const THUMB = [144, 96];

// Crops from the sheet: [left, top, width, height] and the backdrop colour to key out.
const LETTERHEADS = [
  {
    id: 'nintendo-channel-2', name: 'Nintendo Channel - 2',
    letter: [1, 240, 316, 232], env: [318, 240, 88, 58], key: [4, 126, 131]
  }
];

/** Crop a region and make the sheet's backdrop colour transparent. */
async function cut(region, key) {
  const [left, top, width, height] = region;
  const { data, info } = await sharp(SHEET)
    .extract({ left, top, width, height })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const d = Math.abs(data[i] - key[0]) + Math.abs(data[i + 1] - key[1]) + Math.abs(data[i + 2] - key[2]);
    if (d < 24) data[i + 3] = 0;
  }
  return sharp(data, { raw: info }).png().toBuffer();
}

function run(cmd, args, opts) {
  return execFileSync(cmd, args, { stdio: 'pipe', ...opts });
}

function tplFolder(dir, files) {
  const img = path.join(dir, 'img');
  fs.mkdirSync(img, { recursive: true });
  for (const [name, png] of Object.entries(files)) {
    const src = path.join(dir, `${name}.png`);
    fs.writeFileSync(src, png);
    run('wimgt', ['encode', src, '--dest', path.join(img, `${name}.tpl`), '--transform', 'TPL.RGB5A3', '--overwrite']);
    fs.rmSync(src);
  }
}

/** img/ folder -> U8 -> LZ10, the way the Message Board expects letter_LZ.bin */
function packLz(dir, outFile) {
  const u8 = `${dir}.u8`;
  run('wszst', ['create', dir, '--u8', '--no-compress', '--dest', u8, '--overwrite']);
  run('ndspy_lz10', ['compress', u8, outFile]);
}

async function build(lh) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wiimenu-'));
  try {
    const letter = await sharp(await cut(lh.letter, lh.key)).resize(W, H, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
    const tiles = {};
    const layers = [];
    for (const [k, [left, top, w, h]] of Object.entries(TILES)) {
      const tile = await sharp(letter).extract({ left, top, width: w, height: h }).png().toBuffer();
      tiles[`my_Letter_${k}`] = tile;
      layers.push({ input: tile, left, top });
    }
    const thumb = await sharp(await cut(lh.env, lh.key))
      .resize(THUMB[0], THUMB[1], { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: 'lanczos3' })
      .png()
      .toBuffer();

    const pack = path.join(tmp, 'arc');
    fs.mkdirSync(pack);
    const letterDir = path.join(tmp, 'letter');
    const thumbDir = path.join(tmp, 'thumbnail');
    tplFolder(letterDir, tiles);
    tplFolder(thumbDir, { my_LetterS_b: thumb });
    packLz(letterDir, path.join(pack, 'letter_LZ.bin'));
    packLz(thumbDir, path.join(pack, 'thumbnail_LZ.bin'));
    fs.copyFileSync(SOUND, path.join(pack, 'sound.bns'));
    const arc = path.join(ARC_DIR, `${lh.id}.arc`);
    run('wszst', ['create', pack, '--u8', '--no-compress', '--dest', arc, '--overwrite']);

    const sheetPng = await sharp({
      create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
    })
      .composite(layers)
      .png({ compressionLevel: 9 })
      .toBuffer();
    fs.writeFileSync(path.join(NATIVE_DIR, `${lh.id}.png`), sheetPng);
    fs.writeFileSync(
      path.join(PREVIEW_DIR, `${lh.id}.png`),
      await sharp(sheetPng)
        .composite([{ input: thumb, left: 8, top: H - THUMB[1] - 8 }])
        .png({ compressionLevel: 9 })
        .toBuffer()
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  for (const d of [ARC_DIR, PREVIEW_DIR, NATIVE_DIR]) fs.mkdirSync(d, { recursive: true });
  const manifestPath = path.join(ARC_DIR, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const lh of LETTERHEADS) {
    await build(lh);
    const entry = { id: lh.id, group: 'Nintendo Channel', name: lh.name };
    const at = manifest.findIndex((m) => m.id === lh.id);
    if (at >= 0) manifest[at] = entry;
    else manifest.push(entry);
    console.log('ok  ', lh.id);
  }
  manifest.sort((x, y) => x.id.localeCompare(y.id));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
})();
