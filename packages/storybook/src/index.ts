import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  type CaptureOptions,
  type CdpSession,
  capture,
  type DiffOptions,
  diff,
  formatText,
  type Snapshot,
} from '@qain/core'

export type { CaptureOptions, DiffOptions, Snapshot }

// Structural types, so this package depends on nothing but @qain/core. The Storybook
// test runner hands `postVisit` a Playwright page and a story context; both satisfy
// these shapes without importing playwright or @storybook/test-runner.
interface CdpCapablePage {
  context(): { newCDPSession(page: unknown): Promise<unknown> }
}
interface StoryContext {
  id: string
  title?: string
  name?: string
}

export interface StyleSnapshotOptions extends CaptureOptions, DiffOptions {
  /** Directory the baselines live in. Default: `qain-snapshots`. */
  snapshotDir?: string
  /** Baseline name. Default: the story id. */
  name?: string
  /** Rewrite the baseline instead of diffing. Overrides `QAIN_UPDATE_SNAPSHOTS`. */
  update?: boolean
}

const DEFAULT_DIR = 'qain-snapshots'
/** The story canvas root in Storybook 7/8. Older Storybook uses `#root`. */
const DEFAULT_SELECTOR = '#storybook-root'

/**
 * Asserts a story's used values against a committed baseline. Drop it into the test
 * runner's `postVisit` hook:
 *
 *   // .storybook/test-runner.ts
 *   import { matchStyleSnapshot } from '@qain/storybook'
 *   export default {
 *     async postVisit(page, context) { await matchStyleSnapshot(page, context) },
 *   }
 *
 * The runner drives a real Chromium and hands `postVisit` a Playwright page, so qain
 * takes a CDP session exactly as `@qain/playwright` does. The runner is a Node
 * process, so baselines persist straight to disk — one JSON per story id.
 *
 * Baseline lifecycle, following the Storybook/Jest convention rather than
 * `toHaveScreenshot`'s:
 *   - missing        write it and pass (fails instead when `CI` is set, so an
 *                    uncommitted baseline cannot slip through review)
 *   - matches        pass
 *   - differs        throw with the readable diff
 *   - QAIN_UPDATE_SNAPSHOTS=1  rewrite the baseline and pass
 */
export async function matchStyleSnapshot(
  page: CdpCapablePage,
  context: StoryContext,
  options: StyleSnapshotOptions = {},
): Promise<void> {
  const session = (await page.context().newCDPSession(page)) as unknown as CdpSession
  const actual = await capture(session, { selector: DEFAULT_SELECTOR, ...options })

  const name = sanitize(options.name ?? context.id)
  const path = `${options.snapshotDir ?? DEFAULT_DIR}/${name}.qain.json`
  const serialized = `${JSON.stringify(actual, null, 2)}\n`

  const update = shouldUpdate(options)
  const baseline = await readBaseline(path)
  if (!baseline) {
    if (isCI() && !update) {
      throw new Error(
        `qain: no style baseline for "${name}" at ${path}. Commit it, or run locally to create it.`,
      )
    }
    await write(path, serialized)
    return
  }

  const result = diff(baseline, actual, options)
  if (result.changes.length === 0) return

  if (update) {
    await write(path, serialized)
    return
  }

  const text = formatText(result, { color: false })
  throw new Error(
    `qain: "${name}" style snapshot does not match ${path}\n\n${text}\n\nSet QAIN_UPDATE_SNAPSHOTS=1 to accept.`,
  )
}

function shouldUpdate(options: StyleSnapshotOptions): boolean {
  if (typeof options.update === 'boolean') return options.update
  const value = process.env.QAIN_UPDATE_SNAPSHOTS
  return value === '1' || value === 'true'
}

function isCI(): boolean {
  return !!process.env.CI && process.env.CI !== 'false' && process.env.CI !== '0'
}

async function readBaseline(path: string): Promise<Snapshot | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Snapshot
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function write(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body)
}

function sanitize(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'story'
}
