'use strict';

// Mii input: pick a source tab, then the Mii loads on its own as soon as there
// is something to load (typing an ID, choosing/dropping a file, pasting data).
(() => {
  const form = document.getElementById('cardForm');
  const source = document.getElementById('miiSource');
  const file = document.getElementById('miiFile');
  const lookup = document.getElementById('miiLookup');
  const code = document.getElementById('miiCode');
  const stored = document.getElementById('cardMiiData');
  const remove = document.getElementById('removeCardMii');
  const status = document.getElementById('cardMiiStatus');
  const image = document.getElementById('cardMiiThumbnail');
  const hint = document.getElementById('miiSourceHint');
  const drop = document.getElementById('miiDrop');
  const expression = document.getElementById('miiExpression');
  const tabs = [...document.querySelectorAll('[data-mii-tab]')];
  let busy = false;
  let requestId = 0;
  let timer;

  const HINTS = {
    nnid: 'Loads the Mii attached to that Nintendo Network account. You can also drop a file or QR image here.',
    pnid: 'Loads the Mii attached to that Pretendo Network account. You can also drop a file or QR image here.',
    file: 'A Wii, 3DS, Wii U, Switch or Mii Studio file, or an amiibo dump (532 or 540 bytes). Drop it here or paste the data.',
    qr: 'A photo or screenshot of a Mii QR code from a 3DS, Wii U or Switch 2. Drop it here or paste it from your clipboard.'
  };

  function selectTab(tab) {
    source.value = tab;
    const fromId = ['nnid', 'pnid'].includes(tab);
    for (const button of tabs) {
      const active = button.dataset.miiTab === tab;
      button.classList.toggle('tab-active', active);
      button.setAttribute('aria-selected', String(active));
    }
    document.getElementById('miiLookupField').hidden = !fromId;
    document.getElementById('miiFileField').hidden = fromId;
    document.getElementById('miiCodeField').hidden = tab !== 'file';
    document.getElementById('miiLookupLabel').textContent = tab === 'pnid' ? 'Pretendo Network ID' : 'Nintendo Network ID';
    document.getElementById('miiFileLabel').textContent = tab === 'qr' ? 'Upload a Mii QR code image' : 'Upload a Mii file';
    file.accept = tab === 'qr' ? 'image/*' : '';
    file.value = '';
    file.setCustomValidity('');
    hint.textContent = HINTS[tab];
    if (fromId && lookup.value.trim()) loadSoon();
  }

  // Thumbnail of the loaded Mii in the chosen expression
  function faceUrl(data) {
    if (!data || data === 'remove') return '';
    return `/mii-face?data=${encodeURIComponent(data)}&expression=${encodeURIComponent(expression.value)}`;
  }
  expression.addEventListener('change', () => {
    const url = faceUrl(stored.value);
    if (url) image.src = url;
  });

  function report(text, isError) {
    status.textContent = text;
    status.classList.toggle('preview-error', !!isError);
  }

  function ready() {
    if (file.files[0]) return true;
    if (['nnid', 'pnid'].includes(source.value)) return /^[a-z\d._-]{4,16}$/i.test(lookup.value.trim());
    if (source.value === 'file') return code.value.trim().length >= 16;
    return false;
  }

  async function loadMii() {
    clearTimeout(timer);
    if (!ready()) return;
    const id = ++requestId;
    const body = new FormData();
    body.set('_csrf', form.elements._csrf.value);
    const picked = file.files[0];
    // An image on the File tab can only be a QR code
    const kind = picked && picked.type.startsWith('image/') && source.value === 'file' ? 'qr' : source.value;
    body.set('source', kind === 'file' && !picked ? 'data' : kind);
    body.set('value', source.value === 'file' ? code.value : lookup.value);
    if (picked) body.set('miiImportFile', picked);
    busy = true;
    remove.disabled = true;
    form.querySelector('button[type="submit"]').disabled = true;
    report(kind === 'qr' ? 'Scanning QR code…' : 'Loading Mii…');
    try {
      let response = await fetch('/mii-import', { method: 'POST', body });
      if (response.status === 403) {
        const fresh = await fetch('/form-token');
        if (fresh.ok) {
          form.elements._csrf.value = (await fresh.json()).csrfToken;
          body.set('_csrf', form.elements._csrf.value);
          response = await fetch('/mii-import', { method: 'POST', body });
        }
      }
      const result = response.headers.get('content-type')?.includes('application/json')
        ? await response.json() : { error: 'Could not load your Mii. Please try again shortly.' };
      if (id !== requestId) return; // a newer request replaced this one
      if (!response.ok) throw new Error(result.error);
      stored.value = result.data;
      image.src = faceUrl(result.data) || result.image;
      image.hidden = remove.hidden = false;
      file.value = '';
      file.setCustomValidity('');
      report(['nnid', 'pnid'].includes(source.value) ? `Found ${result.name}!` : `✓ ${result.name} loaded onto the PictoCard.`);
      stored.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (error) {
      if (id !== requestId) return;
      report(`✗ ${error.message || 'Could not load your Mii.'}${stored.value && stored.value !== 'remove' ? ' Your current Mii is kept.' : ''}`, true);
      file.value = '';
    } finally {
      if (id === requestId) {
        busy = false;
        remove.disabled = false;
        form.querySelector('button[type="submit"]').disabled = false;
      }
    }
  }

  function loadSoon() {
    clearTimeout(timer);
    timer = setTimeout(loadMii, 500);
  }

  function takeFile(picked) {
    if (!picked) return;
    // Screenshots and photos are QR codes; anything else is Mii data
    if (picked.type.startsWith('image/') && source.value !== 'qr') selectTab('qr');
    else if (!picked.type.startsWith('image/') && ['nnid', 'pnid', 'qr'].includes(source.value)) selectTab('file');
    const transfer = new DataTransfer();
    transfer.items.add(picked);
    file.files = transfer.files;
    loadMii();
  }

  for (const button of tabs) button.addEventListener('click', () => selectTab(button.dataset.miiTab));
  lookup.addEventListener('input', loadSoon);
  lookup.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      loadMii();
    }
  });
  code.addEventListener('input', loadSoon);
  file.addEventListener('change', () => { if (file.files[0]) loadMii(); });

  drop.addEventListener('dragover', (event) => {
    if (![...event.dataTransfer.types].includes('Files')) return;
    event.preventDefault();
    drop.classList.add('drag-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', (event) => {
    drop.classList.remove('drag-over');
    const dropped = event.dataTransfer.files[0];
    if (!dropped) return;
    event.preventDefault();
    takeFile(dropped);
  });
  // Pasting a screenshot of a QR code anywhere in the Mii section loads it
  document.getElementById('extrasGroup').addEventListener('paste', (event) => {
    const pasted = [...(event.clipboardData?.files || [])][0];
    if (!pasted) return;
    event.preventDefault();
    takeFile(pasted);
  });

  remove.addEventListener('click', () => {
    requestId++;
    stored.value = 'remove';
    file.value = '';
    file.setCustomValidity('');
    lookup.value = '';
    code.value = '';
    image.hidden = remove.hidden = true;
    report('Mii removed.');
    stored.dispatchEvent(new Event('change', { bubbles: true }));
  });
  form.addEventListener('submit', (event) => { if (busy) event.preventDefault(); });
  selectTab('nnid');
  // A Mii kept from an earlier visit shows its thumbnail straight away
  if (stored.value && stored.value !== 'remove') {
    image.src = faceUrl(stored.value);
    image.hidden = false;
  }
})();
