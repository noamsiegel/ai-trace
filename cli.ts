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

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildPostingPlan } from './src/core/posting-plan.ts';
import { loadRepoSessions, selectHandoffSession, selectSessionsForRange, safeReadJsonl, isRealPrompt, extractTextFromContent } from './src/core/session.ts';
import { collectMarkdown, loadScrubbers, sanitize } from './src/core/sanitize.ts';
import { GhClient, type PrContext } from './src/adapters/gh-client.ts';

const VERSION = '0.5.0';

const HOME = homedir();
const CLAUDE_PROJECTS = join(HOME, '.claude', 'projects');

interface Args {
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
  console.log(`provenance ${VERSION} — Claude session → secret gist → PR description.

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

function detectRepoRoot(override?: string): string {
  if (override) return override;
  const r = git(['rev-parse', '--show-toplevel']);
  if (r.status !== 0) die('not in a git repo (pass --root <path>)');
  return r.stdout.trim();
}

async function detectPr(args: Args, repoRoot: string): Promise<PrContext> {
  const client = new GhClient();
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

function gitleaksCheck(content: string): { ok: boolean; report: string } {
  // Write content to a tmp file and run `gitleaks detect --source <file>`.
  const tmpDir = mkdirSync(join(tmpdir(), 'provenance-' + Date.now()), { recursive: true })!;
  const tmpFile = join(tmpDir, 'gist.md');
  writeFileSync(tmpFile, content);
  const r = run('gitleaks', ['detect', '--source', tmpDir, '--no-banner', '--redact', '--no-git']);
  return { ok: r.status === 0, report: r.stdout + r.stderr };
}

async function cmdCollect(args: Args) {
  const repoRoot = detectRepoRoot(args.root);
  const pr = await detectPr(args, repoRoot);
  const range = getCommitTimestampsForRange(`origin/${pr.baseRef}`, repoRoot);
  const all = loadRepoSessions(repoRoot, CLAUDE_PROJECTS);
  const diffFiles = args.scope !== 'time' ? getDiffFilesForRange(`origin/${pr.baseRef}`, repoRoot) : new Set<string>();
  const overlapping = selectSessionsForRange(all, pr.baseRef, { mode: args.scope, repoRoot, commitRange: range, diffFiles }, args.graceMin);
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
  const all = loadRepoSessions(repoRoot, CLAUDE_PROJECTS);
  const diffFiles = args.scope !== 'time' ? getDiffFilesForRange(ref, repoRoot) : new Set<string>();
  const overlapping = selectSessionsForRange(all, ref, { mode: args.scope, repoRoot, commitRange: range, diffFiles }, args.graceMin);
  if (overlapping.length === 0) {
    console.log(`No overlapping sessions for commits in ${ref}..HEAD (${range.count} commits).`);
    return;
  }
  for (const s of overlapping) {
    console.log(`${s.path}  prompts=${s.promptCount}  first=${new Date(s.firstTs).toISOString()}  last=${new Date(s.lastTs).toISOString()}`);
  }
}

async function cmdGistCreate(args: Args) {
  const repoRoot = detectRepoRoot(args.root);
  const pr = await detectPr(args, repoRoot);

  const visibilityPlan = buildPostingPlan({
    visibility: pr.visibility,
    flags: { publicOk: args.publicOk, noAttach: args.noAttach, dryRun: args.dryRun, force: args.force },
    gitleaksResult: { ok: true },
    action: 'gist-create',
  });
  if (!visibilityPlan.allow) {
    if (pr.visibility === 'PUBLIC') {
      die(
        `repo ${pr.nameWithOwner} is PUBLIC. A secret gist URL in a public PR body is effectively public.\n` +
          `  - Use --dry-run to print the markdown locally without uploading.\n` +
          `  - Use --no-attach to create a secret gist but NOT link it from the PR.\n` +
          `  - Use --public-ok to override after reviewing dry-run output.`,
        4,
      );
    }
    die(
      `repo visibility could not be determined for ${pr.nameWithOwner}.\n` +
        `Refusing to attach; rerun with --public-ok if you've reviewed dry-run output.`,
      4,
    );
  }

  const range = getCommitTimestampsForRange(`origin/${pr.baseRef}`, repoRoot);
  const diffFiles = args.scope !== 'time' ? getDiffFilesForRange(`origin/${pr.baseRef}`, repoRoot) : new Set<string>();
  const overlapping = selectSessionsForRange(loadRepoSessions(repoRoot, CLAUDE_PROJECTS), pr.baseRef, { mode: args.scope, repoRoot, commitRange: range, diffFiles }, args.graceMin);
  if (overlapping.length === 0) {
    die(`no sessions overlap commits in origin/${pr.baseRef}..HEAD (PR #${pr.number})`);
  }
  const md = collectMarkdown(repoRoot, pr.number, pr.baseRef, overlapping, {
    includeCode: args.includeCode,
    scrubbers: loadScrubbers(),
  });

  // Hard-block gitleaks: defeat-soft-confirm only behind --force.
  const leak = gitleaksCheck(md);
  const postingPlan = buildPostingPlan({
    visibility: pr.visibility,
    flags: { publicOk: args.publicOk, noAttach: args.noAttach, dryRun: args.dryRun, force: args.force },
    gitleaksResult: leak,
    action: 'gist-create',
  });
  if (!postingPlan.allow) {
    console.error(`provenance: gist content contains potential secrets — refusing to post.`);
    console.error(`Use --force to override (NOT recommended for public repos).`);
    console.error(leak.report);
    process.exit(3);
  }
  if (!leak.ok) {
    console.error(`provenance: WARNING: gitleaks reported issues; posting anyway because --force.`);
  }

  if (args.dryRun) {
    process.stdout.write(md);
    console.error(
      `(dry-run; would create ${args.public_ ? 'public' : 'secret'} gist with ${md.length} bytes for ${pr.nameWithOwner} #${pr.number} [${pr.visibility}])`,
    );
    return;
  }

  const client = new GhClient();
  let existingGistId: string | null = null;
  const body = await client.readPrBody(pr.number);
  if (body !== null) {
    existingGistId = await client.findAttachedProvenanceGist(body);
  }

  const gist = await client.upsertProvenanceGist(existingGistId, md, `AI provenance for PR #${pr.number}`, args.public_);
  console.log(gist.url);
  if (args.noAttach) return;
  try {
    await client.writeProvenanceLink(pr.number, gist.url);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
  console.error(`attached to PR #${pr.number}`);
}


async function cmdPrAttach(args: Args) {
  await cmdGistCreate(args);
}

function cmdHandoff(args: Args) {
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
  const sessions = loadRepoSessions(repoRoot, CLAUDE_PROJECTS);

  const session = selectHandoffSession(sessions, args.session);
  if (!session) die(args.session ? `session not found: ${args.session}` : 'no Claude Code sessions found for this repo');

  const branch = git(['symbolic-ref', '--short', 'HEAD'], repoRoot).stdout.trim() || '(detached)';
  const repoName = repoRoot.split('/').pop()!;
  const scrubbers = loadScrubbers();

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
    if (row.type === 'user' && isRealPrompt(row.message?.content)) {
      const ts = row.timestamp ? Date.parse(row.timestamp) : 0;
      const text = extractTextFromContent(row.message?.content).trim();
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

function cmdScrubRules() {
  const rules = loadScrubbers();
  for (const r of rules) {
    console.log(`${r.id}\t${r.pattern}\t→ ${r.replacement}`);
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
  switch (sub) {
    case 'collect':
      await cmdCollect(args);
      break;
    case 'sessions-since':
      cmdSessionsSince(args);
      break;
    case 'gist-create':
      await cmdGistCreate(args);
      break;
    case 'pr-attach':
      await cmdPrAttach(args);
      break;
    case 'handoff':
      cmdHandoff(args);
      break;
    case 'scrub-rules':
      cmdScrubRules();
      break;
    default:
      die(`unknown subcommand: ${sub} (run 'provenance --help')`, 2);
  }
}

if (import.meta.main) {
  await main();
}
