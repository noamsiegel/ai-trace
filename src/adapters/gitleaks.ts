import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CommandRunner, realRunner } from './runner.ts';

export interface GitleaksFinding {
  rule: string;
  description: string;
  file: string;
  line: number;
}

interface GitleaksJsonFinding {
  RuleID?: string;
  Description?: string;
  File?: string;
  StartLine?: number;
  Line?: number;
}

export class GitleaksRunner {
  constructor(private runner: CommandRunner = realRunner) {}

  async run(text: string): Promise<GitleaksFinding[]> {
    const tmpDir = mkdirSync(join(tmpdir(), 'agents-trace-' + Date.now()), { recursive: true })!;
    const tmpFile = join(tmpDir, 'gist.md');
    writeFileSync(tmpFile, text);

    const result = await this.runner.run('gitleaks', ['detect', '--source', tmpDir, '--no-banner', '--redact', '--no-git', '--report-format', 'json']);
    if (result.status === 0) return [];

    const report = (result.stdout + result.stderr).trim();
    if (!report) {
      return [{ rule: 'gitleaks', description: 'gitleaks reported findings', file: tmpFile, line: 0 }];
    }

    try {
      const parsed = JSON.parse(report) as GitleaksJsonFinding[];
      if (!Array.isArray(parsed)) throw new Error('report is not an array');
      return parsed.map((finding) => ({
        rule: finding.RuleID ?? 'unknown',
        description: finding.Description ?? '',
        file: finding.File ?? tmpFile,
        line: finding.StartLine ?? finding.Line ?? 0,
      }));
    } catch {
      return [{ rule: 'gitleaks', description: report, file: tmpFile, line: 0 }];
    }
  }
}
