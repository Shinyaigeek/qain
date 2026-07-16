import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Browser, type Page, expect, test } from '@playwright/test'
import { type CdpSession, type Snapshot, capture, renderReplay } from '@qain/core'

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

async function snapContent(page: Page, body: string): Promise<Snapshot> {
  await page.goto('/base.html')
  await page.setContent(
    `<!doctype html><meta charset=utf-8><style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#fff}</style><div style="padding:16px;display:inline-block">${body}</div>`,
  )
  await page.evaluate(() => document.fonts.ready)
  const cdp = (await page.context().newCDPSession(page)) as unknown as CdpSession
  return capture(cdp, { replay: true })
}

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
  const snapshot = await snapPath(page, '/replay-fidelity.html')
  const ratio = await divergence(page, browser, dir, snapshot)
  expect(ratio, `${(ratio * 100).toFixed(2)}% of pixels differ`).toBeLessThan(0.01)
})

test('a child that overflows a clipping parent is cut, not left dangling', async ({ page }) => {
  const snapshot = await snapPath(page, '/replay-fidelity.html')
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
  const snapshot = await snapPath(page, '/replay-fidelity.html')
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

const FAITHFUL: { name: string; body: string }[] = [
  {
    name: 'flex row with gap',
    body: `<div style="display:flex;gap:12px"><div style="width:60px;height:40px;background:#3b82f6"></div><div style="width:60px;height:40px;background:#22c55e"></div><div style="width:60px;height:40px;background:#ef4444"></div></div>`,
  },
  {
    name: 'css grid',
    body: `<div style="display:grid;grid-template-columns:80px 80px;gap:8px"><div style="height:40px;background:#3b82f6"></div><div style="height:40px;background:#22c55e"></div><div style="height:40px;background:#ef4444"></div><div style="height:40px;background:#eab308"></div></div>`,
  },
  {
    name: 'absolute overlap honours paint order',
    body: `<div style="position:relative;height:80px;width:90px"><div style="position:absolute;left:0;top:0;width:60px;height:60px;background:#3b82f6"></div><div style="position:absolute;left:30px;top:20px;width:60px;height:60px;background:#ef4444"></div></div>`,
  },
  {
    name: 'negative margin overlap',
    body: `<div style="width:80px;height:40px;background:#3b82f6"></div><div style="width:80px;height:40px;background:#ef4444;margin-top:-15px;margin-left:20px"></div>`,
  },
  {
    name: 'paragraph wrapping onto many lines',
    body: `<p style="width:180px;margin:0;color:#111">This paragraph is deliberately narrow so it wraps onto several lines of text.</p>`,
  },
  {
    name: 'nested overflow clipping',
    body: `<div style="width:120px;height:50px;overflow:hidden;background:#eee"><div style="width:200px;height:80px;overflow:hidden;background:#ddd"><div style="width:300px;height:120px;background:#3b82f6"></div></div></div>`,
  },
  {
    name: 'inline-block baseline alignment',
    body: `<div><span style="display:inline-block;width:40px;height:20px;background:#3b82f6"></span><span style="display:inline-block;width:40px;height:50px;background:#22c55e"></span><span style="display:inline-block;width:40px;height:30px;background:#ef4444"></span></div>`,
  },
  {
    name: 'float with text flowing around it',
    body: `<div style="width:200px"><div style="float:left;width:40px;height:40px;background:#3b82f6;margin-right:8px"></div><span style="color:#111">Text flowing to the right of a floated box, wrapping under it.</span></div>`,
  },
  {
    name: 'semi-transparent layer composited over a colour',
    body: `<div style="background:#0000ff;padding:16px"><div style="background:rgba(255,255,255,.5);color:#000;padding:8px">overlay text</div></div>`,
  },
  {
    name: 'border-radius',
    body: `<div style="width:80px;height:80px;background:#3b82f6;border-radius:20px"></div>`,
  },
  {
    name: 'box-shadow',
    body: `<div style="width:80px;height:40px;background:#fff;box-shadow:4px 4px 8px rgba(0,0,0,.4);margin:12px"></div>`,
  },
  {
    name: 'full-size gradient',
    body: `<div style="width:160px;height:60px;background-image:linear-gradient(90deg,#ef4444,#3b82f6)"></div>`,
  },
  {
    name: 'text-decoration underline and strike',
    body: `<div><span style="color:#111;text-decoration:underline">underlined</span> <span style="color:#111;text-decoration:line-through">struck</span></div>`,
  },
  {
    name: 'uniform ancestor opacity',
    body: `<div style="opacity:.5"><div style="width:80px;height:40px;background:#3b82f6"></div><div style="color:#111">faded text</div></div>`,
  },
  {
    name: 'mix-blend-mode multiply',
    body: `<div style="background:#ff0000;width:120px;height:60px;position:relative"><div style="position:absolute;left:20px;top:10px;width:80px;height:40px;background:#00ff00;mix-blend-mode:multiply"></div></div>`,
  },
  {
    name: 'preformatted whitespace',
    body: `<pre style="margin:0;color:#111;font:14px monospace">line one\n  indented\nline three</pre>`,
  },
  {
    name: 'pseudo-element ::before content',
    body: `<style>.pb::before{content:'\\2605 ';color:#eab308}</style><div class="pb" style="color:#111">starred</div>`,
  },
]

for (const { name, body } of FAITHFUL) {
  test(`faithful: ${name}`, async ({ page, browser }) => {
    const snapshot = await snapContent(page, body)
    const ratio = await divergence(page, browser, dir, snapshot)
    expect(ratio, `${(ratio * 100).toFixed(2)}% of pixels differ`).toBeLessThan(0.015)
  })
}

// ---------------------------------------------------------------------------
// Constructs replay documents it cannot reproduce (see replay.ts). Pinned to a
// budget above what they cost today, so a regression that widens the gap trips
// and a fix that closes it leaves obvious slack.

const LIMITS: { name: string; body: string; budget: number; why: string }[] = [
  {
    name: 'rotation replays as its bounding box',
    body: `<div style="width:80px;height:40px;background:#3b82f6;transform:rotate(20deg);margin:20px"></div>`,
    budget: 0.25,
    why: 'bounds is axis-aligned; the rotation is not re-applied',
  },
  {
    name: 'positioned/sized gradient falls back to default',
    body: `<div style="width:200px;height:60px;background-image:linear-gradient(90deg,#ef4444,#3b82f6);background-size:50% 100%;background-repeat:no-repeat"></div>`,
    budget: 0.65,
    why: 'background-size/-position/-repeat are not projected',
  },
  {
    name: "faded ancestor's background tints a faded child",
    body: `<div style="opacity:.3;background:green;padding:8px"><div style="background:yellow;color:#000;padding:4px">tinted</div></div>`,
    budget: 0.3,
    why: 'per-element opacity is not group compositing',
  },
  {
    name: 'text-shadow is dropped',
    body: `<div style="color:#000;text-shadow:3px 3px 0 red;font-size:24px">shadowed</div>`,
    budget: 0.15,
    why: 'text-shadow is not projected',
  },
  {
    name: 'text-overflow ellipsis is hard-clipped without the glyph',
    body: `<div style="width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#111">this text is far too long to fit</div>`,
    budget: 0.06,
    why: 'the run carries the full text; replay clips it rather than drawing the …',
  },
]

for (const { name, body, budget, why } of LIMITS) {
  test(`known limitation: ${name}`, async ({ page, browser }) => {
    const snapshot = await snapContent(page, body)
    const ratio = await divergence(page, browser, dir, snapshot)
    expect(ratio, `${(ratio * 100).toFixed(2)}% differ — ${why}`).toBeLessThan(budget)
  })
}
