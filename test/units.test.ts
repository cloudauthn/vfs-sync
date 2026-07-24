import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJSON, decodeJSON, encodeJSON, hashJSON, randomId, sha256 } from '../src/hash.js';
import { basename, dirname, isInside, joinPath, normalizePath, splitExtension } from '../src/path.js';

const encoder = new TextEncoder();

describe('normalizePath', () => {
  it('strips redundant separators and dot segments', () => {
    expect(normalizePath('/a//b/./c/')).toBe('a/b/c');
    expect(normalizePath('')).toBe('');
    expect(normalizePath('./')).toBe('');
  });

  it('accepts Windows separators', () => {
    expect(normalizePath('a\\b\\c.txt')).toBe('a/b/c.txt');
  });

  it('resolves .. within the root', () => {
    expect(normalizePath('a/b/../c')).toBe('a/c');
    expect(normalizePath('a/b/../../c')).toBe('c');
  });

  it('refuses to escape the root', () => {
    expect(() => normalizePath('../outside')).toThrow(/escapes the root/);
    expect(() => normalizePath('a/../../outside')).toThrow(/escapes the root/);
  });
});

describe('path helpers', () => {
  it('joins and normalises in one step', () => {
    expect(joinPath('a', 'b/', '/c.txt')).toBe('a/b/c.txt');
    expect(joinPath('', 'file.txt')).toBe('file.txt');
  });

  it('splits directories from names', () => {
    expect(dirname('a/b/c.txt')).toBe('a/b');
    expect(dirname('c.txt')).toBe('');
    expect(basename('a/b/c.txt')).toBe('c.txt');
    expect(basename('c.txt')).toBe('c.txt');
  });

  it('treats a leading dot as part of the name, not an extension', () => {
    expect(splitExtension('notes.md')).toEqual(['notes', '.md']);
    expect(splitExtension('archive.tar.gz')).toEqual(['archive.tar', '.gz']);
    expect(splitExtension('LICENSE')).toEqual(['LICENSE', '']);
    expect(splitExtension('.gitignore')).toEqual(['.gitignore', '']);
  });

  it('knows containment, without matching sibling prefixes', () => {
    expect(isInside('a/b/c', 'a/b')).toBe(true);
    expect(isInside('a/b', 'a/b')).toBe(true);
    expect(isInside('anything', '')).toBe(true);
    expect(isInside('a/bc', 'a/b')).toBe(false);
  });
});

describe('sha256', () => {
  it('matches the known digest for "abc"', async () => {
    expect(await sha256(encoder.encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes only the bytes a view covers, not its whole buffer', async () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    const view = backing.subarray(2, 5);
    expect(await sha256(view)).toBe(await sha256(new Uint8Array([1, 2, 3])));
  });

  it('produces different digests for different content', async () => {
    expect(await sha256(encoder.encode('a'))).not.toBe(await sha256(encoder.encode('b')));
  });
});

describe('canonicalJSON', () => {
  it('is independent of key insertion order', () => {
    expect(canonicalJSON({ b: 1, a: 2 })).toBe(canonicalJSON({ a: 2, b: 1 }));
    expect(canonicalJSON({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('drops undefined values but keeps nulls', () => {
    expect(canonicalJSON({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('preserves array order and recurses', () => {
    expect(canonicalJSON({ list: [{ z: 1, a: 2 }, 'x', 3] })).toBe('{"list":[{"a":2,"z":1},"x",3]}');
  });

  it('handles primitives at the top level', () => {
    expect(canonicalJSON(null)).toBe('null');
    expect(canonicalJSON(42)).toBe('42');
    expect(canonicalJSON('text')).toBe('"text"');
  });

  it('gives the same hash regardless of key order', async () => {
    expect(await hashJSON({ tree: 't', parents: [], peer: 'a' })).toBe(
      await hashJSON({ peer: 'a', parents: [], tree: 't' }),
    );
  });

  it('round-trips through encode/decode', () => {
    expect(decodeJSON(encodeJSON({ a: [1, 2], b: 'x' }))).toEqual({ a: [1, 2], b: 'x' });
  });
});

describe('randomId', () => {
  const original = globalThis.crypto;
  afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
  });

  it('returns unique values', () => {
    const ids = new Set(Array.from({ length: 200 }, () => randomId()));
    expect(ids.size).toBe(200);
  });

  it('falls back to getRandomValues where randomUUID is missing', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: (b: Uint8Array) => original.getRandomValues(b) },
      configurable: true,
    });
    const id = randomId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).not.toBe(randomId());
  });
});

describe('missing Web Crypto', () => {
  const original = globalThis.crypto;
  afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
  });

  it('explains what is missing instead of failing obscurely', async () => {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    await expect(sha256(encoder.encode('x'))).rejects.toThrow(/secure context/);
  });
});
