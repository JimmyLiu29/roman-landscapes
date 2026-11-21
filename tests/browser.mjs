import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const types = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.html': 'text/html',
  '.json': 'application/json', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const profile = await mkdtemp(path.join(tmpdir(), 'regional-map-'));
const publicURL = process.argv[2];
let origin = publicURL;
let server, context;
const errors = new Set(), external = new Set();

async function serve() {
  server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(dist)) { res.writeHead(404).end(); return; }
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store' }).end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + server.address().port;
}

async function launch(width, offline = false) {
  context = await chromium.launchPersistentContext(profile, {
    headless: true, executablePath: process.env.CHROMIUM_PATH || undefined,
    viewport: { width, height: width === 390 ? 844 : 880 },
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  });
  await context.setOffline(offline);
  context.on('request', req => {
    if (/^https?:/.test(req.url()) && new URL(req.url()).origin !== new URL(origin).origin) external.add(req.url());
  });
  const page = context.pages()[0];
  page.on('pageerror', e => errors.add(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.add(m.text()); });
  await page.goto(origin);
  await page.locator('#map[data-ready=true]').waitFor({ timeout: 60000 });
  assert.equal(await page.locator('#map-error').isVisible(), false);
  return page;
}

async function layout(page, width) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
  assert.equal(await page.locator('h1').innerText(), 'Roman Landscapes');
  assert.equal(await page.locator('input[type="search"],input[type="checkbox"]').count(), 0);
  assert.equal(await page.locator('#credits a').count(), 4);
  const box = await page.locator('canvas.maplibregl-canvas').boundingBox();
  assert.ok(box.width >= 300 && box.height >= 200);
}

async function controls(page) {
  const reset = page.locator('#reset'), coordinates = page.locator('#coordinates');
  await reset.click();
  const home = await coordinates.textContent();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.waitForTimeout(550);
  const map = page.locator('#map canvas');
  const box = await map.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 35, y - 25, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(700);
  const view = await coordinates.textContent();
  assert.notEqual(view, home);
  const natural = await map.screenshot();
  await page.locator('[value=simple]').check();
  await page.waitForTimeout(350);
  assert.notDeepEqual(natural, await map.screenshot());
  assert.equal(await page.locator('[data-natural]').first().isVisible(), false);
  assert.equal(await coordinates.textContent(), view);
  await page.locator('[value=natural]').check();
  assert.equal(await coordinates.textContent(), view);
  await reset.click();
  assert.equal(await coordinates.textContent(), home);
}

try {
  if (!publicURL) await serve();
  let page = await launch(1440);
  await layout(page, 1440);
  await controls(page);
  if (process.env.ATLAS_SCREENSHOT) await page.screenshot({ path: process.env.ATLAS_SCREENSHOT });
  if (!publicURL) {
    await page.setViewportSize({ width: 390, height: 844 });
    await layout(page, 390);
    await controls(page);
    await page.locator('#download').click();
    await page.getByText('Both maps are verified and ready offline.', { exact: true }).waitFor();
    await context.close();
    await new Promise(resolve => server.close(resolve));
    server = null;
    page = await launch(390, true);
    await layout(page, 390);
    await controls(page);
    await page.getByRole('button', { name: 'Verify saved maps' }).click();
    await page.getByText('All saved map files passed SHA-256 verification.').waitFor();
    await page.locator('#remove').click();
    await page.getByText('Saved maps removed from this browser.').waitFor();
    const count = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle('atlas-packages');
      let entries = 0;
      for await (const _ of directory.values()) entries++;
      return entries;
    });
    assert.equal(count, 0);
  }
  assert.deepEqual([...external], []);
  assert.deepEqual([...errors], []);
  console.log(JSON.stringify({ site: origin, desktop: 'pass', narrow: publicURL ? undefined : 'pass',
    offlineBrowserRestartWithServerStopped: publicURL ? undefined : 'pass', externalRequests: 0, errors: 0 }));
} finally {
  await context?.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
