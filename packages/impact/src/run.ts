import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { diff, type Snapshot } from '@qain/core'
import type { Browser } from 'playwright-core'
import { buildReport, type TargetResult } from './aggregate.js'
import { captureTarget, withBrowser } from './capture.js'
import { baselineName, targetUrl } from './config.js'
import { hasTextRuns, renderShots } from './shots.js'
import type { ImpactConfig, ImpactReport } from './types.js'

export interface RunOptions {
  /** Write before/after/diff PNGs for every changed target into this directory. */
  shotsDir?: string
  onProgress?: (name: string, index: number, total: number) => void
}

export function baselinePath(config: ImpactConfig, name: string): string {
  return join(config.baselineDir, `${baselineName(name)}.qain.json`)
}

async function readBaseline(path: string): Promise<Snapshot | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Snapshot
  } catch {
    return null
  }
}

/**
 * Captures every target and rewrites its baseline. Run on the base branch — merges
 * to main, or a nightly job — never on the PR.
 *
 * Capturing both sides per PR would mean checking out the base ref, installing and
 * building it inside the PR job. That is the slowest and most fragile shape this
 * tool could take, and a stored baseline avoids it entirely.
 */
export async function updateBaselines(
  config: ImpactConfig,
  options: RunOptions = {},
): Promise<string[]> {
  await mkdir(config.baselineDir, { recursive: true })
  const written: string[] = []

  await withBrowser(config, async (browser) => {
    for (const [index, target] of config.targets.entries()) {
      options.onProgress?.(target.name, index, config.targets.length)
      const { snapshot } = await captureTarget(browser, target, config)
      const path = baselinePath(config, target.name)
      await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`)
      written.push(path)
    }
  })

  return written
}

/**
 * Captures every target at HEAD, diffs each against its stored baseline, and folds
 * the results into one blast-radius report.
 *
 * A target whose capture throws is recorded as an error rather than aborting the
 * run: one page that fails to load should not cost the report for the other forty.
 */
export async function runImpact(
  config: ImpactConfig,
  options: RunOptions = {},
): Promise<ImpactReport> {
  const results: TargetResult[] = []

  await withBrowser(config, async (browser) => {
    for (const [index, target] of config.targets.entries()) {
      options.onProgress?.(target.name, index, config.targets.length)

      // Resolved up front so a config error is reported against the target, not
      // thrown out of the run.
      let url: string
      try {
        url = targetUrl(target, config.baseUrl)
      } catch (error) {
        results.push({
          name: target.name,
          url: target.url ?? target.path ?? '',
          status: 'error',
          error: (error as Error).message,
        })
        continue
      }

      const before = await readBaseline(baselinePath(config, target.name))
      if (!before) {
        results.push({ name: target.name, url, status: 'missing-baseline' })
        continue
      }

      try {
        const { snapshot: after } = await captureTarget(browser, target, config)
        const result = diff(before, after)
        results.push({
          name: target.name,
          url,
          status: result.changes.length > 0 ? 'changed' : 'unchanged',
          before,
          after,
          diff: result,
        })
      } catch (error) {
        results.push({ name: target.name, url, status: 'error', error: (error as Error).message })
      }
    }

    if (options.shotsDir) await writeShots(browser, results, options.shotsDir)
  })

  return buildReport(results, config)
}

/**
 * One before/after/diff triptych per changed target, rendered from the snapshots
 * alone. Needs the text rectangles on both sides; a baseline captured by an older
 * version without them is skipped rather than failing the run.
 */
async function writeShots(browser: Browser, results: TargetResult[], dir: string): Promise<void> {
  const changed = results.filter((r) => r.status === 'changed' && r.before && r.after)
  if (changed.length === 0) return

  const page = await browser.newPage()
  try {
    for (const result of changed) {
      const before = result.before!
      const after = result.after!
      if (!hasTextRuns(before) || !hasTextRuns(after)) continue

      const out = join(dir, baselineName(result.name))
      await mkdir(out, { recursive: true })
      const shots = await renderShots(page, before, after)
      await writeFile(join(out, 'before.png'), shots.before)
      await writeFile(join(out, 'after.png'), shots.after)
      await writeFile(join(out, 'diff.png'), shots.diff)
    }
  } finally {
    await page.close()
  }
}
