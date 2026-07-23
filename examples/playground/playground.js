/**
 * The qain playground: capture + diff, entirely client-side.
 *
 * Both editors render into a sandboxed iframe. `captureDom` reads each live DOM —
 * computed styles, boxes, paint order, composited colour, matched rules with
 * `file:line` — into the very snapshot format the CLI produces over CDP, and the
 * same pure `diff`/`renderReplayDiff`/`formatHtml` the CLI runs turns the two
 * snapshots into the report below. Nothing here talks to a server.
 */
import { captureDom, diff, formatHtml, formatText, renderReplayDiff } from './vendor/index.js'

// A self-contained billing page: markup and CSS in one file, the way the prompt
// asked for. The "original" is clean; the "edited" seed breaks it four ways at
// once — a padding reflow, a WCAG contrast regression, a z-index restack, and a
// :hover that stopped differing — plus a utility-class rehash qain must ignore.
const BEFORE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Acme — Billing</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: #fff; color: #111827; }

  .bar { position: relative; display: flex; align-items: center; gap: 12px; padding: 16px 24px; }
  /* Positioned so the badge can stack above it — and a z-index regression is visible. */
  .title { position: relative; z-index: 1; margin: 0; font-size: 20px; background: #fff; }
  .badge {
    position: absolute; left: 56px; z-index: 2;
    padding: 2px 8px; border-radius: 999px;
    background: rgb(219, 234, 254); color: rgb(30, 64, 175); font-size: 12px;
  }

  .stack { display: flex; flex-direction: column; align-items: flex-start; gap: 16px; padding: 24px; }
  .card { padding: 16px; border: 1px solid rgb(229, 231, 235); border-radius: 8px; }
  .card-title { margin: 0 0 4px; font-size: 14px; font-weight: 600; }
  .figure { margin: 0; font-size: 28px; font-weight: 700; }
  .muted { margin: 4px 0 0; color: rgb(107, 114, 128); font-size: 14px; }

  .actions { display: flex; gap: 12px; }
  .btn {
    border: 0; border-radius: 6px; padding: 8px 16px;
    background: rgb(243, 244, 246); color: rgb(17, 24, 39); font: inherit; cursor: pointer;
  }
  .btn-primary { background: rgb(37, 99, 235); color: #fff; }
  .btn-primary:hover { background: rgb(29, 78, 216); }
</style>
</head>
<body>
  <header class="bar css-a1b2c3">
    <h1 class="title">Billing</h1>
    <span class="badge" data-testid="plan-badge">Pro</span>
  </header>

  <main class="stack">
    <section class="card css-a1b2c3" data-testid="usage-card">
      <h2 class="card-title">Usage</h2>
      <p class="figure" data-testid="usage-figure">18,204</p>
      <p class="muted" data-testid="usage-note">requests this month</p>
    </section>

    <div class="actions">
      <button class="btn btn-primary" data-testid="pay">Pay now</button>
      <button class="btn" data-testid="download">Download invoice</button>
    </div>

    <footer class="muted" data-testid="footnote">Prices exclude VAT.</footer>
  </main>
</body>
</html>
`

// The four regressions, applied. Try reverting them one at a time and re-running.
const AFTER = BEFORE.replace('padding: 8px 16px', 'padding: 14px 16px') //   reflow
  .replace(
    '.btn-primary:hover { background: rgb(29, 78, 216); }',
    '.btn-primary:hover { background: rgb(37, 99, 235); }',
  ) // hover stopped differing
  .replace('left: 56px; z-index: 2;', 'left: 56px; z-index: 0;') //          restack
  .replace(
    'color: rgb(107, 114, 128); font-size: 14px;',
    'color: rgb(199, 203, 212); font-size: 14px;',
  ) // contrast
  .replaceAll('css-a1b2c3', 'css-9f8e7d') //                                 rehash — must stay silent

const $ = (id) => document.getElementById(id)
const srcBefore = $('src-before')
const srcAfter = $('src-after')
const viewBefore = $('view-before')
const viewAfter = $('view-after')
const status = $('status')
const banner = $('banner')
const counts = $('counts')

srcBefore.value = BEFORE
srcAfter.value = AFTER

// The iframes render at a fixed size so both snapshots share a viewport — a diff
// across differing viewports cannot compare boxes, and would say so.
const VIEW = { width: 720, height: 460 }
for (const frame of [viewBefore, viewAfter]) {
  frame.style.height = `${VIEW.height}px`
}

/** Point an iframe at `html` and resolve once it has loaded and laid out. */
function load(frame, html) {
  return new Promise((resolve) => {
    frame.onload = () => {
      // Two frames of animation: the load event fires before the first layout.
      frame.contentWindow.requestAnimationFrame(() =>
        frame.contentWindow.requestAnimationFrame(resolve),
      )
    }
    frame.srcdoc = html
  })
}

let seq = 0
async function run() {
  const mine = ++seq
  const states = $('opt-hover').checked ? ['hover'] : []
  const omitDerived = $('opt-derived').checked
  status.textContent = 'rendering…'
  banner.classList.remove('show')

  try {
    const beforeHtml = srcBefore.value
    const afterHtml = srcAfter.value
    await Promise.all([load(viewBefore, beforeHtml), load(viewAfter, afterHtml)])
    if (mine !== seq) return // a newer run superseded this one

    status.textContent = 'capturing…'
    const before = captureDom(viewBefore.contentDocument, {
      states,
      rules: true,
      replay: true,
      source: beforeHtml,
      url: 'before.html',
    })
    const after = captureDom(viewAfter.contentDocument, {
      states,
      rules: true,
      replay: true,
      source: afterHtml,
      url: 'after.html',
    })
    if (mine !== seq) return

    const d = diff(before, after, { omitDerived })
    render(before, after, d)

    const { primary, derived, total } = d.summary
    counts.innerHTML =
      total === 0
        ? '<b>no changes</b>'
        : `${total} changes · <b class="primary">${primary} primary</b> · <b class="derived">${derived} derived</b>`
    status.textContent = `done — ${total} change${total === 1 ? '' : 's'}`
    if (d.warnings.length > 0) fail(d.warnings.join('\n'), true)
  } catch (error) {
    fail(String(error?.stack ? error.stack : error))
    status.textContent = 'error'
  }
}

function render(before, after, d) {
  $('out-replay').srcdoc = renderReplayDiff(before, after, d)
  $('out-report').srcdoc = formatHtml(d)
  const text = formatText(d, { color: false }).trim()
  const term = $('out-terminal')
  term.textContent = ''
  if (text) {
    term.textContent = text
  } else {
    const span = document.createElement('span')
    span.className = 'empty'
    span.textContent = 'No changes. The two pages render identically.'
    term.appendChild(span)
  }
}

function fail(message, warning = false) {
  banner.textContent = (warning ? 'warning: ' : '') + message
  banner.classList.add('show')
}

// --- wiring ---------------------------------------------------------------

let timer = null
function schedule() {
  if (!$('opt-auto').checked) return
  clearTimeout(timer)
  status.textContent = 'edited…'
  timer = setTimeout(run, 500)
}

srcBefore.addEventListener('input', schedule)
srcAfter.addEventListener('input', schedule)
for (const id of ['opt-hover', 'opt-derived']) $(id).addEventListener('change', run)
$('run').addEventListener('click', run)

$('restore').addEventListener('click', () => {
  srcBefore.value = BEFORE
  srcAfter.value = AFTER
  run()
})
$('identical').addEventListener('click', () => {
  srcAfter.value = srcBefore.value
  run()
})

for (const tab of document.querySelectorAll('.tabs [role="tab"]')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tabs [role="tab"]'))
      t.setAttribute('aria-selected', String(t === tab))
    for (const p of document.querySelectorAll('.tabpanel'))
      p.classList.toggle('active', p.dataset.panel === tab.dataset.tab)
  })
}

run()
