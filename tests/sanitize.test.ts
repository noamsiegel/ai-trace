import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyScrubbers, sanitize } from '../src/core/sanitize.ts';
import { BUILTIN_SCRUBBERS, composeScrubbers, loadScrubbers, type UserScrubberConfig } from '../src/core/scrubbers.ts';

const builtinSamples: Record<string, { input: string; output: string }> = {
  'github-pat': {
    input: 'token ghp_1234567890abcdefghijklmnop',
    output: '[REDACTED-GITHUB-TOKEN]',
  },
  'aws-access-key': {
    input: 'key AKIA1234567890ABCDEF',
    output: '[REDACTED-AWS-ACCESS-KEY]',
  },
  'gcp-service-account': {
    input: 'svc robot@project-1.iam.gserviceaccount.com',
    output: '[REDACTED-GCP-SA]',
  },
  'slack-token': {
    input: 'slack xoxb-1234567890abcdef',
    output: '[REDACTED-SLACK-TOKEN]',
  },
  'stripe-live': {
    input: 'stripe sk_live_1234567890abcdefghijkl',
    output: '[REDACTED-STRIPE-LIVE]',
  },
  'openai-key': {
    input: 'openai sk-1234567890abcdefghijkl',
    output: '[REDACTED-OPENAI-KEY]',
  },
  'anthropic-key': {
    input: 'anthropic sk-ant-1234567890abcdefghijkl',
    output: '[REDACTED-ANTHROPIC-KEY]',
  },
  'sentry-dsn': {
    input: 'dsn https://0123456789abcdef0123456789abcdef@sentry.example/123',
    output: '[REDACTED-SENTRY-DSN]',
  },
  'api-keys': {
    input: 'api_key=abcdef0123456789xyz',
    output: 'api_key=[REDACTED-CREDENTIAL]',
  },
  'private-key-block': {
    input: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
    output: '[REDACTED-PRIVATE-KEY-BLOCK]',
  },
  jwt: {
    input: 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature_123',
    output: '[REDACTED-JWT]',
  },
  'db-url-auth': {
    input: 'postgres://user:pass@db.example/app',
    output: 'postgres://[REDACTED-AUTH]@db.example/app',
  },
  emails: {
    input: 'email bob@example.com',
    output: '[REDACTED-EMAIL]',
  },
  'home-paths': {
    input: '/Users/noam/project/file.ts',
    output: '/Users/REDACTED/project/file.ts',
  },
  'home-paths-linux': {
    input: '/home/noam/project/file.ts',
    output: '/home/REDACTED/project/file.ts',
  },
};

describe('built-in scrubber registry', () => {
  test('all built-ins have unique names and required metadata', () => {
    expect(BUILTIN_SCRUBBERS.length).toBeGreaterThanOrEqual(15);
    expect(new Set(BUILTIN_SCRUBBERS.map((scrubber) => scrubber.name)).size).toBe(BUILTIN_SCRUBBERS.length);
    for (const scrubber of BUILTIN_SCRUBBERS) {
      expect(scrubber.name.length).toBeGreaterThan(0);
      expect(scrubber.description.length).toBeGreaterThan(0);
      expect(scrubber.replacement.length).toBeGreaterThan(0);
      expect(scrubber.enabled).toBe(true);
    }
  });

  for (const scrubber of BUILTIN_SCRUBBERS) {
    test(`${scrubber.name} redacts its target pattern`, () => {
      const sample = builtinSamples[scrubber.name];
      expect(sample).toBeDefined();
      expect(applyScrubbers(sample!.input, [scrubber])).toContain(sample!.output);
    });
  }
});

describe('composable scrubber pipeline', () => {
  let errors: string[];
  const originalError = console.error;

  afterEach(() => {
    console.error = originalError;
  });

  function captureWarnings() {
    errors = [];
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };
  }

  test('disabling a built-in by name removes it from the effective pipeline', () => {
    const scrubbers = composeScrubbers({ scrubbers: { disable: ['github-pat'] } });
    expect(scrubbers.some((scrubber) => scrubber.name === 'github-pat')).toBe(false);
    expect(sanitize('value=ghp_1234567890abcdefghijklmnop', 'audit-block', { scrubbers })).toContain('ghp_1234567890abcdefghijklmnop');
  });

  test('user-added scrubber matches its configured pattern', () => {
    const scrubbers = composeScrubbers({
      scrubbers: { add: [{ name: 'internal-id', pattern: 'INT-\\d+', replacement: '[INT-ID]' }] },
    });
    expect(sanitize('ticket INT-123', 'audit-block', { scrubbers })).toContain('[INT-ID]');
  });

  test('invalid user regex emits a warning, skips that scrubber, and keeps other scrubbers', () => {
    captureWarnings();
    const scrubbers = composeScrubbers({
      scrubbers: {
        add: [
          { name: 'broken', pattern: '[', replacement: '[BROKEN]' },
          { name: 'internal-id', pattern: 'INT-\\d+', replacement: '[INT-ID]' },
        ],
      },
    });

    expect(errors.join('\n')).toContain("bad scrubber regex 'broken'");
    expect(scrubbers.some((scrubber) => scrubber.name === 'broken')).toBe(false);
    expect(sanitize('email bob@example.com ticket INT-123', 'audit-block', { scrubbers })).toContain('[REDACTED-EMAIL]');
    expect(sanitize('email bob@example.com ticket INT-123', 'audit-block', { scrubbers })).toContain('[INT-ID]');
  });

  test('disable plus add produces the expected effective set', () => {
    const scrubbers = composeScrubbers({
      scrubbers: {
        disable: ['emails', 'github-pat'],
        add: [{ name: 'internal-id', pattern: 'INT-\\d+', replacement: '[INT-ID]' }],
      },
    });

    expect(scrubbers.some((scrubber) => scrubber.name === 'emails')).toBe(false);
    expect(scrubbers.some((scrubber) => scrubber.name === 'github-pat')).toBe(false);
    expect(scrubbers.at(-1)?.name).toBe('internal-id');
  });

  test('user-added duplicate name overrides a built-in', () => {
    const scrubbers = composeScrubbers({
      scrubbers: {
        add: [{ name: 'emails', pattern: 'bob@example\\.com', replacement: '[BOB]' }],
      },
    });

    expect(scrubbers.filter((scrubber) => scrubber.name === 'emails')).toHaveLength(1);
    expect(sanitize('bob@example.com alice@example.com', 'audit-block', { scrubbers })).toContain('[BOB]');
    expect(sanitize('bob@example.com alice@example.com', 'audit-block', { scrubbers })).toContain('alice@example.com');
  });

  test('built-ins run before user-added scrubbers', () => {
    const scrubbers = composeScrubbers({
      scrubbers: { add: [{ name: 'redacted-email-marker', pattern: '\\[REDACTED-EMAIL\\]', replacement: '[EMAIL-MARKER]' }] },
    });

    expect(sanitize('bob@example.com', 'audit-block', { scrubbers })).toContain('[EMAIL-MARKER]');
  });

  test('loadScrubbers reads disable and add entries from JSON config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agents-trace-config-'));
    try {
      const configDir = join(dir, '.config', 'agents-trace');
      mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, 'config.json');
      writeFileSync(
        configPath,
        JSON.stringify({ scrubbers: { disable: ['github-pat'], add: [{ name: 'internal-id', pattern: 'INT-\\d+', replacement: '[INT-ID]' }] } }),
      );

      const scrubbers = loadScrubbers(configPath);
      expect(scrubbers.some((scrubber) => scrubber.name === 'github-pat')).toBe(false);
      expect(scrubbers.some((scrubber) => scrubber.name === 'internal-id')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
