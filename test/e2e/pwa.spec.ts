import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:8765';

test('index page loads with crux title', async ({ page }) => {
  await page.goto(BASE);
  await expect(page).toHaveTitle(/crux/);
});

test('manifest.json returns correct content-type', async ({ request }) => {
  const res = await request.get(`${BASE}/manifest.json`);
  expect(res.ok()).toBeTruthy();
  expect(res.headers()['content-type']).toContain('manifest+json');
});

test('service worker registers successfully', async ({ page }) => {
  await page.goto(BASE);
  const registered = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.ready;
    return !!reg.active || !!reg.installing || !!reg.waiting;
  });
  expect(registered).toBe(true);
});
