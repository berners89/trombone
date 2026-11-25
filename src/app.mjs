// Interface : affichage (pdf.js), annotations, opérations sur les pages (PdfOps / pdf-lib).
// La plateforme (Electron ou navigateur) fournit window.trombone et window.TROMBONE_CONFIG.
const config = window.TROMBONE_CONFIG;
const at = (rel) => new URL(rel, document.baseURI).href;
const pdfjs = await import(at(config.pdfjs));
pdfjs.GlobalWorkerOptions.workerSrc = at(config.worker);
const RESOURCES = {};
for (const key of ['cMapUrl', 'standardFontDataUrl', 'wasmUrl', 'iccUrl']) {
  if (config[key]) RESOURCES[key] = at(config[key]);
}

const fontCache = new Map();
function loadFont(file) {
  if (!fontCache.has(file)) {
    fontCache.set(file, fetch(at(config.fonts + file)).then(async (res) => {
      if (!res.ok) throw new Error(`Police introuvable : ${file}`);
      return new Uint8Array(await res.arrayBuffer());
    }));
  }
  return fontCache.get(file);
}
// Nom CSS de chaque famille embarquée (les mêmes fichiers servent à l'aperçu et au PDF).
const CSS_FAMILY = Object.fromEntries(Object.entries(window.PdfOps.FAMILIES).map(([key, f]) => [key, `"${f.label}", ${f.generic}`]));

const api = window.trombone;
const PdfOps = window.PdfOps;
const Blocks = window.Blocks;
const Office = window.Office;
const Protect = window.Protect;
const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

const viewer = $('viewer');
const pagesEl = $('pages');
const thumbsEl = $('thumbs');

const PALETTE = [
  [1, 0.86, 0.2], [0.47, 0.86, 0.47], [1, 0.58, 0.72],
  [0.12, 0.37, 0.82], [0.8, 0.12, 0.1], [0.1, 0.1, 0.12],
];

let savedOcrLang = 'fra';
try { savedOcrLang = localStorage.getItem('trombone.ocrLang') || 'fra'; } catch { /* stockage indisponible */ }

const state = {
  ocrLang: savedOcrLang, comments: [],
  bytes: null, name: '', path: null, pdf: null, task: null,
  scale: 1.25, pages: [], annots: [], tool: 'select', dirty: false, current: 1,
  colors: { select: PALETTE[0], edit: PALETTE[0], highlight: PALETTE[0], text: PALETTE[5], ink: PALETTE[4], eraser: PALETTE[0], redact: PALETTE[5], comment: PALETTE[0], field: PALETTE[0] },
};

/* ---------- utilitaires ---------- */

let toastTimer;
function toast(message, isError = false, sticky = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  // Une erreur reste affichée jusqu'à ce qu'on clique dessus ; une information s'efface seule.
  if (!sticky && !isError) toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

async function guard(fn) {
  try {
    await fn();
  } catch (err) {
    console.error(err);
    toast(err && err.message ? err.message : String(err), true);
  }
}

const css = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
const baseName = () => state.name.replace(/\.pdf$/i, '') || 'document';

function refreshChrome() {
  const has = !!state.pdf;
  document.querySelectorAll('[data-needs-doc]').forEach((el) => el.classList.toggle('off', !has));
  $('empty').hidden = has;
  document.title = has ? `${state.dirty ? '• ' : ''}${state.name} — Trombone` : 'Trombone';
  $('doc-name').textContent = has ? `${state.name}${state.dirty ? ' •' : ''}` : '';
  $('doc-name').title = has ? (state.dirty ? 'Modifications non enregistrées' : state.name) : '';
  $('zoom-label').textContent = `${Math.round(state.scale * 100)} %`;
  $('page-count').textContent = `/ ${has ? state.pdf.numPages : 0}`;
  $('page-input').max = has ? state.pdf.numPages : 1;
  $('btn-undo').disabled = history.index <= 0;
  $('btn-redo').disabled = history.index >= history.stack.length - 1;
}

/* ---------- annuler / rétablir ---------- */

// Chaque état = le document (octets) + les modifications en attente. Les octets ne sont jamais
// modifiés en place, donc garder un état ne coûte presque rien.
const history = { stack: [], index: -1, busy: false };

function commit() {
  const top = history.stack[history.index];
  const same = top && top.bytes === state.bytes && top.annots.length === state.annots.length && top.annots.every((a, i) => a === state.annots[i]);
  if (same) return;
  history.stack.length = history.index + 1;
  history.stack.push({ bytes: state.bytes, name: state.name, path: state.path, annots: [...state.annots] });
  if (history.stack.length > 80) history.stack.shift();
  history.index = history.stack.length - 1;
  refreshChrome();
}

async function travel(step) {
  const target = history.stack[history.index + step];
  if (!target || history.busy) return;
  history.busy = true;
  try {
    history.index += step;
    if (target.bytes !== state.bytes) {
      await openBytes(target.bytes, target.name, { path: target.path, page: state.current, dirty: true, keepOcr: true, history: 'keep' });
    }
    // Les blocs sont recalculés à chaque chargement : on rattache chaque modification à son bloc.
    for (const a of target.annots) {
      if (a.type !== 'block') continue;
      const pv = state.pages[a.page - 1];
      if (!pv) continue;
      await loadTextBoxes(pv);
      const block = pv.blocks[a.blockIndex];
      if (block) { a.block = block; a.boxes = block.items; }
    }
    state.annots = [...target.annots];
    for (const pv of state.pages) {
      if (pv.blocks) pv.blocks.forEach((block) => { block.edited = state.annots.some((a) => a.block === block); });
      drawOverlay(pv);
    }
    markDirty();
  } finally {
    history.busy = false;
    refreshChrome();
  }
}

const undo = () => guard(() => travel(-1));
const redo = () => guard(() => travel(1));

function markDirty(value = true) {
  state.dirty = value;
  refreshChrome();
}

/* ---------- chargement et affichage ---------- */

let draggedPage = 0;
const pageObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const pv = state.pages[entry.target.dataset.page - 1];
      if (!pv) continue;
      pv.visible = entry.isIntersecting;
      if (pv.visible) renderPage(pv);
      if (pv.visible && state.tool === 'edit') loadTextBoxes(pv);
      if (pv.visible && state.tool === 'select') renderTextLayer(pv);
    }
  },
  { root: viewer, rootMargin: '500px 0px' },
);

const thumbObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const pv = state.pages[entry.target.dataset.page - 1];
      if (pv) renderThumb(pv);
    }
  },
  { root: thumbsEl, rootMargin: '300px 0px' },
);

function loadDocument(bytes) {
  return pdfjs.getDocument({
    data: bytes.slice(), // pdf.js transfère le tampon au worker : on garde l'original intact
    cMapPacked: true,
    fontExtraProperties: true, // expose le vrai nom des polices du document
    ...RESOURCES,
  });
}

async function openBytes(data, name, { path = null, page = 1, dirty = false, keepOcr = false, history: mode = 'reset' } = {}) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const task = loadDocument(bytes);
  let pdf;
  try {
    pdf = await task.promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') return askPassword(bytes, name, { path, page, dirty, keepOcr, history: mode });
    throw new Error(`Impossible d'ouvrir « ${name} » : ${err && err.message ? err.message : err}`);
  }
  if (state.task) state.task.destroy();
  pageObserver.disconnect();
  thumbObserver.disconnect();
  Object.assign(state, { bytes, name, path, pdf, task, annots: [], pages: [], dirty, ocrTried: keepOcr && state.ocrTried, form: [], formValues: {}, formTouched: false });
  try {
    state.form = await PdfOps.listFormFields(bytes);
  } catch (err) {
    console.error(err);
  }
  for (const field of state.form) state.formValues[field.name] = field.value;
  try {
    state.comments = await PdfOps.listComments(bytes);
  } catch (err) {
    state.comments = [];
  }
  pagesEl.replaceChildren();
  thumbsEl.replaceChildren();
  closePanel();

  for (let n = 1; n <= pdf.numPages; n++) {
    const pdfPage = await pdf.getPage(n);
    const div = document.createElement('div');
    div.className = 'page';
    div.dataset.page = n;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.dataset.page = n;
    div.append(svg);
    pagesEl.append(div);

    const thumb = document.createElement('button');
    thumb.className = 'thumb';
    thumb.dataset.page = n;
    const label = document.createElement('span');
    label.textContent = n;
    thumb.append(document.createElement('canvas'), label);
    thumb.addEventListener('click', () => goToPage(n));
    thumb.draggable = true;
    thumb.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', String(n));
      event.dataTransfer.effectAllowed = 'move';
      thumb.classList.add('dragged');
      draggedPage = n;
    });
    thumb.addEventListener('dragend', () => { draggedPage = 0; thumbsEl.querySelectorAll('.thumb').forEach((t) => t.classList.remove('dragged', 'drop-before', 'drop-after')); });
    thumb.addEventListener('dragover', (event) => {
      if (!draggedPage) return;
      event.preventDefault();
      const rect = thumb.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      thumb.classList.toggle('drop-after', after);
      thumb.classList.toggle('drop-before', !after);
    });
    thumb.addEventListener('dragleave', () => thumb.classList.remove('drop-before', 'drop-after'));
    thumb.addEventListener('drop', (event) => {
      event.preventDefault();
      const from = draggedPage;
      const after = thumb.classList.contains('drop-after');
      draggedPage = 0;
      if (!from) return;
      // Position finale, une fois la page retirée de son ancienne place.
      let to = after ? n + 1 : n;
      if (from < to) to -= 1;
      if (to !== from) guard(() => pageOperation((bytes) => PdfOps.movePage(bytes, from, to), to));
    });
    thumbsEl.append(thumb);

    const pv = { n, pdfPage, div, svg, thumb, canvas: null, renderedScale: 0, busy: false, visible: false, temp: null };
    state.pages.push(pv);
    layoutPage(pv);
    bindOverlay(pv);
    pageObserver.observe(div);
    thumbObserver.observe(thumb);
  }
  applyTool();
  refreshChrome();
  state.current = 0;
  goToPage(Math.min(page, pdf.numPages), 'instant');
  setCurrent(Math.min(page, pdf.numPages));
  if (state.form.length && mode === 'reset') {
    toast(`Ce document contient un formulaire : ${new Set(state.form.map((f) => f.name)).size} champ(s) à remplir directement sur la page, avec l'outil Sélection.`);
  }
  if (mode === 'reset') { history.stack = []; history.index = -1; }
  if (mode !== 'keep') commit();
}

// Couche de texte invisible posée sur la page : permet de sélectionner et copier avec l'outil Sélection.
async function renderTextLayer(pv) {
  if (pv.textScale === state.scale || pv.textBusy) return;
  pv.textBusy = true;
  const scale = state.scale;
  try {
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    pv.div.style.setProperty('--total-scale-factor', scale);
    const builder = new pdfjs.TextLayer({ textContentSource: await pv.pdfPage.getTextContent(), container: layer, viewport: pv.viewport });
    await builder.render();
    if (scale !== state.scale) return;
    const end = document.createElement('div');
    end.className = 'endOfContent';
    layer.append(end);
    if (pv.textLayer) pv.textLayer.remove();
    pv.div.insertBefore(layer, pv.svg);
    pv.textLayer = layer;
    pv.textScale = scale;
  } catch (err) {
    console.error(err);
  } finally {
    pv.textBusy = false;
  }
}

// Champs de formulaire de la page, posés par-dessus et remplis directement à l'écran.
function drawForm(pv) {
  const fields = state.form.filter((field) => field.page === pv.n);
  if (pv.formLayer) pv.formLayer.remove();
  pv.formLayer = null;
  if (!fields.length) return;
  const layer = document.createElement('div');
  layer.className = 'formLayer';
  const set = (name, value) => { state.formValues[name] = value; state.formTouched = true; markDirty(); };
  for (const field of fields) {
    const [x1, y1] = pv.viewport.convertToViewportPoint(field.x, field.y);
    const [x2, y2] = pv.viewport.convertToViewportPoint(field.x + field.w, field.y + field.h);
    const height = Math.abs(y2 - y1);
    let control;
    if (field.kind === 'text') {
      control = document.createElement(field.multiline ? 'textarea' : 'input');
      if (!field.multiline) control.type = 'text';
      control.value = state.formValues[field.name] || '';
      control.readOnly = field.readOnly;
      control.style.fontSize = `${Math.max(8, Math.min(height * 0.62, 12 * state.scale))}px`;
      control.addEventListener('input', () => set(field.name, control.value));
    } else if (field.kind === 'checkbox') {
      control = document.createElement('input');
      control.type = 'checkbox';
      control.checked = !!state.formValues[field.name];
      control.disabled = field.readOnly;
      control.addEventListener('change', () => set(field.name, control.checked));
    } else if (field.kind === 'radio') {
      control = document.createElement('input');
      control.type = 'radio';
      control.name = `champ-${field.name}`;
      control.checked = state.formValues[field.name] === field.option;
      control.disabled = field.readOnly;
      control.addEventListener('change', () => { if (control.checked) set(field.name, field.option); });
    } else {
      control = document.createElement('select');
      control.append(new Option('', ''), ...field.options.map((option) => new Option(option, option)));
      control.value = state.formValues[field.name] || '';
      control.disabled = field.readOnly;
      control.style.fontSize = `${Math.max(8, Math.min(height * 0.62, 12 * state.scale))}px`;
      control.addEventListener('change', () => set(field.name, control.value));
    }
    control.title = field.name;
    control.setAttribute('aria-label', field.name);
    control.addEventListener('keydown', (event) => event.stopPropagation());
    Object.assign(control.style, { left: `${Math.min(x1, x2)}px`, top: `${Math.min(y1, y2)}px`, width: `${Math.abs(x2 - x1)}px`, height: `${height}px` });
    layer.append(control);
  }
  pv.div.append(layer);
  pv.formLayer = layer;
}

function layoutPage(pv) {
  pv.viewport = pv.pdfPage.getViewport({ scale: state.scale });
  pv.div.style.width = `${pv.viewport.width}px`;
  pv.div.style.height = `${pv.viewport.height}px`;
  pv.svg.setAttribute('viewBox', `0 0 ${pv.viewport.width} ${pv.viewport.height}`);
  drawOverlay(pv);
  drawForm(pv);
}

async function renderPage(pv) {
  if (pv.busy || pv.renderedScale === state.scale) return;
  pv.busy = true;
  const scale = state.scale;
  const viewport = pv.viewport;
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  try {
    await pv.pdfPage.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
    if (scale === state.scale) {
      if (pv.canvas) pv.canvas.remove();
      pv.div.prepend(canvas);
      pv.canvas = canvas;
      pv.renderedScale = scale;
    }
  } catch (err) {
    console.error(err);
  } finally {
    pv.busy = false;
  }
  if (pv.visible && pv.renderedScale !== state.scale) renderPage(pv);
}

async function renderThumb(pv) {
  if (pv.thumbDone) return;
  pv.thumbDone = true;
  const base = pv.pdfPage.getViewport({ scale: 1 });
  const viewport = pv.pdfPage.getViewport({ scale: 240 / base.width });
  const canvas = pv.thumb.querySelector('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  try {
    await pv.pdfPage.render({ canvas, viewport }).promise;
  } catch (err) {
    console.error(err);
  }
}

function setScale(scale) {
  if (!state.pdf) return;
  const ratio = viewer.scrollHeight ? viewer.scrollTop / viewer.scrollHeight : 0;
  state.scale = Math.min(4, Math.max(0.25, Math.round(scale * 100) / 100));
  state.pages.forEach(layoutPage);
  viewer.scrollTop = ratio * viewer.scrollHeight;
  state.pages.filter((pv) => pv.visible).forEach(renderPage);
  if (state.tool === 'select') state.pages.filter((pv) => pv.visible).forEach(renderTextLayer);
  refreshChrome();
}

function fitWidth() {
  const pv = state.pages[state.current - 1];
  if (!pv) return;
  const base = pv.pdfPage.getViewport({ scale: 1 });
  setScale((viewer.clientWidth - 56) / base.width);
}

function goToPage(n, behavior = 'smooth') {
  const pv = state.pages[n - 1];
  if (pv) viewer.scrollTo({ top: pv.div.offsetTop - 12, behavior });
}

function setCurrent(n) {
  if (n === state.current) return;
  state.current = n;
  $('page-input').value = n;
  state.pages.forEach((pv) => pv.thumb.classList.toggle('active', pv.n === n));
  const pv = state.pages[n - 1];
  if (pv) pv.thumb.scrollIntoView({ block: 'nearest' });
}

let scrollPending = false;
viewer.addEventListener('scroll', () => {
  if (scrollPending) return;
  scrollPending = true;
  requestAnimationFrame(() => {
    scrollPending = false;
    const middle = viewer.scrollTop + viewer.clientHeight / 2;
    const hit = state.pages.find((pv) => pv.div.offsetTop + pv.div.offsetHeight >= middle);
    if (hit) setCurrent(hit.n);
  });
});

/* ---------- annotations ---------- */

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function annotElement(pv, a) {
  const toView = (x, y) => pv.viewport.convertToViewportPoint(x, y);
  if (a.type === 'comment') return noteIcon(pv, a);
  if (a.type === 'field') {
    const [x1, y1] = toView(a.x, a.y);
    const [x2, y2] = toView(a.x + a.w, a.y + a.h);
    const group = svgEl('g', {});
    const label = svgEl('text', { class: 'annot field-label', x: Math.min(x1, x2) + 3, y: Math.min(y1, y2) - 3 });
    label.textContent = a.kind === 'checkbox' ? `Case « ${a.name} »` : `Champ « ${a.name} »`;
    group.append(svgEl('rect', { class: 'annot field', x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }), label);
    return group;
  }
  if (a.type === 'redact') {
    const [x1, y1] = toView(a.x, a.y);
    const [x2, y2] = toView(a.x + a.w, a.y + a.h);
    return svgEl('rect', { class: 'redact', x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) });
  }
  if (a.type === 'image') {
    const [x, y] = toView(a.x, a.y + a.h);
    const w = a.w * state.scale;
    const h = a.h * state.scale;
    const group = svgEl('g', {});
    group.append(
      svgEl('image', { href: a.url, x, y, width: w, height: h, preserveAspectRatio: 'none' }),
      svgEl('rect', { class: 'frame', x, y, width: w, height: h }),
      svgEl('rect', { class: 'handle', x: x + w - 6, y: y + h - 6, width: 12, height: 12, rx: 2 }),
    );
    return group;
  }
  if (a.type === 'block') {
    const group = svgEl('g', {});
    for (const cover of a.covers) {
      group.append(svgEl('polygon', { points: viewCorners(pv, cover).map((p) => p.join(',')).join(' '), fill: css(a.bg) }));
    }
    if (a.mode === 'image') {
      const [x, y] = toView(a.image.x + a.dx, a.image.y + a.image.h + a.dy);
      group.append(svgEl('image', {
        href: a.image.url, x, y, width: a.image.w * state.scale, height: a.image.h * state.scale, preserveAspectRatio: 'none',
      }));
      return group;
    }
    const angle = viewAngle(pv, a.block.rows[0].row);
    for (const line of a.lines) {
      const [x, y] = toView(line.x, line.y);
      const text = svgEl('text', {
        x, y, fill: css(a.color), 'font-size': a.size * state.scale, 'font-family': CSS_FAMILY[a.family],
        'font-weight': a.bold ? 700 : 400, 'font-style': a.italic ? 'italic' : 'normal',
        transform: `rotate(${angle} ${x} ${y})`, 'xml:space': 'preserve',
      });
      text.textContent = line.text;
      group.append(text);
    }
    return group;
  }
  if (a.type === 'highlight') {
    const [x1, y1] = toView(a.x, a.y);
    const [x2, y2] = toView(a.x + a.w, a.y + a.h);
    return svgEl('rect', {
      x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1),
      fill: css(a.color), 'fill-opacity': 0.4, style: 'mix-blend-mode:multiply',
    });
  }
  if (a.type === 'text') {
    const [x, y] = toView(a.x, a.y);
    const el = svgEl('text', {
      x, y, fill: css(a.color), 'font-size': a.size * state.scale, 'font-family': 'Arial, Helvetica, sans-serif',
    });
    el.textContent = a.text;
    return el;
  }
  const pts = a.points.map(([x, y]) => toView(x, y).join(',')).join(' ');
  return svgEl('polyline', {
    points: a.points.length === 1 ? `${pts} ${pts}` : pts, fill: 'none', stroke: css(a.color),
    'stroke-width': a.width * state.scale, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  });
}

// Les quatre coins d'une ligne (éventuellement inclinée) dans la vue, et son angle à l'écran.
function viewCorners(pv, line) {
  const f = PdfOps.lineFrame(line);
  const rad = (f.angle * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  return [[0, 0], [f.width, 0], [f.width, f.height], [0, f.height]].map(([t, s]) =>
    pv.viewport.convertToViewportPoint(f.x + ux * t - uy * s, f.y + uy * t + ux * s));
}

function viewAngle(pv, line) {
  const [x0, y0] = pv.viewport.convertToViewportPoint(line.bx, line.by);
  const [x1, y1] = pv.viewport.convertToViewportPoint(line.bx + line.ux, line.by + line.uy);
  return (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
}

// Petite note jaune d'un commentaire ; le texte s'affiche au survol et le clic ouvre la liste.
function noteIcon(pv, comment) {
  const [x, y] = pv.viewport.convertToViewportPoint(comment.x, comment.y);
  const group = svgEl('g', { class: 'note-icon' });
  const title = svgEl('title', {});
  title.textContent = comment.author ? `${comment.author} : ${comment.text}` : comment.text;
  group.append(title, svgEl('rect', { x, y, width: 18, height: 16, rx: 2 }), svgEl('path', { d: `M${x + 4} ${y + 5}h10M${x + 4} ${y + 8}h10M${x + 4} ${y + 11}h6` }));
  group.addEventListener('pointerdown', (event) => { if (state.tool !== 'eraser') { event.stopPropagation(); showComments(); } });
  return group;
}

function drawOverlay(pv) {
  const nodes = [];
  for (const comment of state.comments || []) if (comment.page === pv.n) nodes.push(noteIcon(pv, comment));
  if (state.tool === 'edit' && pv.blocks) {
    pv.blocks.forEach((block, index) => {
      if (block.edited) return;
      const points = Blocks.blockQuad(block, 1).map(([x, y]) => pv.viewport.convertToViewportPoint(x, y).join(',')).join(' ');
      nodes.push(svgEl('polygon', { class: 'textbox', 'data-block': index, points }));
    });
  }
  state.annots.forEach((a, index) => {
    if (a.page !== pv.n) return;
    const el = annotElement(pv, a);
    el.classList.add('annot');
    if (a.type === 'block') el.classList.add('edit');
    if (a.type === 'image') el.classList.add('image');
    el.dataset.index = index;
    nodes.push(el);
  });
  if (pv.temp) nodes.push(annotElement(pv, pv.temp));
  pv.svg.replaceChildren(...nodes);
}

function addAnnot(a) {
  state.annots.push(a);
  markDirty();
  drawOverlay(state.pages[a.page - 1]);
  commit();
}

function removeAnnot(index) {
  const [gone] = state.annots.splice(index, 1);
  if (!gone) return;
  if (gone.block) gone.block.edited = false;
  drawOverlay(state.pages[gone.page - 1]);
  commit();
}


function bindOverlay(pv) {
  const svg = pv.svg;
  let drag = null;
  svg.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const rawX = event.clientX - drag.x;
    const rawY = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(rawX, rawY) < 5) return;
    drag.moved = true;
    if (drag.image) {
      const from = drag.original;
      if (drag.resize) {
        // Poignée : redimensionne en gardant les proportions, coin haut-gauche fixe.
        const w = Math.max(12, from.w + rawX / state.scale);
        const h = (w * from.h) / from.w;
        Object.assign(drag.image, { w, h, y: from.y + from.h - h });
        showGuides(pv, null);
      } else {
        const mine = boundsOf([[from.x, from.y], [from.x + from.w, from.y + from.h]].map(([x, y]) => pv.viewport.convertToViewportPoint(x, y)));
        const snapped = event.altKey ? { dx: rawX, dy: rawY, xs: [], ys: [] } : snapBounds(pv, mine, { annot: drag.image }, rawX, rawY);
        const [ox, oy] = pv.viewport.convertToPdfPoint(0, 0);
        const [px, py] = pv.viewport.convertToPdfPoint(snapped.dx, snapped.dy);
        Object.assign(drag.image, { x: from.x + px - ox, y: from.y + py - oy });
        drawOverlay(pv);
        showGuides(pv, snapped);
        return;
      }
      drawOverlay(pv);
      return;
    }
    const shift = drag.previous ? [drag.previous.dx, drag.previous.dy] : [0, 0];
    // Alt maintenue : déplacement libre, sans aimantation.
    const snapped = event.altKey ? { dx: rawX, dy: rawY, xs: [], ys: [] } : snapMove(pv, drag.block, shift, rawX, rawY);
    drag.dx = snapped.dx;
    drag.dy = snapped.dy;
    drag.element.setAttribute('transform', `translate(${snapped.dx} ${snapped.dy})`);
    drag.element.classList.add('dragging');
    showGuides(pv, snapped);
  });
  const drop = () => {
    if (!drag) return;
    const { block, previous, dx, dy, moved } = drag;
    const picture = drag.image ? drag : null;
    drag = null;
    showGuides(pv, null);
    if (picture) {
      // Sans déplacement réel, on remet l'objet d'origine pour ne pas créer un pas d'historique vide.
      if (!moved) state.annots[state.annots.indexOf(picture.image)] = picture.original;
      else { markDirty(); commit(); }
      drawOverlay(pv);
      return;
    }
    if (!moved) guard(() => openEdit(pv, block, previous));
    else guard(() => commitMove(pv, block, previous, dx, dy));
  };
  svg.addEventListener('pointerup', drop);
  svg.addEventListener('pointercancel', () => { drag = null; showGuides(pv, null); drawOverlay(pv); });
  const toPdf = (event) => {
    const rect = svg.getBoundingClientRect();
    return pv.viewport.convertToPdfPoint(event.clientX - rect.left, event.clientY - rect.top);
  };
  let start = null;

  svg.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const tool = state.tool;
    if (tool === 'eraser') {
      const target = event.target.closest('.annot');
      if (target) removeAnnot(Number(target.dataset.index));
      return;
    }
    if (tool === 'edit') {
      const pictureEl = event.target.closest('.annot.image');
      if (pictureEl) {
        event.preventDefault();
        const index = Number(pictureEl.dataset.index);
        const original = state.annots[index];
        const copy = { ...original };
        state.annots[index] = copy; // on travaille sur une copie : l'état précédent reste intact pour Annuler
        try { svg.setPointerCapture(event.pointerId); } catch { /* pointeur simulé */ }
        drag = { image: copy, original, resize: event.target.classList.contains('handle'), x: event.clientX, y: event.clientY, moved: false };
        return;
      }
      // Un clic ouvre la saisie ; un glisser déplace le bloc.
      const again = event.target.closest('.annot.edit');
      const fresh = event.target.closest('.textbox');
      const previous = again ? state.annots[Number(again.dataset.index)] : null;
      const block = previous ? previous.block : fresh ? pv.blocks[Number(fresh.dataset.block)] : null;
      if (!block) return;
      event.preventDefault();
      try { svg.setPointerCapture(event.pointerId); } catch { /* pointeur simulé */ }
      drag = { element: again || fresh, block, previous, x: event.clientX, y: event.clientY, dx: 0, dy: 0, moved: false };
      return;
    }
    if (tool === 'text') {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      openNote(pv, event.clientX - rect.left, event.clientY - rect.top);
      return;
    }
    if (tool === 'comment') {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      openComment(pv, event.clientX - rect.left, event.clientY - rect.top);
      return;
    }
    if (tool !== 'highlight' && tool !== 'ink' && tool !== 'redact' && tool !== 'field') return;
    svg.setPointerCapture(event.pointerId);
    start = toPdf(event);
    pv.temp =
      tool === 'ink'
        ? { type: 'ink', page: pv.n, points: [start], width: 1.8, color: state.colors.ink }
        : tool === 'field'
          ? { type: 'field', kind: state.fieldKind || 'text', name: nextFieldName(state.fieldKind || 'text'), page: pv.n, x: start[0], y: start[1], w: 0, h: 0 }
          : { type: tool === 'redact' ? 'redact' : 'highlight', page: pv.n, x: start[0], y: start[1], w: 0, h: 0, color: state.colors.highlight };
  });

  svg.addEventListener('pointermove', (event) => {
    if (!start || !pv.temp) return;
    const [x, y] = toPdf(event);
    if (pv.temp.type === 'ink') pv.temp.points.push([x, y]);
    else Object.assign(pv.temp, { x: Math.min(start[0], x), y: Math.min(start[1], y), w: Math.abs(x - start[0]), h: Math.abs(y - start[1]) });
    drawOverlay(pv);
  });

  const finish = () => {
    if (!start) return;
    const a = pv.temp;
    start = null;
    pv.temp = null;
    const keep = a && (a.type === 'ink' || (a.w > 2 && a.h > 2));
    if (keep) addAnnot(a);
    else drawOverlay(pv);
  };
  svg.addEventListener('pointerup', finish);
  svg.addEventListener('pointercancel', finish);
}

function openNote(pv, vx, vy) {
  const size = Number($('text-size').value);
  const px = size * state.scale;
  const colour = state.colors.text;
  const input = document.createElement('input');
  input.className = 'note';
  input.style.left = `${vx}px`;
  input.style.top = `${vy}px`;
  input.style.fontSize = `${px}px`;
  input.style.color = css(colour);
  pv.div.append(input);
  let done = false;
  const close = (commit) => {
    if (done) return;
    done = true;
    const text = input.value.trim();
    input.remove();
    if (!commit || !text) return;
    // Ligne de base approximative du champ (bordure + marge intérieure + ascendante Arial).
    const [x, y] = pv.viewport.convertToPdfPoint(vx + 3, vy + 1 + px * 0.92);
    addAnnot({ type: 'text', page: pv.n, x, y, size, text, color: colour, rotate: pv.pdfPage.rotate || 0 });
  };
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') close(true);
    if (event.key === 'Escape') close(false);
  });
  input.addEventListener('blur', () => close(true));
  setTimeout(() => input.focus(), 0);
}

// Phrase qui dit à l'utilisateur quelle police le document utilisait et ce qui la remplace.
function fontAdvice(font) {
  const label = PdfOps.FAMILIES[font.family].label;
  if (font.ocr) return `Texte issu de l'OCR : police d'origine inconnue, ${label} proposée.`;
  if (font.fit === 'exact') return `Police d'origine : ${font.wanted} — remplacée par ${label}, son équivalent libre.`;
  if (font.fit === 'near') return `Police d'origine : ${font.wanted}, non disponible — police la plus proche proposée : ${label}.`;
  return `Police d'origine : ${font.wanted || 'non identifiée'}, non disponible — ${label} proposée par défaut.`;
}

/* ---------- modification du texte existant ---------- */

// Repère les lignes de texte de la page (texte horizontal uniquement pour l'instant).
function loadTextBoxes(pv) {
  // Une seule lecture par page : les appels simultanés attendent la même.
  if (!pv.boxesPromise) pv.boxesPromise = readTextBoxes(pv);
  return pv.boxesPromise;
}

async function readTextBoxes(pv) {
  pv.loadingBoxes = true;
  try {
    const content = await pv.pdfPage.getTextContent();
    pv.boxes = content.items
      .map((item) => {
        if (!item.str || !item.str.trim()) return null;
        const [a, b, c, d, e, f] = item.transform;
        const along = Math.hypot(a, b);
        const size = Math.hypot(c, d);
        if (!along || !size) return null;
        const ux = a / along;
        const uy = b / along;
        if (-uy * c + ux * d <= 0) return null; // texte en miroir
        const style = content.styles[item.fontName] || {};
        const ascent = Number.isFinite(style.ascent) ? style.ascent : 0.9;
        const descent = Number.isFinite(style.descent) ? style.descent : -0.22;
        return {
          str: item.str, fontName: item.fontName, generic: style.fontFamily, size, stretch: along / size,
          bx: e, by: f, ux, uy, iw: item.width, lo: descent * size - 1, hi: ascent * size + 1,
        };
      })
      .filter(Boolean);
    pv.rows = Blocks.buildRows(pv.boxes);
    pv.blocks = Blocks.buildBlocks(pv.rows);
  } finally {
    pv.loadingBoxes = false;
  }
  if (state.tool === 'edit') drawOverlay(pv);
}

function detectFont(pv, box) {
  let name = '';
  const flags = {};
  try {
    const objs = pv.pdfPage.commonObjs;
    if (objs.has(box.fontName)) {
      const font = objs.get(box.fontName);
      name = font.name || '';
      flags.bold = !!(font.bold || font.black);
      flags.italic = !!font.italic;
    }
  } catch {
    // police pas encore chargée par pdf.js : on se rabat sur la famille générique
  }
  return PdfOps.matchFont(name, box.generic, flags);
}

// Couleur du fond et du texte, relevées sur la page affichée.
function sampleColors(pv, x, y, w, h) {
  const fallback = { color: [0, 0, 0], bg: [1, 1, 1] };
  const canvas = pv.canvas;
  if (!canvas || pv.renderedScale !== state.scale) return fallback;
  try {
    const k = canvas.width / pv.viewport.width;
    const sx = Math.max(0, Math.floor(x * k));
    const sy = Math.max(0, Math.floor(y * k));
    const sw = Math.min(canvas.width - sx, Math.ceil(w * k));
    const sh = Math.min(canvas.height - sy, Math.ceil(h * k));
    if (sw < 2 || sh < 2) return fallback;
    const data = canvas.getContext('2d').getImageData(sx, sy, sw, sh).data;
    const counts = new Map();
    const edge = (row) => {
      for (let col = 0; col < sw; col++) {
        const i = (row * sw + col) * 4;
        const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
        const entry = counts.get(key) || { n: 0, rgb: [data[i], data[i + 1], data[i + 2]] };
        entry.n++;
        counts.set(key, entry);
      }
    };
    edge(0);
    edge(sh - 1);
    const bg = [...counts.values()].sort((p, q) => q.n - p.n)[0].rgb;
    let best = 0;
    let ink = null;
    for (let i = 0; i < data.length; i += 4) {
      const dist = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
      if (dist > best) { best = dist; ink = [data[i], data[i + 1], data[i + 2]]; }
    }
    if (!ink || best < 60) return { color: fallback.color, bg: bg.map((v) => v / 255) };
    return { color: ink.map((v) => v / 255), bg: bg.map((v) => v / 255) };
  } catch {
    return fallback;
  }
}

// Largeur d'un texte dans la police de remplacement (les mêmes fichiers que ceux écrits dans le PDF).
const ruler = document.createElement('canvas').getContext('2d');
function measurer(font) {
  const face = `${font.italic ? 'italic ' : ''}${font.bold ? 700 : 400} 100px ${CSS_FAMILY[font.family]}`;
  return (text, size) => {
    ruler.font = face;
    ruler.fontKerning = 'none';
    return (ruler.measureText(text).width * size) / 100;
  };
}

// Ouvre la saisie d'un bloc de texte (un paragraphe, une adresse, un titre…).
async function openEdit(pv, block, previous = null) {
  const quad = Blocks.blockQuad(block, 1).map(([x, y]) => pv.viewport.convertToViewportPoint(x, y));
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  // Reprise d'une modification : on garde sa police, ses couleurs et sa taille.
  const widest = block.items.reduce((p, q) => (q.iw > p.iw ? q : p));
  const font = previous
    ? { family: previous.family, bold: previous.bold, italic: previous.italic, ocr: previous.cover }
    : { ...detectFont(pv, widest) };
  let touched = false; // style changé à la main
  const colors = previous
    ? { color: previous.color, bg: previous.bg }
    : sampleColors(pv, Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  try {
    await document.fonts.load(`${font.italic ? 'italic ' : ''}${font.bold ? 700 : 400} 16px ${CSS_FAMILY[font.family]}`);
  } catch {
    // police d'aperçu indisponible : la mesure se fera avec la police de repli
  }
  let measure = measurer(font);
  const shift = previous ? [previous.dx || 0, previous.dy || 0] : [0, 0];
  const plan = (text, size) => Blocks.planBlock(block, text, { measure, size, shift, rows: pv.rows, page: pv.pdfPage.view });
  if (previous) {
    state.annots.splice(state.annots.indexOf(previous), 1);
    drawOverlay(pv);
  }
  let size = previous ? previous.wanted : block.size;
  const original = block.str;
  const first = block.rows[0].row;
  const angle = viewAngle(pv, first);
  const area = document.createElement('textarea');
  area.className = 'note edit';
  area.value = previous ? previous.text : original;
  area.spellcheck = false;
  pv.div.append(area);

  // Barre de style : police, gras, italique, taille, couleur.
  const bar = document.createElement('div');
  bar.className = 'stylebar';
  const family = document.createElement('select');
  family.title = 'Police';
  const choices = Object.entries(PdfOps.FAMILIES).map(([value, f]) => [value, f.note ? `${f.label} (≈ ${f.note})` : f.label]).sort((p, q) => p[1].localeCompare(q[1]));
  for (const [value, label] of choices) family.append(new Option(label, value, false, value === font.family));
  const toggle = (label, title, key, styleText) => {
    const button = el('button', '', label);
    button.title = title;
    button.style.cssText = styleText;
    button.classList.toggle('active', !!font[key]);
    button.addEventListener('click', () => { font[key] = !font[key]; button.classList.toggle('active', font[key]); restyle(); });
    return button;
  };
  const sizeLabel = el('span', 'size', '');
  const step = (label, title, delta) => {
    const button = el('button', '', label);
    button.title = title;
    button.addEventListener('click', () => { size = Math.max(4, size + delta); touched = true; place(); });
    return button;
  };
  const inks = [[0.1, 0.1, 0.12], [0.12, 0.37, 0.82], [0.8, 0.12, 0.1]].map((c) => {
    const swatch = el('button', 'swatch');
    swatch.style.background = css(c);
    swatch.title = 'Couleur du texte';
    swatch.addEventListener('click', () => { colors.color = c; touched = true; place(); });
    return swatch;
  });
  // Rappel de la police d'origine et de la suggestion ; une police absente est signalée.
  if (!previous) {
    const origin = el('span', `origin ${font.fit === 'exact' || font.ocr ? '' : 'missing'}`, font.ocr ? 'OCR' : font.fit === 'exact' ? font.wanted : `${font.wanted || 'Police inconnue'} absente`);
    origin.title = fontAdvice(font);
    bar.append(origin);
  }
  bar.append(family, toggle('G', 'Gras', 'bold', 'font-weight:700'), toggle('I', 'Italique', 'italic', 'font-style:italic'),
    step('−', 'Réduire la taille', -0.5), sizeLabel, step('+', 'Augmenter la taille', 0.5), ...inks);
  // Un clic sur la barre ne doit pas faire perdre la saisie en cours.
  bar.addEventListener('mousedown', (event) => { if (event.target.tagName !== 'SELECT') event.preventDefault(); });
  pv.div.append(bar);
  async function restyle() {
    touched = true;
    try {
      await document.fonts.load(`${font.italic ? 'italic ' : ''}${font.bold ? 700 : 400} 16px ${CSS_FAMILY[font.family]}`);
    } catch { /* police de repli */ }
    measure = measurer(font);
    place();
  }
  family.addEventListener('change', () => { font.family = family.value; restyle().then(() => area.focus()); });

  // La zone de saisie reproduit la mise en page finale : même largeur, même interligne, mêmes retours.
  const place = () => {
    const laid = plan(area.value, size);
    const scale = state.scale;
    const lineHeight = laid.leading * scale;
    const fontSize = laid.size * scale;
    const corner = Blocks.blockQuad(block, 0)[3];
    const [x, y] = pv.viewport.convertToViewportPoint(corner[0] + shift[0], corner[1] + shift[1]);
    const [bx, by] = pv.viewport.convertToViewportPoint(first.bx + shift[0], first.by + shift[1]);
    const rise = Math.hypot(bx - x, by - y) - ((lineHeight - 1.117 * fontSize) / 2 + 0.905 * fontSize);
    const widthPdf = Math.max(block.width, ...laid.lines.map((l) => measure(l.text, laid.size)));
    Object.assign(area.style, {
      left: `${x}px`, top: `${y}px`, transformOrigin: '0 0',
      transform: `rotate(${angle}deg) translate(-3px, ${rise - 1}px)`,
      width: `${(block.flowing ? block.width : widthPdf) * scale + 14}px`,
      height: `${Math.max(block.rows.length, laid.lines.length) * lineHeight + 4}px`,
      fontSize: `${fontSize}px`, lineHeight: `${lineHeight}px`, textAlign: block.align,
      fontFamily: CSS_FAMILY[font.family], fontWeight: font.bold ? 700 : 400, fontStyle: font.italic ? 'italic' : 'normal',
      color: css(colors.color), background: css(colors.bg),
    });
    sizeLabel.textContent = `${laid.size} pt`;
    Object.assign(bar.style, { left: `${Math.max(0, x)}px`, top: `${Math.max(0, y - 44)}px` });
    return laid;
  };
  place();
  area.addEventListener('input', place);
  let done = false;
  const close = (commit) => {
    if (done) return;
    done = true;
    const text = area.value.replace(/[ \t]+\n/g, '\n').trim();
    area.remove();
    bar.remove();
    if (!commit) {
      if (previous) addAnnot(previous); // Échap : on retrouve la modification précédente
      return;
    }
    if (text === original && size === block.size && !touched) {
      if (shift[0] || shift[1]) {
        // Texte inchangé sur un bloc déplacé : on garde simplement le déplacement.
        addAnnot(previous);
        return;
      }
      // Retour au texte d'origine : plus rien à modifier sur ce bloc.
      block.edited = false;
      drawOverlay(pv);
      return;
    }
    const laid = plan(text, size);
    block.edited = true;
    // Sur un scan, le cache déborde un peu pour recouvrir entièrement les anciens caractères.
    const pad = font.ocr ? block.size * 0.18 : 0;
    addAnnot({
      type: 'block', mode: 'text', dx: shift[0], dy: shift[1], page: pv.n, block, blockIndex: pv.blocks.indexOf(block), boxes: block.items, text, wanted: size,
      covers: block.rows.map(({ row }) => ({ bx: row.bx, by: row.by, ux: row.ux, uy: row.uy, iw: row.iw, size: row.size, lo: row.lo, hi: row.hi, pad })),
      lines: laid.lines, ux: block.ux, uy: block.uy, size: laid.size,
      color: colors.color, bg: colors.bg, family: font.family, bold: font.bold, italic: font.italic,
      cover: !!font.ocr, // sur un scan, il faut aussi masquer les anciens caractères de l'image
    });
    if (laid.overflow) toast(`Le texte est trop long pour ce bloc : il dépasse de ${laid.overflow} ligne(s). Raccourcissez-le ou réduisez la taille (Ctrl + flèche bas).`, true);
    else if (laid.size < size - 0.01) toast(`Texte ajusté à ${laid.size} pt pour tenir dans le bloc.`);
    else if (!previous) toast(touched ? `Texte réécrit en ${PdfOps.FAMILIES[font.family].label}.` : fontAdvice(font));
  };
  area.addEventListener('keydown', (event) => {
    event.stopPropagation();
    // Entrée valide ; Maj + Entrée insère un retour à la ligne.
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); close(true); }
    if (event.key === 'Escape') close(false);
    // Ctrl + flèche haut / bas : ajuste la taille du texte, par demi-point.
    if (event.ctrlKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      size = Math.max(4, size + (event.key === 'ArrowUp' ? 0.5 : -0.5));
      place();
    }
  });
  // Quitter la saisie valide, sauf si l'on passe simplement à la barre de style.
  area.addEventListener('blur', (event) => { if (!bar.contains(event.relatedTarget)) close(true); });
  bar.addEventListener('focusout', (event) => { if (event.relatedTarget !== area && !bar.contains(event.relatedTarget)) close(true); });
  setTimeout(() => area.focus(), 0);
}

/* ---------- déplacement des blocs, avec repères d'alignement ---------- */

function boundsOf(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const l = Math.min(...xs);
  const r = Math.max(...xs);
  const t = Math.min(...ys);
  const b = Math.max(...ys);
  return { l, r, t, b, cx: (l + r) / 2, cy: (t + b) / 2 };
}

// Rectangle d'un bloc à l'écran, à sa place actuelle (shift = déplacement en points PDF).
function blockBounds(pv, block, shift = [0, 0]) {
  return boundsOf(Blocks.blockQuad(block, 1).map(([x, y]) => pv.viewport.convertToViewportPoint(x + shift[0], y + shift[1])));
}

// Aimante un déplacement sur les bords et les centres des autres objets de la page, et sur son centre.
// mine : rectangle à l'écran de l'objet déplacé ; skip : { block } ou { annot } à ignorer.
function snapBounds(pv, mine, skip, dx, dy) {
  const others = [];
  (pv.blocks || []).forEach((other) => { if (other !== skip.block && !other.edited) others.push(blockBounds(pv, other)); });
  state.annots.forEach((a) => {
    if (a.page !== pv.n) return;
    if (a.type === 'block' && a.block !== skip.block) others.push(blockBounds(pv, a.block, [a.dx, a.dy]));
    if (a.type === 'image' && a !== skip.annot) {
      others.push(boundsOf([[a.x, a.y], [a.x + a.w, a.y + a.h]].map(([x, y]) => pv.viewport.convertToViewportPoint(x, y))));
    }
  });
  const reach = 6; // pixels
  const pick = (own, candidates, delta) => {
    let best = null;
    for (const from of own) {
      for (const to of candidates) {
        const gap = to - (from + delta);
        if (Math.abs(gap) <= reach && (!best || Math.abs(gap) < Math.abs(best.gap))) best = { gap, at: to };
      }
    }
    return best;
  };
  const x = pick([mine.l, mine.cx, mine.r], [...others.flatMap((o) => [o.l, o.cx, o.r]), pv.viewport.width / 2], dx);
  const y = pick([mine.t, mine.cy, mine.b], others.flatMap((o) => [o.t, o.cy, o.b]), dy);
  return { dx: dx + (x ? x.gap : 0), dy: dy + (y ? y.gap : 0), xs: x ? [x.at] : [], ys: y ? [y.at] : [] };
}

const snapMove = (pv, block, shift, dx, dy) => snapBounds(pv, blockBounds(pv, block, shift), { block }, dx, dy);

function showGuides(pv, snapped) {
  pv.svg.querySelectorAll('.guide').forEach((node) => node.remove());
  if (!snapped) return;
  for (const x of snapped.xs) pv.svg.append(svgEl('line', { class: 'guide', x1: x, x2: x, y1: 0, y2: pv.viewport.height }));
  for (const y of snapped.ys) pv.svg.append(svgEl('line', { class: 'guide', x1: 0, x2: pv.viewport.width, y1: y, y2: y }));
}

// Découpe dans la page, en haute définition, le morceau d'image correspondant aux lignes d'un bloc.
async function cropBlock(pv, covers) {
  if (!pv.hiRes) {
    const viewport = pv.pdfPage.getViewport({ scale: 3 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await pv.pdfPage.render({ canvas, viewport }).promise;
    pv.hiRes = { canvas, viewport };
  }
  const { canvas, viewport } = pv.hiRes;
  const points = covers.flatMap((cover) => {
    const f = PdfOps.lineFrame(cover);
    const rad = (f.angle * Math.PI) / 180;
    return [[0, 0], [f.width, 0], [f.width, f.height], [0, f.height]].map(([t, s]) =>
      viewport.convertToViewportPoint(f.x + Math.cos(rad) * t - Math.sin(rad) * s, f.y + Math.sin(rad) * t + Math.cos(rad) * s));
  });
  const box = boundsOf(points);
  const sx = Math.max(0, Math.floor(box.l));
  const sy = Math.max(0, Math.floor(box.t));
  const sw = Math.min(canvas.width - sx, Math.ceil(box.r) - sx);
  const sh = Math.min(canvas.height - sy, Math.ceil(box.b) - sy);
  const piece = document.createElement('canvas');
  piece.width = sw;
  piece.height = sh;
  piece.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  const blob = await new Promise((resolve) => piece.toBlob(resolve, 'image/png'));
  const [x0, y1] = viewport.convertToPdfPoint(sx, sy);
  const [x1, y0] = viewport.convertToPdfPoint(sx + sw, sy + sh);
  return { data: new Uint8Array(await blob.arrayBuffer()), url: URL.createObjectURL(blob), x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Enregistre le déplacement d'un bloc (dxView, dyView en pixels à l'écran).
async function commitMove(pv, block, previous, dxView, dyView) {
  const [ox, oy] = pv.viewport.convertToPdfPoint(0, 0);
  const [px, py] = pv.viewport.convertToPdfPoint(dxView, dyView);
  const dx = px - ox;
  const dy = py - oy;
  if (previous) {
    // Bloc déjà modifié ou déjà déplacé : on décale ce qui existe.
    state.annots.splice(state.annots.indexOf(previous), 1);
    addAnnot({ ...previous, dx: previous.dx + dx, dy: previous.dy + dy, lines: previous.lines.map((l) => ({ ...l, x: l.x + dx, y: l.y + dy })) });
    return;
  }
  const quad = blockBounds(pv, block);
  const widest = block.items.reduce((p, q) => (q.iw > p.iw ? q : p));
  const font = detectFont(pv, widest);
  const colors = sampleColors(pv, quad.l, quad.t, quad.r - quad.l, quad.b - quad.t);
  const pad = font.ocr ? block.size * 0.18 : 0;
  const covers = block.rows.map(({ row }) => ({ bx: row.bx, by: row.by, ux: row.ux, uy: row.uy, iw: row.iw, size: row.size, lo: row.lo, hi: row.hi, pad }));
  const annot = {
    type: 'block', mode: 'text', dx, dy, page: pv.n, block, blockIndex: pv.blocks.indexOf(block), boxes: block.items, text: block.str, wanted: block.size, covers,
    lines: block.rows.map(({ row }) => ({ text: row.str.trim(), x: row.bx + dx, y: row.by + dy })),
    ux: block.ux, uy: block.uy, size: block.size, color: colors.color, bg: colors.bg,
    family: font.family, bold: font.bold, italic: font.italic, cover: !!font.ocr,
  };
  if (font.ocr && pv.pdfPage.rotate % 360 === 0) {
    // Sur un scan, on déplace le morceau d'image lui-même : l'aspect d'origine est conservé à l'identique.
    annot.mode = 'image';
    annot.image = await cropBlock(pv, covers);
    annot.hidden = block.rows.map(({ row }) => ({
      text: row.str, x: row.bx, y: row.by, x2: row.bx + row.ux * row.iw, y2: row.by + row.uy * row.iw, size: row.size,
    }));
    annot.lines = [];
  }
  block.edited = true;
  addAnnot(annot);
}

function applyTool() {
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === state.tool));
  for (const pv of state.pages) {
    pv.svg.style.pointerEvents = state.tool === 'select' ? 'none' : 'auto';
    pv.svg.classList.toggle('drawing', ['highlight', 'ink', 'redact', 'field', 'comment'].includes(state.tool));
    pv.svg.classList.toggle('typing', state.tool === 'text');
    pv.svg.classList.toggle('erasing', state.tool === 'eraser');
    pv.svg.classList.toggle('editing', state.tool === 'edit');
    pv.div.classList.toggle('selecting', state.tool === 'select');
    if (state.tool === 'select' && pv.visible) renderTextLayer(pv);
    if (state.tool === 'edit' && pv.visible) loadTextBoxes(pv);
    drawOverlay(pv);
  }
  const active = state.colors[state.tool];
  document.querySelectorAll('.swatch').forEach((s, i) => s.classList.toggle('active', PALETTE[i] === active));
}

function setTool(tool, byUser = false) {
  state.tool = tool;
  applyTool();
  if (tool !== 'edit' || !byUser) return;
  const pv = state.pages[state.current - 1];
  if (!pv) return;
  guard(async () => {
    await loadTextBoxes(pv);
    if (state.tool !== 'edit' || !pv.boxes) return;
    if (pv.boxes.length) {
      toast(`${pv.blocks.length} bloc(s) de texte sur cette page : cliquez sur un bloc pour le modifier, glissez-le pour le déplacer.`);
    } else if (state.ocrTried) {
      toast("Aucun texte n'a pu être reconnu sur cette page.", true);
    } else {
      // Page scannée : on reconnaît le texte automatiquement, puis les lignes deviennent modifiables.
      await runOcr();
    }
  });
}

/* ---------- fichiers et opérations ---------- */

// Caractères (hors espaces) d'un texte, comptés un par un.
function countChars(text, into = new Map(), sign = 1) {
  for (const ch of text.normalize('NFKC').replace(/\s+/g, '')) into.set(ch, (into.get(ch) || 0) + sign);
  return into;
}

async function pageChars(pdfPage) {
  const content = await pdfPage.getTextContent();
  return countChars(content.items.map((item) => item.str).join(''));
}

// Vérifie qu'en supprimant les textes modifiés, on n'a emporté aucun autre texte de la page.
async function removalIsClean(data, edits) {
  const task = loadDocument(data);
  try {
    const pdf = await task.promise;
    for (const number of new Set(edits.map((a) => a.page))) {
      const expected = await pageChars(state.pages[number - 1].pdfPage);
      const actual = await pageChars(await pdf.getPage(number));
      for (const a of edits) {
        if (a.page !== number) continue;
        a.boxes.forEach((box) => countChars(box.str, expected, -1));
        countChars(a.text, actual, -1);
      }
      for (const [ch, n] of expected) if ((actual.get(ch) || 0) < n) return false;
    }
    return true;
  } finally {
    task.destroy();
  }
}

async function flattened() {
  const filled = state.formTouched ? await PdfOps.fillForm(state.bytes, state.formValues) : state.bytes;
  return applyRedactions(await applyChanges(filled));
}

// Caviardage : chaque page concernée est remplacée par son image, zones noircies comprises. Le texte,
// les images et les annotations d'origine de la page sont retirés du fichier ; le texte situé hors des
// zones est reposé en couche invisible pour que la page reste cherchable.
async function applyRedactions(data) {
  const zones = state.annots.filter((a) => a.type === 'redact');
  let bytes = data;
  for (const number of new Set(zones.map((z) => z.page))) {
    const task = loadDocument(bytes);
    try {
      const page = await (await task.promise).getPage(number);
      const viewport = page.getViewport({ scale: 200 / 72 });
      const unit = page.getViewport({ scale: 1 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, viewport }).promise;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000';
      const boxes = [];
      for (const zone of zones.filter((z) => z.page === number)) {
        const corners = [[zone.x, zone.y], [zone.x + zone.w, zone.y + zone.h]];
        const px = boundsOf(corners.map(([x, y]) => viewport.convertToViewportPoint(x, y)));
        ctx.fillRect(px.l - 1, px.t - 1, px.r - px.l + 2, px.b - px.t + 2);
        boxes.push(boundsOf(corners.map(([x, y]) => unit.convertToViewportPoint(x, y))));
      }
      const content = await page.getTextContent();
      const lines = [];
      for (const item of content.items) {
        if (!item.str || !item.str.trim()) continue;
        const [a, b, c, d, e, f] = item.transform;
        const along = Math.hypot(a, b);
        const size = Math.hypot(c, d);
        if (!along || !size) continue;
        const ux = a / along;
        const uy = b / along;
        const frame = PdfOps.lineFrame({ bx: e, by: f, ux, uy, iw: item.width, size });
        const rad = (frame.angle * Math.PI) / 180;
        const box = boundsOf([[0, 0], [frame.width, 0], [frame.width, frame.height], [0, frame.height]].map(([t, s]) =>
          unit.convertToViewportPoint(frame.x + Math.cos(rad) * t - Math.sin(rad) * s, frame.y + Math.sin(rad) * t + Math.cos(rad) * s)));
        // Une ligne qui touche une zone caviardée est retirée en entier.
        if (boxes.some((z) => box.l < z.r && box.r > z.l && box.t < z.b && box.b > z.t)) continue;
        const [x, y] = unit.convertToViewportPoint(e, f);
        const [x2, y2] = unit.convertToViewportPoint(e + ux * item.width, f + uy * item.width);
        lines.push({ text: item.str, x, y: unit.height - y, x2, y2: unit.height - y2, size });
      }
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      bytes = await PdfOps.replacePageWithImage(bytes, number, new Uint8Array(await blob.arrayBuffer()), { width: unit.width, height: unit.height }, lines, loadFont);
    } finally {
      task.destroy();
    }
  }
  return bytes;
}

async function applyChanges(source) {
  const edits = state.annots.filter((a) => a.type === 'block');
  const pageLines = {};
  for (const a of edits) pageLines[a.page] = state.pages[a.page - 1].boxes;
  const data = await PdfOps.applyAnnotations(source, state.annots, loadFont, { pageLines });
  if (!edits.length || (await removalIsClean(data, edits))) return data;
  toast("Sur ce document, l'ancien texte est masqué mais pas supprimé du fichier.", true);
  return PdfOps.applyAnnotations(source, state.annots, loadFont, { removeText: false });
}

async function openDialog() {
  const [file] = await api.openFiles({ title: 'Documents PDF', extensions: ['pdf'], multi: false });
  if (file) await openBytes(file.data, file.name, { path: file.path });
}

async function save() {
  if (!state.pdf) return;
  const redacted = new Set(state.annots.filter((a) => a.type === 'redact').map((a) => a.page)).size;
  const data = await flattened();
  const suggestion = (state.path || state.name).replace(/\.pdf$/i, '') + (state.path ? '-modifié.pdf' : '.pdf');
  const saved = await api.savePdf(suggestion, data);
  if (!saved) return;
  const name = saved.split(/[\\/]/).pop();
  await openBytes(data, name, { path: saved, page: state.current, history: 'push' });
  toast(redacted ? `Enregistré : ${name}. ${redacted} page(s) caviardée(s), converties en image : leur contenu d'origine a été retiré du fichier.` : `Enregistré : ${name}`);
}

async function pageOperation(fn, goTo = 0) {
  if (!state.pdf) return;
  const data = await fn(await flattened(), state.current);
  await openBytes(data, state.name, { path: state.path, page: goTo || state.current, dirty: true, history: 'push' });
}

// Petit formulaire dans le panneau latéral : un champ, un bouton.
function askInPanel(title, help, value, action, run) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  const button = el('button', 'primary', action);
  const go = () => guard(() => run(input.value));
  button.addEventListener('click', go);
  input.addEventListener('keydown', (event) => { event.stopPropagation(); if (event.key === 'Enter') go(); });
  const field = el('div', 'field');
  field.append(input, button);
  showPanel(title, [el('p', '', help), field]);
  setTimeout(() => { input.focus(); input.select(); }, 0);
}

function extractPages() {
  askInPanel('Extraire des pages', `Pages à extraire dans un nouveau PDF, par exemple 1-3, 5. Le document compte ${state.pdf.numPages} page(s).`,
    String(state.current), 'Extraire…', async (value) => {
      const pages = PdfOps.parseRange(value, state.pdf.numPages);
      const data = await PdfOps.extractPages(await flattened(), pages);
      const saved = await api.savePdf(`${baseName()}-pages-${value.replace(/[^0-9-]+/g, '_')}.pdf`, data);
      if (saved) { closePanel(); toast(`${pages.length} page(s) extraite(s).`); }
    });
}

async function insertPdf() {
  const [file] = await api.openFiles({ title: 'PDF à insérer', extensions: ['pdf'], multi: false });
  if (!file) return;
  const at = state.current;
  await pageOperation((bytes) => PdfOps.insertPdf(bytes, new Uint8Array(file.data), at), at + 1);
  toast(`« ${file.name} » inséré après la page ${at}.`);
}

function addWatermark() {
  askInPanel('Filigrane', 'Texte affiché en diagonale, en gris clair, sur toutes les pages.', 'CONFIDENTIEL', 'Appliquer', async (value) => {
    await pageOperation((bytes) => PdfOps.watermark(bytes, value));
    toast('Filigrane ajouté sur toutes les pages.');
  });
}

async function showOutline() {
  const outline = await state.pdf.getOutline();
  if (!outline || !outline.length) return showPanel('Signets', [el('p', '', 'Ce document ne contient pas de signets.')]);
  const nodes = [];
  const walk = (items, depth) => {
    for (const item of items) {
      const button = el('button', 'outline-item', item.title);
      button.style.paddingLeft = `${8 + depth * 14}px`;
      button.addEventListener('click', () => guard(async () => {
        const dest = typeof item.dest === 'string' ? await state.pdf.getDestination(item.dest) : item.dest;
        if (!dest) return;
        const index = typeof dest[0] === 'object' ? await state.pdf.getPageIndex(dest[0]) : Number(dest[0]);
        goToPage(index + 1);
      }));
      nodes.push(button);
      if (item.items && item.items.length) walk(item.items, depth + 1);
    }
  };
  walk(outline, 0);
  showPanel('Signets', nodes);
}

/* ---------- conversions Word et Excel ---------- */

// Décompression « deflate » brute, fournie par le navigateur (les .docx et .xlsx sont des archives ZIP).
async function inflate(raw) {
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Les modifications en attente sont d'abord écrites dans le document, pour figurer dans l'export.
async function settle() {
  if (!state.annots.length && !state.formTouched) return;
  await openBytes(await flattened(), state.name, { path: state.path, page: state.current, dirty: true, keepOcr: true, history: 'push' });
}

const WORD_FONT = Object.fromEntries(Object.entries(PdfOps.FAMILIES).map(([key, f]) => [key, f.word]));

async function exportWord() {
  await settle();
  const pages = [];
  let total = 0;
  for (const pv of state.pages) {
    toast(`Lecture de la page ${pv.n} sur ${state.pages.length}…`, false, true);
    await loadTextBoxes(pv);
    // Les polices d'une page jamais affichée ne sont pas encore connues : on force leur chargement.
    if (!pv.renderedScale) { try { await pv.pdfPage.getOperatorList(); } catch { /* police de repli */ } }
    const [x0, y0, x1, y1] = pv.pdfPage.view;
    // Ordre de lecture : de haut en bas, puis de gauche à droite.
    const blocks = [...pv.blocks].sort((p, q) => q.rows[0].v - p.rows[0].v || p.t0 - q.t0);
    const paragraphs = [];
    let lastLine = null;
    for (const block of blocks) {
      const widest = block.items.reduce((p, q) => (q.iw > p.iw ? q : p));
      const font = detectFont(pv, widest);
      const single = block.rows.length === 1;
      // Blocs d'une seule ligne posés sur la même ligne de base (cellules d'un tableau) : un seul
      // paragraphe, séparé par des tabulations.
      if (single && lastLine && Math.abs(lastLine.v - block.rows[0].v) < 0.45 * block.size) {
        lastLine.paragraph.text += `\t${block.str}`;
        continue;
      }
      const paragraph = { text: block.str, size: Math.round(block.size * 2) / 2, bold: font.bold, italic: font.italic, font: WORD_FONT[font.family], align: block.align };
      paragraphs.push(paragraph);
      lastLine = single ? { v: block.rows[0].v, paragraph } : null;
    }
    total += paragraphs.length;
    pages.push({ width: x1 - x0, height: y1 - y0, paragraphs });
  }
  if (!total) return toast("Aucun texte à exporter : sur un scan, lancez d'abord Outils > Reconnaître le texte (OCR).", true);
  const saved = await api.savePdf(`${baseName()}.docx`, Office.writeDocx(pages));
  if (saved) toast(`Document Word créé : ${total} paragraphe(s) sur ${pages.length} page(s). La mise en page d'origine n'est pas reproduite.`);
  else $('toast').hidden = true;
}

// Couleur dominante du fond et couleur du texte dans un rectangle d'un canevas (pixels).
function sampleRegion(canvas, x, y, w, h) {
  const sx = Math.max(0, Math.floor(x));
  const sy = Math.max(0, Math.floor(y));
  const sw = Math.min(canvas.width - sx, Math.ceil(w));
  const sh = Math.min(canvas.height - sy, Math.ceil(h));
  if (sw < 2 || sh < 2) return { color: [0, 0, 0], bg: [1, 1, 1] };
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(sx, sy, sw, sh).data;
  const counts = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    const entry = counts.get(key) || { n: 0, rgb: [data[i], data[i + 1], data[i + 2]] };
    entry.n++;
    counts.set(key, entry);
  }
  const bg = [...counts.values()].sort((p, q) => q.n - p.n)[0].rgb;
  // Couleur du texte : la teinte la plus fréquente parmi les pixels nettement différents du fond.
  const inks = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const dist = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
    if (dist < 150) continue;
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    const entry = inks.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    entry.n++; entry.r += data[i]; entry.g += data[i + 1]; entry.b += data[i + 2];
    inks.set(key, entry);
  }
  const ink = [...inks.values()].sort((p, q) => q.n - p.n)[0];
  return { color: ink ? [ink.r / ink.n / 255, ink.g / ink.n / 255, ink.b / ink.n / 255] : [0, 0, 0], bg: bg.map((v) => v / 255) };
}

// Export Word fidèle : le fond de chaque page est conservé en image, le texte est reposé par-dessus,
// bloc par bloc, à sa place, dans sa police, sa taille et sa couleur.
async function exportWordLayout() {
  await settle();
  const pages = [];
  let total = 0;
  for (const pv of state.pages) {
    toast(`Conversion de la page ${pv.n} sur ${state.pages.length}…`, false, true);
    await loadTextBoxes(pv);
    const scale = 2;
    const viewport = pv.pdfPage.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await pv.pdfPage.render({ canvas, viewport }).promise; // charge aussi les polices de la page
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const toPx = (x, y) => viewport.convertToViewportPoint(x, y);
    const frames = [];
    const erase = [];
    // Découpage fin : les cellules d'un tableau serré deviennent des cadres distincts, chacun à sa place.
    for (const block of Blocks.buildBlocks(Blocks.buildRows(pv.boxes, 0.35))) {
      // Un bloc incliné reste dans l'image de fond : Word ne sait pas poser un cadre de travers.
      const [ax, ay] = toPx(block.rows[0].row.bx, block.rows[0].row.by);
      const [bx, by] = toPx(block.rows[0].row.bx + block.ux, block.rows[0].row.by + block.uy);
      if (Math.abs(by - ay) > 0.02 * Math.abs(bx - ax) || bx <= ax) continue;
      const quad = boundsOf(Blocks.blockQuad(block, 0).map(([x, y]) => toPx(x, y)));
      const leading = block.leading;
      // Chaque fragment garde son propre style : un mot en gras ou en couleur au milieu d'une ligne reste tel quel.
      const lines = block.rows.map(({ row }) => row.items.map((item, index) => {
        const f = PdfOps.lineFrame({ ...item, lo: -0.22 * item.size, hi: 0.78 * item.size });
        const box = boundsOf([[f.x, f.y], [f.x + f.width, f.y + f.height]].map(([x, y]) => toPx(x, y)));
        const colors = sampleRegion(canvas, box.l, box.t, box.r - box.l, box.b - box.t);
        const font = detectFont(pv, item);
        // Sur un scan, les lettres de l'image débordent un peu du texte reconnu : on efface plus large.
        const more = font.ocr ? item.size * 0.14 * scale : 0;
        erase.push({ box: { l: box.l - more, t: box.t - more, r: box.r + more, b: box.b + more }, bg: colors.bg });
        // Même règle d'espacement que pour le texte de la ligne : un écart visible devient une espace.
        const previous = row.items[index - 1];
        const gap = previous ? (item.bx - previous.bx) * row.ux + (item.by - previous.by) * row.uy - previous.iw : 0;
        const glue = previous && gap > 0.15 * row.size && !/\s$/.test(previous.str) && !/^\s/.test(item.str) ? ' ' : '';
        // Texte issu de l'OCR : sa police réelle est inconnue, on resserre ou on étire les caractères
        // pour que la ligne garde exactement sa largeur d'origine.
        const stretch = font.ocr ? Math.max(0.5, Math.min(1.5, item.stretch || 1)) : 1;
        return { text: glue + item.str, bold: font.bold, italic: font.italic, font: WORD_FONT[font.family], color: colors.color, stretch };
      }));
      frames.push({
        x: quad.l / scale + 1, y: ay / scale - leading * 0.8, w: ((quad.r - quad.l) / scale) * 1.03 + 2,
        lines, size: Math.round(block.size * 2) / 2, leading, align: block.align,
      });
    }
    // Le texte est effacé de l'image de fond, fragment par fragment, avec la couleur de fond relevée.
    // (au plus près des lettres, pour ne pas déborder sur un fond voisin d'une autre couleur)
    for (const { box, bg } of erase) {
      ctx.fillStyle = css(bg);
      ctx.fillRect(box.l, box.t, box.r - box.l, box.b - box.t);
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
    total += frames.length;
    pages.push({ width: viewport.width / scale, height: viewport.height / scale, image: new Uint8Array(await blob.arrayBuffer()), frames });
  }
  const saved = await api.savePdf(`${baseName()}.docx`, Office.writeDocxLayout(pages));
  if (saved) toast(total ? `Document Word créé : mise en page conservée, ${total} bloc(s) de texte modifiable(s).` : "Document Word créé avec les pages en image : pour un texte modifiable, lancez d'abord l'OCR.");
  else $('toast').hidden = true;
}

async function exportExcel() {
  await settle();
  const sheets = [];
  let cells = 0;
  for (const pv of state.pages) {
    toast(`Lecture de la page ${pv.n} sur ${state.pages.length}…`, false, true);
    await loadTextBoxes(pv);
    // Découpage plus fin que pour l'édition : dans un tableau serré, les cellules sont proches.
    const rows = Office.gridFromRows(Blocks.buildRows(pv.boxes, 0.35));
    cells += rows.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
    // Apparence de chaque cellule, relevée sur la page : gras, couleur du texte, couleur de fond.
    const viewport = pv.pdfPage.getViewport({ scale: 1.5 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await pv.pdfPage.render({ canvas, viewport }).promise;
    const far = (c, from) => Math.abs(c[0] - from) + Math.abs(c[1] - from) + Math.abs(c[2] - from) > 0.25;
    const looks = rows.sources.map((line) => line.map((source) => {
      if (!source) return null;
      const f = PdfOps.lineFrame({ ...source, lo: -0.22 * source.size, hi: 0.78 * source.size });
      const box = boundsOf([[f.x, f.y], [f.x + f.width, f.y + f.height]].map(([x, y]) => viewport.convertToViewportPoint(x, y)));
      const colors = sampleRegion(canvas, box.l, box.t, box.r - box.l, box.b - box.t);
      const font = detectFont(pv, source.items[0]);
      const look = { bold: font.bold, color: far(colors.color, 0) ? colors.color : null, fill: far(colors.bg, 1) ? colors.bg : null };
      return look.bold || look.color || look.fill ? look : null;
    }));
    sheets.push({ name: `Page ${pv.n}`, rows, looks });
  }
  if (!cells) return toast("Aucun texte à exporter : sur un scan, lancez d'abord Outils > Reconnaître le texte (OCR).", true);
  const saved = await api.savePdf(`${baseName()}.xlsx`, Office.writeXlsx(sheets));
  if (saved) toast(`Classeur Excel créé : une feuille par page, ${cells} cellule(s) remplie(s).`);
  else $('toast').hidden = true;
}

async function officeToPdf() {
  const [file] = await api.openFiles({ title: 'Documents Word ou Excel', extensions: ['docx', 'xlsx'], multi: false });
  if (!file) return;
  const bytes = new Uint8Array(file.data);
  toast(`Conversion de « ${file.name} »…`, false, true);
  let data;
  if (/\.docx$/i.test(file.name)) data = await PdfOps.docToPdf(await Office.readDocx(bytes, inflate), loadFont);
  else if (/\.xlsx$/i.test(file.name)) data = await PdfOps.sheetsToPdf(await Office.readXlsx(bytes, inflate), loadFont);
  else throw new Error('Format non pris en charge : choisissez un fichier .docx ou .xlsx (les anciens .doc et .xls ne sont pas lus).');
  await openBytes(data, file.name.replace(/\.(docx|xlsx)$/i, '.pdf'), { dirty: true });
  toast(`« ${file.name} » converti en PDF — pensez à enregistrer.`);
}

/* ---------- commentaires, champs, impression ---------- */

function openComment(pv, vx, vy) {
  const area = document.createElement('textarea');
  area.className = 'note comment';
  area.placeholder = 'Votre commentaire… (Entrée pour valider)';
  area.style.left = `${Math.min(vx, pv.viewport.width - 230)}px`;
  area.style.top = `${vy}px`;
  pv.div.append(area);
  let done = false;
  const close = (commit) => {
    if (done) return;
    done = true;
    const text = area.value.trim();
    area.remove();
    if (!commit || !text) return;
    const [x, y] = pv.viewport.convertToPdfPoint(vx, vy);
    addAnnot({ type: 'comment', page: pv.n, x, y, text });
  };
  area.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); close(true); }
    if (event.key === 'Escape') close(false);
  });
  area.addEventListener('blur', () => close(true));
  setTimeout(() => area.focus(), 0);
}

// Liste de tous les commentaires : ceux du fichier et ceux qui viennent d'être ajoutés.
function showComments() {
  const rows = [];
  const entry = (comment, remove) => {
    const row = el('div', 'comment-row');
    const go = el('button', '', 'Aller à la page');
    go.addEventListener('click', () => goToPage(comment.page));
    const del = el('button', 'danger', 'Supprimer');
    del.addEventListener('click', () => guard(remove));
    const buttons = el('div', 'row');
    buttons.append(go, del);
    row.append(el('small', '', `Page ${comment.page}${comment.author ? ` · ${comment.author}` : ''}`), el('p', '', comment.text), buttons);
    rows.push(row);
  };
  for (const comment of state.comments || []) {
    entry(comment, async () => { await pageOperation((bytes) => PdfOps.removeComment(bytes, comment.page, comment.index)); showComments(); });
  }
  state.annots.forEach((a) => {
    if (a.type === 'comment') entry(a, async () => { removeAnnot(state.annots.indexOf(a)); showComments(); });
  });
  showPanel('Commentaires', rows.length ? rows : [el('p', '', "Aucun commentaire. Choisissez l'outil Commenter, puis cliquez à l'endroit voulu sur la page.")]);
}

function nextFieldName(kind) {
  const base = kind === 'checkbox' ? 'case' : 'champ';
  const taken = new Set([...state.form.map((f) => f.name), ...state.annots.filter((a) => a.type === 'field').map((a) => a.name)]);
  let n = 1;
  while (taken.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

function startField(kind) {
  state.fieldKind = kind;
  setTool('field');
  toast(kind === 'checkbox' ? 'Tracez la case à cocher sur la page. Elle sera utilisable après enregistrement.' : 'Tracez le champ de texte sur la page. Il sera utilisable après enregistrement.');
}

// Impression : chaque page est rendue en image, puis la fenêtre d'impression du système s'ouvre.
async function printDocument() {
  const root = $('print-root');
  const task = loadDocument(await flattened());
  const urls = [];
  try {
    const pdf = await task.promise;
    const images = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      toast(`Préparation de la page ${n} sur ${pdf.numPages}…`, false, true);
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: 150 / 72 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, viewport }).promise;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      const image = new Image();
      image.src = URL.createObjectURL(blob);
      urls.push(image.src);
      await image.decode();
      images.push(image);
    }
    root.replaceChildren(...images);
    $('toast').hidden = true;
    window.print();
  } finally {
    task.destroy();
    // Le contenu est retiré une fois l'impression lancée ou annulée.
    setTimeout(() => { root.replaceChildren(); urls.forEach((url) => URL.revokeObjectURL(url)); }, 60000);
  }
}

const OCR_LANGUAGES = [['fra', 'Français'], ['fra+eng', 'Français et anglais'], ['eng', 'Anglais'], ['deu', 'Allemand'], ['spa', 'Espagnol'], ['ita', 'Italien']];

function chooseOcrLanguage() {
  const select = document.createElement('select');
  for (const [value, label] of OCR_LANGUAGES) select.append(new Option(label, value, false, value === state.ocrLang));
  select.addEventListener('change', () => {
    state.ocrLang = select.value;
    try { localStorage.setItem('trombone.ocrLang', select.value); } catch { /* préférence non mémorisée */ }
    toast(`Langue de reconnaissance : ${select.selectedOptions[0].textContent}.`);
  });
  const field = el('div', 'field');
  field.append(select);
  showPanel("Langue de l'OCR", [el('p', '', 'Langue des documents scannés. Une langue de plus rend la reconnaissance un peu plus lente.'), field]);
}

/* ---------- mot de passe et compression ---------- */

let protectLoading;
// La bibliothèque de chiffrement porte le même nom global que pdf-lib : on la charge à part.
function loadProtect() {
  if (!protectLoading) {
    protectLoading = new Promise((resolve, reject) => {
      const original = window.PDFLib;
      const script = document.createElement('script');
      script.src = at(config.crypto);
      script.onload = () => { Protect.library = window.PDFLib; window.PDFLib = original; resolve(); };
      script.onerror = () => { window.PDFLib = original; reject(new Error("Le module de protection par mot de passe n'a pas pu être chargé.")); };
      document.head.append(script);
    });
  }
  return protectLoading;
}

function passwordField(label) {
  const input = document.createElement('input');
  input.type = 'password';
  input.placeholder = label;
  input.setAttribute('aria-label', label);
  input.addEventListener('keydown', (event) => event.stopPropagation());
  return input;
}

function saveProtected() {
  const first = passwordField('Mot de passe');
  const second = passwordField('Confirmer le mot de passe');
  const button = el('button', 'primary', 'Enregistrer la copie protégée…');
  button.addEventListener('click', () => guard(async () => {
    if (!first.value) throw new Error('Indiquez un mot de passe.');
    if (first.value !== second.value) throw new Error('Les deux mots de passe sont différents.');
    await loadProtect();
    const data = await Protect.encrypt(await flattened(), first.value);
    const saved = await api.savePdf(`${baseName()}-protégé.pdf`, data);
    if (saved) { closePanel(); toast('Copie protégée enregistrée. Le mot de passe sera demandé à chaque ouverture : il ne peut pas être retrouvé en cas d\'oubli.'); }
  }));
  const field = el('div', 'field');
  field.append(first, second, button);
  showPanel('Mot de passe', [el('p', '', 'Enregistre une copie chiffrée (AES 256 bits). Le document ouvert ici reste modifiable.'), field]);
  setTimeout(() => first.focus(), 0);
}

// PDF protégé : on demande le mot de passe, puis on travaille sur une copie déchiffrée.
function askPassword(bytes, name, options) {
  const input = passwordField('Mot de passe du document');
  const button = el('button', 'primary', 'Ouvrir');
  const go = () => guard(async () => {
    await loadProtect();
    const plain = await Protect.decrypt(bytes, input.value);
    await openBytes(plain, name, options);
    toast("Document ouvert. Attention : une copie enregistrée d'ici ne sera plus protégée, sauf si vous choisissez « Enregistrer avec un mot de passe ».");
  });
  button.addEventListener('click', go);
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') go(); });
  const field = el('div', 'field');
  field.append(input, button);
  showPanel('Document protégé', [el('p', '', `« ${name} » est protégé par un mot de passe.`), field]);
  setTimeout(() => input.focus(), 0);
}

// Réencode une image en JPEG plus léger, en la ramenant au besoin à 1800 pixels de côté.
async function shrinkImage(image) {
  try {
    let source;
    if (image.kind === 'jpeg') source = await createImageBitmap(new Blob([image.data], { type: 'image/jpeg' }));
    else {
      const rgba = new Uint8ClampedArray(image.width * image.height * 4);
      for (let i = 0, o = 0; i < image.width * image.height; i++, o += 4) {
        const p = i * image.channels;
        rgba[o] = image.data[p];
        rgba[o + 1] = image.data[image.channels === 3 ? p + 1 : p];
        rgba[o + 2] = image.data[image.channels === 3 ? p + 2 : p];
        rgba[o + 3] = 255;
      }
      source = document.createElement('canvas');
      source.width = image.width;
      source.height = image.height;
      source.getContext('2d').putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
    }
    const k = Math.min(1, 1800 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * k));
    canvas.height = Math.max(1, Math.round(image.height * k));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.72));
    return { data: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height };
  } catch {
    return null; // image non décodable par le navigateur : elle est conservée telle quelle
  }
}

async function shrinkFile() {
  toast('Compression des images…', false, true);
  const before = await flattened();
  const result = await PdfOps.recompressImages(before, shrinkImage);
  const size = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);
  if (!result.replaced || result.bytes.length >= before.length) {
    return toast(result.images ? 'Les images de ce document sont déjà compactes : rien à gagner.' : 'Ce document ne contient pas d\'image à compresser.');
  }
  await openBytes(result.bytes, state.name, { path: state.path, page: state.current, dirty: true, keepOcr: true, history: 'push' });
  toast(`Fichier réduit de ${size(before.length)} à ${size(result.bytes.length)} (${result.replaced} image(s) recompressée(s)). Pensez à enregistrer.`);
}

/* ---------- images et signature ---------- */

// Pose une image au centre de la partie visible de la page courante.
async function placeImage(data, kind, widthPt) {
  const pv = state.pages[state.current - 1];
  if (!pv) return;
  const blob = new Blob([data], { type: kind === 'png' ? 'image/png' : 'image/jpeg' });
  const bitmap = await createImageBitmap(blob);
  const [x0, y0, x1, y1] = pv.pdfPage.view;
  const w = Math.min(widthPt || bitmap.width * 0.75, (x1 - x0) * 0.6);
  const h = (w * bitmap.height) / bitmap.width;
  const page = pv.div.getBoundingClientRect();
  const view = viewer.getBoundingClientRect();
  const cx = Math.min(page.width, Math.max(0, (view.left + view.right) / 2 - page.left));
  const cy = Math.min(page.height, Math.max(0, (Math.max(view.top, page.top) + Math.min(view.bottom, page.bottom)) / 2 - page.top));
  const [px, py] = pv.viewport.convertToPdfPoint(cx, cy);
  addAnnot({
    type: 'image', page: pv.n, kind, data, url: URL.createObjectURL(blob),
    x: Math.min(x1 - w, Math.max(x0, px - w / 2)), y: Math.min(y1 - h, Math.max(y0, py - h / 2)), w, h,
  });
  setTool('edit');
  toast('Image posée : glissez-la pour la placer, tirez le coin bleu pour la redimensionner.');
}

async function insertImage() {
  const [file] = await api.openFiles({ title: 'Image', extensions: ['png', 'jpg', 'jpeg'], multi: false });
  if (file) await placeImage(new Uint8Array(file.data), /\.png$/i.test(file.name) ? 'png' : 'jpg');
}

// Zone de dessin d'une signature ; le fond reste transparent.
function openSignature() {
  const pad = document.createElement('canvas');
  pad.className = 'pad';
  pad.width = 560;
  pad.height = 260;
  const ctx = pad.getContext('2d');
  Object.assign(ctx, { lineWidth: 4, lineCap: 'round', lineJoin: 'round', strokeStyle: '#10204a' });
  let drawing = false;
  let box = null; // zone réellement dessinée
  const point = (event) => {
    const rect = pad.getBoundingClientRect();
    return [((event.clientX - rect.left) * pad.width) / rect.width, ((event.clientY - rect.top) * pad.height) / rect.height];
  };
  const grow = ([x, y]) => { box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y]; };
  pad.addEventListener('pointerdown', (event) => {
    drawing = true;
    try { pad.setPointerCapture(event.pointerId); } catch { /* pointeur simulé */ }
    const p = point(event);
    ctx.beginPath();
    ctx.moveTo(...p);
    ctx.lineTo(p[0] + 0.1, p[1] + 0.1);
    ctx.stroke();
    grow(p);
  });
  pad.addEventListener('pointermove', (event) => {
    if (!drawing) return;
    const p = point(event);
    ctx.lineTo(...p);
    ctx.stroke();
    grow(p);
  });
  const stop = () => { drawing = false; };
  pad.addEventListener('pointerup', stop);
  pad.addEventListener('pointercancel', stop);
  const clear = el('button', '', 'Effacer');
  clear.addEventListener('click', () => { ctx.clearRect(0, 0, pad.width, pad.height); box = null; });
  const insert = el('button', 'primary', 'Insérer dans la page');
  insert.addEventListener('click', () => guard(async () => {
    if (!box) return toast("Dessinez d'abord votre signature dans le cadre.", true);
    const m = 8;
    const sx = Math.max(0, Math.floor(box[0] - m));
    const sy = Math.max(0, Math.floor(box[1] - m));
    const sw = Math.min(pad.width - sx, Math.ceil(box[2] - box[0] + 2 * m));
    const sh = Math.min(pad.height - sy, Math.ceil(box[3] - box[1] + 2 * m));
    const cut = document.createElement('canvas');
    cut.width = sw;
    cut.height = sh;
    cut.getContext('2d').drawImage(pad, sx, sy, sw, sh, 0, 0, sw, sh);
    const blob = await new Promise((resolve) => cut.toBlob(resolve, 'image/png'));
    closePanel();
    await placeImage(new Uint8Array(await blob.arrayBuffer()), 'png', Math.max(60, sw * 0.3));
  }));
  const row = el('div', 'row');
  row.append(clear, insert);
  showPanel('Signature', [el('p', '', 'Signez dans le cadre à la souris ou au doigt, puis insérez la signature dans la page.'), pad, row]);
}

async function mergeFiles() {
  const files = await api.openFiles({ title: 'PDF à fusionner', extensions: ['pdf'], multi: true });
  if (!files.length) return;
  const list = files.map((f) => new Uint8Array(f.data));
  if (state.pdf) list.unshift(await flattened());
  if (list.length < 2) return toast('Choisissez au moins deux PDF à fusionner.', true);
  const data = await PdfOps.merge(list);
  await openBytes(data, state.pdf ? state.name : 'fusion.pdf', { path: state.path, page: state.current || 1, dirty: true, history: state.pdf ? 'push' : 'reset' });
  toast(`${list.length} documents fusionnés — pensez à enregistrer.`);
}

async function imagesToPdf() {
  const files = await api.openFiles({ title: 'Images', extensions: ['png', 'jpg', 'jpeg'], multi: true });
  if (!files.length) return;
  const images = files.map((f) => ({ data: new Uint8Array(f.data), kind: /\.png$/i.test(f.name) ? 'png' : 'jpg' }));
  const data = await PdfOps.imagesToPdf(images);
  await openBytes(data, 'images.pdf', { dirty: true });
  toast(`${images.length} image(s) converties — pensez à enregistrer.`);
}

async function exportPng() {
  const folder = await api.chooseExportFolder();
  if (!folder) return;
  const task = loadDocument(await flattened());
  try {
    const pdf = await task.promise;
    const digits = String(pdf.numPages).length;
    for (let n = 1; n <= pdf.numPages; n++) {
      toast(`Export de la page ${n} sur ${pdf.numPages}…`, false, true);
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: 2 }); // 144 ppp
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, viewport }).promise;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const name = `${baseName()}-p${String(n).padStart(digits, '0')}.png`;
      await api.writeExport(name, new Uint8Array(await blob.arrayBuffer()));
    }
    const where = (await api.finishExport(`${baseName()}-images.zip`)) || folder;
    toast(`${pdf.numPages} image(s) exportée(s) : ${where}`);
  } finally {
    task.destroy();
  }
}

/* ---------- reconnaissance de texte (OCR) ---------- */

let tesseractLoading;
function loadTesseract() {
  if (!tesseractLoading) {
    tesseractLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = at(config.ocr + 'tesseract.min.js');
      script.onload = () => resolve(window.Tesseract);
      script.onerror = () => reject(new Error("Le moteur de reconnaissance de texte n'a pas pu être chargé."));
      document.head.append(script);
    });
  }
  return tesseractLoading;
}

const median = (values) => {
  const sorted = [...values].sort((p, q) => p - q);
  return sorted.length ? sorted[sorted.length >> 1] : 0;
};

// Part du corps qu'occupe un mot en hauteur, selon ses caractères : « page » (jambage) est plus haut
// que « nous » (bas de casse seul). Sert à retrouver le corps à partir de la hauteur mesurée du mot.
function heightFraction(text) {
  const top = /[A-ZÀ-ÖØ-Þ0-9bdfhkltßij()\[\]{}|\/§%€$&@#?!'"°]/.test(text) ? 0.72 : /[à-öø-ÿ]/.test(text) ? 0.74 : 0.52;
  const bottom = /[gjpqyçQ()\[\]{}|§]/.test(text) ? 0.21 : /[,;]/.test(text) ? 0.13 : 0;
  return top + bottom;
}

// Lignes reconnues sur une page, converties en points PDF.
// La boîte d'une ligne renvoyée par le moteur est peu fiable (elle peut englober deux colonnes ou un
// parasite) : on repart des mots, on coupe aux grands blancs et on déduit le corps de la hauteur des mots.
function ocrLines(data, viewport) {
  const lines = [];
  for (const block of data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        const words = (line.words || [])
          .filter((w) => w.bbox && (w.text || '').trim() && w.bbox.x1 > w.bbox.x0 && w.bbox.y1 > w.bbox.y0)
          .sort((p, q) => p.bbox.x0 - q.bbox.x0);
        if (!words.length) continue;
        const lineHeight = median(words.map((w) => w.bbox.y1 - w.bbox.y0));
        const cut = [[words[0]]];
        for (let i = 1; i < words.length; i++) {
          const gap = words[i].bbox.x0 - words[i - 1].bbox.x1;
          if (gap > lineHeight * 1.6) cut.push([]); // grand blanc : autre colonne ou autre cellule
          cut[cut.length - 1].push(words[i]);
        }
        // Un mot douteux en bord de ligne (trait de marge, bout de code-barres lu comme du texte)
        // décalerait toute la ligne : on le retire.
        const doubtful = (w, typical) => {
          const tall = w.bbox.y1 - w.bbox.y0;
          const sure = w.confidence || 0;
          // Un tiret ou un deux-points est petit mais légitime : on ne l'écarte que s'il est mal reconnu.
          return sure < 60 || tall > typical * 1.6 || (tall < typical * 0.4 && sure < 75);
        };
        const segments = cut
          .map((group) => {
            const typical = median(group.map((w) => w.bbox.y1 - w.bbox.y0));
            const kept = [...group];
            while (kept.length > 1 && doubtful(kept[0], typical)) kept.shift();
            while (kept.length > 1 && doubtful(kept[kept.length - 1], typical)) kept.pop();
            return kept;
          })
          .filter((group) => group.length);
        const base = line.baseline;
        const slope = base && base.x1 !== base.x0 ? (base.y1 - base.y0) / (base.x1 - base.x0) : 0;
        for (const segment of segments) {
          const text = segment.map((w) => w.text.trim()).join(' ');
          const confidence = segment.reduce((sum, w) => sum + (w.confidence || 0), 0) / segment.length;
          // Écarte les parasites : il faut au moins deux lettres ou chiffres, et qu'ils dominent le texte.
          const solid = (text.match(/[\p{L}\p{N}]/gu) || []).length;
          if (confidence < 55 || solid < 2 || solid < text.replace(/\s/g, '').length * 0.6) continue;
          // Un mot isolé très court (deux caractères seuls dans une marge) n'est gardé que s'il est sûr.
          if (segment.length === 1 && solid < 3 && confidence < 90) continue;
          const x0 = segment[0].bbox.x0;
          const x1 = segment[segment.length - 1].bbox.x1;
          const top = Math.min(...segment.map((w) => w.bbox.y0));
          const bottom = median(segment.map((w) => w.bbox.y1)); // bas des mots sans jambage = ligne de base
          const height = median(segment.map((w) => w.bbox.y1 - w.bbox.y0));
          if (height < 4 || x1 - x0 < 4) continue;
          // Corps estimé mot par mot (hauteur corrigée de l'inclinaison, rapportée aux caractères du mot).
          const sizePx = median(segment.map((w) => {
            const tall = w.bbox.y1 - w.bbox.y0 - Math.abs(slope) * (w.bbox.x1 - w.bbox.x0);
            return Math.max(tall, 2) / heightFraction(w.text.trim());
          }));
          let y0 = bottom;
          let y1 = bottom;
          if (base && Number.isFinite(base.y0) && Number.isFinite(slope)) {
            const at0 = base.y0 + slope * (x0 - base.x0);
            const at1 = base.y0 + slope * (x1 - base.x0);
            // La ligne de base du moteur n'est retenue que si elle tombe bien au pied de ce segment.
            if (Math.abs((at0 + at1) / 2 - bottom) < height * 0.35 && at0 > top) { y0 = at0; y1 = at1; }
          }
          // Une ligne quasi horizontale est posée parfaitement à l'horizontale.
          if (Math.abs(y1 - y0) < (x1 - x0) * 0.004) y0 = y1 = (y0 + y1) / 2;
          const [x, y] = viewport.convertToPdfPoint(x0, y0);
          const [x2, y2] = viewport.convertToPdfPoint(x1, y1);
          lines.push({ text, x, y, x2, y2, size: sizePx / viewport.scale });
        }
      }
    }
  }
  // Les corps très proches sont ramenés à une même valeur, pour un rendu régulier d'une ligne à l'autre.
  const sizes = [...new Set(lines.map((l) => l.size))].sort((p, q) => p - q);
  const snapped = new Map();
  for (let i = 0; i < sizes.length; ) {
    let j = i;
    while (j + 1 < sizes.length && sizes[j + 1] <= sizes[j] * 1.06) j++; // de proche en proche
    const group = sizes.slice(i, j + 1);
    const value = Math.round(median(lines.filter((l) => group.includes(l.size)).map((l) => l.size)) * 2) / 2;
    group.forEach((size) => snapped.set(size, value));
    i = j + 1;
  }
  lines.forEach((l) => { l.size = snapped.get(l.size); });
  return lines;
}

async function runOcr() {
  if (!state.pdf) return;
  state.ocrTried = true;
  const base = await flattened();
  const task = loadDocument(base);
  let worker;
  try {
    const pdf = await task.promise;
    toast('Chargement du moteur de reconnaissance…', false, true);
    const Tesseract = await loadTesseract();
    worker = await Tesseract.createWorker(state.ocrLang, 1, {
      workerPath: at(config.ocr + 'worker-entry.js'),
      corePath: at(config.ocr),
      langPath: at(config.ocr).replace(/\/$/, ''),
      workerBlobURL: false,
      cacheMethod: 'none',
    });
    const layers = {};
    let recognised = 0;
    let skipped = 0;
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const existing = [...(await pageChars(page)).values()].reduce((sum, v) => sum + v, 0);
      if (existing >= 20) { skipped++; continue; } // la page contient déjà du texte
      toast(`Reconnaissance de la page ${n} sur ${pdf.numPages}…`, false, true);
      const natural = page.getViewport({ scale: 1 });
      // ≈ 250 points par pouce, sans dépasser 4000 pixels de côté.
      const viewport = page.getViewport({ scale: Math.min(3.5, 4000 / Math.max(natural.width, natural.height)) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, viewport }).promise;
      const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
      const lines = ocrLines(data, viewport);
      if (lines.length) { layers[n] = lines; recognised++; }
    }
    if (!recognised) {
      toast(skipped ? 'Toutes les pages contiennent déjà du texte : rien à reconnaître.' : 'Aucun texte reconnu dans ce document.', !skipped);
      return;
    }
    const count = Object.values(layers).reduce((sum, l) => sum + l.length, 0);
    const data = await PdfOps.addTextLayer(base, layers, loadFont);
    await openBytes(data, state.name, { path: state.path, page: state.current, dirty: true, keepOcr: true, history: 'push' });
    toast(state.tool === 'edit'
      ? `${count} ligne(s) reconnue(s) sur ${recognised} page(s) : cliquez sur un bloc pour le modifier, glissez-le pour le déplacer.`
      : `${count} ligne(s) reconnue(s) sur ${recognised} page(s) — le texte est cherchable et modifiable. Pensez à enregistrer.`);
  } catch (err) {
    // Message complet, pour pouvoir diagnostiquer un blocage du moteur dans la page.
    throw new Error(`La reconnaissance de texte a échoué : ${err && err.message ? err.message : err}`);
  } finally {
    if (worker) await worker.terminate().catch(() => {});
    task.destroy();
  }
}

/* ---------- panneau latéral : polices et recherche ---------- */

function showPanel(title, nodes) {
  $('panel-title').textContent = title;
  $('panel-body').replaceChildren(...nodes);
  $('panel').hidden = false;
}

function closePanel() {
  $('panel').hidden = true;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function showFonts() {
  const fonts = await PdfOps.listFonts(state.bytes);
  if (!fonts.length) return showPanel('Polices', [el('p', '', 'Aucune police : ce document ne contient probablement que des images (PDF scanné).')]);
  const rows = fonts.map((f) => {
    const row = el('div', 'font-row');
    row.append(el('strong', '', f.name), el('small', '', `${f.subtype} · page(s) ${f.pages.join(', ')}`), document.createElement('br'));
    row.append(el('span', `tag ${f.embedded ? 'ok' : 'warn'}`, f.embedded ? 'Embarquée' : 'Non embarquée'));
    if (f.embedded) row.append(el('span', `tag ${f.subset ? 'warn' : 'ok'}`, f.subset ? 'Jeu partiel' : 'Jeu complet'));
    // Ce que l'application utilisera si l'on modifie un texte dans cette police.
    const match = PdfOps.matchFont(f.name, null, {});
    const label = PdfOps.FAMILIES[match.family].label;
    if (!f.name.startsWith('TromboneOCR') && !f.name.startsWith('FeuilletOCR')) {
      row.append(document.createElement('br'), el('span', `tag ${match.fit === 'exact' ? 'ok' : 'warn'}`,
        match.fit === 'exact' ? `Équivalent : ${label}` : match.fit === 'near' ? `Absente — suggestion : ${label}` : `Absente — par défaut : ${label}`));
    }
    return row;
  });
  const missing = fonts.filter((f) => !f.embedded).length;
  const intro = el('p', '', `${fonts.length} police(s), dont ${missing} non embarquée(s). Un jeu partiel ne contient que les caractères déjà utilisés dans le document.`);
  showPanel('Polices du document', [intro, ...rows]);
}

async function pageText(pv) {
  if (pv.text === undefined) {
    const content = await pv.pdfPage.getTextContent();
    pv.text = content.items.map((item) => item.str + (item.hasEOL ? ' ' : '')).join('');
  }
  return pv.text;
}

let searchRun = 0;
async function search(query) {
  const run = ++searchRun;
  const needle = query.trim().toLowerCase();
  if (!needle || !state.pdf) return closePanel();
  const hits = [];
  let total = 0;
  for (const pv of state.pages) {
    const text = await pageText(pv);
    if (run !== searchRun) return;
    const lower = text.toLowerCase();
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
      total++;
      if (hits.length >= 200) continue;
      const button = el('button', 'hit');
      button.append(el('small', '', `Page ${pv.n}`));
      button.append(
        document.createTextNode('…' + text.slice(Math.max(0, at - 40), at)),
        el('mark', '', text.slice(at, at + needle.length)),
        document.createTextNode(text.slice(at + needle.length, at + needle.length + 60) + '…'),
      );
      button.addEventListener('click', () => goToPage(pv.n));
      hits.push(button);
    }
  }
  const summary = el('p', '', total ? `${total} résultat(s)${total > hits.length ? `, ${hits.length} affichés` : ''}.` : 'Aucun résultat. Si le document est un scan, il faudra d\'abord une reconnaissance de texte (OCR).');
  showPanel(`Recherche : ${query.trim()}`, [summary, ...hits]);
}

/* ---------- branchements ---------- */

PALETTE.forEach((c) => {
  const swatch = el('button', 'swatch');
  swatch.style.background = css(c);
  swatch.title = 'Couleur';
  swatch.addEventListener('click', () => {
    const neutral = ['select', 'eraser', 'edit', 'redact', 'comment', 'field'].includes(state.tool);
    state.colors[neutral ? 'highlight' : state.tool] = c;
    if (neutral) setTool('highlight');
    else applyTool();
  });
  $('swatches').append(swatch);
});

const click = (id, fn) => $(id).addEventListener('click', () => guard(fn));
click('btn-open', openDialog);
click('btn-open-empty', openDialog);
click('btn-sample', async () => {
  const res = await fetch(at(config.samples + 'exemple-scan.pdf'));
  if (!res.ok) throw new Error("Le document d'exemple est introuvable.");
  await openBytes(new Uint8Array(await res.arrayBuffer()), 'exemple-scan.pdf');
});
click('btn-save', save);
click('btn-zoom-in', () => setScale(state.scale * 1.2));
click('btn-zoom-out', () => setScale(state.scale / 1.2));
click('btn-fit', fitWidth);
$('btn-undo').addEventListener('click', undo);
$('btn-redo').addEventListener('click', redo);
click('act-rotate-left', () => pageOperation((b, n) => PdfOps.rotatePage(b, n, -90)));
click('act-rotate-right', () => pageOperation((b, n) => PdfOps.rotatePage(b, n, 90)));
click('act-delete', () => pageOperation((b, n) => PdfOps.deletePage(b, n)));
click('act-extract', extractPages);
click('act-move-up', () => (state.current > 1 ? pageOperation((b, n) => PdfOps.movePage(b, n, n - 1), state.current - 1) : null));
click('act-move-down', () => (state.current < state.pdf.numPages ? pageOperation((b, n) => PdfOps.movePage(b, n, n + 1), state.current + 1) : null));
click('act-insert-blank', () => pageOperation((b, n) => PdfOps.insertBlankPage(b, n), state.current + 1));
click('act-insert-pdf', insertPdf);
click('act-image', insertImage);
click('act-office', officeToPdf);
click('act-word', exportWordLayout);
click('act-word-text', exportWord);
click('act-excel', exportExcel);
click('act-sign', openSignature);
click('act-number', async () => { await pageOperation((b) => PdfOps.numberPages(b)); toast('Pages numérotées en bas au centre.'); });
click('act-watermark', addWatermark);
click('act-outline', showOutline);
click('act-shrink', shrinkFile);
click('act-comments', showComments);
click('act-field-text', () => startField('text'));
click('act-field-check', () => startField('checkbox'));
click('act-print', printDocument);
click('btn-print', printDocument);
click('act-ocr-lang', chooseOcrLanguage);
if (!config.canPrint) { $('act-print').remove(); $('btn-print').remove(); }
click('act-protect', saveProtected);
click('act-merge', mergeFiles);
click('act-images', imagesToPdf);
click('act-export', exportPng);
click('act-fonts', showFonts);
click('act-ocr', runOcr);
click('panel-close', closePanel);

document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool, true)));

// Les menus se referment après un choix ou un clic ailleurs.
document.addEventListener('click', (event) => {
  document.querySelectorAll('details.menu[open]').forEach((menu) => {
    if (!menu.contains(event.target) || event.target.closest('.menu-list')) menu.open = false;
  });
});

$('page-input').addEventListener('change', (event) => {
  const n = Math.min(state.pages.length, Math.max(1, Number(event.target.value) || 1));
  goToPage(n);
});

let searchTimer;
$('search').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  const value = event.target.value;
  searchTimer = setTimeout(() => guard(() => search(value)), 250);
});

document.addEventListener('keydown', (event) => {
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (ctrl && key === 'o') { event.preventDefault(); guard(openDialog); }
  else if (ctrl && key === 's') { event.preventDefault(); guard(save); }
  else if (ctrl && key === 'p') { event.preventDefault(); if (config.canPrint && state.pdf) guard(printDocument); }
  else if (ctrl && key === 'f') { event.preventDefault(); $('search').focus(); }
  else if (ctrl && key === 'z' && !event.shiftKey && !/INPUT|TEXTAREA/.test(event.target.tagName)) { event.preventDefault(); undo(); }
  else if (ctrl && (key === 'y' || (key === 'z' && event.shiftKey)) && !/INPUT|TEXTAREA/.test(event.target.tagName)) { event.preventDefault(); redo(); }
  else if (ctrl && (key === '+' || key === '=')) { event.preventDefault(); setScale(state.scale * 1.2); }
  else if (ctrl && key === '-') { event.preventDefault(); setScale(state.scale / 1.2); }
  else if (key === 'escape') setTool('select');
});

viewer.addEventListener('wheel', (event) => {
  if (!event.ctrlKey) return;
  event.preventDefault();
  setScale(state.scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

viewer.addEventListener('dragover', (event) => { event.preventDefault(); viewer.classList.add('drop'); });
viewer.addEventListener('dragleave', () => viewer.classList.remove('drop'));
viewer.addEventListener('drop', (event) => {
  event.preventDefault();
  viewer.classList.remove('drop');
  const file = [...event.dataTransfer.files].find((f) => /\.pdf$/i.test(f.name));
  if (!file) return toast('Déposez un fichier PDF.', true);
  guard(async () => openBytes(new Uint8Array(await file.arrayBuffer()), file.name));
});

$('toast').addEventListener('click', () => ($('toast').hidden = true));

refreshChrome();
guard(async () => {
  const file = await api.initialFile();
  if (file) await openBytes(file.data, file.name, { path: file.path });
});
