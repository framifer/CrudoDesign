// CrudoDesign — modulo principale
import { Doc } from './doc.js';
import { drawSegment } from './brush.js';
import { floodFill } from './fill.js';
import { hexToRgb, rgbToHex, DEFAULT_SWATCHES } from './color.js';
import {
  saveProject, loadProject, listProjects, deleteProject,
  exportToFile, importFromFile, deserializeInto, newId,
} from './storage.js';

const W = 1280;
const H = 800;

const state = {
  doc: new Doc(W, H),
  tool: 'brush',
  brushType: 'round',
  size: 8,
  opacity: 1,
  color: '#222222',
  usePressure: true,
  drawing: false,
  last: null,
  playing: false,
  fps: 8,
  onion: true,
  scale: 1,
  fitScale: 1,
  zoom: 1,
  undoStack: [],
  redoStack: [],
  projectId: null,
  projectName: 'Senza titolo',
};

// --- Riferimenti DOM ---
const stack = document.getElementById('canvasStack');
const canvasWrap = document.getElementById('canvasWrap');

// Canvas visibili: onion (sotto) + composito (disegno corrente)
const onionCanvas = document.createElement('canvas');
const viewCanvas = document.createElement('canvas');
for (const c of [onionCanvas, viewCanvas]) {
  c.width = W; c.height = H;
  stack.appendChild(c);
}
const onionCtx = onionCanvas.getContext('2d');
const viewCtx = viewCanvas.getContext('2d');
// Canvas per input (in cima, trasparente)
const inputCanvas = viewCanvas;

// Le canvas di disegno devono stare SOPRA il video di riferimento
onionCanvas.style.zIndex = '1';
viewCanvas.style.zIndex = '2';

// Video di riferimento (camera), inserito sotto le canvas nello stack
const refVideo = document.createElement('video');
refVideo.id = 'refVideo';
refVideo.setAttribute('playsinline', '');
refVideo.muted = true;
stack.insertBefore(refVideo, stack.firstChild);

stack.style.width = W + 'px';
stack.style.height = H + 'px';

// --- Adatta lo zoom allo spazio disponibile ---
const stageEl = document.getElementById('stage');

function fitStage() {
  // getBoundingClientRect è affidabile e tiene conto del padding reale
  const rect = stageEl.getBoundingClientRect();
  const cs = getComputedStyle(stageEl);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const availW = rect.width - padX;
  const availH = rect.height - padY;
  if (availW <= 0 || availH <= 0) return; // stage non ancora dimensionato
  const sx = availW / W;
  const sy = availH / H;
  // scala base che fa entrare il foglio nello spazio disponibile
  state.fitScale = Math.max(0.05, Math.min(sx, sy, 1));
  // scala finale = adattamento * zoom manuale
  state.scale = state.fitScale * state.zoom;
  canvasWrap.style.width = W * state.scale + 'px';
  canvasWrap.style.height = H * state.scale + 'px';
  stack.style.transform = `scale(${state.scale})`;
  stack.style.transformOrigin = 'top left';
  const zl = document.getElementById('zoomLabel');
  if (zl) zl.textContent = Math.round(state.scale * 100) + '%';
}

// Ricalcola automaticamente ogni volta che lo stage cambia dimensione
// (apertura/chiusura pannelli, ridimensionamento finestra) — senza problemi di timing.
if ('ResizeObserver' in window) {
  const ro = new ResizeObserver(() => fitStage());
  ro.observe(stageEl);
} else {
  window.addEventListener('resize', () => requestAnimationFrame(fitStage));
}

// Zoom manuale
function setZoom(z) {
  state.zoom = Math.max(0.25, Math.min(8, z));
  fitStage();
}

// --- Rendering ---
function renderView() {
  viewCtx.clearRect(0, 0, W, H);
  Doc.composite(state.doc.frame, viewCtx);
}

function renderOnion() {
  onionCtx.clearRect(0, 0, W, H);
  if (!state.onion || state.playing) return;
  const idx = state.doc.activeFrame;
  // frame precedente in rosso-ish, successivo in blu-ish (semitrasparenti)
  if (idx > 0) {
    onionCtx.globalAlpha = 0.3;
    Doc.composite(state.doc.frames[idx - 1], onionCtx);
  }
  if (idx < state.doc.frames.length - 1) {
    onionCtx.globalAlpha = 0.2;
    Doc.composite(state.doc.frames[idx + 1], onionCtx);
  }
  onionCtx.globalAlpha = 1;
}

function renderAll() {
  renderOnion();
  renderView();
}

// --- Coordinate da evento pointer al canvas (massima precisione) ---
// La bounding box viene letta una volta a inizio tratto (evita letture
// ripetute che introducono errori e costi durante il movimento).
let strokeRect = null;

function readRect() {
  strokeRect = inputCanvas.getBoundingClientRect();
}

function getPoint(e) {
  const rect = strokeRect || inputCanvas.getBoundingClientRect();
  // coordinate in sotto-pixel (nessun arrotondamento): massima precisione
  const x = (e.clientX - rect.left) / state.scale;
  const y = (e.clientY - rect.top) / state.scale;

  // Pressione: usiamo il valore reale del pennino.
  let pressure = e.pressure;
  if (e.pointerType === 'mouse') {
    pressure = 0.5; // il mouse non ha pressione
  } else if (e.pointerType === 'touch' && (pressure === 0 || pressure === 0.5)) {
    // molti touchscreen non riportano pressione affidabile
    pressure = 0.5;
  } else if (pressure === 0) {
    pressure = 0.5; // fallback
  }
  return {
    x, y,
    pressure,
    tiltX: e.tiltX || 0,
    tiltY: e.tiltY || 0,
    pointerType: e.pointerType,
  };
}

// --- Undo/Redo (snapshot del layer attivo) ---
function pushUndo() {
  const l = state.doc.layer;
  const snap = l.ctx.getImageData(0, 0, W, H);
  state.undoStack.push({ frame: state.doc.activeFrame, layerId: l.id, snap });
  if (state.undoStack.length > 40) state.undoStack.shift();
  state.redoStack.length = 0;
}

function restoreSnapshot(entry, intoRedo) {
  // trova il layer per id nel frame corretto
  const frame = state.doc.frames[entry.frame];
  if (!frame) return;
  const layer = frame.layers.find((l) => l.id === entry.layerId);
  if (!layer) return;
  const current = layer.ctx.getImageData(0, 0, W, H);
  const target = intoRedo ? state.redoStack : state.undoStack;
  target.push({ frame: entry.frame, layerId: entry.layerId, snap: current });
  layer.ctx.putImageData(entry.snap, 0, 0);
  renderAll();
  refreshFrameThumbs();
}

function undo() {
  const entry = state.undoStack.pop();
  if (entry) restoreSnapshot(entry, true);
}
function redo() {
  const entry = state.redoStack.pop();
  if (entry) restoreSnapshot(entry, false);
}

// --- Gestione input di disegno (ottimizzata per il pennino) ---
// Palm rejection: se sta scrivendo un pennino, ignoriamo il tocco delle dita.
let activePointerId = null;
let activePointerType = null;
// Buffer dei punti del tratto corrente per lo smoothing a curve quadratiche
let strokePoints = [];
let smoothedPressure = 0.5;

// --- Multi-touch: pinch-to-zoom e pan con due dita ---
const activeTouches = new Map(); // pointerId -> {x, y} (coordinate schermo)
let pinch = null; // { startDist, startZoom, startCenter, startScroll }

function screenPt(e) { return { x: e.clientX, y: e.clientY }; }

// Annulla il tratto in corso ripristinando lo snapshot pre-tratto (nessuna traccia)
function cancelCurrentStroke() {
  if (state.drawing) {
    const entry = state.undoStack.pop(); // rimuovi lo snapshot salvato a inizio tratto
    if (entry) {
      const frame = state.doc.frames[entry.frame];
      const layer = frame && frame.layers.find((l) => l.id === entry.layerId);
      if (layer) layer.ctx.putImageData(entry.snap, 0, 0);
    }
    state.drawing = false;
    state.last = null;
    strokePoints = [];
    renderView();
  }
}

function startPinch() {
  const pts = [...activeTouches.values()];
  if (pts.length < 2) return;
  const [a, b] = pts;
  pinch = {
    startDist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    startZoom: state.zoom,
    startCenter: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    startScroll: { left: stageEl.scrollLeft, top: stageEl.scrollTop },
  };
}

function updatePinch() {
  const pts = [...activeTouches.values()];
  if (!pinch || pts.length < 2) return;
  const [a, b] = pts;
  const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
  const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  // Zoom proporzionale alla variazione della distanza tra le dita
  setZoom(pinch.startZoom * (dist / pinch.startDist));
  // Pan: sposta la vista seguendo il movimento del centro delle due dita
  stageEl.scrollLeft = pinch.startScroll.left - (center.x - pinch.startCenter.x);
  stageEl.scrollTop = pinch.startScroll.top - (center.y - pinch.startCenter.y);
}

inputCanvas.addEventListener('pointerdown', (e) => {
  // Traccia i tocchi per il rilevamento del pinch
  if (e.pointerType === 'touch') {
    activeTouches.set(e.pointerId, screenPt(e));
    // Secondo dito: entra in modalità pinch e annulla qualsiasi tratto iniziato
    if (activeTouches.size === 2) {
      cancelCurrentStroke();
      startPinch();
      return;
    }
    // già in pinch (3+ dita): ignora
    if (activeTouches.size > 2) return;
  }

  // Se siamo in pinch, non disegnare
  if (pinch) return;

  // Palm rejection: se un pennino è già attivo, ignora i tocchi delle dita
  if (activePointerType === 'pen' && e.pointerType === 'touch') return;
  // Se arriva un pennino mentre disegnavi col dito, dai priorità al pennino
  if (e.pointerType === 'pen' && activePointerType === 'touch') {
    state.drawing = false;
  }

  e.preventDefault();
  readRect();
  inputCanvas.setPointerCapture(e.pointerId);
  activePointerId = e.pointerId;
  activePointerType = e.pointerType;

  const p = getPoint(e);

  if (state.tool === 'fill') {
    pushUndo();
    floodFill(state.doc.layer.ctx, p.x, p.y, state.color);
    renderAll();
    refreshFrameThumbs();
    return;
  }
  if (state.tool === 'eyedropper') {
    pickColor(p.x, p.y);
    return;
  }

  state.drawing = true;
  smoothedPressure = p.pressure;
  strokePoints = [p];
  state.last = p;
  pushUndo();
  // punto singolo (tap): disegna un piccolo dot
  stampDot(p);
  renderView();
});

inputCanvas.addEventListener('pointermove', (e) => {
  // Aggiorna la posizione dei tocchi e gestisci il pinch
  if (e.pointerType === 'touch' && activeTouches.has(e.pointerId)) {
    activeTouches.set(e.pointerId, screenPt(e));
    if (pinch) { e.preventDefault(); updatePinch(); return; }
  }
  if (pinch) return;

  if (!state.drawing) return;
  if (e.pointerId !== activePointerId) return; // ignora altri puntatori
  e.preventDefault();

  // Eventi "coalesced": tutti i campioni ad alta frequenza tra due frame
  // (i pennini campionano a 120-240Hz: così non perdiamo precisione).
  const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of coalesced) {
    addStrokePoint(getPoint(ev));
  }
  renderView(); // un solo render per batch di eventi
});

function endStroke(e) {
  // Gestione multi-touch: rimuovi il tocco solo su up/cancel (non su leave,
  // che può scattare mentre il dito è ancora premuto durante il pinch)
  const isRealEnd = e && (e.type === 'pointerup' || e.type === 'pointercancel');
  if (isRealEnd && e.pointerType === 'touch' && activeTouches.has(e.pointerId)) {
    activeTouches.delete(e.pointerId);
    if (pinch && activeTouches.size < 2) {
      // Fine del pinch: non riprendere a disegnare finché non si ricomincia da capo
      pinch = null;
      state.drawing = false;
      state.last = null;
      strokePoints = [];
      return;
    }
  }
  if (pinch) return;

  if (!state.drawing) return;
  if (e && e.pointerId != null && e.pointerId !== activePointerId) return;
  // traccia l'ultimo tratto rimanente fino all'ultimo punto
  flushStrokeTail();
  renderView();
  state.drawing = false;
  state.last = null;
  strokePoints = [];
  activePointerId = null;
  activePointerType = null;
  refreshFrameThumbs();
}
inputCanvas.addEventListener('pointerup', endStroke);
inputCanvas.addEventListener('pointercancel', endStroke);
inputCanvas.addEventListener('pointerleave', endStroke);

// Aggiunge un punto al tratto applicando smoothing a curva quadratica.
// Disegna un segmento fluido dal punto medio precedente al nuovo punto medio,
// usando il punto reale come punto di controllo della curva.
function addStrokePoint(p) {
  // filtra micro-tremolii: ignora spostamenti sub-pixel insignificanti
  const prev = strokePoints[strokePoints.length - 1];
  if (prev) {
    const dx = p.x - prev.x, dy = p.y - prev.y;
    if (dx * dx + dy * dy < 0.09) { // < 0.3px, aggiorna solo la pressione
      prev.pressure = p.pressure;
      return;
    }
  }
  // pressione ammorbidita per evitare scatti di spessore
  smoothedPressure = smoothedPressure * 0.5 + p.pressure * 0.5;
  p = { ...p, pressure: smoothedPressure };
  strokePoints.push(p);

  const n = strokePoints.length;
  if (n < 3) {
    // all'inizio traccia diretto
    drawSmoothSegment(strokePoints[n - 2], strokePoints[n - 2], strokePoints[n - 1]);
    return;
  }
  const p0 = strokePoints[n - 3];
  const p1 = strokePoints[n - 2];
  const p2 = strokePoints[n - 1];
  const m1 = midpoint(p0, p1);
  const m2 = midpoint(p1, p2);
  // curva quadratica da m1 a m2 con p1 come controllo
  drawQuadratic(m1, p1, m2);
  state.last = m2;
}

// Alla fine del tratto, completa fino all'ultimo punto reale.
function flushStrokeTail() {
  const n = strokePoints.length;
  if (n >= 2) {
    const p1 = strokePoints[n - 2];
    const p2 = strokePoints[n - 1];
    const m1 = midpoint(p1, p2);
    drawQuadratic(m1, p2, p2);
  }
}

function midpoint(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    pressure: (a.pressure + b.pressure) / 2,
  };
}

// Suddivide una curva quadratica in piccoli segmenti e li passa al pennello.
function drawQuadratic(start, control, end) {
  const dist = Math.hypot(end.x - start.x, end.y - start.y) +
               Math.hypot(control.x - start.x, control.y - start.y);
  const steps = Math.max(2, Math.ceil(dist / 2)); // ~1 campione ogni 2px
  let prev = start;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const it = 1 - t;
    const pt = {
      x: it * it * start.x + 2 * it * t * control.x + t * t * end.x,
      y: it * it * start.y + 2 * it * t * control.y + t * t * end.y,
      pressure: it * it * start.pressure + 2 * it * t * control.pressure + t * t * end.pressure,
    };
    drawSmoothSegment(prev, prev, pt);
    prev = pt;
  }
}

// Disegna un segmento con il pennello corrente (gestisce anche la gomma).
function drawSmoothSegment(_p0, from, to) {
  const ctx = state.doc.layer.ctx;
  const opts = {
    type: state.brushType,
    size: state.size,
    color: state.color,
    opacity: state.opacity,
    usePressure: state.usePressure,
  };
  if (state.tool === 'eraser') {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    drawSegment(ctx, from, to, { ...opts, color: '#000', opacity: 1 });
    ctx.restore();
  } else {
    drawSegment(ctx, from, to, opts);
  }
}

// Piccolo punto iniziale (tap senza movimento)
function stampDot(p) {
  drawSmoothSegment(p, p, p);
}

function pickColor(x, y) {
  const d = viewCtx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
  if (d[3] === 0) return;
  setColor(rgbToHex(d[0], d[1], d[2]));
  setTool('brush');
}

// --- Colori ---
const colorPicker = document.getElementById('colorPicker');
const currentColorEl = document.getElementById('currentColor');
const swatchesEl = document.getElementById('swatches');

function setColor(hex) {
  state.color = hex;
  colorPicker.value = hex;
  currentColorEl.style.background = hex;
}

function buildSwatches() {
  swatchesEl.innerHTML = '';
  DEFAULT_SWATCHES.forEach((hex) => {
    const s = document.createElement('div');
    s.className = 'swatch';
    s.style.background = hex;
    s.title = hex;
    s.addEventListener('click', () => setColor(hex));
    swatchesEl.appendChild(s);
  });
}

colorPicker.addEventListener('input', (e) => setColor(e.target.value));

// --- Tavolozza per mescolare i colori ---
const mixCanvas = document.getElementById('mixCanvas');
const mixCtx = mixCanvas.getContext('2d', { willReadFrequently: true });
let mixing = false;

function initMix() {
  mixCtx.fillStyle = '#ffffff';
  mixCtx.fillRect(0, 0, mixCanvas.width, mixCanvas.height);
}

function mixStroke(e) {
  const rect = mixCanvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (mixCanvas.width / rect.width);
  const y = (e.clientY - rect.top) * (mixCanvas.height / rect.height);
  const amount = document.getElementById('mixAmount').value / 100;
  const { r, g, b } = hexToRgb(state.color);
  // Deposita colore semitrasparente: sovrapponendo colori diversi si mescolano
  mixCtx.globalAlpha = amount * 0.5;
  mixCtx.fillStyle = `rgb(${r},${g},${b})`;
  mixCtx.beginPath();
  mixCtx.arc(x, y, 12, 0, Math.PI * 2);
  mixCtx.fill();
  mixCtx.globalAlpha = 1;
}

mixCanvas.addEventListener('pointerdown', (e) => {
  // click semplice = preleva il colore mescolato sotto il puntatore
  mixing = true;
  mixStroke(e);
});
mixCanvas.addEventListener('pointermove', (e) => { if (mixing) mixStroke(e); });
mixCanvas.addEventListener('pointerup', (e) => {
  mixing = false;
  // preleva il colore risultante nel punto di rilascio
  const rect = mixCanvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) * (mixCanvas.width / rect.width));
  const y = Math.floor((e.clientY - rect.top) * (mixCanvas.height / rect.height));
  const d = mixCtx.getImageData(x, y, 1, 1).data;
  setColor(rgbToHex(d[0], d[1], d[2]));
});
document.getElementById('mixClear').addEventListener('click', initMix);

// --- Strumenti ---
function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll('.tool').forEach((b) =>
    b.classList.toggle('active', b.dataset.tool === tool));
}
document.querySelectorAll('.tool').forEach((btn) => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

// --- Impostazioni pennello ---
const sizeInput = document.getElementById('brushSize');
const sizeVal = document.getElementById('brushSizeVal');
sizeInput.addEventListener('input', () => {
  state.size = +sizeInput.value;
  sizeVal.textContent = sizeInput.value;
});
const opInput = document.getElementById('brushOpacity');
const opVal = document.getElementById('brushOpacityVal');
opInput.addEventListener('input', () => {
  state.opacity = +opInput.value / 100;
  opVal.textContent = opInput.value;
});
document.getElementById('brushType').addEventListener('change', (e) => {
  state.brushType = e.target.value;
});
document.getElementById('usePressure').addEventListener('change', (e) => {
  state.usePressure = e.target.checked;
});

// --- Azioni ---
document.getElementById('undoBtn').addEventListener('click', undo);
document.getElementById('redoBtn').addEventListener('click', redo);
document.getElementById('clearBtn').addEventListener('click', () => {
  pushUndo();
  state.doc.layer.ctx.clearRect(0, 0, W, H);
  renderAll();
  refreshFrameThumbs();
});
document.getElementById('exportBtn').addEventListener('click', exportPNG);

function exportPNG() {
  // apre la finestra con le opzioni di esportazione
  openExportModal();
}

// --- Esportazione immagine ad alta risoluzione (raster) ---
const exportModal = document.getElementById('exportModal');
const exportModalStatus = document.getElementById('exportModalStatus');

function openExportModal() { exportModal.classList.add('active'); }
function closeExportModal() { exportModal.classList.remove('active'); }

document.getElementById('closeExport').addEventListener('click', closeExportModal);
exportModal.addEventListener('click', (e) => { if (e.target === exportModal) closeExportModal(); });

// Estensione file dal mime type
function extFor(mime) {
  return mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
}

// Compone un frame (o un singolo layer) su un canvas alla scala richiesta
function renderToCanvas({ scale, bg, frame, singleLayer }) {
  const out = document.createElement('canvas');
  out.width = W * scale;
  out.height = H * scale;
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  if (bg === 'white') {
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, out.width, out.height);
  }
  octx.scale(scale, scale);
  if (singleLayer) {
    if (singleLayer.visible) {
      octx.globalAlpha = singleLayer.opacity;
      octx.drawImage(singleLayer.canvas, 0, 0);
      octx.globalAlpha = 1;
    }
  } else {
    Doc.composite(frame, octx);
  }
  return out;
}

function downloadCanvas(canvas, filename, mime) {
  return new Promise((resolve) => {
    // JPEG non supporta trasparenza: qualità 0.92
    const quality = (mime === 'image/jpeg' || mime === 'image/webp') ? 0.92 : undefined;
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); resolve(); }, 400);
    }, mime, quality);
  });
}

async function doExport() {
  const scale = parseInt(document.getElementById('exportScale').value, 10);
  let bg = document.getElementById('exportBg').value;
  const mime = document.getElementById('exportFormat').value;
  const content = document.getElementById('exportContent').value;
  const ext = extFor(mime);
  // JPEG non ha trasparenza: forziamo sfondo bianco
  if (mime === 'image/jpeg' && bg === 'transparent') bg = 'white';

  exportModalStatus.textContent = 'Esportazione…';

  const base = (state.projectName && state.projectName !== 'Senza titolo')
    ? state.projectName.replace(/[^\w\-]+/g, '_') : 'crudodesign';

  if (content === 'frame') {
    const c = renderToCanvas({ scale, bg, frame: state.doc.frame });
    await downloadCanvas(c, `${base}_frame${state.doc.activeFrame + 1}.${ext}`, mime);
  } else if (content === 'layers') {
    const layers = state.doc.frame.layers;
    for (let i = 0; i < layers.length; i++) {
      exportModalStatus.textContent = `Layer ${i + 1}/${layers.length}…`;
      const c = renderToCanvas({ scale, bg, singleLayer: layers[i] });
      await downloadCanvas(c, `${base}_frame${state.doc.activeFrame + 1}_layer${i + 1}.${ext}`, mime);
    }
  } else if (content === 'frames') {
    for (let i = 0; i < state.doc.frames.length; i++) {
      exportModalStatus.textContent = `Frame ${i + 1}/${state.doc.frames.length}…`;
      const c = renderToCanvas({ scale, bg, frame: state.doc.frames[i] });
      const num = String(i + 1).padStart(3, '0');
      await downloadCanvas(c, `${base}_frame${num}.${ext}`, mime);
    }
  }

  exportModalStatus.textContent = 'Fatto ✓';
  setTimeout(() => { exportModalStatus.textContent = ''; closeExportModal(); }, 1200);
}
document.getElementById('doExport').addEventListener('click', doExport);

// --- Pannello Layer ---
const layerList = document.getElementById('layerList');
function refreshLayers() {
  layerList.innerHTML = '';
  const layers = state.doc.frame.layers;
  // mostra dall'alto verso il basso (il layer in cima alla lista è quello sopra)
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    const li = document.createElement('li');
    li.className = 'layer-item' + (i === state.doc.frame.activeLayer ? ' active' : '');

    const vis = document.createElement('span');
    vis.className = 'vis';
    vis.textContent = l.visible ? '👁️' : '🚫';
    vis.addEventListener('click', (e) => {
      e.stopPropagation();
      l.visible = !l.visible;
      refreshLayers();
      renderAll();
    });

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = (i + 1); // solo il numero del layer

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.doc.removeLayer(i)) { refreshLayers(); renderAll(); refreshFrameThumbs(); }
    });

    li.addEventListener('click', () => {
      state.doc.frame.activeLayer = i;
      refreshLayers();
    });

    li.append(vis, name, del);
    layerList.appendChild(li);
  }
}
document.getElementById('addLayer').addEventListener('click', () => {
  state.doc.addLayer();
  refreshLayers();
  renderAll();
});

// --- Timeline / Animazione ---
const frameList = document.getElementById('frameList');

function refreshFrames() {
  frameList.innerHTML = '';
  state.doc.frames.forEach((frame, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'frame-thumb' + (i === state.doc.activeFrame ? ' active' : '');
    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = i + 1;
    const c = document.createElement('canvas');
    c.width = 168; c.height = 120;
    thumb.append(c, idx);
    thumb.addEventListener('click', () => {
      state.doc.activeFrame = i;
      refreshLayers();
      refreshFrames();
      renderAll();
    });
    frameList.appendChild(thumb);
    drawThumb(c, frame);
  });
}

function drawThumb(c, frame) {
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.save();
  ctx.scale(c.width / W, c.height / H);
  Doc.composite(frame, ctx);
  ctx.restore();
}

// Aggiorna solo la miniatura del frame attivo (più efficiente)
function refreshFrameThumbs() {
  const thumbs = frameList.querySelectorAll('.frame-thumb canvas');
  const c = thumbs[state.doc.activeFrame];
  if (c) drawThumb(c, state.doc.frame);
}

document.getElementById('addFrame').addEventListener('click', () => {
  state.doc.addFrame();
  refreshLayers(); refreshFrames(); renderAll();
});
document.getElementById('dupFrame').addEventListener('click', () => {
  state.doc.duplicateFrame();
  refreshLayers(); refreshFrames(); renderAll();
});
document.getElementById('delFrame').addEventListener('click', () => {
  if (state.doc.removeFrame(state.doc.activeFrame)) {
    refreshLayers(); refreshFrames(); renderAll();
  }
});
document.getElementById('onionSkin').addEventListener('change', (e) => {
  state.onion = e.target.checked;
  renderAll();
});
document.getElementById('fps').addEventListener('change', (e) => {
  state.fps = Math.max(1, Math.min(30, +e.target.value));
});

// Playback
let playTimer = null;
const playBtn = document.getElementById('playBtn');
playBtn.addEventListener('click', () => {
  state.playing = !state.playing;
  playBtn.textContent = state.playing ? '⏸️' : '▶️';
  if (state.playing) {
    renderOnion(); // pulisce l'onion durante il play
    playTimer = setInterval(() => {
      state.doc.activeFrame = (state.doc.activeFrame + 1) % state.doc.frames.length;
      renderView();
      refreshFrames();
    }, 1000 / state.fps);
  } else {
    clearInterval(playTimer);
    refreshLayers();
    renderAll();
  }
});

// Scorciatoie da tastiera
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo(); }
  else if (e.ctrlKey && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); redo(); }
  else if (e.key === 'b') setTool('brush');
  else if (e.key === 'e') setTool('eraser');
  else if (e.key === 'g') setTool('fill');
  else if (e.key === 'i') setTool('eyedropper');
});

// --- Toggle timeline (apri/chiudi) ---
const timelineEl = document.getElementById('timeline');
const toggleTimelineBtn = document.getElementById('toggleTimeline');
toggleTimelineBtn.classList.add('active'); // aperta all'avvio
toggleTimelineBtn.addEventListener('click', () => {
  const collapsed = timelineEl.classList.toggle('collapsed');
  toggleTimelineBtn.classList.toggle('active', !collapsed);
  renderAll(); // il ridimensionamento del foglio è gestito dal ResizeObserver
});

// --- Nascondi/mostra l'intera barra dei comandi ---
const appEl = document.getElementById('app');
const brandEl = document.getElementById('brand');
const showTopbarBtn = document.getElementById('showTopbar');

// Usiamo pointerup (immediato e uniforme su dito/pennino/mouse) invece di
// click, che su mobile può essere ritardato o soppresso da touch-action.
function bindTap(el, handler) {
  el.addEventListener('pointerup', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handler();
  });
}

bindTap(brandEl, () => {
  appEl.classList.add('topbar-hidden');
  renderAll(); // il foglio si riadatta via ResizeObserver
});
bindTap(showTopbarBtn, () => {
  appEl.classList.remove('topbar-hidden');
  renderAll();
});

// --- Toggle pannelli Colori e Layer ---
const mainEl = document.getElementById('main');
const toggleColorsBtn = document.getElementById('toggleColors');
const toggleLayersBtn = document.getElementById('toggleLayers');

toggleColorsBtn.addEventListener('click', () => {
  const hidden = mainEl.classList.toggle('no-colors');
  toggleColorsBtn.classList.toggle('active', !hidden);
  renderAll();
});
toggleLayersBtn.addEventListener('click', () => {
  const hidden = mainEl.classList.toggle('no-layers');
  toggleLayersBtn.classList.toggle('active', !hidden);
  renderAll();
});

// --- Zoom in / out del foglio ---
document.getElementById('zoomInBtn').addEventListener('click', () => setZoom(state.zoom * 1.25));
document.getElementById('zoomOutBtn').addEventListener('click', () => setZoom(state.zoom / 1.25));
document.getElementById('zoomResetBtn').addEventListener('click', () => setZoom(1));

// --- Export video dell'animazione ---
const exportVideoBtn = document.getElementById('exportVideoBtn');
const exportStatus = document.getElementById('exportStatus');
let exporting = false;

async function exportVideo() {
  if (exporting) return;
  if (state.doc.frames.length < 1) return;
  if (typeof MediaRecorder === 'undefined') {
    alert('La registrazione video non è supportata da questo browser.');
    return;
  }
  exporting = true;
  const wasPlaying = state.playing;
  if (wasPlaying) playBtn.click(); // ferma il playback

  exportVideoBtn.disabled = true;
  exportStatus.textContent = 'Registrazione…';

  // Canvas di rendering fuori schermo, su sfondo bianco
  const rec = document.createElement('canvas');
  rec.width = W; rec.height = H;
  const rctx = rec.getContext('2d');

  // Scegli un mimeType supportato
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  const mimeType = candidates.find((t) => MediaRecorder.isTypeSupported(t)) || 'video/webm';

  const stream = rec.captureStream(state.fps);
  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

  const done = new Promise((resolve) => { recorder.onstop = resolve; });

  const drawFrame = (i) => {
    rctx.fillStyle = '#ffffff';
    rctx.fillRect(0, 0, W, H);
    Doc.composite(state.doc.frames[i], rctx);
  };

  recorder.start();
  const frameDuration = 1000 / state.fps;

  // Riproduci ogni frame per la durata corretta
  for (let i = 0; i < state.doc.frames.length; i++) {
    drawFrame(i);
    exportStatus.textContent = `Registrazione… ${i + 1}/${state.doc.frames.length}`;
    // richiedi un nuovo frame allo stream e attendi la durata
    if (stream.getVideoTracks()[0].requestFrame) {
      stream.getVideoTracks()[0].requestFrame();
    }
    await new Promise((r) => setTimeout(r, frameDuration));
  }
  // piccolo margine per catturare l'ultimo frame
  await new Promise((r) => setTimeout(r, frameDuration));
  recorder.stop();
  await done;

  const blob = new Blob(chunks, { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'crudodesign_animazione.webm';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  exportStatus.textContent = 'Video salvato ✓';
  setTimeout(() => { exportStatus.textContent = ''; }, 4000);
  exportVideoBtn.disabled = false;
  exporting = false;
  renderAll();
}
exportVideoBtn.addEventListener('click', exportVideo);

// --- Camera di riferimento (ricalco) ---
let camStream = null;
const cameraBtn = document.getElementById('cameraBtn');
const camOpacityWrap = document.getElementById('camOpacityWrap');
const camOpacity = document.getElementById('camOpacity');

async function toggleCamera() {
  if (camStream) {
    stopCamera();
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('La fotocamera non è disponibile su questo dispositivo/browser.');
    return;
  }
  try {
    // facingMode 'environment' = camera posteriore su cellulare
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
    refVideo.srcObject = camStream;
    await refVideo.play();
    refVideo.classList.add('active');
    camOpacityWrap.classList.add('active');
    cameraBtn.classList.add('tool');
    cameraBtn.classList.add('active');
    cameraBtn.textContent = '📷✕';
    cameraBtn.title = 'Chiudi camera';
  } catch (err) {
    console.error('Errore camera:', err);
    let msg = 'Impossibile accedere alla fotocamera.';
    if (err.name === 'NotAllowedError') msg += ' Permesso negato: consenti l\'accesso alla camera.';
    else if (err.name === 'NotFoundError') msg += ' Nessuna fotocamera trovata.';
    else if (location.protocol !== 'https:') msg += ' Serve una connessione sicura (HTTPS).';
    alert(msg);
    camStream = null;
  }
}

function stopCamera() {
  if (camStream) {
    camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
  }
  refVideo.srcObject = null;
  refVideo.classList.remove('active');
  camOpacityWrap.classList.remove('active');
  cameraBtn.classList.remove('tool', 'active');
  cameraBtn.textContent = '📷';
  cameraBtn.title = 'Camera di riferimento (ricalca)';
}

cameraBtn.addEventListener('click', toggleCamera);
camOpacity.addEventListener('input', () => {
  refVideo.style.opacity = camOpacity.value / 100;
});

// --- Salvataggio / Caricamento progetti ---
const LAST_KEY = 'crudodesign_last_project';

// Ricostruisce tutta la UI dopo aver cambiato documento
function rebuildAll() {
  refreshLayers();
  refreshFrames();
  fitStage();
  renderAll();
}

async function doSave(askName) {
  let name = state.projectName;
  if (askName || !state.projectId) {
    const input = prompt('Nome del progetto:', name === 'Senza titolo' ? '' : name);
    if (input === null) return; // annullato
    name = input.trim() || 'Senza titolo';
  }
  if (!state.projectId) state.projectId = newId();
  state.projectName = name;
  try {
    await saveProject(state.projectId, name, state.doc);
    localStorage.setItem(LAST_KEY, state.projectId);
    flash(`Salvato: ${name} ✓`);
  } catch (e) {
    console.error(e);
    alert('Errore durante il salvataggio: ' + e.message);
  }
}

async function doLoad(id) {
  const record = await loadProject(id);
  if (!record) return;
  await deserializeInto(state.doc, record.doc);
  state.projectId = record.id;
  state.projectName = record.name;
  state.undoStack.length = 0;
  state.redoStack.length = 0;
  localStorage.setItem(LAST_KEY, id);
  rebuildAll();
  closeProjectsModal();
  flash(`Aperto: ${record.name}`);
}

function flash(msg) {
  exportStatus.textContent = msg;
  setTimeout(() => { if (exportStatus.textContent === msg) exportStatus.textContent = ''; }, 3000);
}

// Modale progetti
const projectsModal = document.getElementById('projectsModal');
const projectListEl = document.getElementById('projectList');

function openProjectsModal() {
  refreshProjectList();
  projectsModal.classList.add('active');
}
function closeProjectsModal() {
  projectsModal.classList.remove('active');
}

async function refreshProjectList() {
  const items = await listProjects();
  projectListEl.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'project-item empty';
    li.textContent = 'Nessun progetto salvato';
    projectListEl.appendChild(li);
    return;
  }
  items.forEach((it) => {
    const li = document.createElement('li');
    li.className = 'project-item';
    const info = document.createElement('div');
    info.className = 'info';
    const d = new Date(it.updatedAt);
    info.innerHTML = `<div class="name">${it.name}</div>` +
      `<div class="date">${d.toLocaleString('it-IT')}</div>`;
    const openBtn = document.createElement('button');
    openBtn.textContent = 'Apri';
    openBtn.addEventListener('click', () => doLoad(it.id));
    const expBtn = document.createElement('button');
    expBtn.textContent = '⬇️';
    expBtn.title = 'Esporta .crudo';
    expBtn.addEventListener('click', async () => {
      const rec = await loadProject(it.id);
      if (rec) {
        await deserializeInto(state.doc, rec.doc);
        exportToFile(rec.name, state.doc);
      }
    });
    const delBtn = document.createElement('button');
    delBtn.textContent = '🗑️';
    delBtn.title = 'Elimina';
    delBtn.addEventListener('click', async () => {
      if (confirm(`Eliminare "${it.name}"?`)) {
        await deleteProject(it.id);
        if (state.projectId === it.id) { state.projectId = null; }
        refreshProjectList();
      }
    });
    li.append(info, openBtn, expBtn, delBtn);
    projectListEl.appendChild(li);
  });
}

document.getElementById('saveBtn').addEventListener('click', () => doSave(!state.projectId));
document.getElementById('projectsBtn').addEventListener('click', openProjectsModal);
document.getElementById('closeProjects').addEventListener('click', closeProjectsModal);
projectsModal.addEventListener('click', (e) => {
  if (e.target === projectsModal) closeProjectsModal();
});

document.getElementById('newProject').addEventListener('click', () => {
  if (!confirm('Creare un nuovo progetto? Le modifiche non salvate andranno perse.')) return;
  state.doc = new Doc(W, H);
  state.projectId = null;
  state.projectName = 'Senza titolo';
  state.undoStack.length = 0;
  state.redoStack.length = 0;
  localStorage.removeItem(LAST_KEY);
  rebuildAll();
  closeProjectsModal();
});

const importFileInput = document.getElementById('importFile');
document.getElementById('importProject').addEventListener('click', () => importFileInput.click());
importFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const parsed = await importFromFile(file);
    await deserializeInto(state.doc, parsed.doc);
    state.projectId = newId();
    state.projectName = parsed.name || 'Importato';
    await saveProject(state.projectId, state.projectName, state.doc);
    localStorage.setItem(LAST_KEY, state.projectId);
    rebuildAll();
    closeProjectsModal();
    flash(`Importato: ${state.projectName}`);
  } catch (err) {
    alert('File non valido: ' + err.message);
  }
  importFileInput.value = '';
});

// Ctrl+S per salvare
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 's') { e.preventDefault(); doSave(!state.projectId); }
});

// All'avvio prova a ricaricare l'ultimo progetto
async function loadLastProject() {
  const lastId = localStorage.getItem(LAST_KEY);
  if (!lastId) return;
  const record = await loadProject(lastId);
  if (!record) return;
  await deserializeInto(state.doc, record.doc);
  state.projectId = record.id;
  state.projectName = record.name;
  rebuildAll();
}

// --- Avvio ---
function init() {
  setColor(state.color);
  buildSwatches();
  initMix();
  refreshLayers();
  refreshFrames();
  fitStage();
  setZoom(state.zoom); // aggiorna l'etichetta dello zoom
  renderAll();
  // ripristina l'ultimo progetto aperto (se presente)
  loadLastProject().catch((e) => console.error('Ripristino progetto fallito:', e));
}
init();
