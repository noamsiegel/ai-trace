/**
 * agents-trace CLI tests.
 *
 * Run: bun test ~/Documents/GitHub/agents-trace/tests/cli.test.ts
 *
 * These exercise the pure logic (scrubbers, prompt filtering, time overlap,
 * markdown rendering) without needing live PRs or gh authentication.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeCwd, loadRepoSessions, type SessionMeta } from '../src/core/session.ts';
import { loadCodexSessions } from '../src/core/codex.ts';
import { loadOmpSessions } from '../src/core/omp.ts';
import { normalizeToRepoRelative, intersectsScope } from '../src/core/scope.ts';
import { sanitize, type ScrubRule } from '../src/core/sanitize.ts';

const CLI = new URL('../cli.ts', import.meta.url).pathname;

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(...args: string[]): Result {
  const r = spawnSync('bun', [CLI, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout?.toString() ?? '', stderr: r.stderr?.toString() ?? '' };
}

describe('CLI basics', () => {
  test('--help prints usage', () => {
    const r = runCli('--help');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('agents-trace 0.11.0');
    expect(r.stdout).toContain('subcommands:');
  });

  test('unknown subcommand exits non-zero', () => {
    const r = runCli('bogus');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('unknown subcommand');
  });

  test('scrub-rules lists defaults', () => {
    const r = runCli('scrub-rules');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('api-keys');
    expect(r.stdout).toContain('emails');
    expect(r.stdout).toContain('home-paths');
  });
});

describe('collect end-to-end with synthetic session', () => {
  let repo: string;
  let projectsDir: string;
  let origHome: string;
  let fakeHome: string;

  beforeEach(() => {
    // Build a fake $HOME with ~/.claude/projects/ pointing at our fixture.
    fakeHome = mkdtempSync(join(tmpdir(), 'pp-home-'));
    projectsDir = join(fakeHome, '.claude', 'projects');
    mkdirSync(projectsDir, { recursive: true });

    // Initialize a git repo with two commits.
    repo = join(fakeHome, 'repo');
    mkdirSync(repo);
    const g = (...a: string[]) => spawnSync('git', ['-C', repo, ...a]);
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@e.com');
    g('config', 'user.name', 'T');
    writeFileSync(join(repo, 'a.txt'), 'a');
    g('add', '.');
    g('commit', '-q', '-m', 'feat: init');
    g('checkout', '-q', '-b', 'feature');
    writeFileSync(join(repo, 'a.txt'), 'aa');
    g('add', '.');
    g('commit', '-q', '-m', 'feat: change');
    g('branch', '--set-upstream-to', 'main');

    // Encode the repo path: /var/folders/.../pp-home-XXX/repo → -var-folders-...-pp-home-XXX-repo
    const encoded = encodeCwd(repo);
    const sessionDir = join(projectsDir, encoded);
    mkdirSync(sessionDir, { recursive: true });

    // Write a fixture session jsonl with timestamps overlapping the commits.
    const now = Date.now();
    const rows = [
      { type: 'user', timestamp: new Date(now - 1000).toISOString(), message: { content: 'refactor the auth flow' } },
      { type: 'assistant', timestamp: new Date(now - 500).toISOString(), message: { content: [{ type: 'text', text: 'OK, I will refactor.' }] } },
      { type: 'user', timestamp: new Date(now - 100).toISOString(), message: { content: '<command-name>/exit</command-name>' } }, // slash command — filtered
      { type: 'user', timestamp: new Date(now - 50).toISOString(), message: { content: 'My email is bob@example.com and the API_KEY=abcdef0123456789xyz' } },
    ];
    writeFileSync(join(sessionDir, 'session1.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));

    origHome = process.env.HOME!;
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  test('sessions-since detects the fixture session', () => {
    const r = spawnSync('bun', [CLI, 'sessions-since', 'main', '--scope', 'time', '--root', repo], {
      encoding: 'utf8',
      env: { ...process.env, HOME: fakeHome },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('prompts=');
    expect(Number.parseInt(r.stdout.match(/prompts=(\d+)/)?.[1] ?? '0', 10)).toBeGreaterThan(0);
  });

  test('collect output omits slash-command rows', () => {
    // collect requires --pr; use --base + a synthetic PR by stubbing.
    // Instead, exercise via sessions-since (which uses the same filter) plus
    // re-running collect with --base/main directly is not supported; we test
    // the filter behavior via direct CLI subprocess.
    // For now we rely on sessions-since prompt count: 2 valid (refactor, my email…),
    // the slash command should NOT be counted.
    const r = spawnSync('bun', [CLI, 'sessions-since', 'main', '--scope', 'time', '--root', repo], {
      encoding: 'utf8',
      env: { ...process.env, HOME: fakeHome },
    });
    const m = r.stdout.match(/prompts=(\d+)/);
    expect(m).not.toBeNull();
    expect(Number.parseInt(m![1]!, 10)).toBe(2); // refactor + email-line; slash filtered.
  });
  test('default scope (both) auto-falls back to time when zero sessions match file-overlap', () => {
    const r = spawnSync('bun', [CLI, 'sessions-since', 'main', '--root', repo], {
      encoding: 'utf8',
      env: { ...process.env, HOME: fakeHome },
    });
    expect(r.status).toBe(0);
    // The fixture session has prompts but no `file_path` references. Under the
    // new auto-fallback (v0.11.0): both \u2192 time when both returns 0. The session
    // is now visible, and a stderr warning announces the fallback.
    expect(r.stdout).toContain('prompts=');
    expect(r.stderr).toContain('falling back to scope=time');
  });

  test('explicit --scope file is honored verbatim without fallback', () => {
    const r = spawnSync('bun', [CLI, 'sessions-since', 'main', '--root', repo, '--scope', 'file'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: fakeHome },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No overlapping sessions');
    expect(r.stderr).not.toContain('falling back');
  });
});


describe('Codex session adapter', () => {
  let fakeHome: string;
  let repo: string;
  let origHome: string;

  beforeEach(() => {
    origHome = process.env.HOME!;
    fakeHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
    process.env.HOME = fakeHome;
    repo = join(fakeHome, 'repo.with.dots');
    mkdirSync(repo, { recursive: true });
    const sessionsDir = join(fakeHome, '.codex', 'sessions', '2026', '05', '24');
    mkdirSync(sessionsDir, { recursive: true });
    const now = Date.now();
    const rows = [
      { type: 'session_meta', timestamp: new Date(now - 3000).toISOString(), payload: { id: 's1', cwd: repo } },
      { type: 'event_msg', timestamp: new Date(now - 2000).toISOString(), payload: { type: 'user_message', message: 'codex prompt one' } },
      { type: 'response_item', timestamp: new Date(now - 1500).toISOString(), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } },
      { type: 'response_item', timestamp: new Date(now - 1000).toISOString(), payload: { type: 'function_call', name: 'apply_patch', arguments: JSON.stringify({ file_path: join(repo, 'src/a.ts') }) } },
      { type: 'response_item', timestamp: new Date(now - 500).toISOString(), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex prompt two' }] } },
    ];
    writeFileSync(join(sessionsDir, 'rollout-2026-05-24T00-00-00-s1.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));

    const otherRows = [
      { type: 'session_meta', timestamp: new Date(now).toISOString(), payload: { id: 's2', cwd: join(fakeHome, 'other') } },
      { type: 'event_msg', timestamp: new Date(now).toISOString(), payload: { type: 'user_message', message: 'wrong repo' } },
    ];
    writeFileSync(join(sessionsDir, 'rollout-2026-05-24T00-00-01-s2.jsonl'), otherRows.map((r) => JSON.stringify(r)).join('\n'));
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  test('loadRepoSessions scans Codex sessions by recorded cwd, not Claude cwd encoding', () => {
    const sessions = loadRepoSessions(repo, 'codex');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.promptCount).toBe(2);
    expect(sessions[0]!.filesTouched.has(join(repo, 'src/a.ts'))).toBe(true);
    expect(loadCodexSessions(repo)).toHaveLength(1);
  });

  test('auto falls back to Codex when no Claude sessions exist', () => {
    const sessions = loadRepoSessions(repo, 'auto');

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.promptCount).toBe(2);
  });
});

describe('OMP session adapter', () => {
  let fakeHome: string;
  let repo: string;
  let origHome: string;

  beforeEach(() => {
    origHome = process.env.HOME!;
    fakeHome = mkdtempSync(join(tmpdir(), 'omp-home-'));
    process.env.HOME = fakeHome;
    repo = join(fakeHome, 'omp-repo');
    mkdirSync(repo, { recursive: true });
    // OMP encodes cwd as `<home-relative>` with `/` -> `-`. Use any name; the
    // header row's `cwd` field is authoritative for filtering.
    const sessionsDir = join(fakeHome, '.omp', 'agent', 'sessions', '-omp-repo');
    mkdirSync(sessionsDir, { recursive: true });
    const now = Date.now();
    const rows = [
      { type: 'session', version: 3, id: 'sess-1', timestamp: new Date(now - 4000).toISOString(), cwd: repo, title: 'fixture', titleSource: 'manual' },
      { type: 'model_change', id: 'm1', parentId: null, timestamp: new Date(now - 3500).toISOString(), model: 'test-model' },
      { type: 'message', id: 'p1', parentId: 'm1', timestamp: new Date(now - 3000).toISOString(), message: { role: 'user', attribution: 'user', content: [{ type: 'text', text: 'omp prompt one mentioning ' + join(repo, 'src/a.ts') }] } },
      { type: 'message', id: 'a1', parentId: 'p1', timestamp: new Date(now - 2500).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'edit', input: { file_path: join(repo, 'src/a.ts') } }] } },
      { type: 'message', id: 'tr1', parentId: 'a1', timestamp: new Date(now - 2000).toISOString(), message: { role: 'toolResult', content: 'tool output' } },
      { type: 'message', id: 'p2', parentId: 'tr1', timestamp: new Date(now - 1500).toISOString(), message: { role: 'user', attribution: 'user', content: [{ type: 'text', text: 'omp prompt two' }] } },
      // Synthetic developer/agent rows should NOT count as user prompts.
      { type: 'message', id: 'd1', parentId: 'p2', timestamp: new Date(now - 1000).toISOString(), message: { role: 'developer', attribution: 'agent', content: [{ type: 'text', text: 'system reminder injected' }] } },
    ];
    writeFileSync(join(sessionsDir, '2026-05-24T00-00-00-000Z_sess-1.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));

    // A different-cwd session in a sibling encoded-dir; should be filtered out.
    const otherDir = join(fakeHome, '.omp', 'agent', 'sessions', '-other-repo');
    mkdirSync(otherDir, { recursive: true });
    const otherRepo = join(fakeHome, 'other-repo');
    const otherRows = [
      { type: 'session', version: 3, id: 'sess-2', timestamp: new Date(now).toISOString(), cwd: otherRepo, title: 'wrong' },
      { type: 'message', id: 'p3', timestamp: new Date(now).toISOString(), message: { role: 'user', attribution: 'user', content: [{ type: 'text', text: 'wrong repo' }] } },
    ];
    writeFileSync(join(otherDir, '2026-05-24T00-00-01-000Z_sess-2.jsonl'), otherRows.map((r) => JSON.stringify(r)).join('\n'));
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  test('loadOmpSessions filters by recorded cwd in the session header', () => {
    const sessions = loadOmpSessions(repo);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.promptCount).toBe(2);
  });

  test('loadRepoSessions with --source omp returns only matching repo', () => {
    const sessions = loadRepoSessions(repo, 'omp');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.promptCount).toBe(2);
  });

  test('developer/agent attribution rows are NOT counted as user prompts', () => {
    // The fixture has 1 developer/agent row; it must not appear in promptCount.
    const sessions = loadOmpSessions(repo);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.promptCount).toBe(2); // not 3
  });

  test('extractFilePaths picks up file_path from assistant tool_use blocks', () => {
    const sessions = loadOmpSessions(repo);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.filesTouched.has(join(repo, 'src/a.ts'))).toBe(true);
  });

  test('auto falls back to OMP when neither Claude nor Codex sessions exist', () => {
    const sessions = loadRepoSessions(repo, 'auto');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.promptCount).toBe(2);
  });

  test('sessions-since CLI with --source omp counts prompts correctly', () => {
    // Initialize a tiny git repo at `repo` and commit so `sessions-since main` has a base.
    spawnSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { encoding: 'utf8' });
    spawnSync('git', ['-C', repo, 'config', 'user.email', 'test@local'], { encoding: 'utf8' });
    spawnSync('git', ['-C', repo, 'config', 'user.name', 'test'], { encoding: 'utf8' });
    writeFileSync(join(repo, 'a'), 'a\n');
    spawnSync('git', ['-C', repo, 'add', 'a'], { encoding: 'utf8' });
    spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { encoding: 'utf8' });
    const r = spawnSync('bun', [CLI, 'sessions-since', 'main', '--source', 'omp', '--root', repo, '--scope', 'time'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: fakeHome },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('prompts=2');
  });
});

describe('Multi-root session loading (worktree + canonical)', () => {
  let fakeHome: string;
  let canonical: string;
  let worktree: string;
  let origHome: string;

  beforeEach(() => {
    origHome = process.env.HOME!;
    fakeHome = mkdtempSync(join(tmpdir(), 'mroot-home-'));
    process.env.HOME = fakeHome;
    canonical = join(fakeHome, 'canonical');
    mkdirSync(canonical, { recursive: true });

    // Init canonical repo with an initial commit so worktree-add can branch off it.
    spawnSync('git', ['-C', canonical, 'init', '-q', '-b', 'main'], { encoding: 'utf8' });
    spawnSync('git', ['-C', canonical, 'config', 'user.email', 't@local'], { encoding: 'utf8' });
    spawnSync('git', ['-C', canonical, 'config', 'user.name', 't'], { encoding: 'utf8' });
    writeFileSync(join(canonical, 'a'), 'a\n');
    spawnSync('git', ['-C', canonical, 'add', 'a'], { encoding: 'utf8' });
    spawnSync('git', ['-C', canonical, 'commit', '-q', '-m', 'init'], { encoding: 'utf8' });

    worktree = join(fakeHome, 'wt');
    spawnSync('git', ['-C', canonical, 'worktree', 'add', '-b', 'feat', worktree], { encoding: 'utf8' });

    // OMP session recorded against CANONICAL cwd (the user did the work in canonical).
    const canonicalEnc = '-canonical';
    const sessionsDir = join(fakeHome, '.omp', 'agent', 'sessions', canonicalEnc);
    mkdirSync(sessionsDir, { recursive: true });
    const now = Date.now();
    const rows = [
      { type: 'session', version: 3, id: 's-canonical', timestamp: new Date(now - 1000).toISOString(), cwd: canonical, title: 't' },
      { type: 'message', id: 'p1', timestamp: new Date(now - 800).toISOString(), message: { role: 'user', attribution: 'user', content: [{ type: 'text', text: 'work done in canonical' }] } },
    ];
    writeFileSync(join(sessionsDir, '2026-05-27T00-00-00-000Z_s-canonical.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  test('sessions-since run from the worktree picks up sessions recorded against canonical', () => {
    const r = spawnSync('bun', [CLI, 'sessions-since', 'main', '--source', 'omp', '--root', worktree, '--scope', 'time'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: fakeHome },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('prompts=1');
    expect(r.stdout).toContain('s-canonical');
  });
});

describe('Plan-response capture', () => {
  test('collectMarkdown captures /plan response from Claude session shape', async () => {
    const { collectMarkdown } = await import('../src/core/sanitize.ts');
    const fakeHome = mkdtempSync(join(tmpdir(), 'plan-home-'));
    const repo = join(fakeHome, 'repo');
    mkdirSync(repo, { recursive: true });

    const sessionPath = join(fakeHome, 'session.jsonl');
    const now = Date.now();
    const rows = [
      { type: 'user', timestamp: new Date(now - 5000).toISOString(), message: { content: 'normal prompt one' } },
      { type: 'user', timestamp: new Date(now - 4000).toISOString(), message: { content: '<command-name>/plan</command-name>\n<command-message>plan</command-message>\n<command-args></command-args>' } },
      { type: 'assistant', timestamp: new Date(now - 3500).toISOString(), message: { content: [{ type: 'text', text: 'Here is the plan:\n1. Step A\n2. Step B' }] } },
      { type: 'assistant', timestamp: new Date(now - 3000).toISOString(), message: { content: [{ type: 'text', text: 'Step C continues' }] } },
      { type: 'user', timestamp: new Date(now - 2000).toISOString(), message: { content: 'normal prompt two' } },
    ];
    writeFileSync(sessionPath, rows.map((r) => JSON.stringify(r)).join('\n'));

    const session: SessionMeta = {
      path: sessionPath,
      firstTs: now - 5000,
      lastTs: now - 2000,
      promptCount: 2,
      filesTouched: new Set(),
    };
    const md = collectMarkdown(repo, 99, 'main', [session], { includeCode: false, scrubbers: [] });
    expect(md).toContain('### Plans');
    expect(md).toContain('Step A');
    expect(md).toContain('Step B');
    expect(md).toContain('Step C continues');
    expect(md).toContain('normal prompt one');
    expect(md).toContain('normal prompt two');
    expect(md).not.toContain('<command-name>'); // raw command row filtered out of prompts
    rmSync(fakeHome, { recursive: true, force: true });
  });

  test('collectMarkdown captures /plan response from OMP session shape', async () => {
    const { collectMarkdown } = await import('../src/core/sanitize.ts');
    const fakeHome = mkdtempSync(join(tmpdir(), 'plan-omp-home-'));
    const repo = join(fakeHome, 'repo');
    mkdirSync(repo, { recursive: true });

    const sessionPath = join(fakeHome, 'session.jsonl');
    const now = Date.now();
    const rows = [
      { type: 'message', timestamp: new Date(now - 5000).toISOString(), message: { role: 'user', attribution: 'user', content: [{ type: 'text', text: 'normal prompt one' }] } },
      { type: 'message', timestamp: new Date(now - 4000).toISOString(), message: { role: 'user', attribution: 'user', content: [{ type: 'text', text: '<command-name>/plan</command-name>' }] } },
      { type: 'message', timestamp: new Date(now - 3500).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Plan body: do X then Y' }] } },
      { type: 'message', timestamp: new Date(now - 2000).toISOString(), message: { role: 'user', attribution: 'user', content: [{ type: 'text', text: 'normal prompt two' }] } },
    ];
    writeFileSync(sessionPath, rows.map((r) => JSON.stringify(r)).join('\n'));

    const session: SessionMeta = {
      path: sessionPath,
      firstTs: now - 5000,
      lastTs: now - 2000,
      promptCount: 2,
      filesTouched: new Set(),
    };
    const md = collectMarkdown(repo, 100, 'main', [session], { includeCode: false, scrubbers: [] });
    expect(md).toContain('### Plans');
    expect(md).toContain('Plan body: do X then Y');
    expect(md).toContain('normal prompt one');
    expect(md).toContain('normal prompt two');
    rmSync(fakeHome, { recursive: true, force: true });
  });

  test('sessions without /plan invocations do not emit a Plans section', async () => {
    const { collectMarkdown } = await import('../src/core/sanitize.ts');
    const fakeHome = mkdtempSync(join(tmpdir(), 'noplan-home-'));
    const sessionPath = join(fakeHome, 'session.jsonl');
    const now = Date.now();
    const rows = [
      { type: 'user', timestamp: new Date(now - 5000).toISOString(), message: { content: 'just a normal prompt' } },
      { type: 'assistant', timestamp: new Date(now - 4500).toISOString(), message: { content: [{ type: 'text', text: 'just a normal reply' }] } },
    ];
    writeFileSync(sessionPath, rows.map((r) => JSON.stringify(r)).join('\n'));

    const session: SessionMeta = {
      path: sessionPath,
      firstTs: now - 5000,
      lastTs: now - 4500,
      promptCount: 1,
      filesTouched: new Set(),
    };
    const md = collectMarkdown(fakeHome, 101, 'main', [session], { includeCode: false, scrubbers: [] });
    expect(md).not.toContain('### Plans');
    expect(md).toContain('### Prompts');
    rmSync(fakeHome, { recursive: true, force: true });
  });
});

describe('Scrubber semantics', () => {
  // The scrubber rules are private to the CLI, but we can test their effect
  // by passing a synthetic markdown through `collect` with a fixture session.
  test('scrub-rules output uses the documented patterns', () => {
    const r = runCli('scrub-rules');
    expect(r.stdout).toContain('REDACTED-CREDENTIAL');
    expect(r.stdout).toContain('REDACTED-EMAIL');
    expect(r.stdout).toContain('/Users/REDACTED/');
  });
});

describe('C2 — transcript content is treated as untrusted', () => {
  test('sanitize audit-block strips code blocks, neutralizes links/html, escapes fences, and merges custom scrubbers', () => {
    const custom: ScrubRule = { name: 'ticket', description: 'Ticket IDs', pattern: /TICKET-[0-9]+/g, replacement: '[REDACTED-TICKET]', enabled: true };
    const out = sanitize(
      'See [label](https://evil.example) ![alt](https://img.example) <script>x</script> TICKET-123\n' +
        '```ts\nconst secret = "x";\n```\n```',
      'audit-block',
      { scrubbers: [custom] },
    );

    expect(out).toContain('label (https://evil.example)');
    expect(out).toContain('[image: https://img.example]');
    expect(out).not.toContain('<script>');
    expect(out).toContain('[REDACTED-TICKET]');
    expect(out).toContain('[code block stripped]');
    expect(out).not.toContain('```');
    expect(out).toContain('` ` `');
  });

  test('sanitize handoff-inline collapses whitespace, keeps code text, neutralizes markdown, and truncates', () => {
    const out = sanitize('one\n[two](https://example.test)   ```js\nthree\n``` four', 'handoff-inline', { maxLength: 40 });

    expect(out).toBe('one two (https://example.test) ` ` `js t');
    expect(out.length).toBe(40);
  });
});

describe('C3 — JSONL reading rejects unsafe files', () => {
  let fakeHome: string;
  let projectsDir: string;
  let encoded: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'pp-c3-'));
    projectsDir = join(fakeHome, '.claude', 'projects');
    mkdirSync(projectsDir, { recursive: true });
    encoded = encodeCwd('/fake/repo');
    mkdirSync(join(projectsDir, encoded));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  test('symlinked .jsonl is ignored', () => {
    const real = join(fakeHome, 'real.jsonl');
    writeFileSync(real, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: 'evil' } }));
    spawnSync('ln', ['-s', real, join(projectsDir, encoded, 'symlinked.jsonl')]);

    expect(loadRepoSessions('/fake/repo', 'claude', projectsDir)).toEqual([]);
  });
});

describe('Core session and scope helpers', () => {
  test('encodeCwd replaces slashes and dots', () => {
    expect(encodeCwd('/tmp/foo.bar')).toBe('-tmp-foo-bar');
    expect(encodeCwd('/Users/noam.siegel/some/repo')).toBe('-Users-noam-siegel-some-repo');
  });

  test('normalizeToRepoRelative handles absolute, relative, and outside-repo paths', () => {
    const scope = normalizeToRepoRelative(['/repo/src/a.ts', 'src/b.ts', '/elsewhere/src/c.ts', '../outside.ts'], '/repo');

    expect(scope.repoRelative).toEqual(new Set(['src/a.ts', 'src/b.ts']));
  });

  test('intersectsScope does not false-match basename collisions', () => {
    const session: SessionMeta = {
      path: 's.jsonl',
      firstTs: 0,
      lastTs: 1,
      promptCount: 1,
      filesTouched: new Set(['/repo/packages/a/src/index.ts']),
    };

    expect(intersectsScope(session, normalizeToRepoRelative(['packages/b/src/index.ts'], '/repo'), '/repo')).toBe(false);
    expect(intersectsScope(session, normalizeToRepoRelative(['packages/a/src/index.ts'], '/repo'), '/repo')).toBe(true);
  });
});
