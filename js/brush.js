// Motore dei pennelli: disegna un segmento tra due punti su un contesto 2D.
// Supporta pressione (dal pennino) e diversi tipi di pennello.

import { hexToRgb } from './color.js';

// Interpola punti lungo il segmento per un tratto continuo
function forEachStep(p0, p1, spacing, cb) {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.floor(dist / spacing));
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    cb({
      x: p0.x + dx * t,
      y: p0.y + dy * t,
      pressure: p0.pressure + (p1.pressure - p0.pressure) * t,
    });
  }
}

function effectiveSize(size, pressure, usePressure) {
  if (!usePressure) return size;
  // pressione 0..1 -> scala 0.25..1
  return size * (0.25 + 0.75 * pressure);
}

export function drawSegment(ctx, p0, p1, opts) {
  const { type, size, color, opacity, usePressure } = opts;
  ctx.save();
  ctx.globalAlpha = opacity;

  switch (type) {
    case 'pencil':
      drawStroke(ctx, p0, p1, size * 0.5, color, usePressure, size * 0.15);
      break;
    case 'marker':
      ctx.globalAlpha = opacity * 0.5;
      drawStroke(ctx, p0, p1, size, color, usePressure, size * 0.4, 'square');
      break;
    case 'calligraphy':
      drawCalligraphy(ctx, p0, p1, size, color, usePressure);
      break;
    case 'airbrush':
      drawAirbrush(ctx, p0, p1, size, color, usePressure);
      break;
    case 'oil':
      drawOil(ctx, p0, p1, size, color, usePressure);
      break;
    case 'charcoal':
      drawCharcoal(ctx, p0, p1, size, color, usePressure);
      break;
    case 'round':
    default:
      drawStroke(ctx, p0, p1, size, color, usePressure, size * 0.2);
      break;
  }
  ctx.restore();
}

function drawStroke(ctx, p0, p1, size, color, usePressure, spacing, cap = 'round') {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  forEachStep(p0, p1, Math.max(1, spacing), (p) => {
    const r = effectiveSize(size, p.pressure, usePressure) / 2;
    ctx.beginPath();
    if (cap === 'square') {
      ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
    } else {
      ctx.arc(p.x, p.y, Math.max(0.5, r), 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

function drawCalligraphy(ctx, p0, p1, size, color, usePressure) {
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  const angle = Math.PI / 4; // punta inclinata a 45°
  forEachStep(p0, p1, Math.max(1, size * 0.15), (p) => {
    const len = effectiveSize(size, p.pressure, usePressure);
    const ox = Math.cos(angle) * len / 2;
    const oy = Math.sin(angle) * len / 2;
    ctx.lineWidth = Math.max(1, len * 0.35);
    ctx.beginPath();
    ctx.moveTo(p.x - ox, p.y - oy);
    ctx.lineTo(p.x + ox, p.y + oy);
    ctx.stroke();
  });
}

function drawAirbrush(ctx, p0, p1, size, color, usePressure) {
  const { r, g, b } = hexToRgb(color);
  // Spaziatura fitta per un flusso continuo e più denso
  forEachStep(p0, p1, Math.max(1, size * 0.12), (p) => {
    const radius = effectiveSize(size, p.pressure, usePressure);
    // Molte più particelle -> spruzzo più coprente
    const density = Math.floor(radius * radius * 0.9) + 8;
    for (let i = 0; i < density; i++) {
      // distribuzione concentrata verso il centro (aspetto più naturale)
      const a = Math.random() * Math.PI * 2;
      const rr = Math.pow(Math.random(), 0.5) * radius;
      const x = p.x + Math.cos(a) * rr;
      const y = p.y + Math.sin(a) * rr;
      // opacità maggiore e più forte al centro
      const alpha = 0.12 * (1 - rr / (radius + 0.001)) + 0.04;
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
      const dot = radius > 30 ? 2 : 1;
      ctx.fillRect(x, y, dot, dot);
    }
  });
}

// Variazione casuale di una tinta (per texture di olio e carboncino)
function jitterColor(r, g, b, amount) {
  const j = () => (Math.random() - 0.5) * 2 * amount;
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return { r: clamp(r + j()), g: clamp(g + j()), b: clamp(b + j()) };
}

// Pittura ad olio: più "setole" parallele che lasciano striature visibili
function drawOil(ctx, p0, p1, size, color, usePressure) {
  const { r, g, b } = hexToRgb(color);
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy) || 1;
  // normale al movimento: le setole si distribuiscono perpendicolarmente
  const nx = -dy / len;
  const ny = dx / len;

  const width = effectiveSize(size, (p0.pressure + p1.pressure) / 2, usePressure);
  const bristles = Math.max(4, Math.floor(width / 3));

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i < bristles; i++) {
    const t = bristles === 1 ? 0 : i / (bristles - 1) - 0.5; // -0.5..0.5
    const off = t * width;
    // ogni setola ha un colore leggermente diverso -> striature
    const c = jitterColor(r, g, b, 22);
    ctx.strokeStyle = `rgb(${c.r},${c.g},${c.b})`;
    ctx.lineWidth = Math.max(1, width / bristles * (0.8 + Math.random() * 0.6));
    ctx.beginPath();
    ctx.moveTo(p0.x + nx * off, p0.y + ny * off);
    ctx.lineTo(p1.x + nx * off, p1.y + ny * off);
    ctx.stroke();
  }
}

// Carboncino/gessetto: deposito granuloso e irregolare su "carta ruvida"
function drawCharcoal(ctx, p0, p1, size, color, usePressure) {
  const { r, g, b } = hexToRgb(color);
  forEachStep(p0, p1, Math.max(1, size * 0.2), (p) => {
    const radius = effectiveSize(size, p.pressure, usePressure) / 2;
    // grana: tanti punti sparsi con opacità variabile -> aspetto polveroso
    const grains = Math.floor(radius * radius * 1.2) + 6;
    for (let i = 0; i < grains; i++) {
      const a = Math.random() * Math.PI * 2;
      // bordo sfrangiato: alcuni granelli escono un po' dal raggio
      const rr = Math.random() * radius * (0.7 + Math.random() * 0.5);
      const x = p.x + Math.cos(a) * rr;
      const y = p.y + Math.sin(a) * rr;
      // solo una parte dei granelli viene depositata -> texture ruvida
      if (Math.random() < 0.55) continue;
      const alpha = 0.15 + Math.random() * 0.35;
      const c = jitterColor(r, g, b, 12);
      ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${alpha.toFixed(3)})`;
      ctx.fillRect(x, y, 1, 1);
    }
  });
}
