#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import {
  type CdpSession,
  PSEUDO_STATES,
  type PseudoState,
  type Snapshot,
  capture,
  diff,
  formatHtml,
  formatText,
} from '@qain/core'
import { chromium } from 'playwright-core'

const USAGE = `qain — semantic style-regression testing

  qain snap <url> [options]         capture a snapshot
  qain diff <before> <after> [opts] compare two snapshots

snap options
  -o, --out <file>         write JSON here (default: stdout)
      --selector <css>     scope the snapshot to one subtree
      --states <list>      pseudo-states to capture: ${PSEUDO_STATES.join(',')}
      --viewport <WxH>     default 1280x720
      --wait <ms>          settle time after load (default 0)
      --wait-for <css>     wait for this selector before capturing
      --strategy <mode>    auto | bulk | isolated  (default auto)
      --browser <path>     Chromium executable to use
      --headed             run with a visible window

diff options
      --html <file>        write a standalone HTML report
      --json               emit the diff as JSON instead of text
      --omit-derived       drop changes that are only collateral movement
      --no-color           plain text
      --tolerance <px>     sub-pixel box tolerance (default 0.5)

Exit code is 1 when the diff is non-empty, so CI and agents can gate on it.`

async function main(argv: string[]): Promise<number> {
  const command = argv[0]
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (command === 'snap') return snap(argv.slice(1))
  if (command === 'diff') return compare(argv.slice(1))

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

  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    const color = !values['no-color'] && process.stdout.isTTY
    process.stdout.write(`${formatText(result, { color })}\n`)
  }

  return result.changes.length > 0 ? 1 : 0
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
