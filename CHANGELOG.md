# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages in
this monorepo are versioned together under
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **qain-diff action, reworked.** It no longer takes explicit `before`/`after`
  paths: it detects the committed `*.qain.json` baselines a PR changes
  (configurable `pattern` glob), diffs each against the merge base, posts one
  sticky comment with a per-baseline semantic diff, updates it on every push,
  and deletes it when the diff disappears. `fail-on-diff` now defaults to
  `false`.

## [0.0.2] - 2026-07-12

Initial release. Packages: `@qain/cli` (the `qain` CLI), `@qain/core`, `@qain/playwright`,
`@qain/vitest`, `@qain/storybook`.

### Added

- Semantic style-regression capture over CDP: resolved used values, layout
  boxes, paint order, and composited colors, diffed to report **what changed and
  what merely moved**.
- Primary-vs-derived change classification, with attribution back to the source
  CSS rule and location.
- Pseudo-state capture via `CSS.forcePseudoState` — rules captured per state.
- WCAG contrast checks on color changes.
- Replay: rebuild the page from a snapshot.
- Integrations: CLI, Playwright fixture + expect matcher, Vitest browser-mode
  matcher, and Storybook test-runner matcher.
- GitHub Action for posting diff summaries as PR comments.

[Unreleased]: https://github.com/Shinyaigeek/qain/compare/v0.0.2...HEAD
[0.0.2]: https://github.com/Shinyaigeek/qain/releases/tag/v0.0.2
