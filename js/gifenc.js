// Encoder GIF animato minimale, senza dipendenze né web worker.
// Supporta: più frame, palette a 256 colori per frame (quantizzazione
// per canale), delay configurabile e loop infinito.
// Non è ottimizzato come gif.js, ma è autonomo e funziona offline.

// --- Scrittura bit a bit per il flusso LZW ---
class BitWriter {
  constructor() { this.bytes = []; this.cur = 0; this.n = 0; }
  writeBits(value, len) {
    for (let i = 0; i < len; i++) {
      if (value & (1 << i)) this.cur |= (1 << this.n);
      this.n++;
      if (this.n === 8) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; }
    }
  }
  flush() { if (this.n > 0) { this.bytes.push(this.cur); this.cur = 0; this.n = 0; } }
}

// Compressione LZW dei codici dei pixel (indici palette)
function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let dict = new Map();
  const resetDict = () => {
    dict = new Map();
    for (let i = 0; i < clearCode; i++) dict.set(String(i), i);
    return clearCode + 2;
  };
  let next = resetDict();
  const bw = new BitWriter();
  bw.writeBits(clearCode, codeSize);

  let w = String(indices[0]);
  for (let i = 1; i < indices.length; i++) {
    const k = String(indices[i]);
    const wk = w + ',' + k;
    if (dict.has(wk)) {
      w = wk;
    } else {
      bw.writeBits(dict.get(w), codeSize);
      dict.set(wk, next++);
      if (next > (1 << codeSize) && codeSize < 12) codeSize++;
      if (next >= 4096) { bw.writeBits(clearCode, codeSize); next = resetDict(); codeSize = minCodeSize + 1; }
      w = k;
    }
  }
  bw.writeBits(dict.get(w), codeSize);
  bw.writeBits(eoiCode, codeSize);
  bw.flush();
  return bw.bytes;
}

// Quantizza un frame RGBA in indici su una palette a 256 colori (6x7x6 circa).
// Usiamo una palette fissa "web-ish" 6-8-5 per semplicità e velocità.
const LEVELS_R = 6, LEVELS_G = 8, LEVELS_B = 5; // 6*8*5 = 240 colori
function buildPalette() {
  const pal = [];
  for (let r = 0; r < LEVELS_R; r++)
    for (let g = 0; g < LEVELS_G; g++)
      for (let b = 0; b < LEVELS_B; b++)
        pal.push([
          Math.round(r * 255 / (LEVELS_R - 1)),
          Math.round(g * 255 / (LEVELS_G - 1)),
          Math.round(b * 255 / (LEVELS_B - 1)),
        ]);
  while (pal.length < 256) pal.push([0, 0, 0]);
  return pal;
}
const PALETTE = buildPalette();

function colorIndex(r, g, b) {
  const ri = Math.round(r * (LEVELS_R - 1) / 255);
  const gi = Math.round(g * (LEVELS_G - 1) / 255);
  const bi = Math.round(b * (LEVELS_B - 1) / 255);
  return (ri * LEVELS_G + gi) * LEVELS_B + bi;
}

// Scrive un numero a 16 bit little-endian
function u16(arr, v) { arr.push(v & 0xff, (v >> 8) & 0xff); }

// Crea il Blob GIF da una lista di ImageData e un delay (in centesimi di secondo)
export function encodeGIF(frames, width, height, delayCs) {
  const out = [];
  // Header
  'GIF89a'.split('').forEach((c) => out.push(c.charCodeAt(0)));
  // Logical Screen Descriptor
  u16(out, width); u16(out, height);
  out.push(0xF7); // GCT presente, 256 colori
  out.push(0); out.push(0);
  // Global Color Table
  for (let i = 0; i < 256; i++) out.push(PALETTE[i][0], PALETTE[i][1], PALETTE[i][2]);
  // Netscape looping extension (loop infinito)
  out.push(0x21, 0xFF, 0x0B);
  'NETSCAPE2.0'.split('').forEach((c) => out.push(c.charCodeAt(0)));
  out.push(0x03, 0x01); u16(out, 0); out.push(0x00);

  for (const img of frames) {
    // Graphic Control Extension (delay)
    out.push(0x21, 0xF9, 0x04, 0x00);
    u16(out, delayCs);
    out.push(0x00, 0x00);
    // Image Descriptor
    out.push(0x2C);
    u16(out, 0); u16(out, 0); u16(out, width); u16(out, height);
    out.push(0x00);
    // Indici dei pixel
    const data = img.data;
    const indices = new Array(width * height);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      indices[p] = colorIndex(data[i], data[i + 1], data[i + 2]);
    }
    const minCodeSize = 8;
    out.push(minCodeSize);
    const lzw = lzwEncode(indices, minCodeSize);
    // Sotto-blocchi da max 255 byte
    for (let i = 0; i < lzw.length; i += 255) {
      const chunk = lzw.slice(i, i + 255);
      out.push(chunk.length, ...chunk);
    }
    out.push(0x00); // block terminator
  }
  out.push(0x3B); // trailer
  return new Blob([new Uint8Array(out)], { type: 'image/gif' });
}
