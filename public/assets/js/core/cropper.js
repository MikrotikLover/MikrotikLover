// Photo cropper: fixed 3:4 frame, drag to pan, slider / mouse wheel to zoom, rotate 90°.
// Resolves to a JPEG Blob (width x height) or null when cancelled.
import { h, modal, toast } from './dom.js';

export function cropImage(file, { width = 300, height = 400 } = {}) {
  return new Promise((resolve) => {
    if (!file || !/^image\//.test(file.type)) {
      toast('Please choose an image file (JPG / PNG).', 'err');
      resolve(null);
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => { URL.revokeObjectURL(url); toast('This image could not be opened.', 'err'); resolve(null); };
    img.onload = () => {
      const view = 1; // canvas shown at output size (300x400) - fits every screen
      const canvas = h('canvas', { width: width * view, height: height * view });
      const ctx = canvas.getContext('2d');
      let rot = 0; // 0, 90, 180, 270
      let scale = 1, minScale = 1, x = 0, y = 0;
      const dims = () => (rot % 180 === 0 ? [img.width, img.height] : [img.height, img.width]);
      const zoom = h('input', { type: 'range', min: 0, max: 100, value: 0 });

      function fit() {
        const [w, hh] = dims();
        minScale = Math.max(canvas.width / w, canvas.height / hh);
        scale = minScale;
        x = (canvas.width - w * scale) / 2;
        y = (canvas.height - hh * scale) / 2;
        zoom.value = 0;
        draw();
      }
      function clamp() {
        const [w, hh] = dims();
        x = Math.min(0, Math.max(canvas.width - w * scale, x));
        y = Math.min(0, Math.max(canvas.height - hh * scale, y));
      }
      function draw(target = ctx, k = 1) {
        clamp();
        target.save();
        target.fillStyle = '#fff';
        target.fillRect(0, 0, target.canvas.width, target.canvas.height);
        target.translate(x * k, y * k);
        target.scale(scale * k, scale * k);
        const [w, hh] = dims();
        target.translate(w / 2, hh / 2);
        target.rotate((rot * Math.PI) / 180);
        target.drawImage(img, -img.width / 2, -img.height / 2);
        target.restore();
      }
      function setScale(s, cx = canvas.width / 2, cy = canvas.height / 2) {
        const ns = Math.max(minScale, Math.min(minScale * 4, s));
        x = cx - ((cx - x) * ns) / scale;
        y = cy - ((cy - y) * ns) / scale;
        scale = ns;
        zoom.value = ((scale / minScale - 1) / 3) * 100;
        draw();
      }
      zoom.addEventListener('input', () => setScale(minScale * (1 + (Number(zoom.value) / 100) * 3)));
      canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = canvas.getBoundingClientRect();
        setScale(scale * (e.deltaY < 0 ? 1.08 : 0.92), (e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height));
      }, { passive: false });
      let drag = null;
      canvas.addEventListener('pointerdown', (e) => { drag = { px: e.clientX, py: e.clientY, x, y }; canvas.setPointerCapture(e.pointerId); });
      canvas.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const r = canvas.getBoundingClientRect();
        const k = canvas.width / r.width;
        x = drag.x + (e.clientX - drag.px) * k;
        y = drag.y + (e.clientY - drag.py) * k;
        draw();
      });
      canvas.addEventListener('pointerup', () => { drag = null; });

      let result = null;
      const body = h('div', { class: 'cropper' },
        canvas,
        h('div', { class: 'row' }, h('span', null, 'Zoom'), zoom,
          h('button', { class: 'btn sm', type: 'button', onclick: () => { rot = (rot + 90) % 360; fit(); } }, '⟳ Rotate')),
        h('div', { class: 'muted', style: 'font-size:12px' }, 'Drag to position the face inside the frame. Mouse wheel zooms.'));
      modal({
        title: 'Crop photo',
        body,
        buttons: [
          { label: 'Cancel' },
          { label: 'Use photo', class: 'primary', onClick: () => new Promise((done) => {
            const out = document.createElement('canvas');
            out.width = width;
            out.height = height;
            draw(out.getContext('2d'), width / canvas.width);
            out.toBlob((b) => { result = b; done(); }, 'image/jpeg', 0.9);
          }) },
        ],
        onClose: () => { URL.revokeObjectURL(url); resolve(result); },
      });
      fit();
    };
    img.src = url;
  });
}
