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
function fitStage() {
  const stage = document.getElementById('stage');
  const pad = 40;
  const sx = (stage.clientWidth - pad) / W;
  const sy = (stage.clientHeight - pad) / H;
  state.scale = Math.min(sx, sy, 1);
  canvasWrap.style.width = W * state.scale + 'px';
  canvasWrap.style.height = H * state.scale + 'px';
  stack.style.transform = `scale(${state.scale})`;
  stack.style.transformOrigin = 'top left';
}
window.addEventListener('resize', fitStage);

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

// --- Coordinate da evento pointer al canvas ---
function getPoint(e) {
  const rect = inputCanvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / state.scale;
  const y = (e.clientY - rect.top) / state.scale;
  let pressure = e.pressure;
  // Il dito/mouse spesso riporta 0 o 0.5; normalizziamo
  if (e.pointerType === 'mouse') pressure = 0.5;
  if (pressure === 0) pressure = 0.5;
  return { x, y, pressure };
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

// --- Gestione input di disegno ---
inputCanvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  inputCanvas.setPointerCapture(e.pointerId);
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
  state.last = p;
  pushUndo();
  strokeTo(p); // punto singolo
});

inputCanvas.addEventListener('pointermove', (e) => {
  if (!state.drawing) return;
  e.preventDefault();
  // coalesced events per tratti fluidi ad alta frequenza (pennino)
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of events) {
    const p = getPoint(ev);
    strokeTo(p);
  }
});

function endStroke(e) {
  if (!state.drawing) return;
  state.drawing = false;
  state.last = null;
  refreshFrameThumbs();
}
inputCanvas.addEventListener('pointerup', endStroke);
inputCanvas.addEventListener('pointercancel', endStroke);
inputCanvas.addEventListener('pointerleave', endStroke);

function strokeTo(p) {
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
    drawSegment(ctx, state.last || p, p, { ...opts, color: '#000', opacity: 1 });
    ctx.restore();
  } else {
    drawSegment(ctx, state.last || p, p, opts);
  }
  state.last = p;
  renderView();
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
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const octx = out.getContext('2d');
  octx.fillStyle = '#ffffff';
  octx.fillRect(0, 0, W, H);
  Doc.composite(state.doc.frame, octx);
  const a = document.createElement('a');
  a.download = `crudodesign_frame${state.doc.activeFrame + 1}.png`;
  a.href = out.toDataURL('image/png');
  a.click();
}

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
    name.textContent = l.name;

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
  fitStage(); // ricalcola lo zoom con il nuovo spazio disponibile
  renderAll();
});

// --- Toggle pannelli Colori e Layer ---
const mainEl = document.getElementById('main');
const toggleColorsBtn = document.getElementById('toggleColors');
const toggleLayersBtn = document.getElementById('toggleLayers');

toggleColorsBtn.addEventListener('click', () => {
  const hidden = mainEl.classList.toggle('no-colors');
  toggleColorsBtn.classList.toggle('active', !hidden);
  fitStage();
  renderAll();
});
toggleLayersBtn.addEventListener('click', () => {
  const hidden = mainEl.classList.toggle('no-layers');
  toggleLayersBtn.classList.toggle('active', !hidden);
  fitStage();
  renderAll();
});

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
  renderAll();
  // ripristina l'ultimo progetto aperto (se presente)
  loadLastProject().catch((e) => console.error('Ripristino progetto fallito:', e));
}
init();
