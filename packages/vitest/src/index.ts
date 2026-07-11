import {
  type CaptureOptions,
  type CdpSession,
  type DiffOptions,
  type Snapshot,
  capture,
  diff,
  formatText,
} from '@qain/core'
import { expect } from 'vitest'
import * as browserApi from 'vitest/browser'

export type { CaptureOptions, DiffOptions, Snapshot }

// `cdp()` and `server.commands` are real runtime exports of `vitest/browser`, but
// its published types omit them. Bind them through one checked cast rather than
// scattering `any` at every call site.
const { cdp, server } = browserApi as unknown as {
  cdp: () => CdpSession
  server: {
    commands: {
      readFile(path: string): Promise<string>
      writeFile(path: string, content: string): Promise<void>
    }
  }
}
const commands = server.commands

/**
 * Capture the component under test.
 *
 * `@vitest/browser` runs every test file inside an iframe, so the CDP session the
 * provider hands back is attached to the orchestrator page — its top document is
 * the Vitest runner, not your component. qain targets `location.href` (the test
 * frame) instead, which is where the component actually is.
 */
export async function snapshot(options: CaptureOptions = {}): Promise<Snapshot> {
  return capture(cdp(), { frameUrl: location.href, ...options })
}

export interface StyleSnapshotOptions extends CaptureOptions, DiffOptions {
  /** Baseline file name (without extension). Default: the test's name. */
  name?: string
}

// Vitest's built-in browser commands run in Node, so a test in the browser can
// still read and write a committed baseline on disk. Paths resolve relative to the
// test file, the same as `__snapshots__`.
async function readBaseline(path: string): Promise<Snapshot | null> {
  try {
    return JSON.parse(await commands.readFile(path)) as Snapshot
  } catch {
    // readFile rejects when the baseline does not exist yet.
    return null
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'snapshot'
}

expect.extend({
  /**
   * Compares the component against a committed style baseline.
   *
   * Follows Vitest's own snapshot conventions, not `toHaveScreenshot`'s:
   *   - first run writes the baseline and passes
   *   - later runs diff against it and fail on any change
   *   - `-u` / `--update` rewrites the baseline
   *   - `--ci` never writes, so a missing baseline fails
   */
  async toMatchStyleSnapshot(_received: unknown, options: StyleSnapshotOptions = {}) {
    const ctx = this as unknown as {
      currentTestName?: string
      testPath?: string
      snapshotState?: { _updateSnapshot?: 'all' | 'new' | 'none' }
    }
    const name = sanitize(options.name ?? ctx.currentTestName ?? 'snapshot')
    // Co-locate baselines with the test file (like `__snapshots__`), so two files
    // that happen to share a test name don't overwrite each other's baseline.
    const dir = ctx.testPath ? ctx.testPath.replace(/[/\\][^/\\]+$/, '') : '.'
    const baselinePath = `${dir}/__qain__/${name}.qain.json`
    const update = ctx.snapshotState?._updateSnapshot ?? 'new'

    const actual = await snapshot(options)
    const serialized = `${JSON.stringify(actual, null, 2)}\n`

    const baseline = await readBaseline(baselinePath)
    if (!baseline) {
      if (update === 'none') {
        return {
          pass: false,
          message: () =>
            `qain: no style baseline for "${name}". Run without --ci (or with -u) to create it.`,
        }
      }
      await commands.writeFile(baselinePath, serialized)
      return { pass: true, message: () => `qain: created style baseline "${name}"` }
    }

    const result = diff(baseline, actual, options)
    if (result.changes.length === 0) {
      return { pass: true, message: () => `style snapshot "${name}" matched` }
    }

    if (update === 'all') {
      await commands.writeFile(baselinePath, serialized)
      return {
        pass: true,
        message: () => `qain: updated style baseline "${name}" (${result.summary.total} changes)`,
      }
    }

    const text = formatText(result, { color: false })
    return {
      pass: false,
      message: () =>
        `qain: style snapshot "${name}" does not match its baseline\n\n${text}\n\nRe-run with -u to accept.`,
    }
  },
})

export { expect }

interface QainMatchers<R = unknown> {
  toMatchStyleSnapshot(options?: StyleSnapshotOptions): Promise<R>
}

declare module 'vitest' {
  // `T = any` (not unknown) because declaration merging requires the exact type
  // parameter Vitest declares on Assertion.
  interface Assertion<T = any> extends QainMatchers<T> {}
  interface AsymmetricMatchersContaining extends QainMatchers {}
}
