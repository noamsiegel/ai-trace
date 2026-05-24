# Changelog
## [0.8.1] — docs + architecture map

### Added
- `CONTEXT.md` with load-bearing invariants, module map, real vs hypothetical seams, public CLI stability, and ADRs (matches the agents-toc convention).
- `AGENTS.md` orienting agents working on this repo itself.
- `docs/COMPARISON.md` with full narrative competitor analysis (Goose, Aider, Codex CLI, codex-transcript-viewer, Cline, OpenInference, GitHub artifact attestations, Sigstore/in-toto).

### Changed
- `README.md` adjacent-tools section reformatted to the agents-toc-style table (`Tool | What it captures | Where it stores | When it runs`) and links to the new comparison doc.
- Added explicit `## What it doesn’t do` section to clarify scope versus build provenance, transcript UI, observability backends, and access control.

## [0.8.0] — ai-trace rebrand + Codex sessions

### Added
- Added `--source claude|codex|auto` for `collect`, `gist-create`, and `handoff`; `auto` keeps Claude Code first, then falls back to Codex.
- Added Codex CLI JSONL loading from `~/.codex/sessions/**/*.jsonl`, filtered by each session's recorded `cwd`.
- Added tests for Codex prompt extraction, dotted repo paths, and auto fallback.

### Changed
- Renamed the CLI, package, binary, help text, README, and docs from `provenance` to `ai-trace`.
- Bumped version to `0.8.0`.
- Updated PR body attachment marker to `🤖 ai-trace:`.

### Fixed
- Re-attach now recognizes both the old `🤖 AI Provenance:` marker and the new `🤖 ai-trace:` marker, edits the existing gist, and avoids duplicate PR markers.

## [0.7.0] — composable scrubber pipeline

### Added
- Added `src/core/scrubbers.ts` with a named built-in scrubber registry and `composeScrubbers`.
- Added JSON config support for disabling built-ins by name and adding custom regex scrubbers:
  `{ "scrubbers": { "disable": ["github-pat"], "add": [{ "name": "internal-id", "pattern": "INT-\\\\d+", "replacement": "[INT-ID]" }] } }`.
- Added scrubber pipeline tests covering every built-in, disable/add composition, invalid regex warnings, ordering, and duplicate-name override.

### Changed
- Moved the built-in scrubber list out of `src/core/sanitize.ts`; adding a built-in is now one registry entry.
- `cmdCollect`, `cmdGistCreate`, `cmdPrAttach`, `cmdHandoff`, and `scrub-rules` share one composed scrubber set loaded at startup.
- User-added scrubbers with duplicate built-in names replace the built-in.
- `provenance --help` reports `0.7.0`.

### Fixed
- Invalid user scrubber regexes warn to stderr and are skipped without crashing the CLI.

## [0.6.0] — posting plan safety gates

### Added
- Added `src/adapters/gitleaks.ts` with a concrete `GitleaksRunner` adapter returning structured findings.
- Added comprehensive posting-plan matrix tests covering visibility, override flags, dry-run, force, gitleaks findings, and create/reattach actions.

### Changed
- `cmdGistCreate` now gates posting through `buildPostingPlan` after markdown generation and gitleaks scanning.
- Moved C1 visibility refusal, gitleaks refusal, dry-run allowance, force override, and `--no-attach` reattach compatibility into `src/core/posting-plan.ts`.
- `provenance --help` reports `0.6.0`.

## [0.5.0] — GhClient adapter

### Added
- Extracted all GitHub CLI interactions into concrete `src/adapters/gh-client.ts`.
- Added fake-runner `GhClient` tests for PR context parsing, visibility propagation, gist re-attach, edit-failure create fallback, and PR body marker replacement.

### Changed
- `cli.ts` no longer invokes `gh` directly; gist upsert and PR body mutation now route through `GhClient`.
- `provenance --help` reports `0.5.0`.

## [0.4.0] — pure core extraction

### Added
- Extracted session loading/selection, normalized file scoping, sanitization, and posting-policy decisions into `src/core/`.
- Added direct core tests for dotted Claude Code path encoding, repo-relative scope normalization, basename-collision prevention, sanitization modes, unsafe JSONL rejection, and posting-plan policy branches.

### Changed
- `cli.ts` is now a thinner executable wrapper guarded by `import.meta.main`.
- `provenance --help` reports `0.4.0`.

## [0.3.0] — handoff subcommand + encodeCwd bug fix

### Added
- **`provenance handoff [--session ID] [--last-prompts N]`** — compact brief of the latest (or named) Claude Code session in the current repo, suitable for inclusion in a subagent's system prompt. Different output shape from `collect` (lossless audit log): decision-distilled, token-budget aware. Includes last N user prompts, files touched, tool usage table.

### Fixed
- **`encodeCwd` bug**: Claude Code encodes BOTH `/` and `.` as `-` (so `/Users/x.y/foo` → `-Users-x-y-foo`). The previous version only replaced `/`, causing `collect` / `sessions-since` / `handoff` to find zero sessions for any repo whose path contained a `.`.

## [0.2.0] — file-overlap scoping + custom scrubbers + gist-in-place re-attach

### Added
- **File-overlap session scoping.** New `--scope <time|file|both>` flag (default `both`). Intersects time-overlap with files-touched-by-the-PR-diff, addressing the pentester's H2 finding (forgeable-mtime session attachment). Falls back to time-only with `--scope time`.
- **Custom scrubber rules** via `~/.config/provenance/config.json`. Format:
  ```json
  {
    "scrubbers": [
      { "id": "my-token", "pattern": "MYORG-[A-Z0-9]{16}", "replacement": "[REDACTED-ORG-TOKEN]", "flags": "g" }
    ]
  }
  ```
  Append to the 15 defaults.
- **Gist-in-place re-attach.** When the PR body already contains a `🤖 AI Provenance:` URL, `pr-attach` updates that gist via `gh gist edit` instead of creating a new one. No more orphaned gists on force-push re-attach.

### Tests
- 9 tests pass (1 added: default-scope-requires-file-overlap).

## [0.1.0] — initial public release

### Added
- CLI subcommands: `collect`, `sessions-since`, `gist-create`, `pr-attach`, `scrub-rules`.
- Time-overlap session scoping with configurable grace (`--grace-min`).
- 15+ default scrubbers covering common token families (GitHub PAT, AWS, GCP, Stripe, OpenAI, Anthropic, JWT, private-key blocks, DB URLs with basic auth, emails, home paths).
- Shell-wrapper recipes for `gh pr create` and `gt submit` (in README).
- bun-test suite (8 tests) covering CLI dispatch, scrubber rules, session detection, slash-command filtering, and unsafe-file rejection.

### Security
- **C1**: refuses to attach to public-repo PRs by default. Detects visibility via `gh repo view --json visibility`. Override with `--public-ok` after dry-run review.
- **C2**: transcript content is treated as untrusted — markdown links/images flattened to plain text, HTML tags stripped, content wrapped in fenced code blocks labeled untrusted, fence-escape attempts neutralized.
- **C3**: JSONL reads use `lstat`+`fstat` to reject symlinks, hardlinks (`nlink > 1`), non-regular files, files not owned by current uid, and files larger than 20MB. Row count capped at 50000.
- **Hard gitleaks gate**: refuses to post on any gitleaks finding unless `--force`. No soft-confirmation path.
- Defense-in-depth scrubbers run BEFORE gitleaks.

### Known limitations
- macOS-tested. Linux probably works but untested in CI.
- bun runtime required. (Bun ships as a single binary; install via `curl -fsSL https://bun.sh/install | bash`.)
- Default scoping is time-overlap only. File-overlap (intersecting with PR diff) planned for next release.

### Not in this release
- Subagent context handoff (`provenance handoff`).
- File-overlap session scoping.
- ETag-based PR-body concurrency for force-push re-attach.
- Custom YAML scrubber rules in `~/.config/provenance/config.yaml`.
