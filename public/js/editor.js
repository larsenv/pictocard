'use strict';

(() => {
  const form = document.getElementById('cardForm');
  const preview = document.getElementById('livePreview');
  const image = document.getElementById('liveCardImage');
  const letter = document.getElementById('wiiLetterPreview');
  const status = document.getElementById('previewStatus');
  const heading = document.getElementById('previewHeading');
  const description = document.getElementById('previewDescription');
  const message = document.getElementById('cardText');
  const cardMessage = document.getElementById('wiiCardText');
  const counter = document.getElementById('charCounter');
  const toggle = document.getElementById('openPreview');
  const close = document.getElementById('closePreview');
  const fields = new Set(['cardImage', 'presetImage', 'cardText', 'fontFamily', 'textColor',
    'cardMiiData', 'wiiMii', 'senderName', 'wiiImage', 'wiiCardText', 'letterhead', 'wiiAttach', 'cardBackground']);
  let timer;
  let revision = 0;
  let running = false;
  let busyRetries = 0;
  const fieldValues = new WeakMap();
  const valueOf = (field) => field.type === 'file' ? field.files[0] : `${field.value}:${field.checked || false}`;
  for (const field of form.elements) {
    if (fields.has(field.name)) fieldValues.set(field, valueOf(field));
  }

  const pictureInput = document.getElementById('cardImage');
  const pictureThumbnail = document.getElementById('pictureThumbnail');
  const pictureName = document.getElementById('pictureFileName');
  const choosePicture = document.getElementById('choosePicture');
  choosePicture.addEventListener('click', () => pictureInput.click());

  function showPicture(source, name) {
    pictureThumbnail.src = source;
    pictureThumbnail.hidden = false;
    pictureName.textContent = name;
    choosePicture.textContent = 'Change picture';
  }
  pictureThumbnail.addEventListener('error', () => { pictureThumbnail.hidden = true; });
  pictureInput.addEventListener('change', () => {
    const file = pictureInput.files[0];
    if (!file) return;
    for (const preset of form.querySelectorAll('[name="presetImage"]')) {
      preset.checked = false;
      fieldValues.set(preset, valueOf(preset));
    }
    const url = URL.createObjectURL(file);
    pictureThumbnail.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
    pictureThumbnail.addEventListener('error', () => URL.revokeObjectURL(url), { once: true });
    showPicture(url, file.name);
  });

  // Import the picture from a URL: the server downloads it, then it is put in
  // the picture field exactly like a file the user chose.
  function setupImport(urlId, buttonId, statusId, target) {
    const importUrl = document.getElementById(urlId);
    const importButton = document.getElementById(buttonId);
    const importStatus = document.getElementById(statusId);
    if (!importUrl || !importButton || !importStatus || !target) return;
    const importHint = importStatus.textContent;
    function importMessage(text, isError) {
      importStatus.textContent = text;
      importStatus.classList.toggle('field-error', !!isError);
    }
    async function importImage() {
      const url = importUrl.value.trim();
      if (!url) return importMessage('Paste an image link first.', true);
      importButton.disabled = true;
      importMessage('Importing…');
      try {
        const send = () => fetch('/image-import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': form.elements._csrf.value },
          body: JSON.stringify({ url })
        });
        let response = await send();
        if (response.status === 403) {
          const fresh = await fetch('/form-token');
          if (fresh.ok) {
            form.elements._csrf.value = (await fresh.json()).csrfToken;
            response = await send();
          }
        }
        if (!response.ok) {
          const type = response.headers.get('content-type') || '';
          const body = type.includes('application/json') ? await response.json() : {};
          return importMessage(body.error || 'Could not import that image. Please try again.', true);
        }
        const blob = await response.blob();
        const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }[blob.type] || 'img';
        let name = 'imported-image';
        try { name = decodeURIComponent(new URL(url).pathname.split('/').pop()) || name; } catch { /* keep default */ }
        if (!/\.(jpe?g|png|gif|webp)$/i.test(name)) name = `${name.replace(/\.[^.]*$/, '')}.${extension}`;
        const transfer = new DataTransfer();
        transfer.items.add(new File([blob], name, { type: blob.type }));
        target.files = transfer.files;
        target.dispatchEvent(new Event('change', { bubbles: true }));
        importMessage(importHint);
        importUrl.value = '';
      } catch {
        importMessage('Could not import that image. Check your connection and try again.', true);
      } finally {
        importButton.disabled = false;
      }
    }
    importButton.addEventListener('click', importImage);
    importUrl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        importImage();
      }
    });
  }
  setupImport('imageUrl', 'importImage', 'imageUrlStatus', pictureInput);
  setupImport('wiiImageUrl', 'importWiiImage', 'wiiImageUrlStatus', document.getElementById('wiiImage'));

  function showPreview(open) {
    preview.classList.toggle('preview-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'Close' : 'Open';
  }
  toggle.addEventListener('click', () => showPreview(!preview.classList.contains('preview-open')));
  close.addEventListener('click', () => { showPreview(false); toggle.focus(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && preview.classList.contains('preview-open')) {
      showPreview(false);
      toggle.focus();
    }
  });

  const content = document.querySelector('.live-preview-content');
  function alignPreviewGrid() {
    const active = letter.hidden ? image : letter;
    const height = active.hidden ? 0 : active.getBoundingClientRect().height;
    if (!height) return;
    const rows = Math.floor((height + 38) / 14);
    content.style.setProperty('--preview-gap', `${(rows * 14 - height) / 2}px`);
  }
  const previewSize = new ResizeObserver(alignPreviewGrid);
  previewSize.observe(image);
  previewSize.observe(letter);
  image.addEventListener('load', alignPreviewGrid);

  async function updatePreview() {
    if (running) return;
    running = true;
    const current = revision;
    status.textContent = 'Updating preview…';
    status.classList.remove('preview-error');
    try {
      let response = await fetch('/card-preview', { method: 'POST', body: new FormData(form) });
      if (response.status === 403) {
        const fresh = await fetch('/form-token');
        if (fresh.ok) {
          const token = await fresh.json();
          form.elements._csrf.value = token.csrfToken;
          response = await fetch('/card-preview', { method: 'POST', body: new FormData(form) });
        }
      }
      const result = response.headers.get('content-type')?.includes('application/json')
        ? await response.json() : { error: 'Could not refresh the preview. Reload this page and try again.' };
      if (current !== revision) return;
      if (!response.ok) {
        if (response.status === 429) {
          status.textContent = result.error || 'Preview is busy. Please try again shortly.';
          status.classList.add('preview-error');
          if (busyRetries++ < 4) {
            const delay = Number(response.headers.get('Retry-After')) || 2;
            timer = setTimeout(updatePreview, Math.min(60_000, Math.max(500, delay * 1000)));
          }
          return;
        }
        image.hidden = true;
        letter.hidden = true;
        status.textContent = result.error || 'Could not update the preview. Please try again.';
        status.classList.add('preview-error');
        if (result.textOverflow) {
          const field = result.textField === 'wiiCardText' ? cardMessage : message;
          field.setCustomValidity(result.error);
          counter.textContent = `${message.value.length} / 500 · check message length`;
        }
        return;
      }
      busyRetries = 0;
      message.setCustomValidity('');
      cardMessage.setCustomValidity('');
      image.hidden = result.wii || !result.image;
      heading.textContent = result.wii ? 'Wii letter preview' : 'Live preview';
      description.textContent = result.wii
        ? 'Select the attachment to enlarge it. Select it again to return to the letter.'
        : document.getElementById('deliveryMethod').value === 'discord'
          ? 'This is the image sent in the Discord message. Nothing is sent until you confirm.'
          : "This is the card image they'll receive. You'll review everything before sending.";
      if (result.image && !result.wii) image.src = result.image;
      letter.hidden = !result.wii;
      if (result.wii) document.dispatchEvent(new CustomEvent('wii-preview-update', { detail: result }));
      status.textContent = result.needsImage ? 'Choose a picture to see your attachment.' : 'Preview is up to date.';
      if (result.native?.faceUnavailable) status.textContent += ' Face preview unavailable.';
      counter.textContent = `${message.value.length} / 500`;
    } catch {
      if (current === revision) {
        image.hidden = true;
        letter.hidden = true;
        status.textContent = 'Preview unavailable. Check your connection and try editing again.';
        status.classList.add('preview-error');
      }
    } finally {
      running = false;
      if (current !== revision) {
        clearTimeout(timer);
        timer = setTimeout(updatePreview, 250);
      }
    }
  }

  function schedulePreview() {
    busyRetries = 0;
    revision++;
    clearTimeout(timer);
    status.textContent = 'Updating preview…';
    message.setCustomValidity('');
    cardMessage.setCustomValidity('');
    counter.textContent = `${message.value.length} / 500`;
    timer = setTimeout(updatePreview, 400);
  }
  function fieldChanged(event) {
    const field = event.target;
    if (!fields.has(field.name)) return;
    const value = valueOf(field);
    if (fieldValues.get(field) === value) return;
    fieldValues.set(field, value);
    if (field.type === 'radio') {
      for (const radio of form.elements) {
        if (radio.type === 'radio' && radio.name === field.name) fieldValues.set(radio, valueOf(radio));
      }
    }
    if (field.name === 'presetImage' && field.checked) {
      pictureInput.value = '';
      fieldValues.set(pictureInput, valueOf(pictureInput));
      showPicture(field.value, 'Preset picture');
    }
    if (field.name === 'cardBackground') {
      const color = document.getElementById('textColor');
      if (['#111111', '#f5f5f7'].includes(color.value)) {
        color.value = field.value === 'dark' ? '#f5f5f7' : '#111111';
        document.getElementById('colorLabel').textContent = color.value;
        fieldValues.set(color, valueOf(color));
      }
    }
    schedulePreview();
  }
  form.addEventListener('input', fieldChanged);
  form.addEventListener('change', fieldChanged);
  form.addEventListener('click', (event) => {
    if (event.target.closest('.tab-btn')) schedulePreview();
  });
  updatePreview();
})();
