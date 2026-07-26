/** Presentation helpers: bytes, times and the MIME guess the details pane shows. */

const MIME: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.jsonc': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.jsx': 'text/javascript',
  '.sh': 'application/x-sh',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Extensionless names that are text anyway — the ones a repo actually holds. */
const TEXT_NAMES = new Set([
  'license',
  'licence',
  'readme',
  'makefile',
  'dockerfile',
  'procfile',
  'changelog',
  'authors',
  'notice',
]);

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i).toLowerCase();
}

/** Best guess from the name alone — no sniffing, the same way an OS does it. */
export function mimeOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const type = MIME[extensionOf(name)];
  if (type) return type;
  if (name.startsWith('.') || TEXT_NAMES.has(name.toLowerCase())) return 'text/plain';
  return 'application/octet-stream';
}

/**
 * Does this decode as text? For a name-based MIME guess this is never needed —
 * but a blob under `.vfs/objects/` is named after its hash, so its name says
 * nothing at all. Control characters (bar tab and the newlines) or the
 * decoder's replacement char mean it was not text to begin with.
 */
export function looksTextual(text: string): boolean {
  const end = Math.min(text.length, 4096);
  for (let i = 0; i < end; i++) {
    const code = text.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) continue; // tab, LF, CR
    // 0xfffd is what the decoder leaves where the bytes were not UTF-8 at all.
    if (code < 32 || code === 0xfffd) return false;
  }
  return true;
}

export function isTextMime(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/yaml' ||
    mime === 'application/toml' ||
    mime === 'application/xml' ||
    mime === 'application/x-sh' ||
    mime === 'image/svg+xml'
  );
}

/** A glyph per family, so the tree reads like a file manager at a glance. */
export function iconOf(mime: string): string {
  if (mime.startsWith('image/')) return '🖼';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('font/')) return '🔤';
  if (mime === 'application/pdf') return '📕';
  if (mime === 'application/zip' || mime === 'application/gzip') return '🗜';
  if (isTextMime(mime)) return '📄';
  return '📦';
}

const UNITS = ['bytes', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} ${size === 1 ? 'byte' : 'bytes'}`;
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unit]}`;
}

/** `1.2 KB (1,234 bytes)` — the long form the details pane shows. */
export function formatSize(size: number): string {
  if (size < 1024) return formatBytes(size);
  return `${formatBytes(size)} (${size.toLocaleString()} bytes)`;
}

export function formatTime(ms: number): string {
  const date = new Date(ms);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

/** `12s ago`, for anything whose interest is how recent it is. */
export function formatAgo(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
