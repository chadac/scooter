/**
 * Small generated PNGs for the fake agent's `~media` directive, so the inline-media path
 * (tool result images, agent message images, the gallery) can be driven without a model.
 * Each image is a diagonal two-colour stripe pattern with no external dependencies.
 */

import { deflateSync } from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

type Rgb = [number, number, number];

/** A width×height RGB PNG of diagonal stripes in two colours. */
export function stripedPng(width: number, height: number, a: Rgb, b: Rgb, stripe = 16): Buffer {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, bl] = Math.floor((x + y) / stripe) % 2 === 0 ? a : b;
      const o = y * row + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = bl;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The three images `~media` sends, as base64. */
export function fakeMediaImages(): { toolA: string; toolB: string; inline: string; tiny: string } {
  return {
    toolA: stripedPng(640, 400, [37, 99, 235], [147, 197, 253]).toString("base64"),
    toolB: stripedPng(400, 640, [22, 163, 74], [187, 247, 208], 24).toString("base64"),
    inline: stripedPng(800, 450, [234, 88, 12], [254, 215, 170], 32).toString("base64"),
    tiny: stripedPng(48, 48, [147, 51, 234], [233, 213, 255], 6).toString("base64"),
  };
}
