import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { normalizeToRepoRelative, intersectsScope } from './scope.ts';

const MAX_JSONL_BYTES = 20 * 1024 * 1024;
const MAX_JSONL_ROWS = 50000;

export interface SessionMeta {
  path: string;
  firstTs: number;
  lastTs: number;
  promptCount: number;
  filesTouched: Set<string>;
}

export type Session = SessionMeta;

export interface CommitRange {
  min: number;
  max: number;
  count?: number;
}

export interface RangeSelectionScope {
  mode: 'time' | 'file' | 'both';
  repoRoot: string;
  commitRange: CommitRange;
  diffFiles: string[] | Set<string>;
}

export function encodeCwd(p: string): string {
  return p.replaceAll('/', '-').replaceAll('.', '-');
}

export function loadRepoSessions(repoRoot: string, claudeRoot: string): SessionMeta[] {
  const encoded = encodeCwd(repoRoot);
  const dir = join(claudeRoot, encoded);
  if (!existsSync(dir)) return [];

  let dirStat;
  try {
    dirStat = lstatSync(dir);
  } catch {
    return [];
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return [];
  if (dirStat.uid !== userInfo().uid) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const out: SessionMeta[] = [];
  for (const f of files) {
    const fp = join(dir, f);
    const meta = inspectSession(fp);
    if (meta && meta.promptCount > 0) out.push(meta);
  }
  return out;
}

export function inspectSession(path: string): SessionMeta | null {
  const content = safeReadJsonl(path);
  if (content === null) return null;
  let firstTs = Number.POSITIVE_INFINITY;
  let lastTs = 0;
  let promptCount = 0;
  let rowCount = 0;
  const filesTouched = new Set<string>();
  for (const line of content.split('\n')) {
    if (++rowCount > MAX_JSONL_ROWS) break;
    if (!line.trim()) continue;
    let row: {
      type?: string;
      timestamp?: string;
      message?: { content?: unknown };
      toolUseResult?: unknown;
    };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.timestamp) {
      const t = Date.parse(row.timestamp);
      if (!Number.isNaN(t)) {
        if (t < firstTs) firstTs = t;
        if (t > lastTs) lastTs = t;
      }
    }
    if (row.type === 'user' && isRealPrompt(row.message?.content)) promptCount++;
    extractFilePaths(row, filesTouched);
  }
  return { path, firstTs, lastTs, promptCount, filesTouched };
}

export function extractFilePaths(row: unknown, out: Set<string>): void {
  if (!row || typeof row !== 'object') return;
  const stack: unknown[] = [row];
  while (stack.length > 0) {
    const v = stack.pop();
    if (!v || typeof v !== 'object') continue;
    if (Array.isArray(v)) {
      for (const item of v) stack.push(item);
      continue;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'file_path' && typeof val === 'string' && val.length > 0) {
        out.add(val);
      } else if (val && typeof val === 'object') {
        stack.push(val);
      }
    }
  }
}

export function selectSessionsForRange(
  sessions: SessionMeta[],
  _baseRef: string,
  scope: RangeSelectionScope,
  graceMin: number,
): SessionMeta[] {
  const fileScope = normalizeToRepoRelative([...scope.diffFiles], scope.repoRoot);
  return sessions.filter((session) => {
    const timeMatch = overlapsRange(session, scope.commitRange, graceMin);
    switch (scope.mode) {
      case 'time':
        return timeMatch;
      case 'file':
        return intersectsScope(session, fileScope, scope.repoRoot);
      case 'both':
        return timeMatch && intersectsScope(session, fileScope, scope.repoRoot);
    }
  });
}

export function selectHandoffSession(sessions: SessionMeta[], name?: string): SessionMeta | undefined {
  if (name) return sessions.find((s) => s.path.endsWith(`${name}.jsonl`));
  return [...sessions].sort((a, b) => b.lastTs - a.lastTs)[0];
}

export function safeReadJsonl(path: string): string | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.isSymbolicLink()) return null;
  if (stat.nlink > 1) return null;
  if (stat.uid !== userInfo().uid) return null;
  if (stat.size > MAX_JSONL_BYTES) return null;

  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const fstat = fstatSync(fd);
    if (fstat.ino !== stat.ino || fstat.dev !== stat.dev) return null;
    const buf = Buffer.alloc(fstat.size);
    let offset = 0;
    while (offset < fstat.size) {
      const n = readSync(fd, buf, offset, fstat.size - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    return buf.toString('utf8', 0, offset);
  } finally {
    closeSync(fd);
  }
}

export function isRealPrompt(content: unknown): boolean {
  if (typeof content === 'string') {
    if (content.includes('<command-name>')) return false;
    if (content.includes('<local-command-caveat>')) return false;
    if (content.trim().length === 0) return false;
    return true;
  }
  if (Array.isArray(content)) {
    return content.some((block) => block && typeof block === 'object' && (block as { type?: string }).type === 'text');
  }
  return false;
}

export function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as { type?: string; text?: string };
        if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

function overlapsRange(s: SessionMeta, range: CommitRange, graceMin: number): boolean {
  const grace = graceMin * 60 * 1000;
  return s.lastTs >= range.min - grace && s.firstTs <= range.max + grace;
}
