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
  page.setDefaultTimeout(30000);
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
  assert.equal(await page.locator('[data-layer]').count(),3);
  assert.equal(await page.locator('[data-tier]').count(),3);
  assert.deepEqual(await page.locator('[data-layer]').evaluateAll(bs=>bs.map(b=>b.dataset.layer)),['settlements','roads','maritime']);
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

async function tierInteractions(page,open,loaded) {
  const tier=id=>page.locator('[data-tier="'+id+'"]');
  const ports=page.locator('[data-sublayer=ports]');
  const countText=id=>page.locator('[data-count="'+id+'"]').textContent();
  const expected={settlements:{all:1388,medium:992,major:176,metropoleis:14},maritime:{all:584,open:143,primary:74},
    roads:{all:14769,probable:13992,certain:1040}};
  const observed={};
  for(const [group,options] of Object.entries(expected)) {
    observed[group]={};
    for(const [value,count] of Object.entries(options)) {
      await tier(group).selectOption(value);
      assert((await countText(group)).startsWith(' ('+count.toLocaleString('en-US')));
      const visible=await page.evaluate(async group=>{
        const m=window.testMap, layers=group==='roads'?['roads','roads-tentative']:[group];
        // Evaluate the installed MapLibre filters over every source feature.
        function evaluate(expr,p) {
          if(!Array.isArray(expr)) return expr;
          const [op,...args]=expr;
          if(op==='literal') return args[0];
          if(op==='get') return p[args[0]];
          const a=args.map(e=>evaluate(e,p));
          switch(op) {
            case '==':return a[0]===a[1]; case 'in':return a[1].includes(a[0]);
            case '!':return !a[0]; case 'all':return a.every(Boolean); case 'any':return a.some(Boolean);
            default:throw Error('Unexpected map filter: '+op);
          }
        }
        const filters=layers.map(id=>m.getFilter(id));
        const fc=await m.getSource(group).getData();
        return fc.features.filter(f=>filters.some(expr=>!expr || evaluate(expr,f.properties))).length;
      },group);
      assert.equal(visible,count);observed[group][value]=visible;
    }
  }
  assert.equal(await page.locator('.key-coastal').isVisible(),false);
  assert.equal(await page.locator('.key-conjectured').isVisible(),false);
  assert.equal(await page.locator('.key-rank3').isVisible(),false);
  await ports.uncheck();
  assert.match(await countText('maritime'),/0 ports/);
  assert.equal(await page.locator('.key-port').isVisible(),false);
  assert.equal(await page.evaluate(()=>window.testMap.getLayoutProperty('ports','visibility')),'none');
  await ports.check();assert.match(await countText('maritime'),/294 ports/);
  for (const id of Object.keys(expected)) await tier(id).selectOption('auto');
  const zoomCounts=[];
  async function checkBand(z,towns,roads,routes) {
    await page.evaluate(z=>window.testMap.jumpTo({zoom:z}),z);
    assert.equal(await countText('settlements'),' ('+towns.toLocaleString('en-US')+')');
    assert.equal(await countText('roads'),' ('+roads.toLocaleString('en-US')+')');
    assert.equal(await countText('maritime'),' ('+routes+' routes · 294 ports)');
    zoomCounts.push([z,towns,roads,routes]);
  }
  for(const band of [[4.49,176,1040,74],[4.5,992,13992,74],[4.79,992,13992,74],
    [4.8,992,13992,143],[5.59,992,13992,143],[5.6,1388,14769,143],[4,176,1040,74]]) {
    await checkBand(...band);
  }
  await tier('settlements').selectOption('metropoleis');
  await checkBand(6.5,14,14769,143);
  await tier('roads').selectOption('certain');await tier('maritime').selectOption('all');
  await checkBand(4,14,1040,584);
  await checkBand(6.5,14,1040,584);
  await tier('settlements').selectOption('all');
  await tier('roads').selectOption('all'); await tier('maritime').selectOption('all');
  const camera=()=>page.evaluate(()=>[...window.testMap.getCenter().toArray(),window.testMap.getZoom()]);
  const roma='hanson:Hanson2016_992';
  await page.evaluate(()=>{
    const m=window.testMap,original=m.fitBounds;
    window.testFits=0;m.fitBounds=function(...args){window.testFits++;return original.apply(this,args);};
    m.jumpTo({center:[15,41],zoom:4});
  });
  const before=await camera();
  await page.waitForFunction(()=>window.testMap.loaded());
  const pos=await page.evaluate(()=>{
    const {x,y}=window.testMap.project([12.485098,41.892777]); return {x,y};
  });
  const canvas=page.locator('#map canvas');
  await canvas.hover({position:pos});
  await page.waitForFunction(()=>document.querySelector('#map-hover').textContent==='Roma · Settlement (Rank 1)' &&
    !document.querySelector('#map-hover').hidden);
  assert.equal(await canvas.evaluate(c=>c.style.cursor),'pointer');
  await canvas.click({position:pos});await loaded(roma);
  const ids=await page.locator('#overlap-records button').evaluateAll(bs=>bs.map(b=>b.dataset.record));
  assert.equal(ids[0],roma);assert(ids.length>1);
  const ranks=await page.evaluate(async ids=>{
    const fc=await window.testMap.getSource('settlements').getData();
    const ranks=new Map(fc.features.map(f=>[f.properties.id,f.properties.rank]));
    return ids.filter(id=>ranks.has(id)).map(id=>ranks.get(id));
  },ids);
  assert(ranks.length>1);
  const rankOrder=rank=>({'1':0,'2':1,'3':2}[rank] ?? 3);
  assert.deepEqual(ranks,[...ranks].sort((a,b)=>rankOrder(a)-rankOrder(b)));
  assert.deepEqual(await camera(),before);await page.locator('#overlap-records button').nth(1).click();await loaded(ids[1]);
  assert.deepEqual(await camera(),before);assert.equal(await page.evaluate(()=>window.testFits),0);
  await open(roma);const located=await camera();assert.notDeepEqual(located,before);
  assert.equal(await page.evaluate(()=>window.testFits),1);
  await open('orbis:route:987571');
  const related=page.locator('#record-content button[data-related]').first();
  const destination=await related.getAttribute('data-related');await related.click();await loaded(destination);
  assert.equal(await page.evaluate(()=>window.testFits),3);
  await page.locator('#close-record').click();
  assert.equal(await page.locator('#map-hover').isVisible(),false);
  for(const id of ['settlements','roads','maritime']) await page.locator('[data-layer="'+id+'"]').uncheck();
  await canvas.hover({position:pos});assert.equal(await page.locator('#map-hover').isVisible(),false);
  for(const id of ['settlements','roads','maritime']) await page.locator('[data-layer="'+id+'"]').check();
  // Isolate a lower-ranked city. Its native rank must control rendering, hits and highlighting together.
  const isolated=await page.evaluate(async()=>{
    const m=window.testMap,fc=await m.getSource('settlements').getData();
    return fc.features.find(f=>f.properties.rank==='4 or 5' &&
      fc.features.every(other=>other===f || Math.hypot(...other.geometry.coordinates.map((v,i)=>v-f.geometry.coordinates[i]))>0.4)).properties.id;
  });
  await open(isolated);
  await page.locator('[data-layer=maritime]').uncheck();await page.locator('[data-layer=roads]').uncheck();
  await page.locator('#close-record').click();
  const isolatedPos=await page.evaluate(async id=>{
    const m=window.testMap, city=(await m.getSource('settlements').getData()).features.find(f=>f.properties.id===id);
    const [lng,lat]=city.geometry.coordinates;m.jumpTo({center:[lng+0.2,lat],zoom:5.7});
    const {x,y}=m.project([lng,lat]);return {x,y};
  },isolated);
  const isolatedCamera=await camera();
  await page.waitForFunction(()=>window.testMap.loaded());
  await canvas.click({position:isolatedPos});await loaded(isolated);
  assert.equal(await page.locator('#overlap-picker').isVisible(),false);assert.deepEqual(await camera(),isolatedCamera);
  await tier('settlements').selectOption('major');
  assert.deepEqual(await page.evaluate(async()=>(await window.testMap.getSource('selected-record').getData()).features),[]);
  await page.locator('#close-record').click();await page.waitForFunction(()=>window.testMap.loaded());
  await canvas.hover({position:isolatedPos});await canvas.click({position:isolatedPos});
  assert.equal(await page.locator('#record-panel').isVisible(),false);
  assert.equal(await page.locator('#map-hover').isVisible(),false);
  assert.deepEqual(await camera(),isolatedCamera);
  assert.equal(await page.evaluate(()=>window.testFits),4);
  await tier('settlements').selectOption('all');
  await page.locator('[data-layer=maritime]').check();await page.locator('[data-layer=roads]').check();
  proof.detailFilters={counts:observed,autoByZoom:zoomCounts,manualAtZoom65:{towns:14,roads:1040,routes:584},
    hover:'Roma · Settlement (Rank 1)',overlapCityRanks:ranks,mapAndPickerCamera:before,searchCamera:located,
    isolatedCity:isolated,isolatedClickCamera:isolatedCamera,filteredCityExcludedFromHits:true,
    directAndPickerFitCalls:0,searchAndRelationFitCalls:3};
}

async function savedTiers(page,write) {
  const settings={settlements:'major',maritime:'primary',roads:'certain'};
  for(const [id,value] of Object.entries(settings)) {
    const select=page.locator('[data-tier="'+id+'"]');
    if(write) await select.selectOption(value);
    assert.equal(await select.inputValue(),value);
  }
  const ports=page.locator('[data-sublayer=ports]');
  if(write) await ports.check();
  assert(await ports.isChecked());
  assert.equal(await page.locator('[data-count=maritime]').textContent(),' (74 routes · 294 ports)');
  assert.equal(await page.locator('[data-count=roads]').textContent(),' (1,040)');
  assert.equal(await page.locator('[data-count=settlements]').textContent(),' (176)');
}

async function observeMap(page) {
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
  await page.locator('[value=simple]').check();
  await page.locator('[value=natural]').check();
  await page.waitForFunction(()=>window.testMap.loaded());
  const startup=await page.evaluate(()=>{
    const m=window.testMap;
    const layers=['settlements','roads','maritime','ports'];
    return Object.fromEntries(layers.map(id=>[id,new Set(m.queryRenderedFeatures({layers:[id]}).map(f=>f.properties.id)).size]));
  });
  assert(startup.settlements>0 && startup.roads>0 && startup.maritime>0 && startup.ports===0);
  const first=await page.evaluate(()=>{
    const m=window.testMap, hits=id=>m.queryRenderedFeatures({layers:[id]});
    return {zoom:m.getZoom(),counts:[...document.querySelectorAll('[data-count]')].map(x=>x.textContent.trim()),
      ranks:[...new Set(hits('settlements').map(f=>f.properties.rank))].sort(),
      certainty:[...new Set(hits('roads').map(f=>f.properties.certainty))].sort(),
      water:[...new Set(hits('maritime').map(f=>f.properties.t))].sort(),tentative:hits('roads-tentative').length};
  });
  assert.equal(first.zoom.toFixed(1),'3.4');
  assert.deepEqual(first.counts,['(176)','(1,040)','(74 routes · 0 ports)']);
  assert.deepEqual(first.ranks,['1','2']);assert.deepEqual(first.certainty,['Certain']);
  assert.deepEqual(first.water,['ferry','overseas']);assert.equal(first.tentative,0);
  proof.defaultRendered=startup;proof.defaultView=first;
}

async function interactions(page) {
  const groups=['settlements','roads','maritime'];
  const toggle=g=>page.locator('[data-layer="'+g+'"]');
  await page.locator('[data-tier=maritime]').selectOption('all');
  await page.locator('[data-sublayer=ports]').check();
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
      roadOpacity:m.getPaintProperty('roads','line-opacity'),radius:m.getPaintProperty('settlements','circle-radius'),
      stroke:m.getPaintProperty('settlements','circle-stroke-width'),seaWidth:m.getPaintProperty('maritime','line-width'),
      seaOpacity:m.getPaintProperty('maritime','line-opacity'),
      tentative:m.getPaintProperty('roads-tentative','line-dasharray'),maritime:m.getPaintProperty('maritime','line-dasharray'),
      filter:m.getFilter('roads-tentative')};
  });
  // Sample the linear stops installed in MapLibre for each native class.
  function paintValue(expression,zoom,value) {
    assert.deepEqual(expression.slice(0,3),['interpolate',['linear'],['zoom']]);
    const stops=[];
    for(let i=3;i<expression.length;i+=2) {
      const match=expression[i+1];assert.equal(match[0],'match');
      const index=match.findIndex((entry,j)=>j>=2 && j%2===0 && entry===value);
      stops.push([expression[i],index<0?match.at(-1):match[index+1]]);
    }
    if (zoom<=stops[0][0]) return stops[0][1];
    for(let i=1;i<stops.length;i++){
      const [z0,v0]=stops[i-1], [z1,v1]=stops[i];
      if(zoom<=z1) return Number((v0+(v1-v0)*(zoom-z0)/(z1-z0)).toFixed(4));
    }
    return stops.at(-1)[1];
  }
  const samples=(expr,zooms,value)=>zooms.map(z=>paintValue(expr,z,value));
  assert.deepEqual(samples(style.radius,[3,5,7],'1'),[4.2,5.4,6.8]);
  assert.deepEqual(samples(style.radius,[3,3.4,5,7],'2'),[2.5,2.76,3.8,5]);
  assert.deepEqual(samples(style.radius,[5,7],'3'),[2.8,3.8]);
  assert.equal(paintValue(style.radius,7,'4 or 5'),2.8);assert.equal(paintValue(style.stroke,3,'2'),0.5);
  assert.deepEqual(samples(style.roads,[3,7],'Certain'),[1.15,2.4]);
  assert.deepEqual(samples(style.roads,[3,7],'Conjectured'),[0.65,1.4]);
  assert.deepEqual(samples(style.roadOpacity,[3,6],'Conjectured'),[0.55,0.82]);
  assert.deepEqual(samples(style.seaWidth,[3,7],'overseas'),[1.25,2.2]);
  assert.equal(paintValue(style.seaOpacity,3,'overseas'),0.68);assert.notEqual(style.color[3],style.color[4]);
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
  await tierInteractions(page,open,loaded);
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
      const highlighted=await page.evaluate(()=>window.testMap.queryRenderedFeatures({layers:['selected-point']})
        .map(f=>({id:f.properties.id,geometry:f.geometry.type,layer:f.layer.type})));
      assert(highlighted.some(f=>f.id===id && f.geometry==='Point' && f.layer==='circle'));
      proof.pleiadesHighlight={id,source:(await selection()).type,rendered:'circle',baseGroupsOn:0};
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
  for(const box of await page.locator('[data-layer]').all()){await box.uncheck();await box.check();}
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
  await observeMap(page);
  if (process.env.ATLAS_SCREENSHOT) await page.screenshot({path:process.env.ATLAS_SCREENSHOT});
  assert.deepEqual(await page.locator('[data-tier]').evaluateAll(ns=>ns.map(n=>n.value)),['auto','auto','auto']);
  assert.equal(await page.locator('[data-sublayer=ports]').isChecked(),false);
  await foundation(page,true);
  await interactions(page);
  await guide(page,1440);
  await controls(page);
  {
    await page.setViewportSize({ width: 390, height: 844 });
    await layout(page, 390);
    await guide(page,390);
    await controls(page);
  }
  if (!publicURL) {
    await savedTiers(page,true);
    await page.locator('#download').click();
    await page.getByText('Both maps are verified and ready offline.', { exact: true }).waitFor();
    await context.close();
    await new Promise(resolve => server.close(resolve));
    server = null;
    page = await launch(390, true);
    await savedTiers(page,false);
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
    offlineBrowserRestartWithServerStopped: publicURL ? undefined : 'pass', offlineTiersRetained:publicURL?undefined:{settlements:176,roads:1040,maritime:74,ports:294}, foundation:proof, externalRequests: 0, errors: 0 }));
} finally {
  await context?.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
