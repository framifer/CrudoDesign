// Riempimento (secchiello) con algoritmo scanline su ImageData
import { hexToRgb } from './color.js';

export function floodFill(ctx, startX, startY, fillHex, tolerance = 20) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  startX = Math.floor(startX);
  startY = Math.floor(startY);
  if (startX < 0 || startY < 0 || startX >= w || startY >= h) return;

  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;

  const idx = (x, y) => (y * w + x) * 4;
  const startIdx = idx(startX, startY);
  const target = {
    r: data[startIdx], g: data[startIdx + 1],
    b: data[startIdx + 2], a: data[startIdx + 3],
  };

  const fill = hexToRgb(fillHex);
  const fillColor = { r: fill.r, g: fill.g, b: fill.b, a: 255 };

  // Se il colore di destinazione è già uguale, non fare nulla
  if (
    Math.abs(target.r - fillColor.r) <= tolerance &&
    Math.abs(target.g - fillColor.g) <= tolerance &&
    Math.abs(target.b - fillColor.b) <= tolerance &&
    Math.abs(target.a - fillColor.a) <= tolerance
  ) return;

  const matches = (i) =>
    Math.abs(data[i] - target.r) <= tolerance &&
    Math.abs(data[i + 1] - target.g) <= tolerance &&
    Math.abs(data[i + 2] - target.b) <= tolerance &&
    Math.abs(data[i + 3] - target.a) <= tolerance;

  const setPixel = (i) => {
    data[i] = fillColor.r;
    data[i + 1] = fillColor.g;
    data[i + 2] = fillColor.b;
    data[i + 3] = fillColor.a;
  };

  // Scanline flood fill
  const stack = [[startX, startY]];
  while (stack.length) {
    const [x, yTop] = stack.pop();
    let y = yTop;
    // scendi finché combacia
    while (y >= 0 && matches(idx(x, y))) y--;
    y++;
    let reachLeft = false;
    let reachRight = false;
    while (y < h && matches(idx(x, y))) {
      setPixel(idx(x, y));
      // controlla sinistra
      if (x > 0) {
        if (matches(idx(x - 1, y))) {
          if (!reachLeft) { stack.push([x - 1, y]); reachLeft = true; }
        } else reachLeft = false;
      }
      // controlla destra
      if (x < w - 1) {
        if (matches(idx(x + 1, y))) {
          if (!reachRight) { stack.push([x + 1, y]); reachRight = true; }
        } else reachRight = false;
      }
      y++;
    }
  }

  ctx.putImageData(img, 0, 0);
}
