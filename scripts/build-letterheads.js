'use strict';

// Builds the Wii letterhead gallery from RiiConnect24/WMB-Letterhead.
//
//   node scripts/build-letterheads.js <path-to-WMB-Letterhead> [--all]
//
// Uses nintoolbox (wszst + wimgt on PATH) to unpack each .arc and decode its
// nine letter tiles, assembles them into the 512x376 letterhead, and puts the
// envelope icon in the bottom-left corner. Outputs:
//   public/images/letterheads/<id>.png   gallery preview
//   data/letterheads/<id>.arc            the original archive, attached to mail
//   data/letterheads/manifest.json       gallery metadata
// The outputs are committed, so servers don't need nintoolbox.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

const SRC = process.argv[2];
const ALL = process.argv.includes('--all');
if (!SRC) {
  console.error('usage: node scripts/build-letterheads.js <WMB-Letterhead dir> [--all]');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const PREVIEW_DIR = path.join(ROOT, 'public', 'images', 'letterheads');
const ARC_DIR = path.join(ROOT, 'data', 'letterheads');

const W = 512;
const H = 376;
// Tile origin for my_Letter_a..i (see Helper/letter.sh in WMB-Letterhead)
const TILES = {
  a: [0, 0], b: [64, 0], c: [448, 0],
  d: [0, 144], e: [64, 144], f: [448, 144],
  g: [0, 312], h: [64, 312], i: [448, 312]
};

// One-time letters are left out: all of "Calling" except the image-embedding
// one (CALLING_KEEP), and RiiConnect24's Valentine's Day letters.
const CALLING_KEEP = process.env.CALLING_KEEP || '';
function excluded(group, file) {
  if (ALL) return false;
  if (group === 'Calling') return file !== CALLING_KEEP;
  if (/Valentine/i.test(file)) return true;
  if (group === 'Wii Menu') return true; // loose PNG tiles, no .arc to attach
  return false;
}

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

async function build(arcPath, group, name) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-'));
  try {
    fs.copyFileSync(arcPath, path.join(tmp, 'a.arc'));
    execFileSync('wszst', ['xx', 'a.arc'], { cwd: tmp, stdio: 'pipe' });
    const lettersDir = path.join(tmp, 'a.d', 'letter_LZ.bin.d', 'img');
    const thumbDir = path.join(tmp, 'a.d', 'thumbnail_LZ.bin.d', 'img');

    const layers = [];
    for (const [k, [left, top]] of Object.entries(TILES)) {
      const f = path.join(lettersDir, `my_Letter_${k}.tpl.png`);
      if (fs.existsSync(f)) layers.push({ input: f, left, top });
    }
    if (layers.length < 9) throw new Error(`only ${layers.length}/9 letter tiles`);

    // Envelope icon -> bottom-left corner
    const thumb = path.join(thumbDir, 'my_LetterS_b.tpl.png');
    if (fs.existsSync(thumb)) {
      const { height } = await sharp(thumb).metadata();
      layers.push({ input: thumb, left: 8, top: H - height - 8 });
    }

    const out = await sharp({
      create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
    })
      .composite(layers)
      .png({ compressionLevel: 9 })
      .toBuffer();
    return out;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  fs.mkdirSync(ARC_DIR, { recursive: true });
  const root = fs.existsSync(path.join(SRC, 'Letterhead')) ? path.join(SRC, 'Letterhead') : SRC;
  const manifest = [];
  for (const arc of walk(root).filter((f) => f.endsWith('.arc')).sort()) {
    const rel = path.relative(root, arc).split(path.sep);
    const group = rel.length > 1 ? rel[0] : 'Other';
    const file = path.basename(arc, '.arc');
    if (excluded(group, file)) continue;
    const id = slug(file);
    try {
      const png = await build(arc, group, file);
      fs.writeFileSync(path.join(PREVIEW_DIR, `${id}.png`), png);
      fs.copyFileSync(arc, path.join(ARC_DIR, `${id}.arc`));
      manifest.push({ id, group, name: file });
      console.log('ok  ', id);
    } catch (err) {
      console.error('FAIL', file, err.message);
    }
  }
  fs.writeFileSync(path.join(ARC_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`${manifest.length} letterheads`);
})();
