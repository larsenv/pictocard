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
    Object.assign(expanded.style, {
      left: `${attachmentRect.x / 512 * 100}%`, top: `${attachmentRect.y / 376 * 100}%`,
      width: `${width / 512 * 100}%`, height: `${height / 376 * 100}%`
    });
  }

  function thumbnailTransform() {
    const thumb = data.native.attachmentRect;
    return `translate(${(thumb.x - attachmentRect.x) / 512 * stage.clientWidth}px,
      ${(thumb.y - attachmentRect.y) / 376 * stage.clientHeight}px)
      scale(${thumb.width / attachmentRect.width}, ${thumb.height / attachmentRect.height})`;
  }

  function display() {
    if (!data) return;
    letter.src = data.native.pages[page];
    letter.dataset.letterhead = data.letterhead;
    expanded.hidden = !viewingAttachment && !transitioning;
    target.hidden = !data.image || viewingAttachment || transitioning;
    controls.hidden = data.native.pages.length <= 1 || viewingAttachment || transitioning;
    previous.hidden = next.hidden = data.native.pages.length <= 1 || viewingAttachment;
    label.hidden = data.native.pages.length <= 1 || viewingAttachment;
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
    const from = animation ? getComputedStyle(expanded).transform
      : viewingAttachment ? 'none' : thumbnailTransform();
    animation?.cancel();
    viewingAttachment = !viewingAttachment;
    transitioning = true;
    display();
    const current = expanded.animate([
      { transform: from }, { transform: viewingAttachment ? 'none' : thumbnailTransform() }
    ], { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 240,
      easing: 'cubic-bezier(.2,.75,.25,1)' });
    animation = current;
    try { await current.finished; } catch { return; }
    animation = null;
    transitioning = false;
    display();
    (viewingAttachment ? expanded : target).focus({ preventScroll: true });
  }
  target.addEventListener('click', toggleAttachment);
  expanded.addEventListener('click', toggleAttachment);
  attachment.addEventListener('load', fitAttachment);
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
