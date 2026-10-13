'use strict';

(() => {
  const root = document.getElementById('wiiLetterPreview');
  if (!root) return;
  const letter = document.getElementById('liveLetterhead');
  const target = document.getElementById('wiiAttachmentTarget');
  const expanded = document.getElementById('wiiExpanded');
  const attachment = document.getElementById('wiiExpandedImage');
  const stage = root.querySelector('.wii-preview-stage');
  const controls = root.querySelector('.wii-preview-controls');
  const previous = document.getElementById('wiiPrevious');
  const next = document.getElementById('wiiNext');
  const label = document.getElementById('wiiPage');
  const message = document.getElementById('liveLetterText');
  let data;
  let page = 0;
  let viewingAttachment = false;
  let animation = null;
  let transitioning = false;
  let attachmentRect;

  function fitAttachment() {
    if (!attachment.naturalWidth || !attachment.naturalHeight) return;
    const scale = Math.min(448 / attachment.naturalWidth, 300 / attachment.naturalHeight);
    const width = attachment.naturalWidth * scale + 16;
    const height = attachment.naturalHeight * scale + 28;
    attachmentRect = { x: (512 - width) / 2, y: (376 - height) / 2, width, height };
    Object.assign(expanded.style, frameStyle(attachmentRect));
  }

  function frameStyle(rect, thumbnail = false) {
    const scale = stage.getBoundingClientRect().width / 512;
    const edge = (thumbnail ? 4 : 8) * scale;
    const bottom = (thumbnail ? 14 : 20) * scale;
    return {
      left: `${rect.x / 512 * 100}%`, top: `${rect.y / 376 * 100}%`,
      width: `${rect.width / 512 * 100}%`, height: `${rect.height / 376 * 100}%`,
      padding: `${edge}px ${edge}px ${bottom}px`
    };
  }

  function display() {
    if (!data) return;
    letter.src = data.native.pages[page];
    letter.dataset.letterhead = data.letterhead;
    expanded.hidden = !viewingAttachment && !transitioning;
    target.hidden = !data.image || viewingAttachment || transitioning;
    controls.hidden = data.native.pages.length <= 1;
    controls.inert = viewingAttachment || transitioning;
    controls.style.visibility = controls.inert ? 'hidden' : '';
    previous.hidden = next.hidden = label.hidden = data.native.pages.length <= 1;
    previous.disabled = page === 0;
    next.disabled = page === data.native.pages.length - 1;
    label.textContent = `${page + 1} / ${data.native.pages.length}`;
    if (data.native.attachmentRect) {
      const rect = data.native.attachmentRect;
      Object.assign(target.style, {
        left: `${rect.x / 512 * 100}%`, top: `${rect.y / 376 * 100}%`,
        width: `${rect.width / 512 * 100}%`, height: `${rect.height / 376 * 100}%`
      });
    }
  }

  function update(value) {
    animation?.cancel();
    animation = null;
    transitioning = false;
    data = value;
    page = Math.min(page, data.native.pages.length - 1);
    if (!data.image) viewingAttachment = false;
    if (data.image && attachment.src !== data.image) attachment.src = data.image;
    fitAttachment();
    message.textContent = data.text;
    root.hidden = false;
    display();
  }
  async function toggleAttachment() {
    if (!data.image || !attachmentRect) return;
    const style = getComputedStyle(expanded);
    const from = animation
      ? Object.fromEntries(Object.keys(frameStyle(attachmentRect)).map((key) => [key, style[key]]))
      : viewingAttachment ? frameStyle(attachmentRect) : frameStyle(data.native.attachmentRect, true);
    animation?.cancel();
    viewingAttachment = !viewingAttachment;
    transitioning = true;
    display();
    const to = viewingAttachment ? frameStyle(attachmentRect) : frameStyle(data.native.attachmentRect, true);
    const current = expanded.animate([from, to], {
      duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 240,
      easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'both'
    });
    animation = current;
    try { await current.finished; } catch { return; }
    animation = null;
    transitioning = false;
    Object.assign(expanded.style, frameStyle(attachmentRect));
    display();
    current.cancel();
    (viewingAttachment ? expanded : target).focus({ preventScroll: true });
  }
  target.addEventListener('click', toggleAttachment);
  expanded.addEventListener('click', toggleAttachment);
  attachment.addEventListener('load', fitAttachment);
  new ResizeObserver(fitAttachment).observe(stage);
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && viewingAttachment) {
      event.preventDefault();
      event.stopPropagation();
      toggleAttachment();
    }
  });
  previous.addEventListener('click', () => { if (page > 0) { page--; display(); } });
  next.addEventListener('click', () => { if (page < data.native.pages.length - 1) { page++; display(); } });
  document.addEventListener('wii-preview-update', (event) => update(event.detail));
  const initial = document.getElementById('wiiPreviewData');
  if (initial) update(JSON.parse(initial.textContent));
})();
