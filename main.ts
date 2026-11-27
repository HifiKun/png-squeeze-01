// png-squeeze: squeeze 1280x720 RGBA screenshots into the smallest lossless PNG.
//
// Strategy (all in-process, no network, deterministic, fixed work only):
//   1. Decode the stored RGBA PNG.
//   2. Analyse the pixels: opaque? grey? how many distinct colours?
//   3. Enumerate lossless forms: palette (<=256 colours, count and luminance
//      order), grey / grey+alpha, RGB / RGBA, and a tRNS-keyed form when the
//      image has a single fully-transparent colour and is otherwise opaque.
//   4. For each form, try filter plans: fixed filters, per-row minimum-sum,
//      per-row fewest-distinct-byte-pairs, and per-row brute force (each of the
//      five filters weighed by a small zlib run over the preceding 32 KiB).
//   5. Screen every plan with zlib level 6, keep the best two, re-compress
//      them with zlib level 9 (plain, and block-split at 128/256/512 KiB so
//      each block gets fresh Huffman tables) and keep the smallest file
//      overall (IDAT bytes + PLTE/tRNS chunk overhead).
//
// Node 22 only, built-ins only. Runs the whole set of 8 inside one 60 s wall
// budget: the work per image is a fixed number of zlib passes, never cut off
// by the clock, so two executions write identical bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, createDeflate, deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- CRC-32 ---

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function ihdr(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8; // bit depth
  d[9] = colourType;
  d[10] = 0; // compression
  d[11] = 0; // filter method
  d[12] = 0; // no interlace
  return d;
}

function pngOf(width, height, colourType, plte, trns, idat) {
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr(width, height, colourType))];
  if (plte) parts.push(chunk('PLTE', plte));
  if (trns) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', idat));
  parts.push(chunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ------------------------------------------------------------ PNG decode ---

/** Decode a bit-depth-8 PNG into RGBA bytes (handles colour types 0, 2, 3, 4, 6). */
function decodePng(bytes) {
  if (bytes.length < 8 || bytes[0] !== 137 || bytes[1] !== 80) throw new Error('not a PNG');
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = 6;
  let bitDepth = 8;
  let plte = null;
  let trns = null;
  const idat = [];
  while (at + 8 <= bytes.length) {
    const len = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      const v = new DataView(data.buffer, data.byteOffset, data.length);
      width = v.getUint32(0);
      height = v.getUint32(4);
      bitDepth = data[8];
      colourType = data[9];
      if (bitDepth !== 8) throw new Error('bit depth is not 8');
      if (data[12] !== 0) throw new Error('interlaced');
    } else if (type === 'PLTE') {
      plte = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType];
  if (ch === undefined) throw new Error('unsupported colour type ' + colourType);
  const total = idat.reduce((a, d) => a + d.length, 0);
  const z = new Uint8Array(total);
  let off = 0;
  for (const d of idat) {
    z.set(d, off);
    off += d.length;
  }
  const raw = inflateSync(z);
  const stride = width * ch;
  if (raw.length !== height * (stride + 1)) throw new Error('IDAT length mismatch');
  const rgba = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const rowAt = y * (stride + 1);
    const filter = raw[rowAt];
    const cur = raw.subarray(rowAt + 1, rowAt + 1 + stride);
    const out = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[x - ch] : 0;
      const b = prev[x];
      let pred;
      if (filter === 0) pred = 0;
      else if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const ul = x >= ch ? prev[x - ch] : 0;
        const p = a + b - ul;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - ul);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : ul;
      } else throw new Error('unknown filter ' + filter);
      out[x] = (cur[x] + pred) & 0xff;
    }
    prev.set(out);
    // Expand to RGBA.
    const dst = y * width * 4;
    if (colourType === 6) {
      rgba.set(out, dst);
    } else if (colourType === 2) {
      for (let x = 0; x < width; x++) {
        rgba[dst + x * 4] = out[x * 3];
        rgba[dst + x * 4 + 1] = out[x * 3 + 1];
        rgba[dst + x * 4 + 2] = out[x * 3 + 2];
        rgba[dst + x * 4 + 3] = 255;
      }
    } else if (colourType === 0) {
      for (let x = 0; x < width; x++) {
        const g = out[x];
        rgba[dst + x * 4] = g;
        rgba[dst + x * 4 + 1] = g;
        rgba[dst + x * 4 + 2] = g;
        rgba[dst + x * 4 + 3] = 255;
      }
    } else if (colourType === 4) {
      for (let x = 0; x < width; x++) {
        const g = out[x * 2];
        rgba[dst + x * 4] = g;
        rgba[dst + x * 4 + 1] = g;
        rgba[dst + x * 4 + 2] = g;
        rgba[dst + x * 4 + 3] = out[x * 2 + 1];
      }
    } else {
      // Palette: honour tRNS alphas (entries past it are opaque).
      for (let x = 0; x < width; x++) {
        const i = out[x];
        rgba[dst + x * 4] = plte[i * 3];
        rgba[dst + x * 4 + 1] = plte[i * 3 + 1];
        rgba[dst + x * 4 + 2] = plte[i * 3 + 2];
        rgba[dst + x * 4 + 3] = trns && i < trns.length ? trns[i] : 255;
      }
    }
  }
  return { rgba, width, height };
}

// -------------------------------------------------------------- analysis ---

/** Opaque? grey (R=G=B everywhere)? distinct colours (null when over 256)? */
function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = (rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  let colours = null;
  if (!many) {
    colours = [...counts.entries()].map(([word, count]) => ({
      r: (word >>> 24) & 0xff,
      g: (word >>> 16) & 0xff,
      b: (word >>> 8) & 0xff,
      a: word & 0xff,
      word,
      count,
    }));
  }
  return { opaque, grey, colours };
}

/**
 * The single fully-transparent value the image may key by tRNS instead of an
 * alpha channel: every non-opaque pixel is that exact value at alpha 0, and
 * no opaque pixel shares the value. Null when there is none.
 */
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

// --------------------------------------------------------------- filters ---

/** One PNG filter row: `cur` filtered against `prev`, bytes per pixel `bpp`. */
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
    return;
  }
  for (let x = 0; x < n; x++) {
    const a = x >= bpp ? cur[x - bpp] : 0;
    const b = prev ? prev[x] : 0;
    let pred;
    if (type === 1) pred = a;
    else if (type === 2) pred = b;
    else if (type === 3) pred = (a + b) >> 1;
    else {
      const ul = x >= bpp && prev ? prev[x - bpp] : 0;
      const p = a + b - ul;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - ul);
      pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : ul;
    }
    out[x] = (cur[x] - pred) & 0xff;
  }
}

/** Sum of absolute values of signed bytes (PNG spec section 12.8 heuristic). */
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

/** How many distinct neighbouring byte pairs a filtered row holds. */
function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

/**
 * Filter `samples` (height rows of width*bpp) by `choice`: a fixed filter
 * (0-4), or a per-row plan: 'minsum', 'pairs', or 'brute' (each filter
 * weighed by a small zlib run over the preceding 32 KiB of filtered output).
 * Writes into `raw` (height rows, each a filter byte + stride bytes).
 */
function filtered(samples, width, height, bpp, choice, raw) {
  const stride = width * bpp;
  const trial = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trial.push(row);
  }
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else {
        cost = deflateSync(
          trial[t],
          before.length === 0
            ? { level: BRUTE_LEVEL, memLevel: 9 }
            : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before },
        ).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// ----------------------------------------------------------------- forms ---

/** Palette form: entries (transparent first, then by `order`), PLTE/tRNS/indices. */
function paletteForm(rgba, colours, order) {
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const ta = x.a === 255 ? 1 : 0;
    const tb = y.a === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    indices[i] = index.get((rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3]);
  }
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

/** Channel samples of RGBA in colour type `ct` (0, 2, 4 or 6). */
function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

/** All lossless forms of an image, each with the filter plans to try. */
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance']) {
      forms.push({ ...paletteForm(rgba, colours, order), filters: [0, 'minsum', 'brute'] });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({
    colourType: ct,
    bpp,
    samples: samplesOf(rgba, ct),
    plte: null,
    trns,
    filters: [0, 4, 'minsum', 'pairs'],
  });
  return forms;
}

const chunkOverhead = (form) =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

const SCREEN = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };

/**
 * Deflate `data` as one zlib stream, ending the deflate block every
 * `blockBytes` of input (Z_BLOCK flush) so each block gets fresh Huffman
 * tables. A block boundary never breaks LZ77 matching (the window persists),
 * it only restarts the tables, which pays on these heterogeneous screenshots.
 * Returns the stream's bytes. Deterministic: same input, same chunking.
 */
function deflateBlocked(data, blockBytes, level, strategy) {
  return new Promise((resolve, reject) => {
    const d = createDeflate({ level, memLevel: 9, strategy });
    const chunks = [];
    d.on('data', (c) => chunks.push(c));
    d.on('error', reject);
    d.on('end', () => resolve(Buffer.concat(chunks)));
    (async () => {
      try {
        for (let i = 0; i < data.length; i += blockBytes) {
          const last = i + blockBytes >= data.length;
          await new Promise((res, rej) => {
            d.write(data.subarray(i, Math.min(data.length, i + blockBytes)), (err) => {
              if (err) return rej(err);
              if (last) return res();
              d.flush(constants.Z_BLOCK, (e2) => (e2 ? rej(e2) : res()));
            });
          });
        }
        d.end();
      } catch (e) {
        reject(e);
      }
    })();
  });
}

/**
 * Squeeze one image: screen every form/filter plan at zlib level 6, then
 * re-compress the best two at level 9 in several shapes (plain, and block
 * split at 128 KiB / 256 KiB with the filtered strategy, 512 KiB with the
 * default strategy) and return the smallest complete PNG.
 */
async function squeeze(rgba, width, height) {
  const forms = formsOf(rgba);
  const candidates = [];
  for (const form of forms) {
    const size = height * (width * form.bpp + 1);
    const overhead = chunkOverhead(form);
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice, new Uint8Array(size));
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + overhead;
      candidates.push({ form, choice, data, bytes });
    }
  }
  // Best two by screened size, cheapest first; re-compress each at level 9.
  // Tie-breaks are fixed ranks, never locale-dependent, so two executions
  // always pick the same winner.
  const choiceRank = (c) => (typeof c === 'number' ? c : { minsum: 10, pairs: 11, brute: 12 }[c]);
  candidates.sort(
    (a, b) =>
      a.bytes - b.bytes ||
      a.form.colourType - b.form.colourType ||
      choiceRank(a.choice) - choiceRank(b.choice),
  );
  const finalists = candidates.slice(0, 2);
  for (let i = 2; i < candidates.length; i++) candidates[i].data = null; // let GC reclaim the losers
  let best = null;
  for (const c of finalists) {
    const overhead = chunkOverhead(c.form);
    const variants = [];
    variants.push(deflateSync(c.data, { level: 9, memLevel: 9, strategy: constants.Z_FILTERED }));
    variants.push(await deflateBlocked(c.data, 131072, 9, constants.Z_FILTERED));
    variants.push(await deflateBlocked(c.data, 262144, 9, constants.Z_FILTERED));
    variants.push(await deflateBlocked(c.data, 524288, 9, constants.Z_DEFAULT_STRATEGY));
    for (const zlib of variants) {
      const bytes = zlib.length + overhead;
      if (best === null || bytes < best.bytes) {
        best = { form: c.form, zlib: new Uint8Array(zlib.buffer, zlib.byteOffset, zlib.length), bytes };
      }
    }
  }
  return pngOf(width, height, best.form.colourType, best.form.plte, best.form.trns, best.zlib);
}

// ------------------------------------------------------------------ main ---

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

if (process.env.MAKEFUN_RUN !== '0') {
  (async () => {
    for (const id of readdirSync(I).sort()) {
      const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
      mkdirSync(join(O, id), { recursive: true });
      writeFileSync(join(O, id, 'image.png'), await squeeze(image.rgba, image.width, image.height));
    }
  })();
}

export { decodePng, squeeze, formsOf, filtered, chunkOverhead, SCREEN };
