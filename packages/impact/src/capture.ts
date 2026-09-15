import { type CdpSession, capture, type Snapshot } from '@qain/core'
import { type Browser, chromium } from 'playwright-core'
import { targetUrl } from './config.js'
import type { ImpactConfig, TargetConfig } from './types.js'

/** Opens one Chromium for the whole run and always closes it. */
export async function withBrowser<T>(
  config: ImpactConfig,
  fn: (browser: Browser) => Promise<T>,
): Promise<T> {
  const browser = await chromium.launch({
    headless: true,
    ...(config.browser ? { executablePath: config.browser } : {}),
  })
  try {
    return await fn(browser)
  } finally {
    await browser.close()
  }
}

/**
 * Captures one target.
 *
 * Rules and replay are both on, unconditionally. Rules cost a CDP round-trip per
 * node, which is why `qain snap` leaves them opt-in — but a report that cannot name
 * the library behind a change is the one thing this command exists to avoid, and
 * replay data is what lets the screenshots be rendered later without the app.
 */
export async function captureTarget(
  browser: Browser,
  target: TargetConfig,
  config: ImpactConfig,
): Promise<{ url: string; snapshot: Snapshot }> {
  const url = targetUrl(target, config.baseUrl)
  const viewport = target.viewport ?? config.viewport
  const page = await browser.newPage({ viewport })
  try {
    await page.goto(url, { waitUntil: 'load' })
    if (target.waitFor) await page.waitForSelector(target.waitFor)
    // Webfonts swap in after load and change every font-family in the snapshot.
    await page.evaluate(() => document.fonts.ready)
    if (target.wait) await page.waitForTimeout(target.wait)

    const cdp = (await page.context().newCDPSession(page)) as unknown as CdpSession
    const snapshot = await capture(cdp, {
      ...(target.selector ? { selector: target.selector } : {}),
      states: target.states ?? config.states,
      rules: true,
      replay: true,
    })
    return { url, snapshot }
  } finally {
    await page.close()
  }
}
