import { test, expect, type Page } from '@playwright/test';

/**
 * test/e2e/graph.spec.ts — status colour-coding and the task detail panel.
 *
 * Both features are only real in a browser. The unit tests can assert that
 * tokens.css defines --color-status-done and that the PATCH handler writes the
 * row, but whether the node actually paints green — after the theme cascade,
 * the class hierarchy and the crit rules have all had their say — is a question
 * about CSS resolution, and only a browser answers it.
 */

async function gotoSettled(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300); // the graph lays out on a rAF after data arrives
}

async function graphFor(page: Page, projectName = 'Atlas Platform'): Promise<string> {
  await page.goto('/');
  const projects = await page.evaluate(async () => (await fetch('/api/overview')).json());
  const project = projects.find((p: { name: string }) => p.name === projectName);
  expect(project, `fixture project ${projectName} is missing`).toBeTruthy();
  await gotoSettled(page, `/graph?id=${project.id}`);
  return project.id;
}

/** The stroke the browser actually resolved for a node, as an rgb() string. */
const strokeOf = (page: Page, slugPrefix: string) =>
  page.evaluate((prefix) => {
    const node = [...document.querySelectorAll('.node')]
      .find(n => n.querySelector('.node-slug')?.textContent?.includes(prefix));
    const bg = node?.querySelector('.node-bg');
    return bg ? getComputedStyle(bg).stroke : null;
  }, slugPrefix);

/** The same token resolved off :root, so the comparison is not a hardcoded hex. */
const tokenValue = (page: Page, token: string) =>
  page.evaluate((t) => {
    const probe = document.createElement('div');
    probe.style.color = `var(${t})`;
    document.body.appendChild(probe);
    const v = getComputedStyle(probe).color;
    probe.remove();
    return v;
  }, token);

test.describe('status colour-coding', () => {
  test('every node carries a class matching its task status', async ({ page }) => {
    await graphFor(page);
    const mismatches = await page.evaluate(async () => {
      const id = new URLSearchParams(location.search).get('id');
      const { tasks } = await (await fetch(`/api/project/${id}`)).json();
      const out: string[] = [];
      for (const t of tasks) {
        const node = document.querySelector(`.node[data-id="${t.id}"]`);
        if (!node) { out.push(`${t.slug}: no node`); continue; }
        if (!node.classList.contains(`status-${t.status}`)) out.push(`${t.slug}: expected status-${t.status}`);
      }
      return out;
    });
    expect(mismatches).toEqual([]);
  });

  test('the outline resolves to the status token, per status', async ({ page }) => {
    await graphFor(page);
    for (const [slug, token] of [
      ['f0-repo',   '--color-status-done'],
      ['a2-jwt',    '--color-status-in-progress'],
      ['a2-rbac',   '--color-status-blocked'],
      ['r3-tasks',  '--color-status-todo'],
      ['x6-soap',   '--color-status-dropped'],
    ] as const) {
      expect(await strokeOf(page, slug), `${slug} should paint ${token}`)
        .toBe(await tokenValue(page, token));
    }
  });

  test('a critical node keeps its status outline and gains the red accent bar', async ({ page }) => {
    // The regression this guards: `.node.crit .node-bg { stroke: danger }` used
    // to overwrite status on exactly the nodes you most need to read.
    await graphFor(page);
    const crit = page.locator('.node.crit').first();
    await expect(crit).toBeAttached();
    await expect(crit.locator('.node-accent')).toBeAttached();

    const [stroke, danger] = await Promise.all([
      crit.locator('.node-bg').evaluate(el => getComputedStyle(el).stroke),
      tokenValue(page, '--color-danger'),
    ]);
    const status = await crit.evaluate(el => [...el.classList].find(c => c.startsWith('status-')));
    expect(stroke).toBe(await tokenValue(page, `--color-${status}`));
    expect(stroke, 'the outline must no longer be the critical red').not.toBe(danger);
  });

  test('dropped is distinguishable without relying on colour', async ({ page }) => {
    await graphFor(page);
    const dash = await page.locator('.node.status-dropped .node-bg').first()
      .evaluate(el => getComputedStyle(el).strokeDasharray);
    expect(dash === 'none' || dash === '').toBe(false);
  });

  test('the legend explains the encoding it actually uses', async ({ page }) => {
    await graphFor(page);
    await expect(page.locator('.legend .lbox.status-done')).toBeVisible();
    await expect(page.locator('.legend .lbar')).toBeVisible();
    await expect(page.locator('.legend')).toContainText('Critical path (left bar)');
  });
});

test.describe('task detail panel', () => {
  test('clicking a node opens the panel populated from the task', async ({ page }) => {
    await graphFor(page);
    await page.locator('.node[data-id]').first().click();

    const panel = page.locator('#task-panel');
    await expect(panel).toBeVisible();

    const slug = await page.locator('#task-panel-slug').textContent();
    const task = await page.evaluate(async (s) => {
      const id = new URLSearchParams(location.search).get('id');
      const { tasks } = await (await fetch(`/api/project/${id}`)).json();
      return tasks.find((t: { slug: string }) => t.slug === s);
    }, slug);

    await expect(page.locator('#tp-title')).toHaveValue(task.title);
    await expect(page.locator('#tp-status')).toHaveValue(task.status);
    await expect(panel).toContainText('Schedule');
    await expect(panel).toContainText('Dependencies');
  });

  test('the clicked node is marked as the panel subject', async ({ page }) => {
    await graphFor(page);
    const node = page.locator('.node[data-id]').first();
    await node.click();
    await expect(node).toHaveClass(/tp-selected/);
  });

  test('Save stays disabled until something actually changes', async ({ page }) => {
    await graphFor(page);
    await page.locator('.node[data-id]').first().click();
    const save = page.locator('#task-panel-save');
    await expect(save).toBeDisabled();

    await page.locator('#tp-title').fill('Edited in a test');
    await expect(save).toBeEnabled();
  });

  test('editing round-trips through PATCH and repaints the node', async ({ page }) => {
    await graphFor(page);
    // a2-jwt is in-progress in the fixture; moving it to done must recolour it.
    const node = page.locator('.node').filter({ hasText: 'a2-jwt' }).first();
    await node.click();

    const before = await strokeOf(page, 'a2-jwt');
    await page.locator('#tp-status').selectOption('done');
    await page.locator('#task-panel-save').click();
    await expect(page.locator('#task-panel-msg')).toContainText(/Saved/);

    const after = await strokeOf(page, 'a2-jwt');
    expect(after).not.toBe(before);
    expect(after).toBe(await tokenValue(page, '--color-status-done'));

    // The write reached the database, not just the DOM.
    const persisted = await page.evaluate(async () => {
      const id = new URLSearchParams(location.search).get('id');
      const { tasks } = await (await fetch(`/api/project/${id}`)).json();
      return tasks.find((t: { slug: string }) => t.slug === 'a2-jwt').status;
    });
    expect(persisted).toBe('done');

    // Put the fixture back so the screenshot pass and any later test see the
    // status set the seed script intended.
    await page.locator('#tp-status').selectOption('in-progress');
    await page.locator('#task-panel-save').click();
    await expect(page.locator('#task-panel-msg')).toContainText(/Saved/);
  });

  test('a rejected value is reported against its field and keeps the edit', async ({ page }) => {
    await graphFor(page);
    await page.locator('.node[data-id]').first().click();
    // The number input will not accept letters, so send an out-of-range value.
    await page.locator('#tp-priority').fill('9999');
    await page.locator('#task-panel-save').click();

    await expect(page.locator('#task-panel-msg')).toContainText('priority');
    await expect(page.locator('#tp-priority')).toHaveValue('9999');
    await expect(page.locator('#tp-priority')).toHaveClass(/tp-invalid/);
  });

  test('pinning gives the panel a column and unpinning returns it to an overlay', async ({ page }) => {
    await graphFor(page);
    await page.locator('.node[data-id]').first().click();

    const pin = page.locator('#task-panel-pin');
    const positionOf = () => page.locator('#task-panel').evaluate(el => getComputedStyle(el).position);

    expect(await positionOf()).toBe('fixed');
    await pin.click();
    await expect(page.locator('body')).toHaveClass(/task-panel-pinned/);
    expect(await positionOf()).not.toBe('fixed');

    // Pinning must survive a reload — that is the point of persisting it.
    await gotoSettled(page, page.url());
    await page.locator('.node[data-id]').first().click();
    await expect(page.locator('body')).toHaveClass(/task-panel-pinned/);

    await page.locator('#task-panel-pin').click();
    await expect(page.locator('body')).not.toHaveClass(/task-panel-pinned/);
  });

  test('Escape closes the overlay but leaves a pinned panel alone', async ({ page }) => {
    await graphFor(page);
    await page.locator('.node[data-id]').first().click();
    await page.keyboard.press('Escape');
    await expect(page.locator('#task-panel')).toBeHidden();

    await page.locator('.node[data-id]').first().click();
    await page.locator('#task-panel-pin').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('#task-panel')).toBeVisible();
    await page.locator('#task-panel-pin').click();
  });

  test('the page never scrolls horizontally with the panel pinned', async ({ page }) => {
    await graphFor(page);
    await page.locator('.node[data-id]').first().click();
    await page.locator('#task-panel-pin').click();
    await page.waitForTimeout(200);

    const overflows = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(overflows).toBe(false);
    await page.locator('#task-panel-pin').click();
  });
});

test.describe('panel screenshots', () => {
  // Build artifacts for human review, same contract as theme.spec.ts: the
  // assertions elsewhere carry the signal, these carry the look.
  for (const scheme of ['light', 'dark'] as const) {
    test(`the panel in ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await graphFor(page);
      await page.locator('.node').filter({ hasText: 'a2-jwt' }).first().click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `test/e2e/screenshots/panel-overlay-${scheme}.png` });

      await page.locator('#task-panel-pin').click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `test/e2e/screenshots/panel-pinned-${scheme}.png` });
      await page.locator('#task-panel-pin').click();
    });
  }
});

test.describe('kanban board shares the panel', () => {
  test('clicking a card opens the same editor', async ({ page }) => {
    await page.goto('/');
    const projects = await page.evaluate(async () => (await fetch('/api/overview')).json());
    const atlas = projects.find((p: { name: string }) => p.name === 'Atlas Platform');
    await gotoSettled(page, `/project?id=${atlas.id}`);

    await page.locator('.task-card').first().click();
    await expect(page.locator('#task-panel')).toBeVisible();
    await expect(page.locator('#tp-title')).toBeVisible();
    await expect(page.locator('.task-card').first()).toHaveClass(/tp-selected/);
  });
});
