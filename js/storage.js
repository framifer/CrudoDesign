// Salvataggio e caricamento progetti.
// Persistenza locale offline via IndexedDB + export/import su file .crudo (JSON).
import { createLayer } from './doc.js';

const DB_NAME = 'crudodesign';
const STORE = 'projects';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// --- Serializzazione documento -> oggetto JSON semplice ---
export function serializeDoc(doc) {
  return {
    version: 1,
    width: doc.width,
    height: doc.height,
    activeFrame: doc.activeFrame,
    frames: doc.frames.map((frame) => ({
      activeLayer: frame.activeLayer,
      layers: frame.layers.map((l) => ({
        name: l.name,
        visible: l.visible,
        opacity: l.opacity,
        // il contenuto del layer come PNG (base64)
        data: l.canvas.toDataURL('image/png'),
      })),
    })),
  };
}

// Ricostruisce i frame/layer in un documento esistente (immagini caricate async)
export function deserializeInto(doc, data) {
  return new Promise((resolve) => {
    doc.width = data.width;
    doc.height = data.height;

    const pending = [];
    const frames = data.frames.map((f) => {
      const layers = f.layers.map((ld) => {
        const layer = createLayer(data.width, data.height, ld.name);
        layer.visible = ld.visible !== false;
        layer.opacity = typeof ld.opacity === 'number' ? ld.opacity : 1;
        if (ld.data) {
          const p = new Promise((res) => {
            const img = new Image();
            img.onload = () => {
              layer.ctx.drawImage(img, 0, 0);
              res();
            };
            img.onerror = () => res();
            img.src = ld.data;
          });
          pending.push(p);
        }
        return layer;
      });
      return { layers, activeLayer: f.activeLayer || 0 };
    });

    Promise.all(pending).then(() => {
      doc.frames = frames;
      doc.activeFrame = Math.min(data.activeFrame || 0, frames.length - 1);
      resolve(doc);
    });
  });
}

// --- IndexedDB: salva / carica / elenca / elimina ---
export async function saveProject(id, name, doc) {
  const db = await openDB();
  const record = {
    id,
    name,
    updatedAt: Date.now(),
    doc: serializeDoc(doc),
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadProject(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function listProjects() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      const all = (req.result || []).sort((a, b) => b.updatedAt - a.updatedAt);
      resolve(all.map(({ id, name, updatedAt }) => ({ id, name, updatedAt })));
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteProject(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- Export/import su file .crudo (per backup o trasferimento) ---
export function exportToFile(name, doc) {
  const payload = { name, savedAt: Date.now(), doc: serializeDoc(doc) };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(name || 'progetto').replace(/[^\w\-]+/g, '_')}.crudo`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function importFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        resolve(parsed);
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

export function newId() {
  return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
