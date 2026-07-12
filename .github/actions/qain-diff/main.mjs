// The action's brain, driven from action.yml via actions/github-script:
// find the qain baselines this PR changes, diff each against its merge-base
// version, and keep exactly one sticky comment in sync — created when a diff
// appears, updated in place, deleted when the diff disappears.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
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

export async function run({ github, context, core }) {
  const patterns = (process.env.QAIN_PATTERN ?? '**/*.qain.json')
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean)
    .map(globToRegExp)
  const name = process.env.QAIN_NAME || 'qain'
  const cmdWords = (process.env.QAIN_CMD || 'npx --yes @qain/cli').split(/\s+/)
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
        }
        entries.push(entry)
      } catch (err) {
        core.warning(`qain-diff: ${f.filename}: ${err.message}`)
        entries.push({ path: f.filename, status: 'error', error: err.message })
      }
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
      entries.map(({ text, warnings, ...rest }) => rest), // keep the output small
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
