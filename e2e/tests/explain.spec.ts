import { expect, type Page, test } from '@playwright/test'
import { type CdpSession, capture, diff, type Snapshot, winner } from '@qain/core'

async function snap(page: Page, path: string, options = {}): Promise<Snapshot> {
  await page.goto(path)
  await page.evaluate(() => document.fonts.ready)
  const cdp = (await page.context().newCDPSession(page)) as unknown as CdpSession
  return capture(cdp, options)
}

test('names the rule, the shorthand and the file:line behind a reflow', async ({ page }) => {
  // `padding` is not in the projection, so the diff can only say the button grew.
  // Attribution goes to the matched rules and finds the declaration that did it.
  const before = await snap(page, '/ext-base.html', { rules: true })
  const after = await snap(page, '/ext-changed.html', { rules: true })
  const result = diff(before, after)

  const submit = result.attributions.find((a) => a.key === '@submit')
  expect(submit).toBeDefined()
  expect(submit!.unattributed).toBe(false)

  // Four longhands changed, but the author wrote one shorthand. Report it once.
  expect(submit!.causes).toHaveLength(1)
  const cause = submit!.causes[0]!
  expect(cause.property).toBe('padding')
  expect(cause.before!.selector).toBe('.btn')
  expect(cause.before!.shorthand).toBe('padding: 8px 16px')
  expect(cause.after!.shorthand).toBe('padding: 20px 16px')

  expect(cause.before!.source!.url).toMatch(/\/external\.css$/)
  expect(cause.after!.source!.url).toMatch(/\/external-changed\.css$/)
  expect(cause.after!.source!.line).toBe(3)
})

test('a renamed class does not list declarations whose value never changed', async ({ page }) => {
  // A v2→v3 migration rewrites the winning selector and its source even for
  // declarations that render identically. Only `padding` actually moved, so the
  // one cause reported must be `padding` — not `display: inline-flex → inline-flex`
  // and the rest of the box model coming along because their selector renamed.
  const before = await snap(page, '/migrate-v2.html', { rules: true })
  const after = await snap(page, '/migrate-v3.html', { rules: true })

  const pay = diff(before, after).attributions.find((a) => a.key === '@pay')!
  expect(pay.unattributed).toBe(false)

  const properties = pay.causes.map((c) => c.property)
  expect(properties).toEqual(['padding'])
  expect(properties).not.toContain('display')
  expect(properties).not.toContain('box-sizing')
  expect(properties).not.toContain('align-items')

  const padding = pay.causes[0]!
  expect(padding.before!.selector).toBe('.css-1a2b3c')
  expect(padding.after!.selector).toBe('.chakra-button--solid')
})

test('resolves the cascade rather than taking the last matched rule', async ({ page }) => {
  // Chromium orders matchedCSSRules by specificity, not by importance. `.winner`
  // sits *before* the more specific `#target` in that array, and an inline style is
  // not in the array at all — yet `.winner !important` is what renders.
  const before = await snap(page, '/cascade.html', { rules: true })
  const after = await snap(page, '/cascade-changed.html', { rules: true })

  const node = before.states[0]!.nodes.find((n) => n.key === '@t')!
  expect(node.styles['background-color']).toBe('rgb(3, 3, 3)')

  const declarations = before.states[0]!.rules!['@t']!
  const win = winner(declarations, 'background-color')
  expect(win!.value).toBe('rgb(3, 3, 3)')
  expect(win!.important).toBe(true)
  expect(win!.selector).toBe('.winner')

  // Chromium agrees: the computed value equals the declaration we picked.
  expect(node.styles['background-color']).toBe(win!.value)

  // And the diff attributes the change to that same rule, not to #target or inline.
  const cause = diff(before, after).attributions.find((a) => a.key === '@t')!.causes[0]!
  expect(cause.property).toBe('background-color')
  expect(cause.before!.value).toBe('rgb(3, 3, 3)')
  expect(cause.after!.value).toBe('rgb(9, 9, 9)')
  expect(cause.after!.selector).toBe('.winner')
  expect(cause.after!.source!.url).toMatch(/cascade-changed\.html$/)
})

test('attributes a colour change to its rule and ignores the currentColor followers', async ({
  page,
}) => {
  const before = await snap(page, '/ext-base.html', { rules: true })
  await page.goto('/ext-base.html')
  await page.addStyleTag({ content: '.note { color: rgb(190, 190, 190); }' })
  const cdp = (await page.context().newCDPSession(page)) as unknown as CdpSession
  const after = await capture(cdp, { rules: true })

  const note = diff(before, after).attributions.find((a) => a.key === '@note')!
  const properties = note.causes.map((c) => c.property)

  // `color` changed; `border-*-color` and friends followed it and are derived, so
  // they never reach attribution.
  expect(properties).toContain('color')
  expect(properties).not.toContain('border-top-color')
  expect(properties).not.toContain('outline-color')
})

test('derived changes are never attributed — their cause is another node', async ({ page }) => {
  // The note is pushed down by the button growing. Nothing in `.note` changed, and
  // asking the stylesheet why it moved would find a rule that did not change.
  const before = await snap(page, '/ext-base.html', { rules: true })
  const after = await snap(page, '/ext-changed.html', { rules: true })
  const result = diff(before, after)

  expect(
    result.changes.some((c) => c.kind === 'box' && c.cause === 'derived' && c.key === '@note'),
  ).toBe(true)
  expect(result.attributions.some((a) => a.key === '@note')).toBe(false)
})

test('reports unattributed when a primary change has no declaration behind it', async ({
  page,
}) => {
  // A longer label widens the button. Every declaration on it is untouched — the
  // cause is content, not CSS. qain must say it does not know rather than blame a
  // rule that happens to mention `width`.
  const before = await snap(page, '/ext-base.html', { rules: true })
  const after = await snap(page, '/ext-longer-text.html', { rules: true })

  const result = diff(before, after)
  const box = result.changes.find((c) => c.kind === 'box' && c.key === '@submit')
  expect(box?.kind === 'box' && box.cause).toBe('primary')

  const submit = result.attributions.find((a) => a.key === '@submit')!
  expect(submit.causes).toEqual([])
  expect(submit.unattributed).toBe(true)
})

test('a snapshot without rules yields no attributions and warns on mismatch', async ({ page }) => {
  const plainBefore = await snap(page, '/ext-base.html')
  const plainAfter = await snap(page, '/ext-changed.html')
  expect(diff(plainBefore, plainAfter).attributions).toEqual([])

  const withRules = await snap(page, '/ext-changed.html', { rules: true })
  const mixed = diff(plainBefore, withRules)
  expect(mixed.attributions).toEqual([])
  expect(mixed.warnings.join('\n')).toContain('only one snapshot carries matched rules')
})

test('rules exclude the user-agent stylesheet by default', async ({ page }) => {
  const snapshot = await snap(page, '/ext-base.html', { rules: true })
  const declarations = snapshot.states[0]!.rules!['@submit']!
  expect(declarations.every((d) => d.origin !== 'user-agent')).toBe(true)

  const withUa = await snap(page, '/ext-base.html', { rules: true, includeUserAgentRules: true })
  expect(withUa.states[0]!.rules!['@submit']!.some((d) => d.origin === 'user-agent')).toBe(true)
})

// ---------------------------------------------------------------------------
// Pseudo-states have their own cascade.
// ---------------------------------------------------------------------------

test('a :hover rule is invisible until the node is forced into :hover', async ({ page }) => {
  // The reason rules are captured per state rather than once: CSS.getMatchedStylesForNode
  // simply does not return `.btn:hover` for a node that is not hovered.
  const snapshot = await snap(page, '/hover-rules.html', { rules: true, states: ['hover'] })

  const resting = snapshot.states.find((s) => s.state === 'default')!.rules!['@a']!
  const hovered = snapshot.states.find((s) => s.state === 'hover')!.rules!['@a']!

  expect(resting.map((d) => d.selector)).not.toContain('.btn:hover')
  expect(hovered.map((d) => d.selector)).toContain('.btn:hover')

  // And the winning declaration under :hover is the one the browser actually used.
  const win = winner(hovered, 'background-color')
  expect(win!.selector).toBe('.btn:hover')
  const node = snapshot.states.find((s) => s.state === 'hover')!.nodes.find((n) => n.key === '@a')!
  expect(node.styles['background-color']).toBe(win!.value)
})

test('a hover regression is attributed to the hover rule, not the resting one', async ({
  page,
}) => {
  const before = await snap(page, '/hover-rules.html', { rules: true, states: ['hover'] })
  const after = await snap(page, '/hover-rules-changed.html', { rules: true, states: ['hover'] })
  const result = diff(before, after)

  const hover = result.attributions.find((a) => a.state === 'hover' && a.key === '@a')
  expect(hover).toBeDefined()

  // The diff detects `background-color`; the author wrote the `background`
  // shorthand, and that is what gets named.
  expect(result.changes.some((c) => c.kind === 'style' && c.property === 'background-color')).toBe(
    true,
  )
  const cause = hover!.causes.find((c) => c.property === 'background')!
  expect(cause.before!.selector).toBe('.btn:hover')
  expect(cause.after!.selector).toBe('.btn:hover')
  expect(cause.after!.value).toBe('rgb(9, 9, 9)')

  // The resting state is untouched, so it produces no attribution at all.
  expect(result.attributions.some((a) => a.state === 'default')).toBe(false)
})

test('a padding change under :hover is explained by the rule that set it', async ({ page }) => {
  const before = await snap(page, '/hover-layout.html', { rules: true, states: ['hover'] })
  const after = await snap(page, '/hover-layout-changed.html', { rules: true, states: ['hover'] })
  const result = diff(before, after)

  const hover = result.attributions.find((a) => a.state === 'hover' && a.key === '@a')!
  const cause = hover.causes.find((c) => c.property === 'padding')!
  expect(cause.before!.selector).toBe('.btn:hover')
  expect(cause.before!.shorthand).toBe('padding: 24px 16px')
  expect(cause.after!.shorthand).toBe('padding: 40px 16px')
})
