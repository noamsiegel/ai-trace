import { isAbsolute, relative, normalize } from 'node:path';
import type { SessionMeta } from './session.ts';

export interface FileScope {
  repoRelative: Set<string>;
}

export function normalizeToRepoRelative(paths: string[], repoRoot: string): FileScope {
  const normalizedRepo = normalizePath(repoRoot);
  const repoRelative = new Set<string>();

  for (const path of paths) {
    if (!path) continue;
    const normalized = normalizePath(path);
    if (isAbsolute(path)) {
      const rel = normalizePath(relative(normalizedRepo, normalized));
      if (rel && rel !== '.' && !rel.startsWith('../') && rel !== '..') repoRelative.add(rel);
    } else {
      const rel = normalizePath(normalized);
      if (rel && rel !== '.' && !rel.startsWith('../') && rel !== '..') repoRelative.add(rel);
    }
  }

  return { repoRelative };
}

export function intersectsScope(session: SessionMeta, scope: FileScope, repoRoot?: string): boolean {
  if (scope.repoRelative.size === 0 || session.filesTouched.size === 0) return false;
  const touched = repoRoot
    ? normalizeToRepoRelative([...session.filesTouched], repoRoot).repoRelative
    : new Set([...session.filesTouched].map(normalizePath).filter((p) => p && p !== '.' && !p.startsWith('../') && p !== '..'));

  for (const path of touched) {
    if (scope.repoRelative.has(path)) return true;
  }
  return false;
}

function normalizePath(path: string): string {
  return normalize(path).replaceAll('\\', '/');
}
