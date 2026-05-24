import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPostingPlan, normalizeRepoVisibility, type PostingPlanInput, type RepoVisibility } from '../src/core/posting-plan.ts';
import { encodeCwd } from '../src/core/session.ts';
import type { GitleaksFinding } from '../src/adapters/gitleaks.ts';

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

const finding: GitleaksFinding = { rule: 'generic-api-key', description: 'Generic API Key', file: 'gist.md', line: 1 };
const flags = (overrides: Partial<PostingPlanInput['flags']> = {}): PostingPlanInput['flags'] => ({
  publicOk: false,
  noAttach: false,
  dryRun: false,
  force: false,
  ...overrides,
});

function expected(input: PostingPlanInput): { allow: boolean; reason: string } {
  if (input.flags.dryRun) return { allow: true, reason: 'dry-run allowed; no network mutation will occur' };
  if (input.gitleaksFindings.length > 0 && !input.flags.force) return { allow: false, reason: `gitleaks found ${input.gitleaksFindings.length} potential secret${input.gitleaksFindings.length === 1 ? '' : 's'}; use --force to override` };
  if (input.visibility === 'public' && !input.flags.publicOk) return { allow: false, reason: 'public repository requires --public-ok before posting agents-trace gist URL' };
  if (input.visibility === 'unknown' && !input.flags.publicOk) return { allow: false, reason: 'unknown repository visibility requires --public-ok before posting agents-trace gist URL' };
  if (input.flags.noAttach && input.action === 'reattach') return { allow: false, reason: '--no-attach is incompatible with re-attach' };
  return { allow: true, reason: 'posting permitted' };
}

describe('buildPostingPlan', () => {
  test('covers visibility × publicOk × noAttach × dryRun × force × gitleaks × action', () => {
    const visibilities: RepoVisibility[] = ['public', 'private', 'unknown'];
    const booleans = [false, true];
    const actions: PostingPlanInput['action'][] = ['create', 'reattach'];
    let rows = 0;

    for (const visibility of visibilities) {
      for (const publicOk of booleans) {
        for (const noAttach of booleans) {
          for (const dryRun of booleans) {
            for (const force of booleans) {
              for (const hasFinding of booleans) {
                for (const action of actions) {
                  const input: PostingPlanInput = {
                    visibility,
                    flags: flags({ publicOk, noAttach, dryRun, force }),
                    gitleaksFindings: hasFinding ? [finding] : [],
                    action,
                  };
                  expect(buildPostingPlan(input)).toEqual(expected(input));
                  rows++;
                }
              }
            }
          }
        }
      }
    }

    expect(rows).toBe(3 * 2 * 2 * 2 * 2 * 2 * 2);
  });

  test('normalizes GitHub visibility values into posting-plan visibility', () => {
    expect(normalizeRepoVisibility('PUBLIC')).toBe('public');
    expect(normalizeRepoVisibility('UNKNOWN')).toBe('unknown');
    expect(normalizeRepoVisibility('PRIVATE')).toBe('private');
    expect(normalizeRepoVisibility('INTERNAL')).toBe('private');
  });
});

describe('cmdGistCreate posting-plan integration', () => {
  let fakeHome: string | undefined;
  let actualSessionDir: string | undefined;

  afterEach(() => {
    if (fakeHome) rmSync(fakeHome, { recursive: true, force: true });
    if (actualSessionDir) rmSync(actualSessionDir, { recursive: true, force: true });
    fakeHome = undefined;
    actualSessionDir = undefined;
  });

  test('calls planner exactly once and skips network mutation when verdict is dry-run allow', async () => {
    ({ home: fakeHome, actualSessionDir } = makeFixtureHome());
    process.env.HOME = fakeHome;
    const { cmdGistCreate } = await import(`../cli.ts?dryrun=${Date.now()}`);
    const repo = join(fakeHome, 'repo');
    let plannerCalls = 0;
    let upserts = 0;
    const ghClient = {
      async readPrContext() {
        return { number: 7, baseRef: 'main', visibility: 'PUBLIC', nameWithOwner: 'owner/repo' };
      },
      async readPrBody() {
        return '';
      },
      async findAttachedAgentsTraceGist() {
        return null;
      },
      async upsertAgentsTraceGist() {
        upserts++;
        return { id: '1', url: 'https://gist.github.com/1' };
      },
      async writeAgentsTraceLink() {},
    };
    const gitleaksRunner = { async run() { return [] as GitleaksFinding[]; } };
    const args = baseArgs(repo, { dryRun: true });

    await cmdGistCreate(args, {
      ghClient,
      gitleaksRunner,
      planner(input: PostingPlanInput) {
        plannerCalls++;
        expect(input.visibility).toBe('public');
        expect(input.action).toBe('reattach');
        return buildPostingPlan(input);
      },
    });

    expect(plannerCalls).toBe(1);
    expect(upserts).toBe(0);
  });

  test('respects deny verdict before gist mutation', async () => {
    ({ home: fakeHome, actualSessionDir } = makeFixtureHome());
    process.env.HOME = fakeHome;
    const { cmdGistCreate } = await import(`../cli.ts?deny=${Date.now()}`);
    const repo = join(fakeHome, 'repo');
    let plannerCalls = 0;
    let upserts = 0;
    const originalExit = process.exit;
    process.exit = ((code?: string | number | null) => { throw new Error(`exit:${code}`); }) as typeof process.exit;

    try {
      await expect(cmdGistCreate(baseArgs(repo), {
        ghClient: {
          async readPrContext() {
            return { number: 7, baseRef: 'main', visibility: 'PRIVATE', nameWithOwner: 'owner/repo' };
          },
          async readPrBody() { return ''; },
          async findAttachedAgentsTraceGist() { return null; },
          async upsertAgentsTraceGist() { upserts++; return { id: '1', url: 'https://gist.github.com/1' }; },
          async writeAgentsTraceLink() {},
        },
        gitleaksRunner: { async run() { return [] as GitleaksFinding[]; } },
        planner() {
          plannerCalls++;
          return { allow: false, reason: 'blocked by plan' };
        },
      })).rejects.toThrow('exit:3');
    } finally {
      process.exit = originalExit;
    }

    expect(plannerCalls).toBe(1);
    expect(upserts).toBe(0);
  });
});

function baseArgs(repo: string, overrides: Partial<Args> = {}): Args {
  return {
    root: repo,
    graceMin: 30,
    scope: 'time',
    includeCode: false,
    dryRun: false,
    noAttach: false,
    force: false,
    public_: false,
    publicOk: false,
    rest: [],
    ...overrides,
  };
}

function makeFixtureHome(): { home: string; actualSessionDir: string } {
  const home = mkdtempSync(join(tmpdir(), 'pp-plan-'));
  const repo = join(home, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => spawnSync('git', ['-C', repo, ...args]);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.test');
  git('config', 'user.name', 'T');
  writeFileSync(join(repo, 'a.txt'), 'a');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('branch', 'origin/main', 'main');
  git('checkout', '-q', '-b', 'feature');
  writeFileSync(join(repo, 'a.txt'), 'aa');
  git('add', '.');
  git('commit', '-q', '-m', 'change');

  const encoded = encodeCwd(repo);
  const sessionDir = join(home, '.claude', 'projects', encoded);
  const actualSessionDir = join(homedir(), '.claude', 'projects', encoded);
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(actualSessionDir, { recursive: true });
  const now = Date.now();
  const rows = [
    { type: 'user', timestamp: new Date(now - 1000).toISOString(), message: { content: [{ type: 'text', text: 'change a.txt' }] } },
    { type: 'assistant', timestamp: new Date(now - 500).toISOString(), message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: join(repo, 'a.txt') } }] } },
  ];
  const content = rows.map((row) => JSON.stringify(row)).join('\n');
  writeFileSync(join(sessionDir, 'session.jsonl'), content);
  writeFileSync(join(actualSessionDir, 'session.jsonl'), content);
  return { home, actualSessionDir };
}
