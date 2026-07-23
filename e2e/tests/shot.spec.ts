import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { type CdpSession, capture } from '@qain/core'

// The CLI entry, resolved through the package: the bin shim does not exist
// when install ran before build.
const require = createRequire(import.meta.url)
const cliManifest = require.resolve('@qain/cli/package.json')
const cli = join(dirname(cliManifest), require('@qain/cli/package.json').bin.qain)

function qainShot(args: string[]) {
  const browser = process.env.QAIN_CHROME_PATH ? ['--browser', process.env.QAIN_CHROME_PATH] : []
  return spawnSync(process.execPath, [cli, 'shot', ...args, ...browser], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}

async function snapTo(page: Page, path: string, file: string, options = {}): Promise<void> {
  await page.goto(path)
  await page.evaluate(() => document.fonts.ready)
  const cdp = (await page.context().newCDPSession(page)) as unknown as CdpSession
  const snapshot = await capture(cdp, options)
  await writeFile(file, JSON.stringify(snapshot))
}

function pngSize(buffer: Buffer): { width: number; height: number } {
  expect(buffer.subarray(0, 8).toString('latin1')).toBe('\x89PNG\r\n\x1a\n')
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

let dir: string
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qain-shot-'))
})
test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('renders before.png, after.png and a red-overlay diff.png', async ({ page }) => {
  const before = join(dir, 'before.json')
  const after = join(dir, 'after.json')
  await snapTo(page, '/cascade.html', before, { replay: true })
  await snapTo(page, '/cascade-changed.html', after, { replay: true })

  const result = qainShot([before, after, '-o', join(dir, 'shots')])
  expect(result.stderr).toContain('diff.png')
  expect(result.status).toBe(0)

  const pngs = await Promise.all(
    ['before.png', 'after.png', 'diff.png'].map((f) => readFile(join(dir, 'shots', f))),
  )
  const [b, a, d] = pngs.map(pngSize)

  // The bare replay stage is screenshotted at the recorded page size, and the
  // diff canvas covers the larger of the two renders.
  expect(b.width).toBeGreaterThan(0)
  expect(d.width).toBe(Math.max(b.width, a.width))
  expect(d.height).toBe(Math.max(b.height, a.height))

  // The fixtures render differently, so the two screenshots cannot be equal.
  expect(pngs[0].equals(pngs[1])).toBe(false)
})

test('refuses snapshots captured without --replay', async ({ page }) => {
  const before = join(dir, 'before.json')
  const after = join(dir, 'after.json')
  await snapTo(page, '/cascade.html', before)
  await snapTo(page, '/cascade-changed.html', after)

  const result = qainShot([before, after, '-o', join(dir, 'shots')])
  expect(result.status).toBe(2)
  expect(result.stderr).toContain('--replay')
})
