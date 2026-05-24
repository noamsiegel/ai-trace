import { describe, expect, test } from 'bun:test';
import { GhClient } from '../src/adapters/gh-client.ts';
import { type CommandResult, type CommandRunner } from '../src/adapters/runner.ts';
import { buildPostingPlan, normalizeRepoVisibility } from '../src/core/posting-plan.ts';

class FakeRunner implements CommandRunner {
  readonly calls: { cmd: string; args: string[]; input?: string; cwd?: string }[] = [];

  constructor(private responses: CommandResult[]) {}

  async run(cmd: string, args: string[], opts: { input?: string; cwd?: string } = {}): Promise<CommandResult> {
    this.calls.push({ cmd, args, input: opts.input, cwd: opts.cwd });
    const response = this.responses.shift();
    if (!response) throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    return response;
  }
}

const ok = (stdout = ''): CommandResult => ({ status: 0, stdout, stderr: '' });
const fail = (stderr = 'failed'): CommandResult => ({ status: 1, stdout: '', stderr });

describe('GhClient', () => {
  test('readPrContext parses PR metadata and repo visibility', async () => {
    const runner = new FakeRunner([
      ok(JSON.stringify({ number: 42, baseRefName: 'main', headRepository: { nameWithOwner: 'owner/repo' } })),
      ok(JSON.stringify({ visibility: 'PRIVATE', nameWithOwner: 'owner/repo' })),
    ]);

    const ctx = await new GhClient(runner).readPrContext('/repo', '42');

    expect(ctx).toEqual({ number: 42, baseRef: 'main', visibility: 'PRIVATE', nameWithOwner: 'owner/repo' });
    expect(runner.calls[0]).toMatchObject({ cmd: 'gh', args: ['pr', 'view', '42', '--json', 'number,baseRefName,headRepository'], cwd: '/repo' });
    expect(runner.calls[1]).toMatchObject({ cmd: 'gh', args: ['repo', 'view', 'owner/repo', '--json', 'visibility,nameWithOwner'], cwd: '/repo' });
  });

  test('readPrContext passes public visibility through to posting-plan refusal', async () => {
    const runner = new FakeRunner([
      ok(JSON.stringify({ number: 7, baseRefName: 'main', headRepository: { nameWithOwner: 'owner/public-repo' } })),
      ok(JSON.stringify({ visibility: 'PUBLIC', nameWithOwner: 'owner/public-repo' })),
    ]);

    const ctx = await new GhClient(runner).readPrContext('/repo', '7');
    const plan = buildPostingPlan({ visibility: normalizeRepoVisibility(ctx.visibility), flags: { publicOk: false, noAttach: false, dryRun: false, force: false }, gitleaksFindings: [], action: 'reattach' });

    expect(ctx.visibility).toBe('PUBLIC');
    expect(plan.allow).toBe(false);
  });

  test('findAttachedAgentsTraceGist extracts gist IDs from agents-trace marker URLs', async () => {
    const client = new GhClient(new FakeRunner([]));

    await expect(client.findAttachedAgentsTraceGist('🤖 agents-trace: https://gist.github.com/noam/feed123')).resolves.toBe('feed123');
    await expect(client.findAttachedAgentsTraceGist('no marker')).resolves.toBeNull();
  });

  test('upsertAgentsTraceGist edits existing gist when marker is attached', async () => {
    const runner = new FakeRunner([ok('')]);

    const gist = await new GhClient(runner).upsertAgentsTraceGist('abc123', '# body', 'agents-trace for PR #99');

    expect(gist).toEqual({ id: 'abc123', url: 'https://gist.github.com/abc123' });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.args.slice(0, 5)).toEqual(['gist', 'edit', 'abc123', '--filename', 'pr-99.md']);
  });

  test('upsertAgentsTraceGist falls back to create when editing existing gist fails', async () => {
    const runner = new FakeRunner([fail('not found'), ok('https://gist.github.com/def456\n')]);

    const gist = await new GhClient(runner).upsertAgentsTraceGist('abc123', '# body', 'agents-trace for PR #5');

    expect(gist).toEqual({ id: 'def456', url: 'https://gist.github.com/def456' });
    expect(runner.calls[0]!.args.slice(0, 5)).toEqual(['gist', 'edit', 'abc123', '--filename', 'pr-5.md']);
    expect(runner.calls[1]!.args.slice(0, 4)).toEqual(['gist', 'create', '--secret', '--filename']);
    expect(runner.calls[1]!.args[4]).toBe('pr-5.md');
  });

  test('writeAgentsTraceLink replaces only marker URL and preserves other body content', async () => {
    const body = ['Intro', '', 'Keep this line https://example.test', '🤖 agents-trace: https://gist.github.com/abc123', '', 'Footer'].join('\n');
    const runner = new FakeRunner([ok(JSON.stringify({ body })), ok('')]);

    await new GhClient(runner).writeAgentsTraceLink(12, 'https://gist.github.com/def456');

    expect(runner.calls[0]!.args).toEqual(['pr', 'view', '12', '--json', 'body']);
    expect(runner.calls[1]!.args.slice(0, 4)).toEqual(['pr', 'edit', '12', '--body']);
    expect(runner.calls[1]!.args[4]).toBe(['Intro', '', 'Keep this line https://example.test', '🤖 agents-trace: https://gist.github.com/def456', '', 'Footer'].join('\n'));
  });
  test('writeAgentsTraceLink replaces new marker URL without duplicating marker', async () => {
    const body = ['Intro', '🤖 agents-trace: https://gist.github.com/abc123'].join('\n');
    const runner = new FakeRunner([ok(JSON.stringify({ body })), ok('')]);

    await new GhClient(runner).writeAgentsTraceLink(12, 'https://gist.github.com/def456');

    expect(runner.calls[1]!.args[4]).toBe(['Intro', '🤖 agents-trace: https://gist.github.com/def456'].join('\n'));
    expect((runner.calls[1]!.args[4]!.match(/🤖 agents-trace:/g) ?? [])).toHaveLength(1);
  });

  test('writeAgentsTraceLink appends marker when absent', async () => {
    const runner = new FakeRunner([ok(JSON.stringify({ body: 'Intro\n\nBody' })), ok('')]);

    await new GhClient(runner).writeAgentsTraceLink(14, 'https://gist.github.com/def456');

    expect(runner.calls[1]!.args[4]).toBe('Intro\n\nBody\n\n---\n🤖 agents-trace: https://gist.github.com/def456\n');
  });
});
