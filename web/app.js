import { mountFoundation } from './foundation.js';
import * as maplibregl from './vendor/maplibre-gl/maplibre-gl.mjs';
import { activeRelease, downloadRelease, fileHash, localFile, readState, recoverDownloads,
  removeDownloads, validateManifest, writeState } from './storage.js';

maplibregl.setWorkerUrl('/vendor/maplibre-gl/maplibre-gl-worker.mjs');
const $ = selector => document.querySelector(selector);
const protocol = new pmtiles.Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);
let map, release, saved, abort, registration, installPrompt;
let natural = true;
const region = [[-17, 15], [55, 63]];

function status(message, error = false) {
  $('#storage-status').textContent = message;
  $('#storage-status').dataset.error = error;
}

function mode(value) {
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
  if (!response.ok) throw new Error('Map content is unavailable. Reconnect and open the atlas again.');
  const blob = await response.blob();
  if (blob.size !== file.bytes || await fileHash(blob) !== file.sha256) throw new Error('Map checksum mismatch.');
  return new File([blob], file.sha256);
}

async function render() {
  const source = new pmtiles.FileSource(await content('relief.pmtiles'));
  protocol.add(new pmtiles.PMTiles(source));
  const [land, rivers, lakes, ocean, sources] = await Promise.all(
    ['land.geojson', 'rivers.geojson', 'lakes.geojson', 'ocean.geojson', 'sources.json']
      .map(async name => JSON.parse(await (await content(name)).text())));
  const visibility = natural ? 'visible' : 'none';
  map = new maplibregl.Map({
    container: 'map', bounds: region, fitBoundsOptions: { padding: 16 }, minZoom: 2, maxZoom: 7,
    maxBounds: [[release.bounds[0], release.bounds[1]], [release.bounds[2], release.bounds[3]]],
    renderWorldCopies: false, attributionControl: true, fadeDuration: 0, dragRotate: false, pitchWithRotate: false, maxPitch: 0,
    style: {
      version: 8,
      sources: {
        land: { type: 'geojson', data: land }, ocean: { type: 'geojson', data: ocean },
        lakes: { type: 'geojson', data: lakes }, rivers: { type: 'geojson', data: rivers },
        relief: { type: 'raster', url: `pmtiles://${source.getKey()}`, tileSize: 256,
          attribution: '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a>' }
      },
      layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#bed6d9' } },
        { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': '#ecebdc' } },
        { id: 'relief', type: 'raster', source: 'relief', layout: { visibility }, paint: { 'raster-opacity': 0.68, 'raster-saturation': -1 } },
        { id: 'ocean', type: 'fill', source: 'ocean', paint: { 'fill-color': '#bed6d9' } },
        { id: 'coast', type: 'line', source: 'land', paint: { 'line-color': '#9cafaa', 'line-width': 0.65 } },
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
  await mountFoundation(map,release,async name => {
    const file=await content(name);
    const stream=file.stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).json();
  },await readState('layers').catch(()=>null),layers=>writeState('layers',layers).catch(()=>{}));
  const ready=()=>{ $('#map').dataset.ready=String($('#map-error').hidden); };
  map.on('idle',ready);
  if (map.loaded()) ready();
  $('#reset').disabled=false; coordinates();
  const names = { relief: 'Shaded Relief', land: 'Land', rivers: 'Rivers and Lake Centerlines', lakes: 'Lakes' };
  for (const record of sources.sources) {
    const link = document.createElement('a');
    link.href = record.landing_url || record.url;
    link.textContent = (record.label || names[record.id.replace('natural-earth-', '')]) + ' · ' + (record.archive_version || record.version);
    const row = document.createElement('li');
    row.append(link);
    $('#credits').append(row);
  }
  $('#reset').onclick = () => map.fitBounds(region, { padding: 16, duration: 0, bearing: 0 });
}

function packageControls() {
  $('#download').textContent = saved ? 'Verify saved maps' : 'Enable offline use';
  $('#remove').hidden = !saved;
  $('#package-description').textContent = `Maps and selected datasets · ${(release.bytes / 1048576).toFixed(1)} MiB`;
}
for (const radio of document.querySelectorAll('[name=mode]')) {
  radio.onchange = () => { mode(radio.value); writeState('mode', radio.value).catch(() => {}); };
}
$('#cancel').onclick = () => abort?.abort();
$('#download').onclick = async () => {
  $('#download').disabled = $('#remove').disabled = true;
  try {
    if (saved) {
      if (!await activeRelease(true)) throw new Error('The saved maps were removed.');
      status('All saved map files passed SHA-256 verification.');
    } else {
      abort = new AbortController();
      $('#cancel').hidden = $('#progress').hidden = false;
      $('#progress').value = 0;
      await navigator.storage.persist?.();
      saved = await downloadRelease(release, ({ received, total }) => {
        $('#progress').max = total; $('#progress').value = received;
      }, abort.signal);
      packageControls();
      status('Both maps are verified and ready offline.');
    }
  } catch (error) {
    status(error.name === 'AbortError' ? 'Download cancelled.' : error.message, true);
  } finally {
    $('#cancel').hidden = $('#progress').hidden = true;
    $('#download').disabled = $('#remove').disabled = false;
  }
};
function removed() {
  saved = null;
  packageControls();
  status('Saved maps removed from this browser.');
}
new BroadcastChannel('atlas-storage').onmessage = removed;
$('#remove').onclick = async () => {
  try { await removeDownloads(); removed(); } catch (error) { status(error.message, true); }
};
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault(); installPrompt = event; $('#install').hidden = false;
});
$('#install').onclick = async () => { await installPrompt?.prompt(); $('#install').hidden = true; };
$('#update-app').onclick = () => {
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  registration.waiting?.postMessage('activate');
};

async function start() {
  let storageError;
  try { await recoverDownloads(); saved = await activeRelease(true); }
  catch (error) { storageError = error; }
  if (saved) release = saved;
  else {
    const response = await fetch('/release.json');
    if (!response.ok) throw new Error('Connect to load the atlas or enable offline maps first.');
    release = validateManifest(await response.json());
  }
  mode(await readState('mode').catch(() => null) === 'simple' ? 'simple' : 'natural');
  packageControls();
  await render();
  try {
    registration = await navigator.serviceWorker.register('/sw.js');
    const check = () => { $('#update-app').hidden = !registration.waiting; };
    registration.addEventListener('updatefound', () => registration.installing?.addEventListener('statechange', check));
    check();
    await navigator.serviceWorker.ready;
    $('#download').disabled = false;
    status(storageError?.message || (saved ? 'Both maps are verified and ready offline.' : 'Save the full region for use without a connection.'), !!storageError);
  } catch { status('Offline storage is unavailable in this browser.', true); }
}
start().catch(error => { $('#map-error').textContent = error.message; $('#map-error').hidden = false; });
