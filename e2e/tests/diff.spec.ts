import { expect, type Page, test } from '@playwright/test'
import { type CdpSession, capture, diff, type Snapshot } from '@qain/core'

async function snap(page: Page, path: string, options = {}): Promise<Snapshot> {
  await page.goto(path)
  await page.evaluate(() => document.fonts.ready)
  const cdp = (await page.context().newCDPSession(page)) as unknown as CdpSession
  return capture(cdp, options)
}

test('identical pages produce an empty diff', async ({ page }) => {
  const before = await snap(page, '/base.html')
  const after = await snap(page, '/base.html')
  expect(diff(before, after).changes).toEqual([])
})

test('class-name churn produces no diff', async ({ page }) => {
  // Tailwind and CSS Modules rewrite class strings on every build. The rendering
  // is identical, so qain must stay silent — this is the case that makes naive
  // DOM snapshot tests unusable in a real codebase.
  const before = await snap(page, '/base.html')
  const after = await snap(page, '/class-churn.html')
  expect(diff(before, after).changes).toEqual([])
})

test('inserting an element reports one addition, not a rewritten subtree', async ({ page }) => {
  const before = await snap(page, '/base.html')
  const after = await snap(page, '/inserted.html')
  const result = diff(before, after)

  const added = result.changes.filter((c) => c.kind === 'added')
  expect(added).toHaveLength(1)
  expect(added[0]!.key).toBe('@brand-new')

  // Everything after it shifted down, and every one of those is derived.
  const boxes = result.changes.filter((c) => c.kind === 'box')
  expect(boxes.length).toBeGreaterThan(0)
  expect(boxes.every((c) => c.kind === 'box' && c.cause === 'derived')).toBe(true)

  // No element was reported as removed, and nothing was restyled.
  expect(result.changes.filter((c) => c.kind === 'removed')).toEqual([])
  expect(result.changes.filter((c) => c.kind === 'style')).toEqual([])
})

test('separates the cause of a reflow from its collateral', async ({ page }) => {
  // `.btn` padding goes 8px -> 20px. Padding is not in the projection, so the
  // buttons have no style change; the only evidence is that they grew while
  // their contents did not. Everything else on the page merely got pushed.
  const before = await snap(page, '/base.html')
  const after = await snap(page, '/derived-shift.html')
  const result = diff(before, after)

  const primary = result.changes.filter((c) => c.kind === 'box' && c.cause === 'primary')
  const derived = result.changes.filter((c) => c.kind === 'box' && c.cause === 'derived')

  // Exactly the two buttons are named as causes.
  expect(primary.map((c) => c.key).sort()).toEqual(['@cancel', '@submit'])

  // The note was displaced; the stack and body only grew to fit the buttons.
  const derivedKeys = derived.map((c) => c.key)
  expect(derivedKeys).toContain('@note')
  expect(derived.length).toBeGreaterThan(0)

  expect(result.summary.primary).toBe(primary.length)
  expect(result.summary.derived).toBe(derived.length)
})

test('reports an inherited change once, at the element that declared it', async ({ page }) => {
  // `body` gains `letter-spacing: 1px`. Every descendant inherits it and restates
  // the identical change — the noise this demotion exists to remove. `.note` sets
  // 4px of its own, so it moves between different values and stays a cause.
  const before = await snap(page, '/base.html')
  const after = await snap(page, '/inherited-changed.html')
  const result = diff(before, after)

  const spacing = result.changes.filter(
    (c) => c.kind === 'style' && c.property === 'letter-spacing',
  )
  const primary = spacing.filter((c) => c.kind === 'style' && c.cause === 'primary')
  const derived = spacing.filter((c) => c.kind === 'style' && c.cause === 'derived')

  // The body declared it; the note overrode it. Nothing else is a cause.
  expect(primary.map((c) => c.key).sort()).toEqual(['@note', 'html/body'])
  // The overlay, two levels down, restates the body's change verbatim. The buttons
  // are absent rather than derived: the UA sheet resets `letter-spacing` on form
  // controls, so they never inherited it in the first place.
  expect(derived.length).toBeGreaterThan(0)
  expect(derived.map((c) => c.key)).toContain('@overlay')

  // Dropping the derived changes leaves the two declarations and no restatements.
  const terse = diff(before, after, { omitDerived: true })
  expect(
    terse.changes.filter((c) => c.kind === 'style' && c.property === 'letter-spacing'),
  ).toHaveLength(2)
})

test('detects a contrast regression and names the WCAG threshold', async ({ page }) => {
  const before = await snap(page, '/base.html')
  const after = await snap(page, '/contrast-regression.html')
  const result = diff(before, after)

  const contrast = result.changes.find((c) => c.kind === 'contrast' && c.key === '@note')
  expect(contrast).toBeDefined()
  if (contrast?.kind !== 'contrast') throw new Error('unreachable')

  expect(contrast.before).toBeGreaterThan(4.5)
  expect(contrast.after).toBeLessThan(4.5)
  expect(contrast.crosses).toBe('AA-normal')
})

test('one colour change reports as one primary change, not seven', async ({ page }) => {
  // `border-*-color`, `outline-color` and `text-decoration-color` all default to
  // `currentColor`, so changing `color` moves seven properties. Only `color` is
  // the change; the rest are the same fact restated.
  const before = await snap(page, '/base.html')
  const after = await snap(page, '/contrast-regression.html')
  const result = diff(before, after)

  const styles = result.changes.filter((c) => c.kind === 'style')
  const primary = styles.filter((c) => c.kind === 'style' && c.cause === 'primary')

  expect(primary).toHaveLength(1)
  expect(primary[0]!.key).toBe('@note')
  expect(primary[0]!.kind === 'style' && primary[0]!.property).toBe('color')
  expect(styles.length).toBeGreaterThan(1)
  expect(result.summary.primary).toBeLessThan(styles.length)
})

test('an independently authored border colour is still primary', async ({ page }) => {
  const before = await snap(page, '/base.html')
  await page.goto('/base.html')
  await page.addStyleTag({ content: '.note { border-top-color: rgb(1, 2, 3); }' })
  const cdp = (await page.context().newCDPSession(page)) as unknown as CdpSession
  const after = await capture(cdp)

  const change = diff(before, after).changes.find(
    (c) => c.kind === 'style' && c.property === 'border-top-color',
  )
  expect(change).toBeDefined()
  expect(change!.kind === 'style' && change!.cause).toBe('primary')
})

test('omitDerived drops collateral movement', async ({ page }) => {
  const before = await snap(page, '/base.html')
  const after = await snap(page, '/inserted.html')

  const full = diff(before, after)
  const terse = diff(before, after, { omitDerived: true })

  expect(full.summary.derived).toBeGreaterThan(0)
  expect(terse.summary.derived).toBe(0)
  expect(terse.changes.length).toBeLessThan(full.changes.length)
})

test('a viewport mismatch is a warning, not a silent wrong answer', async ({ page }) => {
  const before = await snap(page, '/base.html')
  await page.setViewportSize({ width: 800, height: 600 })
  const after = await snap(page, '/base.html')

  const result = diff(before, after)
  expect(result.warnings.join('\n')).toContain('viewport differs')
})

test('a recoloured element that gets pushed reports the move as derived', async ({ page }) => {
  // The footnote-like `.note` changes colour *and* is displaced by the buttons
  // growing. Colour cannot move a box, so only the colour is a cause.
  const before = await snap(page, '/base.html')
  await page.goto('/derived-shift.html')
  await page.addStyleTag({ content: '.note { color: rgb(190, 190, 190); }' })
  const cdp = (await page.context().newCDPSession(page)) as unknown as CdpSession
  const after = await capture(cdp)

  const changes = diff(before, after).changes.filter((c) => c.key === '@note')
  const style = changes.find((c) => c.kind === 'style' && c.property === 'color')
  const box = changes.find((c) => c.kind === 'box')

  expect(style?.kind === 'style' && style.cause).toBe('primary')
  expect(box?.kind === 'box' && box.delta.dy).toBeGreaterThan(0)
  expect(box?.kind === 'box' && box.cause).toBe('derived')
})
