import { type Page, expect, test } from '@playwright/test'
import { type CdpSession, capture } from '@qain/core'

// `capture({ frameUrl })` snapshots a nested frame instead of the top document.
// This is the whole basis for running qain inside @vitest/browser, which mounts
// every test in an iframe: without it, capture sees the host, not the component.

async function cdpOf(page: Page): Promise<CdpSession> {
  return (await page.context().newCDPSession(page)) as unknown as CdpSession
}

async function loadHost(page: Page): Promise<string> {
  await page.goto('/frame-host.html')
  // The child frame must be rendered before the snapshot, or its document is empty.
  await page.frameLocator('iframe').locator('[data-testid=pay]').waitFor()
  return new URL('frame-child.html', page.url()).href
}

test('default capture stops at the iframe boundary', async ({ page }) => {
  await loadHost(page)
  const snapshot = await capture(await cdpOf(page))

  const testids = snapshot.states[0]!.nodes.map((n) => n.attrs['data-testid'])
  expect(testids).toContain('host-marker')
  // The component lives in the child document, which the top-level snapshot omits.
  expect(testids).not.toContain('pay')
  expect(snapshot.states[0]!.nodes.some((n) => n.tag === 'iframe')).toBe(true)
})

test('frameUrl scopes the capture to the iframe component', async ({ page }) => {
  const frameUrl = await loadHost(page)
  const snapshot = await capture(await cdpOf(page), { frameUrl })

  expect(snapshot.url).toBe(frameUrl)

  const pay = snapshot.states[0]!.nodes.find((n) => n.attrs['data-testid'] === 'pay')
  expect(pay).toBeDefined()
  expect(pay!.box).not.toBeNull()
  expect(pay!.styles['background-color']).toBe('rgb(37, 99, 235)')

  // Nothing from the host document leaks into a frame-scoped capture.
  expect(snapshot.states[0]!.nodes.some((n) => n.attrs['data-testid'] === 'host-marker')).toBe(
    false,
  )
})

test('rules and pseudo-states pierce the frame boundary', async ({ page }) => {
  const frameUrl = await loadHost(page)
  const snapshot = await capture(await cdpOf(page), {
    frameUrl,
    rules: true,
    states: ['hover'],
  })

  // pushNodesByBackendIds + getMatchedStylesForNode reached the framed node.
  const pay = snapshot.states
    .find((s) => s.state === 'default')!
    .nodes.find((n) => n.attrs['data-testid'] === 'pay')!
  expect(snapshot.states.find((s) => s.state === 'default')!.rules![pay.key]).toBeDefined()

  // forcePseudoState reached it too: the hovered background is the :hover value.
  const hover = snapshot.states.find((s) => s.state === 'hover')
  expect(hover).toBeDefined()
  const hoverPay = hover!.nodes.find((n) => n.attrs['data-testid'] === 'pay')
  expect(hoverPay).toBeDefined()
  expect(hoverPay!.styles['background-color']).toBe('rgb(29, 78, 216)')
})
