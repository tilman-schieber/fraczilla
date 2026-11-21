// Minimal WebM (Matroska) muxer for a single video track from WebCodecs chunks.
// Enough for <video> playback and downloads; no seeking index (Cues).

const enc = new TextEncoder();

function vint(n) { // 8-byte EBML size
  const b = new Uint8Array(8);
  b[0] = 0x01;
  for (let i = 7; i >= 1; i--) { b[i] = n % 256; n = Math.floor(n / 256); }
  return b;
}
function idBytes(id) {
  const out = [];
  while (id > 0) { out.unshift(id & 0xff); id = Math.floor(id / 256); }
  return new Uint8Array(out);
}
function uint(n) {
  const out = [];
  do { out.unshift(n % 256); n = Math.floor(n / 256); } while (n > 0);
  return new Uint8Array(out);
}
function float64(x) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, x);
  return b;
}
const size = (parts) => parts.reduce((s, p) => s + p.byteLength, 0);
// element -> list of Uint8Array parts (avoids copying big payloads)
function el(id, body) {
  const parts = body instanceof Uint8Array ? [body] : body.flat();
  return [idBytes(id), vint(size(parts)), ...parts];
}

/**
 * chunks: [{ data: Uint8Array, ts: microseconds, key: bool }] in decode order
 * codecId: 'V_VP9' | 'V_VP8' | 'V_AV1'
 */
export function muxWebM(chunks, width, height, codecId, durationMs) {
  const header = el(0x1a45dfa3, [
    el(0x4286, uint(1)), el(0x42f7, uint(1)), el(0x42f2, uint(4)), el(0x42f3, uint(8)),
    el(0x4282, enc.encode('webm')), el(0x4287, uint(4)), el(0x4285, uint(2)),
  ]);
  const info = el(0x1549a966, [
    el(0x2ad7b1, uint(1000000)), // timestamps in ms
    el(0x4d80, enc.encode('Fraczilla')), el(0x5741, enc.encode('Fraczilla')),
    el(0x4489, float64(durationMs)),
  ]);
  const tracks = el(0x1654ae6b, [
    el(0xae, [
      el(0xd7, uint(1)), el(0x73c5, uint(1)), el(0x83, uint(1)),
      el(0x86, enc.encode(codecId)),
      el(0xe0, [el(0xb0, uint(width)), el(0xba, uint(height))]),
    ]),
  ]);
  // a new cluster at every keyframe (and at least every 30 s, since block offsets are int16 ms)
  const clusters = [];
  let cur = null, base = 0;
  for (const c of chunks) {
    const ms = Math.round(c.ts / 1000);
    if (!cur || c.key || ms - base > 30000) {
      if (cur) clusters.push(el(0x1f43b675, cur));
      base = ms;
      cur = [el(0xe7, uint(base))];
    }
    const hdr = new Uint8Array(4);
    hdr[0] = 0x81; // track 1
    new DataView(hdr.buffer).setInt16(1, ms - base);
    hdr[3] = c.key ? 0x80 : 0x00;
    cur.push(el(0xa3, [hdr, c.data]));
  }
  if (cur) clusters.push(el(0x1f43b675, cur));
  const segment = el(0x18538067, [info, tracks, ...clusters]);
  return new Blob([...header, ...segment], { type: 'video/webm' });
}
