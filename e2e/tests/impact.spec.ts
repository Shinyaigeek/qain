import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { type CdpSession, capture, diff, type Snapshot } from '@qain/core'
import {
  buildReport,
  classifyOrigin,
  DEFAULT_CONFIG,
  globToRegExp,
  type ImpactConfig,
  type ImpactReport,
  packageNameFrom,
} from '@qain/impact'

const require = createRequire(import.meta.url)
const cliManifest = require.resolve('@qain/cli/package.json')
const cli = join(dirname(cliManifest), require('@qain/cli/package.json').bin.qain)

/**
 * The fixture design system lives under /vendor/ rather than /node_modules/,
 * because .gitignore would swallow the second. Package-name recovery from a real
 * node_modules path is covered by its own unit test below.
 */
const CONFIG: ImpactConfig = {
  ...DEFAULT_CONFIG,
  origins: { library: ['**/vendor/**'], theme: [] },
  targets: [],
}

async function snap(page: Page, path: string): Promise<Snapshot> {
  await page.goto(path)
  await page.evaluate(() => document.fonts.ready)
  const cdp = (await page.context().newCDPSession(page)) as unknown as CdpSession
  return capture(cdp, { rules: true, replay: true })
}

async function reportFor(page: Page, config: ImpactConfig = CONFIG): Promise<ImpactReport> {
  const before = await snap(page, '/impact-base.html')
  const after = await snap(page, '/impact-bumped.html')
  return buildReport(
    [
      {
        name: 'checkout',
        url: '/impact-bumped.html',
        status: 'changed',
        before,
        after,
        diff: diff(before, after),
      },
    ],
    config,
  )
}

// ---------------------------------------------------------------------------

test('globs match a path the way a stylesheet URL is shaped', () => {
  expect(globToRegExp('**/node_modules/**').test('http://x/node_modules/@acme/ds/a.css')).toBe(true)
  expect(globToRegExp('**/node_modules/**').test('http://x/src/app.css')).toBe(false)
  // `*` must not cross a separator, or every library pattern would match everything.
  expect(globToRegExp('**/tokens*.css').test('http://x/theme/tokens-dark.css')).toBe(true)
  expect(globToRegExp('**/tokens*.css').test('http://x/tokens/deep/a.css')).toBe(false)
})

test('recovers the package a stylesheet was published in', () => {
  expect(packageNameFrom('http://x/node_modules/@acme/ds/dist/button.css')).toBe('@acme/ds')
  expect(packageNameFrom('http://x/node_modules/normalize/normalize.css')).toBe('normalize')
  // pnpm's virtual store nests a second node_modules; the last one is the real name.
  expect(
    packageNameFrom('/node_modules/.pnpm/@acme+ds@1.2.3/node_modules/@acme/ds/dist/x.css'),
  ).toBe('@acme/ds')
  // A bundler's own directory is not a package.
  expect(packageNameFrom('http://x/node_modules/.vite/deps/chunk.css')).toBe(null)
  expect(packageNameFrom('http://x/src/app.css')).toBe(null)
})

test('a declaration with no source location is reported as unknown, not as local', () => {
  // This is what runtime-injected CSS-in-JS looks like over CDP. Calling it "local"
  // would quietly credit the application for a library's change.
  expect(classifyOrigin(null, CONFIG.origins)).toEqual({ kind: 'unknown', name: 'unknown' })
})

// ---------------------------------------------------------------------------

test('groups changes under the design-system component that owns them', async ({ page }) => {
  const report = await reportFor(page)

  const button = report.components.find((c) => c.component === 'Button')
  expect(button, 'the Button component should appear in the report').toBeTruthy()
  expect(button!.primary).toBeGreaterThan(0)
  expect(button!.targets).toEqual(['checkout'])

  // The label's colour lives on a span *inside* the button, and the span carries no
  // attribute of its own — it is only found by walking up to the nearest one.
  expect(button!.examples.some((path) => path.includes('span'))).toBe(true)
})

test('names the library behind the change, not just the fact of it', async ({ page }) => {
  const report = await reportFor(page)

  const button = report.components.find((c) => c.component === 'Button')!
  expect(button.origins.map((o) => o.kind)).toContain('library')

  const causes = button.causes.map((c) => `${c.selector} ${c.property}`)
  expect(causes.some((c) => c.includes('.acme-Button') && c.includes('padding'))).toBe(true)
  expect(button.causes.every((c) => c.source !== '<unknown>')).toBe(true)

  const library = report.byOrigin.find((o) => o.origin.kind === 'library')
  expect(library, 'the report should have a library bucket').toBeTruthy()
  expect(library!.components).toContain('Button')
})

test('a component that only moved is separated from the one that changed', async ({ page }) => {
  const report = await reportFor(page)

  // The card sits below the button, so a taller button pushes it down. That is
  // collateral, and the whole point of qain is not to bill it as a regression.
  const card = report.components.find((c) => c.component === 'Card')
  expect(card, 'the Card moved, so it should be reported').toBeTruthy()
  expect(card!.primary).toBe(0)
  expect(card!.derived).toBeGreaterThan(0)

  const trimmed = await reportFor(page, { ...CONFIG, omitDerived: true })
  expect(trimmed.components.map((c) => c.component)).toContain('Button')
  expect(trimmed.components.map((c) => c.component)).not.toContain('Card')
})

// ---------------------------------------------------------------------------

test('the CLI writes baselines, then reports the blast radius against them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qain-impact-'))
  const browser = process.env.QAIN_CHROME_PATH ? { browser: process.env.QAIN_CHROME_PATH } : {}
  const run = (configPath: string, args: string[] = []) =>
    spawnSync(process.execPath, [cli, 'impact', '--config', configPath, ...args], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })

  const write = async (file: string, page: string): Promise<string> => {
    const path = join(dir, file)
    await writeFile(
      path,
      JSON.stringify({
        ...browser,
        baselineDir: join(dir, 'baselines'),
        origins: { library: ['**/vendor/**'], theme: [] },
        targets: [{ name: 'checkout', url: `http://localhost:5599/${page}` }],
      }),
    )
    return path
  }

  try {
    // The baseline stands in for the base branch; the second config for HEAD.
    const baseConfig = await write('base.json', 'impact-base.html')
    const update = run(baseConfig, ['--update'])
    expect(update.stderr).toContain('baseline')
    expect(update.status).toBe(0)

    const unchanged = run(baseConfig, ['--json'])
    expect(unchanged.status, 'the same page against its own baseline is clean').toBe(0)

    const headConfig = await write('head.json', 'impact-bumped.html')
    const changed = run(headConfig, ['--json'])
    expect(changed.status, 'a non-empty report exits 1, so CI can gate on it').toBe(1)

    const report = JSON.parse(changed.stdout) as ImpactReport
    expect(report.summary.targetsChanged).toBe(1)
    expect(report.components.map((c) => c.component)).toContain('Button')
    expect(report.byOrigin.some((o) => o.origin.kind === 'library')).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unbaselined target exits non-zero rather than reporting all clear', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qain-impact-'))
  try {
    const path = join(dir, 'config.json')
    await writeFile(
      path,
      JSON.stringify({
        baselineDir: join(dir, 'baselines'),
        targets: [{ name: 'never-captured', url: 'http://localhost:5599/impact-base.html' }],
      }),
    )
    const result = spawnSync(process.execPath, [cli, 'impact', '--config', path, '--json'], {
      cwd: dir,
      encoding: 'utf8',
    })

    expect(result.status).toBe(1)
    const report = JSON.parse(result.stdout) as ImpactReport
    expect(report.summary.missingBaselines).toBe(1)
    expect(report.targets[0]!.status).toBe('missing-baseline')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
