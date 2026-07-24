import { describe, expect, it } from 'vitest';
import {
  formatAgo,
  formatBytes,
  formatSize,
  iconOf,
  isTextMime,
  mimeOf,
} from '../explorer/src/format';

describe('explorer format helpers', () => {
  it('guesses mime from the extension, case-insensitively', () => {
    expect(mimeOf('notes.md')).toBe('text/markdown');
    expect(mimeOf('docs/Photo.JPG')).toBe('image/jpeg');
    expect(mimeOf('data.json')).toBe('application/json');
    expect(mimeOf('archive.tar.gz')).toBe('application/gzip');
  });

  it('treats well-known extensionless names and dotfiles as text', () => {
    expect(mimeOf('LICENSE')).toBe('text/plain');
    expect(mimeOf('.gitignore')).toBe('text/plain');
    expect(mimeOf('a-binary')).toBe('application/octet-stream');
  });

  it('only the basename matters, not the folders around it', () => {
    expect(mimeOf('deep/nested/dir/readme')).toBe('text/plain');
    // a dot in a folder name is not an extension
    expect(mimeOf('v1.2/blob')).toBe('application/octet-stream');
  });

  it('classifies text-editable mimes', () => {
    expect(isTextMime('text/markdown')).toBe(true);
    expect(isTextMime('application/json')).toBe(true);
    expect(isTextMime('image/svg+xml')).toBe(true);
    expect(isTextMime('image/png')).toBe(false);
    expect(isTextMime('application/octet-stream')).toBe(false);
  });

  it('gives every mime family an icon', () => {
    expect(iconOf('image/png')).not.toBe(iconOf('text/plain'));
    expect(iconOf('application/octet-stream')).toBeTruthy();
  });

  it('formats byte counts with a unit that fits', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(999)).toBe('999 bytes');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(10 * 1024)).toBe('10 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('long form repeats the exact byte count', () => {
    expect(formatSize(512)).toBe('512 bytes');
    expect(formatSize(2048)).toBe(`2.0 KB (${(2048).toLocaleString()} bytes)`);
  });

  it('relative times step through units', () => {
    const now = 1_000_000_000;
    expect(formatAgo(now - 5_000, now)).toBe('5s ago');
    expect(formatAgo(now - 120_000, now)).toBe('2m ago');
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatAgo(now - 48 * 3_600_000, now)).toBe('2d ago');
    // a future mtime (clock skew) clamps to "now" instead of negative
    expect(formatAgo(now + 60_000, now)).toBe('0s ago');
  });
});
