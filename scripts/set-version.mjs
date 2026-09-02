#!/usr/bin/env node
// Sets one version across every publishable package, and prints it.
//
// Every package in the workspace ships the same version, and `workspace:*` deps
// are rewritten by `pnpm publish` to whatever that version is — so setting them
// together is the only way to publish a coherent set.
//
//   node scripts/set-version.mjs 0.1.0
//   node scripts/set-version.mjs --prerelease beta --id 42.gc0ffee1
//
// The prerelease form bumps the patch first. `0.0.5` becomes `0.0.6-beta.42.gc0ffee1`
// rather than `0.0.5-beta.42...`, because a prerelease sorts *before* the release it
// names: publishing `0.0.5-beta.1` would put `npm install pkg@beta` on something
// older than the current `latest`.

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = join(root, 'packages')

async function publishablePackages() {
  const entries = await readdir(packagesDir, { withFileTypes: true })
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(packagesDir, entry.name, 'package.json')
    let source
    try {
      source = await readFile(path, 'utf8')
    } catch {
      continue
    }
    const manifest = JSON.parse(source)
    if (manifest.private) continue
    out.push({ path, source, manifest })
  }
  return out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
}

function bumpPatch(version) {
  const [core] = version.split('-')
  const [major, minor, patch] = core.split('.').map(Number)
  if ([major, minor, patch].some((n) => !Number.isInteger(n))) {
    throw new Error(`cannot bump a non-semver version: ${version}`)
  }
  return `${major}.${minor}.${patch + 1}`
}

function parseArgs(argv) {
  const args = { explicit: null, prerelease: null, id: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--prerelease') args.prerelease = argv[++i]
    else if (argv[i] === '--id') args.id = argv[++i]
    else args.explicit = argv[i]
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const packages = await publishablePackages()
if (packages.length === 0) throw new Error('no publishable packages found under packages/')

let version = args.explicit
if (args.prerelease) {
  if (!args.id) throw new Error('--prerelease needs --id')
  // Identifiers are dot-separated and must not have leading zeros when numeric.
  // The caller passes `<run>.g<sha>`; the `g` keeps a hex sha alphanumeric.
  if (!/^[0-9A-Za-z.-]+$/.test(args.id)) throw new Error(`unusable prerelease id: ${args.id}`)
  version = `${bumpPatch(packages[0].manifest.version)}-${args.prerelease}.${args.id}`
}
if (!version) throw new Error('usage: set-version.mjs <version> | --prerelease <tag> --id <id>')

// Rewritten in place rather than re-serialized: `JSON.stringify` would reflow every
// manifest in the repo and bury the one-line change in formatting noise.
for (const { path, source, manifest } of packages) {
  const patched = source.replace(
    /^(\s*"version"\s*:\s*)"[^"]*"/m,
    (_, prefix) => `${prefix}${JSON.stringify(version)}`,
  )
  if (patched === source && manifest.version !== version) {
    throw new Error(`could not find a "version" field to rewrite in ${path}`)
  }
  await writeFile(path, patched)
}

process.stderr.write(`set ${packages.map((p) => p.manifest.name).join(', ')} to ${version}\n`)
process.stdout.write(version)
