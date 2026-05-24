import { safeReadJsonl, isPromptRow, extractPromptText, type SessionMeta } from './session.ts';
import { type Scrubber, loadScrubbers } from './scrubbers.ts';

export type ScrubRule = Scrubber;
export type SanitizeMode = 'audit-block' | 'handoff-inline';
export type ScrubberConfig = Scrubber[] | { scrubbers?: Scrubber[]; includeCode?: boolean; maxLength?: number } | undefined;


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
  scrubbers: Scrubber[];
}

export function collectMarkdown(repoRoot: string, prNum: number, baseRef: string, sessions: SessionMeta[], opts: CollectOptions): string {
  const lines: string[] = [];
  lines.push(`# agents-trace for PR #${prNum}`);
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
      let row: { type?: string; timestamp?: string; message?: { content?: unknown }; payload?: unknown };
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isPromptRow(row)) continue;
      n++;
      const ts = row.timestamp ? new Date(row.timestamp).toISOString().slice(11, 19) : '';
      const text = sanitize(extractPromptText(row).trim(), 'audit-block', {
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

export function applyScrubbers(s: string, rules: Scrubber[]): string {
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

export { loadScrubbers };

function getRules(config: ScrubberConfig): ScrubRule[] {
  if (Array.isArray(config)) return config;
  return config?.scrubbers ?? loadScrubbers();
}
