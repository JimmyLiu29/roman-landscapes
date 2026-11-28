import assert from 'node:assert/strict';

export async function ready(page) {
  await page.locator('#map[data-ready=true]').waitFor({timeout:90000});
  await page.locator('#foundation-controls').waitFor();
  assert.equal(await page.locator('#map-error').isVisible(),false);
}

export async function openRecord(page,id) {
  await page.locator('#search-source').selectOption('');
  await page.locator('#search-category').selectOption('');
  await page.locator('#search').fill(id);
  await page.locator('#search-results').locator('[data-record="'+id+'"]').click();
  await page.locator('#record-panel[data-loaded="'+id+'"]').waitFor();
}

async function mapHandle(page) {
  await page.evaluate(async()=>{
    if (window.atlasTestMap) return;
    const {Map:MapView}=await import('/vendor/maplibre-gl/maplibre-gl.mjs');
    const fit=MapView.prototype.fitBounds;
    MapView.prototype.fitBounds=function(...args) {
      MapView.prototype.fitBounds=fit; window.atlasTestMap=this; return fit.apply(this,args);
    };
    document.querySelector('#reset').click();
  });
}

async function follow(page,selector) {
  const link=page.locator('#record-content').locator(selector).first();
  const id=await link.getAttribute('data-related');
  await link.evaluate(node=>node.closest('details').open=true);
  await link.click();
  await page.locator('#record-panel[data-loaded="'+id+'"]').waitFor();
  return id;
}

export async function checkGuide(page) {
  for (const [key,count] of [['methods',3],['datasets',13]]) {
    await page.locator('[data-guide="'+key+'"]').click();
    const links=page.locator('#guide-dialog article:visible nav a');
    assert.equal(await links.count(),count);
    for (const link of await links.all()) {
      await link.click();
      assert.equal('#'+await page.evaluate(()=>document.activeElement.id),await link.getAttribute('href'));
    }
    await page.keyboard.press('Escape');
    assert(await page.locator('[data-guide="'+key+'"]').evaluate(n=>n===document.activeElement));
  }
}

export async function siteCases(page,{test,rows,edges,detail,fixture,release,shot}) {
  const town=rows.find(r=>r.label==='Roma' && r.layers.includes('settlements'));
  const body=page.locator('#record-content');
  const layer=id=>page.locator('[data-layer="'+id+'"]');
  await ready(page); await mapHandle(page);
  await test('T-A1',async()=>{
    assert.deepEqual(await page.locator('[data-layer]').evaluateAll(nodes=>nodes.map(n=>[n.dataset.layer,n.checked])),
      [['settlements',true],['roads',true],['maritime',true],['economy',false],['people-biography',false],['people',false],['events',false]]);
    await page.locator('[data-sublayer=ports]').check();
    for (const name of ['economy','events','people','people-biography']) await layer(name).check();
    await page.locator('#economy-category').selectOption('Mining and metals');
    await openRecord(page,town.id);
    await page.locator('#map canvas').press('ArrowRight');
    await page.getByRole('button',{name:'Zoom in',exact:true}).click();
    await page.waitForFunction(()=>!window.atlasTestMap.isMoving());
    const state=()=>page.evaluate(()=>({position:document.querySelector('#coordinates').textContent,
      selected:document.querySelector('#record-panel').dataset.loaded,category:document.querySelector('#economy-category').value,
      layers:[...document.querySelectorAll('[data-layer],[data-sublayer]')].map(e=>e.checked)}));
    const before=await state();
    for (const mode of ['simple','natural']) {
      await page.locator('[value='+mode+']').check(); assert.deepEqual(await state(),before);
      assert.equal(await page.evaluate(()=>window.atlasTestMap.getLayoutProperty('relief','visibility')),mode==='simple'?'none':'visible');
    }
    const map=page.locator('#map canvas'), b=await map.boundingBox();
    await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();
    await page.mouse.move(b.x+b.width/2+48,b.y+b.height/2-32,{steps:7});await page.mouse.up();
    await page.waitForFunction(()=>!window.atlasTestMap.isMoving());
    assert.notEqual((await state()).position,before.position);
    await page.locator('#reset').click();await page.locator('#close-record').click();
    return before;
  });
  await test('T-A2',async()=>{
    const checked=[];
    for (const [source,name] of [['hanson-cities','Rhome'],['hanson-cities','Roma'],['itinere','InLine_FID'],
      ['oxford-shipwrecks','Parker Number'],['oxford-karanis','P.Mich.'],['wikidata-history','Q1048'],['orbis-maritime',null]]) {
      let record,query;
      if (!name) {record=rows.find(r=>r.source===source && r.layers.includes('maritime'));query=record.id;}
      else if (['Roma','Rhome','Q1048'].includes(name)) {
        query=name; record=rows.find(r=>r.source===source && [r.label,...r.aliases||[]].includes(query));
        if (!record && name==='Rhome') {record=rows.find(r=>r.source==='pleiades' && r.aliases?.includes('Rhome'));}
      } else if (fixture) {record=rows.find(r=>r.source===source && r.aliases?.length);query=record.aliases[0];}
      else {
        for (const r of rows.filter(r=>r.source===source)) {
          const d=await detail(r),value=String((d.normalized_fields || d.native)[name] ?? '');
          if (value && r.aliases?.includes(value) && (name!=='InLine_FID' || value.length===1)) {record=r;query=value;break;}
        }
      }
      assert(record && query,'Missing example for '+name);
      await page.locator('#search-source').selectOption(record.source);await page.locator('#search').fill(query);
      const option=page.locator('#search-results [data-record="'+record.id+'"]');
      // Common native identifiers may refer to more than one record.
      await page.waitForTimeout(180);
      while (!await option.count() && await page.locator('#more-results').isVisible()) await page.locator('#more-results').click();
      await option.click(); await page.locator('#record-panel[data-loaded="'+record.id+'"]').waitFor();
      await page.locator('#close-record').click();assert(await page.locator('#search').evaluate(n=>n===document.activeElement));
      checked.push({source:record.source,field:name || 'route ID'});
    }
    return checked;
  });
  await test('T-A3',async()=>{
    const kinds=new Set();
    for (const row of rows) {
      if (kinds.has(row.render_kind)) continue;
      kinds.add(row.render_kind);await openRecord(page,row.id);
      const text=await body.innerText();assert(!/\[object Object\]|(?:^|\D)(0|42339|9999) CE\b/.test(text));
      assert(await body.getByText('Cite this source',{exact:true}).isVisible());
    }
    assert.equal(kinds.size,23);
    for (const d of release.datasets.filter(d=>d.group==='economy')) {
      await page.locator('#search').fill('');await page.locator('#search-source').selectOption(d.id);
      const archive=release.archives.find(a=>a.id===d.id);
      const count=archive?.record_count ?? rows.filter(r=>r.source===d.id).length;
      assert.equal(await page.locator('#search-status').textContent(),count+(count===1?' result':' results'));
      await page.locator('#search-results button').first().click();
      await page.locator('#record-panel[data-loaded]').waitFor();
    }
    for (const a of release.archives) {
      for (const way of ['sidebar','dropdown']) {
        if (way==='sidebar') await page.locator('[data-archive="'+a.id+'"]').click();
        else {await page.locator('#search').fill(''); await page.locator('#search-source').selectOption(''); await page.locator('#search-source').selectOption(a.id);}
        assert.equal(await page.locator('#search-status').textContent(),a.record_count+' results');
        for (const n of a.collection_notices) assert((await page.locator('#collection-notices').innerText()).includes(n.message));
        await page.locator('#more-results').click();
        const expected=rows.filter(r=>r.archive===a.id).sort((a,b)=>a.source_order-b.source_order).slice(0,50).map(r=>r.id);
        assert.deepEqual(await page.locator('#search-results button').evaluateAll(ns=>ns.map(n=>n.dataset.record)),expected);
      }
    }
    const aux=rows.filter(r=>r.render_kind==='economy_document_place' || r.id==='karanis:archive');
    assert.equal(aux.length,fixture?2:26);
    for (const row of aux) {
      await page.locator('#search-source').selectOption(row.source);await page.locator('#search').fill(row.id);
      await page.locator('#search-results [data-record="'+row.id+'"]').waitFor();
    }
    await openRecord(page,'shipwrecks:unmatched');
    assert.equal((await detail(rows.find(r=>r.id==='shipwrecks:unmatched'))).native.length,3);
    assert.equal(await body.locator(':scope > section > dl').count(),4);
    const data={amphorae:0,objects:0,presses:0,regnal:[],normalized:[],water:0};
    for (const r of rows.filter(r=>r.source.startsWith('oxford-'))) {
      const d=await detail(r);
      if (d.tables) {
        data.amphorae+=d.tables['Amphorae (Wreck ID)']?.length || 0;
        data.objects+=d.tables['Site objects (objloc = locid)']?.length || 0;
      }
      if (d.normalized_fields) {data.normalized.push(d.native.source_row); await openRecord(page,r.id);assert(await body.getByText('Normalized source fields').isVisible());}
      if (d.warnings?.some(w=>w.code==='karanis_regnal_42339')) {
        data.regnal.push(d.native.source_row); await openRecord(page,r.id);
        assert.equal(await body.locator('dt').filter({hasText:'Corrected into'}).count(),2);
        assert(await body.locator('[data-warning-code=karanis_regnal_42339]').isVisible());
      }
      if (d.render_kind==='economy_press_group') data.presses+=Number(d.native.presses||0);
      if (d.warnings?.some(w=>w.code==='water_lost_greek')) data.water++;
    }
    if (!fixture) assert.deepEqual(data,{amphorae:887,objects:2544,presses:760,regnal:[2584,2607,3446],normalized:[5,6],water:622});
    const economic=await page.evaluate(async()=>(await window.atlasTestMap.getSource('economy').getData()).features.map(f=>f.properties.category));
    assert.equal(new Set(economic).size,5);
    return {kinds:kinds.size,auxiliary:aux.length,...data};
  });
  await test('T-A4',async()=>{
    const edge=edges.find(e=>e.to==='pleiades:114765' && e.group==='economic_place');
    await openRecord(page,edge.from);await follow(page,'[data-related="'+edge.to+'"]');await follow(page,'[data-related="'+edge.from+'"]');
    await openRecord(page,'karanis:archive');
    const evidence=(await detail(rows.find(r=>r.id==='karanis:archive'))).crosswalk.evidence;
    const items=body.getByRole('list',{name:'Crosswalk evidence'}).getByRole('listitem');
    assert.equal(await items.count(),evidence.length);
    assert(evidence.length>0);
    for (const [i,{source,url,locator}] of evidence.entries()) {
      const item=items.nth(i), link=item.getByRole('link',{name:source,exact:true});
      assert.equal(await item.textContent(),source+' · '+locator);
      if (['http:','https:'].includes(URL.parse(url)?.protocol)) {
        assert.equal(await link.getAttribute('href'),new URL(url).href);
        assert.equal(await link.getAttribute('target'),'_blank');
        assert.equal(await link.getAttribute('rel'),'noopener noreferrer');
      } else assert.equal(await link.count(),0);
    }
    assert.doesNotMatch(await body.textContent(),/"(?:url|locator|source)"\s*:/);
    await body.getByRole('button',{name:/Browse .* transactions/}).click();
    assert.equal(await page.locator('#search-source').inputValue(),'oxford-karanis');
    await page.locator('#search-results button').first().click();
    await body.getByText('Collection archive (1 link)',{exact:true}).waitFor();
    await follow(page,'[data-related="karanis:archive"]');
    await openRecord(page,town.id);await page.locator('#close-record').click();
    const coord=await page.evaluate(async id=>{
      const m=window.atlasTestMap;const fc=await m.getSource('settlements').getData();
      const {x,y}=m.project(fc.features.find(f=>f.properties.record_id===id).geometry.coordinates);return {x,y};
    },town.id);
    await page.waitForFunction(()=>window.atlasTestMap.loaded());await page.locator('#map canvas').click({position:coord});
    assert.equal(await page.locator('#overlap-records button').first().getAttribute('data-record'),town.id);
    assert.equal(await page.locator('a[download],button[download]').count(),0);
    return {overlapFirst:town.id,place:edge.to,crosswalkEvidence:evidence.length};
  });
  await test('T-A10',async()=>{
    const people=rows.filter(r=>r.render_kind==='history_person');
    const counts=[rows.filter(r=>r.render_kind==='history_event').length,people.length,
      people.filter(r=>r.layers.includes('people')).length,people.filter(r=>r.layers.includes('people-biography')).length,
      people.filter(r=>r.layers.length===2).length,people.filter(r=>r.layers.length===1 && r.layers[0]==='people-biography').length];
    assert.deepEqual(counts,fixture?[1,2,1,2,1,1]:[324,1208,414,944,150,794]);
    await openRecord(page,'wikidata:Q1048');
    const highlight=()=>page.evaluate(async()=>(await window.atlasTestMap.getSource('selected-record').getData()).features.map(f=>f.geometry));
    const selection=await page.evaluate(()=>{
      const layers=window.atlasTestMap.getStyle().layers;
      const selected=layers.filter(l=>l.source==='selected-record');
      return {aboveData:layers.slice(layers.indexOf(selected[0])).every(l=>l.source==='selected-record'),
        layers:selected.map(l=>[l.id,l.paint])};
    });
    assert.deepEqual(selection,{aboveData:true,layers:[
      ['selected-point',{'circle-radius':7,'circle-color':'#f0e442','circle-stroke-color':'#111111','circle-stroke-width':2}],
      ['selected-line-casing',{'line-width':6,'line-color':'#111111'}],
      ['selected-line',{'line-width':3,'line-color':'#f0e442'}]]});
    assert.equal((await highlight()).length,2);await layer('people').uncheck();assert.equal((await highlight()).length,1);
    await layer('people-biography').uncheck();assert.equal((await highlight()).length,2);assert(await page.locator('#selection-notice').isVisible());
    await layer('people').check();await openRecord(page,'wikidata:Q1407');
    assert(await page.locator('#selection-notice').isVisible());await layer('people-biography').check();
    assert.equal(await page.locator('#selection-notice').isVisible(),false);
    const actium=rows.find(r=>r.layers.includes('events') && r.label.includes('Actium'));
    await openRecord(page,actium.id);
    const person=await follow(page,'[data-related^="wikidata:"]'); await follow(page,'[data-related="'+actium.id+'"]');
    await openRecord(page,town.id);await follow(page,'[data-related^="wikidata:"]');
    let supporting;
    for (const r of people) if ((await detail(r)).dated_supporting_events?.some(e=>!e.event_record_id)) {supporting=r;break;}
    assert(supporting); await openRecord(page,supporting.id);
    const item=(await detail(supporting)).dated_supporting_events.find(e=>!e.event_record_id);
    assert((await body.textContent()).includes(String(item.event_revision)));
    const section=body.locator('details').filter({has:page.getByText(item.event_label+' · '+item.event_qid,{exact:true})}).first();
    await section.locator('summary').first().click();
    for (const [prop,statements] of Object.entries(item.date_statements)) {
      const blocks=section.locator('details').filter({has:page.getByText(item.event_qid+' · '+prop+' · revision '+item.event_revision,{exact:true})});
      assert.equal(await blocks.count(),statements.length);
      await blocks.first().locator('summary').click();
      const visible=await blocks.first().innerText();assert(visible.includes(String(item.event_revision)));
      if (!statements[0].references?.length) assert(visible.includes('No source reference recorded'));
      else assert(visible.includes('Reference') && visible.includes('Evidence'));
    }
    assert((await body.textContent()).includes('Supporting dating events'));
    return {counts,actium:actium.id,person,supporting:supporting.id,selection};
  });
  await test('T-A7',async()=>{
    await page.locator('#close-record').click();await page.locator('#reset').click();
    let narrow;
    for (const width of [1280,390]) {
      await page.setViewportSize({width,height:width===390?844:800});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
      await checkGuide(page);
      if (width===390) {
        await page.evaluate(()=>window.scrollTo(0,0));
        const control=page.locator('#map .maplibregl-ctrl-attrib.maplibregl-compact');
        const button=control.locator('.maplibregl-ctrl-attrib-button');
        const credits=control.locator('.maplibregl-ctrl-attrib-inner');
        await button.waitFor();
        if (await control.evaluate(node=>node.classList.contains('maplibregl-compact-show'))) await button.click();
        await credits.waitFor({state:'hidden'});
        const bounds={};
        for (const state of ['collapsed','expanded']) {
          if (state==='expanded') {
            await button.click();
            await credits.waitFor();
          }
          assert.equal(await credits.isVisible(),state==='expanded');
          assert.equal(await control.evaluate(node=>node.classList.contains('maplibregl-compact-show')),state==='expanded');
          const map=await page.locator('#map').boundingBox(), b=await button.boundingBox();
          assert(b.width===44 && b.height===44);
          const panel=await control.boundingBox();
          for (const box of [b,panel]) {
            assert(box.x>=map.x && box.y>=map.y && box.x+box.width<=map.x+map.width && box.y+box.height<=map.y+map.height);
          }
          bounds[state]={button:b,panel,map};
        }
        await button.click();
        narrow={attributionBounds:bounds};
      }
      await shot(page,'map-'+width);
      if (width===1280) {
        await page.locator('[data-guide=datasets]').click();await shot(page,'dataset-guide');await page.keyboard.press('Escape');
      }
      await openRecord(page,'wikidata:Q1048');
      if (width===390) {
        const box=await page.locator('#record-panel').boundingBox();assert(Math.abs(box.y+box.height-844)<2);
        assert((await page.locator('#close-record').boundingBox()).height>=44);
        await page.locator('#close-record').click();
        const warningRow=rows.find(r=>r.render_kind==='economy_karanis_transaction');
        await openRecord(page,warningRow.id);
        Object.assign(narrow,await page.evaluate(() => ({
          warning:getComputedStyle(document.querySelector('.record-warnings')).display,
          attributionRepeat:getComputedStyle(document.querySelector('.maplibregl-ctrl-attrib-button')).backgroundRepeat,
          searchHeights:['#search','#search-source','#search-category'].map(s=>document.querySelector(s).getBoundingClientRect().height)
        })));
        assert.equal(narrow.warning,'block'); assert.equal(narrow.attributionRepeat,'no-repeat');
        assert(narrow.searchHeights.every(h=>h>=44));
        await shot(page,'narrow-detail');
        await page.locator('#close-record').click();
        const legend=page.locator('[data-group=economy] > span:visible');
        const categories=await page.locator('#economy-category option').evaluateAll(ns=>ns.map(n=>n.value).filter(Boolean));
        assert.equal(categories.length,5);
        for (const name of categories) {
          await page.locator('#economy-category').selectOption(name);
          assert.deepEqual(await legend.allTextContents(),[name]);
        }
        await page.locator('#economy-category').selectOption('');
        assert.deepEqual(await legend.allTextContents(),categories);
        narrow.legendCategories=categories;
        continue;
      }
      await page.locator('#close-record').click();
    }
    await page.setViewportSize({width:1280,height:800});await page.locator('#credits').evaluate(n=>n.closest('details').open=true);
    assert.equal(await page.locator('#credits > li').count(),16);
    assert.equal(await page.locator('#credits a:not([rel="noopener noreferrer"][target="_blank"])').count(),0);
    await page.locator('#credits').evaluate(n=>n.closest('details').open=false);
    return {widths:[1280,390],narrow,sourceCredits:16,guideChapters:13};
  });
}
