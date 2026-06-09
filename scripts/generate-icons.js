// Generates OSHADI app icons (pink heart) as PNGs — no external deps.
// Run once:  node scripts/generate-icons.js
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "public");

// --- tiny PNG encoder (RGBA) ---
const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(size, pixelFn) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // rest 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y, size);
      raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = a;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// --- OSHADI icon: pink gradient bg + white heart ---
function pixel(x, y, size) {
  const u = x / size, v = y / size;
  // diagonal pink gradient
  const r = Math.round(255 - u * 10);
  const g = Math.round(150 - (u + v) * 35);
  const b = Math.round(185 - v * 25);

  // heart test — center the shape, point downward
  const nx = (x / size - 0.5) * 2.5;
  const ny = -((y / size - 0.5) * 2.5) + 0.55;
  const inside = Math.pow(nx * nx + ny * ny - 1, 3) - nx * nx * Math.pow(ny, 3) < 0;

  if (inside) {
    // soft inner glow
    return [255, 255, 255, 255];
  }
  return [r, Math.max(60, g), Math.max(120, b), 255];
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of [192, 512, 180]) {
  const buf = encodePNG(size, pixel);
  const name = size === 180 ? "apple-touch-icon.png" : `icon-${size}.png`;
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log("wrote", name, `(${size}x${size}, ${buf.length} bytes)`);
}
