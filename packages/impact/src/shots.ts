import { renderReplay, type Snapshot, type StateName } from '@qain/core'
import type { Page } from 'playwright-core'

export interface Shots {
  before: Buffer
  after: Buffer
  diff: Buffer
}

/** Snapshots carry text rectangles only when captured with `replay: true`. */
export function hasTextRuns(snapshot: Snapshot): boolean {
  return snapshot.states.some((state) => state.nodes.some((node) => node.textRuns?.length))
}

function toDataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`
}

/**
 * Renders before, after and diff PNGs from the two snapshots alone — the app is
 * never re-run, because the snapshot already carries every box and text rectangle
 * the page had.
 *
 * Lives here rather than in `@qain/core` because it needs a browser to rasterize,
 * and core deliberately knows only about a CDP session.
 */
export async function renderShots(
  page: Page,
  before: Snapshot,
  after: Snapshot,
  state: StateName = 'default',
): Promise<Shots> {
  const render = async (snapshot: Snapshot): Promise<Buffer> => {
    await page.setViewportSize(snapshot.viewport)
    await page.setContent(renderReplay(snapshot, { state, bare: true }), { waitUntil: 'load' })
    await page.evaluate(() => document.fonts.ready)
    return page.screenshot({ fullPage: true })
  }

  const beforePng = await render(before)
  const afterPng = await render(after)
  return { before: beforePng, after: afterPng, diff: await composeDiff(page, beforePng, afterPng) }
}

/**
 * The pixel diff, composed in the page's own canvas: changed pixels in red over a
 * faded greyscale of the base render, so the red reads in context.
 */
export async function composeDiff(
  page: Page,
  beforePng: Buffer,
  afterPng: Buffer,
): Promise<Buffer> {
  await page.setContent('<canvas id="diff"></canvas>', { waitUntil: 'load' })
  await page.evaluate(
    async ([a, b]) => {
      const load = async (src: string) => {
        const img = new Image()
        img.src = src
        await img.decode()
        return img
      }
      const [ia, ib] = await Promise.all([load(a), load(b)])
      const width = Math.max(ia.naturalWidth, ib.naturalWidth)
      const height = Math.max(ia.naturalHeight, ib.naturalHeight)

      const pixels = (img: HTMLImageElement) => {
        const c = document.createElement('canvas')
        c.width = width
        c.height = height
        const ctx = c.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        return ctx.getImageData(0, 0, width, height).data
      }
      const da = pixels(ia)
      const db = pixels(ib)

      const canvas = document.getElementById('diff') as HTMLCanvasElement
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')!
      const out = ctx.createImageData(width, height)
      for (let i = 0; i < da.length; i += 4) {
        const delta = Math.max(
          Math.abs(da[i]! - db[i]!),
          Math.abs(da[i + 1]! - db[i + 1]!),
          Math.abs(da[i + 2]! - db[i + 2]!),
          Math.abs(da[i + 3]! - db[i + 3]!),
        )
        if (delta > 8) {
          out.data[i] = 255
          out.data[i + 1] = 32
          out.data[i + 2] = 32
          out.data[i + 3] = 255
        } else {
          const grey = 0.299 * da[i]! + 0.587 * da[i + 1]! + 0.114 * da[i + 2]!
          const faded = 255 - (255 - grey) * 0.25
          out.data[i] = faded
          out.data[i + 1] = faded
          out.data[i + 2] = faded
          out.data[i + 3] = 255
        }
      }
      ctx.putImageData(out, 0, 0)
    },
    [toDataUrl(beforePng), toDataUrl(afterPng)] as const,
  )
  return page.locator('#diff').screenshot()
}
