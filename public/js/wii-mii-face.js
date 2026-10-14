'use strict';

// Shows the Mii face rendered from the chosen Wii Mii file, using the same
// /mii-face renderer as the PictoCard Mii.
(() => {
  const input = document.getElementById('wiiMii');
  const result = document.getElementById('wiiMiiResult');
  const image = document.getElementById('wiiMiiThumbnail');
  if (!input || !result || !image) return;

  const toBase64 = (bytes) => {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };

  image.addEventListener('error', () => { result.hidden = true; });
  input.addEventListener('change', async () => {
    result.hidden = true;
    const file = input.files[0];
    if (!file || file.size > 1024) return;
    const data = toBase64(new Uint8Array(await file.arrayBuffer()));
    image.src = `/mii-face?data=${encodeURIComponent(data)}`;
    result.hidden = false;
  });
})();
