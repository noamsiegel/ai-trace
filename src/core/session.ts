import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, userInfo } from 'node:os';
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

// Compare two filesystem paths through realpath so symlink-mediated mismatches
// (e.g. macOS /var/folders/\u2026 vs /private/var/folders/\u2026, or worktrees vs canonical)
// don't cause false negatives when matching session.cwd to repoRoot.
export function pathsEquivalent(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  let ra: string, rb: string;
  try { ra = realpathSync(a); } catch { ra = resolve(a); }
  try { rb = realpathSync(b); } catch { rb = resolve(b); }
  return ra === rb;
}

export type SessionSource = 'claude' | 'codex' | 'omp' | 'auto';

export function loadRepoSessions(repoRoot: string, source: SessionSource = 'auto', claudeRoot = join(process.env.HOME ?? homedir(), '.claude', 'projects')): SessionMeta[] {
  if (source === 'codex') return loadCodexSessions(repoRoot);
  if (source === 'omp') return loadOmpSessions(repoRoot);
  const claudeSessions = loadClaudeSessions(repoRoot, claudeRoot);
  if (source === 'claude' || claudeSessions.length > 0) return claudeSessions;
  const codexSessions = loadCodexSessions(repoRoot);
  if (codexSessions.length > 0) return codexSessions;
  return loadOmpSessions(repoRoot);
}

export function loadClaudeSessions(repoRoot: string, claudeRoot: string): SessionMeta[] {
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
    if (isPromptRow(row)) promptCount++;
    extractFilePaths(row, filesTouched);
  }
  return finiteSession(path, firstTs, lastTs, promptCount, filesTouched);
}

export function inspectCodexSession(path: string, repoRoot: string): SessionMeta | null {
  const content = safeReadJsonl(path);
  if (content === null) return null;
  let cwd: string | null = null;
  let firstTs = Number.POSITIVE_INFINITY;
  let lastTs = 0;
  let promptCount = 0;
  let rowCount = 0;
  const filesTouched = new Set<string>();

  for (const line of content.split('\n')) {
    if (++rowCount > MAX_JSONL_ROWS) break;
    if (!line.trim()) continue;
    let row: { type?: string; timestamp?: string; payload?: unknown };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    const t = timestampOf(row);
    if (t !== 0) {
      if (t < firstTs) firstTs = t;
      if (t > lastTs) lastTs = t;
    }

    const payload = row.payload && typeof row.payload === 'object' ? row.payload as Record<string, unknown> : null;
    if (row.type === 'session_meta' && typeof payload?.cwd === 'string') {
      cwd = resolve(payload.cwd);
    }
    if (row.type === 'turn_context' && typeof payload?.cwd === 'string') {
      cwd ??= resolve(payload.cwd);
    }

    if (isPromptRow(row)) promptCount++;
    extractFilePaths(row, filesTouched);
  }

  // Codex stores sessions in a global tree rather than a cwd-encoded directory.
  // Scan every session file and keep only transcripts whose recorded cwd is the target repo.
  if (cwd === null || !pathsEquivalent(cwd, repoRoot)) return null;
  return finiteSession(path, firstTs, lastTs, promptCount, filesTouched);
}

export function inspectOmpSession(path: string, repoRoot: string): SessionMeta | null {
  // OMP (Oh-My-Pi) session JSONL.
  //
  // Header row: { type: "session", id, timestamp, cwd: "...", title }
  // User prompts: { type: "message", timestamp, message: { role: "user", attribution: "user", content: [{type: "text", text: "..."}] } }
  // Other roles seen (NOT prompts): toolResult, assistant, developer (with attribution: "agent").
  //
  // OMP encodes the cwd in the parent directory name, but the encoding does not
  // round-trip (HOME prefix is stripped, dots are preserved). The session header
  // row is the authoritative source for cwd \u2014 same approach codex uses.
  const content = safeReadJsonl(path);
  if (content === null) return null;
  let cwd: string | null = null;
  let firstTs = Number.POSITIVE_INFINITY;
  let lastTs = 0;
  let promptCount = 0;
  let rowCount = 0;
  const filesTouched = new Set<string>();

  for (const line of content.split('\n')) {
    if (++rowCount > MAX_JSONL_ROWS) break;
    if (!line.trim()) continue;
    let row: { type?: string; timestamp?: string; cwd?: string; message?: unknown };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    const t = timestampOf(row);
    if (t !== 0) {
      if (t < firstTs) firstTs = t;
      if (t > lastTs) lastTs = t;
    }

    if (row.type === 'session' && typeof row.cwd === 'string') {
      cwd = resolve(row.cwd);
    }

    if (isPromptRow(row)) promptCount++;
    extractFilePaths(row, filesTouched);
  }

  if (cwd === null || !pathsEquivalent(cwd, repoRoot)) return null;
  return finiteSession(path, firstTs, lastTs, promptCount, filesTouched);
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
      } else if (k === 'arguments' && typeof val === 'string') {
        try {
          stack.push(JSON.parse(val));
        } catch {
          // Tool arguments may be arbitrary strings; ignore non-JSON values.
        }
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

export function isPromptRow(row: unknown): boolean {
  const text = extractPromptText(row);
  return isRealPrompt(text);
}

export function extractPromptText(row: unknown): string {
  if (!row || typeof row !== 'object') return '';
  const r = row as { type?: string; message?: { content?: unknown }; payload?: unknown };

  if (r.type === 'user') return extractTextFromContent(r.message?.content);

  // OMP shape: { type: "message", message: { role: "user", attribution: "user", content: [...] } }
  if (r.type === 'message' && r.message && typeof r.message === 'object') {
    const msg = r.message as { role?: string; content?: unknown; attribution?: string };
    if (msg.role === 'user' && (msg.attribution === undefined || msg.attribution === 'user')) {
      return extractTextFromContent(msg.content);
    }
  }

  const payload = r.payload && typeof r.payload === 'object' ? r.payload as { type?: string; role?: string; message?: string; content?: unknown } : null;
  if (!payload) return '';

  if (r.type === 'event_msg' && payload.type === 'user_message' && typeof payload.message === 'string') return payload.message;
  if (r.type === 'response_item' && payload.type === 'message' && payload.role === 'user') return extractTextFromContent(payload.content);
  return '';
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
        if ((b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') && typeof b.text === 'string') parts.push(b.text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

// Extract assistant-side message text. Mirrors extractPromptText but for role=assistant.
// Returns empty string for non-assistant rows or when no text content is found.
export function extractAssistantText(row: unknown): string {
  if (!row || typeof row !== 'object') return '';
  const r = row as { type?: string; message?: { role?: string; content?: unknown }; payload?: unknown };

  // Claude shape: { type: "assistant", message: { content: [...] } }
  if (r.type === 'assistant') return extractTextFromContent(r.message?.content);

  // OMP shape: { type: "message", message: { role: "assistant", content: [...] } }
  if (r.type === 'message' && r.message && typeof r.message === 'object') {
    const msg = r.message as { role?: string; content?: unknown };
    if (msg.role === 'assistant') return extractTextFromContent(msg.content);
  }

  // Codex shape: { type: "response_item", payload: { type: "message", role: "assistant", content: [...] } }
  const payload = r.payload && typeof r.payload === 'object' ? r.payload as { type?: string; role?: string; content?: unknown } : null;
  if (payload && r.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
    return extractTextFromContent(payload.content);
  }
  return '';
}

// Detect whether a user-prompt row is a `/plan` slash-command invocation.
// Pattern: <command-name>/plan</command-name> or <command-name>plan</command-name>.
export function isPlanCommandRow(row: unknown): boolean {
  const r = row as { type?: string; message?: { content?: unknown } };
  // Pull the raw text without going through the isPromptRow filter (which strips command rows).
  const text = extractPromptTextRaw(r);
  return /<command-name>\/?plan<\/command-name>/i.test(text);
}

// Same as extractPromptText but skips the isRealPrompt filter, so command rows are visible.
function extractPromptTextRaw(row: unknown): string {
  if (!row || typeof row !== 'object') return '';
  const r = row as { type?: string; message?: { content?: unknown }; payload?: unknown };
  if (r.type === 'user') return extractTextFromContent(r.message?.content);
  if (r.type === 'message' && r.message && typeof r.message === 'object') {
    const msg = r.message as { role?: string; content?: unknown; attribution?: string };
    if (msg.role === 'user') return extractTextFromContent(msg.content);
  }
  const payload = r.payload && typeof r.payload === 'object' ? r.payload as { type?: string; role?: string; message?: string; content?: unknown } : null;
  if (payload) {
    if (r.type === 'event_msg' && payload.type === 'user_message' && typeof payload.message === 'string') return payload.message;
    if (r.type === 'response_item' && payload.type === 'message' && payload.role === 'user') return extractTextFromContent(payload.content);
  }
  return '';
}

// Detect any user row (filtered or not) \u2014 used to terminate plan-capture state.
export function isAnyUserRow(row: unknown): boolean {
  return extractPromptTextRaw(row).length > 0;
}

function finiteSession(path: string, firstTs: number, lastTs: number, promptCount: number, filesTouched: Set<string>): SessionMeta | null {
  if (!Number.isFinite(firstTs) || lastTs === 0) return null;
  return { path, firstTs, lastTs, promptCount, filesTouched };
}

function timestampOf(row: { timestamp?: string }): number {
  if (!row.timestamp) return 0;
  const t = Date.parse(row.timestamp);
  return Number.isNaN(t) ? 0 : t;
}

function loadCodexSessions(repoRoot: string): SessionMeta[] {
  // Dynamic import avoided here: session.ts is the central loader and codex.ts imports its inspectors.
  const root = join(process.env.HOME ?? homedir(), '.codex', 'sessions');
  if (!existsSync(root)) return [];
  const out: SessionMeta[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let stat;
    try {
      stat = lstatSync(dir);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== userInfo().uid) continue;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (entry.endsWith('.jsonl')) {
        const meta = inspectCodexSession(path, repoRoot);
        if (meta && meta.promptCount > 0) out.push(meta);
      } else {
        stack.push(path);
      }
    }
  }
  return out;
}

function loadOmpSessions(repoRoot: string): SessionMeta[] {
  // Same dispatch pattern as loadCodexSessions to avoid circular imports with omp.ts.
  const root = join(process.env.HOME ?? homedir(), '.omp', 'agent', 'sessions');
  if (!existsSync(root)) return [];
  const out: SessionMeta[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let stat;
    try {
      stat = lstatSync(dir);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== userInfo().uid) continue;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (entry.endsWith('.jsonl')) {
        const meta = inspectOmpSession(path, repoRoot);
        if (meta && meta.promptCount > 0) out.push(meta);
      } else {
        stack.push(path);
      }
    }
  }
  return out;
}

function overlapsRange(s: SessionMeta, range: CommitRange, graceMin: number): boolean {
  const grace = graceMin * 60 * 1000;
  return s.lastTs >= range.min - grace && s.firstTs <= range.max + grace;
}
