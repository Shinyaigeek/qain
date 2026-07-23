import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { matchStyleSnapshot } from '@qain/storybook'

// The Storybook test runner hands `postVisit(page, context)` a Playwright page
// against a real Chromium — exactly what a Playwright test already is. So the whole
// adapter is exercised end to end here without standing up Storybook.

const story = { id: 'components-button--primary' }

async function scratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'qain-sb-'))
}

test.beforeEach(async ({ page }) => {
  await page.goto('/story-root.html')
  await page.evaluate(() => document.fonts.ready)
})

test('scopes to #storybook-root and matches a written baseline', async ({ page }) => {
  const dir = await scratchDir()
  try {
    // Seed a baseline (update bypasses the CI guard), then assert it matches.
    await matchStyleSnapshot(page as Page, story, { snapshotDir: dir, update: true })
    await matchStyleSnapshot(page as Page, story, { snapshotDir: dir })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('throws the readable diff when the story restyles', async ({ page }) => {
  const dir = await scratchDir()
  try {
    await matchStyleSnapshot(page as Page, story, { snapshotDir: dir, update: true })
    await page.evaluate(() => {
      const button = document.querySelector('.btn') as HTMLElement
      button.style.padding = '20px 16px'
      button.style.background = 'rgb(220, 38, 38)'
    })
    await expect(matchStyleSnapshot(page as Page, story, { snapshotDir: dir })).rejects.toThrow(
      /does not match/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing baseline fails under CI instead of writing one', async ({ page }) => {
  const dir = await scratchDir()
  const saved = process.env.CI
  try {
    process.env.CI = 'true'
    await expect(
      matchStyleSnapshot(page as Page, { id: 'never--committed' }, { snapshotDir: dir }),
    ).rejects.toThrow(/no style baseline/)
  } finally {
    // Restore, without `delete` (biome noDelete): '' reads as unset to isCI().
    process.env.CI = saved ?? ''
    await rm(dir, { recursive: true, force: true })
  }
})
