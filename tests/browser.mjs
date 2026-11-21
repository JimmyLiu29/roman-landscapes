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
  await page.locator('#foundation-controls').waitFor();
  assert.deepEqual(await page.locator('#atlas-layers label').allTextContents(),
    [' Settlements (1,388)',' Terrestrial roads (14,769)',' Maritime routes (584 routes · 294 ports)']);
  assert.equal(await page.locator('#credits a').count(), 8);
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

async function guide(page,width) {
  const dialog=page.locator('#guide-dialog');
  for (const [key,chapters] of [['datasets',5],['methods',2]]) {
    const button=page.locator('[data-guide="'+key+'"]');
    await button.click();
    const article=dialog.locator('article:visible');
    const links=article.locator('nav a');
    assert.equal(await links.count(),chapters);
    assert.equal(await article.locator('.guide-text h3').count(),chapters);
    const box=await dialog.boundingBox();
    assert(width===390 ? box.width===390 : box.width>=760 && box.width<=840);
    assert(await dialog.evaluate(d=>d.scrollWidth===d.clientWidth));
    for (const link of await links.all()) {
      await link.click();
      assert.equal('#'+await page.evaluate(()=>document.activeElement.id),await link.getAttribute('href'));
    }
    if (key==='datasets') await page.keyboard.press('Escape');
    else await dialog.locator('#guide-close').click();
    assert.equal(await dialog.isVisible(),false);
    assert(await button.evaluate(b=>b===document.activeElement));
    (proof.guideChapters ??= {})[key]=chapters;
  }
}

async function interactions(page) {
  // Observe the map instance through its public API for this browser test only.
  await page.evaluate(async()=>{
    const {Map:GLMap}=await import('/vendor/maplibre-gl/maplibre-gl.mjs');
    const original=GLMap.prototype.setLayoutProperty;
    GLMap.prototype.setLayoutProperty=function(...args){
      GLMap.prototype.setLayoutProperty=original;
      window.testMap=this;
      return original.apply(this,args);
    };
  });
  const groups=['settlements','roads','maritime'];
  const toggle=g=>page.locator('[data-layer="'+g+'"]');
  for (let mask=0; mask<8; mask++) {
    for (const [i,g] of groups.entries()) await toggle(g).setChecked(Boolean(mask&(1<<i)));
    const shown=await page.evaluate(()=>{
      const visibility=id=>window.testMap.getLayoutProperty(id,'visibility')==='visible';
      return ['settlements','roads','roads-tentative','maritime','ports'].map(visibility);
    });
    const [towns,roads,sea]=groups.map((_,i)=>Boolean(mask&(1<<i)));
    assert.deepEqual(shown,[towns,roads,roads,sea,sea]);
    assert.deepEqual(await page.locator('.legend-group').evaluateAll(gs=>gs.map(g=>
      getComputedStyle(g).display!=='none')), [towns,roads,sea]);
  }
  const style=await page.evaluate(()=>{
    const m=window.testMap;
    return {roads:m.getPaintProperty('roads','line-width'),color:m.getPaintProperty('roads','line-color'),
      tentative:m.getPaintProperty('roads-tentative','line-dasharray'),maritime:m.getPaintProperty('maritime','line-dasharray'),
      filter:m.getFilter('roads-tentative')};
  });
  assert(style.roads.includes('Certain') && style.roads[3]>style.roads[4] && style.color[3]!==style.color[4]);
  assert(style.tentative.length && style.maritime.length && JSON.stringify(style.filter).includes('Hypothetical') && JSON.stringify(style.filter).includes('ferry'));
  const loaded=id=>page.locator('#record-panel[data-loaded="'+id+'"]').waitFor();
  const open=async id=>{
    await page.locator('#search').fill(id);
    await page.locator('#search-results button[data-record="'+id+'"]').click();
    await loaded(id);
  };
  const waitForLayer=async id=>{
    await page.waitForFunction(id=>window.testMap.loaded() &&
      window.testMap.queryRenderedFeatures({layers:[id]}).length>0,id);
  };
  const selection=()=>page.evaluate(async()=>await window.testMap.getSource('selected-record').getData());
  const geometries={};
  for (const [id,type,group] of [
    ['hanson:Hanson2016_992','Point','settlements'],['itinere:17122148:0','LineString','roads'],
    ['orbis:route:987571','MultiLineString','maritime'],['pleiades:423025','Point',null]]) {
    await open(id);
    assert.equal((await selection()).geometry.type,type);
    await waitForLayer(type==='Point'?'selected-point':'selected-line');
    if(group) {
      await toggle(group).uncheck();
      assert.deepEqual((await selection()).features,[]);
      await toggle(group).check();
      assert.equal((await selection()).properties.id,id);
    } else {
      for(const g of groups) await toggle(g).uncheck();
      assert.equal((await selection()).properties.id,id);
      await waitForLayer('selected-point');
      for(const g of groups) await toggle(g).check();
    }
    geometries[id]=type;
  }
  const roma='hanson:Hanson2016_992';
  await open(roma);
  await waitForLayer('settlements');
  const location=await page.evaluate(()=>{
    const {x,y}=window.testMap.project([12.485098,41.892777]);return {x,y};
  });
  await page.locator('#map canvas').click({position:location});
  const choices=page.locator('#overlap-records button');
  await choices.first().waitFor();
  const ids=await choices.evaluateAll(bs=>bs.map(b=>b.dataset.record));
  assert.equal(new Set(ids).size,ids.length);
  assert(ids.length>1 && ids[0]===roma);
  assert.equal(await page.locator('#overlap-count').textContent(),ids.length+' overlapping records at this location');
  assert((await choices.locator('small').allTextContents()).every(s=>s.split(' · ').every(Boolean)));
  await loaded(ids[0]);await choices.nth(1).click();await loaded(ids[1]);
  const camera=()=>page.evaluate(()=>[...window.testMap.getCenter().toArray(),window.testMap.getZoom()]);
  const before=await camera(), highlight=await selection();
  for(const mode of ['simple','natural']){
    await page.locator('[value='+mode+']').check();
    assert.deepEqual(await camera(),before);
    assert.deepEqual(await selection(),highlight);
    assert.deepEqual(await choices.evaluateAll(bs=>bs.map(b=>b.dataset.record)),ids);
    assert.equal(await choices.nth(1).getAttribute('aria-pressed'),'true');await loaded(ids[1]);
  }
  await toggle('maritime').uncheck();
  await page.locator('[value=simple]').check();
  await page.waitForFunction(async()=>{const {readState}=await import('/storage.js');
    return (await readState('layers')).maritime===false && (await readState('mode'))==='simple';});
  await page.reload();await page.locator('#foundation-controls').waitFor();
  assert(await toggle('settlements').isChecked() && await toggle('roads').isChecked());
  assert.equal(await toggle('maritime').isChecked(),false);
  assert(await page.locator('[value=simple]').isChecked());
  await toggle('maritime').check();await page.locator('[value=natural]').check();
  Object.assign(proof,{layerCombinations:8,overlapAtRoma:ids,selectedFromPicker:ids[1],
    cameraUnchanged:before,highlightGeometry:geometries,style,indexedDBReload:'pass'});
}

const proof={};
async function foundation(page,full) {
  await page.locator('#foundation-controls').waitFor();
  const search=page.locator('#search'), body=page.locator('#record-content');
  const loaded=id=>page.locator('#record-panel[data-loaded="'+id+'"]').waitFor();
  async function open(id) {
    await search.fill(id);
    await page.locator('#search-results button[data-record="'+id+'"]').click();
    await loaded(id);
  }
  for (const query of ['Roma','Rhome']) {
    await search.fill(query);
    const ids=await page.locator('#search-results button').evaluateAll(bs=>bs.slice(0,2).map(b=>b.dataset.record));
    assert.deepEqual(ids,['hanson:Hanson2016_992','pleiades:423025']);proof[query]=ids;
  }
  await search.fill('تل ابو شيجة');
  await page.locator('#search-results button[data-record="pleiades:108542249"]').click();
  await loaded('pleiades:108542249');
  if (!full) return;
  for(const box of await page.locator('#atlas-layers input').all()){await box.uncheck();await box.check();}
  await page.locator('#search-source').selectOption('pleiades');
  await search.fill('Roma');
  assert.equal(await page.locator('#search-results button').first().getAttribute('data-record'),'pleiades:423025');
  await page.locator('#search-source').selectOption('');
  proof.catalogSearch=await page.evaluate(async()=>{
    const {searchIndex}=await import('/search.js');
    const release=await (await fetch('/release.json')).json();
    const file=release.files.find(f=>f.path.endsWith('/catalog.json.gz'));
    const response=await fetch('/'+file.path);
    const {records}=await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
    const index=searchIndex(records);
    let total=0,misses=0;
    for(const record of records) {
      for(const name of [record.label,...(record.aliases||[])]) {
        const query=name.normalize('NFD').replace(/\p{M}/gu,'');
        let found=false;
        for (const hit of index.search(query)) {
          if (hit.tier>2) break;
          if (hit.record.id===record.id) {found=true;break;}
        }
        total++;if (!found) misses++;
      }
    }
    return {records:records.length,total,misses};
  });
  assert.deepEqual(proof.catalogSearch,{records:49711,total:92326,misses:0});
  await open('hanson:Hanson2016_992');
  for (const layer of ['maritime','roads']) await page.locator('[data-layer="'+layer+'"]').uncheck();
  await page.locator('#close-record').click();
  const canvas=page.locator('#map canvas');
  await canvas.click();
  await loaded('hanson:Hanson2016_992');
  proof.mapClick='hanson:Hanson2016_992';
  for (const layer of ['maritime','roads']) await page.locator('[data-layer="'+layer+'"]').check();
  await open('hanson:Hanson2016_1');
  await body.getByRole('button',{name:'BNP',exact:true}).click();
  await loaded('hanson:bibliography');
  assert.equal(await page.locator('.selected-reference').getAttribute('id'),'reference-18');
  await open('hanson:unmatched');assert.match(await body.innerText(),/Agora\?/);
  for(const fid of ['14767','14768']){
    await open('itinere:17122148:'+fid);
    await body.getByRole('button',{name:'Open field definitions'}).click();
    await loaded('itinere:fields');
    assert.equal(await body.locator('table tr').count(),16);
    assert.equal(await body.locator('table td,table th').count(),64);
  }
  await open('itinere:17122148:14768');
  await body.getByRole('button',{name:'Open source bibliography'}).click();
  await loaded('itinere:bibliography');
  assert.equal(await body.locator('[data-citation]').count(),627);
  await body.getByRole('searchbox').fill('petrovic_locating_2008');
  assert.equal(await body.locator('[data-citation]').count(),1);
  await body.locator('.original-source summary').click();
  const raw=await body.locator('pre').textContent();
  const bytes=new TextEncoder().encode(raw);
  assert.equal(bytes.length,248702);
  assert.equal(Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex'),'8c819a8238664666042b1f538dc319f364f13358715322b40d29bac21ec3b0a7');
  for(const node of ['50457','50522','50572','50786','50789','50790','50792']){
    const id='orbis:place:'+node;
    await open(id);assert.match(await body.innerText(),/Unlocated/);
    await body.getByRole('button').first().click();
    await page.locator('#record-panel[data-loaded^="orbis:route:"]').waitFor();
    await body.getByRole('button',{name:new RegExp(node)}).first().click();await loaded(id);
  }
  await open('pleiades:97294452');
  const duplicate=await body.locator('[data-name-key^="97294452/kerameikos/"]').evaluateAll(ns=>ns.map(n=>n.dataset.nameKey));
  assert.equal(new Set(duplicate).size,2);
  await open('pleiades:172198383');await body.getByText('Unspecified',{exact:true}).waitFor({state:'attached'});
  await body.locator('.original-source summary').click();assert.match(await body.locator('pre').textContent(),/"name_type": "undefined"/);
  await open('pleiades:139216315');
  assert(!/mso-|<style|&amp;/.test(await body.innerText()));
  await page.locator('#close-record').click();
  await search.fill('');await page.locator('#reset').click();
  Object.assign(proof,{maritimeReverseLinks:7,ferries:2,citationRedirect:18,docxCells:64,rawBibBytes:bytes.length,distinctKerameikosRows:duplicate.length});
}

try {
  if (!publicURL) await serve();
  let page = await launch(1440);
  await layout(page, 1440);
  await foundation(page,true);
  await interactions(page);
  await guide(page,1440);
  await controls(page);
  if (process.env.ATLAS_SCREENSHOT) await page.screenshot({ path: process.env.ATLAS_SCREENSHOT });
  {
    await page.setViewportSize({ width: 390, height: 844 });
    await layout(page, 390);
    await guide(page,390);
    await controls(page);
  }
  if (!publicURL) {
    await page.locator('#download').click();
    await page.getByText('Both maps are verified and ready offline.', { exact: true }).waitFor();
    await context.close();
    await new Promise(resolve => server.close(resolve));
    server = null;
    page = await launch(390, true);
    await layout(page, 390);
    await guide(page,390);
    await foundation(page,false);
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
  console.log(JSON.stringify({ site: origin, chromium:context.browser()?.version(), desktop: 'pass', narrow: 'pass',
    offlineBrowserRestartWithServerStopped: publicURL ? undefined : 'pass', foundation:proof, externalRequests: 0, errors: 0 }));
} finally {
  await context?.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
