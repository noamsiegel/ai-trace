# AGENTS.md

This file orients agents working on **ai-trace** itself. Read `CONTEXT.md` for
load-bearing invariants: public PR refusal, gitleaks gate, untrusted transcript
hardening, safe JSONL reads, scoped session selection, and idempotent PR marker
writes. See `README.md` for user-facing behavior.

## How to work here

- Code edits go in `cli.ts` only for CLI parsing/wiring, `src/core/*` for pure
  session/scope/sanitize/posting logic, or `src/adapters/*` for concrete `gh`,
  `gitleaks`, and command-runner integration.
- Keep `src/core/*` free of `process`, `gh`, `gitleaks`, PR mutation, and other
  side effects unless `CONTEXT.md` is updated with a new invariant.
- Add or update tests in `tests/` for any behavior change. Use `bun test
  tests/<name>.test.ts` for targeted verification; run broader tests only when
  the changed seam crosses files.
- Never relax the public-repo refusal, scrubber pipeline, gitleaks gate,
  safe-read checks, or PR marker idempotency to make a test pass.
- Never commit, tag, push, publish releases, bump the Homebrew tap, or sync the
  PAI skill mirror unless the user explicitly asks for that release step.
- Do not add abstract adapter interfaces unless there are at least two real
  implementations or a concrete testability/locality gain that passes the
  deletion test.

## Docs index

Manual index for now. If this repo later installs `agents-toc`, it can own the
placeholder block below.

- `README.md` — product overview, safety posture, install, usage, config,
  adjacent-tool comparison.
- `CONTEXT.md` — architecture invariants, module map, real vs hypothetical
  seams, public CLI stability, ADRs.
- `ROADMAP.md` — v0.8.0 architecture state, extracted-core/adapters plan, and
  non-goals.
- `CHANGELOG.md` — release history and security-relevant behavior changes.
- `docs/COMPARISON.md` — narrative comparison with adjacent agent-session,
  observability, and supply-chain provenance tools.
- `SKILL.md` — PAI skill wrapper for invoking ai-trace from agent workflows.
- `CONTRIBUTING.md` — contribution workflow and local test expectations.
- `SECURITY.md` — vulnerability reporting and supported security posture.

<!-- INDEX:START -->
<!-- Placeholder for future agents-toc-managed index. Do not rely on this block yet. -->
<!-- INDEX:END -->
