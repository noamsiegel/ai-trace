#!/usr/bin/env bun
/**
 * provenance — capture Claude Code session JSONL as a secret gist
 * attached to a GitHub PR.
 *
 * Subcommands:
 *   collect [--pr N] [--base REF] [--include-code]
 *       Print cleaned markdown for sessions overlapping the PR's commits.
 *   sessions-since <ref>
 *       List sessions whose timestamps overlap commits since <ref>.
 *   gist-create [--pr N] [--public]
 *       collect + create a secret (default) gist; print URL.
 *   pr-attach [--pr N]
 *       gist-create + append/update "AI Provenance: <url>" in PR description.
 *   scrub-rules
 *       Print active scrubber rules.
 *
 * Common flags:
 *   --pr <num|url>      target PR (default: current branch's open PR via gh)
 *   --base <ref>        base ref for scoping (default: PR base branch)
 *   --grace-min N       minutes of overlap grace (default: 30)
 *   --include-code      include code blocks in output (default: omit)
 *   --dry-run           print what would happen, create no gist
 *   --no-attach         gist-create only, do not edit PR
 *   --force             post gist even if gitleaks finds issues
 *   --root <path>       override repo root detection
 *   --help, -h
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Caps to prevent runaway reads on attacker-influenced files.
const MAX_JSONL_BYTES = 20 * 1024 * 1024; // 20MB per session file
const MAX_JSONL_ROWS = 50000;

const HOME = homedir();
const CLAUDE_PROJECTS = join(HOME, '.claude', 'projects');
const CONFIG_FILE = join(HOME, '.config', 'provenance', 'config.yaml');

interface Args {
  pr?: string;
  base?: string;
  graceMin: number;
  scope: 'time' | 'file' | 'both';
  includeCode: boolean;
  dryRun: boolean;
  noAttach: boolean;
  force: boolean;
  root?: string;
  public_: boolean;
  publicOk: boolean;
  rest: string[];
}

interface ScrubRule {
  id: string;
  pattern: RegExp;
  replacement: string;
}

const DEFAULT_SCRUBBERS: ScrubRule[] = [
  // Cloud / service tokens.
  { id: 'github-pat', pattern: /\b(ghp_|github_pat_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]{20,}\b/g, replacement: '[REDACTED-GITHUB-TOKEN]' },
  { id: 'aws-access-key', pattern: /\b(AKIA|ASIA|AROA|AIDA|AGPA|AIPA|ANPA|ANVA|ASCA|APKA)[0-9A-Z]{16}\b/g, replacement: '[REDACTED-AWS-ACCESS-KEY]' },
  { id: 'gcp-service-account', pattern: /\b[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com\b/g, replacement: '[REDACTED-GCP-SA]' },
  { id: 'slack-token', pattern: /\bxox[bpoars]-[A-Za-z0-9-]{10,}\b/g, replacement: '[REDACTED-SLACK-TOKEN]' },
  { id: 'stripe-live', pattern: /\bsk_live_[A-Za-z0-9]{20,}\b/g, replacement: '[REDACTED-STRIPE-LIVE]' },
  { id: 'openai-key', pattern: /\bsk-[A-Za-z0-9]{20,}\b/g, replacement: '[REDACTED-OPENAI-KEY]' },
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, replacement: '[REDACTED-ANTHROPIC-KEY]' },
  { id: 'sentry-dsn', pattern: /\bhttps:\/\/[a-f0-9]{32}@[a-zA-Z0-9.-]+\/[0-9]+\b/g, replacement: '[REDACTED-SENTRY-DSN]' },
  // Generic credential assignments.
  {
    id: 'api-keys',
    pattern: /(?<prefix>(?:api[_-]?key|secret|token|password|bearer|authorization)["\s:=]+)[A-Za-z0-9_\-./+=]{16,}/gi,
    replacement: '$<prefix>[REDACTED-CREDENTIAL]',
  },
  // Private-key blocks.
  { id: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '[REDACTED-PRIVATE-KEY-BLOCK]' },
  // JWTs (3 base64url segments separated by `.`).
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, replacement: '[REDACTED-JWT]' },
  // Database URLs with basic auth.
  { id: 'db-url-auth', pattern: /\b([a-z][a-z0-9+]*):\/\/[^:\s/@]+:[^@\s]+@/gi, replacement: '$1://[REDACTED-AUTH]@' },
  // PII.
  { id: 'emails', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: '[REDACTED-EMAIL]' },
  { id: 'home-paths', pattern: /\/Users\/[^/\s]+\//g, replacement: '/Users/REDACTED/' },
  { id: 'home-paths-linux', pattern: /\/home\/[^/\s]+\//g, replacement: '/home/REDACTED/' },
];

function parseArgs(argv: string[]): Args {
  const args: Args = {
    graceMin: 30,
    scope: 'both',
    includeCode: false,
    dryRun: false,
    noAttach: false,
    force: false,
    public_: false,
    publicOk: false,
    rest: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--pr':
        args.pr = argv[++i];
        break;
      case '--base':
        args.base = argv[++i];
        break;
      case '--grace-min':
        args.graceMin = Number.parseInt(argv[++i]!, 10);
        break;
      case '--scope':
        const v = argv[++i];
        if (v !== 'time' && v !== 'file' && v !== 'both') {
          die(`--scope must be one of: time, file, both (got: ${v})`);
        }
        args.scope = v;
        break;
      case '--include-code':
        args.includeCode = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--no-attach':
        args.noAttach = true;
        break;
      case '--force':
        args.force = true;
        break;
      case '--root':
        args.root = resolve(argv[++i]!);
        break;
      case '--public':
        args.public_ = true;
        break;
      case '--public-ok':
        args.publicOk = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        if (a?.startsWith('--')) {
          die(`unknown flag: ${a}`, 2);
        }
        args.rest.push(a!);
    }
  }
  return args;
}

function printHelp() {
  console.log(`provenance — Claude session → secret gist → PR description.

usage:
  provenance <subcommand> [flags]

subcommands:
  collect [--pr N] [--base REF] [--include-code]
                          Print cleaned markdown.
  sessions-since <ref>    List overlapping sessions for commits since <ref>.
  gist-create [--pr N] [--public] [--no-attach]
                          Create gist (secret by default); print URL.
  pr-attach [--pr N]      gist-create + edit PR description.
  scrub-rules             Show active scrubbing rules.

flags:
  --pr <num>          Target PR (default: detect from current branch via gh).
  --base <ref>        Base ref for scoping (default: PR base branch).
  --grace-min N       Time-overlap grace in minutes (default: 30).
  --scope <mode>      Session-scoping: time | file | both (default: both).
                      'both' = intersection of time AND file overlap (most precise).
                      'file' = only sessions that touched files in the PR diff.
                      'time' = only time-overlap (broader, the v0.1.0 default).
  --include-code      Include code blocks (default: omit).
  --dry-run           Print what would happen; do not create gist.
  --no-attach         Create gist but don't edit the PR.
  --force             Post even if gitleaks finds issues.
  --public-ok         Override the refusal-to-attach-on-public-repos guard.
  --root <path>       Override repo root.
  --help, -h          This help.
`);
}

function die(msg: string, code = 1): never {
  console.error(`provenance: ${msg}`);
  process.exit(code);
}

function run(cmd: string, args: string[], opts: { input?: string; cwd?: string } = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { status: r.status ?? 1, stdout: r.stdout?.toString() ?? '', stderr: r.stderr?.toString() ?? '' };
}

function git(args: string[], cwd?: string): { status: number; stdout: string; stderr: string } {
  return run('git', cwd ? ['-C', cwd, ...args] : args);
}

// Encode a repo path the way Claude Code does: `/Users/x/y` → `-Users-x-y`.
function encodeCwd(p: string): string {
  return p.replace(/\//g, '-');
}

function detectRepoRoot(override?: string): string {
  if (override) return override;
  const r = git(['rev-parse', '--show-toplevel']);
  if (r.status !== 0) die('not in a git repo (pass --root <path>)');
  return r.stdout.trim();
}

interface PrInfo {
  number: number;
  baseRef: string;
  visibility: 'PUBLIC' | 'PRIVATE' | 'INTERNAL' | 'UNKNOWN';
  nameWithOwner: string;
}

function detectPr(args: Args): PrInfo {
  const fields = 'number,baseRefName,headRepository';
  let raw: string;
  if (args.pr) {
    const m = args.pr.match(/(?:\/pull\/)?(\d+)$/);
    const num = m ? Number.parseInt(m[1]!, 10) : Number.NaN;
    if (Number.isNaN(num)) die(`could not parse PR number from --pr ${args.pr}`);
    const meta = run('gh', ['pr', 'view', String(num), '--json', fields]);
    if (meta.status !== 0) die(`gh pr view ${num} failed: ${meta.stderr.trim()}`);
    raw = meta.stdout;
  } else {
    const meta = run('gh', ['pr', 'view', '--json', fields]);
    if (meta.status !== 0) die(`no PR for current branch (run with --pr <num>): ${meta.stderr.trim()}`);
    raw = meta.stdout;
  }
  const data = JSON.parse(raw);
  // C1: repo visibility is the gate for public-repo block.
  // We read the head repo (where the gist will be associated), not the base repo.
  // For PRs against the same repo (no fork), these are identical.
  const visMeta = run('gh', ['repo', 'view', data.headRepository?.nameWithOwner ?? '', '--json', 'visibility,nameWithOwner']);
  const visData = visMeta.status === 0 ? JSON.parse(visMeta.stdout) : null;
  return {
    number: data.number,
    baseRef: args.base ?? data.baseRefName,
    visibility: (visData?.visibility ?? 'UNKNOWN') as PrInfo['visibility'],
    nameWithOwner: visData?.nameWithOwner ?? data.headRepository?.nameWithOwner ?? '',
  };
}

function getCommitTimestampsForRange(base: string, repoRoot: string): { min: number; max: number; count: number } {
  // Commits in HEAD that are not in base.
  const r = git(['log', '--format=%cI', `${base}..HEAD`], repoRoot);
  if (r.status !== 0) die(`git log ${base}..HEAD failed: ${r.stderr.trim()}`);
  const ts = r.stdout.split('\n').filter(Boolean).map((s) => Date.parse(s));
  if (ts.length === 0) {
    return { min: Date.now() - 24 * 60 * 60 * 1000, max: Date.now(), count: 0 };
  }
  return { min: Math.min(...ts), max: Math.max(...ts), count: ts.length };
}

function getDiffFilesForRange(base: string, repoRoot: string): Set<string> {
  // Files changed by HEAD vs base.
  const r = git(['diff', '--name-only', `${base}..HEAD`], repoRoot);
  if (r.status !== 0) return new Set();
  return new Set(r.stdout.split('\n').filter(Boolean));
}

interface SessionMeta {
  path: string;
  firstTs: number;
  lastTs: number;
  promptCount: number;
  filesTouched: Set<string>;
}

/**
 * C3: Safely read a JSONL session file.
 *   - lstat: refuse symlinks, hardlinks (nlink > 1), non-regular files
 *   - require current uid ownership
 *   - refuse files >MAX_JSONL_BYTES
 *   - open by fd, fstat, read by fd (no path reopen → no TOCTOU)
 *   - cap row count
 * Returns null when the file is rejected.
 */
function safeReadJsonl(path: string): string | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.isSymbolicLink()) return null;
  if (stat.nlink > 1) return null; // hardlink — could escape into other content
  if (stat.uid !== userInfo().uid) return null;
  if (stat.size > MAX_JSONL_BYTES) return null;

  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    // Verify the open file matches the stat result (catches TOCTOU swaps).
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

function loadSessionsForRepo(repoRoot: string): SessionMeta[] {
  const encoded = encodeCwd(repoRoot);
  const dir = join(CLAUDE_PROJECTS, encoded);
  if (!existsSync(dir)) return [];

  // Refuse if the directory itself is a symlink.
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

function inspectSession(path: string): SessionMeta | null {
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
    // Extract file paths from tool-use blocks (Edit, Write, Read, etc.).
    extractFilePaths(row, filesTouched);
  }
  return { path, firstTs, lastTs, promptCount, filesTouched };
}

function extractFilePaths(row: unknown, out: Set<string>): void {
  if (!row || typeof row !== 'object') return;
  // Walk the row recursively; collect any value at key "file_path".
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

function isRealPrompt(content: unknown): boolean {
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

function overlapsRange(s: SessionMeta, range: { min: number; max: number }, graceMin: number): boolean {
  const grace = graceMin * 60 * 1000;
  return s.lastTs >= range.min - grace && s.firstTs <= range.max + grace;
}

function intersectsDiffFiles(s: SessionMeta, diffFiles: Set<string>): boolean {
  if (diffFiles.size === 0) return false;
  // Match by realpath suffix: session paths are usually absolute but diff files
  // are relative. Treat as overlap if any session-touched path ends with any
  // diff-file path.
  for (const f of diffFiles) {
    for (const touched of s.filesTouched) {
      if (touched.endsWith(`/${f}`) || touched === f) return true;
    }
  }
  return false;
}

function filterScope(
  s: SessionMeta,
  range: { min: number; max: number },
  diffFiles: Set<string>,
  args: { scope: 'time' | 'file' | 'both'; graceMin: number },
): boolean {
  const timeMatch = overlapsRange(s, range, args.graceMin);
  switch (args.scope) {
    case 'time': return timeMatch;
    case 'file': return intersectsDiffFiles(s, diffFiles);
    case 'both': return timeMatch && intersectsDiffFiles(s, diffFiles);
  }
}

function applyScrubbers(s: string, rules: ScrubRule[]): string {
  let out = s;
  for (const r of rules) {
    out = out.replaceAll(r.pattern, r.replacement);
  }
  return out;
}

function extractTextFromContent(content: unknown): string {
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

function neutralizeUntrustedText(s: string): string {
  // Render transcript content so embedded markdown/HTML cannot influence
  // the gist body or smuggle clickable links to reviewers.
  return s
    .replaceAll(/!\[([^\]]*)\]\(([^)]*)\)/g, '[image: $2]')
    .replaceAll(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replaceAll(/<\/?[a-zA-Z][^>]*>/g, '');
}

interface CollectOptions {
  includeCode: boolean;
  scrubbers: ScrubRule[];
}

function collectMarkdown(repoRoot: string, prNum: number, baseRef: string, sessions: SessionMeta[], opts: CollectOptions): string {
  const lines: string[] = [];
  lines.push(`# AI Provenance for PR #${prNum}`);
  lines.push('');
  lines.push(`Captured: ${new Date().toISOString()}`);
  lines.push(`Repo: ${applyScrubbers(repoRoot, opts.scrubbers)}`);
  lines.push(`Base ref: ${baseRef}`);
  lines.push(`Sessions: ${sessions.length}`);
  const totalPrompts = sessions.reduce((s, x) => s + x.promptCount, 0);
  lines.push(`Total prompts: ${totalPrompts}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]!;
    lines.push(`## Session ${i + 1}`);
    lines.push('');
    lines.push(`- First message: ${new Date(s.firstTs).toISOString()}`);
    lines.push(`- Last message:  ${new Date(s.lastTs).toISOString()}`);
    lines.push(`- Prompts: ${s.promptCount}`);
    lines.push('');
    lines.push('### Prompts');
    lines.push('');
    let n = 0;
    const sessionContent = safeReadJsonl(s.path);
    if (sessionContent === null) continue;
    let rowCount = 0;
    for (const line of sessionContent.split('\n')) {
      if (++rowCount > MAX_JSONL_ROWS) break;
      if (!line.trim()) continue;
      let row: { type?: string; timestamp?: string; message?: { content?: unknown } };
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.type !== 'user') continue;
      if (!isRealPrompt(row.message?.content)) continue;
      n++;
      const ts = row.timestamp ? new Date(row.timestamp).toISOString().slice(11, 19) : '';
      let text = extractTextFromContent(row.message?.content).trim();
      if (!opts.includeCode) {
        // Strip fenced code blocks to keep gists scannable.
        text = text.replaceAll(/```[\s\S]*?```/g, '[code block stripped]');
      }
      text = applyScrubbers(text, opts.scrubbers);
      // C2: render transcript content as untrusted data.
      //   - Markdown links/images → plain URL text only (no clickable smuggling).
      //   - Wrap each prompt in a fenced code block so markdown/HTML inside
      //     cannot influence the gist's structure.
      text = neutralizeUntrustedText(text);
      lines.push(`**Prompt ${n}** (${ts}):`);
      lines.push('');
      lines.push('```text');
      // Sanitize the fence too: if text contains backticks-3+, escape them.
      lines.push(text.replaceAll(/```/g, '` ` `'));
      lines.push('```');
      lines.push('');
    }
  }

  return lines.join('\n');
}

function loadScrubbers(): ScrubRule[] {
  // Default scrubbers always apply. Merge user-supplied rules from
  // ~/.config/provenance/config.json (JSON, not YAML, to avoid a YAML dep).
  //
  // Expected shape:
  // {
  //   "scrubbers": [
  //     { "id": "my-pattern", "pattern": "regex", "replacement": "[REDACTED]",
  //       "flags": "gi" }
  //   ]
  // }
  const configJson = join(homedir(), '.config', 'provenance', 'config.json');
  if (!existsSync(configJson)) return DEFAULT_SCRUBBERS;

  const userRules: ScrubRule[] = [];
  try {
    const raw = readFileSync(configJson, 'utf8');
    const parsed = JSON.parse(raw) as {
      scrubbers?: Array<{ id?: string; pattern?: string; replacement?: string; flags?: string }>;
    };
    if (Array.isArray(parsed.scrubbers)) {
      for (const r of parsed.scrubbers) {
        if (!r.id || !r.pattern || r.replacement === undefined) continue;
        try {
          userRules.push({
            id: r.id,
            pattern: new RegExp(r.pattern, r.flags ?? 'g'),
            replacement: r.replacement,
          });
        } catch (e) {
          console.error(`provenance: bad scrubber regex '${r.id}': ${(e as Error).message}`);
        }
      }
    }
  } catch (e) {
    console.error(`provenance: could not load ${configJson}: ${(e as Error).message}`);
  }

  return [...DEFAULT_SCRUBBERS, ...userRules];
}

function gitleaksCheck(content: string): { ok: boolean; report: string } {
  // Write content to a tmp file and run `gitleaks detect --source <file>`.
  const tmpDir = mkdirSync(join(tmpdir(), 'provenance-' + Date.now()), { recursive: true })!;
  const tmpFile = join(tmpDir, 'gist.md');
  writeFileSync(tmpFile, content);
  const r = run('gitleaks', ['detect', '--source', tmpDir, '--no-banner', '--redact', '--no-git']);
  return { ok: r.status === 0, report: r.stdout + r.stderr };
}

function cmdCollect(args: Args) {
  const repoRoot = detectRepoRoot(args.root);
  const pr = detectPr(args);
  const range = getCommitTimestampsForRange(`origin/${pr.baseRef}`, repoRoot);
  const all = loadSessionsForRepo(repoRoot);
  const diffFiles = args.scope !== 'time' ? getDiffFilesForRange(`origin/${pr.baseRef}`, repoRoot) : new Set<string>();
  const overlapping = all.filter((s) => filterScope(s, range, diffFiles, args));
  const md = collectMarkdown(repoRoot, pr.number, pr.baseRef, overlapping, {
    includeCode: args.includeCode,
    scrubbers: loadScrubbers(),
  });
  process.stdout.write(md);
}

function cmdSessionsSince(args: Args) {
  const ref = args.rest[0];
  if (!ref) die('usage: provenance sessions-since <ref>', 2);
  const repoRoot = detectRepoRoot(args.root);
  const range = getCommitTimestampsForRange(ref, repoRoot);
  const all = loadSessionsForRepo(repoRoot);
  const diffFiles = args.scope !== 'time' ? getDiffFilesForRange(ref, repoRoot) : new Set<string>();
  const overlapping = all.filter((s) => filterScope(s, range, diffFiles, args));
  if (overlapping.length === 0) {
    console.log(`No overlapping sessions for commits in ${ref}..HEAD (${range.count} commits).`);
    return;
  }
  for (const s of overlapping) {
    console.log(`${s.path}  prompts=${s.promptCount}  first=${new Date(s.firstTs).toISOString()}  last=${new Date(s.lastTs).toISOString()}`);
  }
}

function cmdGistCreate(args: Args) {
  const repoRoot = detectRepoRoot(args.root);
  const pr = detectPr(args);

  // C1: refuse to attach against public repos by default. Secret gists are
  // URL-protected only; the URL goes in the PR body which is publicly readable
  // for public repos, so attaching = effectively publishing the transcript.
  if (pr.visibility === 'PUBLIC' && !args.publicOk) {
    die(
      `repo ${pr.nameWithOwner} is PUBLIC. A secret gist URL in a public PR body is effectively public.\n` +
        `  - Use --dry-run to print the markdown locally without uploading.\n` +
        `  - Use --no-attach to create a secret gist but NOT link it from the PR.\n` +
        `  - Use --public-ok to override after reviewing dry-run output.`,
      4,
    );
  }
  if (pr.visibility === 'UNKNOWN' && !args.publicOk) {
    die(
      `repo visibility could not be determined for ${pr.nameWithOwner}.\n` +
        `Refusing to attach; rerun with --public-ok if you've reviewed dry-run output.`,
      4,
    );
  }

  const range = getCommitTimestampsForRange(`origin/${pr.baseRef}`, repoRoot);
  const diffFiles = args.scope !== 'time' ? getDiffFilesForRange(`origin/${pr.baseRef}`, repoRoot) : new Set<string>();
  const overlapping = loadSessionsForRepo(repoRoot).filter((s) => filterScope(s, range, diffFiles, args));
  if (overlapping.length === 0) {
    die(`no sessions overlap commits in origin/${pr.baseRef}..HEAD (PR #${pr.number})`);
  }
  const md = collectMarkdown(repoRoot, pr.number, pr.baseRef, overlapping, {
    includeCode: args.includeCode,
    scrubbers: loadScrubbers(),
  });

  // Hard-block gitleaks: defeat-soft-confirm only behind --force.
  const leak = gitleaksCheck(md);
  if (!leak.ok) {
    if (!args.force) {
      console.error(`provenance: gist content contains potential secrets — refusing to post.`);
      console.error(`Use --force to override (NOT recommended for public repos).`);
      console.error(leak.report);
      process.exit(3);
    } else {
      console.error(`provenance: WARNING: gitleaks reported issues; posting anyway because --force.`);
    }
  }

  if (args.dryRun) {
    process.stdout.write(md);
    console.error(
      `(dry-run; would create ${args.public_ ? 'public' : 'secret'} gist with ${md.length} bytes for ${pr.nameWithOwner} #${pr.number} [${pr.visibility}])`,
    );
    return;
  }

  // Find an existing gist URL in the PR body so we can update IN PLACE
  // instead of creating a new gist on every re-attach.
  const existingGistId = findExistingGistId(pr.number);

  const tmp = join(tmpdir(), `provenance-pr-${pr.number}.md`);
  writeFileSync(tmp, md);

  let url: string;
  if (existingGistId) {
    const editOut = run('gh', ['gist', 'edit', existingGistId, '--filename', `pr-${pr.number}.md`, tmp]);
    if (editOut.status !== 0) {
      console.error(`provenance: could not update existing gist ${existingGistId} (${editOut.stderr.trim()}); creating a new one.`);
      const created = createGist(args.public_, pr.number, tmp);
      url = created;
    } else {
      // gh gist edit doesn't print the URL; reconstruct.
      url = `https://gist.github.com/${existingGistId}`;
      console.error(`provenance: updated existing gist ${existingGistId} in place`);
    }
  } else {
    url = createGist(args.public_, pr.number, tmp);
  }

  console.log(url);
  if (args.noAttach) return;
  attachToPr(pr.number, url);
}

function createGist(public_: boolean, prNum: number, srcFile: string): string {
  const visibilityFlag = public_ ? '--public' : '--secret';
  const ghOut = run('gh', ['gist', 'create', visibilityFlag, '--filename', `pr-${prNum}.md`, srcFile]);
  if (ghOut.status !== 0) die(`gh gist create failed: ${ghOut.stderr.trim()}`);
  return ghOut.stdout.trim().split('\n').pop()!;
}

function findExistingGistId(prNum: number): string | null {
  const view = run('gh', ['pr', 'view', String(prNum), '--json', 'body']);
  if (view.status !== 0) return null;
  let body: string;
  try {
    body = (JSON.parse(view.stdout).body as string) ?? '';
  } catch {
    return null;
  }
  // Match: "🤖 AI Provenance: https://gist.github.com/<owner>/<gist-id>"
  // or:    "🤖 AI Provenance: https://gist.github.com/<gist-id>"
  const m = body.match(/🤖 AI Provenance:\s*https:\/\/gist\.github\.com\/(?:[^/\s]+\/)?([a-f0-9]+)/);
  return m ? m[1]! : null;
}

function attachToPr(prNum: number, gistUrl: string) {
  const view = run('gh', ['pr', 'view', String(prNum), '--json', 'body']);
  if (view.status !== 0) die(`gh pr view failed: ${view.stderr.trim()}`);
  let body = (JSON.parse(view.stdout).body as string) ?? '';
  const marker = '🤖 AI Provenance:';
  if (body.includes(marker)) {
    // Replace existing line.
    body = body.replaceAll(new RegExp(`${marker} \\S+`, 'g'), `${marker} ${gistUrl}`);
  } else {
    body = body.trim() + `\n\n---\n${marker} ${gistUrl}\n`;
  }
  const r = run('gh', ['pr', 'edit', String(prNum), '--body', body]);
  if (r.status !== 0) die(`gh pr edit failed: ${r.stderr.trim()}`);
  console.error(`attached to PR #${prNum}`);
}

function cmdPrAttach(args: Args) {
  cmdGistCreate(args);
}

function cmdScrubRules() {
  const rules = loadScrubbers();
  for (const r of rules) {
    console.log(`${r.id}\t${r.pattern}\t→ ${r.replacement}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    return;
  }
  const sub = argv[0]!;
  const args = parseArgs(argv.slice(1));
  switch (sub) {
    case 'collect':
      cmdCollect(args);
      break;
    case 'sessions-since':
      cmdSessionsSince(args);
      break;
    case 'gist-create':
      cmdGistCreate(args);
      break;
    case 'pr-attach':
      cmdPrAttach(args);
      break;
    case 'scrub-rules':
      cmdScrubRules();
      break;
    default:
      die(`unknown subcommand: ${sub} (run 'provenance --help')`, 2);
  }
}

main();
