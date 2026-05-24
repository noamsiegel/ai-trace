import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Scrubber {
  name: string;
  description: string;
  pattern: RegExp;
  replacement: string;
  enabled: boolean;
}

export interface UserScrubberConfig {
  scrubbers?: {
    disable?: string[];
    add?: Array<{
      name?: string;
      pattern?: string;
      replacement?: string;
      flags?: string;
      description?: string;
      enabled?: boolean;
    }>;
  };
}

export const BUILTIN_SCRUBBERS: Scrubber[] = [
  {
    name: 'github-pat',
    description: 'GitHub personal access tokens and fine-grained tokens',
    pattern: /\b(ghp_|github_pat_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]{20,}\b/g,
    replacement: '[REDACTED-GITHUB-TOKEN]',
    enabled: true,
  },
  {
    name: 'aws-access-key',
    description: 'AWS access key identifiers',
    pattern: /\b(AKIA|ASIA|AROA|AIDA|AGPA|AIPA|ANPA|ANVA|ASCA|APKA)[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED-AWS-ACCESS-KEY]',
    enabled: true,
  },
  {
    name: 'gcp-service-account',
    description: 'Google Cloud service account email addresses',
    pattern: /\b[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com\b/g,
    replacement: '[REDACTED-GCP-SA]',
    enabled: true,
  },
  {
    name: 'slack-token',
    description: 'Slack bot, user, app, and refresh tokens',
    pattern: /\bxox[bpoars]-[A-Za-z0-9-]{10,}\b/g,
    replacement: '[REDACTED-SLACK-TOKEN]',
    enabled: true,
  },
  {
    name: 'stripe-live',
    description: 'Stripe live secret keys',
    pattern: /\bsk_live_[A-Za-z0-9]{20,}\b/g,
    replacement: '[REDACTED-STRIPE-LIVE]',
    enabled: true,
  },
  {
    name: 'openai-key',
    description: 'OpenAI API keys',
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/g,
    replacement: '[REDACTED-OPENAI-KEY]',
    enabled: true,
  },
  {
    name: 'anthropic-key',
    description: 'Anthropic API keys',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED-ANTHROPIC-KEY]',
    enabled: true,
  },
  {
    name: 'sentry-dsn',
    description: 'Sentry DSN URLs',
    pattern: /\bhttps:\/\/[a-f0-9]{32}@[a-zA-Z0-9.-]+\/[0-9]+\b/g,
    replacement: '[REDACTED-SENTRY-DSN]',
    enabled: true,
  },
  {
    name: 'api-keys',
    description: 'Generic API key, secret, token, password, bearer, and authorization values',
    pattern: /(?<prefix>(?:api[_-]?key|secret|token|password|bearer|authorization)["\s:=]+)[A-Za-z0-9_\-./+=]{16,}/gi,
    replacement: '$<prefix>[REDACTED-CREDENTIAL]',
    enabled: true,
  },
  {
    name: 'private-key-block',
    description: 'PEM private key blocks',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED-PRIVATE-KEY-BLOCK]',
    enabled: true,
  },
  {
    name: 'jwt',
    description: 'JSON Web Tokens',
    pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replacement: '[REDACTED-JWT]',
    enabled: true,
  },
  {
    name: 'db-url-auth',
    description: 'Credentials embedded in database or service URLs',
    pattern: /\b([a-z][a-z0-9+]*):\/\/[^:\s/@]+:[^@\s]+@/gi,
    replacement: '$1://[REDACTED-AUTH]@',
    enabled: true,
  },
  {
    name: 'emails',
    description: 'Email addresses',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: '[REDACTED-EMAIL]',
    enabled: true,
  },
  {
    name: 'home-paths',
    description: 'macOS user home paths',
    pattern: /\/Users\/[^/\s]+\//g,
    replacement: '/Users/REDACTED/',
    enabled: true,
  },
  {
    name: 'home-paths-linux',
    description: 'Linux user home paths',
    pattern: /\/home\/[^/\s]+\//g,
    replacement: '/home/REDACTED/',
    enabled: true,
  },
];

export function composeScrubbers(userConfig: UserScrubberConfig = {}): Scrubber[] {
  const disabled = new Set(userConfig.scrubbers?.disable ?? []);
  const scrubbers = BUILTIN_SCRUBBERS.map((scrubber) => ({
    ...scrubber,
    enabled: scrubber.enabled && !disabled.has(scrubber.name),
  }));

  for (const entry of userConfig.scrubbers?.add ?? []) {
    if (!entry.name || !entry.pattern || entry.replacement === undefined) continue;
    let pattern: RegExp;
    try {
      pattern = new RegExp(entry.pattern, entry.flags ?? 'g');
    } catch (e) {
      console.error(`agents-trace: bad scrubber regex '${entry.name}': ${(e as Error).message}`);
      continue;
    }

    const duplicate = scrubbers.findIndex((scrubber) => scrubber.name === entry.name);
    if (duplicate !== -1) scrubbers.splice(duplicate, 1);
    scrubbers.push({
      name: entry.name,
      description: entry.description ?? 'User-configured scrubber',
      pattern,
      replacement: entry.replacement,
      enabled: entry.enabled ?? true,
    });
  }

  return scrubbers.filter((scrubber) => scrubber.enabled);
}

export function loadScrubberConfig(configJson = join(homedir(), '.config', 'agents-trace', 'config.json')): UserScrubberConfig {
  if (!existsSync(configJson)) return {};

  try {
    const parsed = JSON.parse(readFileSync(configJson, 'utf8')) as UserScrubberConfig | LegacyScrubberConfig;
    return normalizeScrubberConfig(parsed);
  } catch (e) {
    console.error(`agents-trace: could not load ${configJson}: ${(e as Error).message}`);
    return {};
  }
}

export function loadScrubbers(configJson?: string): Scrubber[] {
  return composeScrubbers(loadScrubberConfig(configJson));
}

interface LegacyScrubberConfig {
  scrubbers?: Array<{ id?: string; name?: string; pattern?: string; replacement?: string; flags?: string }>;
}

function normalizeScrubberConfig(config: UserScrubberConfig | LegacyScrubberConfig): UserScrubberConfig {
  if (Array.isArray(config.scrubbers)) {
    return {
      scrubbers: {
        add: config.scrubbers.map((scrubber) => ({
          name: scrubber.name ?? scrubber.id,
          pattern: scrubber.pattern,
          replacement: scrubber.replacement,
          flags: scrubber.flags,
        })),
      },
    };
  }

  return config as UserScrubberConfig;
}
