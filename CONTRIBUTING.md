# Contributing to agents-trace

Thanks for improving `agents-trace`. Treat transcript handling as security-sensitive: secret gists are URL-protected, not access-controlled.

## How to report a bug

Open a [bug report](./.github/ISSUE_TEMPLATE/bug.md) with reproduction steps, expected behavior, actual behavior, and your environment.

## How to propose a feature

Open a [feature request](./.github/ISSUE_TEMPLATE/feature.md) with the problem, proposed solution, and alternatives considered.

## Development setup

`agents-trace` is a Bun/TypeScript CLI.

Dependencies:

```bash
brew install bun gh gitleaks
bun install
```

Authenticate `gh` with gist and repo scopes before testing commands that create gists or edit PR bodies:

```bash
gh auth refresh -h github.com -s gist,repo
```

## Running tests

```bash
bun test tests/cli.test.ts
```

## Commit message format

Use Conventional Commits. Release Please uses these to decide versions and changelog entries:

```text
fix: preserve public-repo block during pr attach
feat: add session filtering by file overlap
```

## Pull request checklist

- [ ] Tests pass with `bun test tests/cli.test.ts`.
- [ ] Lint/security checks are clean.
- [ ] Documentation is updated when behavior changes.
- [ ] `CHANGELOG.md` is updated for user-visible changes.
