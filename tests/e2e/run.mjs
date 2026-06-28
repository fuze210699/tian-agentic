// Browser-driven E2E check for Phases 1, 2, 3, 4, 5, 6, 9 of
// PLAN-agentation-parity.md, run against the demo app (demo/App.vue) with a
// real Chromium instance via the `playwright` package directly (no
// @playwright/test runner installed — this repo only has the core
// `playwright` library, so this is a plain script, not a test-runner suite).
//
// Run with: node tests/e2e/run.mjs   (from tian-agentic/, vite dev server
// is started programmatically below, no need to run `npm run dev` first)
//
// Note: demo/App.vue's sync-endpoint points at the shared dev backend on
// :4848 (same one a worker may already be running). Tests that exercise
// sync use the demo's own "tian-annotate-demo" session and clean up every
// annotation they create afterward via the HTTP API, so this never leaves
// stray data behind in that shared session.

import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`  ok   - ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${label}`);
  }
}

async function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms`);
}

async function main() {
  const devPort = 5179; // fixed, unlikely to collide with a manually-run `npm run dev` on 5173
  const viteProcess = spawn('npx', ['vite', '--port', String(devPort), '--strictPort'], {
    cwd: new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let viteLog = '';
  viteProcess.stdout.on('data', (d) => (viteLog += d.toString()));
  viteProcess.stderr.on('data', (d) => (viteLog += d.toString()));

  const baseUrl = `http://localhost:${devPort}`;
  try {
    await waitForServer(baseUrl);
  } catch (err) {
    console.error(viteLog);
    throw err;
  }
  console.log(`vite dev server up at ${baseUrl}`);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  await page.goto(baseUrl);
  await page.waitForSelector('.tian-annotate-toggle');

  // ---- Phase 6 (partial): session-created fires on mount whenever
  // syncEndpoint+syncSessionId are both set ----
  console.log('\nPhase 6 — session-created emit on mount');
  const events = await page.evaluate(() => window.__tianEvents);
  check(
    'session-created emitted for demo session on mount',
    events.some((e) => e.type === 'session-created' && e.payload === 'tian-annotate-demo')
  );

  // ---- Phase 1 — keyboard shortcuts ----
  console.log('\nPhase 1 — keyboard shortcuts');
  await page.keyboard.press('Control+Shift+F');
  await check2('Ctrl+Shift+F activates toolbar', page.locator('.tian-annotate-icon-bar'));

  const pauseBtn = page.locator('.tian-annotate-icon-btn[aria-label*="animations" i]');
  const pausedBefore = await pauseBtn.evaluate((el) => el.classList.contains('is-on'));
  await page.keyboard.press('p');
  const pausedAfter = await pauseBtn.evaluate((el) => el.classList.contains('is-on'));
  check('"p" toggles animation pause', pausedBefore !== pausedAfter);

  const hideBtn = page.locator('.tian-annotate-icon-btn[aria-label*="pins" i]');
  const hiddenBefore = await hideBtn.evaluate((el) => el.classList.contains('is-on'));
  await page.keyboard.press('h');
  const hiddenAfter = await hideBtn.evaluate((el) => el.classList.contains('is-on'));
  check('"h" toggles pin visibility', hiddenBefore !== hiddenAfter);
  await page.keyboard.press('h'); // restore

  // typing inside a real <input> on the page must not trigger shortcuts.
  // Use focus() directly rather than click() — the toolbar intercepts every
  // click on the page while active (that's how annotation picking works),
  // so a real click here would open a feedback popup instead of just
  // focusing the field.
  await page.locator('.text-input').evaluate((el) => el.focus());
  await page.keyboard.press('p');
  const pausedAfterTypingInInput = await pauseBtn.evaluate((el) => el.classList.contains('is-on'));
  check(
    'shortcuts disabled while focus is in a page <input>',
    pausedAfterTypingInInput === pausedAfter
  );
  // Defocus the <input> WITHOUT Escape (consumed by our own handler — closes
  // the toolbar when nothing else is open) and WITHOUT clicking elsewhere on
  // the page (the toolbar intercepts every click while active and would open
  // an annotation popup on whatever we clicked). A direct blur() sidesteps both.
  await page.locator('.text-input').evaluate((el) => el.blur());

  // ---- Phase 2 — smart element naming ----
  console.log('\nPhase 2 — smart element naming via text content');
  await page.locator('.submit-btn').hover();
  await page.waitForSelector('.tian-annotate-tag');
  await page.waitForFunction(() =>
    document.querySelector('.tian-annotate-tag')?.textContent?.includes('Submit')
  );
  const tagText = await page.locator('.tian-annotate-tag').innerText();
  check(
    `hover tag shows quoted button text (got: ${JSON.stringify(tagText)})`,
    tagText.includes('"Submit" button')
  );

  // ---- Phase 3 — accent color + block-interaction setting ----
  console.log('\nPhase 3 — accent color + block interaction on copy');
  const accentStyle = await page.locator('.tian-annotate-toolbar').getAttribute('style');
  check(
    `toolbar root has --tian-accent from prop (style: ${accentStyle})`,
    accentStyle.includes('#ef4444')
  );
  // Regression check for a real bug found in production (notexio): the var
  // must resolve on actual PAGE elements, not just be present in the
  // toolbar's own inline style. The toolbar renders as a sibling overlay,
  // not a wrapper — CSS custom properties don't cascade sideways, only down
  // to descendants, so this only works if the var is also set on a common
  // ancestor (documentElement in TianAnnotate.vue's onMounted).
  await page.locator('.submit-btn').hover();
  await page.waitForSelector('.tian-annotate-hover-outline');
  await page.waitForTimeout(150); // let the 80ms outline-color transition settle
  const outlineColor = await page
    .locator('.tian-annotate-hover-outline')
    .evaluate((el) => getComputedStyle(el).outlineColor);
  check(
    `hover outline on a PAGE element actually renders in accentColor, not just present in DOM (got: ${outlineColor})`,
    outlineColor === 'rgb(239, 68, 68)' // #ef4444
  );

  await page.locator('.tian-annotate-icon-btn[aria-label="Settings"]').click();
  await page.waitForSelector('.tian-annotate-panel');
  const colorVal = await page.locator('.tian-annotate-panel-color').inputValue();
  check(
    `settings color picker reflects accentColor prop (got: ${colorVal})`,
    colorVal.toLowerCase() === '#ef4444'
  );
  const blockChecked = await page.locator('.tian-annotate-panel-check').first().isChecked();
  check('block-interaction-on-copy checkbox reflects prop (true)', blockChecked === true);
  await page.locator('.tian-annotate-icon-btn[aria-label="Settings"]').click(); // close panel

  // ---- Phase 4 — Area mode (drag-select over empty space) ----
  console.log('\nPhase 4 — Area mode (drag over empty space)');
  const emptyArea = page.locator('.empty-area');
  const box = await emptyArea.boundingBox();
  await page.keyboard.down('Shift');
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 60, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForSelector('.tian-annotate-popup');
  await page.locator('.tian-annotate-popup textarea').fill('empty area e2e test');
  await page.locator('.tian-annotate-popup button:has-text("Add")').click();
  await page.waitForTimeout(150);
  let evts = await page.evaluate(() => window.__tianEvents);
  const areaAdd = evts.find((e) => e.type === 'annotation-add' && e.payload.kind === 'area');
  check('drag over empty space creates annotation with kind "area"', !!areaAdd);
  check(
    'area annotation carries area.rect',
    !!areaAdd && !!areaAdd.payload.area && !!areaAdd.payload.area.rect
  );

  // ---- Phase 5 — Shadow DOM ----
  console.log('\nPhase 5 — Shadow DOM support');
  // Playwright's locator engine pierces open shadow roots by default.
  await page.locator('.shadow-btn').hover();
  await page.waitForSelector('.tian-annotate-tag');
  const shadowTag = await page.locator('.tian-annotate-tag').innerText();
  check(
    `hover resolves an element inside the shadow root (got: ${JSON.stringify(shadowTag)})`,
    shadowTag.toLowerCase().includes('shadow') || shadowTag.includes('button')
  );
  await page.locator('.shadow-btn').click();
  await page.waitForSelector('.tian-annotate-popup');
  await page.locator('.tian-annotate-popup textarea').first().fill('shadow dom e2e test');
  await page.locator('.tian-annotate-popup button:has-text("Add")').click();
  await page.waitForTimeout(150);
  evts = await page.evaluate(() => window.__tianEvents);
  const shadowAdd = [...evts]
    .reverse()
    .find((e) => e.type === 'annotation-add' && e.payload.comment === 'shadow dom e2e test');
  check(
    'annotating an element inside shadow DOM succeeds with a non-empty elementPath',
    !!shadowAdd && !!shadowAdd.payload.elementPath
  );

  // ---- Phase 6 — remaining emits (copy / annotations-clear) ----
  console.log('\nPhase 6 — callback emits (copy, annotations-clear)');
  await page.locator('.tian-annotate-icon-btn[aria-label="Copy markdown"]').click();
  await page.waitForTimeout(50);
  evts = await page.evaluate(() => window.__tianEvents);
  check(
    '"copy" event emitted with markdown string',
    evts.some((e) => e.type === 'copy' && typeof e.payload === 'string' && e.payload.length > 0)
  );

  await page.locator('.tian-annotate-icon-btn[aria-label="Clear all annotations"]').click();
  await page.waitForTimeout(50);
  evts = await page.evaluate(() => window.__tianEvents);
  check(
    '"annotations-clear" event emitted',
    evts.some((e) => e.type === 'annotations-clear')
  );
  const remaining = await page.evaluate(
    () => document.querySelectorAll('.tian-annotate-pin').length
  );
  check('all pins removed from page after Clear all', remaining === 0);

  // ---- Phase 9 — component palette + wireframe ----
  console.log('\nPhase 9 — layout mode: component palette + wireframe');
  await page.keyboard.press('l'); // feedback -> placement
  await page.locator('.card__title').first().click();
  await page.waitForSelector('.tian-annotate-popup');
  const paletteInput = page.locator(
    '.tian-annotate-popup input[list="tian-annotate-component-palette"]'
  );
  check('placement popup input has datalist palette wired up', (await paletteInput.count()) === 1);
  const optionValues = await page
    .locator('#tian-annotate-component-palette option')
    .evaluateAll((opts) => opts.map((o) => o.value));
  check(
    `datalist includes "Button" (got ${optionValues.length} options)`,
    optionValues.includes('Button')
  );
  await paletteInput.fill('Button');
  await page.locator('.tian-annotate-popup textarea').fill('place a button here');
  await page.locator('.tian-annotate-popup button:has-text("Add")').click();
  await page.waitForTimeout(150);
  evts = await page.evaluate(() => window.__tianEvents);
  const placementAdd = [...evts]
    .reverse()
    .find((e) => e.type === 'annotation-add' && e.payload.kind === 'placement');
  check(
    'placement annotation created with componentType "Button"',
    !!placementAdd && placementAdd.payload.placement?.componentType === 'Button'
  );
  await page.keyboard.press('l'); // placement -> rearrange
  await page.keyboard.press('l'); // rearrange -> feedback

  await page.locator('.tian-annotate-icon-btn[aria-label="Settings"]').click();
  await page.waitForSelector('.tian-annotate-panel');
  const wireframeCheckbox = page
    .locator('.tian-annotate-panel-section', { hasText: 'Wireframe view' })
    .locator('input[type="checkbox"]');
  check(
    'wireframe toggle present in settings (layout mode enabled)',
    (await wireframeCheckbox.count()) === 1
  );
  await wireframeCheckbox.check();
  await page.waitForSelector('.tian-annotate-wireframe-overlay');
  const opacityBefore = await page
    .locator('.tian-annotate-wireframe-overlay')
    .evaluate((el) => getComputedStyle(el).opacity);
  const slider = page.locator('.tian-annotate-panel-range');
  await slider.fill('20');
  await page.waitForTimeout(50);
  const opacityAfter = await page
    .locator('.tian-annotate-wireframe-overlay')
    .evaluate((el) => getComputedStyle(el).opacity);
  check(
    `wireframe opacity slider updates overlay opacity (before: ${opacityBefore}, after: ${opacityAfter})`,
    opacityBefore !== opacityAfter
  );
  check(
    'wireframe grid overlay rendered',
    (await page.locator('.tian-annotate-wireframe-grid').count()) === 1
  );
  check(
    'wireframe top ruler has tick labels',
    (await page.locator('.tian-annotate-wireframe-tick-x').count()) > 0
  );
  check(
    'wireframe left ruler has tick labels',
    (await page.locator('.tian-annotate-wireframe-tick-y').count()) > 0
  );
  await wireframeCheckbox.uncheck();
  // Close the settings panel — focus is still on the checkbox we just
  // unchecked, and isEditableTarget() in TianAnnotate.vue blocks the "l"
  // mode-cycle shortcut while focus sits in any <input>/<select>/textarea,
  // which would otherwise silently no-op the keyboard.press('l') calls below.
  await page.locator('.tian-annotate-icon-btn[aria-label="Settings"]').click();

  // ---- Phase 9 (cont) — rearrange mode ghost clone + arrow ----
  console.log('\nPhase 9 (cont) — rearrange ghost clone + arrow');
  await page.keyboard.press('l'); // feedback -> placement
  await page.keyboard.press('l'); // placement -> rearrange
  const cardTitle = page.locator('.card__title').first();
  const ctBox = await cardTitle.boundingBox();
  const dragFromX = ctBox.x + ctBox.width / 2;
  const dragFromY = ctBox.y + ctBox.height / 2;
  const dragToX = dragFromX + 120;
  const dragToY = dragFromY + 60;
  await page.mouse.move(dragFromX, dragFromY);
  await page.mouse.down();
  await page.mouse.move(dragToX, dragToY, { steps: 10 });
  check(
    'ghost clone appears during rearrange drag',
    (await page.locator('.tian-annotate-rearrange-ghost').count()) === 1
  );
  check(
    'arrow appears during rearrange drag',
    (await page.locator('.tian-annotate-rearrange-arrow line').count()) === 1
  );
  const arrowX2 = await page
    .locator('.tian-annotate-rearrange-arrow line')
    .getAttribute('x2');
  check(
    `arrow tip near mouse position (x2: ${arrowX2}, expected ~${Math.round(dragToX)})`,
    Math.abs(Number(arrowX2) - dragToX) < 10
  );
  await page.mouse.up();
  await page.waitForSelector('.tian-annotate-popup');
  check(
    'ghost removed after mouse up',
    (await page.locator('.tian-annotate-rearrange-ghost').count()) === 0
  );
  check(
    'arrow still visible after mouse up (popup is open)',
    (await page.locator('.tian-annotate-rearrange-arrow line').count()) === 1
  );
  await page.locator('.tian-annotate-popup textarea').fill('rearrange ghost e2e test');
  await page.locator('.tian-annotate-popup button:has-text("Add")').click();
  await page.waitForTimeout(150);
  check(
    'arrow removed after confirm',
    (await page.locator('.tian-annotate-rearrange-arrow line').count()) === 0
  );

  // Cancel path: drag again, then press Esc
  await page.mouse.move(dragFromX, dragFromY);
  await page.mouse.down();
  await page.mouse.move(dragToX, dragToY, { steps: 10 });
  await page.mouse.up();
  await page.waitForSelector('.tian-annotate-popup');
  check(
    'arrow visible after second drag',
    (await page.locator('.tian-annotate-rearrange-arrow line').count()) === 1
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  check(
    'arrow removed after Escape cancel',
    (await page.locator('.tian-annotate-rearrange-arrow line').count()) === 0
  );
  check(
    'ghost removed after Escape cancel',
    (await page.locator('.tian-annotate-rearrange-ghost').count()) === 0
  );
  await page.keyboard.press('l'); // rearrange -> feedback (restore)
  console.log('\nCleanup — removing e2e-created annotations from shared backend session');
  try {
    const res = await fetch('http://localhost:4848/api/annotations?sessionId=tian-annotate-demo');
    if (res.ok) {
      const remote = await res.json();
      for (const a of remote) {
        if (typeof a.comment === 'string' && a.comment.includes('e2e test')) {
          await fetch(`http://localhost:4848/api/annotations/${a.id}`, { method: 'DELETE' });
        }
      }
      console.log(`  cleaned up annotations tagged "e2e test" from shared backend`);
    }
  } catch (err) {
    console.warn(`  cleanup skipped (backend unreachable): ${err.message}`);
  }

  check('no uncaught page errors during the run', consoleErrors.length === 0);
  if (consoleErrors.length) console.error(consoleErrors);

  await browser.close();
  viteProcess.kill();

  console.log(
    failures === 0 ? '\nAll frontend checks passed.\n' : `\n${failures} frontend check(s) failed.\n`
  );
  process.exit(failures === 0 ? 0 : 1);

  async function check2(label, locator) {
    const ok = await locator
      .first()
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    check(label, ok);
  }
}

main().catch((err) => {
  console.error('e2e run crashed:', err);
  process.exit(1);
});
