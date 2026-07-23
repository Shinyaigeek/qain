import { expect, type Page, test } from '@playwright/test'
import { type CdpSession, capture, type Snapshot } from '@qain/core'

async function snap(page: Page, path: string, options = {}): Promise<Snapshot> {
  await page.goto(path)
  await page.evaluate(() => document.fonts.ready)
  const cdp = (await page.context().newCDPSession(page)) as unknown as CdpSession
  return capture(cdp, options)
}

const nodeFor = (snapshot: Snapshot, key: string, state = 'default') =>
  snapshot.states.find((s) => s.state === state)?.nodes.find((n) => n.key === key)

test('captures used values and layout boxes, not authored declarations', async ({ page }) => {
  const snapshot = await snap(page, '/base.html')
  const submit = nodeFor(snapshot, '@submit')

  expect(submit).toBeDefined()
  expect(submit!.styles['background-color']).toBe('rgb(59, 130, 246)')
  // A box the CSS never declares: it exists only after layout.
  expect(submit!.box).not.toBeNull()
  expect(submit!.box![2]).toBeGreaterThan(0)
  expect(submit!.box![3]).toBeGreaterThan(0)
})

test('projection excludes properties already visible in the box', async ({ page }) => {
  const snapshot = await snap(page, '/base.html')
  for (const property of ['padding-top', 'margin-left', 'width', 'height']) {
    expect(snapshot.projection).not.toContain(property)
  }
  expect(snapshot.projection).toContain('background-color')
})

test('data-testid produces a key that survives being moved', async ({ page }) => {
  const before = await snap(page, '/base.html')
  const after = await snap(page, '/inserted.html')

  // Submit moved down one slot; its key did not change.
  expect(nodeFor(before, '@submit')).toBeDefined()
  expect(nodeFor(after, '@submit')).toBeDefined()
  expect(nodeFor(after, '@brand-new')).toBeDefined()
  expect(nodeFor(before, '@brand-new')).toBeUndefined()
})

test('resolves accessible role and name from the AX tree', async ({ page }) => {
  const snapshot = await snap(page, '/base.html')
  const submit = nodeFor(snapshot, '@submit')!
  expect(submit.role).toBe('button')
  expect(submit.name).toBe('Submit')
})

test('records pseudo-elements as their own nodes', async ({ page }) => {
  await page.goto('/base.html')
  await page.addStyleTag({ content: '.note::before { content: "★"; color: rgb(220, 38, 38); }' })
  const cdp = (await page.context().newCDPSession(page)) as unknown as CdpSession
  const snapshot = await capture(cdp)

  const pseudo = snapshot.states[0]!.nodes.find((n) => n.pseudo === 'before')
  expect(pseudo).toBeDefined()
  expect(pseudo!.styles.color).toBe('rgb(220, 38, 38)')
  expect(pseudo!.key).toContain('::before')
})

test('blended background resolves compositing, not the declared color', async ({ page }) => {
  const snapshot = await snap(page, '/base.html')
  const overlay = nodeFor(snapshot, '@overlay')!

  expect(overlay.styles['background-color']).toBe('rgba(255, 255, 255, 0.5)')
  // Half-opaque white over pure blue.
  expect(overlay.blendedBackground).toBe('rgb(128, 128, 255)')
})

test('scopes to a selector', async ({ page }) => {
  const snapshot = await snap(page, '/base.html', { selector: '.panel' })
  const keys = snapshot.states[0]!.nodes.map((n) => n.key)
  expect(keys.some((k) => k === '@overlay')).toBe(true)
  expect(keys.some((k) => k === '@submit')).toBe(false)
})

// ---------------------------------------------------------------------------
// Pseudo-state capture strategy — the behaviour the spike uncovered.
// ---------------------------------------------------------------------------

test('hover that only repaints stays on the fast bulk path', async ({ page }) => {
  const snapshot = await snap(page, '/hover-color.html', { states: ['hover'] })
  const hover = snapshot.states.find((s) => s.state === 'hover')!

  expect(hover.strategy).toBe('bulk')
  expect(snapshot.warnings).toEqual([])
  expect(nodeFor(snapshot, '@a', 'hover')!.styles['background-color']).toBe('rgb(200, 200, 200)')
  expect(nodeFor(snapshot, '@b', 'hover')!.styles['background-color']).toBe('rgb(200, 200, 200)')
})

test('hover that reflows falls back to isolated capture', async ({ page }) => {
  const snapshot = await snap(page, '/hover-layout.html', { states: ['hover'] })
  const hover = snapshot.states.find((s) => s.state === 'hover')!

  expect(hover.strategy).toBe('isolated')
  expect(snapshot.warnings.join('\n')).toContain('fell back to isolated capture')

  // Under isolated capture each button is measured while it alone is hovered,
  // so B keeps the y it has when A is at rest. A bulk capture would have pushed
  // B down by A's extra padding.
  const restB = nodeFor(snapshot, '@b')!
  const hoverB = nodeFor(snapshot, '@b', 'hover')!
  expect(hoverB.box![1]).toBe(restB.box![1])
  expect(hoverB.box![3]).toBeGreaterThan(restB.box![3])
})

test('bulk strategy can be forced, and says so when it is wrong', async ({ page }) => {
  const snapshot = await snap(page, '/hover-layout.html', { states: ['hover'], strategy: 'bulk' })
  const hover = snapshot.states.find((s) => s.state === 'hover')!

  expect(hover.strategy).toBe('bulk')
  expect(snapshot.warnings.join('\n')).toContain('contaminated')
})
