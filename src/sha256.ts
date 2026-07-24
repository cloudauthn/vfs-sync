import type { Hash } from './types.js';

/**
 * Incremental SHA-256.
 *
 * `crypto.subtle.digest()` is one-shot: it wants the whole message in memory,
 * which is the one thing a streaming engine cannot afford. This is the same
 * digest, fed a chunk at a time, so a blob's content address is identical
 * whichever path produced it — {@link sha256} stays the fast path for small
 * inputs, this takes over once a file is too big to hold.
 */

// FIPS 180-4 round constants: the first 32 bits of the fractional parts of the
// cube roots of the first 64 primes.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

// Square roots of the first 8 primes, same treatment.
const INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const BLOCK = 64;

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/**
 * Feed it with {@link update}, read the digest with {@link digest}. An instance
 * is single-use: once digested it cannot be updated again.
 */
export class Sha256 {
  private readonly state = INIT.slice();
  private readonly block = new Uint8Array(BLOCK);
  private readonly view = new DataView(this.block.buffer);
  private readonly words = new Uint32Array(64);
  /** Bytes sitting in `block` waiting for a full 64-byte round. */
  private buffered = 0;
  private total = 0;
  private hex: Hash | null = null;

  update(chunk: Uint8Array): this {
    if (this.hex) throw new Error('Sha256: update() after digest()');
    this.total += chunk.byteLength;

    let offset = 0;
    if (this.buffered > 0) {
      const take = Math.min(BLOCK - this.buffered, chunk.byteLength);
      this.block.set(chunk.subarray(0, take), this.buffered);
      this.buffered += take;
      offset = take;
      if (this.buffered === BLOCK) {
        this.compress(this.view, 0);
        this.buffered = 0;
      }
    }

    // Whole blocks are read straight out of the caller's chunk, no copying.
    if (offset + BLOCK <= chunk.byteLength) {
      const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      for (; offset + BLOCK <= chunk.byteLength; offset += BLOCK) this.compress(view, offset);
    }

    if (offset < chunk.byteLength) {
      this.block.set(chunk.subarray(offset), 0);
      this.buffered = chunk.byteLength - offset;
    }
    return this;
  }

  /** Hex digest. Idempotent; further {@link update} calls throw. */
  digest(): Hash {
    if (this.hex) return this.hex;

    // Padding: a 1 bit, zeroes, then the message length in bits as a 64-bit
    // big-endian integer that has to land in the last 8 bytes of a block.
    const bits = this.total * 8;
    this.block[this.buffered++] = 0x80;
    if (this.buffered > BLOCK - 8) {
      this.block.fill(0, this.buffered);
      this.compress(this.view, 0);
      this.buffered = 0;
    }
    this.block.fill(0, this.buffered, BLOCK - 8);
    // `total` is a JS number, so the high word comes from a division rather
    // than a shift — files beyond 2^53 bytes are not a thing.
    this.view.setUint32(BLOCK - 8, Math.floor(bits / 0x100000000), false);
    this.view.setUint32(BLOCK - 4, bits >>> 0, false);
    this.compress(this.view, 0);

    let out = '';
    for (let i = 0; i < 8; i++) {
      out += ((this.state[i] as number) >>> 0).toString(16).padStart(8, '0');
    }
    this.hex = out;
    return out;
  }

  private compress(view: DataView, offset: number): void {
    const w = this.words;
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15] as number;
      const y = w[i - 2] as number;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0;
    }

    const s = this.state;
    let a = s[0] as number;
    let b = s[1] as number;
    let c = s[2] as number;
    let d = s[3] as number;
    let e = s[4] as number;
    let f = s[5] as number;
    let g = s[6] as number;
    let h = s[7] as number;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + (K[i] as number) + (w[i] as number)) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }

    s[0] = (a + (s[0] as number)) | 0;
    s[1] = (b + (s[1] as number)) | 0;
    s[2] = (c + (s[2] as number)) | 0;
    s[3] = (d + (s[3] as number)) | 0;
    s[4] = (e + (s[4] as number)) | 0;
    s[5] = (f + (s[5] as number)) | 0;
    s[6] = (g + (s[6] as number)) | 0;
    s[7] = (h + (s[7] as number)) | 0;
  }
}
