import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(cmd: string, args: string[], opts?: { input?: string; cwd?: string }): Promise<CommandResult>;
}

export type RepoVisibility = 'PUBLIC' | 'PRIVATE' | 'INTERNAL' | 'UNKNOWN';

export interface PrContext {
  number: number;
  baseRef: string;
  visibility: RepoVisibility;
  nameWithOwner: string;
}

export const PROVENANCE_MARKER = '🤖 AI Provenance:';

export const realRunner: CommandRunner = {
  async run(cmd: string, args: string[], opts: { input?: string; cwd?: string } = {}): Promise<CommandResult> {
    const proc = Bun.spawn([cmd, ...args], {
      cwd: opts.cwd,
      stdin: opts.input === undefined ? 'ignore' : 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (opts.input !== undefined) {
      proc.stdin?.write(opts.input);
      proc.stdin?.end();
    }

    const [stdout, stderr, status] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { status, stdout, stderr };
  },
};

export class GhClient {
  constructor(private runner: CommandRunner = realRunner) {}

  async readPrContext(repoRoot: string, branch?: string): Promise<PrContext> {
    const fields = 'number,baseRefName,headRepository';
    const args = branch ? ['pr', 'view', this.parsePrNumber(branch), '--json', fields] : ['pr', 'view', '--json', fields];
    const meta = await this.runner.run('gh', args, { cwd: repoRoot });
    if (meta.status !== 0) {
      throw new Error(branch ? `gh pr view ${this.parsePrNumber(branch)} failed: ${meta.stderr.trim()}` : `no PR for current branch (run with --pr <num>): ${meta.stderr.trim()}`);
    }

    const data = JSON.parse(meta.stdout) as { number: number; baseRefName: string; headRepository?: { nameWithOwner?: string } };
    const repo = data.headRepository?.nameWithOwner ?? '';
    const visMeta = await this.runner.run('gh', ['repo', 'view', repo, '--json', 'visibility,nameWithOwner'], { cwd: repoRoot });
    const visData = visMeta.status === 0 ? (JSON.parse(visMeta.stdout) as { visibility?: RepoVisibility; nameWithOwner?: string }) : null;

    return {
      number: data.number,
      baseRef: data.baseRefName,
      visibility: visData?.visibility ?? 'UNKNOWN',
      nameWithOwner: visData?.nameWithOwner ?? repo,
    };
  }
  async readPrBody(prNumber: number): Promise<string | null> {
    const view = await this.runner.run('gh', ['pr', 'view', String(prNumber), '--json', 'body']);
    if (view.status !== 0) return null;
    return (JSON.parse(view.stdout).body as string) ?? '';
  }

  async findAttachedProvenanceGist(prBody: string): Promise<string | null> {
    const m = prBody.match(/🤖 AI Provenance:\s*https:\/\/gist\.github\.com\/(?:[^/\s]+\/)?([a-f0-9]+)/);
    return m ? m[1]! : null;
  }

  async upsertProvenanceGist(gistId: string | null, content: string, description: string, public_ = false): Promise<{ id: string; url: string }> {
    const tmpDir = join(tmpdir(), 'provenance-' + Date.now());
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, this.filenameFromDescription(description));
    writeFileSync(tmpFile, content);

    if (gistId) {
      const editOut = await this.runner.run('gh', ['gist', 'edit', gistId, '--filename', this.filenameFromDescription(description), tmpFile]);
      if (editOut.status === 0) {
        return { id: gistId, url: `https://gist.github.com/${gistId}` };
      }
    }

    const created = await this.runner.run('gh', ['gist', 'create', public_ ? '--public' : '--secret', '--filename', this.filenameFromDescription(description), tmpFile]);
    if (created.status !== 0) {
      throw new Error(`gh gist create failed: ${created.stderr.trim()}`);
    }

    const url = created.stdout.trim().split('\n').pop()!;
    return { id: this.gistIdFromUrl(url), url };
  }

  async writeProvenanceLink(prNumber: number, gistUrl: string): Promise<void> {
    const view = await this.runner.run('gh', ['pr', 'view', String(prNumber), '--json', 'body']);
    if (view.status !== 0) throw new Error(`gh pr view failed: ${view.stderr.trim()}`);

    let body = (JSON.parse(view.stdout).body as string) ?? '';
    if (body.includes(PROVENANCE_MARKER)) {
      body = body.replaceAll(new RegExp(`${PROVENANCE_MARKER} \\S+`, 'g'), `${PROVENANCE_MARKER} ${gistUrl}`);
    } else {
      body = body.trim() + `\n\n---\n${PROVENANCE_MARKER} ${gistUrl}\n`;
    }

    const edit = await this.runner.run('gh', ['pr', 'edit', String(prNumber), '--body', body]);
    if (edit.status !== 0) throw new Error(`gh pr edit failed: ${edit.stderr.trim()}`);
  }

  private parsePrNumber(input: string): string {
    const m = input.match(/(?:\/pull\/)?(\d+)$/);
    if (!m) throw new Error(`could not parse PR number from --pr ${input}`);
    return m[1]!;
  }

  private gistIdFromUrl(url: string): string {
    return url.trim().split('/').pop() ?? '';
  }

  private filenameFromDescription(description: string): string {
    const m = description.match(/PR #(\d+)/);
    return m ? `pr-${m[1]}.md` : 'provenance.md';
  }
}
