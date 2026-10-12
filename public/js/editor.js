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
    'miiFile', 'wiiMii', 'senderName', 'wiiImage', 'wiiCardText', 'letterhead', 'wiiAttach', 'cardBackground']);
  let timer;
  let revision = 0;
  let running = false;
  const fieldValues = new WeakMap();
  const valueOf = (field) => field.type === 'file' ? field.files[0] : `${field.value}:${field.checked || false}`;
  for (const field of form.elements) {
    if (fields.has(field.name)) fieldValues.set(field, valueOf(field));
  }

  function showPreview(open) {
    preview.classList.toggle('preview-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'Close preview' : 'Preview card';
  }
  toggle.addEventListener('click', () => showPreview(!preview.classList.contains('preview-open')));
  close.addEventListener('click', () => { showPreview(false); toggle.focus(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && preview.classList.contains('preview-open')) {
      showPreview(false);
      toggle.focus();
    }
  });

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
      message.setCustomValidity('');
      cardMessage.setCustomValidity('');
      image.hidden = result.wii || !result.image;
      heading.textContent = result.wii ? 'Wii Letter Preview' : 'Live Preview';
      description.textContent = result.wii
        ? 'Select the attachment to enlarge it. Select it again to return to the letter.'
        : document.getElementById('deliveryMethod').value === 'discord'
          ? 'This is the image sent in the Discord message. Nothing is sent until you confirm.'
          : 'This is the image sent by email. Nothing is sent until you confirm.';
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
