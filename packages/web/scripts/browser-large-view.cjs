/** Browser smoke/performance evidence. Requires an existing Playwright installation, no app dependency.
 * node browser-large-view.cjs <graph.json> <playwright-module-dir> <chromium.exe> [baseUrl] [output-dir]
 * Only /api/graph and read-only result requests are intercepted; the audited project is not modified.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const [graphPath, playwrightPath, executablePath, baseUrl = 'http://127.0.0.1:4871', outputDir = '.proofflow/browser'] = process.argv.slice(2);
if (!graphPath || !playwrightPath || !executablePath) throw new Error('Provide graph.json, Playwright module directory and Chromium executable');
const { chromium } = require(path.resolve(playwrightPath));

(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  const graphText = fs.readFileSync(graphPath, 'utf8');
  const graph = JSON.parse(graphText);
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    let resultRequests = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/graph', route => route.fulfill({ contentType: 'application/json', body: graphText }));
    await page.route('**/api/results?*', route => { resultRequests++; return route.fulfill({ contentType: 'application/json', body: '[]' }); });
    await page.addInitScript(() => {
      window.__pfLongTasks = [];
      new PerformanceObserver(list => { for (const e of list.getEntries()) window.__pfLongTasks.push(e.duration); }).observe({ type: 'longtask', buffered: true });
    });
    const started = Date.now();
    await page.goto(baseUrl);
    await page.locator('.pf-large-flow__notice').waitFor({ timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('.pf-large-flow__canvas')?.width > 0);
    const firstMapMs = Date.now() - started;
    assert.equal(await page.getByRole('button', { name: 'Whole project', exact: true }).first().getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByText(/This cone has/).count(), 0);
    const overview = await page.locator('.pf-large-flow__notice').innerText();
    const domNodes = await page.locator('*').count();
    const overviewCards = await page.locator('.pf-node').count();
    const overviewResultRequests = resultRequests;
    await page.screenshot({ path: path.join(outputDir, 'overview.png') });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.collectGarbage');
    const mainHeap = await cdp.send('Runtime.getHeapUsage');

    const target = graph.nodes.find(n => n.isLocal && !n.isAux && n.kind === 'theorem' && graph.stats.localSinks.includes(n.id)) || graph.nodes.find(n => n.isLocal && !n.isAux);
    const search = page.getByRole('combobox', { name: 'Search declarations to locate' });
    await search.fill(target.id);
    await page.getByRole('option').first().waitFor();
    await search.press('Enter');
    await page.getByLabel('Node details').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.pf-node').length > 0, { timeout: 10000 });
    assert.equal(await page.getByRole('button', { name: 'Whole project', exact: true }).first().getAttribute('aria-pressed'), 'true');
    const detailCards = await page.locator('.pf-node').count();
    assert.ok(detailCards <= 80, `detail card count ${detailCards}`);
    assert.ok((await page.getByLabel('Node details').innerText()).includes(target.id));
    await page.waitForFunction(id => {
      const el = [...document.querySelectorAll('.pf-node')].find(e => e.dataset.id === id);
      const flow = el?.closest('.react-flow__node');
      return flow && getComputedStyle(flow).visibility === 'visible';
    }, target.id);
    await page.waitForFunction(() => {
      const transform = document.querySelector('.react-flow__viewport')?.style.transform || '';
      return Number(/scale\(([^)]+)\)/.exec(transform)?.[1] || 0) >= 0.79;
    });
    await page.screenshot({ path: path.join(outputDir, 'detail.png') });
    await page.getByRole('button', { name: 'Show all edges', exact: true }).click();
    await page.getByText('All edges shown.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Simplify edges', exact: true }).click();
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    const pan = await page.locator('.pf-large-flow').boundingBox();
    await page.mouse.move(pan.x + pan.width / 2, pan.y + pan.height / 2);
    await page.mouse.down();
    const panStart = Date.now();
    await page.mouse.move(pan.x + pan.width / 2 + 120, pan.y + pan.height / 2 + 50, { steps: 20 });
    await page.mouse.up();
    const panWallMs = Date.now() - panStart;

    const expandStart = Date.now();
    await page.getByLabel('Hide aux', { exact: true }).uncheck();
    await page.getByRole('combobox', { name: /^External/ }).selectOption('expand');
    await page.waitForFunction(n => document.querySelector('.pf-large-flow__notice')?.textContent?.includes(n.toLocaleString() + ' nodes'), graph.stats.nodes, { timeout: 60000 });
    const expandedMs = Date.now() - expandStart;
    const expanded = await page.locator('.pf-large-flow__notice').innerText();
    await page.screenshot({ path: path.join(outputDir, 'expanded.png') });
    const preparationLongTasks = await page.evaluate(() => window.__pfLongTasks.splice(0));
    await page.getByRole('button', { name: 'Show all edges', exact: true }).click();
    await page.locator('[data-edge-state="drawing"]').waitFor();
    const cancelStart = Date.now();
    await page.getByRole('button', { name: 'Simplify edges', exact: true }).click();
    await page.locator('[data-edge-state="simplified"]').waitFor();
    const cancelAllEdgesMs = Date.now() - cancelStart;
    const allEdgesStart = Date.now();
    await page.getByRole('button', { name: 'Show all edges', exact: true }).click();
    await page.locator('[data-edge-state="complete"]').waitFor({ timeout: 60000 });
    const expandedAllEdgesMs = Date.now() - allEdgesStart;
    await page.getByRole('button', { name: 'Simplify edges', exact: true }).click();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(outputDir, 'expanded-dark.png') });
    const longTasks = await page.evaluate(() => window.__pfLongTasks);
    const report = { inputNodes: graph.stats.nodes, inputEdges: graph.stats.edges, firstMapMs, overview, domNodes, overviewCards, overviewResultRequests,
      mainThreadRetainedHeapMiB: Math.round(mainHeap.usedSize / 2 ** 20), selected: target.id, detailCards, panWallMs, expandedMs, expanded, expandedAllEdgesMs, cancelAllEdgesMs,
      preparationLongTasks: { count: preparationLongTasks.length, maxMs: Math.round(Math.max(0, ...preparationLongTasks)) },
      allEdgeLongTasks: { count: longTasks.length, maxMs: Math.round(Math.max(0, ...longTasks)) }, errors };
    fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
