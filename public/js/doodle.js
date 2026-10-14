'use strict';

// Doodle pad for card pictures. The drawing tools (colours, brush sizes, draw,
// fill, undo, erase, clear) and the flood fill come from Discross' drawing page;
// the finished doodle is put into the picture field like an uploaded file.
(() => {
  const dialog = document.getElementById('doodleDialog');
  const canvas = document.getElementById('doodleCanvas');
  if (!dialog || !canvas || typeof dialog.showModal !== 'function') {
    for (const button of document.querySelectorAll('[data-doodle-target]')) button.hidden = true;
    return;
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const COLORS = ['#000000', '#555555', '#aaaaaa', '#ffffff', '#800000', '#ff0000', '#ff9900', '#ffff00',
    '#800080', '#004d00', '#00ff00', '#000080', '#00ffff', '#ff69b4', '#ff00ff', '#8b4513'];
  const SIZES = [2, 5, 10, 20];
  const MAX_HISTORY = 20;

  let color = '#000000';
  let size = 5;
  let tool = 'draw';
  let drawing = false;
  let lastX = 0;
  let lastY = 0;
  let target = null;
  const history = [];

  const colorBox = document.getElementById('doodleColors');
  const sizeBox = document.getElementById('doodleSizes');
  const toolButtons = new Map();

  function blank() {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  function select(group, active) {
    for (const el of group.children) el.classList.toggle('is-active', el === active);
  }

  for (const value of COLORS) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'doodle-swatch';
    swatch.style.background = value;
    swatch.setAttribute('aria-label', `Colour ${value}`);
    swatch.addEventListener('click', () => {
      color = value;
      if (tool === 'eraser') setTool('draw');
      select(colorBox, swatch);
    });
    colorBox.append(swatch);
    if (value === color) swatch.classList.add('is-active');
  }
  for (const value of SIZES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'doodle-size';
    button.setAttribute('aria-label', `Brush size ${value}`);
    const dot = document.createElement('span');
    dot.style.width = dot.style.height = `${value}px`;
    button.append(dot);
    button.addEventListener('click', () => {
      size = value;
      select(sizeBox, button);
    });
    sizeBox.append(button);
    if (value === size) button.classList.add('is-active');
  }

  function setTool(name) {
    tool = name;
    for (const [key, button] of toolButtons) button.classList.toggle('is-active', key === name);
  }
  for (const button of dialog.querySelectorAll('[data-tool]')) {
    toolButtons.set(button.dataset.tool, button);
    button.addEventListener('click', () => setTool(button.dataset.tool));
  }

  function saveHistory() {
    if (history.length >= MAX_HISTORY) history.shift();
    history.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
  }
  document.getElementById('doodleUndo').addEventListener('click', () => {
    if (history.length) ctx.putImageData(history.pop(), 0, 0);
  });
  document.getElementById('doodleClear').addEventListener('click', () => {
    saveHistory();
    blank();
  });

  function floodFill(startX, startY) {
    startX = Math.round(startX);
    startY = Math.round(startY);
    const w = canvas.width;
    const h = canvas.height;
    if (startX < 0 || startX >= w || startY < 0 || startY >= h) return;
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;
    const fill = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    const start = (startY * w + startX) * 4;
    const target = [data[start], data[start + 1], data[start + 2], data[start + 3]];
    if (target[0] === fill[0] && target[1] === fill[1] && target[2] === fill[2] && target[3] === 255) return;

    // Generous tolerance (~66% of the colour space) so the fill swallows the
    // anti-aliased edge of a stroke and leaves only its core.
    const tolerance = 130000;
    const visited = new Uint8Array(w * h);
    const stack = [startX + startY * w];
    while (stack.length) {
      const pos = stack.pop();
      if (visited[pos]) continue;
      visited[pos] = 1;
      const i = pos * 4;
      const dr = data[i] - target[0];
      const dg = data[i + 1] - target[1];
      const db = data[i + 2] - target[2];
      const da = data[i + 3] - target[3];
      if (dr * dr + dg * dg + db * db + da * da > tolerance) continue;
      data[i] = fill[0];
      data[i + 1] = fill[1];
      data[i + 2] = fill[2];
      data[i + 3] = 255;
      const x = pos % w;
      if (x > 0) stack.push(pos - 1);
      if (x < w - 1) stack.push(pos + 1);
      if (pos >= w) stack.push(pos - w);
      if (pos < w * (h - 1)) stack.push(pos + w);
    }
    ctx.putImageData(imageData, 0, 0);
  }

  function position(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height)
    };
  }
  const ink = () => (tool === 'eraser' ? '#ffffff' : color);

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button > 0) return;
    event.preventDefault();
    const pos = position(event);
    saveHistory();
    if (tool === 'fill') {
      floodFill(pos.x, pos.y);
      return;
    }
    canvas.setPointerCapture(event.pointerId);
    drawing = true;
    lastX = pos.x;
    lastY = pos.y;
    ctx.fillStyle = ctx.strokeStyle = ink();
    ctx.lineWidth = size;
    ctx.beginPath();
    ctx.arc(lastX, lastY, size / 2, 0, Math.PI * 2);
    ctx.fill();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drawing) return;
    event.preventDefault();
    const pos = position(event);
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    lastX = pos.x;
    lastY = pos.y;
  });
  const stop = () => { drawing = false; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  for (const button of document.querySelectorAll('[data-doodle-target]')) {
    button.addEventListener('click', () => {
      target = document.getElementById(button.dataset.doodleTarget);
      if (!target) return;
      history.length = 0;
      blank();
      setTool('draw');
      dialog.showModal();
    });
  }

  document.getElementById('doodleCancel').addEventListener('click', () => dialog.close());
  document.getElementById('doodleUse').addEventListener('click', () => {
    canvas.toBlob((blob) => {
      if (!blob || !target) return dialog.close();
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], 'doodle.png', { type: 'image/png' }));
      target.files = transfer.files;
      target.dispatchEvent(new Event('change', { bubbles: true }));
      dialog.close();
    }, 'image/png');
  });
})();
