import type { DatedSchedule, SeriesDefinition } from '../shared/models';

export function stableStringify(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number') { if (!Number.isFinite(input)) throw new Error('Non-finite JSON number'); return input; }
    if (typeof input !== 'object') throw new Error('Value is not JSON serializable');
    if (seen.has(input)) throw new Error('Circular JSON value');
    seen.add(input);
    const result = Array.isArray(input) ? input.map(v => v === undefined ? null : normalize(v)) : Object.fromEntries(Object.keys(input).sort().filter(k => (input as Record<string, unknown>)[k] !== undefined).map(k => [k, normalize((input as Record<string, unknown>)[k])]));
    seen.delete(input); return result;
  };
  return JSON.stringify(normalize(value));
}

/** Small deterministic SHA-256 for browser/Node parity; identity, not a signature. */
export function stableHash(value: unknown): string {
  const text = typeof value === 'string' ? value : stableStringify(value);
  const bytes: number[] = [];
  for (const char of text) {
    let cp = char.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 128) bytes.push(cp);
    else if (cp < 2048) bytes.push(192 | (cp >> 6), 128 | (cp & 63));
    else if (cp < 65536) bytes.push(224 | (cp >> 12), 128 | ((cp >> 6) & 63), 128 | (cp & 63));
    else bytes.push(240 | (cp >> 18), 128 | ((cp >> 12) & 63), 128 | ((cp >> 6) & 63), 128 | (cp & 63));
  }
  const bits = bytes.length * 8; bytes.push(128);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bits / 0x100000000), low = bits >>> 0;
  for (const n of [high, low]) for (let shift = 24; shift >= 0; shift -= 8) bytes.push((n >>> shift) & 255);
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const rotate = (n: number, r: number) => (n >>> r) | (n << (32 - r));
  for (let start = 0; start < bytes.length; start += 64) {
    const w: number[] = [];
    for (let i = 0; i < 16; i++) w[i] = ((bytes[start + i * 4]! << 24) | (bytes[start + i * 4 + 1]! << 16) | (bytes[start + i * 4 + 2]! << 8) | bytes[start + i * 4 + 3]!) >>> 0;
    for (let i = 16; i < 64; i++) { const a = w[i - 15]!, b = w[i - 2]!; w[i] = (w[i - 16]! + (rotate(a,7) ^ rotate(a,18) ^ (a >>> 3)) + w[i - 7]! + (rotate(b,17) ^ rotate(b,19) ^ (b >>> 10))) >>> 0; }
    let [a,b,c,d,e,f,g,j] = h as [number,number,number,number,number,number,number,number];
    for (let i = 0; i < 64; i++) { const t1 = (j + (rotate(e,6) ^ rotate(e,11) ^ rotate(e,25)) + ((e & f) ^ (~e & g)) + k[i]! + w[i]!) >>> 0; const t2 = ((rotate(a,2) ^ rotate(a,13) ^ rotate(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0; j=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0; }
    [a,b,c,d,e,f,g,j].forEach((v,i) => { h[i] = (h[i]! + v) >>> 0; });
  }
  return h.map(n => n.toString(16).padStart(8, '0')).join('');
}
export function occurrenceKey(seriesId: string, predecessorId?: string): string { return stableHash(['joplin-task-occurrence-v1', seriesId, predecessorId ?? 'root']); }
/** Locale-independent ordering is required for cross-device conflict decisions. */
export function compareIds(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
export function candidateSlotKey(definition: SeriesDefinition, schedule: DatedSchedule): string { return stableHash(['joplin-task-slot-v1', definition.seriesId, definition.revisionId, schedule.date, schedule.kind === 'timed' ? schedule.time : 'allDay', schedule.zone]); }
export function candidateNoteId(occurrenceId: string, creatingOpId: string): string { return stableHash(['joplin-task-note-v1', occurrenceId, creatingOpId]).slice(0, 32); }
