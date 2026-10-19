'use strict';

// Builds envelope-only letterheads: an .arc with just thumbnail_LZ.bin (the
// my_LetterS_b envelope icon), drawn from a PNG in scripts/assets/. The letter
// itself stays the default one. The gallery preview is the icon on its own.
//
//   node scripts/build-envelope-letterheads.js
//
// Needs nintoolbox (wszst + wimgt on PATH) and ndspy_lz10.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const ARC_DIR = path.join(ROOT, 'data', 'letterheads');
const PREVIEW_DIR = path.join(ROOT, 'public', 'images', 'letterheads');
const NATIVE_DIR = path.join(ROOT, 'public', 'images', 'wii-letters');
const THUMB = [144, 96];

const LETTERHEADS = [
  { id: 'letterbomb', group: 'LetterBomb', name: 'LetterBomb', icon: 'letterbomb-icon.png' },
  { id: 'letterbomb-pride', group: 'LetterBomb', name: 'LetterBomb - Pride', icon: 'letterbomb-icon-pride.png' }
];

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' });

async function build(lh) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'envelope-'));
  try {
    const thumb = await sharp(path.join(__dirname, 'assets', lh.icon))
      .resize(THUMB[0], THUMB[1], { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: 'lanczos3' })
      .png()
      .toBuffer();
    const dir = path.join(tmp, 'thumbnail');
    fs.mkdirSync(path.join(dir, 'img'), { recursive: true });
    const png = path.join(dir, 'my_LetterS_b.png');
    fs.writeFileSync(png, thumb);
    run('wimgt', ['encode', png, '--dest', path.join(dir, 'img', 'my_LetterS_b.tpl'), '--transform', 'TPL.RGB5A3', '--overwrite']);
    fs.rmSync(png);
    run('wszst', ['create', dir, '--u8', '--no-compress', '--dest', `${dir}.u8`, '--overwrite']);
    const pack = path.join(tmp, 'arc');
    fs.mkdirSync(pack);
    run('ndspy_lz10', ['compress', `${dir}.u8`, path.join(pack, 'thumbnail_LZ.bin')]);
    run('wszst', ['create', pack, '--u8', '--no-compress', '--dest', path.join(ARC_DIR, `${lh.id}.arc`), '--overwrite']);
    fs.writeFileSync(path.join(PREVIEW_DIR, `${lh.id}.png`), thumb);
    fs.copyFileSync(path.join(NATIVE_DIR, 'default.png'), path.join(NATIVE_DIR, `${lh.id}.png`));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  const manifestPath = path.join(ARC_DIR, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const lh of LETTERHEADS) {
    await build(lh);
    const entry = { id: lh.id, group: lh.group, name: lh.name, envelope: true };
    const at = manifest.findIndex((m) => m.id === lh.id);
    if (at >= 0) manifest[at] = entry;
    else manifest.push(entry);
    console.log('ok  ', lh.id);
  }
  manifest.sort((x, y) => x.id.localeCompare(y.id));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
})();
