# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages in
this monorepo are versioned together under
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.5] - 2026-08-06

### Added

- **`captureDom(doc, options)` in `@qain/core`** captures a live DOM without
  CDP, emitting the identical `Snapshot` the CDP capture does. Everything
  downstream — diff, explain, replay, report — was already browser-safe, so qain
  now runs entirely in a tab. There is an
  [in-browser playground](https://shinyaigeek.github.io/qain/playground/) built
  on it.
- **The qain-diff action embeds a render for a brand-new baseline.** A PR that
  adds a `*.qain.json` used to get only a text note; when the new snapshot
  carries replay data it is now shot against itself and the render embedded, so
  reviewers see what the first baseline looks like. Degrades to the usual
  `--replay` hint otherwise.

### Fixed

- **An inherited change is no longer restated as a primary cause.** A change to
  an inherited property on an ancestor is repeated by every descendant that did
  not override it, so a single `body { line-height }` edit reported 123 primary
  changes and `--omit-derived` had nothing to drop. Such a restatement is now
  demoted to derived on the same terms `currentColor` already used — only when
  the value matches an ancestor's change exactly, so an independently authored
  change stays its own cause. The same edit now reports 1 primary and 122
  derived. The demotion also runs before `selfChanged` is seeded, so a node that
  merely inherited a geometric property is no longer reported as a cause of the
  box move it received.

## [0.0.4] - 2026-07-16

### Added

- **`view --serve` / `diff --serve`** host the rebuilt page on localhost instead
  of writing a file, staying up until Ctrl-C (default port 4179, falling back to
  the first free port; `--port` to override). `diff --serve` serves the
  before/after replay when both snapshots carry `--replay` data, otherwise the
  HTML report.
- **The replay and `view` canvas zooms and pans.** ⌘/Ctrl + scroll or the
  −/+/reset control zooms cursor-anchored; drag to pan. Zoom defaults to 1 via
  CSS `zoom`, so the pixel-identity guarantee is untouched.
- **Click a change to spotlight it.** Clicking a box in the canvas or a row in
  the causes list rings every box for that node and marks the matching row, both
  directions in sync; Esc or an empty-space click clears it.

### Fixed

- **Replay reproduces ancestor `overflow:hidden` and `opacity`.** Flattening the
  DOM into siblings had dropped the effects a parent has on its whole subtree, so
  a clipped child could spill past its container and a faded child render fully
  opaque. Both are now rebuilt from the recorded parent chain — clipping as the
  intersection of every clipping ancestor's box, opacity as the product down the
  chain.

## [0.0.3] - 2026-07-12

### Added

- **`qain shot <before> <after>`** renders a snapshot pair as `before.png`,
  `after.png` and `diff.png` — the diff fades unchanged pixels to grey and
  paints every differing pixel red. Snapshots need `snap --replay` data.
- `renderReplay` gained a `bare` option: just the reconstruction, no viewer
  chrome — two bare renders differ only where the page does.
- **The qain-diff action embeds screenshots.** Before/after/diff renders are
  committed to an assets branch and embedded in the sticky comment
  (`screenshots`/`assets-branch` inputs; needs `contents: write` and
  `--replay` baselines; degrades to text when unavailable).

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

[Unreleased]: https://github.com/Shinyaigeek/qain/compare/v0.0.5...HEAD
[0.0.5]: https://github.com/Shinyaigeek/qain/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/Shinyaigeek/qain/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/Shinyaigeek/qain/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/Shinyaigeek/qain/releases/tag/v0.0.2
