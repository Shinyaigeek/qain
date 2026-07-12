# Security Policy

## Supported versions

qain is pre-1.0. Security fixes land on the latest `0.x` release; there is no
backport window for older versions. Please always test against the newest
published version before reporting.

| Version | Supported |
| ------- | --------- |
| latest `0.x` | ✅ |
| older | ❌ |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Report privately through either channel:

- GitHub's [private vulnerability reporting](https://github.com/Shinyaigeek/qain/security/advisories/new)
  (Security → Report a vulnerability), or
- email **philispaxil@gmail.com** with `qain security` in the subject.

Include the affected package and version, a description of the impact, and a
reproduction if you have one. You can expect an acknowledgement within a few
days. Once a fix is available we will publish it and credit you in the advisory
unless you ask otherwise.

## What counts

qain drives a real Chromium instance over the DevTools Protocol and executes
JavaScript in the pages it snapshots. Relevant classes of report include:

- a crafted page or snapshot that lets qain read or write files outside the
  intended output path, or execute code on the host beyond the page context;
- a snapshot/replay artifact that, when opened, escalates beyond the sandboxed
  page it represents;
- exposure of secrets (tokens, env) into snapshot output or logs.

## Supply-chain posture

This project takes concrete steps to reduce dependency risk, and reports about
gaps in these are welcome:

- **Install scripts are blocked by default.** Only packages listed in
  `allowBuilds` (`pnpm-workspace.yaml`) may run lifecycle scripts.
- **New dependency versions have a cooldown.** `minimumReleaseAge` delays
  adoption of freshly published versions, blunting the window in which a
  compromised release can spread.
- **Lockfile is frozen in CI** (`--frozen-lockfile`) and dependency updates flow
  through Dependabot for review.
- **Published packages carry npm provenance** and are published from a tagged
  release via a version-verified workflow.
