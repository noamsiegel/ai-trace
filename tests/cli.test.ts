/**
 * provenance CLI tests.
 *
 * Run: bun test ~/.pai/skills/provenance/tests/cli.test.ts
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
import { normalizeToRepoRelative, intersectsScope } from '../src/core/scope.ts';
import { sanitize, type ScrubRule } from '../src/core/sanitize.ts';
import { buildPostingPlan, type RepoVisibility } from '../src/core/posting-plan.ts';

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
    expect(r.stdout).toContain('provenance');
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
  test('default scope (both) requires file-overlap; session with no file_path → no match', () => {
    const r = spawnSync('bun', [CLI, 'sessions-since', 'main', '--root', repo], {
      encoding: 'utf8',
      env: { ...process.env, HOME: fakeHome },
    });
    expect(r.status).toBe(0);
    // The fixture session has prompts but no `file_path` references, so under
    // 'both' scope (time AND file overlap) there's no match.
    expect(r.stdout).toContain('No overlapping sessions');
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
    const custom: ScrubRule = { id: 'ticket', pattern: /TICKET-[0-9]+/g, replacement: '[REDACTED-TICKET]' };
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

    expect(loadRepoSessions('/fake/repo', projectsDir)).toEqual([]);
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

describe('Posting plan', () => {
  const visibilities: RepoVisibility[] = ['PUBLIC', 'UNKNOWN', 'PRIVATE'];

  test('visibility gates attaching unless explicitly overridden', () => {
    for (const visibility of visibilities) {
      const plan = buildPostingPlan({ visibility, flags: {}, gitleaksResult: { ok: true }, action: 'gist-create' });
      expect(plan.allow).toBe(visibility === 'PRIVATE');
    }

    expect(buildPostingPlan({ visibility: 'PUBLIC', flags: { publicOk: true }, gitleaksResult: { ok: true }, action: 'gist-create' }).allow).toBe(true);
    expect(buildPostingPlan({ visibility: 'UNKNOWN', flags: { publicOk: true }, gitleaksResult: { ok: true }, action: 'gist-create' }).allow).toBe(true);
  });

  test('no-attach avoids public visibility attach gate', () => {
    expect(buildPostingPlan({ visibility: 'PUBLIC', flags: { noAttach: true }, gitleaksResult: { ok: true }, action: 'gist-create' }).allow).toBe(true);
  });

  test('dry-run does not override gitleaks without force', () => {
    expect(buildPostingPlan({ visibility: 'PRIVATE', flags: { dryRun: true }, gitleaksResult: { ok: false }, action: 'gist-create' }).allow).toBe(false);
  });

  test('force overrides gitleaks failure after visibility passes', () => {
    expect(buildPostingPlan({ visibility: 'PRIVATE', flags: { force: true }, gitleaksResult: { ok: false }, action: 'gist-create' }).allow).toBe(true);
    expect(buildPostingPlan({ visibility: 'PUBLIC', flags: { force: true }, gitleaksResult: { ok: false }, action: 'gist-create' }).allow).toBe(false);
  });
});
