#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  type CdpSession,
  capture,
  diff,
  formatHtml,
  formatText,
  PSEUDO_STATES,
  type PseudoState,
  renderReplay,
  renderReplayDiff,
  type Snapshot,
  type StateName,
} from '@qain/core'
import {
  ConfigError,
  DEFAULT_CONFIG_FILE,
  formatImpactMarkdown,
  formatImpactText,
  loadConfig,
  renderShots,
  runImpact,
  updateBaselines,
} from '@qain/impact'
import { chromium } from 'playwright-core'

const USAGE = `qain — semantic style-regression testing

  qain snap <url> [options]         capture a snapshot
  qain diff <before> <after> [opts] compare two snapshots
  qain view <snapshot> [opts]       rebuild the page from a snapshot, as HTML
  qain shot <before> <after> [opts] render before.png, after.png and diff.png
  qain impact [options]             blast radius of the working tree, per component

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
      --ignore-paint-order do not report paint-order (stacking) changes; use when
                           part of the tree is out of the page's control, such as a
                           cross-origin iframe that paints only once it loads
      --replay <file>      write a before/after replay you can fade between
                           (capture both snapshots with \`snap --replay\` first)
      --serve              host the view on localhost instead of writing a file;
                           the before/after replay when both snapshots carry
                           \`--replay\` data, otherwise the HTML report
      --port <n>           port for --serve (default: first free from 4179)
      --no-color           plain text
      --tolerance <px>     sub-pixel box tolerance (default 0.5)

view options
  -o, --out <file>         write HTML here (default: stdout)
      --state <name>       which captured state to draw (default: default)
      --serve              host the rebuilt page on localhost instead of writing
      --port <n>           port for --serve (default: first free from 4179)

impact options
      --config <file>      target list and grouping rules (default: qain.impact.json)
      --update             (re)write the baselines instead of diffing — run this on
                           the base branch, never on the PR
      --shots <dir>        render before/after/diff PNGs for every changed target
      --markdown <file>    write the report as a PR comment
      --json               emit the report as JSON
      --omit-derived       hide components that only moved
      --no-color           plain text

shot options
  -o, --out-dir <dir>      where to write the three PNGs (default: .)
      --state <name>       which captured state to draw (default: default)
      --browser <path>     Chromium executable to use
                           (both snapshots need \`snap --replay\` data)

Exit code is 1 when the diff is non-empty, so CI and agents can gate on it.`

const version = (() => {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version: string }).version
  } catch {
    return ''
  }
})()

// The logo, as terminal art. It *is* what qain does: a faint frame (the before),
// a solid frame offset over it (the after), and the red square where they overlap
// — the diff. Each character is two vertical pixels, drawn with half-blocks.
// `i` outline · `b` after (blue) · `r` diff (red) · `.` transparent.
const ICON = [
  '..............',
  '..iiiiiii.....',
  '.i.......i....',
  '.i.......i....',
  '.i...rrrrbb...',
  '.i..rrrrrrbb..',
  '.i..rrrrrrbbb.',
  '.i..rrrrrrbbb.',
  '.i..rrrrrrbbb.',
  '..iibrrrrbbbb.',
  '....bbbbbbbbb.',
  '.....bbbbbbb..',
  '......bbbbb...',
  '..............',
]
const PALETTE: Record<string, [number, number, number]> = {
  i: [150, 160, 178], // outline — reads on light and dark terminals
  b: [67, 97, 238], // after — blue
  r: [229, 72, 77], // diff — red
}
const fg = (c: [number, number, number]) => `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`
const bg = (c: [number, number, number]) => `\x1b[48;2;${c[0]};${c[1]};${c[2]}m`
const RESET = '\x1b[0m'

/** Fold the pixel map into half-block rows: top pixel = foreground, bottom = background. */
function iconLines(): string[] {
  const lines: string[] = []
  for (let r = 0; r < ICON.length; r += 2) {
    let line = ''
    for (let c = 0; c < ICON[r]!.length; c++) {
      const top = PALETTE[ICON[r]![c]!]
      const bot = PALETTE[ICON[r + 1]?.[c] ?? '.']
      if (!top && !bot) line += ' '
      else if (top && bot) line += `${fg(top)}${bg(bot)}▀${RESET}`
      else if (top) line += `${fg(top)}▀${RESET}`
      else line += `${fg(bot!)}▄${RESET}`
    }
    lines.push(line)
  }
  return lines
}

/**
 * The welcome splash: the logo beside the wordmark. Shown only on an interactive
 * TTY — piped or agent-driven runs get clean help with no escape codes.
 */
function banner(): string {
  const B = '\x1b[1m'
  const D = '\x1b[2m'
  const dot = `${fg(PALETTE.r!)}·${RESET}`
  const text = [
    '',
    `${B}${fg(PALETTE.b!)}qain${RESET}${version ? `  ${D}v${version}${RESET}` : ''}`,
    `${D}semantic style-regression testing${RESET}`,
    `${D}— what changed, and what merely moved${RESET}`,
    '',
    `${D}semantic vrt ${dot}${D} names the rule ${dot}${D} exit-code gating${RESET}`,
    '',
  ]
  const icon = iconLines()
  const rows = Math.max(icon.length, text.length)
  const blankIcon = ' '.repeat(ICON[0]!.length)
  let out = '\n'
  for (let i = 0; i < rows; i++) {
    const left = icon[i] ?? blankIcon
    const right = text[i] ?? ''
    out += `  ${left}   ${right}\n`
  }
  return out
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0]
  if (!command || command === '--help' || command === '-h') {
    if (process.stdout.isTTY) {
      // The banner already carries the name and tagline; drop the usage heading.
      process.stdout.write(banner())
      process.stdout.write(`${USAGE.replace(/^qain — [^\n]*\n\n/, '')}\n`)
    } else {
      process.stdout.write(`${USAGE}\n`)
    }
    return 0
  }
  if (command === 'snap') return snap(argv.slice(1))
  if (command === 'diff') return compare(argv.slice(1))
  if (command === 'view') return view(argv.slice(1))
  if (command === 'shot') return shot(argv.slice(1))
  if (command === 'impact') return impact(argv.slice(1))

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
      serve: { type: 'boolean', default: false },
      port: { type: 'string' },
      json: { type: 'boolean', default: false },
      'omit-derived': { type: 'boolean', default: false },
      'ignore-paint-order': { type: 'boolean', default: false },
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
    ignorePaintOrder: values['ignore-paint-order'],
    ...(values.tolerance ? { boxTolerance: Number(values.tolerance) } : {}),
  })

  if (values.serve) {
    // The replay is the richer view — zoom, pan, click a change to spotlight it —
    // but it needs the text rectangles. Fall back to the HTML report without them.
    const replayable = hasTextRuns(before) && hasTextRuns(after)
    const html = replayable ? renderReplayDiff(before, after, result) : formatHtml(result)
    if (!replayable) {
      process.stderr.write(
        'qain: no text rectangles — serving the HTML report. Re-capture both with\n' +
          '      `qain snap --replay` for the before/after replay.\n',
      )
    }
    return serve(html, parsePort(values.port), replayable ? 'the replay' : 'the diff report')
  }

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
      serve: { type: 'boolean', default: false },
      port: { type: 'string' },
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
  if (values.serve) return serve(html, parsePort(values.port), 'the rebuilt page')
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
    const shots = await renderShots(page, before, after, state)

    for (const [file, png] of [
      ['before.png', shots.before],
      ['after.png', shots.after],
      ['diff.png', shots.diff],
    ] as const) {
      await writeFile(join(dir, file), png)
    }
    process.stderr.write(`qain: before.png, after.png, diff.png → ${dir}\n`)
    return 0
  } finally {
    await browser.close()
  }
}

// ---------------------------------------------------------------------------

/**
 * The blast radius of the working tree, grouped by the component a change landed
 * in and by the stylesheet that caused it.
 *
 * Deliberately asymmetric: it captures HEAD only and diffs against baselines
 * committed from the base branch. Capturing both sides per PR would mean checking
 * out, installing and building the base ref inside the PR job, which is the
 * slowest and most brittle shape this could take.
 */
async function impact(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', default: DEFAULT_CONFIG_FILE },
      update: { type: 'boolean', default: false },
      shots: { type: 'string' },
      markdown: { type: 'string' },
      json: { type: 'boolean', default: false },
      'omit-derived': { type: 'boolean', default: false },
      'no-color': { type: 'boolean', default: false },
    },
  })

  const config = await loadConfig(values.config!).catch((error: unknown) => {
    if (error instanceof ConfigError) {
      process.stderr.write(`qain impact: ${error.message}\n`)
      return null
    }
    throw error
  })
  if (!config) return 2
  if (values['omit-derived']) config.omitDerived = true

  const onProgress = (name: string, index: number, total: number) => {
    process.stderr.write(`qain impact: [${index + 1}/${total}] ${name}\n`)
  }

  if (values.update) {
    const written = await updateBaselines(config, { onProgress })
    process.stderr.write(`qain impact: ${written.length} baseline(s) → ${config.baselineDir}\n`)
    return 0
  }

  const report = await runImpact(config, {
    ...(values.shots ? { shotsDir: values.shots } : {}),
    onProgress,
  })

  if (values.markdown) {
    await writeFile(values.markdown, formatImpactMarkdown(report))
    process.stderr.write(`qain impact: markdown → ${values.markdown}\n`)
  }
  if (values.shots) {
    process.stderr.write(`qain impact: screenshots → ${values.shots}\n`)
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    const color = !values['no-color'] && process.stdout.isTTY
    process.stdout.write(`${formatImpactText(report, { color })}\n`)
  }

  // 2 is a broken run. 1 covers both "something changed" and "a target has no
  // baseline" — an unbaselined target is unreviewed, not clean, and exiting 0 on
  // one would be exactly the silent miss this command exists to prevent.
  if (report.summary.errors > 0) return 2
  return report.summary.changes > 0 || report.summary.missingBaselines > 0 ? 1 : 0
}

// ---------------------------------------------------------------------------

const DEFAULT_PORT = 4179

/**
 * Host one page of HTML on localhost and stay up until Ctrl-C. Every path serves
 * the same document, so a browser refresh always shows it. Returns a promise that
 * never resolves — the server *is* the command from here on.
 */
async function serve(html: string, preferred: number, label: string): Promise<number> {
  const body = Buffer.from(html)
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': body.length,
    })
    response.end(body)
  })

  const port = await listen(server, preferred)
  process.stderr.write(`qain: serving ${label} at http://localhost:${port}  —  Ctrl-C to stop\n`)
  // Keep the event loop alive; main()'s .then(process.exit) never runs.
  return new Promise<number>(() => {})
}

/** Listen on `preferred`, falling back to an OS-assigned port if it is taken. */
async function listen(server: Server, preferred: number): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : port)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    })

  try {
    return await tryPort(preferred)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || preferred === 0) throw error
    process.stderr.write(`qain: port ${preferred} is in use, picking a free one\n`)
    return tryPort(0)
  }
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`qain: bad port ${JSON.stringify(value)}`)
  }
  return port
}

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
