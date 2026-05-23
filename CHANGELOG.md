# Changelog

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
