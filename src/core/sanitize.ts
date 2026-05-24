import { safeReadJsonl, isRealPrompt, extractTextFromContent, type SessionMeta } from './session.ts';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ScrubRule {
  id: string;
  pattern: RegExp;
  replacement: string;
}

export type SanitizeMode = 'audit-block' | 'handoff-inline';
export type ScrubberConfig = ScrubRule[] | { scrubbers?: ScrubRule[]; includeCode?: boolean; maxLength?: number } | undefined;

export const DEFAULT_SCRUBBERS: ScrubRule[] = [
  { id: 'github-pat', pattern: /\b(ghp_|github_pat_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]{20,}\b/g, replacement: '[REDACTED-GITHUB-TOKEN]' },
  { id: 'aws-access-key', pattern: /\b(AKIA|ASIA|AROA|AIDA|AGPA|AIPA|ANPA|ANVA|ASCA|APKA)[0-9A-Z]{16}\b/g, replacement: '[REDACTED-AWS-ACCESS-KEY]' },
  { id: 'gcp-service-account', pattern: /\b[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com\b/g, replacement: '[REDACTED-GCP-SA]' },
  { id: 'slack-token', pattern: /\bxox[bpoars]-[A-Za-z0-9-]{10,}\b/g, replacement: '[REDACTED-SLACK-TOKEN]' },
  { id: 'stripe-live', pattern: /\bsk_live_[A-Za-z0-9]{20,}\b/g, replacement: '[REDACTED-STRIPE-LIVE]' },
  { id: 'openai-key', pattern: /\bsk-[A-Za-z0-9]{20,}\b/g, replacement: '[REDACTED-OPENAI-KEY]' },
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, replacement: '[REDACTED-ANTHROPIC-KEY]' },
  { id: 'sentry-dsn', pattern: /\bhttps:\/\/[a-f0-9]{32}@[a-zA-Z0-9.-]+\/[0-9]+\b/g, replacement: '[REDACTED-SENTRY-DSN]' },
  {
    id: 'api-keys',
    pattern: /(?<prefix>(?:api[_-]?key|secret|token|password|bearer|authorization)["\s:=]+)[A-Za-z0-9_\-./+=]{16,}/gi,
    replacement: '$<prefix>[REDACTED-CREDENTIAL]',
  },
  { id: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '[REDACTED-PRIVATE-KEY-BLOCK]' },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, replacement: '[REDACTED-JWT]' },
  { id: 'db-url-auth', pattern: /\b([a-z][a-z0-9+]*):\/\/[^:\s/@]+:[^@\s]+@/gi, replacement: '$1://[REDACTED-AUTH]@' },
  { id: 'emails', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: '[REDACTED-EMAIL]' },
  { id: 'home-paths', pattern: /\/Users\/[^/\s]+\//g, replacement: '/Users/REDACTED/' },
  { id: 'home-paths-linux', pattern: /\/home\/[^/\s]+\//g, replacement: '/home/REDACTED/' },
];

export function sanitize(rawText: string, mode: SanitizeMode, scrubberConfig?: ScrubberConfig): string {
  const rules = getRules(scrubberConfig);
  const includeCode = !Array.isArray(scrubberConfig) && scrubberConfig?.includeCode === true;
  let text = rawText;

  if (mode === 'audit-block' && !includeCode) text = stripCodeBlocks(text);
  text = applyScrubbers(text, rules);
  text = neutralizeUntrustedText(text);
  text = escapeMarkdownFences(text);

  if (mode === 'handoff-inline') {
    const maxLength = !Array.isArray(scrubberConfig) && scrubberConfig?.maxLength ? scrubberConfig.maxLength : 300;
    text = text.replaceAll(/\s+/g, ' ').slice(0, maxLength);
  }

  return text;
}

interface CollectOptions {
  includeCode: boolean;
  scrubbers: ScrubRule[];
}

export function collectMarkdown(repoRoot: string, prNum: number, baseRef: string, sessions: SessionMeta[], opts: CollectOptions): string {
  const lines: string[] = [];
  lines.push(`# AI Provenance for PR #${prNum}`);
  lines.push('');
  lines.push(`Captured: ${new Date().toISOString()}`);
  lines.push(`Repo: ${sanitize(repoRoot, 'audit-block', { scrubbers: opts.scrubbers, includeCode: true })}`);
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
      if (++rowCount > 50000) break;
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
      const text = sanitize(extractTextFromContent(row.message?.content).trim(), 'audit-block', {
        scrubbers: opts.scrubbers,
        includeCode: opts.includeCode,
      });
      lines.push(`**Prompt ${n}** (${ts}):`);
      lines.push('');
      lines.push('```text');
      lines.push(text);
      lines.push('```');
      lines.push('');
    }
  }

  return lines.join('\n');
}

export function applyScrubbers(s: string, rules: ScrubRule[]): string {
  let out = s;
  for (const r of rules) out = out.replaceAll(r.pattern, r.replacement);
  return out;
}

export function neutralizeUntrustedText(s: string): string {
  return s
    .replaceAll(/!\[([^\]]*)\]\(([^)]*)\)/g, '[image: $2]')
    .replaceAll(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replaceAll(/<\/?[a-zA-Z][^>]*>/g, '');
}

export function stripCodeBlocks(s: string): string {
  return s.replaceAll(/```[\s\S]*?```/g, '[code block stripped]');
}

export function escapeMarkdownFences(s: string): string {
  return s.replaceAll(/```/g, '` ` `');
}

export function loadScrubbers(configJson = join(homedir(), '.config', 'provenance', 'config.json')): ScrubRule[] {
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

function getRules(config: ScrubberConfig): ScrubRule[] {
  if (Array.isArray(config)) return config;
  return [...DEFAULT_SCRUBBERS, ...(config?.scrubbers ?? [])];
}
