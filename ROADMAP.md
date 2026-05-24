# agents-trace Roadmap

> Target architecture and quarterly milestones, derived from the
> `improve-codebase-architecture` audit on 2026-05-23.

## Current state (v0.8.0)

Single-file TypeScript CLI (`cli.ts`, ~930 LOC) running on Bun. The 2026-05
audit found these structural issues (ordered by leverage):

1. **Session identity reassembled per command** — `cmdCollect`, `cmdGistCreate`, `cmdHandoff` each compute encoded-cwd, load JSONL, filter, select differently. The `encodeCwd` bug (`/` replaced but not `.`) was a symptom of exactly this scattering.
2. **Sanitization pipeline scattered** — `collectMarkdown` strips code blocks + applies scrubbers + neutralizes markdown/HTML + escapes fences; `cmdHandoff` separately applies scrubbers + neutralizes + collapses whitespace + truncates. Tests for C2/C3 contain `expect(true).toBe(true)` placeholders because the surface is not directly callable.
3. **GitHub interactions raw** — `gh` invocations and JSON parsing scattered across `detectPr`, `cmdGistCreate`, `findExistingGistId`, `createGist`, `attachToPr`. No concrete boundary.
4. **Posting safety gates interleaved with mutation** — C1 public-block, C2 escaping, gitleaks gate, dry-run ordering all live inline in `cmdGistCreate`.
5. **File-overlap scoping uses string suffix matching** — `endsWith('/' + f)` can false-match nested paths with the same basename.
6. **No pure core** — importing `cli.ts` runs `main`. Tests use subprocess workarounds; security-critical branches are untestable from in-process.

## Target architecture

### Pure core (`src/core/`, no `process`, no `fs`, no `gh`)

```ts
// Session identity
type Session = { path: string; firstTs: number; lastTs: number; promptCount: number; filesTouched: Set<string> };
function encodeCwd(absPath: string): string;          // owns Claude / + . replacement invariant
function loadRepoSessions(repoRoot, source): Session[];
function selectSessionsForRange(sessions, baseRef, scope, graceMin): Session[];
function selectHandoffSession(sessions, name?): Session;

// File scope as a value
type FileScope = { repoRelative: Set<string> };
function normalizeToRepoRelative(paths, repoRoot): FileScope;
function intersectsScope(session, scope): boolean;

// Sanitization
type SanitizeMode = 'audit-block' | 'handoff-inline';
function sanitize(rawText, mode, scrubberConfig): string;

// Posting plan
type PostingPlan = { allow: boolean; reason: string };
function buildPostingPlan({ visibility, flags, gitleaksResult, action }): PostingPlan;
```

### Adapter layer (`src/adapters/`, concrete, unmocked)

- `GhClient` — `readPrContext` / `findAttachedAgentsTraceGist` / `upsertAgentsTraceGist` / `writeAgentsTraceLink`
- `Fs` — `safeReadJsonl` (lstat+fstat, C3 isolated here)
- `Gitleaks` — `runGitleaks(text)` → `Finding[]`
- `Git` — `diffFilesForRange`

### CLI layer (`cli.ts`)

- Argument parsing
- Wires core + adapters
- `main()` only runs when `import.meta.main` is true (so tests can import without auto-run)

## Milestones

### v0.4.0 — Pure core extraction (Q1)

**Goals**
- Create `src/core/` with `session.ts`, `scope.ts`, `sanitize.ts`, `posting-plan.ts`.
- Move `encodeCwd`, `loadSessionsForRepo`, `inspectSession`, `extractFilePaths`, `intersectsDiffFiles`, `filterScope`, `applyScrubbers`, `neutralizeUntrustedText`, `collectMarkdown` body, scrubber merging into core modules.
- Guard `main()` execution: `if (import.meta.main) await main();`
- Replace C2/C3 placeholder tests with real direct-call assertions.
- Add normalized-path tests covering absolute paths, dotted repo paths, basename collisions.

**Files**
- `cli.ts` (extract bodies, keep as the executable wrapper)
- `src/core/session.ts` (new)
- `src/core/scope.ts` (new)
- `src/core/sanitize.ts` (new)
- `src/core/posting-plan.ts` (new)
- `tests/cli.test.ts` (replace placeholders; add core tests)

**Acceptance**
- 8 existing tests pass.
- C2 and C3 placeholder assertions replaced with real ones; net new test count ≥ 6.
- `bun cli.ts --help` still works (cli wiring unchanged from user view).
- `encodeCwd('/Users/noam.siegel/some/repo')` returns the same value as Claude Code's actual encoding (both `/` and `.` replaced).
- Dotted fixture paths in tests (e.g. `/tmp/foo.bar`) now exercise the encoding correctly.

### v0.5.0 — GhClient adapter (Q2)

**Goals**
- Extract `gh` interactions into one `GhClient` class.
- `detectPr`, gist create/edit, PR-body marker rewrite all go through it.
- Add fixture-based tests using a fake command runner.

**Acceptance**
- `cli.ts` contains zero `gh` invocations.
- Tests cover: gist re-attach, create-on-edit-fail fallback, PR marker replacement, public-visibility refusal — all without real `gh`.

### v0.6.0 — Posting plan + safety gates (Q3)

**Goals**
- `buildPostingPlan` runs after markdown generation, before network mutation.
- Branch tests for PUBLIC / UNKNOWN / PRIVATE × `--public-ok` × `--no-attach` × `--dry-run` × gitleaks-fail × `--force`.

**Acceptance**
- All C1/gitleaks/dry-run policy lives in one function with one test table.

### v0.7.0 — Composable scrubber pipeline (Q4)

**Goals**
- Replace the hardcoded `DEFAULT_SCRUBBERS` array with a config-driven pipeline.
- Built-ins, user config, and per-call overrides compose cleanly.

**Acceptance**
- Adding a built-in scrubber is one line in the registry.
- User config can disable specific built-ins by name.

## Non-goals

- **No abstract adapter interfaces.** One backend each (gh, gitleaks, filesystem). Concrete classes.
- **No mocking framework / DI container.** Tests use real fixtures or a single fake command runner.
- **No rewrite in another runtime.** Stays Bun + TypeScript.

## Open questions

- **Single-file vs `src/` directory**: v0.4.0 introduces `src/core/`. The bin entry stays `cli.ts` for brew compatibility. Decide if the synced copy at `~/Documents/GitHub/agents-trace/cli.ts` becomes a directory or a bundled single file.
- **`gh` vs Octokit**: stays `gh` (no auth complexity, brew install model). Reconsider only if rate limits or pagination force the issue.
- **Homebrew-core graduation**: candidate after v0.5.0.
