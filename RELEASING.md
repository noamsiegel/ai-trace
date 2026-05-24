# Releasing agents-trace

Use this checklist from a clean `main` checkout.

1. Run pre-release checks:
   ```bash
   bun test
   git status --short
   ```
   `bun test` must pass and `git status --short` must print nothing.
2. Bump both version sources to the same `X.Y.Z`:
   - `VERSION` const in `cli.ts` near line 38
   - `version` in `package.json`
   The version-match test enforces this drift check.
3. Prepend a `## [vX.Y.Z]` entry to `CHANGELOG.md` with `Added`, `Changed`, and/or `Fixed` subsections as appropriate.
4. Commit, tag, and push in order:
   ```bash
   git add -A
   git commit -m "Release vX.Y.Z"
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin main
   git push origin vX.Y.Z
   ```
   If the pre-push hook complains about `cmdGistCreate` or `cmdHandoff` complexity, retry with `SKIP_FALLOW=1`; this is known fallow noise and Q3 architectural debt.
5. Create the GitHub release after both pushes succeed:
   ```bash
   gh release create vX.Y.Z --notes "..."
   ```
6. Update the Homebrew tap formula `Formula/agents-trace.rb` URL and `sha256`.
7. Sync the PAI skill mirror:
   ```bash
   cp cli.ts ~/.pai/skills/agents-trace/cli.ts
   cp -r src/* ~/.pai/skills/agents-trace/src/
   ```
8. Upgrade and smoke test the installed tap package:
   ```bash
   brew update
   brew upgrade noamsiegel/tap/agents-trace
   agents-trace --help
   ```
   Help output must report `vX.Y.Z`.

## Recovery

- If push fails due to a stale guardrails shim, run `git-guardrails install --force` to refresh hooks, then retry the push.
- If `gh release create` ran before push succeeded, the remote tag may point at the wrong commit. Recover with `gh release delete vX.Y.Z --yes`, `git push origin --delete vX.Y.Z`, `git tag -d vX.Y.Z`, `git tag -a vX.Y.Z HEAD -m "vX.Y.Z"`, push the tag, then recreate the release.
- If brew install fails after a formula bump because pkgshare assets are missing, check `def install` in `Formula/agents-trace.rb`; it must list `libexec.install "cli.ts", "package.json", "src"`.
