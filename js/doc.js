// Modello dati: un Documento contiene Frame; ogni Frame contiene Layer.
// Ogni Layer è un canvas offscreen indipendente.

let layerIdSeq = 1;

export function createLayer(width, height, name) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return {
    id: layerIdSeq++,
    name: name || `Layer ${layerIdSeq - 1}`,
    visible: true,
    opacity: 1,
    canvas,
    ctx,
  };
}

export function createFrame(width, height) {
  return {
    layers: [createLayer(width, height, 'Layer 1')],
    activeLayer: 0,
  };
}

export class Doc {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.frames = [createFrame(width, height)];
    this.activeFrame = 0;
  }

  get frame() { return this.frames[this.activeFrame]; }
  get layer() { return this.frame.layers[this.frame.activeLayer]; }

  addLayer() {
    const l = createLayer(this.width, this.height);
    this.frame.layers.push(l);
    this.frame.activeLayer = this.frame.layers.length - 1;
    return l;
  }

  removeLayer(index) {
    if (this.frame.layers.length <= 1) return false;
    this.frame.layers.splice(index, 1);
    this.frame.activeLayer = Math.min(this.frame.activeLayer, this.frame.layers.length - 1);
    return true;
  }

  addFrame() {
    const f = createFrame(this.width, this.height);
    this.frames.splice(this.activeFrame + 1, 0, f);
    this.activeFrame++;
    return f;
  }

  duplicateFrame() {
    const src = this.frame;
    const layers = src.layers.map((l) => {
      const nl = createLayer(this.width, this.height, l.name);
      nl.visible = l.visible;
      nl.opacity = l.opacity;
      nl.ctx.drawImage(l.canvas, 0, 0);
      return nl;
    });
    const f = { layers, activeLayer: src.activeLayer };
    this.frames.splice(this.activeFrame + 1, 0, f);
    this.activeFrame++;
    return f;
  }

  removeFrame(index) {
    if (this.frames.length <= 1) return false;
    this.frames.splice(index, 1);
    this.activeFrame = Math.min(this.activeFrame, this.frames.length - 1);
    return true;
  }

  // Compone tutti i layer visibili di un frame su un canvas di destinazione
  static composite(frame, targetCtx) {
    for (const layer of frame.layers) {
      if (!layer.visible) continue;
      targetCtx.globalAlpha = layer.opacity;
      targetCtx.drawImage(layer.canvas, 0, 0);
    }
    targetCtx.globalAlpha = 1;
  }
}
