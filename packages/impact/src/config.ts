import { readFile } from 'node:fs/promises'
import { PSEUDO_STATES, type PseudoState } from '@qain/core'
import type { ImpactConfig, TargetConfig } from './types.js'

export const DEFAULT_CONFIG_FILE = 'qain.impact.json'

export const DEFAULT_CONFIG: Omit<ImpactConfig, 'targets'> = {
  baselineDir: 'qain-baselines',
  componentAttributes: ['data-component', 'data-qain-component'],
  origins: {
    library: ['**/node_modules/**'],
    theme: ['**/theme/**', '**/tokens*.css', '**/*.tokens.css'],
  },
  viewport: { width: 1280, height: 720 },
  states: [],
  omitDerived: false,
}

export class ConfigError extends Error {}

const EXAMPLE = [
  '  {',
  '    "baseUrl": "http://localhost:3000",',
  '    "targets": [{ "name": "checkout", "path": "/checkout" }]',
  '  }',
].join('\n')

/**
 * Reads and validates the config. Everything except `targets` has a default, and
 * `targets` deliberately does not: there is no sound guess for which pages a team
 * wants captured, and guessing one would silently under-report.
 */
export async function loadConfig(path: string): Promise<ImpactConfig> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    throw new ConfigError(`no config at ${path}. Create one with:\n\n${EXAMPLE}\n`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${(error as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`${path} must contain a JSON object`)
  }

  const input = parsed as Partial<ImpactConfig>

  return {
    ...DEFAULT_CONFIG,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.browser ? { browser: input.browser } : {}),
    baselineDir: input.baselineDir ?? DEFAULT_CONFIG.baselineDir,
    componentAttributes: input.componentAttributes ?? DEFAULT_CONFIG.componentAttributes,
    origins: {
      library: input.origins?.library ?? DEFAULT_CONFIG.origins.library,
      theme: input.origins?.theme ?? DEFAULT_CONFIG.origins.theme,
    },
    viewport: input.viewport ?? DEFAULT_CONFIG.viewport,
    states: normalizeStates(input.states) ?? DEFAULT_CONFIG.states,
    omitDerived: input.omitDerived ?? DEFAULT_CONFIG.omitDerived,
    targets: normalizeTargets(input.targets, path),
  }
}

function normalizeTargets(targets: unknown, path: string): TargetConfig[] {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new ConfigError(`${path} must list at least one target under "targets"`)
  }

  const seen = new Set<string>()
  return targets.map((target, index) => {
    if (typeof target !== 'object' || target === null) {
      throw new ConfigError(`targets[${index}] must be an object`)
    }
    const config = target as TargetConfig
    if (!config.name) throw new ConfigError(`targets[${index}] needs a "name"`)
    if (!config.path && !config.url) {
      throw new ConfigError(`target "${config.name}" needs a "path" or a "url"`)
    }
    // The name becomes a filename, so a collision would have one target silently
    // overwrite another's baseline.
    if (seen.has(config.name)) throw new ConfigError(`duplicate target name "${config.name}"`)
    seen.add(config.name)

    const states = normalizeStates(config.states)
    return { ...config, ...(states ? { states } : {}) }
  })
}

/**
 * The resting state is always captured, so `states` names only the pseudo-states to
 * force on top of it. `"default"` is rejected rather than ignored: silently
 * dropping it would leave someone believing they had asked for something.
 */
function normalizeStates(states: unknown): PseudoState[] | undefined {
  if (states === undefined) return undefined
  if (!Array.isArray(states)) throw new ConfigError('"states" must be an array')

  const allowed = new Set<string>(PSEUDO_STATES)
  for (const state of states) {
    if (typeof state !== 'string' || !allowed.has(state)) {
      throw new ConfigError(
        `unknown state ${JSON.stringify(state)}; allowed: ${[...allowed].join(', ')} ` +
          '(the resting state is always captured)',
      )
    }
  }
  return states as PseudoState[]
}

/** The URL a target resolves to. Throws rather than capturing the wrong page. */
export function targetUrl(target: TargetConfig, baseUrl: string | undefined): string {
  if (target.url) return target.url
  if (!baseUrl) {
    throw new ConfigError(
      `target "${target.name}" uses "path", so the config needs a "baseUrl" (or give the target an absolute "url")`,
    )
  }
  return new URL(target.path!, baseUrl).toString()
}

/** Baselines are one JSON per target, named by target. Keep it filesystem-safe. */
export function baselineName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '-')
}
