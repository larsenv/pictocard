'use strict';

(() => {
  const form = document.getElementById('cardForm');
  const source = document.getElementById('miiSource');
  const file = document.getElementById('miiFile');
  const lookup = document.getElementById('miiLookup');
  const code = document.getElementById('miiCode');
  const stored = document.getElementById('cardMiiData');
  const load = document.getElementById('loadCardMii');
  const remove = document.getElementById('removeCardMii');
  const status = document.getElementById('cardMiiStatus');
  const image = document.getElementById('cardMiiThumbnail');
  const hint = document.getElementById('miiSourceHint');
  let busy = false;

  function selectSource() {
    const fromId = ['nnid', 'pnid'].includes(source.value);
    document.getElementById('miiLookupField').hidden = !fromId;
    document.getElementById('miiCodeField').hidden = source.value !== 'data';
    document.getElementById('miiFileField').hidden = fromId || source.value === 'data';
    document.getElementById('miiLookupLabel').textContent = source.value === 'pnid'
      ? 'Pretendo Network ID' : 'Nintendo Network ID';
    file.accept = source.value === 'qr' ? 'image/*' : '';
    file.value = '';
    file.setCustomValidity('');
    hint.textContent = source.value === 'qr' ? 'Choose a Mii QR code image from a 3DS, Wii U, or Switch 2.'
      : source.value === 'amiibo' ? 'Choose an encrypted or decrypted amiibo dump (532 or 540 bytes).'
      : source.value === 'data' ? 'Paste the data itself or a Studio image URL containing a data parameter.'
      : fromId ? 'Loads the Mii attached to that Nintendo or Pretendo account.'
      : 'Wii, 3DS, Wii U, Switch, or Mii Studio data. The Mii is drawn onto the PictoCard image.';
  }

  async function loadMii() {
    if (busy) return;
    const body = new FormData();
    body.set('_csrf', form.elements._csrf.value);
    body.set('source', source.value);
    body.set('value', source.value === 'data' ? code.value : lookup.value);
    if (file.files[0]) body.set('miiImportFile', file.files[0]);
    busy = true;
    load.disabled = remove.disabled = source.disabled = true;
    form.querySelector('button[type="submit"]').disabled = true;
    status.textContent = 'Loading Mii…';
    status.classList.remove('preview-error');
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
      if (!response.ok) throw new Error(result.error);
      stored.value = result.data;
      image.src = result.image;
      image.hidden = remove.hidden = false;
      file.value = '';
      file.setCustomValidity('');
      status.textContent = `${result.name} loaded onto the PictoCard.`;
      stored.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (error) {
      status.textContent = `${error.message || 'Could not load your Mii.'}${stored.value && stored.value !== 'remove' ? ' Your current Mii is kept.' : ''}`;
      status.classList.add('preview-error');
      file.value = '';
    } finally {
      busy = false;
      const active = document.getElementById('extrasGroup').style.display !== 'none';
      load.disabled = source.disabled = remove.disabled = !active;
      form.querySelector('button[type="submit"]').disabled = false;
    }
  }
  source.addEventListener('change', selectSource);
  file.addEventListener('change', () => { if (file.files[0]) loadMii(); });
  load.addEventListener('click', loadMii);
  remove.addEventListener('click', () => {
    stored.value = 'remove';
    file.value = '';
    file.setCustomValidity('');
    image.hidden = remove.hidden = true;
    status.textContent = 'Mii removed.';
    status.classList.remove('preview-error');
    stored.dispatchEvent(new Event('change', { bubbles: true }));
  });
  form.addEventListener('submit', (event) => { if (busy) event.preventDefault(); });
})();
