# Security Policy

## Reporting a vulnerability

Email security reports to noam@noamsiegel.com.

Do not open public issues for security bugs. Include enough detail to reproduce the problem, the affected version or commit, and any known impact. You can expect a private response before public disclosure is coordinated.

## Supported versions

| Version | Supported |
|---|---|
| 0.x | Yes |

## Security boundaries

`agents-trace` handles Claude Code session transcripts and posts cleaned output to secret gists. Secret gists are URL-protected, not access-controlled; the gist-secrecy model and public-repo safety tradeoff are documented in the README.

Report any bypass of the public-repo block as a security issue. Also report transcript scrubbing failures, markdown-smuggling bypasses, unsafe session-file reads, gitleaks-gate bypasses, or behavior that attaches unsafe transcript content to a PR without explicit user approval.
