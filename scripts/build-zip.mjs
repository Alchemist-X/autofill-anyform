#!/usr/bin/env node
/**
 * AutoFill AnyForm — dependency-free extension packager.
 *
 * Produces dist/autofill-anyform.zip containing exactly the files Chrome needs
 * to load the unpacked extension. Uses zlib (Node builtin) for DEFLATE; no
 * external packages. Run with: npm run build:zip
 */

import {
  readFileSync, writeFileSync, mkdirSync, statSync, existsSync, readdirSync,
} from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = join(ROOT, 'dist');
const OUT_ZIP = join(OUT_DIR, 'autofill-anyform.zip');

// Directories/files to exclude from the package.
const EXCLUDE_DIRS = new Set(['.git', 'node_modules', 'eval', 'dist', 'scripts', '.github']);
const EXCLUDE_FILES = new Set(['.DS_Store', '.gitignore', 'package-lock.json']);
const EXCLUDE_EXT = new Set(['.zip']);

/** Recursively collect packable files relative to ROOT. */
function collect(dir, base = ROOT, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      collect(join(dir, entry.name), base, out);
    } else {
      if (EXCLUDE_FILES.has(entry.name)) continue;
      const ext = entry.name.slice(entry.name.lastIndexOf('.'));
      if (EXCLUDE_EXT.has(ext)) continue;
      // Skip test source files; keep the sample form (web-accessible resource).
      if (/\.test\.(mjs|js)$/.test(entry.name)) continue;
      out.push(relative(base, join(dir, entry.name)));
    }
  }
  return out;
}

// ── Minimal ZIP writer (store + deflate), CRC-32, no deps ─────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const d = date;
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const day = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time: time & 0xffff, day: day & 0xffff };
}

function buildZip(files) {
  const localParts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const { time, day } = dosDateTime(now);

  for (const relPath of files) {
    const nameInZip = relPath.split(sep).join('/');
    const nameBuf = Buffer.from(nameInZip, 'utf8');
    const content = readFileSync(join(ROOT, relPath));
    const crc = crc32(content);
    const compressed = deflateRawSync(content);
    const useDeflate = compressed.length < content.length;
    const data = useDeflate ? compressed : content;
    const method = useDeflate ? 8 : 0;

    // Local file header.
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // UTF-8 flag
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(day, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(content.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    localParts.push(lh, nameBuf, data);

    // Central directory header.
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0x0800, 8); // UTF-8 flag
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(day, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(content.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); // extra len
    ch.writeUInt16LE(0, 32); // comment len
    ch.writeUInt16LE(0, 34); // disk number
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const localBuf = Buffer.concat(localParts);

  // End of central directory record.
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  try {
    if (!existsSync(join(ROOT, 'manifest.json'))) {
      throw new Error('manifest.json not found at repo root');
    }
    const files = collect(ROOT).sort();
    if (!files.includes('manifest.json')) {
      throw new Error('manifest.json missing from packed file set');
    }
    const zip = buildZip(files);
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(OUT_ZIP, zip);
    const kb = (statSync(OUT_ZIP).size / 1024).toFixed(1);
    console.log(`Built ${relative(ROOT, OUT_ZIP)} (${files.length} files, ${kb} KB)`);
  } catch (err) {
    console.error('build:zip failed:', err.message);
    process.exit(1);
  }
}

main();
