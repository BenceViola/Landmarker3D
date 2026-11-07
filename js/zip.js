// A small zip writer and reader, so hand-ins need no outside library.
// Same code as the 2D app's. Writing stores files without compression (they
// are small JSON and text files); reading also takes compressed ("deflated")
// files, e.g. a zip a student unpacked and packed again on macOS.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const utf8 = (v) => (typeof v === 'string' ? new TextEncoder().encode(v) : v);

function put(view, fields) {
  for (const [offset, value, size] of fields) {
    if (size === 4) view.setUint32(offset, value, true);
    else view.setUint16(offset, value, true);
  }
}

/** files: [{ name, data: string | Uint8Array }] → zip archive bytes. */
export function zipFiles(files, date = new Date()) {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = utf8(f.name);
    const data = utf8(f.data);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    put(local, [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, dosTime, 2], [12, dosDate, 2],
      [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, name.length, 2], [28, 0, 2]]);
    const cen = new DataView(new ArrayBuffer(46));
    put(cen, [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, dosTime, 2], [14, dosDate, 2],
      [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, name.length, 2], [30, 0, 2], [32, 0, 2],
      [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, offset, 4]]);
    parts.push(new Uint8Array(local.buffer), name, data);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cenSize = central.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  put(end, [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, files.length, 2], [10, files.length, 2],
    [12, cenSize, 4], [16, offset, 4], [20, 0, 2]]);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, b) => n + b.length, 0));
  let p = 0;
  for (const b of all) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser can’t unpack compressed zip files. Update it, or unzip the file and open the .lmk.json files instead.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Zip bytes → [{ name, data: Uint8Array }]. Skips folders and macOS metadata. */
export async function unzipFiles(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('This is not a zip file, or it is damaged.');
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  const out = [];
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('The zip file is damaged.');
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const nlen = v.getUint16(p + 28, true);
    const xlen = v.getUint16(p + 30, true);
    const clen = v.getUint16(p + 32, true);
    const loc = v.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/') || /(^|\/)(__MACOSX\/|\._)/.test(name)) continue;
    if (flags & 1) throw new Error(`“${name}” in the zip is password-protected.`);
    const start = loc + 30 + v.getUint16(loc + 26, true) + v.getUint16(loc + 28, true);
    const raw = bytes.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflateRaw(raw);
    else throw new Error(`“${name}” in the zip uses a compression this app can’t read.`);
    out.push({ name, data });
  }
  return out;
}
