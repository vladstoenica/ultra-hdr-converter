import { parseJpeg, readOrientation, hasGainMap, buildUltraHdr } from './ultrahdr.js?v=9';
import { makeGainMap, canvasToJpeg, boostWeight, curveExponent } from './gainmap.js?v=9';
import { makeZip } from './zip.js?v=9';

const $ = (s) => document.querySelector(s);
const els = {
  drop: $('#drop'),
  input: $('#file-input'),
  boost: $('#boost'),
  boostOut: $('#boost-out'),
  threshold: $('#threshold'),
  thresholdOut: $('#threshold-out'),
  spread: $('#spread'),
  spreadOut: $('#spread-out'),
  saturation: $('#saturation'),
  saturationOut: $('#saturation-out'),
  curve: $('#curve'),
  reprocess: $('#reprocess'),
  format: $('#format'),
  convert: $('#convert'),
  zip: $('#zip'),
  share: $('#share'),
  clear: $('#clear'),
  list: $('#list'),
  summary: $('#summary'),
  hdrNote: $('#hdr-note'),
};

/** @type {{id:number,file:File,status:string,msg?:string,out?:Blob,url?:string,key?:string,el:HTMLElement}[]} */
let items = [];
let nextId = 1;
let busy = false;

const settings = () => ({
  maxStops: parseFloat(els.boost.value),
  start: parseInt(els.threshold.value, 10) / 100,
  spread: parseInt(els.spread.value, 10) / 100,
  saturation: parseInt(els.saturation.value, 10) / 100,
  reprocess: els.reprocess.checked,
  format: els.format.value,
});
const settingsKey = (s) => `${s.maxStops}|${s.start}|${s.spread}|${s.saturation}|${s.reprocess}|${s.format}`;
const FORMATS = { both: { xmp: true, iso: true }, xmp: { xmp: true, iso: false }, iso: { xmp: false, iso: true } };

function outName(name, format = 'xmp') {
  return name.replace(/\.[^.]+$/, '') + '_HDR' + (format === 'xmp' ? '' : '_' + format) + '.jpg';
}

function fmtSize(n) {
  return n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB';
}

// ---------- UI ----------

function renderItem(it) {
  const el = it.el;
  el.dataset.status = it.status;
  el.querySelector('.status').textContent =
    it.status === 'done' ? `Ultra HDR · ${fmtSize(it.out.size)}`
    : it.status === 'working' ? 'Converting…'
    : it.status === 'skipped' ? it.msg
    : it.status === 'error' ? it.msg
    : 'Ready';
  const thumb = el.querySelector('img');
  const src = it.url || it.srcUrl;
  if (thumb.getAttribute('src') !== src) thumb.src = src;
  const a = el.querySelector('a.dl');
  if (it.status === 'done') {
    a.href = it.url;
    a.download = it.outName;
    a.hidden = false;
  } else {
    a.hidden = true;
  }
}

function renderSummary() {
  const done = items.filter((i) => i.status === 'done').length;
  const total = items.length;
  els.summary.textContent = total ? `${done} of ${total} converted` : '';
  els.convert.disabled = busy || !total;
  els.convert.textContent = busy ? 'Converting…' : 'Convert all';
  els.zip.disabled = busy || !done;
  els.share.disabled = busy || !done;
  els.clear.disabled = busy || !total;
  document.body.classList.toggle('has-items', total > 0);
}

function addFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|avif|heic)$/i.test(file.name)) continue;
    const el = document.createElement('li');
    el.className = 'item';
    el.innerHTML = `<img alt="" loading="lazy" decoding="async">
      <div class="meta"><div class="name"></div><div class="status"></div></div>
      <a class="dl btn small" hidden>Download</a>`;
    el.querySelector('.name').textContent = file.name;
    el.querySelector('img').onerror = (e) => { e.target.style.visibility = 'hidden'; };
    const it = { id: nextId++, file, status: 'pending', el, srcUrl: URL.createObjectURL(file) };
    items.push(it);
    els.list.appendChild(el);
    renderItem(it);
  }
  renderSummary();
}

// ---------- conversion ----------

function sofSize(bytes, parsed) {
  for (const s of parsed.header) {
    const m = s.marker;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const d = s.dataStart;
      return { h: (bytes[d + 1] << 8) | bytes[d + 2], w: (bytes[d + 3] << 8) | bytes[d + 4] };
    }
  }
  return null;
}

async function decode(blob) {
  const img = new Image();
  const url = URL.createObjectURL(blob);
  try {
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new Error('This browser can’t open this file type');
  } finally {
    // keep URL alive until drawn; revoked by caller via img.dataset
    img.dataset.url = url;
  }
}

async function convertOne(it, s) {
  let bytes = new Uint8Array(await it.file.arrayBuffer());
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const img = await decode(it.file);
  try {
    const dw = img.naturalWidth, dh = img.naturalHeight;
    let orientation = 1;

    if (isJpeg) {
      const parsed = parseJpeg(bytes);
      if (!s.reprocess && hasGainMap(bytes, parsed)) {
        return { skipped: 'Already HDR – skipped' };
      }
      orientation = readOrientation(bytes, parsed);
      // If the browser didn't apply EXIF rotation, the decoded grid == stored grid.
      const sof = sofSize(bytes, parsed);
      if (sof && orientation >= 5 && sof.w !== sof.h && dw === sof.w && dh === sof.h) orientation = 1;
    } else {
      // Non-JPEG input: render it to a high-quality JPEG base image first.
      const c = document.createElement('canvas');
      c.width = dw; c.height = dh;
      c.getContext('2d').drawImage(img, 0, 0);
      bytes = await canvasToJpeg(c, 0.95);
    }

    const gm = await makeGainMap(img, dw, dh, orientation, { maxStops: s.maxStops, start: s.start, spread: s.spread, saturation: s.saturation });
    const out = buildUltraHdr(bytes, gm.jpeg, gm.meta, FORMATS[s.format]);
    return { blob: new Blob([out], { type: 'image/jpeg' }) };
  } finally {
    URL.revokeObjectURL(img.dataset.url);
  }
}

async function convertAll() {
  if (busy) return;
  busy = true;
  renderSummary();
  const s = settings();
  const key = settingsKey(s);
  for (const it of items) {
    if ((it.status === 'done' || it.status === 'skipped') && it.key === key) continue;
    it.status = 'working';
    renderItem(it);
    try {
      const r = await convertOne(it, s);
      if (it.url) { URL.revokeObjectURL(it.url); it.url = undefined; it.out = undefined; }
      if (r.skipped) {
        it.status = 'skipped';
        it.msg = r.skipped;
      } else {
        it.out = r.blob;
        it.outName = outName(it.file.name, s.format);
        it.url = URL.createObjectURL(r.blob);
        it.status = 'done';
      }
      it.key = key;
    } catch (e) {
      console.error(e);
      it.status = 'error';
      it.msg = e.message || String(e);
    }
    renderItem(it);
    renderSummary();
    await new Promise((r) => setTimeout(r)); // let the UI breathe
  }
  busy = false;
  renderSummary();
}

function doneFiles() {
  const used = new Set();
  return items.filter((i) => i.status === 'done').map((i) => {
    let name = i.outName;
    for (let n = 2; used.has(name); n++) name = i.outName.replace(/\.jpg$/, `_${n}.jpg`);
    used.add(name);
    return { name, blob: i.out };
  });
}

async function downloadZip() {
  const files = await Promise.all(doneFiles().map(async (f) => ({ name: f.name, data: new Uint8Array(await f.blob.arrayBuffer()) })));
  const zip = makeZip(files);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(zip);
  a.download = `UltraHDR_${new Date().toISOString().slice(0, 10)}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

async function shareAll() {
  const files = doneFiles().map((f) => new File([f.blob], f.name, { type: 'image/jpeg' }));
  try {
    await navigator.share({ files });
  } catch (e) {
    if (e.name !== 'AbortError') alert('Sharing failed: ' + e.message);
  }
}

function clearAll() {
  for (const it of items) {
    URL.revokeObjectURL(it.srcUrl);
    if (it.url) URL.revokeObjectURL(it.url);
  }
  items = [];
  els.list.innerHTML = '';
  renderSummary();
}

// ---------- wiring ----------

els.input.addEventListener('change', () => { addFiles(els.input.files); els.input.value = ''; });
els.drop.addEventListener('click', () => els.input.click());
els.drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.input.click(); } });
['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); els.drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || e.target === document.documentElement) els.drop.classList.remove('over'); }));
document.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

function drawCurve() {
  const s = settings();
  const p = curveExponent(s.spread);
  const W = 300, H = 120, top = 14, maxY = 3; // y axis: 0..3 stops
  const y = (stops) => H - (stops / maxY) * (H - top);
  let d = '';
  for (let i = 0; i <= 150; i++) {
    const L = i / 150;
    d += `${i ? 'L' : 'M'}${(L * W).toFixed(1)},${y(s.maxStops * boostWeight(L, s.start, p)).toFixed(1)}`;
  }
  const at = (L) => (s.maxStops * boostWeight(L, s.start, p)).toFixed(1);
  els.curve.innerHTML = `
    <line class="third" x1="100" y1="0" x2="100" y2="${H}"/>
    <line class="third" x1="200" y1="0" x2="200" y2="${H}"/>
    <path class="area" d="${d}L${W},${H}L0,${H}Z"/>
    <path class="line" d="${d}"/>`;
  els.curve.setAttribute('aria-label',
    `Boost curve: shadows/mids boundary +${at(1 / 3)} stops, mids/highlights boundary +${at(2 / 3)} stops, white +${s.maxStops} stops`);
}

const syncOutputs = () => {
  els.boostOut.textContent = `+${els.boost.value} stops (${Math.round(2 ** els.boost.value * 10) / 10}×)`;
  els.thresholdOut.textContent = `${els.threshold.value}%`;
  const v = +els.spread.value;
  els.spreadOut.textContent = v < 25 ? 'highlights only' : v < 60 ? 'balanced' : v < 85 ? 'into mids' : 'even';
  els.saturationOut.textContent = +els.saturation.value ? `+${els.saturation.value}% in highlights` : 'off';
  drawCurve();
};
[els.boost, els.threshold, els.spread, els.saturation].forEach((e) => e.addEventListener('input', syncOutputs));
syncOutputs();

els.convert.addEventListener('click', convertAll);
els.zip.addEventListener('click', downloadZip);
els.share.addEventListener('click', shareAll);
els.clear.addEventListener('click', clearAll);

const canShareFiles = !!(navigator.canShare && navigator.canShare({ files: [new File([''], 'x.jpg', { type: 'image/jpeg' })] }));
els.share.hidden = !canShareFiles;

const hdr = matchMedia('(dynamic-range: high)').matches;
els.hdrNote.textContent = hdr
  ? 'Your screen supports HDR — converted previews below will glow.'
  : 'Your screen/browser isn’t showing HDR, so previews look normal. The files are still Ultra HDR.';
els.hdrNote.dataset.hdr = hdr;

renderSummary();

// test hook
window.__uhdr = { addFiles, convertAll, items: () => items };
