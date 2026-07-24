import { describe, expect, it } from 'vitest';
import { sha256, sha256Stream } from '../src/hash.js';
import { Sha256 } from '../src/sha256.js';
import { chunked } from '../src/stream.js';

const encoder = new TextEncoder();
const digest = (data: Uint8Array): string => new Sha256().update(data).digest();

/** Deterministic filler, so a failure is reproducible. */
function pattern(size: number): Uint8Array {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (i * 31 + 7) & 0xff;
  return data;
}

describe('Sha256', () => {
  it('matches the FIPS 180-4 vectors', () => {
    expect(digest(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(digest(encoder.encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(digest(encoder.encode('a'.repeat(1_000_000)))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  /**
   * The whole design rests on the incremental digest being bit-identical to the
   * native one — a blob hashed by streaming has to land at the same content
   * address as the same blob hashed in one shot, or peers stop agreeing.
   */
  it('agrees with crypto.subtle at every block boundary and chunking', async () => {
    // 55/56 and 119/120 straddle the length-padding rollover
    for (const size of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 65_536]) {
      const data = pattern(size);
      const expected = await sha256(data);
      expect(digest(data), `one shot, ${size} bytes`).toBe(expected);

      for (const chunk of [1, 7, 64, 100, 4096]) {
        const hasher = new Sha256();
        for (let at = 0; at < size; at += chunk) {
          hasher.update(data.subarray(at, Math.min(at + chunk, size)));
        }
        expect(hasher.digest(), `${size} bytes in ${chunk}-byte chunks`).toBe(expected);
      }
    }
  });

  it('hashes a view into a larger buffer by its own bytes only', async () => {
    const backing = pattern(1000);
    const view = backing.subarray(100, 300);
    expect(digest(view)).toBe(await sha256(view));
    expect(digest(view)).not.toBe(digest(backing));
  });

  it('is idempotent once digested, and refuses further updates', () => {
    const hasher = new Sha256().update(encoder.encode('abc'));
    const first = hasher.digest();
    expect(hasher.digest()).toBe(first);
    expect(() => hasher.update(new Uint8Array(1))).toThrow(/after digest/);
  });
});

describe('sha256Stream', () => {
  it('matches the one-shot digest', async () => {
    const data = pattern(200_000);
    expect(await sha256Stream(chunked(data, 4096))).toBe(await sha256(data));
  });

  it('handles an empty stream', async () => {
    expect(await sha256Stream(chunked(new Uint8Array()))).toBe(await sha256(new Uint8Array()));
  });
});
