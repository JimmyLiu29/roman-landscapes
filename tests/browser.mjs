import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';
import {siteCases,ready,openRecord,checkGuide} from './browser-site.mjs';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const fixture=process.argv.includes('--fixture');
const evidence=path.resolve(process.env.ATLAS_EVIDENCE || path.join(root,'.cache/browser-evidence'));
const mode=fixture?'fixture':'full';
await mkdir(evidence,{recursive:true});
const work=await mkdtemp(path.join(evidence,'.'+mode+'-'));
const profile=path.join(work,'profile');
const dist=fixture?path.join(work,'miniature'):path.join(root,'dist');
async function hashes(dir,prefix='') {
  const out={};
  for (const item of await readdir(path.join(dir,prefix),{withFileTypes:true})) {
    const name=path.join(prefix,item.name);
    if (item.isDirectory()) Object.assign(out,await hashes(dir,name));
    else out[name]=createHash('sha256').update(await readFile(path.join(dir,name))).digest('hex');
  }
  return out;
}
const makeFixture=dir=>execFileSync(process.env.ATLAS_PYTHON || 'python3',['-B',path.join(root,'tests/fixture.py'),dir]);
if (fixture) makeFixture(dist);
const base=JSON.parse(await readFile(path.join(dist,'release.json')));
const pack=path.join(dist,'packs',base.id);
const readPack=async name=>JSON.parse(gunzipSync(await readFile(path.join(pack,name))));
const {records:rows}=await readPack('catalog.json.gz');
const edges=await readPack('relations.json.gz');
const shardCache=new Map();
async function detail(row) {
  if (!shardCache.has(row.detail)) {
    if (shardCache.size>=4) shardCache.delete(shardCache.keys().next().value);
    shardCache.set(row.detail,await readPack(row.detail));
  }
  return shardCache.get(row.detail)[row.id];
}
const report={mode,release:base.id,bytes:base.bytes,cases:{},screenshots:[],pageErrors:[],consoleErrors:[],csp:[],thirdParty:[],expectedFaults:[]};
const reportFile=path.join(evidence,mode+'-report.json');
const save=()=>writeFile(reportFile,JSON.stringify(report,null,2)+'\n');
async function test(id,operation) {
  console.log(id,mode);
  try {report.cases[id]={status:'pass',observations:await operation()};}
  catch (e) {report.cases[id]={status:'fail',error:e.message};throw e;}
  finally {await save();}
}
async function shot(page,label) {
  const name=mode+'-'+label+'.png';await page.screenshot({path:path.join(evidence,name)});
  report.screenshots.push(name);
}
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json',
  '.css':'text/css','.webmanifest':'application/manifest+json','.png':'image/png'};
let server,port,origin,serving=dist,context,update,override,missing,slowShell=false,shellSuffix='',oldRequests=0;
const changedFiles = new Map();
const rules=[];
for (const line of (await readFile(path.join(dist,'_headers'),'utf8')).split('\n')) {
  if (line.startsWith('/')) rules.push({pattern:new RegExp('^'+line.trim().split('*').map(s=>s.replace(/[.]/g,'\\.')).join('.*')+'$'),values:{}});
  else if (line.trim()) {
    const i=line.indexOf(':');rules.at(-1).values[line.slice(0,i).trim().toLowerCase()]=line.slice(i+1).trim();
  }
}
async function serve() {
  server=createServer(async(req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    let rel=pathname==='/'?'index.html':pathname.slice(1);
    if (update && rel.startsWith('packs/'+update.id+'/')) rel=rel.replace(update.id,base.id);
    const file=path.resolve(serving,rel);
    if (!file.startsWith(serving+path.sep) || pathname===missing) {if (pathname===missing) oldRequests++;res.writeHead(404).end();return;}
    try {
      let bytes=await readFile(file);
      if (pathname==='/release.json' && update) bytes=JSON.stringify(update);
      if (changedFiles.has(pathname)) bytes=changedFiles.get(pathname);
      if (pathname===override?.path) bytes=override.bytes;
      if (pathname==='/sw.js' && shellSuffix) bytes=bytes.toString().replace(/atlas-shell-([a-f0-9]{16})/,'atlas-shell-$1'+shellSuffix);
      if (slowShell && pathname==='/style.css') await new Promise(resolve=>setTimeout(resolve,900));
      const headers={'content-type':types[path.extname(file)] || 'application/octet-stream'};
      for (const rule of rules) if (rule.pattern.test(pathname)) Object.assign(headers,rule.values);
      res.writeHead(200,headers).end(bytes);
    } catch {res.writeHead(404).end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port || 0,'127.0.0.1',resolve);});
  port=server.address().port;origin='http://127.0.0.1:'+port;
}
async function stop() {
  if (server) {const closed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await closed;server=null;}
}
async function launch(dir=profile,offline=false,headed=false) {
  context=await chromium.launchPersistentContext(dir,{headless:!headed,executablePath:process.env.CHROMIUM_PATH || chromium.executablePath(),
    viewport:headed ? null : {width:1280,height:800},args:[...(headed && offline ? ['--proxy-server=http://127.0.0.1:'+port,'--proxy-bypass-list=<-loopback>'] : []),'--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  report.chromium=context.browser().version();
  if (fixture) assert(Number.parseInt(report.chromium,10)>=151);
  else assert.match(report.chromium,/^151\./);
  console.log('Chromium '+report.chromium);
  context.setDefaultTimeout(15000);await context.setOffline(offline);
  context.on('request',r=>{if (/^https?:/.test(r.url()) && new URL(r.url()).origin!==origin) report.thirdParty.push(r.url());});
  await context.exposeBinding('reportPolicy',(_,directive)=>report.csp.push(directive));
  await context.addInitScript(()=>addEventListener('securitypolicyviolation',e=>window.reportPolicy(e.effectiveDirective)));
  function watch(page) {
    page.on('pageerror',e=>report.pageErrors.push(e.message));
    page.on('console',m=>{
      if (m.type()!=='error') return;
      const url=m.location().url;
      if (url.endsWith('/release.json?check=1') && /ERR_(INTERNET_DISCONNECTED|CONNECTION_REFUSED|PROXY_CONNECTION_FAILED|FAILED)/.test(m.text()) ||
          (missing && url.endsWith(missing) && /404/.test(m.text()))) report.expectedFaults.push(m.text());
      else report.consoleErrors.push({text:m.text(),url});
    });
  }
  for (const p of context.pages()) watch(p);context.on('page',watch);
  return context.pages()[0];
}
async function close() {await context?.close();context=null;}
async function openAtlas(page) {await page.goto(origin);await ready(page);}
async function savePack(page) {
  await page.locator('#download').click();
  await page.locator('#storage-status').filter({hasText:'verified and ready offline'}).waitFor({timeout:180000});
}
async function savedState(page) {
  return page.evaluate(async()=>{
    const s=await import('/storage.js');const active=await s.activeRelease(true);
    const dirs=[];const root=await (await navigator.storage.getDirectory()).getDirectoryHandle('atlas-packages');
    for await (const name of root.keys()) dirs.push(name);
    return {id:active.id,dir:active.storageDirectory,dirs,completed:await s.readState('completed'),transfer:await s.readState('transfer')};
  });
}
async function prepareUpdate(fault) {
  update=structuredClone(base);update.id='atlas-test-'+fault;
  for (const f of update.files) f.path=f.path.replace(base.id,update.id);
  override=null;
  if (!['corrupt','gzip','closure'].includes(fault)) return;
  const file=update.files.find(f=>f.path.endsWith(fault==='closure'?'/catalog.json.gz':'/details-hanson-cities-000.json.gz'));
  let bytes=Buffer.from(await readFile(path.join(dist,file.path.replace(update.id,base.id))));
  if (fault==='closure') {const c=JSON.parse(gunzipSync(bytes));c.records[0].detail='missing.json.gz';bytes=gzipSync(JSON.stringify(c));}
  else bytes[0]^=255;
  if (fault!=='corrupt') {file.sha256=createHash('sha256').update(bytes).digest('hex');update.bytes+=bytes.length-file.bytes;file.bytes=bytes.length;}
  override={path:'/'+file.path,bytes};
}
async function clickAndReload(page, selector) {
  await Promise.all([page.waitForEvent('framenavigated', {
    predicate: frame => frame === page.mainFrame(), timeout:180000
  }), page.locator(selector).click()]);
  await ready(page);
}

async function damageFile(page, name, remove=false) {
  return page.evaluate(async ({name,remove}) => {
    const s = await import('/storage.js'), active = await s.readState('active');
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('atlas-packages');
    const dir = await root.getDirectoryHandle(active.storageDirectory);
    const file = active.files.find(f => f.path.endsWith('/'+name));
    if (remove) { await dir.removeEntry(file.sha256); return; }
    const handle = await dir.getFileHandle(file.sha256);
    const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
    bytes[0] ^= 1;
    const writer = await handle.createWritable();
    await writer.write(bytes); await writer.close();
    return {before:file.bytes, after:(await handle.getFile()).size};
  }, {name,remove});
}

async function rollback(page) {
  const initial=await savedState(page);
  update={...base,app_schema:99};
  const incompatible=await page.evaluate(async()=>{
    const s=await import('/storage.js');const manifest=await (await fetch('/release.json?check=1')).json();
    try {await s.downloadRelease(manifest);return false;} catch(e){return /compatible/.test(e.message);}
  });
  assert(incompatible);update=null;
  for (const [fault,message] of [['cancel','Download cancelled'],['quota','Not enough browser storage'],
    ['corrupt','Content checksum failed'],['gzip','Invalid compressed package'],['closure','missing detail shard']]) {
    await prepareUpdate(fault);await page.reload();await ready(page);
    if (fault==='quota') await page.evaluate(()=>navigator.storage.estimate=async()=>({usage:0,quota:1}));
    await page.locator('#update-maps').click();
    if (fault==='cancel') {await page.waitForFunction(()=>!document.querySelector('#cancel').hidden);await page.locator('#cancel').click();}
    await page.locator('#storage-status').filter({hasText:message}).waitFor({timeout:180000});
    assert.deepEqual(await savedState(page),initial);
  }
  update=null;override=null;await close();await stop();
  page=await launch(profile,true);await openAtlas(page);
  await openRecord(page,rows.find(r=>r.layers.includes('roads')).id);await page.locator('[value=simple]').check();
  await page.locator('[value=natural]').check();assert.deepEqual(await savedState(page),initial);
  await shot(page,'rollback-offline');
  await serve();await context.setOffline(false);await page.reload();await ready(page);
  for (const damage of ['flip','missing']) {
    const old=await savedState(page);
    await damageFile(page,rows[0].detail,damage==='missing');
    await page.locator('#download').click();
    await page.getByRole('button',{name:'Repair offline maps'}).waitFor();
    if (damage==='flip') {
      await page.locator('#download').click();await page.locator('#cancel').click();
      await page.locator('#storage-status').filter({hasText:'Download cancelled'}).waitFor();
      await page.evaluate(()=>{window.actualEstimate=navigator.storage.estimate.bind(navigator.storage);navigator.storage.estimate=async()=>({quota:1,usage:0});});
      await page.locator('#download').click();await page.locator('#storage-status').filter({hasText:'Not enough browser storage'}).waitFor();
      assert.equal(await page.evaluate(async()=>(await (await import('/storage.js')).readState('active')).storageDirectory),old.dir);
      await page.evaluate(()=>navigator.storage.estimate=window.actualEstimate);
    }
    await clickAndReload(page,'#download');const repaired=await savedState(page);assert.notEqual(repaired.dir,old.dir);assert.equal(repaired.id,old.id);
  }
  return page;
}

const oldRecord = 'shipwrecks:unmatched', newRecord = 'shipwrecks:revised-note';
async function serveRevisedCatalog() {
  await prepareUpdate('revised');
  const catalog = await readPack('catalog.json.gz');
  const row = catalog.records.find(r => r.id === oldRecord);
  const shard = await readPack(row.detail);
  row.id = newRecord; row.label = 'Revised cargo note';
  shard[newRecord] = {...shard[oldRecord], id:newRecord};
  delete shard[oldRecord];
  for (const [name,data] of [['catalog.json.gz',catalog],[row.detail,shard]]) {
    const entry = update.files.find(f => f.path.endsWith('/'+name));
    const bytes = gzipSync(JSON.stringify(data));
    update.bytes += bytes.length - entry.bytes;
    entry.bytes = bytes.length; entry.sha256 = createHash('sha256').update(bytes).digest('hex');
    changedFiles.set('/'+entry.path,bytes);
  }
}

async function assertRevisedCatalog(page) {
  await openRecord(page,newRecord);
  assert.equal(await page.locator('#record-content h3').innerText(),'Revised cargo note');
  await page.locator('#close-record').click();
  await page.locator('#search').fill(oldRecord);
  await page.waitForFunction(() => document.querySelector('#search-status').textContent === '0 results');
  assert.equal(await page.locator('#search-results button').count(),0);
}

async function repairAndRemove(page) {
  const initial = await savedState(page);
  await openRecord(page,oldRecord);
  await page.locator('#close-record').click();
  await damageFile(page,rows[0].detail);
  await serveRevisedCatalog();
  await page.locator('#download').click();
  await page.getByRole('button',{name:'Repair offline maps'}).waitFor();
  await clickAndReload(page,'#download');
  const revised = await savedState(page);
  assert.equal(revised.id,update.id);
  assert.notEqual(revised.dir,initial.dir);
  assert.deepEqual(revised.dirs,[revised.dir]);
  await assertRevisedCatalog(page);
  changedFiles.clear(); update=null;
  await clickAndReload(page,'#remove');
  const empty = await page.evaluate(async () => {
    const s=await import('/storage.js');
    const dir=await (await navigator.storage.getDirectory()).getDirectoryHandle('atlas-packages');
    const entries=[]; for await (const name of dir.keys()) entries.push(name);
    return {entries, active:await s.readState('active'), stored:await s.storedContentStatus()};
  });
  assert.deepEqual(empty,{entries:[],active:null,stored:false});
  await savePack(page);
  assert.equal((await savedState(page)).id,base.id);

  const length=await damageFile(page,'catalog.json.gz');
  assert.equal(length.before,length.after);
  await close(); await stop();
  page=await launch(profile,true); await page.goto(origin);
  for (const id of ['#storage-status','#map-error']) {
    await page.locator(id).filter({hasText:/damaged.*Reconnect/i}).waitFor();
  }
  assert(await page.locator('#remove').isVisible() && await page.locator('#remove').isEnabled());
  assert(await page.locator('#download').isDisabled());
  await close(); await serve();
  page=await launch(profile); await page.goto(origin);
  for (const id of ['#storage-status','#map-error']) {
    await page.locator(id).filter({hasText:/damaged.*Repair offline maps/i}).waitFor();
  }
  assert(await page.locator('#remove').isVisible() && await page.locator('#remove').isEnabled());
  const repair=page.getByRole('button',{name:'Repair offline maps'});
  assert(await repair.isEnabled());
  await clickAndReload(page,'#download');
  await openRecord(page,oldRecord); assert.equal((await savedState(page)).id,base.id);
  await close();
  return {crossVersion:{from:initial.id,to:revised.id,oldRecord,newRecord,oldDirectoryPruned:true},
    coldCatalog:{...length,onlineRepair:true,offlineRemovalAvailable:true}, removal:{empty,downloaded:base.id}};
}

async function detailReload() {
  const page=await launch(path.join(work,'detail-update'));
  const cdp=await context.newCDPSession(page);
  await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  await openAtlas(page);
  await page.waitForFunction(()=>navigator.serviceWorker.controller);
  await serveRevisedCatalog();
  missing='/packs/'+base.id+'/'+rows.find(r=>r.id===oldRecord).detail;
  shellSuffix='-detail'; slowShell=true;
  await page.locator('#search').fill(oldRecord);
  await page.locator('#search-results [data-record="'+oldRecord+'"]').click();
  const reload=page.getByRole('button',{name:'Reload',exact:true});
  await reload.waitFor();
  let navigations=0;
  page.on('framenavigated',f=>{if (f===page.mainFrame()) navigations++;});
  await clickAndReload(page,'#record-content button');
  assert.equal(navigations,1);
  assert((await page.locator('#package-description').textContent()).startsWith(update.id));
  await assertRevisedCatalog(page);
  await close(); missing=null; shellSuffix=''; slowShell=false; update=null; changedFiles.clear();
  return {clicks:1,navigations,newRecord};
}

async function migrations() {
  const legacy=process.env.ATLAS_LEGACY;
  if (!legacy && fixture) return {legacy:'Real legacy snapshot is exercised in the full run.'};
  assert(legacy,'Supply the archived legacy site in ATLAS_LEGACY');
  const manifest=JSON.parse(await readFile(path.join(legacy,'release.json')));
  assert.equal(manifest.id,'foundation-340b3c94ee3b7e66');
  for (const saved of [false,true]) {
    serving=legacy;const oldProfile=path.join(work,'legacy-'+saved);
    let page=await launch(oldProfile);await openAtlas(page);
    await page.evaluate(()=>navigator.serviceWorker.ready);await page.waitForFunction(()=>navigator.serviceWorker.controller);
    if (saved) {
      await savePack(page);await close();await stop();
      page=await launch(oldProfile,true);await openAtlas(page);
      await openRecord(page,'hanson:Hanson2016_992');await serve();await context.setOffline(false);
    }
    serving=dist;
    const navigations=[];page.on('framenavigated',f=>{if(f===page.mainFrame()) navigations.push(f.url());});
    await page.evaluate(async()=>{const reg=await navigator.serviceWorker.ready;await reg.update();}).catch(e=>{
      if (!e.message.includes('Execution context was destroyed')) throw e;
    });
    if (saved) {
      await page.locator('#update-app').waitFor();assert.equal(await page.locator('[data-layer]').count(),3);
      await page.locator('#update-app').click();
      await page.locator('#storage-status').filter({hasText:'A previous v0.1 offline package is stored'}).waitFor({timeout:60000});
      await ready(page);assert(await page.locator('#remove').isVisible());await close();await stop();
      page=await launch(oldProfile,true);await page.goto(origin);
      await page.locator('#storage-status').filter({hasText:'Reconnect to upgrade'}).waitFor();
      assert.equal(await page.locator('#foundation-controls').isVisible(),false);assert(await page.locator('#remove').isVisible());
      await serve();await context.setOffline(false);await page.reload();await ready(page);await savePack(page);
      assert.equal((await savedState(page)).id,base.id);
    } else {
      await page.locator('[data-layer=events]').waitFor({timeout:60000});assert(navigations.length<=1);
    }
    await close();
  }
  return {legacy:manifest.id,automatic:true,storedPackage:true};
}

async function installingRace() {
  const page=await launch(path.join(work,'race'));
  const cdp=await context.newCDPSession(page);
  await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  const states=[];
  await page.exposeFunction('noteWorker',state=>states.push(state));
  await page.addInitScript(()=>{
    navigator.serviceWorker?.getRegistration().then(reg=>{
      reg?.addEventListener('updatefound',()=>{const w=reg.installing;window.noteWorker(w.state);});
    });
  });
  await openAtlas(page);
  await page.waitForFunction(()=>navigator.serviceWorker.controller);
  await page.evaluate(()=>sessionStorage.setItem('race','started'));
  missing='/packs/'+base.id+'/relief.pmtiles';slowShell=true;shellSuffix='-next';await prepareUpdate('next');
  await page.reload();
  await page.waitForFunction(id=>document.querySelector('#package-description')?.textContent.startsWith(id),update.id,{timeout:60000});
  await ready(page);
  assert(states.includes('installing'));assert.equal(await page.evaluate(()=>sessionStorage.getItem('retry-shell')),base.id);
  assert((await page.locator('#package-description').textContent()).includes(update.id));assert(oldRequests>0);
  missing=null;slowShell=false;shellSuffix='';update=null;await close();
}
async function installed(page) {
  const manifestId=origin+'/';
  const cdp=await context.newCDPSession(page);
  await cdp.send('PWA.install',{manifestId,installUrlOrBundleUrl:manifestId});
  await cdp.send('PWA.changeAppUserSettings',{manifestId,displayMode:'standalone'});
  const state=await cdp.send('PWA.getOsAppState',{manifestId});
  async function launchApp(cdp) {
    const {targetId}=await cdp.send('PWA.launch',{manifestId});
    const {windowId}=await cdp.send('Browser.getWindowForTarget',{targetId});
    const until=Date.now()+20000;
    while (Date.now()<until) {
      for (const tab of context.pages()) {
        if (!tab.url().startsWith(manifestId)) continue;
        const session=await context.newCDPSession(tab);
        let own;
        try { own=await session.send('Browser.getWindowForTarget'); }
        finally { await session.detach(); }
        if (own.windowId!==windowId || !await tab.evaluate(()=>matchMedia('(display-mode: standalone)').matches)) continue;
        await ready(tab);return tab;
      }
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    throw new Error('Installed app did not open in a standalone window');
  }
  let app=await launchApp(cdp);await shot(app,'installed-window');
  await close();await stop();page=await launch(profile,true,true);
  const cold=await context.newCDPSession(page);app=await launchApp(cold);
  assert.equal(server,null);
  const connection=await app.evaluate(async()=>{
    try {
      await fetch('/release.json?check=1',{cache:'no-store',signal:AbortSignal.timeout(3000)});
      return {reachable:true};
    } catch {return {reachable:false,browserOnlineFlag:navigator.onLine};}
  });
  assert.equal(connection.reachable,false,'A network-only request reached the stopped origin');
  await openRecord(app,rows.find(r=>r.layers.includes('events')).id);await shot(app,'installed-offline');
  await cold.send('PWA.uninstall',{manifestId});await serve();
  return {installed:true,standalone:true,coldOffline:true,networkOnlyProbe:connection,closedProxyAtStartup:true,platform:process.platform,state};
}

try {
  await serve();
  let page=await launch();await openAtlas(page);
  await siteCases(page,{test,rows,edges,detail,fixture,release:base,shot});
  await test('T-A5a',async()=>{
    await savePack(page);assert.equal((await savedState(page)).id,base.id);await close();await stop();
    page=await launch(profile,true);await openAtlas(page);
    for (const box of await page.locator('[data-layer]').all()) {await box.uncheck();await box.check();}
    for (const id of base.datasets.map(d=>d.id)) {
      const r=rows.filter(r=>r.source===id).at(-1);await openRecord(page,r.id);
    }
    for (const archive of base.archives) {await page.locator('[data-archive="'+archive.id+'"]').click();await page.locator('#more-results').click();}
    await openRecord(page,report.cases['T-A10'].observations.supporting);
    assert(await page.locator('#record-content').getByText('Supporting dating events',{exact:true}).isVisible());
    await page.locator('#close-record').click();await checkGuide(page);
    assert.equal(await page.locator('#credits > li').count(),16);
    const distant=rows.filter(r=>r.layers.includes('settlements') && r.bbox).sort((a,b)=>a.bbox[0]-b.bbox[0])[0];
    await openRecord(page,distant.id);
    await page.locator('#map canvas').press('ArrowRight');
    for (const mode of ['simple','natural']) {
      await page.locator('[value='+mode+']').check();
      assert.equal(await page.locator('#map-error').isVisible(),false);
    }
    await shot(page,'cold-offline');await serve();await context.setOffline(false);
    return {serverStopped:true,coldProfile:true,bytes:base.bytes,sources:12,archives:3,distantRecord:distant.id};
  });
  await test('T-A6',async()=>{
    page=await rollback(page);const fixes=await repairAndRemove(page);
    const oneClick=await detailReload();const migration=await migrations();await installingRace();
    return {...migration,...fixes,detail404:oneClick,rollback:['cancel','quota','checksum','gzip','shard closure','schema 99'],repair:['equal length','missing','cancel','quota'],installingRace:true};
  });
  await test('T-A8',async()=>{
    if (fixture) {
      const second=path.join(work,'repeat');makeFixture(second);
      const first=await hashes(dist);assert.deepEqual(await hashes(second),first);return {identicalFiles:Object.keys(first).length};
    }
    if (!await readFile(path.join(evidence,'determinism.json')).catch(()=>null)) {
      const args=['-B',path.join(root,'tests/rebuild.py'),evidence];
      if (process.env.ATLAS_FROZEN_PACK) args.push('--reference',process.env.ATLAS_FROZEN_PACK);
      execFileSync(process.env.ATLAS_PYTHON || 'python3',args,{stdio:'inherit'});
    }
    const receipt=JSON.parse(await readFile(path.join(evidence,'determinism.json')));
    assert.equal(receipt.release,base.id);assert.deepEqual(receipt.commands,{build:[0,0],verify:[0,0]});
    const first=JSON.parse(await readFile(path.join(evidence,'offline-1-hashes.json')));
    const second=JSON.parse(await readFile(path.join(evidence,'offline-2-hashes.json')));
    assert.deepEqual(first,second);assert.deepEqual(await hashes(dist),second);
    return receipt;
  });
  if (fixture && process.platform!=='darwin') {
    report.cases['T-A5b']={status:'not applicable',platform:process.platform,reason:'Native installation is assessed on macOS.'};
  } else {
    await test('T-A5b',async()=>{
      page=await launch(profile,false,true);await openAtlas(page);return installed(page);
    });
  }
  assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.csp,[]);assert.deepEqual(report.consoleErrors,[]);assert.deepEqual(report.thirdParty,[]);
  report.status='pass';
} catch (error) {
  report.status='fail';report.error=error.message;
  const page=context?.pages().at(-1);
  if (page) report.screenState=await page.evaluate(()=>({map:document.querySelector('#map-error')?.textContent,
    storage:document.querySelector('#storage-status')?.textContent,record:document.querySelector('#record-panel')?.dataset.loaded})).catch(()=>null);
  console.error(error);process.exitCode=1;
} finally {
  await close();await stop();await save();await rm(work,{recursive:true,force:true});
}
