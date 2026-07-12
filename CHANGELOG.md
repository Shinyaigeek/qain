# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages in
this monorepo are versioned together under
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0]

Initial release. Packages: `qain` (CLI), `@qain/core`, `@qain/playwright`,
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

[Unreleased]: https://github.com/Shinyaigeek/qain/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Shinyaigeek/qain/releases/tag/v0.1.0
