import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Browser, expect, type Page, test } from '@playwright/test'
import { type CdpSession, capture, renderReplay, type Snapshot } from '@qain/core'

/**
 * Replay fidelity: the bare reconstruction must look like the page it was taken
 * from. `replay.spec.ts` proves this pixel-for-pixel on one page; this file is the
 * broad "are we sure this survives replay?" sweep — one small, static page per
 * construct, each screenshotted twice and compared.
 *
 * The check is a differing-pixel ratio over a tight crop, not exact equality: the
 * fixtures have anti-aliased text and edges that wobble by a shade between two
 * independent renders. A construct replay handles must stay near zero; a construct
 * it cannot (documented in replay.ts) is pinned to a budget so a *further* drift is
 * still caught, and a future fix that closes the gap shows up as slack to reclaim.
 */

async function snapPath(page: Page, path: string): Promise<Snapshot> {
  await page.goto(path)
  await page.evaluate(() => document.fonts.ready)
  const cdp = (await page.context().newCDPSession(page)) as unknown as CdpSession
  return capture(cdp, { replay: true })
}

/** The content's bounding box, minus the html/body boxes that span the viewport. */
function contentSize(snapshot: Snapshot): { width: number; height: number } {
  let width = 0
  let height = 0
  for (const node of snapshot.states[0]!.nodes) {
    if (!node.box || node.tag === 'html' || node.tag === 'body') continue
    width = Math.max(width, node.box[0] + node.box[2])
    height = Math.max(height, node.box[1] + node.box[3])
  }
  return { width: Math.ceil(width), height: Math.ceil(height) }
}

/**
 * Screenshot the page as it stands now (the original) and the bare replay of
 * `snapshot`, both pinned to the document origin, and return the fraction of pixels
 * that differ by more than a shade.
 */
async function divergence(
  page: Page,
  browser: Browser,
  dir: string,
  snapshot: Snapshot,
): Promise<number> {
  const { width, height } = contentSize(snapshot)
  const original = await page.screenshot({ clip: { x: 0, y: 0, width, height } })

  const replayPage = await browser.newPage({ viewport: { width, height: height + 200 } })
  const file = join(dir, 'replay.html')
  await writeFile(file, renderReplay(snapshot, { bare: true }))
  await replayPage.goto(`file://${file}`)
  await replayPage.evaluate(() => document.fonts.ready)
  const rebuilt = await replayPage.screenshot({ clip: { x: 0, y: 0, width, height } })
  await replayPage.close()

  return page.evaluate(
    async ([a, b, w, h]) => {
      function decode(dataUrl: string): Promise<Uint8ClampedArray> {
        return new Promise((resolve) => {
          const img = new Image()
          img.onload = () => {
            const canvas = document.createElement('canvas')
            canvas.width = w as number
            canvas.height = h as number
            const ctx = canvas.getContext('2d')!
            ctx.drawImage(img, 0, 0)
            resolve(ctx.getImageData(0, 0, w as number, h as number).data)
          }
          img.src = dataUrl
        })
      }
      const [pa, pb] = await Promise.all([decode(a as string), decode(b as string)])
      let differ = 0
      for (let i = 0; i < pa.length; i += 4) {
        if (
          Math.abs(pa[i]! - pb[i]!) > 16 ||
          Math.abs(pa[i + 1]! - pb[i + 1]!) > 16 ||
          Math.abs(pa[i + 2]! - pb[i + 2]!) > 16
        )
          differ++
      }
      return differ / (pa.length / 4)
    },
    [
      `data:image/png;base64,${original.toString('base64')}`,
      `data:image/png;base64,${rebuilt.toString('base64')}`,
      width,
      height,
    ] as const,
  )
}

let dir: string
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qain-fidelity-'))
})
test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// The whole-page integration check, plus the two mechanisms it leans on.

test('the bare replay of a static page matches the original within anti-alias noise', async ({
  page,
  browser,
}) => {
  const snapshot = await snapPath(page, '/fidelity/page.html')
  const ratio = await divergence(page, browser, dir, snapshot)
  expect(ratio, `${(ratio * 100).toFixed(2)}% of pixels differ`).toBeLessThan(0.01)
})

test('a child that overflows a clipping parent is cut, not left dangling', async ({ page }) => {
  const snapshot = await snapPath(page, '/fidelity/page.html')
  await writeFile(join(dir, 'replay.html'), renderReplay(snapshot, { bare: true }))
  await page.goto(`file://${join(dir, 'replay.html')}`)

  const banner = snapshot.states[0]!.nodes.find((n) => n.attrs.class === 'banner')!
  const card = snapshot.states[0]!.nodes.find((n) => n.attrs.class === 'card')!
  expect(banner.box![2]).toBeGreaterThan(card.box![2]) // the banner really does overflow

  const clipPath = await page.evaluate((key) => {
    const el = [...document.querySelectorAll<HTMLElement>('.stage .n')].find(
      (n) => n.dataset.qainKey === key,
    )!
    return getComputedStyle(el).clipPath
  }, banner.key)
  expect(clipPath).not.toBe('none')
})

test('a child under a faded ancestor is faded too', async ({ page }) => {
  const snapshot = await snapPath(page, '/fidelity/page.html')
  await writeFile(join(dir, 'replay.html'), renderReplay(snapshot, { bare: true }))
  await page.goto(`file://${join(dir, 'replay.html')}`)

  const button = snapshot.states[0]!.nodes.find((n) => n.attrs.class === 'btn')!
  const opacity = await page.evaluate((key) => {
    const el = [...document.querySelectorAll<HTMLElement>('.stage .n')].find(
      (n) => n.dataset.qainKey === key,
    )!
    return getComputedStyle(el).opacity
  }, button.key)
  expect(Number(opacity)).toBeCloseTo(0.4, 1)
})

// ---------------------------------------------------------------------------
// Constructs replay is meant to reproduce exactly. Each renders to within
// anti-alias noise of the original — the reassuring half of the sweep.

const FAITHFUL: { name: string; file: string }[] = [
  { name: 'flex row with gap', file: 'flex-gap.html' },
  { name: 'css grid', file: 'grid.html' },
  { name: 'absolute overlap honours paint order', file: 'abs-overlap.html' },
  { name: 'negative margin overlap', file: 'neg-margin.html' },
  { name: 'paragraph wrapping onto many lines', file: 'wrap-paragraph.html' },
  { name: 'nested overflow clipping', file: 'nested-clip.html' },
  { name: 'inline-block baseline alignment', file: 'inline-block.html' },
  { name: 'float with text flowing around it', file: 'float.html' },
  { name: 'semi-transparent layer composited over a colour', file: 'rgba-stack.html' },
  { name: 'border-radius', file: 'radius.html' },
  { name: 'box-shadow', file: 'box-shadow.html' },
  { name: 'full-size gradient', file: 'gradient.html' },
  { name: 'text-decoration underline and strike', file: 'text-decoration.html' },
  { name: 'uniform ancestor opacity', file: 'uniform-opacity.html' },
  { name: 'mix-blend-mode multiply', file: 'mix-blend.html' },
  { name: 'preformatted whitespace', file: 'pre.html' },
  { name: 'pseudo-element ::before content', file: 'pseudo-before.html' },
]

for (const { name, file } of FAITHFUL) {
  test(`faithful: ${name}`, async ({ page, browser }) => {
    const snapshot = await snapPath(page, `/fidelity/${file}`)
    const ratio = await divergence(page, browser, dir, snapshot)
    expect(ratio, `${(ratio * 100).toFixed(2)}% of pixels differ`).toBeLessThan(0.015)
  })
}

// ---------------------------------------------------------------------------
// Constructs replay documents it cannot reproduce (see replay.ts). Pinned to a
// budget above what they cost today, so a regression that widens the gap trips
// and a fix that closes it leaves obvious slack.

const LIMITS: { name: string; file: string; budget: number; why: string }[] = [
  {
    name: 'rotation replays as its bounding box',
    file: 'rotate.html',
    budget: 0.25,
    why: 'bounds is axis-aligned; the rotation is not re-applied',
  },
  {
    name: 'positioned/sized gradient falls back to default',
    file: 'positioned-gradient.html',
    budget: 0.65,
    why: 'background-size/-position/-repeat are not projected',
  },
  {
    name: "faded ancestor's background tints a faded child",
    file: 'opacity-tint.html',
    budget: 0.3,
    why: 'per-element opacity is not group compositing',
  },
  {
    name: 'text-shadow is dropped',
    file: 'text-shadow.html',
    budget: 0.15,
    why: 'text-shadow is not projected',
  },
  {
    name: 'text-overflow ellipsis is hard-clipped without the glyph',
    file: 'ellipsis.html',
    budget: 0.06,
    why: 'the run carries the full text; replay clips it rather than drawing the …',
  },
]

for (const { name, file, budget, why } of LIMITS) {
  test(`known limitation: ${name}`, async ({ page, browser }) => {
    const snapshot = await snapPath(page, `/fidelity/${file}`)
    const ratio = await divergence(page, browser, dir, snapshot)
    expect(ratio, `${(ratio * 100).toFixed(2)}% differ — ${why}`).toBeLessThan(budget)
  })
}
