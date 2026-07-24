import type { Hash } from './types.js';

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i] as number];
  return out;
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error(
      'vfs-sync requires Web Crypto (globalThis.crypto.subtle). ' +
        'In browsers this means a secure context (https or localhost).',
    );
  }
  return c.subtle;
}

/** Content address of a blob. */
export async function sha256(data: Uint8Array): Promise<Hash> {
  // Copy into a plain ArrayBuffer: a Uint8Array view may cover only part of
  // a larger buffer, and digest() would otherwise hash the whole thing.
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return toHex(await subtle().digest('SHA-256', buf as ArrayBuffer));
}

/**
 * JSON with deterministic key order, so the same logical object always
 * produces the same hash on every peer.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJSON(obj[key])}`);
  }
  return `{${parts.join(',')}}`;
}

const encoder = new TextEncoder();

export function encodeJSON(value: unknown): Uint8Array {
  return encoder.encode(canonicalJSON(value));
}

const decoder = new TextDecoder();

export function decodeJSON<T>(data: Uint8Array): T {
  return JSON.parse(decoder.decode(data)) as T;
}

export function encodeText(text: string): Uint8Array {
  return encoder.encode(text);
}

export function decodeText(data: Uint8Array): string {
  return decoder.decode(data);
}

/** Content address of a tree or commit. */
export async function hashJSON(value: unknown): Promise<Hash> {
  return sha256(encodeJSON(value));
}

export function randomId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => HEX[b]).join('');
}
