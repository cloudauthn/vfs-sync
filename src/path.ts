/** Normalise to POSIX, drop leading/trailing slashes and `.` segments. */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) throw new Error(`path escapes the root: ${path}`);
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.join('/'));
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** `['name', '.ext']` — a leading dot is part of the name, not an extension. */
export function splitExtension(name: string): [string, string] {
  const i = name.lastIndexOf('.');
  if (i <= 0) return [name, ''];
  return [name.slice(0, i), name.slice(i)];
}

export function isInside(path: string, dir: string): boolean {
  if (!dir) return true;
  return path === dir || path.startsWith(`${dir}/`);
}
