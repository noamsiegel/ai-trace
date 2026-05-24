# ai-trace CONTEXT

Architecture context for agents (human and AI) working on ai-trace itself.
For user documentation see `README.md` and `docs/*`.

## Load-bearing invariants

These do not change without a major version bump.

1. **Public PR attachment is refused by default**: `pr-attach` must not put a
   secret-gist URL into a public repository PR unless the caller passes
   `--public-ok`. The policy lives in `src/core/posting-plan.ts`
   (`buildPostingPlan`, `normalizeRepoVisibility`) and is enforced from
   `cli.ts` before PR mutation.
2. **Gitleaks is a hard pre-post gate**: transcript markdown is generated and
   scrubbed before `GitleaksRunner` scans it, and posting is refused on any
   finding unless `--force` is explicit. See `src/adapters/gitleaks.ts`,
   `src/core/posting-plan.ts`, and the `cmdGistCreate` flow in `cli.ts`.
3. **Transcript text is untrusted input**: audit output strips code blocks by
   default, applies scrubbers, flattens links/images, strips HTML, escapes
   nested fences, and wraps prompt text in fenced `text` blocks. See
   `src/core/sanitize.ts` (`sanitize`, `collectMarkdown`,
   `neutralizeUntrustedText`, `escapeMarkdownFences`).
4. **Local JSONL reads must stay safe**: session loading rejects symlinks,
   hardlinks, non-regular files, wrong-owner files, oversized files, and inode
   swaps between `lstat` and `fstat`; row processing is capped. See
   `src/core/session.ts` (`safeReadJsonl`, `MAX_JSONL_BYTES`,
   `MAX_JSONL_ROWS`).
5. **Session selection must be scoped to the repo and PR**: Claude Code sessions
   are loaded from the cwd-encoded project directory; Codex sessions are kept
   only when recorded `cwd` equals the repo root; default PR selection requires
   both commit-time overlap and normalized file overlap. See
   `src/core/session.ts` (`encodeCwd`, `loadRepoSessions`,
   `inspectCodexSession`, `selectSessionsForRange`) and `src/core/scope.ts`.
6. **PR marker writes are idempotent and migrate the old marker**: re-attach
   must update the existing gist/line instead of appending duplicates, and must
   recognize both `🤖 ai-trace:` and legacy `🤖 AI Provenance:` markers. See
   `src/adapters/gh-client.ts` (`MARKER_PATTERN`, `findAttachedAiTraceGist`,
   `writeAiTraceLink`).
7. **The binary is the public API**: `src/core/*` and `src/adapters/*` are
   internal implementation boundaries for tests and maintainability. External
   users depend on the `ai-trace` CLI, flags, config shape, PR marker, and gist
   output semantics.

## Module map

```text
cli.ts                         Bun executable, argument parsing, command wiring,
                               git calls, repo/PR orchestration
src/core/session.ts            Claude/Codex session discovery, safe JSONL reads,
                               prompt extraction, time/file selection
src/core/codex.ts              Codex session-tree walking helper
src/core/scope.ts              repo-relative path normalization and file-scope
                               intersection
src/core/sanitize.ts           audit/handoff sanitization and markdown rendering
src/core/scrubbers.ts          built-in scrubber registry + user config composition
src/core/posting-plan.ts       pure posting policy: public visibility, dry-run,
                               force, gitleaks, no-attach
src/adapters/runner.ts         concrete Bun command runner used by adapters
src/adapters/gh-client.ts      GitHub CLI adapter: PR context/body, gist upsert,
                               marker rewrite
src/adapters/gitleaks.ts       gitleaks command adapter returning structured findings
tests/cli.test.ts              CLI behavior, session loading, source selection,
                               safe reads
tests/sanitize.test.ts         scrubber and markdown-neutralization behavior
tests/posting-plan.test.ts     posting-policy matrix
tests/gh-client.test.ts        fake-runner GitHub adapter tests
```

Current dependency direction: `cli.ts` wires `src/core/*` pure functions and
concrete `src/adapters/*`; adapters may depend on `runner.ts`; core must not
call `gh`, `gitleaks`, `git`, or mutate PR/gist state.

## Real seams

- **Transcript source selection** (`src/core/session.ts`): Claude Code and Codex
  have different storage models (cwd-encoded directory vs global session tree
  with recorded cwd). The `--source claude|codex|auto` option makes this a real
  product seam, not an abstract future hook.
- **GitHub command boundary** (`src/adapters/gh-client.ts`): all PR/gist
  mutation goes through one concrete class. The seam earns its keep because
  tests can exercise marker migration, gist fallback, and visibility parsing
  without touching GitHub.
- **Posting policy** (`src/core/posting-plan.ts`): public-repo refusal,
  gitleaks findings, dry-run, force, no-attach, and create-vs-reattach behavior
  form a cross-product matrix. Keeping it pure is the cheapest way to make the
  safety gate testable.
- **Scrubber pipeline** (`src/core/scrubbers.ts`): built-ins, disabled rules,
  user-added regexes, and duplicate-name replacement are real variation points
  exposed by the config file.

## Hypothetical (don't introduce yet) seams

- **Abstract filesystem adapter**: `safeReadJsonl` is security-critical and
  currently uses real OS metadata (`lstat`, `fstat`, uid, nlink, size). Tests use
  real fixtures. A generic filesystem interface would hide the exact checks
  that matter.
- **GitHub API client / Octokit adapter**: `gh` already owns auth, scopes, and
  user ergonomics. Add Octokit only if `gh` becomes impossible to use for a real
  required behavior such as pagination, concurrency control, or org policy.
- **Command-runner hierarchy**: `runner.ts` is enough. Splitting one command
  runner per adapter would be pass-through unless command behavior diverges.
- **Renderer/viewer layer**: markdown gist output is the product surface today.
  HTML transcript rendering would be a new product, not a refactor seam.
- **Cryptographic attestation backend**: ai-trace is not SLSA/in-toto/Sigstore.
  Add signing only if the product contract changes from reviewer evidence to
  verifiable audit artifact.

## Public CLI stability

The stable contract is the `ai-trace` binary: subcommands, documented flags,
JSON config at `~/.config/ai-trace/config.json`, secret-gist PR marker, public
PR refusal semantics, and scrub/gitleaks gates. Internal TypeScript exports may
change to keep those behaviors correct and testable.

Changing the meaning of default scoping, relaxing posting safety, changing the
marker format, or changing scrubber composition requires an explicit changelog
entry and should be treated as a compatibility break for existing PR workflows.

## ADRs

ADR-001 — secret gist linked from PR body: chosen over commit trailers,
commit-message transcript blocks, and a local database because reviewers look at
PR bodies, commit history stays clean, and the artifact can be deleted later.
See `README.md` (`Why this design`).

ADR-002 — conservative public-repo posture: secret gists are URL-protected, not
access-controlled, so public PR attachment is refused by default. See
`README.md` (`Public-repo safety`) and `CHANGELOG.md` v0.1.0 C1.

ADR-003 — untrusted transcript hardening before posting: prompt text may contain
markdown smuggling, secrets, fence escapes, HTML, or code. Sanitization and
scrubbing happen before gitleaks and before gist creation. See `CHANGELOG.md`
v0.1.0 C2/C3 and v0.7.0.

ADR-004 — pure core plus concrete adapters: v0.4.0–v0.7.0 moved session logic,
scope normalization, sanitization, posting policy, GitHub operations, gitleaks,
and scrubbers out of the original CLI flow to make safety behavior directly
testable. See `ROADMAP.md` and `CHANGELOG.md` v0.4.0–v0.7.0.

ADR-005 — Bun + TypeScript stays for now: the roadmap explicitly rejected a
runtime rewrite. Bun keeps the executable script simple and matches the current
one-author distribution model; the binary CLI remains the contract. See
`ROADMAP.md` (`Non-goals`).
