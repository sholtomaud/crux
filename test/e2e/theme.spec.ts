import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * test/e2e/theme.spec.ts — the light/dark cascade, verified in a real browser.
 *
 * The unit tests can only check that tokens.css *says* the right things. Whether
 * :root:not([data-theme="light"]) actually beats a dark OS setting is a question
 * about CSS resolution, and only a browser can answer it.
 *
 * Screenshots are captured as build artifacts, NOT pixel-diffed against
 * baselines. Local runs are arm64 and CI is amd64, and font rasterisation
 * differs enough between them that toHaveScreenshot would fail on architecture
 * rather than on regressions. The assertions below carry the actual signal;
 * the images are for human review.
 */

const SHOTS = join('test', 'e2e', 'screenshots');
mkdirSync(SHOTS, { recursive: true });

/** The value of --color-bg the browser has actually resolved. */
async function resolvedBg(page: Page): Promise<string> {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim()
  );
}

const LIGHT_BG = '#faf9f8';
const DARK_BG  = '#1b1a19';

/** Waits for the project list to arrive so screenshots never catch a spinner. */
async function gotoSettled(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
}

async function firstProjectId(page: Page): Promise<string> {
  const projects = await page.evaluate(async () => {
    const res = await fetch('/api/overview');
    return res.json();
  });
  expect(projects.length).toBeGreaterThan(0);
  return projects[0].id;
}

test.describe('theme cascade', () => {
  test('a dark OS setting with no stored choice resolves dark', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await gotoSettled(page, '/');
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-theme'))).toBe(false);
    expect(await resolvedBg(page)).toBe(DARK_BG);
  });

  test('a light OS setting with no stored choice resolves light', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await gotoSettled(page, '/');
    expect(await resolvedBg(page)).toBe(LIGHT_BG);
  });

  test('an explicit light choice beats a dark OS setting', async ({ page }) => {
    // This is what the :root:not([data-theme="light"]) guard exists for — without
    // it the media query would win and the user's choice would be ignored.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.addInitScript(() => localStorage.setItem('crux-theme', 'light'));
    await gotoSettled(page, '/');
    expect(await page.getAttribute('html', 'data-theme')).toBe('light');
    expect(await resolvedBg(page)).toBe(LIGHT_BG);
  });

  test('an explicit dark choice beats a light OS setting', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.addInitScript(() => localStorage.setItem('crux-theme', 'dark'));
    await gotoSettled(page, '/');
    expect(await page.getAttribute('html', 'data-theme')).toBe('dark');
    expect(await resolvedBg(page)).toBe(DARK_BG);
  });

  test('the toggle cycles system → light → dark and persists', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await gotoSettled(page, '/');
    const toggle = page.locator('[data-theme-toggle]');
    await expect(toggle).toBeVisible();

    await toggle.click();
    expect(await page.getAttribute('html', 'data-theme')).toBe('light');
    await toggle.click();
    expect(await page.getAttribute('html', 'data-theme')).toBe('dark');
    await toggle.click();
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-theme'))).toBe(false);

    // Survives a reload — the point of persisting it at all.
    await toggle.click();
    await page.reload();
    await page.waitForLoadState('networkidle');
    expect(await page.getAttribute('html', 'data-theme')).toBe('light');
  });

  test('theme-color follows the resolved theme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await gotoSettled(page, '/');
    expect(await page.getAttribute('meta[name="theme-color"]', 'content')).toBe(DARK_BG);

    await page.emulateMedia({ colorScheme: 'light' });
    await gotoSettled(page, '/');
    expect(await page.getAttribute('meta[name="theme-color"]', 'content')).toBe(LIGHT_BG);
  });

  test('graph.html is themed too, despite never loading app.js', async ({ page }) => {
    // It carried a private palette until the token purge; this is the regression.
    await page.emulateMedia({ colorScheme: 'dark' });
    const id = await (async () => { await gotoSettled(page, '/'); return firstProjectId(page); })();
    await gotoSettled(page, `/graph?id=${id}`);
    expect(await resolvedBg(page)).toBe(DARK_BG);
    await expect(page.locator('[data-theme-toggle]')).toBeVisible();
  });
});

test.describe('screenshots', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`capture every page in ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await gotoSettled(page, '/');
      const id = await firstProjectId(page);

      const pages: Array<[string, string]> = [
        ['portfolio', '/'],
        ['project',   `/project?id=${id}`],
        ['graph',     `/graph?id=${id}`],
        ['roi',       '/roi'],
        ['db',        '/db'],
      ];

      for (const [name, path] of pages) {
        await gotoSettled(page, path);
        // The graph lays out on a rAF after data arrives.
        await page.waitForTimeout(400);
        await page.screenshot({
          path: join(SHOTS, `${name}-${scheme}.png`),
          fullPage: name !== 'graph', // the graph is a fixed-height canvas
        });
      }
    });
  }
});
