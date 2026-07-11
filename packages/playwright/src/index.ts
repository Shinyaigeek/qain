import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { type Page, test as base, expect as baseExpect } from '@playwright/test'
import {
  type CaptureOptions,
  type CdpSession,
  type DiffOptions,
  type Snapshot,
  capture,
  diff,
  formatHtml,
  formatText,
  renderReplayDiff,
} from '@qain/core'

export type { CaptureOptions, DiffOptions, Snapshot }

export interface QainFixture {
  /** Capture the current page. Handy for `expect(await qain.snapshot()).toMatchObject(...)`. */
  snapshot(options?: CaptureOptions): Promise<Snapshot>
}

/**
 * Playwright has no plugin system. The three extension points it does have are a
 * fixture, `expect.extend`, and the reporter — qain uses all three. The reporter
 * side is `testInfo.attach`, which drops a standalone HTML diff into the run's
 * report, so a failing style regression is something a human can look at without
 * qain shipping a viewer.
 */
export const test = base.extend<{ qain: QainFixture }>({
  qain: async ({ page }, use) => {
    await use({
      snapshot: (options?: CaptureOptions) => snapshotOf(page, options),
    })
  },
})

async function snapshotOf(page: Page, options?: CaptureOptions): Promise<Snapshot> {
  const session = (await page.context().newCDPSession(page)) as unknown as CdpSession
  return capture(session, options)
}

export interface StyleSnapshotOptions extends CaptureOptions, DiffOptions {
  /** Baseline file name, resolved inside the test's snapshot directory. */
  name?: string
  /** Absolute baseline path, bypassing the snapshot directory entirely. */
  path?: string
}

export const expect = baseExpect.extend({
  /**
   * Compares the page against a committed style baseline.
   *
   * Honours `--update-snapshots` the same way the built-in matchers do:
   *   all      rewrite the baseline, pass
   *   changed  rewrite when it differs, pass
   *   missing  write only when absent, otherwise fail on difference
   *   none     never write
   */
  async toMatchStyleSnapshot(page: Page, options: StyleSnapshotOptions = {}) {
    const assertionName = 'toMatchStyleSnapshot'
    const info = test.info()

    const name = options.name ?? `${sanitize(info.titlePath.slice(1).join('-'))}.qain.json`
    const baselinePath = options.path ?? info.snapshotPath(name)
    const updateMode = info.config.updateSnapshots

    const actual = await snapshotOf(page, options)

    const baseline = await readBaseline(baselinePath)
    if (!baseline) {
      if (updateMode === 'none') {
        return {
          name: assertionName,
          pass: false,
          message: () =>
            `qain: no style baseline at ${baselinePath}\nRe-run with --update-snapshots to create it.`,
        }
      }
      await write(baselinePath, `${JSON.stringify(actual, null, 2)}\n`)
      // Matches how Playwright reports a freshly written screenshot baseline:
      // the run does not silently pass. Say so, so a first run does not read as a
      // real regression.
      return {
        name: assertionName,
        pass: false,
        message: () =>
          `qain: created a new style baseline at ${baselinePath}\nA first run fails by design, exactly like toHaveScreenshot — re-run to verify against it.`,
      }
    }

    const result = diff(baseline, actual, options)

    if (result.changes.length === 0) {
      return { name: assertionName, pass: true, message: () => 'style snapshot matched' }
    }

    if (updateMode === 'all' || updateMode === 'changed') {
      await write(baselinePath, `${JSON.stringify(actual, null, 2)}\n`)
      return {
        name: assertionName,
        pass: true,
        message: () => `qain: updated style baseline (${result.summary.total} changes)`,
      }
    }

    await info.attach(`${name}-diff.html`, {
      body: formatHtml(result),
      contentType: 'text/html',
    })
    await info.attach(`${name}-actual.json`, {
      body: `${JSON.stringify(actual, null, 2)}\n`,
      contentType: 'application/json',
    })

    // Captured with `replay: true`, both snapshots can be rebuilt into pages a
    // human can fade between. This is the closest qain gets to a screenshot, and
    // it needs no viewer beyond the Playwright report.
    if (hasTextRuns(baseline) && hasTextRuns(actual)) {
      await info.attach(`${name}-replay.html`, {
        body: renderReplayDiff(baseline, actual, result),
        contentType: 'text/html',
      })
    }

    const text = formatText(result, { color: false })
    const hint = 'Open the attached diff report, or re-run with --update-snapshots to accept.'
    return {
      name: assertionName,
      pass: false,
      message: () => `qain: style snapshot does not match ${baselinePath}\n\n${text}\n\n${hint}`,
    }
  },
})

/** Replay needs the per-line text rectangles that `capture({ replay: true })` records. */
function hasTextRuns(snapshot: Snapshot): boolean {
  return snapshot.states.some((state) => state.nodes.some((node) => node.textRuns !== undefined))
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
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'snapshot'
}
