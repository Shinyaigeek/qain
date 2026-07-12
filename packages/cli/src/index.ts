#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  type CdpSession,
  PSEUDO_STATES,
  type PseudoState,
  type Snapshot,
  type StateName,
  capture,
  diff,
  formatHtml,
  formatText,
  renderReplay,
  renderReplayDiff,
} from '@qain/core'
import { type Page, chromium } from 'playwright-core'

const USAGE = `qain — semantic style-regression testing

  qain snap <url> [options]         capture a snapshot
  qain diff <before> <after> [opts] compare two snapshots
  qain view <snapshot> [opts]       rebuild the page from a snapshot, as HTML
  qain shot <before> <after> [opts] render before.png, after.png and diff.png

snap options
  -o, --out <file>         write JSON here (default: stdout)
      --selector <css>     scope the snapshot to one subtree
      --states <list>      pseudo-states to capture: ${PSEUDO_STATES.join(',')}
      --viewport <WxH>     default 1280x720
      --wait <ms>          settle time after load (default 0)
      --wait-for <css>     wait for this selector before capturing
      --strategy <mode>    auto | bulk | isolated  (default auto)
      --rules              also record matched CSS rules, so \`qain diff\` can name
                           the declaration behind each change (one CDP call/node)
      --ua-rules           include the user-agent stylesheet in --rules
      --replay             record per-line text rectangles, so \`qain view\` and
                           \`qain diff --replay\` can rebuild the page without
                           re-running layout — pass it on both snapshots you diff
      --browser <path>     Chromium executable to use
      --headed             run with a visible window

diff options
      --html <file>        write a standalone HTML report
      --json               emit the diff as JSON instead of text
      --omit-derived       drop changes that are only collateral movement
      --replay <file>      write a before/after replay you can fade between
                           (capture both snapshots with \`snap --replay\` first)
      --no-color           plain text
      --tolerance <px>     sub-pixel box tolerance (default 0.5)

view options
  -o, --out <file>         write HTML here (default: stdout)
      --state <name>       which captured state to draw (default: default)

shot options
  -o, --out-dir <dir>      where to write the three PNGs (default: .)
      --state <name>       which captured state to draw (default: default)
      --browser <path>     Chromium executable to use
                           (both snapshots need \`snap --replay\` data)

Exit code is 1 when the diff is non-empty, so CI and agents can gate on it.`

async function main(argv: string[]): Promise<number> {
  const command = argv[0]
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (command === 'snap') return snap(argv.slice(1))
  if (command === 'diff') return compare(argv.slice(1))
  if (command === 'view') return view(argv.slice(1))
  if (command === 'shot') return shot(argv.slice(1))

  process.stderr.write(`qain: unknown command '${command}'\n\n${USAGE}\n`)
  return 2
}

// ---------------------------------------------------------------------------

async function snap(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      selector: { type: 'string' },
      states: { type: 'string' },
      viewport: { type: 'string', default: '1280x720' },
      wait: { type: 'string' },
      'wait-for': { type: 'string' },
      strategy: { type: 'string', default: 'auto' },
      rules: { type: 'boolean', default: false },
      'ua-rules': { type: 'boolean', default: false },
      replay: { type: 'boolean', default: false },
      browser: { type: 'string' },
      headed: { type: 'boolean', default: false },
    },
  })

  const url = positionals[0]
  if (!url) {
    process.stderr.write('qain snap: a url is required\n')
    return 2
  }

  const viewport = parseViewport(values.viewport!)
  const states = parseStates(values.states)
  const strategy = values.strategy as 'auto' | 'bulk' | 'isolated'
  if (!['auto', 'bulk', 'isolated'].includes(strategy)) {
    process.stderr.write(`qain snap: unknown strategy '${strategy}'\n`)
    return 2
  }

  const browser = await chromium.launch({
    headless: !values.headed,
    ...(values.browser ? { executablePath: values.browser } : {}),
  })
  try {
    const page = await browser.newPage({ viewport })
    await page.goto(url, { waitUntil: 'load' })
    if (values['wait-for']) await page.waitForSelector(values['wait-for'])

    // Webfonts swap in after load and change every font-family in the snapshot.
    await page.evaluate(() => document.fonts.ready)
    if (values.wait) await page.waitForTimeout(Number(values.wait))

    const cdp = (await page.context().newCDPSession(page)) as unknown as CdpSession
    const snapshot = await capture(cdp, {
      ...(values.selector ? { selector: values.selector } : {}),
      states,
      strategy,
      rules: values.rules,
      includeUserAgentRules: values['ua-rules'],
      replay: values.replay,
    })

    const json = `${JSON.stringify(snapshot, null, 2)}\n`
    if (values.out) {
      await writeFile(values.out, json)
      const nodes = snapshot.states.reduce((n, s) => n + s.nodes.length, 0)
      process.stderr.write(
        `qain: ${nodes} nodes across ${snapshot.states.length} state(s) → ${values.out}\n`,
      )
      for (const warning of snapshot.warnings) process.stderr.write(`warning: ${warning}\n`)
    } else {
      process.stdout.write(json)
    }
    return 0
  } finally {
    await browser.close()
  }
}

// ---------------------------------------------------------------------------

async function compare(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      html: { type: 'string' },
      replay: { type: 'string' },
      json: { type: 'boolean', default: false },
      'omit-derived': { type: 'boolean', default: false },
      // node:util's parseArgs has no --no-<flag> support, so the negation is the flag.
      'no-color': { type: 'boolean', default: false },
      tolerance: { type: 'string' },
    },
  })

  const [beforePath, afterPath] = positionals
  if (!beforePath || !afterPath) {
    process.stderr.write('qain diff: two snapshot files are required\n')
    return 2
  }

  const before = await readSnapshot(beforePath)
  const after = await readSnapshot(afterPath)

  const result = diff(before, after, {
    omitDerived: values['omit-derived'],
    ...(values.tolerance ? { boxTolerance: Number(values.tolerance) } : {}),
  })

  if (values.html) await writeFile(values.html, formatHtml(result))
  if (values.replay) {
    if (!hasTextRuns(before) || !hasTextRuns(after)) {
      process.stderr.write(
        'qain: neither snapshot records text rectangles; re-capture with `qain snap --replay`\n',
      )
      return 2
    }
    await writeFile(values.replay, renderReplayDiff(before, after, result))
    process.stderr.write(`qain: replay → ${values.replay}\n`)
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    const color = !values['no-color'] && process.stdout.isTTY
    process.stdout.write(`${formatText(result, { color })}\n`)
  }

  return result.changes.length > 0 ? 1 : 0
}

// ---------------------------------------------------------------------------

async function view(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      state: { type: 'string', default: 'default' },
    },
  })

  const path = positionals[0]
  if (!path) {
    process.stderr.write('qain view: a snapshot file is required\n')
    return 2
  }

  const snapshot = await readSnapshot(path)
  if (!hasTextRuns(snapshot)) {
    process.stderr.write(
      'qain view: this snapshot has no text rectangles, so text will not be placed.\n' +
        '           Re-capture with `qain snap --replay`.\n',
    )
  }

  const html = renderReplay(snapshot, { state: values.state as StateName })
  if (values.out) {
    await writeFile(values.out, html)
    process.stderr.write(`qain: replay → ${values.out}\n`)
  } else {
    process.stdout.write(html)
  }
  return 0
}

/** A snapshot captured without `--replay` rebuilds as boxes with no text in them. */
function hasTextRuns(snapshot: Snapshot): boolean {
  return snapshot.states.some((state) => state.nodes.some((node) => node.textRuns !== undefined))
}

// ---------------------------------------------------------------------------

async function shot(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'out-dir': { type: 'string', short: 'o', default: '.' },
      state: { type: 'string', default: 'default' },
      browser: { type: 'string' },
    },
  })

  const [beforePath, afterPath] = positionals
  if (!beforePath || !afterPath) {
    process.stderr.write('qain shot: two snapshot files are required\n')
    return 2
  }

  const before = await readSnapshot(beforePath)
  const after = await readSnapshot(afterPath)
  if (!hasTextRuns(before) || !hasTextRuns(after)) {
    process.stderr.write(
      'qain shot: a snapshot has no text rectangles; re-capture both with `qain snap --replay`\n',
    )
    return 2
  }

  const state = values.state as StateName
  const dir = values['out-dir']!
  const browser = await chromium.launch({
    headless: true,
    ...(values.browser ? { executablePath: values.browser } : {}),
  })
  try {
    await mkdir(dir, { recursive: true })
    const page = await browser.newPage({ viewport: before.viewport })

    const render = async (snapshot: Snapshot): Promise<Buffer> => {
      await page.setViewportSize(snapshot.viewport)
      await page.setContent(renderReplay(snapshot, { state, bare: true }), { waitUntil: 'load' })
      await page.evaluate(() => document.fonts.ready)
      return page.screenshot({ fullPage: true })
    }
    const beforePng = await render(before)
    const afterPng = await render(after)
    const diffPng = await composeDiff(page, beforePng, afterPng)

    for (const [file, png] of [
      ['before.png', beforePng],
      ['after.png', afterPng],
      ['diff.png', diffPng],
    ] as const) {
      await writeFile(join(dir, file), png)
    }
    process.stderr.write(`qain: before.png, after.png, diff.png → ${dir}\n`)
    return 0
  } finally {
    await browser.close()
  }
}

/**
 * Paint the pixel overlay: the base render faded to near-white, with every
 * pixel that differs between the two screenshots in solid red. Composed in the
 * already-running browser so the CLI needs no image library.
 */
async function composeDiff(page: Page, beforePng: Buffer, afterPng: Buffer): Promise<Buffer> {
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
          // Unchanged: the base render, faded, so the red reads in context.
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

function toDataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`
}

// ---------------------------------------------------------------------------

async function readSnapshot(path: string): Promise<Snapshot> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`qain: cannot read snapshot ${path}: ${(error as Error).message}`)
  }
  const snapshot = parsed as Snapshot
  if (typeof snapshot?.qain !== 'number' || !Array.isArray(snapshot.states)) {
    throw new Error(`qain: ${path} is not a qain snapshot`)
  }
  return snapshot
}

function parseViewport(value: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(value)
  if (!match) throw new Error(`qain: bad viewport ${JSON.stringify(value)}, expected e.g. 1280x720`)
  return { width: Number(match[1]), height: Number(match[2]) }
}

function parseStates(value: string | undefined): PseudoState[] {
  if (!value) return []
  const states = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const state of states) {
    if (!(PSEUDO_STATES as readonly string[]).includes(state)) {
      throw new Error(`qain: unknown state '${state}', expected one of ${PSEUDO_STATES.join(', ')}`)
    }
  }
  return states as PseudoState[]
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: Error) => {
    process.stderr.write(`${error.message}\n`)
    process.exit(2)
  })
