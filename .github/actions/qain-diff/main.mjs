// The action's brain, driven from action.yml via actions/github-script:
// find the qain baselines this PR changes, diff each against its merge-base
// version, and keep exactly one sticky comment in sync — created when a diff
// appears, updated in place, deleted when the diff disappears.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildComment, isReportable, markerFor } from './comment.mjs'

/** Minimal glob → RegExp: supports '**', '*' and '?', '/'-aware. */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:[^/]+/)*'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

function qain(cmdWords, args, opts = {}) {
  const r = spawnSync(cmdWords[0], [...cmdWords.slice(1), ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  })
  if (r.error) throw r.error
  return r
}

/** Renders need a browser; prefer what the runner already has. */
function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']) {
    const r = spawnSync('which', [name], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim()
  }
  return null
}

/** `--replay` capture data is what makes a snapshot renderable as pixels. */
function hasReplayData(json) {
  try {
    const snapshot = JSON.parse(json)
    return Boolean(snapshot.states?.some((s) => s.nodes?.some((n) => n.textRuns !== undefined)))
  } catch {
    return false
  }
}

/**
 * Commit files to the assets branch and return the commit sha. A comment can
 * only embed an image by URL, so the PNGs live on an orphan branch, referenced
 * immutably by commit — raw.githubusercontent.com renders in comments for
 * public repositories.
 */
async function pushAssets(github, { owner, repo }, branch, files, message) {
  const blobs = await Promise.all(
    files.map((f) =>
      github.rest.git.createBlob({ owner, repo, content: f.base64, encoding: 'base64' }),
    ),
  )
  const { data: tree } = await github.rest.git.createTree({
    owner,
    repo,
    tree: files.map((f, i) => ({
      path: f.path,
      mode: '100644',
      type: 'blob',
      sha: blobs[i].data.sha,
    })),
  })

  for (let attempt = 0; ; attempt++) {
    let headSha = null
    try {
      const { data } = await github.rest.git.getRef({ owner, repo, ref: `heads/${branch}` })
      headSha = data.object.sha
    } catch (err) {
      if (err.status !== 404) throw err
    }
    const { data: commit } = await github.rest.git.createCommit({
      owner,
      repo,
      message,
      tree: tree.sha,
      parents: headSha ? [headSha] : [],
    })
    try {
      if (headSha) {
        await github.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.sha })
      } else {
        await github.rest.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${branch}`,
          sha: commit.sha,
        })
      }
      return commit.sha
    } catch (err) {
      // Another run moved the ref between read and write; re-read and retry once.
      if (attempt === 0 && (err.status === 422 || err.status === 409)) continue
      throw err
    }
  }
}

export async function run({ github, context, core }) {
  const patterns = (process.env.QAIN_PATTERN ?? '**/*.qain.json')
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean)
    .map(globToRegExp)
  const name = process.env.QAIN_NAME || 'qain'
  const cmdWords = (process.env.QAIN_CMD || 'npx --yes @qain/cli').split(/\s+/)
  const screenshots = (process.env.QAIN_SCREENSHOTS ?? 'true') !== 'false'
  const assetsBranch = process.env.QAIN_ASSETS_BRANCH || 'qain-diff-assets'
  const workspace = process.env.GITHUB_WORKSPACE
  const reportDir = join(process.env.RUNNER_TEMP, 'qain-reports')
  const baseDir = join(process.env.RUNNER_TEMP, 'qain-bases')

  const setOutputs = (o) => {
    for (const [k, v] of Object.entries(o)) core.setOutput(k, String(v))
  }
  setOutputs({ changed: false, total: 0, report: false, files: '[]' })

  const pr = context.payload.pull_request
  if (!pr) {
    core.warning('qain-diff only works on pull_request events; nothing to do.')
    return
  }
  const { owner, repo } = context.repo

  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pr.number,
    per_page: 100,
  })
  const matches = (path) => path && patterns.some((re) => re.test(path))
  const matched = files.filter((f) => matches(f.filename) || matches(f.previous_filename))
  core.info(
    `${matched.length} of ${files.length} changed file(s) match ${patterns.length} pattern(s)`,
  )

  const entries = []
  if (matched.length > 0) {
    mkdirSync(reportDir, { recursive: true })
    mkdirSync(baseDir, { recursive: true })

    // Changed files are reported against the merge base, so fetch base
    // contents from there too — the diff then matches what the PR view shows.
    const { data: cmp } = await github.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${pr.base.sha}...${pr.head.sha}`,
    })
    const mergeBase = cmp.merge_base_commit.sha

    for (const f of matched) {
      if (f.status === 'added') {
        entries.push({ path: f.filename, status: 'added' })
        continue
      }
      if (f.status === 'removed') {
        entries.push({ path: f.filename, status: 'removed' })
        continue
      }
      const basePath = f.previous_filename ?? f.filename
      const slug = f.filename.replace(/[^A-Za-z0-9._-]+/g, '__')
      try {
        const { data: raw } = await github.rest.repos.getContent({
          owner,
          repo,
          path: basePath,
          ref: mergeBase,
          mediaType: { format: 'raw' },
        })
        const before = join(baseDir, slug)
        writeFileSync(before, typeof raw === 'string' ? raw : JSON.stringify(raw))
        const after = join(workspace, f.filename)

        const json = qain(cmdWords, ['diff', before, after, '--json'])
        if (json.status !== 0 && json.status !== 1) {
          throw new Error(`qain diff exited ${json.status}: ${json.stderr || json.stdout}`)
        }
        const diff = JSON.parse(json.stdout)
        const { total = 0, primary = 0, derived = 0 } = diff.summary ?? {}
        const entry = {
          path: f.filename,
          status: 'modified',
          ...(f.previous_filename ? { renamedFrom: f.previous_filename } : {}),
          total,
          primary,
          derived,
          contrast: (diff.changes ?? []).filter((c) => c.kind === 'contrast' && c.crosses).length,
          warnings: diff.warnings ?? [],
        }
        if (total > 0) {
          entry.text = qain(cmdWords, ['diff', before, after, '--no-color']).stdout
          qain(cmdWords, ['diff', before, after, '--html', join(reportDir, `${slug}.html`)])

          if (screenshots) {
            if (
              hasReplayData(readFileSync(before, 'utf8')) &&
              hasReplayData(readFileSync(after, 'utf8'))
            ) {
              const shotDir = join(reportDir, `${slug}.shots`)
              const chrome = findChrome()
              const r = qain(cmdWords, [
                'shot',
                before,
                after,
                '-o',
                shotDir,
                ...(chrome ? ['--browser', chrome] : []),
              ])
              if (r.status === 0) entry.shotDir = shotDir
              else core.warning(`qain shot failed for ${f.filename}: ${r.stderr || r.stdout}`)
            } else {
              entry.noReplay = true
            }
          }
        }
        entries.push(entry)
      } catch (err) {
        core.warning(`qain-diff: ${f.filename}: ${err.message}`)
        entries.push({ path: f.filename, status: 'error', error: err.message })
      }
    }
  }

  // Embed the screenshots: one assets-branch commit for the whole run, each
  // image referenced by that immutable commit sha.
  const withShots = entries.filter((e) => e.shotDir)
  if (withShots.length > 0) {
    try {
      const assets = []
      for (const e of withShots) {
        e.images = {}
        for (const file of ['before.png', 'after.png', 'diff.png']) {
          const path = `pr-${pr.number}/${e.path.replace(/[^A-Za-z0-9._-]+/g, '__')}/${file}`
          assets.push({ path, base64: readFileSync(join(e.shotDir, file)).toString('base64') })
          e.images[file.replace('.png', '')] = path
        }
      }
      const sha = await pushAssets(
        github,
        { owner, repo },
        assetsBranch,
        assets,
        `qain screenshots for #${pr.number} (${context.sha ?? pr.head.sha})`,
      )
      for (const e of withShots) {
        for (const key of Object.keys(e.images)) {
          e.images[key] =
            `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${e.images[key]}`
        }
      }
    } catch (err) {
      core.warning(
        `Could not push screenshots to '${assetsBranch}' (does the workflow grant contents: write?): ${err.message}`,
      )
      for (const e of withShots) e.images = undefined
    }
  }

  const changedEntries = entries.filter((e) => e.status === 'modified' && e.total > 0)
  const total = changedEntries.reduce((n, e) => n + e.total, 0)
  const hasReport = changedEntries.length > 0
  setOutputs({
    changed: changedEntries.length > 0,
    total,
    report: hasReport,
    files: JSON.stringify(
      entries.map(({ text, warnings, shotDir, images, ...rest }) => rest), // keep the output small
    ),
  })

  // One sticky comment per `name`: create it when there is something to say,
  // rewrite it in place while there is, delete it the moment there is not.
  const marker = markerFor(name)
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pr.number,
    per_page: 100,
  })
  const mine = comments.find((c) => c.body?.includes(marker))

  if (!isReportable(entries)) {
    if (mine) {
      await github.rest.issues.deleteComment({ owner, repo, comment_id: mine.id })
      core.info('No style diff any more — deleted the stale comment.')
    } else {
      core.info('No style diff and no comment — nothing to do.')
    }
    return
  }

  const body = buildComment({
    name,
    runUrl: `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`,
    hasReport,
    entries,
  })
  if (mine) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: mine.id, body })
    core.info(`Updated comment ${mine.id}.`)
  } else {
    const { data } = await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: pr.number,
      body,
    })
    core.info(`Created comment ${data.id}.`)
  }
}
