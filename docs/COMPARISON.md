---
id: COMPARISON
summary: "How ai-trace differs from agent session exporters, transcript viewers, observability traces, and build provenance systems"
---

# How ai-trace compares

Short version: adjacent tools either run agents, export their own session
history, render transcripts, observe runtime LLM calls, or attest build
artifacts. `ai-trace` sits downstream of local coding agents and upstream of PR
review: it turns local Claude Code/Codex JSONL into scrubbed, gitleaks-gated,
secret-gist evidence linked from a GitHub PR.

## At a glance

| Project | Core verb | Output | Loaded at | Composable with ai-trace? |
|---|---|---|---|---|
| **ai-trace** | attach | scrubbed Markdown gist linked from PR body | PR review time | — |
| [Goose](https://github.com/aaif-goose/goose) | run/export | Goose session JSON or Markdown export | agent runtime / on-demand export | yes — exported sessions could become a future source adapter |
| [Aider](https://github.com/Aider-AI/aider) | pair/program | chat history and optional LLM history files | during Aider use | partial — history files are source material, not PR plumbing |
| [Codex CLI](https://github.com/openai/codex) | run/resume | local session JSONL under `~/.codex/sessions` | during Codex CLI use | yes — ai-trace already consumes Codex JSONL when cwd matches the repo |
| [codex-transcript-viewer](https://github.com/masonc15/codex-transcript-viewer) | render | single-file HTML transcript | after Codex sessions exist | yes — viewer UX is complementary to ai-trace's PR attachment flow |
| [Cline](https://github.com/cline/cline) | run/checkpoint | IDE/CLI sessions, checkpoints, plugin-defined logs | agent runtime | partial — Cline plugins could emit audit logs, but ai-trace owns PR linkage |
| [OpenInference](https://github.com/Arize-ai/openinference) | observe | OpenTelemetry-compatible AI spans | instrumented runtime | yes — possible future import/export format, not today's storage model |
| [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations) | attest | signed artifact provenance and predicates | CI/build workflow | no — different trust domain |
| [Sigstore / in-toto](https://github.com/sigstore/cosign) | sign/verify | signatures, attestations, layouts/link metadata | build/release/signing workflow | no — different trust domain |

## In words

### Goose

Goose is a general-purpose AI agent with desktop, CLI, API, MCP extensions, and
documented session export. Its export path can produce JSON or Markdown that
preserves conversation history and metadata.

**Difference**: Goose owns the agent runtime and its own export surface.
`ai-trace` owns review plumbing: scrub, neutralize, gitleaks-gate, create a
secret gist, and attach/update a PR marker.

**Compose**: a Goose source adapter would make sense only if Goose exports carry
enough repo cwd, timestamps, prompts, and file references to pass ai-trace's
selection and safety gates.

### Aider

Aider is a terminal pair-programming agent with persistent chat history and
optional LLM-history files.

**Difference**: Aider history is useful local memory for the Aider workflow.
`ai-trace` produces reviewer-visible evidence with public-repo safety checks and
PR marker idempotency.

**Compose**: Aider history could become input, but only after source-specific
parsing preserves the same invariants as Claude/Codex sessions: repo identity,
time/file scoping, prompt extraction, sanitization, and hard pre-post gates.

### Codex CLI

Codex CLI stores JSONL sessions under `~/.codex/sessions` for resume. Unlike
Claude Code's cwd-encoded project directory, Codex sessions live in a global
tree and must be filtered by recorded `cwd`.

**Difference**: Codex persists sessions so Codex can resume work. `ai-trace`
consumes those sessions when they belong to the current repo and turns them into
PR evidence.

**Compose**: this is already implemented. `--source codex` loads Codex sessions;
`--source auto` tries Claude Code first, then falls back to Codex.

### codex-transcript-viewer

codex-transcript-viewer renders Codex JSONL into a readable single-file HTML
artifact with navigation/search/filtering affordances.

**Difference**: it is a viewer. `ai-trace` is a secure collection, scrubbing,
gitleaks, gist, and PR attachment workflow.

**Compose**: HTML review UX is complementary, but would be a product expansion.
Today ai-trace's Markdown gist is deliberately lightweight and review-oriented.

### Cline

Cline is an agent runtime across IDE/CLI/SDK surfaces with sessions,
checkpoints, headless output, and plugin hooks that can log or audit events.

**Difference**: Cline can host runtime audit hooks inside its own ecosystem.
`ai-trace` is not an agent runtime; it is downstream PR review infrastructure.

**Compose**: a Cline plugin could emit source data for ai-trace, but that is a
future source-adapter question, not a reason to change ai-trace's core shape.

### OpenInference

OpenInference defines OpenTelemetry-compatible semantic conventions for AI
observability: agents, LLM calls, tools, retrievers, chains, and related spans.

**Difference**: OpenInference traces instrumented runtime behavior and sends it
to observability backends. `ai-trace` reads local coding-agent transcripts and
creates a human-readable PR artifact without requiring OTLP infrastructure.

**Compose**: OpenInference is the most useful future interchange shape if
ai-trace ever needs standard trace import/export. It should not replace the
current CLI until the source transcript problem moves from local JSONL to
standard spans.

### GitHub artifact attestations

GitHub artifact attestations create signed statements about build artifacts,
digests, predicates, and build provenance, verifiable with `gh attestation
verify`.

**Difference**: this is supply-chain provenance. `ai-trace` does not attest that
a build artifact was produced by a workflow; it captures prompts and local AI
coding intent for human PR review.

**Compose**: not today. A future custom predicate could embed an ai-trace digest,
but that would be a separate audit-grade feature and should not be implied by
current secret-gist behavior.

### Sigstore / in-toto

Sigstore and in-toto provide signatures, transparency logs, layouts, link
metadata, and verifiable supply-chain integrity.

**Difference**: they answer "was this artifact built by the expected identity
and process?" `ai-trace` answers "what AI session evidence should a reviewer see
next to this PR?"

**Compose**: not today. The naming collision is exactly why the project is
called `ai-trace`, not `provenance`.

## Why these gaps add up to a tool

Every adjacent tool above either:

1. owns the agent runtime,
2. stores or exports one agent's session history,
3. renders a transcript for reading,
4. emits runtime observability traces,
5. or verifies build/release supply-chain metadata.

None of them observed in the prior landscape pass combined Claude Code and Codex
local JSONL collection, repo/PR session selection, security scrubbers,
markdown-smuggling neutralization, hard gitleaks gate, secret gist creation,
public-PR refusal, and idempotent PR marker update.

That is intentionally narrow. `ai-trace` should stay narrow unless a new source
adapter or sink preserves the same safety invariants and clearly improves PR
review evidence.
