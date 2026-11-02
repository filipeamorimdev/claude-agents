// The app icon (Home Screen, installed app, notifications), drawn here so the repo needs no image files:
// a white person (head and shoulders, like the UI's agent icon) on the UI's cobalt. Full-bleed, so phones
// can round or mask the corners themselves. Encoded as PNG with node:zlib.

import zlib from "node:zlib";

const BG = [0x24, 0x50, 0xd3], FG = [0xff, 0xff, 0xff];

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])));
  return Buffer.concat([len, Buffer.from(type), data, crc]);
}

/** A size×size RGB PNG. */
export function iconPng(size) {
  // Coverage of the white shape at (x, y) in 0..1 units: a head and the top of a body (shoulders).
  const inside = (x, y) => {
    const head = Math.hypot(x - 0.5, y - 0.39) < 0.135;
    const body = y < 0.76 && ((x - 0.5) / 0.25) ** 2 + ((y - 0.79) / 0.22) ** 2 < 1;
    return head || body;
  };
  const S = 4; // samples per axis, for smooth edges
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 3); // filter byte 0, then RGB
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) hits += inside((px + (sx + 0.5) / S) / size, (py + (sy + 0.5) / S) / size);
      const a = hits / (S * S);
      for (let c = 0; c < 3; c++) row[1 + px * 3 + c] = Math.round(BG[c] + (FG[c] - BG[c]) * a);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0)),
  ]);
}
