/**
 * WCAG 2.1 contrast, computed against the *composited* background.
 *
 * The reason this is worth doing here rather than in an accessibility linter:
 * `background-color` as declared is often `transparent` or a translucent
 * overlay, and a linter reading the CSS cannot know what ends up behind the
 * text. Chromium can — DOMSnapshot's `blendedBackgroundColors` returns the color
 * after compositing. A half-opaque white panel over blue reports
 * `rgb(128, 128, 255)`, which is what the eye actually receives.
 */

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const RGB_PATTERN = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)$/i

export function parseColor(input: string | undefined): Rgba | null {
  if (!input) return null
  const match = RGB_PATTERN.exec(input.trim())
  if (!match) return null

  const [, r, g, b, a] = match
  let alpha = 1
  if (a !== undefined) {
    alpha = a.endsWith('%') ? Number.parseFloat(a) / 100 : Number.parseFloat(a)
  }
  if (!Number.isFinite(alpha)) return null

  return { r: Number(r), g: Number(g), b: Number(b), a: alpha }
}

/** Source-over compositing of `fg` onto an opaque `bg`. */
export function composite(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  }
}

function channelLuminance(value: number): number {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance({ r, g, b }: Rgba): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)
}

/** WCAG contrast ratio, 1.0 (identical) to 21.0 (black on white). */
export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const opaque = foreground.a < 1 ? composite(foreground, background) : foreground
  const l1 = relativeLuminance(opaque)
  const l2 = relativeLuminance(background)
  const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * WCAG treats large text more leniently: >= 24px, or >= 18.66px when bold.
 * `textOpacity` folds in opacity inherited from ancestors, which Chromium
 * reports separately because it is applied at paint time, not to the color value.
 */
export interface ContrastInput {
  color: string | undefined
  blendedBackground: string | undefined
  fontSize: string | undefined
  fontWeight: string | undefined
  textOpacity?: number
}

export function isLargeText(fontSize: string | undefined, fontWeight: string | undefined): boolean {
  const size = Number.parseFloat(fontSize ?? '')
  if (!Number.isFinite(size)) return false
  const weight = Number.parseInt(fontWeight ?? '400', 10)
  const bold = Number.isFinite(weight) ? weight >= 700 : false
  return size >= 24 || (bold && size >= 18.66)
}

export function computeContrast(input: ContrastInput): number | null {
  const fg = parseColor(input.color)
  const bg = parseColor(input.blendedBackground)
  if (!fg || !bg) return null
  if (bg.a < 1) return null // nothing opaque behind the text; ratio is undefined

  const opacity = input.textOpacity ?? 1
  const effective: Rgba = { ...fg, a: fg.a * opacity }
  return contrastRatio(effective, bg)
}

export const THRESHOLDS = {
  'AA-normal': 4.5,
  'AA-large': 3,
  'AAA-normal': 7,
  'AAA-large': 4.5,
} as const

/**
 * Names the strictest threshold the ratio fell below, going from `before` to
 * `after`. Returns null when nothing was crossed — a ratio that drops 8.0 -> 7.5
 * is a change, not a regression, and callers usually want to say so differently.
 */
export function crossedThreshold(before: number, after: number, large: boolean): string | null {
  const applicable: [string, number][] = large
    ? [
        ['AAA-large', THRESHOLDS['AAA-large']],
        ['AA-large', THRESHOLDS['AA-large']],
      ]
    : [
        ['AAA-normal', THRESHOLDS['AAA-normal']],
        ['AA-normal', THRESHOLDS['AA-normal']],
      ]

  // Report the most severe crossing: AA before AAA.
  for (const [name, limit] of applicable.slice().reverse()) {
    if (before >= limit && after < limit) return name
  }
  return null
}
