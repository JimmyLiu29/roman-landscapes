import { element } from './details.js';
import { mountFoundation } from './foundation.js';
import * as maplibregl from './vendor/maplibre-gl/maplibre-gl.mjs';
import { activeRelease, downloadRelease, fileHash, localFile, readState, recoverDownloads,
  removeDownloads, storedContentStatus, tabId, validateManifest, writeState } from './storage.js';

maplibregl.setWorkerUrl('/vendor/maplibre-gl/maplibre-gl-worker.mjs');
const $ = selector => document.querySelector(selector);
const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);
let map, release, saved, abort, registration, installPrompt;
let natural = true, modeChosen = false, hasStoredContent = false, latest, offlineRemoved = false;
const viewBounds = [[-27, 8], [65, 67]];
const naturalCredit = '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener noreferrer">Natural Earth</a>';
const region = [[-17, 15], [55, 63]];

function status(message, error = false) {
  $('#storage-status').textContent = message;
  $('#storage-status').dataset.error = error;
}

function mode(value) {
  if (!['natural','simple'].includes(value) || (offlineRemoved && value==='natural')) return;
  natural = value === 'natural';
  for (const id of ['relief', 'rivers', 'lakes']) {
    if (map?.getLayer(id)) map.setLayoutProperty(id, 'visibility', natural ? 'visible' : 'none');
  }
  $('#mode-caption').textContent = natural ? 'Natural' : 'Simple';
  document.querySelectorAll('[data-natural]').forEach(item => { item.hidden = !natural; });
  document.querySelector(`input[value="${value}"]`).checked = true;
}

async function content(name) {
  const file = release.files.find(entry => entry.path.endsWith('/' + name));
  if (saved) return localFile(saved, file);
  const response = await fetch('/' + file.path);
  if (response.status === 404 && name.startsWith('details-')) {
    const error = new Error('A newer atlas release is online. Reload to open this record.');
    error.status = 404;
    throw error;
  }
  if (!response.ok) throw new Error('Map content is unavailable. Reconnect and open the atlas again.');
  const blob = await response.blob();
  if (blob.size !== file.bytes || await fileHash(blob) !== file.sha256) throw new Error('Map checksum mismatch.');
  return new File([blob], file.sha256);
}

async function render() {
  let reliefFile=await content('relief.pmtiles');
  // Keep the live raster readable during a replacement or removal in another tab.
  if (saved) reliefFile=new File([await reliefFile.arrayBuffer()],reliefFile.name);
  const source = new pmtiles.FileSource(reliefFile);
  protocol.add(new pmtiles.PMTiles(source));
  const [land, rivers, lakes, ocean, sources] = await Promise.all(
    ['land.geojson', 'rivers.geojson', 'lakes.geojson', 'ocean.geojson', 'sources.json']
      .map(async name => JSON.parse(await (await content(name)).text())));
  const coast = release.files.some(f=>f.path.endsWith('/coast.geojson'))
    ? JSON.parse(await (await content('coast.geojson')).text()) : land;
  const visibility = natural ? 'visible' : 'none';
  map = new maplibregl.Map({
    container: 'map', bounds: region, fitBoundsOptions: { padding: 16 }, minZoom: 1, maxZoom: 7,
    maxBounds: viewBounds,
    renderWorldCopies: false, attributionControl: true, fadeDuration: 0, dragRotate: false, pitchWithRotate: false, maxPitch: 0,
    style: {
      version: 8,
      sources: {
        land: { type: 'geojson', data: land, attribution: naturalCredit }, coast: {type:'geojson', data:coast}, ocean: { type: 'geojson', data: ocean },
        lakes: { type: 'geojson', data: lakes }, rivers: { type: 'geojson', data: rivers },
        relief: { type: 'raster', url: `pmtiles://${source.getKey()}`, tileSize: 256,
          attribution: naturalCredit }
      },
      layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#bed6d9' } },
        { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': '#ecebdc' } },
        { id: 'relief', type: 'raster', source: 'relief', layout: { visibility }, paint: { 'raster-opacity': 0.68, 'raster-saturation': -1 } },
        { id: 'ocean', type: 'fill', source: 'ocean', paint: { 'fill-color': '#bed6d9' } },
        { id: 'coast', type: 'line', source: 'coast', paint: { 'line-color': '#9cafaa', 'line-width': 0.65 } },
        { id: 'lakes', type: 'fill', source: 'lakes', layout: { visibility }, paint: { 'fill-color': '#96bbc3' } },
        { id: 'rivers', type: 'line', source: 'rivers', layout: { visibility }, paint: { 'line-color': '#679dad', 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.3, 6, 0.8] } }
      ]
    }
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 90 }), 'bottom-left');
  function coordinates() {
    const { lng, lat } = map.getCenter();
    $('#coordinates').textContent = `${Math.abs(lng).toFixed(2)}°${lng < 0 ? 'W' : 'E'}  ${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}  ·  z${map.getZoom().toFixed(2)}`;
  }
  map.on('move', coordinates);
  map.on('error', event => {
    $('#map-error').textContent = event.error?.message || 'Map rendering failed.';
    $('#map-error').hidden = false;
  });
  await new Promise(resolve => map.once('load',resolve));
  mode(natural ? 'natural' : 'simple');
  await mountFoundation(map,release,async name => {
    const file=await content(name);
    const stream=file.stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).json();
  },await readState('layers').catch(()=>null),layers=>writeState('layers',layers).catch(()=>{}),
    new Map(sources.sources.map(source=>[source.id,source])),reloadAtlas);
  const ready=()=>{ $('#map').dataset.ready=String($('#map-error').hidden); };
  map.on('idle',ready);
  if (map.loaded()) ready();
  $('#reset').disabled=false; coordinates();
  const names = { relief: 'Shaded Relief', land: 'Land', rivers: 'Rivers and Lake Centerlines', lakes: 'Lakes' };
  for (const record of sources.sources) {
    const row = element('li');
    const label = record.label || names[record.id.replace('natural-earth-', '')];
    row.append(externalLink(record.landing_url, label + ' · ' + (record.archive_version || record.version)),
      element('p',record.citation),element('p',record.terms),externalLink(record.terms_url,'Source terms'));
    if (record.endpoint_rule) row.append(element('p',record.endpoint_rule));
    if (record.notice) {
      const notice = element('details');
      notice.append(element('summary','License notice'),element('pre',record.notice));
      row.append(notice);
    }
    $('#credits').append(row);
  }
  $('#reset').onclick = () => map.fitBounds(region, { padding: 16, duration: 0, bearing: 0 });
}

function externalLink(url, text) {
  let target;
  try { target=new URL(url); } catch { return element('span',text); }
  if (!['http:','https:'].includes(target.protocol)) return element('span',text);
  const link=element('a',text);
  link.href=target.href; link.target='_blank'; link.rel='noopener noreferrer';
  return link;
}

function size(bytes) {
  return bytes.toLocaleString('en-US')+' bytes ('+(bytes/1048576).toFixed(1)+' MiB)';
}

function packageControls() {
  $('#download').textContent = saved ? 'Verify saved maps' : 'Enable offline use';
  $('#remove').hidden = !hasStoredContent;
  $('#update-maps').hidden = !saved || !latest || latest.id===saved.id;
  if (release) $('#package-description').textContent = release.id+' · '+size(release.bytes)
    + ($('#update-maps').hidden ? '' : ' · Available: '+latest.id+' · '+size(latest.bytes));
}

for (const radio of document.querySelectorAll('[name=mode]')) {
  radio.onchange = () => { modeChosen=true; mode(radio.value); writeState('mode', radio.value).catch(() => {}); };
}
$('#cancel').onclick = () => abort?.abort();

async function transfer(manifest, update) {
  abort = new AbortController();
  $('#cancel').hidden = $('#progress').hidden = false;
  $('#progress').value = 0;
  const persistent = await navigator.storage.persist?.();
  saved = await downloadRelease(manifest, ({ received, total, files }) => {
    $('#progress').max = total; $('#progress').value = received;
    status(files+' / '+manifest.files.length+' files · '+(received/1048576).toFixed(1)+' / '+(total/1048576).toFixed(1)+' MiB');
  }, abort.signal);
  hasStoredContent = true;
  packageControls();
  status('Both maps are verified and ready offline.' + (persistent===false ? ' The browser may evict offline data under storage pressure.' : ''));
  if (update) location.reload();
}

async function runAction(action) {
  $('#download').disabled = $('#update-maps').disabled = $('#remove').disabled = true;
  try { await action(); }
  catch (error) {
    status(error.name === 'AbortError' ? 'Download cancelled.' : error.message, true);
    hasStoredContent = await storedContentStatus().catch(()=>hasStoredContent);
    packageControls();
  } finally {
    abort=null;
    $('#cancel').hidden = $('#progress').hidden = true;
    $('#download').disabled = $('#update-maps').disabled = $('#remove').disabled = false;
  }
}

$('#download').onclick = () => runAction(async () => {
  if (!saved) return transfer(release, false);
  if (!await activeRelease(true)) throw new Error('The saved maps were removed.');
  status('All saved map files passed SHA-256 verification.');
});
$('#update-maps').onclick = () => runAction(()=>transfer(latest, true));

async function networkManifest() {
  if (!navigator.onLine) return null;
  try {
    const response=await fetch('/release.json?check=1',{cache:'no-store',signal:AbortSignal.timeout(5000)});
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

async function removed() {
  saved=null; latest=null; hasStoredContent=false;
  packageControls();
  if (await networkManifest()) { location.reload(); return; }
  offlineRemoved=true; mode('simple'); $('input[value=natural]').disabled=true;
  if (map?.getLayer('relief')) map.removeLayer('relief');
  if (map?.getSource('relief')) map.removeSource('relief');
  $('#download').disabled=true;
  status('Saved maps removed. Reconnect and reload to use the full atlas.');
}

new BroadcastChannel('atlas-storage').onmessage = ({data:message}) => {
  if (message?.sender===tabId) return;
  const data=message?.event ?? message;
  if (data==='removed') removed();
  else if (saved && data.directory!==saved.storageDirectory) location.reload();
  else if (!saved && data.active) location.reload();
};
$('#remove').onclick = async () => {
  $('#remove').disabled=true;
  try { await removeDownloads(); await removed(); } catch (error) { status(error.message, true); }
  finally { $('#remove').disabled=false; }
};

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault(); installPrompt = event; $('#install').hidden = false;
});
$('#install').onclick = async () => { await installPrompt?.prompt(); $('#install').hidden = true; };
function reloadAtlas() {
  $('#update-app').disabled=true;
  if (!registration?.waiting) { location.reload(); return; }
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  registration.waiting.postMessage('activate');
}
$('#update-app').onclick = reloadAtlas;

async function checkForUpdate() {
  try {
    const candidate=await networkManifest();
    if (candidate) { latest=validateManifest(candidate); packageControls(); }
  } catch { /* The saved release remains available offline. */ }
}

async function start() {
  let storageError;
  try {
    registration = await navigator.serviceWorker.register('/sw.js');
    const check = () => { $('#update-app').hidden = !registration.waiting; };
    const watch = () => { registration.installing?.addEventListener('statechange',check); check(); };
    registration.addEventListener('updatefound',watch); watch();
  } catch { /* The online atlas also works without a service worker. */ }
  try { await recoverDownloads(); } catch { /* A concurrent transfer owns its staging directory. */ }
  hasStoredContent=await storedContentStatus().catch(()=>false);
  packageControls();
  try { saved = await activeRelease(); }
  catch (error) { storageError=error; status(error.message,true); }
  if (saved) release=saved;
  else {
    if (storageError && !await networkManifest()) throw storageError;
    try {
      const response=await fetch('/release.json');
      if (!response.ok) throw new Error('Connect to load the atlas or enable offline maps first.');
      release=validateManifest(await response.json());
    } catch (error) { throw storageError || error; }
  }
  const preference=await readState('mode').catch(()=>null);
  if (!modeChosen) mode(preference==='simple'?'simple':'natural');
  packageControls();
  if (saved && navigator.onLine) void checkForUpdate();
  try { await render(); } catch (error) { throw storageError || error; }
  if (registration) {
    await navigator.serviceWorker.ready;
    $('#download').disabled=false;
    status(storageError?.message || (saved ? 'Saved maps are ready offline.' : 'Save the full region for use without a connection.'), !!storageError);
    if (saved && await navigator.storage.persisted?.()===false && !storageError) {
      status('Saved maps are ready offline. The browser may evict offline data under storage pressure.');
    }
  } else if (!storageError) status('Offline storage is unavailable in this browser.',true);
}

start().catch(error => {
  status(error.message,true);
  $('#map-error').textContent=error.message; $('#map-error').hidden=false;
});
