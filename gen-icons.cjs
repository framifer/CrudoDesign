// Genera i PNG delle icone dalla SVG pixel art.
// Uso: node gen-icons.js
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const iconsDir = path.join(__dirname, 'icons');
const svg = fs.readFileSync(path.join(iconsDir, 'icon.svg'));

// nitidezza pixel art: nessun antialiasing in scala
const sizes = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'favicon-32.png', size: 32 },
];

async function run() {
  for (const { name, size } of sizes) {
    await sharp(svg, { density: 384 })
      .resize(size, size, { kernel: 'nearest' })
      .png()
      .toFile(path.join(iconsDir, name));
    console.log('creato', name);
  }

  // Icona "maskable": stesso disegno con margine di sicurezza (~20%)
  const maskSize = 512;
  const inner = Math.round(maskSize * 0.72);
  const pad = Math.round((maskSize - inner) / 2);
  const innerBuf = await sharp(svg, { density: 384 })
    .resize(inner, inner, { kernel: 'nearest' })
    .png()
    .toBuffer();
  await sharp({
    create: { width: maskSize, height: maskSize, channels: 4, background: '#2b6cff' },
  })
    .composite([{ input: innerBuf, top: pad, left: pad }])
    .png()
    .toFile(path.join(iconsDir, 'icon-maskable-512.png'));
  console.log('creato icon-maskable-512.png');
}

run().catch((e) => { console.error(e); process.exit(1); });
