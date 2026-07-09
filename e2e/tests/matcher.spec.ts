import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FORMAT_VERSION } from '@qain/core'
import { expect, test } from '@qain/playwright'

// The matcher writes a baseline on first run and fails, exactly as Playwright's
// own toHaveScreenshot does — a run that silently passes because there was
// nothing to compare against is worse than useless in CI.

test('writes a baseline on first run, then matches it', async ({ page }, testInfo) => {
  const dir = await mkdtemp(join(tmpdir(), 'qain-'))
  const path = join(dir, 'baseline.qain.json')
  try {
    await page.goto('/base.html')
    await page.evaluate(() => document.fonts.ready)

    // First run: no baseline yet.
    await expect(async () => {
      await expect(page).toMatchStyleSnapshot({ path })
    }).rejects.toThrow(/wrote a new style baseline/)

    const written = JSON.parse(await readFile(path, 'utf8'))
    expect(written.qain).toBe(FORMAT_VERSION)
    expect(written.states[0].state).toBe('default')

    // Second run: the page has not changed.
    await expect(page).toMatchStyleSnapshot({ path })
  } finally {
    await rm(dir, { recursive: true, force: true })
    void testInfo
  }
})

test('fails with a readable diff and attaches a report', async ({ page }, testInfo) => {
  const dir = await mkdtemp(join(tmpdir(), 'qain-'))
  const path = join(dir, 'baseline.qain.json')
  try {
    await page.goto('/base.html')
    await page.evaluate(() => document.fonts.ready)
    await expect(async () => {
      await expect(page).toMatchStyleSnapshot({ path })
    }).rejects.toThrow()

    await page.goto('/contrast-regression.html')
    await page.evaluate(() => document.fonts.ready)

    let message = ''
    try {
      await expect(page).toMatchStyleSnapshot({ path })
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).toContain('style snapshot does not match')
    expect(message).toContain('color:')
    expect(message).toContain('WCAG AA-normal')

    const attached = testInfo.attachments.map((a) => a.name)
    expect(attached.some((n) => n.endsWith('-diff.html'))).toBe(true)
    expect(attached.some((n) => n.endsWith('-actual.json'))).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('attaches a replay when the snapshots were captured for it', async ({ page }, testInfo) => {
  const dir = await mkdtemp(join(tmpdir(), 'qain-'))
  const path = join(dir, 'baseline.qain.json')
  try {
    await page.goto('/base.html')
    await page.evaluate(() => document.fonts.ready)
    await expect(async () => {
      await expect(page).toMatchStyleSnapshot({ path, replay: true })
    }).rejects.toThrow(/wrote a new style baseline/)

    await page.goto('/derived-shift.html')
    await page.evaluate(() => document.fonts.ready)
    await expect(async () => {
      await expect(page).toMatchStyleSnapshot({ path, replay: true })
    }).rejects.toThrow(/does not match/)

    const replay = testInfo.attachments.find((a) => a.name.endsWith('-replay.html'))
    expect(replay).toBeDefined()
    expect(replay!.contentType).toBe('text/html')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
