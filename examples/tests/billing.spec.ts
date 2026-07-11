import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@qain/playwright'

/**
 * How qain looks inside a Playwright suite.
 *
 * In a real project you would write exactly this and commit the baseline:
 *
 *   test('billing page', async ({ page }) => {
 *     await page.goto('/')
 *     await expect(page).toMatchStyleSnapshot({ states: ['hover'], rules: true })
 *   })
 *
 * These tests pass an explicit `path` into a temp directory instead, so they can
 * assert both halves — the pass and the failure — without committing a baseline
 * that would drift with every Chrome release.
 */

let dir: string
let baseline: string

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qain-billing-'))
  baseline = join(dir, 'billing.qain.json')
})
test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Records the good variant as the committed baseline would be. */
async function recordBaseline(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.evaluate(() => document.fonts.ready)
  await expect(async () => {
    await expect(page).toMatchStyleSnapshot({ path: baseline, states: ['hover'], rules: true })
  }).rejects.toThrow(/created a new style baseline/)
}

test('the unchanged page matches its baseline', async ({ page }) => {
  await recordBaseline(page)
  await page.goto('/')
  await page.evaluate(() => document.fonts.ready)
  await expect(page).toMatchStyleSnapshot({ path: baseline, states: ['hover'], rules: true })
})

test('the regressed page fails, names every cause, and attaches a report', async ({
  page,
}, testInfo) => {
  await recordBaseline(page)

  await page.goto('/?variant=regressed')
  await page.evaluate(() => document.fonts.ready)

  let message = ''
  try {
    await expect(page).toMatchStyleSnapshot({ path: baseline, states: ['hover'], rules: true })
  } catch (error) {
    message = (error as Error).message
  }
  expect(message).toContain('style snapshot does not match')

  // The four edits, each surfaced in the language it belongs to.
  expect(message).toContain('.btn { padding: 8px 16px → 14px 16px }')
  expect(message).toContain('.muted { color: rgb(107, 114, 128) → rgb(199, 203, 212) }')
  expect(message).toContain('.badge { z-index: 2 → 0 }')
  expect(message).toContain('falls below WCAG AA-normal')
  expect(message).toContain('paint order')
  // The hover state stopped differing from rest.
  expect(message).toContain(':hover')

  // The rehashed utility class is not a change.
  expect(message).not.toContain('css-9f8e7d')

  const attached = testInfo.attachments.map((a) => a.name)
  expect(attached.some((name) => name.endsWith('-diff.html'))).toBe(true)
})

test('a failing run never rewrites the baseline', async ({ page }) => {
  // Accepting a regression takes `--update-snapshots`, and nothing else. Run the
  // suite twice without it and it fails identically both times — a baseline that
  // quietly heals itself is a baseline that tests nothing.
  await recordBaseline(page)
  await page.goto('/?variant=regressed')
  await page.evaluate(() => document.fonts.ready)

  expect(test.info().config.updateSnapshots).toBe('missing')
  for (const _attempt of [1, 2]) {
    await expect(async () => {
      await expect(page).toMatchStyleSnapshot({ path: baseline, states: ['hover'], rules: true })
    }).rejects.toThrow(/style snapshot does not match/)
  }
})
