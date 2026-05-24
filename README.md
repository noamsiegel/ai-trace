# agents-trace

> Capture Claude Code and Codex CLI session transcripts as scrubbed secret gists linked from GitHub PRs.

`agents-trace` reads local AI coding-session JSONL from Claude Code
(`~/.claude/projects/<encoded-cwd>/*.jsonl`) and Codex CLI
(`~/.codex/sessions/**/*.jsonl`), scrubs it, and attaches cleaned markdown as a
**secret GitHub gist** linked from your PR description.

Reviewers see one line in the PR body: `🤖 agents-trace: <gist-url>`. The gist
contains prompts that produced code, so auditors can trace intent without
polluting commit history.

## Adjacent tools

| Tool | What it captures | Where it stores | When it runs |
|---|---|---|---|
| **agents-trace** | Claude Code + Codex CLI local JSONL sessions; prompts/code intent filtered by PR time/file overlap; scrubbed and gitleaks-gated | Secret GitHub gist linked from PR body as `🤖 agents-trace:` | On-demand or after PR creation/Graphite submit |
| Goose | Goose agent sessions; documented JSON/Markdown exports | Exported local files/artifacts from Goose session export | On-demand session export |
| Aider | Chat history and optional LLM history for Aider pair-programming sessions | Local history files such as `.aider.chat.history.md` / LLM history | During Aider use; restored/exported on demand |
| Codex CLI | Codex session JSONL used for resume | Local `~/.codex/sessions/**/*.jsonl` | During Codex CLI use; consumed by agents-trace on demand |
| codex-transcript-viewer | Codex JSONL session logs rendered for reading | Single-file HTML transcript artifact | On-demand after Codex sessions exist |
| Cline | Cline agent sessions/checkpoints and headless JSON output; plugin hooks can log/audit events | Cline workspace/session surfaces or plugin-defined sinks | Runtime inside Cline/IDE/CLI |
| OpenInference | AI observability spans: LLM, agent, tool, retriever, chain events via OpenTelemetry conventions | OTLP-compatible observability backends/traces | Runtime instrumentation |
| GitHub artifact attestations | Build artifact subjects, digests, predicates, SLSA/in-toto provenance | GitHub attestation store; verifiable with `gh attestation verify` | CI/build workflows |
| Sigstore / in-toto | Signed supply-chain metadata, artifact signatures, layouts/link metadata | Transparency logs / attestations / OCI or blob signatures | Build/release/signing workflows |

`agents-trace` is narrower: it is not an agent runtime, trace backend,
transcript UI, or build attestation system. It is PR review plumbing for
scrubbed AI session evidence. See [`docs/COMPARISON.md`](docs/COMPARISON.md)
for narrative detail.

## What it doesn't do

- It does not create cryptographic build provenance, SLSA predicates, in-toto
  link metadata, or Sigstore/GitHub artifact attestations.
- It does not make secret gists private or access-controlled; PR visibility and
  gist URL handling remain your responsibility.
- It does not replace Claude Code, Codex CLI, Goose, Aider, Cline, or any other
  agent runtime; it consumes transcripts they already wrote.
- It does not provide an observability backend, OpenTelemetry collector, trace
  store, or dashboard.
- It does not provide a transcript viewer UI; markdown gist output is optimized
  for lightweight PR review.
- It does not guarantee every prompt influenced a PR; selection is based on
  recorded repo/session data, time overlap, and file overlap.

## Why this design

| Approach | What it captures | Where it lives | Adoption friction |
|---|---|---|---|
| Co-authored-by trailer | "AI helped" flag | git commit history (permanent, public) | Low. VS Code rolled back automatic injection. |
| Commit-message context block | All prompts | git commit history (permanent, public) | High noise. Long commits. |
| **PR-link to secret gist (this)** | All prompts | Off-history (deletable, URL-protected) | One line in PR body |
| MCP server / DB query | Session metadata + replay | Local DB | Heavy runtime. Single-user. |

PR attachment puts trace data where reviewers already look, keeps commit history
clean, and lets you delete the gist later if needed.

## Public-repo safety

**Secret gists are URL-protected, not access-controlled.** Anyone with the URL
can read the gist. If you put that URL in a public PR body, the transcript is
effectively public.

`agents-trace pr-attach` **refuses to attach to public-repo PRs by default**.
Override with `--public-ok` after confirming dry-run output is safe to make
public. Better: keep this tool to private repos.

## What it does

```text
Claude session → ~/.claude/projects/<encoded-cwd>/*.jsonl
Codex session  → ~/.codex/sessions/**/*.jsonl (filtered by recorded cwd)
                          ↓ filter by time/file overlap with PR commits
                          ↓ strip code blocks (configurable)
                          ↓ run scrubbers (15+ default patterns)
                          ↓ neutralize markdown smuggling
                          ↓ wrap in fenced "untrusted transcript" blocks
                          ↓ hard gitleaks gate
                          ↓ gh gist create --secret
                          ↓ gh pr edit --body (appends or updates "🤖 agents-trace: <url>")
```

## Install

Requires [`bun`](https://bun.sh), [`gh`](https://cli.github.com), and
[`gitleaks`](https://github.com/gitleaks/gitleaks).

```bash
git clone https://github.com/noamsiegel/agents-trace.git ~/.local/share/agents-trace
ln -s ~/.local/share/agents-trace/bin/agents-trace ~/.local/bin/agents-trace
```

Authenticate `gh`:

```bash
gh auth status
gh auth refresh -h github.com -s gist,repo
```

## Usage

```bash
agents-trace collect [--pr N] [--source auto|claude|codex]
agents-trace sessions-since <ref> [--source auto|claude|codex]
agents-trace gist-create [--pr N] [--source auto|claude|codex]
agents-trace pr-attach [--pr N] [--source auto|claude|codex]
agents-trace handoff [--session ID] [--source auto|claude|codex]
agents-trace scrub-rules
```

Common flags: `--source auto|claude|codex`, `--dry-run`, `--no-attach`,
`--force`, `--public-ok`, `--include-code`, `--grace-min N`, `--base <ref>`.

`--source auto` is default. It tries Claude Code sessions for the current repo
first, then Codex sessions. Codex sessions are global, so `agents-trace` scans the
session tree and keeps only files whose recorded `cwd` equals the repo root.

## Configuration

`agents-trace` reads optional JSON config from `~/.config/agents-trace/config.json`.

Built-in scrubbers run first, in registry order. User-added scrubbers run after
built-ins. `disable` removes matching built-ins by name. If a user-added
scrubber uses the same name as a built-in, the user scrubber replaces that
built-in.

```json
{
  "scrubbers": {
    "disable": ["github-pat"],
    "add": [
      {
        "name": "internal-id",
        "pattern": "INT-\\d+",
        "replacement": "[INT-ID]"
      }
    ]
  }
}
```

Each `add` entry requires `name`, `pattern`, and `replacement`; `flags` is
optional and defaults to `g`. Invalid regexes are warned to stderr and skipped.
Run `agents-trace scrub-rules` to inspect the effective scrubber pipeline.

## Marker idempotency

`agents-trace pr-attach` recognizes an existing `🤖 agents-trace: <gist-url>` marker,
edits that gist, and rewrites the PR body without appending a duplicate line.

## Integrating with your workflow

Add to your shell rc to auto-attach on PR creation:

```bash
# ~/.zshrc or ~/.bashrc
gh() {
  command gh "$@"
  local rc=$?
  if [[ "$1" == "pr" && "$2" == "create" && $rc -eq 0 ]]; then
    agents-trace pr-attach 2>/dev/null || true
  fi
  return $rc
}

# Graphite users:
gt() {
  command gt "$@"
  local rc=$?
  if [[ "$1" == "submit" && $rc -eq 0 ]]; then
    agents-trace pr-attach 2>/dev/null || true
  fi
  return $rc
}
```

## Related tools

- [git-wt](https://github.com/noamsiegel/git-wt) — parallel-safe worktree CLI for agentic coding.
- [git-guardrails](https://github.com/noamsiegel/git-guardrails) — pre-commit secret scanning. Complementary to agents-trace's pre-post gitleaks check.

## Status

Private-use tool. Default posture: safe for private repos, conservative for
public repos.
