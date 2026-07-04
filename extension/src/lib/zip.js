// Minimal store-only ZIP writer (no compression, no dependencies) — enough to bundle
// PDFs into a single download and sidestep the browser's multi-download block.
const CRC = (() => {
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
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const u16 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255]);
const u32 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
function concat(arrs) {
  let len = 0; for (const a of arrs) len += a.length;
  const out = new Uint8Array(len); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// entries: [{ name, blob }]  ->  Blob (application/zip)
export async function makeZip(entries) {
  const enc = new TextEncoder();
  const files = [];
  for (const e of entries) {
    const data = new Uint8Array(await e.blob.arrayBuffer());
    files.push({ name: enc.encode(e.name), data, crc: crc32(data) });
  }
  const locals = [], central = [];
  let offset = 0;
  for (const f of files) {
    const local = concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(f.crc), u32(f.data.length), u32(f.data.length),
      u16(f.name.length), u16(0), f.name, f.data,
    ]);
    central.push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(f.crc), u32(f.data.length), u32(f.data.length),
      u16(f.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), f.name,
    ]));
    locals.push(local);
    offset += local.length;
  }
  const cd = concat(central);
  const end = concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(cd.length), u32(offset), u16(0),
  ]);
  return new Blob([...locals, cd, end], { type: 'application/zip' });
}
