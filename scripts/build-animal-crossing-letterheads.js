'use strict';

// Builds a LetterForm .arc for every City Folk paper (Layout/Paper/paperNNN.d/arc/timg/letter_NNN.tpl.png)
// with the Animal Crossing envelope icon (green seal) as the thumbnail.
//
//   node scripts/build-animal-crossing-letterheads.js <.../Layout/Paper>
//
// Needs nintoolbox (wszst + wimgt on PATH) and ndspy_lz10.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

const SRC = process.argv[2];
if (!SRC) {
  console.error('usage: node scripts/build-animal-crossing-letterheads.js <Layout/Paper dir>');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const ARC_DIR = path.join(ROOT, 'data', 'letterheads');
const PREVIEW_DIR = path.join(ROOT, 'public', 'images', 'letterheads');
const NATIVE_DIR = path.join(ROOT, 'public', 'images', 'wii-letters');
const ENVELOPE = path.join(__dirname, 'assets', 'animal-crossing-envelope.png');
const GROUP = 'Animal Crossing - City Folk';

const W = 512;
const H = 376;
const TILES = {
  a: [0, 0, 64, 144], b: [64, 0, 384, 144], c: [448, 0, 64, 144],
  d: [0, 144, 64, 168], e: [64, 144, 384, 168], f: [448, 144, 64, 168],
  g: [0, 312, 64, 64], h: [64, 312, 384, 64], i: [448, 312, 64, 64]
};
const THUMB = [144, 96];

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' });

function tplFolder(dir, files) {
  fs.mkdirSync(path.join(dir, 'img'), { recursive: true });
  for (const [name, png] of Object.entries(files)) {
    const src = path.join(dir, `${name}.png`);
    fs.writeFileSync(src, png);
    run('wimgt', ['encode', src, '--dest', path.join(dir, 'img', `${name}.tpl`), '--transform', 'TPL.RGB5A3', '--overwrite']);
    fs.rmSync(src);
  }
}

function packLz(dir, outFile) {
  run('wszst', ['create', dir, '--u8', '--no-compress', '--dest', `${dir}.u8`, '--overwrite']);
  run('ndspy_lz10', ['compress', `${dir}.u8`, outFile]);
}

async function build(id, letterPng, thumb) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-'));
  try {
    const letter = await sharp(letterPng).resize(W, H, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
    const tiles = {};
    const layers = [];
    for (const [k, [left, top, w, h]] of Object.entries(TILES)) {
      const tile = await sharp(letter).extract({ left, top, width: w, height: h }).png().toBuffer();
      tiles[`my_Letter_${k}`] = tile;
      layers.push({ input: tile, left, top });
    }
    const pack = path.join(tmp, 'arc');
    fs.mkdirSync(pack);
    tplFolder(path.join(tmp, 'letter'), tiles);
    tplFolder(path.join(tmp, 'thumbnail'), { my_LetterS_b: thumb });
    packLz(path.join(tmp, 'letter'), path.join(pack, 'letter_LZ.bin'));
    packLz(path.join(tmp, 'thumbnail'), path.join(pack, 'thumbnail_LZ.bin'));
    run('wszst', ['create', pack, '--u8', '--no-compress', '--dest', path.join(ARC_DIR, `${id}.arc`), '--overwrite']);

    const sheet = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite(layers)
      .png({ compressionLevel: 9 })
      .toBuffer();
    fs.writeFileSync(path.join(NATIVE_DIR, `${id}.png`), sheet);
    fs.writeFileSync(
      path.join(PREVIEW_DIR, `${id}.png`),
      await sharp(sheet).composite([{ input: thumb, left: 8, top: H - THUMB[1] - 8 }]).png({ compressionLevel: 9 }).toBuffer()
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  const thumb = await sharp(ENVELOPE)
    .resize(THUMB[0], THUMB[1], { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: 'lanczos3' })
    .png()
    .toBuffer();
  const manifestPath = path.join(ARC_DIR, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const papers = fs.readdirSync(SRC).filter((d) => /^paper\d+\.d$/.test(d)).sort();
  for (const dir of papers) {
    const n = dir.match(/\d+/)[0];
    const file = path.join(SRC, dir, 'arc', 'timg', `letter_${n}.tpl.png`);
    if (!fs.existsSync(file)) continue;
    const id = `animal-crossing-city-folk-paper-${n}`;
    await build(id, file, thumb);
    const entry = { id, group: GROUP, name: `Animal Crossing - City Folk - Paper ${n}` };
    const at = manifest.findIndex((m) => m.id === id);
    if (at >= 0) manifest[at] = entry;
    else manifest.push(entry);
    console.log('ok  ', id);
  }
  manifest.sort((x, y) => x.id.localeCompare(y.id));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
})();
