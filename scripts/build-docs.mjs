#!/usr/bin/env node
/**
 * Renders docs/*.md to a small, modern, self-contained doc site for GitHub Pages
 * (https://shinyaigeek.github.io/qain/docs/). One Markdown source serves both
 * GitHub and the site: link rewriting turns doc-to-doc links into .html and
 * repo-relative links (../packages/…) into GitHub URLs.
 *
 * The theme is hand-rolled and zero-dependency: a sticky header, a left page
 * nav, a right "on this page" table of contents built from the headings, a
 * light/dark toggle, and build-time syntax highlighting (a compact scanner for
 * the three languages the docs use — sh, ts, jsonc). No runtime framework.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { marked } from 'marked'
import { gfmHeadingId } from 'marked-gfm-heading-id'

const REPO = 'https://github.com/Shinyaigeek/qain'
const DOCS = new URL('../docs/', import.meta.url).pathname
const outDir = process.argv[2] ?? 'site/docs'

// The site nav, in reading order. Labels are short; the page's own H1 can be long.
const NAV = [
  { src: 'README.md', file: 'index.html', label: 'Overview' },
  { src: 'getting-started.md', file: 'getting-started.html', label: 'Getting started' },
  { src: 'cli.md', file: 'cli.html', label: 'CLI reference' },
  { src: 'recipes.md', file: 'recipes.html', label: 'Recipes' },
  { src: 'github-action.md', file: 'github-action.html', label: 'GitHub Action' },
  { src: 'snapshot-format.md', file: 'snapshot-format.html', label: 'Snapshot & diff format' },
  { src: 'library.md', file: 'library.html', label: 'Library API' },
]

// --- link rewriting -------------------------------------------------------

function rewrite(href) {
  if (/^(?:https?:|#|mailto:)/.test(href)) return href
  const hashIndex = href.indexOf('#')
  const path = hashIndex === -1 ? href : href.slice(0, hashIndex)
  const hash = hashIndex === -1 ? '' : href.slice(hashIndex)

  // Out of docs/: point at the repository. Directories get tree/, files blob/.
  if (path.startsWith('../')) {
    const resolved = posix.normalize(`docs/${path}`)
    const mode = /\.[a-z]+$/i.test(resolved) ? 'blob' : 'tree'
    return `${REPO}/${mode}/main/${resolved}${hash}`
  }

  // Doc to doc: the .md is rendered next to this page as .html.
  if (path.endsWith('.md')) {
    const base = path.replace(/^\.\//, '').replace(/\.md$/, '')
    return `${base === 'README' ? 'index' : base}.html${hash}`
  }

  return href
}

// --- syntax highlighting (build-time, no deps) ----------------------------

const AMP = /&/g
const LT = /</g
const GT = />/g
function esc(s) {
  return s.replace(AMP, '&amp;').replace(LT, '&lt;').replace(GT, '&gt;')
}
function span(cls, text) {
  return `<span class="t-${cls}">${esc(text)}</span>`
}

const TS_KW = new Set([
  'import',
  'from',
  'export',
  'default',
  'const',
  'let',
  'var',
  'function',
  'return',
  'async',
  'await',
  'if',
  'else',
  'for',
  'of',
  'in',
  'while',
  'new',
  'class',
  'extends',
  'type',
  'interface',
  'implements',
  'as',
  'this',
  'void',
  'typeof',
  'keyof',
  'readonly',
  'true',
  'false',
  'null',
  'undefined',
  'yield',
  'throw',
  'try',
  'catch',
  'finally',
])

function hlTs(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    // line comment
    if (c === '/' && src[i + 1] === '/') {
      let j = i
      while (j < n && src[j] !== '\n') j++
      out += span('comment', src.slice(i, j))
      i = j
      continue
    }
    // block comment
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++
      j = Math.min(j + 2, n)
      out += span('comment', src.slice(i, j))
      i = j
      continue
    }
    // strings
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      let j = i + 1
      while (j < n && src[j] !== q) {
        if (src[j] === '\\') j++
        j++
      }
      j = Math.min(j + 1, n)
      out += span('str', src.slice(i, j))
      i = j
      continue
    }
    // number
    if (/[0-9]/.test(c)) {
      let j = i
      while (j < n && /[0-9._a-fx]/i.test(src[j])) j++
      out += span('num', src.slice(i, j))
      i = j
      continue
    }
    // identifier
    if (/[A-Za-z_$]/.test(c)) {
      let j = i
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++
      const word = src.slice(i, j)
      let k = j
      while (k < n && /\s/.test(src[k])) k++
      if (TS_KW.has(word)) out += span('kw', word)
      else if (src[k] === '(') out += span('fn', word)
      else if (/^[A-Z]/.test(word)) out += span('type', word)
      else out += esc(word)
      i = j
      continue
    }
    out += esc(c)
    i++
  }
  return out
}

function hlJson(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      let j = i
      while (j < n && src[j] !== '\n') j++
      out += span('comment', src.slice(i, j))
      i = j
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++
      j = Math.min(j + 2, n)
      out += span('comment', src.slice(i, j))
      i = j
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\') j++
        j++
      }
      j = Math.min(j + 1, n)
      let k = j
      while (k < n && /\s/.test(src[k])) k++
      out += span(src[k] === ':' ? 'prop' : 'str', src.slice(i, j))
      i = j
      continue
    }
    if (/[0-9-]/.test(c) && /[0-9]/.test(src[i + 1] || c)) {
      let j = i
      while (j < n && /[0-9.eE+-]/.test(src[j])) j++
      out += span('num', src.slice(i, j))
      i = j
      continue
    }
    if (/[a-z]/.test(c)) {
      let j = i
      while (j < n && /[a-z]/.test(src[j])) j++
      const word = src.slice(i, j)
      out += /^(true|false|null)$/.test(word) ? span('kw', word) : esc(word)
      i = j
      continue
    }
    out += esc(c)
    i++
  }
  return out
}

function hlShell(src) {
  let out = ''
  let i = 0
  const n = src.length
  let atCmd = true // true when the next word begins a command
  while (i < n) {
    const c = src[i]
    if (c === '\n') {
      out += '\n'
      i++
      atCmd = true
      continue
    }
    if (/\s/.test(c)) {
      out += c
      i++
      continue
    }
    // comment: # only at a word boundary
    if (c === '#' && (i === 0 || /\s/.test(src[i - 1]))) {
      let j = i
      while (j < n && src[j] !== '\n') j++
      out += span('comment', src.slice(i, j))
      i = j
      atCmd = false
      continue
    }
    // strings
    if (c === '"' || c === "'") {
      const q = c
      let j = i + 1
      while (j < n && src[j] !== q) {
        if (src[j] === '\\') j++
        j++
      }
      j = Math.min(j + 1, n)
      out += span('str', src.slice(i, j))
      i = j
      atCmd = false
      continue
    }
    // variable / subshell
    if (c === '$') {
      if (src[i + 1] === '(') {
        out += span('var', '$(')
        i += 2
        atCmd = true
        continue
      }
      let j = i + 1
      if (src[j] === '{') {
        while (j < n && src[j] !== '}') j++
        j++
      } else {
        while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++
      }
      out += span('var', src.slice(i, j))
      i = j
      atCmd = false
      continue
    }
    // command name at the start of a line / pipeline
    if (atCmd && /[A-Za-z_./]/.test(c)) {
      let j = i
      while (j < n && /[A-Za-z0-9_./-]/.test(src[j])) j++
      out += span('fn', src.slice(i, j))
      i = j
      atCmd = false
      continue
    }
    // flags
    if (c === '-' && /[-A-Za-z]/.test(src[i + 1] || '')) {
      let j = i
      while (j < n && /[A-Za-z0-9-]/.test(src[j])) j++
      out += span('flag', src.slice(i, j))
      i = j
      atCmd = false
      continue
    }
    // number
    if (/[0-9]/.test(c)) {
      let j = i
      while (j < n && /[0-9.]/.test(src[j])) j++
      out += span('num', src.slice(i, j))
      i = j
      atCmd = false
      continue
    }
    // operators; a pipe or ; or & starts a fresh command
    if ('|&><;'.includes(c)) {
      out += span('op', c)
      atCmd = c === '|' || c === '&' || c === ';'
      i++
      continue
    }
    out += esc(c)
    i++
    atCmd = false
  }
  return out
}

const LANG_LABEL = {
  sh: 'shell',
  bash: 'shell',
  ts: 'ts',
  tsx: 'tsx',
  js: 'js',
  json: 'json',
  jsonc: 'jsonc',
}
function highlight(code, lang) {
  const l = (lang || '').toLowerCase()
  if (l === 'ts' || l === 'tsx' || l === 'js' || l === 'jsx') return hlTs(code)
  if (l === 'json' || l === 'jsonc') return hlJson(code)
  if (l === 'sh' || l === 'bash' || l === 'shell') return hlShell(code)
  return esc(code)
}

// --- marked config --------------------------------------------------------

marked.use(gfmHeadingId())
marked.use({
  walkTokens(token) {
    if (token.type === 'link' || token.type === 'image') token.href = rewrite(token.href)
  },
  renderer: {
    code({ text, lang }) {
      const label = LANG_LABEL[(lang || '').toLowerCase()] ?? (lang || '')
      const body = highlight(text, lang)
      const chip = label ? `<span class="code-lang">${esc(label)}</span>` : ''
      return `<div class="code"><div class="code-bar">${chip}<button class="copy" type="button" aria-label="Copy code">Copy</button></div><pre><code>${body}</code></pre></div>`
    },
  },
})

// --- table of contents ----------------------------------------------------

function extractToc(html) {
  const re = /<h([23]) id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g
  const items = []
  let m
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = re.exec(html)) !== null) {
    const level = Number(m[1])
    const id = m[2]
    const label = m[3].replace(/<[^>]+>/g, '').trim()
    items.push({ level, id, label })
  }
  if (items.length < 2) return ''
  const lis = items
    .map((it) => `<li class="lvl-${it.level}"><a href="#${it.id}">${it.label}</a></li>`)
    .join('\n')
  return `<nav class="toc" aria-label="On this page"><p class="toc-title">On this page</p><ul>${lis}</ul></nav>`
}

// --- shell ----------------------------------------------------------------

function logo(size, stroke) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" fill="none" aria-hidden="true"><rect x="6" y="6" width="38" height="38" rx="10" fill="none" stroke="${stroke}" stroke-width="5"/><rect x="20" y="20" width="38" height="38" rx="10" fill="#4361ee"/><rect x="20" y="20" width="24" height="24" rx="5" fill="#e5484d"/></svg>`
}

function sidebar(current) {
  const links = NAV.map((n) => {
    const active = n.file === current ? ' class="active" aria-current="page"' : ''
    return `<a href="${n.file}"${active}>${n.label}</a>`
  }).join('\n')
  return `<aside class="sidebar"><nav aria-label="Docs"><p class="side-title">Documentation</p>${links}<p class="side-title">Elsewhere</p><a href="../">Live demo</a><a href="../playground/">Playground</a><a href="${REPO}">GitHub ↗</a></nav></aside>`
}

const STYLE = `
:root {
  --bg: #ffffff; --bg-soft: #f7f8fa; --panel: #fbfcfd;
  --fg: #1c2128; --muted: #5b6472; --faint: #8a94a6;
  --border: #e7eaf0; --border-soft: #eef1f5;
  --accent: #3a54e0; --accent-hover: #2338c4; --danger: #e5484d;
  --shadow: 0 1px 2px rgba(16,24,40,.04), 0 8px 24px rgba(16,24,40,.06);
  --header-h: 56px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0b0e14; --bg-soft: #0f131b; --panel: #0f131b;
    --fg: #e6e9ef; --muted: #9aa4b2; --faint: #6b7482;
    --border: #1e2530; --border-soft: #161c25;
    --accent: #7f9bff; --accent-hover: #a3b6ff; --danger: #ff6b6f;
    --shadow: 0 1px 2px rgba(0,0,0,.3), 0 12px 32px rgba(0,0,0,.35);
  }
}
:root[data-theme="light"] {
  --bg: #ffffff; --bg-soft: #f7f8fa; --panel: #fbfcfd;
  --fg: #1c2128; --muted: #5b6472; --faint: #8a94a6;
  --border: #e7eaf0; --border-soft: #eef1f5;
  --accent: #3a54e0; --accent-hover: #2338c4; --danger: #e5484d;
  --shadow: 0 1px 2px rgba(16,24,40,.04), 0 8px 24px rgba(16,24,40,.06);
}
:root[data-theme="dark"] {
  --bg: #0b0e14; --bg-soft: #0f131b; --panel: #0f131b;
  --fg: #e6e9ef; --muted: #9aa4b2; --faint: #6b7482;
  --border: #1e2530; --border-soft: #161c25;
  --accent: #7f9bff; --accent-hover: #a3b6ff; --danger: #ff6b6f;
  --shadow: 0 1px 2px rgba(0,0,0,.3), 0 12px 32px rgba(0,0,0,.35);
}

* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font-family: "IBM Plex Sans", system-ui, sans-serif;
  font-size: 16px; line-height: 1.65;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
a { color: var(--accent); text-decoration: none; }
a:hover { color: var(--accent-hover); text-decoration: underline; text-underline-offset: 3px; }

/* header */
.site-header {
  position: sticky; top: 0; z-index: 50; height: var(--header-h);
  display: flex; align-items: center; gap: 16px;
  padding: 0 20px; background: color-mix(in srgb, var(--bg) 82%, transparent);
  backdrop-filter: saturate(180%) blur(12px);
  -webkit-backdrop-filter: saturate(180%) blur(12px);
  border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: center; gap: 10px; font-weight: 600; color: var(--fg); }
.brand:hover { text-decoration: none; }
.brand .word { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 17px; letter-spacing: -.02em; }
.brand .sep { color: var(--faint); font-weight: 400; }
.brand .kicker { color: var(--muted); font-weight: 500; font-size: 14px; }
.site-header .spacer { flex: 1; }
.site-header nav.top { display: flex; align-items: center; gap: 18px; font-size: 14px; }
.site-header nav.top a { color: var(--muted); }
.site-header nav.top a:hover { color: var(--fg); text-decoration: none; }
.theme-toggle {
  display: inline-grid; place-items: center; width: 34px; height: 34px;
  border: 1px solid var(--border); border-radius: 9px; background: var(--panel);
  color: var(--muted); cursor: pointer; padding: 0;
}
.theme-toggle:hover { color: var(--fg); border-color: var(--faint); }
.theme-toggle svg { width: 17px; height: 17px; }
.theme-toggle .moon { display: none; }
:root[data-theme="dark"] .theme-toggle .moon { display: block; }
:root[data-theme="dark"] .theme-toggle .sun { display: none; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .theme-toggle .moon { display: block; }
  :root:not([data-theme="light"]) .theme-toggle .sun { display: none; }
}

/* layout */
.layout {
  display: grid; grid-template-columns: 232px minmax(0, 1fr) 208px;
  gap: 40px; max-width: 1240px; margin: 0 auto; padding: 0 24px;
  align-items: start;
}
.sidebar { position: sticky; top: var(--header-h); align-self: start;
  height: calc(100vh - var(--header-h)); overflow-y: auto; padding: 28px 0 40px; }
.sidebar .side-title {
  font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
  color: var(--faint); font-weight: 600; margin: 22px 8px 8px;
}
.sidebar .side-title:first-child { margin-top: 4px; }
.sidebar a {
  display: block; padding: 6px 12px; margin: 1px 0; border-radius: 8px;
  color: var(--muted); font-size: 14.5px; line-height: 1.4;
}
.sidebar a:hover { background: var(--bg-soft); color: var(--fg); text-decoration: none; }
.sidebar a.active {
  color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent);
  font-weight: 600; box-shadow: inset 2px 0 0 var(--accent);
}

main { min-width: 0; padding: 40px 0 96px; }
.content { max-width: 46rem; }

/* right toc */
.toc { position: sticky; top: calc(var(--header-h) + 28px); font-size: 13.5px;
  padding: 4px 0; max-height: calc(100vh - var(--header-h) - 60px); overflow-y: auto; }
.toc-title { font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
  color: var(--faint); font-weight: 600; margin: 0 0 10px; }
.toc ul { list-style: none; margin: 0; padding: 0; border-left: 1px solid var(--border); }
.toc li a { display: block; padding: 4px 0 4px 14px; margin-left: -1px;
  color: var(--muted); border-left: 2px solid transparent; }
.toc li.lvl-3 a { padding-left: 28px; font-size: 13px; }
.toc li a:hover { color: var(--fg); text-decoration: none; }
.toc li a.active { color: var(--accent); border-left-color: var(--accent); font-weight: 500; }

/* prose */
.content > :first-child { margin-top: 0; }
h1, h2, h3, h4 { line-height: 1.25; font-weight: 650; scroll-margin-top: calc(var(--header-h) + 16px); }
h1 { font-size: 2.1rem; letter-spacing: -.02em; margin: 0 0 .6rem; }
h2 { font-size: 1.4rem; letter-spacing: -.01em; margin: 2.6rem 0 1rem;
  padding-bottom: .4rem; border-bottom: 1px solid var(--border-soft); }
h3 { font-size: 1.12rem; margin: 2rem 0 .7rem; }
p { margin: 0 0 1.05rem; }
strong { font-weight: 650; }
ul, ol { padding-left: 1.3rem; margin: 0 0 1.15rem; }
li { margin: .35rem 0; }
li::marker { color: var(--faint); }
hr { border: none; border-top: 1px solid var(--border); margin: 2.5rem 0; }

blockquote {
  margin: 1.4rem 0; padding: .2rem 1.1rem; color: var(--muted);
  border-left: 3px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 5%, transparent);
  border-radius: 0 8px 8px 0;
}
blockquote p:last-child { margin-bottom: 0; }

/* inline code */
:not(pre) > code {
  font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: .86em;
  background: color-mix(in srgb, var(--fg) 8%, transparent);
  color: var(--fg); padding: .12em .38em; border-radius: 5px;
  border: 1px solid var(--border-soft);
}
a code { color: var(--accent); }

/* code block */
.code {
  margin: 1.4rem 0; border-radius: 12px; overflow: hidden;
  background: #0b1020; border: 1px solid #1c2333; box-shadow: var(--shadow);
}
.code-bar {
  display: flex; align-items: center; justify-content: space-between;
  height: 38px; padding: 0 10px 0 14px;
  background: #0e1424; border-bottom: 1px solid #1c2333;
}
.code-lang {
  font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 11px;
  text-transform: uppercase; letter-spacing: .08em; color: #6b7794;
}
.copy {
  font: 500 12px "IBM Plex Sans", system-ui, sans-serif; color: #8792ab;
  background: transparent; border: 1px solid #232c40; border-radius: 7px;
  padding: 4px 10px; cursor: pointer; transition: all .12s;
}
.copy:hover { color: #dfe6f5; border-color: #35415c; }
.copy.done { color: #7fdb87; border-color: #2c4a34; }
.code pre { margin: 0; padding: 16px 18px; overflow-x: auto; }
.code code {
  font-family: "IBM Plex Mono", ui-monospace, monospace;
  font-size: 13.5px; line-height: 1.7; color: #d6deeb;
}
.t-comment { color: #5f7e97; font-style: italic; }
.t-str { color: #addb67; }
.t-num { color: #f78c6c; }
.t-kw { color: #c792ea; }
.t-fn { color: #82aaff; }
.t-type { color: #ffcb8b; }
.t-flag { color: #7fdbca; }
.t-var { color: #7fdbca; }
.t-prop { color: #80cbc4; }
.t-op { color: #89ddff; }

/* tables */
.content table {
  border-collapse: collapse; width: 100%; margin: 1.4rem 0;
  font-size: 14.5px; display: block; overflow-x: auto;
  border: 1px solid var(--border); border-radius: 10px;
}
.content th, .content td {
  padding: .6rem .85rem; text-align: left; vertical-align: top;
  border-bottom: 1px solid var(--border-soft);
}
.content th { background: var(--bg-soft); font-weight: 600; font-size: 13px;
  text-transform: uppercase; letter-spacing: .03em; color: var(--muted); }
.content tr:last-child td { border-bottom: none; }
.content tbody tr:hover { background: var(--bg-soft); }

/* hero (index) */
.hero { display: flex; align-items: center; gap: 18px; margin: 8px 0 8px; }
.hero .mark {
  display: grid; place-items: center; width: 58px; height: 58px; flex: none;
  border: 1px solid var(--border); border-radius: 16px;
  background: var(--panel); box-shadow: var(--shadow); color: var(--fg);
}

footer.site {
  border-top: 1px solid var(--border); margin-top: 24px;
  padding: 28px 24px; text-align: center; color: var(--muted); font-size: 14px;
}
footer.site a { color: var(--muted); }
footer.site a:hover { color: var(--fg); }

@media (max-width: 1080px) {
  .layout { grid-template-columns: 220px minmax(0, 1fr); }
  .toc { display: none; }
}
@media (max-width: 820px) {
  .layout { grid-template-columns: minmax(0, 1fr); gap: 0; padding: 0 20px; }
  .sidebar {
    position: static; height: auto; overflow: visible;
    border-bottom: 1px solid var(--border); margin: 0 -20px;
  }
  .sidebar nav { display: flex; flex-wrap: nowrap; gap: 8px;
    overflow-x: auto; padding: 12px 20px; -webkit-overflow-scrolling: touch; }
  .sidebar .side-title { display: none; }
  .sidebar a { white-space: nowrap; margin: 0; padding: 6px 13px;
    border: 1px solid var(--border); border-radius: 999px; background: var(--panel); }
  .sidebar a.active { box-shadow: none; border-color: var(--accent); }
  .site-header nav.top .demo { display: none; }
  h1 { font-size: 1.7rem; }
}
`

const SCRIPT = `
(function () {
  var root = document.documentElement;
  var btn = document.querySelector('.theme-toggle');
  function current() {
    return root.dataset.theme ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }
  if (btn) btn.addEventListener('click', function () {
    var next = current() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('qain-theme', next); } catch (e) {}
  });

  document.querySelectorAll('.copy').forEach(function (b) {
    b.addEventListener('click', function () {
      var code = b.closest('.code').querySelector('code');
      var text = code.innerText;
      navigator.clipboard.writeText(text).then(function () {
        b.textContent = 'Copied';
        b.classList.add('done');
        setTimeout(function () { b.textContent = 'Copy'; b.classList.remove('done'); }, 1400);
      });
    });
  });

  var links = {};
  document.querySelectorAll('.toc a').forEach(function (a) {
    links[a.getAttribute('href').slice(1)] = a;
  });
  var ids = Object.keys(links);
  if (ids.length) {
    var seen = new Set();
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) seen.add(e.target.id); else seen.delete(e.target.id);
      });
      var active = ids.filter(function (id) { return seen.has(id); })[0];
      ids.forEach(function (id) { links[id].classList.toggle('active', id === active); });
    }, { rootMargin: '-72px 0px -70% 0px' });
    ids.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) obs.observe(el);
    });
  }
})();
`

function page({ title, body, toc, current, isIndex }) {
  const themeBoot = `<script>try{var t=localStorage.getItem('qain-theme');if(t)document.documentElement.dataset.theme=t;}catch(e){}</script>`
  const sun = `<svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/></svg>`
  const moon = `<svg class="moon" viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>`
  const hero = isIndex
    ? `<div class="hero"><span class="mark">${logo(34, 'currentColor')}</span></div>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${themeBoot}
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64' fill='none'%3E%3Crect x='6' y='6' width='38' height='38' rx='10' fill='none' stroke='%238a94a6' stroke-width='5'/%3E%3Crect x='20' y='20' width='38' height='38' rx='10' fill='%234361ee'/%3E%3Crect x='20' y='20' width='24' height='24' rx='5' fill='%23e5484d'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="site-header">
  <a class="brand" href="index.html">${logo(24, 'currentColor')}<span class="word">qain</span><span class="sep">/</span><span class="kicker">docs</span></a>
  <span class="spacer"></span>
  <nav class="top">
    <a class="demo" href="../">Live demo</a>
    <a href="${REPO}">GitHub</a>
  </nav>
  <button class="theme-toggle" type="button" aria-label="Toggle theme">${sun}${moon}</button>
</header>
<div class="layout">
${sidebar(current)}
<main><article class="content">${hero}
${body}</article></main>
${toc || '<div></div>'}
</div>
<footer class="site"><a href="${REPO}">github.com/Shinyaigeek/qain</a> &middot; MIT &copy; Shinyaigeek</footer>
<script>${SCRIPT}</script>
</body>
</html>
`
}

// --- build ----------------------------------------------------------------

await mkdir(outDir, { recursive: true })
const present = new Set((await readdir(DOCS)).filter((f) => f.endsWith('.md')))
for (const nav of NAV) {
  if (!present.has(nav.src)) continue
  const markdown = await readFile(join(DOCS, nav.src), 'utf8')
  const heading = markdown.match(/^# (.+)$/m)?.[1] ?? 'qain'
  const title = heading === 'qain docs' ? 'qain docs' : `${heading} · qain docs`
  const bodyHtml = marked.parse(markdown)
  const html = page({
    title,
    body: bodyHtml,
    toc: extractToc(bodyHtml),
    current: nav.file,
    isIndex: nav.src === 'README.md',
  })
  await writeFile(join(outDir, nav.file), html)
  process.stderr.write(`docs: ${nav.src} → ${join(outDir, nav.file)}\n`)
}
