import { describe, expect, test } from 'bun:test';
import { GhClient, type CommandResult, type CommandRunner } from '../src/adapters/gh-client.ts';
import { buildPostingPlan } from '../src/core/posting-plan.ts';

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
    const plan = buildPostingPlan({ visibility: ctx.visibility, flags: {}, gitleaksResult: { ok: true }, action: 'gist-create' });

    expect(ctx.visibility).toBe('PUBLIC');
    expect(plan.allow).toBe(false);
  });

  test('findAttachedProvenanceGist extracts gist IDs from marker URLs', async () => {
    const client = new GhClient(new FakeRunner([]));

    await expect(client.findAttachedProvenanceGist('x\n🤖 AI Provenance: https://gist.github.com/noam/abc123def456\ny')).resolves.toBe('abc123def456');
    await expect(client.findAttachedProvenanceGist('🤖 AI Provenance: https://gist.github.com/deadbeef')).resolves.toBe('deadbeef');
    await expect(client.findAttachedProvenanceGist('no marker')).resolves.toBeNull();
  });

  test('upsertProvenanceGist edits existing gist when marker is attached', async () => {
    const runner = new FakeRunner([ok('')]);

    const gist = await new GhClient(runner).upsertProvenanceGist('abc123', '# body', 'AI provenance for PR #99');

    expect(gist).toEqual({ id: 'abc123', url: 'https://gist.github.com/abc123' });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.args.slice(0, 5)).toEqual(['gist', 'edit', 'abc123', '--filename', 'pr-99.md']);
  });

  test('upsertProvenanceGist falls back to create when editing existing gist fails', async () => {
    const runner = new FakeRunner([fail('not found'), ok('https://gist.github.com/newid987\n')]);

    const gist = await new GhClient(runner).upsertProvenanceGist('oldid123', '# body', 'AI provenance for PR #5');

    expect(gist).toEqual({ id: 'newid987', url: 'https://gist.github.com/newid987' });
    expect(runner.calls[0]!.args.slice(0, 5)).toEqual(['gist', 'edit', 'oldid123', '--filename', 'pr-5.md']);
    expect(runner.calls[1]!.args.slice(0, 4)).toEqual(['gist', 'create', '--secret', '--filename']);
    expect(runner.calls[1]!.args[4]).toBe('pr-5.md');
  });

  test('writeProvenanceLink replaces only marker URL and preserves other body content', async () => {
    const body = ['Intro', '', 'Keep this line https://example.test', '🤖 AI Provenance: https://gist.github.com/oldid123', '', 'Footer'].join('\n');
    const runner = new FakeRunner([ok(JSON.stringify({ body })), ok('')]);

    await new GhClient(runner).writeProvenanceLink(12, 'https://gist.github.com/newid987');

    expect(runner.calls[0]!.args).toEqual(['pr', 'view', '12', '--json', 'body']);
    expect(runner.calls[1]!.args.slice(0, 4)).toEqual(['pr', 'edit', '12', '--body']);
    expect(runner.calls[1]!.args[4]).toBe(['Intro', '', 'Keep this line https://example.test', '🤖 AI Provenance: https://gist.github.com/newid987', '', 'Footer'].join('\n'));
  });

  test('writeProvenanceLink appends marker when absent', async () => {
    const runner = new FakeRunner([ok(JSON.stringify({ body: 'Intro\n\nBody' })), ok('')]);

    await new GhClient(runner).writeProvenanceLink(14, 'https://gist.github.com/newid987');

    expect(runner.calls[1]!.args[4]).toBe('Intro\n\nBody\n\n---\n🤖 AI Provenance: https://gist.github.com/newid987\n');
  });
});
