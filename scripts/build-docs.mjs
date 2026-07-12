#!/usr/bin/env node
/**
 * Renders docs/*.md to standalone HTML for the GitHub Pages site
 * (https://shinyaigeek.github.io/qain/docs/). No generator, no theme: the same
 * minimal shell as the demo landing page, plus link rewriting so one Markdown
 * source serves both GitHub and the site — doc-to-doc links become .html,
 * repo-relative links (../packages/…) become GitHub URLs.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { marked } from 'marked'
import { gfmHeadingId } from 'marked-gfm-heading-id'

const REPO = 'https://github.com/Shinyaigeek/qain'
const DOCS = new URL('../docs/', import.meta.url).pathname
const outDir = process.argv[2] ?? 'site/docs'

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

marked.use(gfmHeadingId())
marked.use({
  walkTokens(token) {
    if (token.type === 'link' || token.type === 'image') token.href = rewrite(token.href)
  },
})

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font: 16px/1.6 system-ui, sans-serif;
    max-width: 46rem; margin: 2.5rem auto; padding: 0 1.25rem;
  }
  nav { font-size: 0.9rem; margin-bottom: 2rem; }
  nav a { margin-right: 1rem; }
  h1 { font-size: 1.6rem; }
  h2 { font-size: 1.25rem; margin-top: 2.2rem; }
  h3 { font-size: 1.05rem; margin-top: 1.8rem; }
  code, pre { font-family: ui-monospace, monospace; font-size: 0.9em; }
  pre { padding: 0.75rem 1rem; border-radius: 8px; overflow-x: auto;
        background: rgba(127, 127, 127, 0.12); }
  a { color: #2563eb; }
  @media (prefers-color-scheme: dark) { a { color: #7ea8ff; } }
  li { margin: 0.25rem 0; }
  table { border-collapse: collapse; display: block; overflow-x: auto; }
  th, td { border: 1px solid rgba(127, 127, 127, 0.35);
           padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
  footer { margin-top: 3rem; font-size: 0.9rem; opacity: 0.8; }
</style>
</head>
<body>
<nav>
  <a href="index.html">qain docs</a>
  <a href="../">live demo</a>
  <a href="${REPO}">GitHub</a>
</nav>
<main>
${body}
</main>
<footer><a href="${REPO}">github.com/Shinyaigeek/qain</a> · MIT © Shinyaigeek</footer>
</body>
</html>
`
}

await mkdir(outDir, { recursive: true })
const sources = (await readdir(DOCS)).filter((f) => f.endsWith('.md'))
for (const source of sources) {
  const markdown = await readFile(join(DOCS, source), 'utf8')
  const heading = markdown.match(/^# (.+)$/m)?.[1] ?? 'qain'
  const title = heading === 'qain docs' ? heading : `${heading} · qain docs`
  const out = source === 'README.md' ? 'index.html' : source.replace(/\.md$/, '.html')
  await writeFile(join(outDir, out), page(title, marked.parse(markdown)))
  process.stderr.write(`docs: ${source} → ${join(outDir, out)}\n`)
}
