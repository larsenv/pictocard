'use strict';

(() => {
  const root = document.getElementById('wiiLetterPreview');
  if (!root) return;
  const letter = document.getElementById('liveLetterhead');
  const target = document.getElementById('wiiAttachmentTarget');
  const expanded = document.getElementById('wiiExpanded');
  const attachment = document.getElementById('wiiExpandedImage');
  const toggle = document.getElementById('wiiToggleAttachment');
  const previous = document.getElementById('wiiPrevious');
  const next = document.getElementById('wiiNext');
  const label = document.getElementById('wiiPage');
  const message = document.getElementById('liveLetterText');
  let data;
  let page = 0;
  let viewingAttachment = false;

  function display() {
    if (!data) return;
    letter.src = data.native.pages[page];
    letter.dataset.letterhead = data.letterhead;
    letter.hidden = viewingAttachment;
    expanded.hidden = !viewingAttachment;
    target.hidden = !data.image || viewingAttachment;
    toggle.hidden = !data.image;
    toggle.textContent = viewingAttachment ? 'Back to letter' : 'View attachment';
    toggle.setAttribute('aria-pressed', String(viewingAttachment));
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
    data = value;
    page = Math.min(page, data.native.pages.length - 1);
    if (!data.image) viewingAttachment = false;
    if (data.image) attachment.src = data.image;
    message.textContent = data.text;
    root.hidden = false;
    display();
  }
  function toggleAttachment() { viewingAttachment = !viewingAttachment; display(); }
  target.addEventListener('click', toggleAttachment);
  toggle.addEventListener('click', toggleAttachment);
  previous.addEventListener('click', () => { if (page > 0) { page--; display(); } });
  next.addEventListener('click', () => { if (page < data.native.pages.length - 1) { page++; display(); } });
  document.addEventListener('wii-preview-update', (event) => update(event.detail));
  const initial = document.getElementById('wiiPreviewData');
  if (initial) update(JSON.parse(initial.textContent));
})();
