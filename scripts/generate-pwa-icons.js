/**
 * Generates all required PWA PNG icons from public/icons/logo.png.
 * Run once: node scripts/generate-pwa-icons.js
 * Requires: npm install --save-dev sharp
 */
const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');

const SRC  = path.join(__dirname, '../public/icons/logo.png');
const DEST = path.join(__dirname, '../public/icons');

const SIZES = [72, 96, 128, 144, 152, 192, 384, 512];

// Resize with contain (no distortion) on a white background
function resizeTo(size) {
  return sharp(SRC)
    .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .png();
}

async function main() {
  fs.mkdirSync(DEST, { recursive: true });

  for (const size of SIZES) {
    const out = path.join(DEST, `icon-${size}.png`);
    await resizeTo(size).toFile(out);
    console.log(`✓  icon-${size}.png`);
  }

  // Maskable icon — logo at ~80% with white padding so it sits within the safe zone
  const MASK_SIZE   = 512;
  const LOGO_SIZE   = Math.round(MASK_SIZE * 0.8); // 410px
  const logoBuffer  = await sharp(SRC)
    .resize(LOGO_SIZE, LOGO_SIZE, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .png()
    .toBuffer();
  const offset = Math.round((MASK_SIZE - LOGO_SIZE) / 2);
  const maskable = path.join(DEST, 'icon-512-maskable.png');
  await sharp({ create: { width: MASK_SIZE, height: MASK_SIZE, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite([{ input: logoBuffer, top: offset, left: offset }])
    .png()
    .toFile(maskable);
  console.log('✓  icon-512-maskable.png');

  // Apple touch icon (180x180)
  const apple = path.join(DEST, 'apple-touch-icon.png');
  await resizeTo(180).toFile(apple);
  console.log('✓  apple-touch-icon.png');

  console.log('\nAll icons generated in public/icons/');
}

main().catch(err => { console.error(err); process.exit(1); });
