#!/usr/bin/env bun
/**
 * agents-trace — capture AI session JSONL as a secret gist
 * attached to a GitHub PR.
 *
 * Subcommands:
 *   collect [--pr N] [--base REF] [--source auto|claude|codex|omp]
 *       Print cleaned markdown for sessions overlapping the PR's commits.
 *   sessions-since <ref>
 *       List sessions whose timestamps overlap commits since <ref>.
 *   gist-create [--pr N] [--public]
 *       collect + create a secret (default) gist; print URL.
 *   pr-attach [--pr N]
 *       gist-create + append/update "agents-trace: <url>" in PR description.
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

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { buildPostingPlan, normalizeRepoVisibility } from './src/core/posting-plan.ts';
import { loadRepoSessions, selectHandoffSession, selectSessionsForRange, safeReadJsonl, isPromptRow, extractPromptText, type SessionSource, type SessionMeta, type CommitRange } from './src/core/session.ts';
import { collectMarkdown, loadScrubbers, sanitize, type ScrubRule } from './src/core/sanitize.ts';
import { GhClient, type PrContext } from './src/adapters/gh-client.ts';
import { GitleaksRunner } from './src/adapters/gitleaks.ts';

const VERSION = '0.11.0';

export interface Args {
  pr?: string;
  base?: string;
  graceMin: number;
  scope: 'time' | 'file' | 'both';
  session?: string;
  lastPrompts?: number;
  includeCode: boolean;
  dryRun: boolean;
  noAttach: boolean;
  force: boolean;
  root?: string;
  source: SessionSource;
  public_: boolean;
  publicOk: boolean;
  rest: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    graceMin: 30,
    scope: 'both',
    includeCode: false,
    dryRun: false,
    noAttach: false,
    force: false,
    source: 'auto',
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
      case '--source':
        const source = argv[++i];
        if (source !== 'claude' && source !== 'codex' && source !== 'omp' && source !== 'auto') {
          die(`--source must be one of: claude, codex, omp, auto (got: ${source})`);
        }
        args.source = source;
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
      case '--session':
        args.session = argv[++i];
        break;
      case '--last-prompts':
        args.lastPrompts = Number.parseInt(argv[++i]!, 10);
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
  console.log(`agents-trace ${VERSION} — AI session → secret gist → PR description.

usage:
  agents-trace <subcommand> [flags]

subcommands:
  collect [--pr N] [--base REF] [--source auto|claude|codex]
                          Print cleaned markdown.
  sessions-since <ref>    List overlapping sessions for commits since <ref>.
  gist-create [--pr N] [--public] [--no-attach]
                          Create gist (secret by default); print URL.
  pr-attach [--pr N]      gist-create + edit PR description.
  scrub-rules             Show active scrubbing rules.
  handoff [--session ID] [--last-prompts N]
                          Compact brief of the latest (or named) session for
                          a subagent's system prompt.

flags:
  --pr <num>          Target PR (default: detect from current branch via gh).
  --base <ref>        Base ref for scoping (default: PR base branch).
  --grace-min N       Time-overlap grace in minutes (default: 30).
  --scope <mode>      Session-scoping: time | file | both (default: both).
                      'both' = intersection of time AND file overlap (most precise).
                      'file' = only sessions that touched files in the PR diff.
                      'time' = only time-overlap (broader, the v0.1.0 default).
  --source <source>   Session source: auto | claude | codex | omp (default: auto).
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
  console.error(`agents-trace: ${msg}`);
  process.exit(code);
}

function run(cmd: string, args: string[], opts: { input?: string; cwd?: string } = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { status: r.status ?? 1, stdout: r.stdout?.toString() ?? '', stderr: r.stderr?.toString() ?? '' };
}

function git(args: string[], cwd?: string): { status: number; stdout: string; stderr: string } {
  return run('git', cwd ? ['-C', cwd, ...args] : args);
}

function detectRepoRoot(override?: string): string {
  if (override) return override;
  const r = git(['rev-parse', '--show-toplevel']);
  if (r.status !== 0) die('not in a git repo (pass --root <path>)');
  return r.stdout.trim();
}

// Resolve all worktree roots that share a git repo with the given root. When
// `repoRoot` is a worktree, sessions for the canonical checkout (or sibling
// worktrees) live under different `<encoded-cwd>` directories but belong to
// the same logical repo \u2014 a PR opened from one worktree often wants traces
// from sessions that ran in the canonical.
function resolveAllRoots(repoRoot: string): string[] {
  const roots = new Set<string>([resolve(repoRoot)]);
  const r = git(['worktree', 'list', '--porcelain'], repoRoot);
  if (r.status !== 0) return [...roots];
  for (const block of r.stdout.split('\n\n')) {
    const m = block.match(/^worktree\s+(\S+)/m);
    if (m) roots.add(resolve(m[1]!));
  }
  return [...roots];
}

// Load sessions across all worktree roots, deduplicating by session file path.
function loadAllRootSessions(roots: string[], source: SessionSource): SessionMeta[] {
  const seen = new Set<string>();
  const out: SessionMeta[] = [];
  for (const r of roots) {
    for (const s of loadRepoSessions(r, source)) {
      if (seen.has(s.path)) continue;
      seen.add(s.path);
      out.push(s);
    }
  }
  return out;
}

async function detectPr(args: Args, repoRoot: string, client = new GhClient()): Promise<PrContext> {
  try {
    const pr = await client.readPrContext(repoRoot, args.pr);
    return { ...pr, baseRef: args.base ?? pr.baseRef };
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
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

// Select overlapping sessions with auto-fallback: when `scope=both` returns zero
// (e.g. a fresh PR with only a marker file has no file-overlap with any prior
// session), retry with `scope=time` and emit a stderr warning. Explicit
// `--scope time` and `--scope file` are honored verbatim with no fallback.
function selectWithScopeFallback(
  all: SessionMeta[],
  baseRef: string,
  repoRoot: string,
  range: CommitRange,
  diffFiles: Set<string>,
  graceMin: number,
  scope: 'time' | 'file' | 'both',
): SessionMeta[] {
  const primary = selectSessionsForRange(all, baseRef, { mode: scope, repoRoot, commitRange: range, diffFiles }, graceMin);
  if (primary.length > 0) return primary;
  if (scope !== 'both') return primary;
  const fallback = selectSessionsForRange(all, baseRef, { mode: 'time', repoRoot, commitRange: range, diffFiles }, graceMin);
  if (fallback.length > 0) {
    process.stderr.write(`agents-trace: scope=both returned 0 sessions; falling back to scope=time (${fallback.length} match)\n`);
  }
  return fallback;
}


async function cmdCollect(args: Args, scrubbers: ScrubRule[] = loadScrubbers()) {
  const repoRoot = detectRepoRoot(args.root);
  const pr = await detectPr(args, repoRoot);
  const range = getCommitTimestampsForRange(`origin/${pr.baseRef}`, repoRoot);
  const all = loadAllRootSessions(resolveAllRoots(repoRoot), args.source);
  const diffFiles = args.scope !== 'time' ? getDiffFilesForRange(`origin/${pr.baseRef}`, repoRoot) : new Set<string>();
  const overlapping = selectWithScopeFallback(all, pr.baseRef, repoRoot, range, diffFiles, args.graceMin, args.scope);
  const md = collectMarkdown(repoRoot, pr.number, pr.baseRef, overlapping, {
    includeCode: args.includeCode,
    scrubbers,
  });
  process.stdout.write(md);
}

function cmdSessionsSince(args: Args) {
  const ref = args.rest[0];
  if (!ref) die('usage: agents-trace sessions-since <ref>', 2);
  const repoRoot = detectRepoRoot(args.root);
  const range = getCommitTimestampsForRange(ref, repoRoot);
  const all = loadAllRootSessions(resolveAllRoots(repoRoot), args.source);
  const diffFiles = args.scope !== 'time' ? getDiffFilesForRange(ref, repoRoot) : new Set<string>();
  const overlapping = selectWithScopeFallback(all, ref, repoRoot, range, diffFiles, args.graceMin, args.scope);
  if (overlapping.length === 0) {
    console.log(`No overlapping sessions for commits in ${ref}..HEAD (${range.count} commits).`);
    return;
  }
  for (const s of overlapping) {
    console.log(`${s.path}  prompts=${s.promptCount}  first=${new Date(s.firstTs).toISOString()}  last=${new Date(s.lastTs).toISOString()}`);
  }
}

export async function cmdGistCreate(
  args: Args,
  deps: {
    ghClient?: GhClient;
    gitleaksRunner?: GitleaksRunner;
    planner?: typeof buildPostingPlan;
    scrubbers?: ScrubRule[];
  } = {},
) {
  const repoRoot = detectRepoRoot(args.root);
  const client = deps.ghClient ?? new GhClient();
  const pr = await detectPr(args, repoRoot, client);
  const range = getCommitTimestampsForRange(`origin/${pr.baseRef}`, repoRoot);
  const diffFiles = args.scope !== 'time' ? getDiffFilesForRange(`origin/${pr.baseRef}`, repoRoot) : new Set<string>();
  const overlapping = selectWithScopeFallback(loadAllRootSessions(resolveAllRoots(repoRoot), args.source), pr.baseRef, repoRoot, range, diffFiles, args.graceMin, args.scope);
  if (overlapping.length === 0) {
    die(`no sessions overlap commits in origin/${pr.baseRef}..HEAD (PR #${pr.number})`);
  }

  const md = collectMarkdown(repoRoot, pr.number, pr.baseRef, overlapping, {
    includeCode: args.includeCode,
    scrubbers: deps.scrubbers ?? loadScrubbers(),
  });
  const gitleaksFindings = await (deps.gitleaksRunner ?? new GitleaksRunner()).run(md);
  const plan = (deps.planner ?? buildPostingPlan)({
    visibility: normalizeRepoVisibility(pr.visibility),
    flags: { publicOk: args.publicOk, noAttach: args.noAttach, dryRun: args.dryRun, force: args.force },
    gitleaksFindings,
    action: args.noAttach ? 'create' : 'reattach',
  });

  if (!plan.allow) {
    die(plan.reason, 3);
  }

  if (args.dryRun) {
    process.stdout.write(md);
    console.error(
      `(dry-run; would create ${args.public_ ? 'public' : 'secret'} gist with ${md.length} bytes for ${pr.nameWithOwner} #${pr.number} [${pr.visibility}])`,
    );
    return;
  }

  let existingGistId: string | null = null;
  const body = await client.readPrBody(pr.number);
  if (body !== null) {
    existingGistId = await client.findAttachedAgentsTraceGist(body);
  }

  const gist = await client.upsertAgentsTraceGist(existingGistId, md, `agents-trace for PR #${pr.number}`, args.public_);
  console.log(gist.url);
  if (args.noAttach) return;
  try {
    await client.writeAgentsTraceLink(pr.number, gist.url);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
  console.error(`attached to PR #${pr.number}`);
}


async function cmdPrAttach(args: Args, scrubbers: ScrubRule[] = loadScrubbers()) {
  await cmdGistCreate(args, { scrubbers });
}

function cmdHandoff(args: Args, scrubbers: ScrubRule[] = loadScrubbers()) {
  // Produce a compact brief of the LATEST session in the current repo, suitable
  // for inclusion in a subagent's system prompt. Different shape from `collect`:
  //
  //   collect — lossless audit log; for human review of an entire PR
  //   handoff — decision-distilled, token-budget aware; for handing off to a
  //             subagent so it doesn't re-discover everything
  //
  // Format:
  //   - Header: repo, branch, time window, prompt count
  //   - Last N user prompts (default 10)
  //   - Distinct files touched (sorted)
  //   - Tool usage counts
  //   - No raw assistant responses (too long), no slash commands

  const lastN = args.lastPrompts ?? 10;
  const repoRoot = detectRepoRoot(args.root);
  const sessions = loadRepoSessions(repoRoot, args.source);

  const session = selectHandoffSession(sessions, args.session);
  if (!session) die(args.session ? `session not found: ${args.session}` : 'no AI sessions found for this repo');

  const branch = git(['symbolic-ref', '--short', 'HEAD'], repoRoot).stdout.trim() || '(detached)';
  const repoName = repoRoot.split('/').pop()!;
  const lines: string[] = [];
  lines.push(`# Handoff brief — ${repoName} (${branch})`);
  lines.push('');
  lines.push(`Session: \`${session.path.split('/').pop()}\``);
  lines.push(`Time window: ${new Date(session.firstTs).toISOString()} → ${new Date(session.lastTs).toISOString()}`);
  lines.push(`Prompts: ${session.promptCount}`);
  lines.push(`Files touched: ${session.filesTouched.size}`);
  lines.push('');

  // Collect prompts + tool uses from the session.
  const content = safeReadJsonl(session.path);
  if (content === null) die(`could not safely read session file: ${session.path}`);

  const prompts: { ts: number; text: string }[] = [];
  const toolUseCounts: Record<string, number> = {};
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let row: { type?: string; timestamp?: string; message?: { content?: unknown } };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (isPromptRow(row)) {
      const ts = row.timestamp ? Date.parse(row.timestamp) : 0;
      const text = extractPromptText(row).trim();
      prompts.push({ ts, text });
    }
    if (row.type === 'assistant' && Array.isArray(row.message?.content)) {
      for (const block of row.message.content as unknown[]) {
        if (block && typeof block === 'object') {
          const b = block as { type?: string; name?: string };
          if (b.type === 'tool_use' && b.name) {
            toolUseCounts[b.name] = (toolUseCounts[b.name] ?? 0) + 1;
          }
        }
      }
    }
  }

  // Take the last N prompts, scrub them, and render.
  const recent = prompts.slice(-lastN);
  lines.push(`## Recent prompts (last ${recent.length})`);
  lines.push('');
  for (let i = 0; i < recent.length; i++) {
    const p = recent[i]!;
    const ts = p.ts ? new Date(p.ts).toISOString().slice(11, 19) : '';
    const text = sanitize(p.text, 'handoff-inline', { scrubbers, maxLength: 300 });
    lines.push(`${i + 1}. **${ts}** — ${text}`);
  }
  lines.push('');

  // Files touched.
  if (session.filesTouched.size > 0) {
    const files = [...session.filesTouched].sort();
    lines.push(`## Files touched in this session`);
    lines.push('');
    const truncated = files.length > 30 ? files.slice(0, 30) : files;
    for (const f of truncated) {
      lines.push(`- \`${sanitize(f, 'handoff-inline', { scrubbers, maxLength: 1000 })}\``);
    }
    if (files.length > 30) {
      lines.push(`- … and ${files.length - 30} more`);
    }
    lines.push('');
  }

  // Tool usage.
  const tools = Object.entries(toolUseCounts).sort((a, b) => b[1] - a[1]);
  if (tools.length > 0) {
    lines.push(`## Tool usage`);
    lines.push('');
    lines.push('| Tool | Count |');
    lines.push('|---|---|');
    for (const [name, count] of tools) {
      lines.push(`| ${name} | ${count} |`);
    }
    lines.push('');
  }

  process.stdout.write(lines.join('\n'));
}

function cmdScrubRules(scrubbers: ScrubRule[] = loadScrubbers()) {
  for (const r of scrubbers) {
    console.log(`${r.name}\t${r.pattern}\t→ ${r.replacement}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    return;
  }
  const sub = argv[0]!;
  const args = parseArgs(argv.slice(1));
  const scrubbers = loadScrubbers();
  switch (sub) {
    case 'collect':
      await cmdCollect(args, scrubbers);
      break;
    case 'sessions-since':
      cmdSessionsSince(args);
      break;
    case 'gist-create':
      await cmdGistCreate(args, { scrubbers });
      break;
    case 'pr-attach':
      await cmdPrAttach(args, scrubbers);
      break;
    case 'handoff':
      cmdHandoff(args, scrubbers);
      break;
    case 'scrub-rules':
      cmdScrubRules(scrubbers);
      break;
    default:
      die(`unknown subcommand: ${sub} (run 'agents-trace --help')`, 2);
  }
}

if (import.meta.main) {
  await main();
}
