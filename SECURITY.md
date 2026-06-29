# Security Policy

## Supported versions

This package is in early access (`0.x`). Security fixes are released against the
latest published version on npm. Always run the most recent `@mywebapi.com/sdk`
release before reporting an issue.

| Version | Supported          |
| ------- | ------------------ |
| `0.1.x` | :white_check_mark: |
| `< 0.1` | :x:                |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
pull requests, or discussions.**

Instead, report them privately by email to **info@cplugin.com**.

Include as much of the following as you can — it helps us triage faster:

- A description of the vulnerability and its potential impact.
- The affected version(s) of `@mywebapi.com/sdk`.
- Step-by-step instructions to reproduce the issue (proof-of-concept code,
  request/response samples, or a failing test are ideal).
- Any known mitigations or workarounds.

If you prefer encrypted communication, mention it in your first email and we
will provide a key.

## What to expect

- **Acknowledgement** within 3 business days of your report.
- **Initial assessment** (severity and affected versions) within 10 business
  days.
- **Status updates** as we work toward a fix, plus coordination on a disclosure
  timeline.
- **Credit** for the report once a fix ships, if you would like to be named.

We follow a coordinated-disclosure model: please give us a reasonable window to
release a fix before any public disclosure. We will keep you informed throughout
and aim to resolve confirmed vulnerabilities promptly.

## Scope

This policy covers the `@mywebapi.com/sdk` JavaScript/TypeScript client library
in this repository. Vulnerabilities in the underlying WebAPI service itself, or
in third-party dependencies, should still be reported to info@cplugin.com so
we can route them to the right team.

## Handling credentials safely

This SDK manages OAuth2 client credentials and access tokens. When reporting
issues or sharing reproduction steps, **never include real client secrets,
tokens, or production credentials** — redact them or use placeholder values.
