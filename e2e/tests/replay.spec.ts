import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import {
  type CdpSession,
  capture,
  diff,
  renderReplay,
  renderReplayDiff,
  type Snapshot,
} from '@qain/core'

async function snap(page: Page, path: string, options = {}): Promise<Snapshot> {
  await page.goto(path)
  await page.evaluate(() => document.fonts.ready)
  const cdp = (await page.context().newCDPSession(page)) as unknown as CdpSession
  return capture(cdp, options)
}

/** Serve the replay HTML from disk so relative URLs and `<base>` behave. */
async function openReplay(page: Page, html: string, dir: string): Promise<void> {
  const file = join(dir, 'replay.html')
  await writeFile(file, html)
  await page.goto(`file://${file}`)
  await page.evaluate(() => document.fonts.ready)
}

let dir: string
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qain-replay-'))
})
test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('every element is rebuilt at the exact rectangle it was recorded at', async ({ page }) => {
  // Replay never re-runs layout: it places each box at its recorded coordinates.
  // So the rebuilt DOM must agree with the snapshot to within float rounding.
  const snapshot = await snap(page, '/base.html', { replay: true })
  await openReplay(page, renderReplay(snapshot), dir)

  const actual = await page.evaluate(() => {
    const stage = document.querySelector('.stage')!.getBoundingClientRect()
    const out: Record<string, number[]> = {}
    for (const el of document.querySelectorAll<HTMLElement>('.stage .n[data-qain-key]')) {
      const r = el.getBoundingClientRect()
      out[el.dataset.qainKey!] = [r.x - stage.x, r.y - stage.y, r.width, r.height]
    }
    return out
  })

  const nodes = snapshot.states[0]!.nodes.filter((n) => n.box && !['html', 'body'].includes(n.tag))
  expect(nodes.length).toBeGreaterThan(3)

  for (const node of nodes) {
    const rebuilt = actual[node.key]
    expect(rebuilt, `${node.key} was not rebuilt`).toBeDefined()
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(rebuilt![i]! - node.box![i]!), `${node.key} axis ${i}`).toBeLessThan(0.5)
    }
  }
})

test('each line of text lands where the browser originally put it', async ({ page }) => {
  // This is what buys back `padding`, which the projection deliberately omits. A
  // button's text run sits inside its border box by exactly the border + padding.
  const snapshot = await snap(page, '/base.html', { replay: true })
  await openReplay(page, renderReplay(snapshot), dir)

  const rendered = await page.evaluate(() => {
    const stage = document.querySelector('.stage')!.getBoundingClientRect()
    return [...document.querySelectorAll<HTMLElement>('.stage .t')].map((el) => {
      const r = el.getBoundingClientRect()
      return {
        key: el.dataset.qainKey!,
        text: el.textContent!,
        box: [r.x - stage.x, r.y - stage.y, r.width, r.height],
      }
    })
  })

  const expected = snapshot.states[0]!.nodes.flatMap((n) =>
    (n.textRuns ?? []).map((run) => ({ key: n.key, ...run })),
  )
  expect(expected.length).toBeGreaterThan(2)
  expect(rendered).toHaveLength(expected.length)

  for (const run of expected) {
    const match = rendered.find((r) => r.key === run.key && r.text === run.text)
    expect(match, `${run.key} run ${JSON.stringify(run.text)}`).toBeDefined()
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(match!.box[i]! - run.box[i]!)).toBeLessThan(0.5)
    }
  }

  // The submit button's text is inset from its own border box — that inset is the
  // padding, which appears nowhere in the snapshot.
  const submit = snapshot.states[0]!.nodes.find((n) => n.key === '@submit')!
  expect(submit.textRuns![0]!.box[0]).toBeGreaterThan(submit.box![0])
  expect(submit.textRuns![0]!.box[1]).toBeGreaterThan(submit.box![1])
})

test('the rebuilt page is pixel-identical to the original', async ({ page, browser }) => {
  const snapshot = await snap(page, '/base.html', { replay: true })
  const width = 1280
  const height = Math.ceil(
    Math.max(...snapshot.states[0]!.nodes.filter((n) => n.box).map((n) => n.box![1] + n.box![3])),
  )

  const original = await page.screenshot({ clip: { x: 0, y: 0, width, height } })

  const replayPage = await browser.newPage({ viewport: { width, height: height + 200 } })
  await openReplay(replayPage, renderReplay(snapshot), dir)
  // Pin the stage to the document origin: a fractional offset would shift the whole
  // reconstruction off the device-pixel grid and blur every glyph.
  await replayPage.addStyleTag({
    content:
      'header,aside{display:none!important}.scroll{padding:0!important;overflow:visible!important}body{display:block!important;height:auto!important}',
  })
  const rebuilt = await replayPage.screenshot({ clip: { x: 0, y: 0, width, height } })
  await replayPage.close()

  expect(rebuilt.equals(original)).toBe(true)
})

test('a pseudo-state replays over the default page, not on an empty one', async ({ page }) => {
  // A hover capture holds only the forced subtrees. Drawing it alone would show two
  // buttons floating on nothing.
  const snapshot = await snap(page, '/hover-color.html', { replay: true, states: ['hover'] })
  await openReplay(page, renderReplay(snapshot, { state: 'hover' }), dir)

  const backgrounds = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.stage .n[data-qain-key^="@"]')].map(
      (el) => el.style.backgroundColor,
    ),
  )
  expect(backgrounds).toEqual(['rgb(200, 200, 200)', 'rgb(200, 200, 200)'])

  // The surrounding page is still there.
  const keys = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.stage .n')].map((el) => el.dataset.qainKey),
  )
  expect(keys.length).toBeGreaterThan(2)
})

test('a diff replay marks causes apart from collateral and lists them', async ({ page }) => {
  const before = await snap(page, '/base.html', { replay: true })
  const after = await snap(page, '/derived-shift.html', { replay: true })
  const result = diff(before, after)

  await openReplay(page, renderReplayDiff(before, after, result), dir)

  const stages = await page.locator('.stage').count()
  expect(stages).toBe(2)

  const primary = await page
    .locator('.stage .c-primary[data-qain-key]')
    .evaluateAll((els) => [...new Set(els.map((el) => (el as HTMLElement).dataset.qainKey))])
  const derived = await page
    .locator('.stage .c-derived[data-qain-key]')
    .evaluateAll((els) => [...new Set(els.map((el) => (el as HTMLElement).dataset.qainKey))])

  expect(primary.sort()).toEqual(['@cancel', '@submit'])
  expect(derived).toContain('@note')
  expect(primary).not.toContain('@note')

  // The cause list names them, and only them.
  const causes = await page.locator('aside li').allTextContents()
  expect(causes.length).toBe(2)
  expect(causes.join(' ')).toContain('resized')

  // Overlay mode exists and fades the "after" stage.
  await page.selectOption('#mode', 'overlay')
  const opacity = await page
    .locator('.stages figure')
    .nth(1)
    .evaluate((el) => el.style.opacity)
  expect(Number(opacity)).toBeGreaterThan(0)
  expect(Number(opacity)).toBeLessThan(1)
})

test('the diff view zooms and spotlights a change on click', async ({ page }) => {
  const before = await snap(page, '/base.html', { replay: true })
  const after = await snap(page, '/derived-shift.html', { replay: true })
  const result = diff(before, after)
  await openReplay(page, renderReplayDiff(before, after, result), dir)

  // Zoom: the + button scales the canvas, reset returns it to 1.
  await page.locator('[data-zoom="in"]').click()
  const zoomed = await page.locator('.stages').evaluate((el) => Number(el.style.zoom))
  expect(zoomed).toBeGreaterThan(1)
  await page.locator('[data-zoom="reset"]').click()
  expect(await page.locator('.stages').evaluate((el) => el.style.zoom)).toBe('1')

  // Clicking a cause spotlights every box for that node and marks the row.
  const first = page.locator('aside li').first()
  const key = await first.getAttribute('data-jump')
  await first.click()
  await expect(first).toHaveClass(/active/)
  const selected = await page
    .locator('.stage .selected')
    .evaluateAll((els) => [...new Set(els.map((el) => (el as HTMLElement).dataset.qainKey))])
  expect(selected).toEqual([key])

  // Escape clears the spotlight.
  await page.keyboard.press('Escape')
  expect(await page.locator('.stage .selected').count()).toBe(0)
})

test('a snapshot captured without replay still draws boxes, just no text', async ({ page }) => {
  const snapshot = await snap(page, '/base.html')
  expect(snapshot.states[0]!.nodes.every((n) => n.textRuns === undefined)).toBe(true)

  await openReplay(page, renderReplay(snapshot), dir)
  expect(await page.locator('.stage .n').count()).toBeGreaterThan(3)
  expect(await page.locator('.stage .t').count()).toBe(0)
})
