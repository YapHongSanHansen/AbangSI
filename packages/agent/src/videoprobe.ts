/** Reads an MP4/MOV duration from its `mvhd` box (no ffprobe needed). Downloads at most MAX_BYTES. */
const MAX_BYTES = 120 * 1024 * 1024;

export function mvhdSeconds(buf: Uint8Array): number | null {
  for (let i = 4; i + 32 < buf.length; i++) {
    if (buf[i] === 0x6d && buf[i + 1] === 0x76 && buf[i + 2] === 0x68 && buf[i + 3] === 0x64) { // "mvhd"
      const v = new DataView(buf.buffer, buf.byteOffset + i + 4);
      const version = v.getUint8(0);
      if (version === 1) {
        const timescale = v.getUint32(20);
        const duration = Number(v.getBigUint64(24));
        return timescale ? duration / timescale : null;
      }
      const timescale = v.getUint32(12);
      const duration = v.getUint32(16);
      return timescale ? duration / timescale : null;
    }
  }
  return null;
}

export async function videoSeconds(url: string): Promise<number> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok || !res.body) throw new Error(`could not download the attached video (${res.status})`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) throw new Error("attached video is larger than 120 MB");
  const buf = new Uint8Array(await res.arrayBuffer());
  const s = mvhdSeconds(buf);
  if (!s || !Number.isFinite(s)) throw new Error("could not read the attached video's length (MP4/MOV expected)");
  return s;
}