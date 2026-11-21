import { registry } from './layers.js';
const SUPPORTED_APP_SCHEMAS = new Set([1]);
const DB = 'roman-atlas';
const STORE = 'state';
const ROOT = 'atlas-packages';

function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readState(key) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE);
    const request = transaction.objectStore(STORE).get(key);
    transaction.oncomplete = () => { db.close(); resolve(request.result); };
    transaction.onerror = transaction.onabort = () => {
      db.close();
      reject(transaction.error || new DOMException('IndexedDB transaction aborted', 'AbortError'));
    };
  });
}

export async function writeState(key, value) {
  return writeStates({ [key]: value });
}

async function writeStates(values) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    for (const [key, value] of Object.entries(values)) transaction.objectStore(STORE).put(value, key);
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = transaction.onabort = () => {
      db.close();
      reject(transaction.error || new DOMException('IndexedDB transaction aborted', 'AbortError'));
    };
  });
}

export function validateManifest(release) {
  if (release?.schema !== 1 || !SUPPORTED_APP_SCHEMAS.has(release.app_schema) || typeof release.id !== 'string' || !/^[a-z0-9-]+$/.test(release.id)) {
    throw new Error('This data version needs a compatible application update or a new download of the current scope.');
  }
  if (!Array.isArray(release.files) || !release.files.length) throw new Error('Empty content package.');
  if (!Array.isArray(release.scope) || release.scope.some(s => typeof s !== 'string')
      || (release.datasets !== undefined && (!Array.isArray(release.datasets)
          || release.datasets.some(d => typeof d?.id !== 'string' || typeof d.label !== 'string')))) {
    throw new Error('Invalid package scope or datasets.');
  }
  const paths = new Set();
  let total = 0;
  for (const file of release.files) {
    if (typeof file?.path !== 'string' || !file.path.startsWith(`packs/${release.id}/`) || !/^[a-zA-Z0-9_./-]+$/.test(file.path)
      || file.path.split('/').some(part => !part || part === '.') || typeof file.sha256 !== 'string'
      || file.path.includes('..') || paths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.bytes) || file.bytes <= 0) throw new Error('Invalid package manifest.');
    paths.add(file.path);
    total += file.bytes;
  }
  if (total !== release.bytes) throw new Error('Package size does not match the manifest.');
  const required = ['land.geojson', 'ocean.geojson', 'lakes.geojson', 'rivers.geojson', 'relief.pmtiles', 'sources.json'];
  const {datasets,groups}=registry(release);
  const active=datasets.map(dataset=>dataset.id);
  if (active.length) required.push('catalog.json.gz','relations.json.gz',
    ...groups.flatMap(group=>group.sources.map(source=>source.id+'.geojson.gz')));
  const names=[...paths].map(path=>path.slice(('packs/'+release.id+'/').length));
  if (required.some(name=>!names.includes(name))
      || active.some(source=>!names.some(name=>name.startsWith('details-'+source+'-')))) {
    throw new Error('Unexpected map package contents.');
  }
  return release;
}

export async function fileHash(file) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function packageRoot() {
  if (!navigator.storage?.getDirectory) throw new Error('Offline files are unavailable in this browser.');
  return (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create: true });
}

function storageFailure(cause) {
  if (['NotFoundError', 'NotReadableError', 'TypeMismatchError'].includes(cause.name)) {
    return new Error('Browser storage was cleared or damaged. Remove the saved maps and reconnect to download them again.', {cause});
  }
  return cause;
}

export async function localFile(release, file) {
  try {
    const directory = await (await packageRoot()).getDirectoryHandle(release.storageDirectory);
    return await (await directory.getFileHandle(file.sha256)).getFile();
  } catch (cause) {
    throw storageFailure(cause);
  }
}

export async function storedContentStatus() {
  const states = await Promise.all(['active', 'completed', 'transfer'].map(readState));
  if (states[0] || states[1]?.length || states[2]) return true;
  for await (const name of (await packageRoot()).keys()) return true;
  return false;
}

export async function activeRelease(verifyHashes = false) {
  const active = await readState('active');
  if (!active) return null;
  validateManifest(active);
  if (typeof active.storageDirectory !== 'string' || !/^download-[a-z0-9-]+$/.test(active.storageDirectory)) {
    throw new Error('Invalid saved map directory. Remove the saved maps and download them again.');
  }
  for (const file of active.files) {
    const stored = await localFile(active, file);
    if (stored.size !== file.bytes) throw new Error('Saved content is incomplete. Remove the maps and download them again.');
    if (verifyHashes && await fileHash(stored).catch(cause => { throw storageFailure(cause); }) !== file.sha256) throw new Error('Saved map checksum mismatch. Remove and download the maps again.');
  }
  return active;
}

async function verifyContents(release, directory, signal) {
  const prefix = 'packs/' + release.id + '/';
  const names = new Set(release.files.map(f => f.path.slice(prefix.length)));
  for (const entry of release.files) {
    if (!entry.path.endsWith('.gz')) continue;
    signal?.throwIfAborted();
    const name = entry.path.slice(prefix.length);
    const file = await (await directory.getFileHandle(entry.sha256)).getFile();
    const response = new Response(file.stream().pipeThrough(new DecompressionStream('gzip')));
    try {
      if (!name.endsWith('.json.gz') && !name.endsWith('.geojson.gz')) {
        await response.arrayBuffer();
        continue;
      }
      const data = await response.json();
      if (name === 'catalog.json.gz' && (!Array.isArray(data.records)
          || data.records.some(r => typeof r?.detail !== 'string' || !r.detail.endsWith('.json.gz') || !names.has(r.detail)))) {
        throw new Error('Missing detail shard.');
      }
    } catch (cause) {
      throw new Error('Invalid compressed package content or missing detail shard: ' + name, {cause});
    }
  }
}

function digests(release) {
  return release.files.map(f => f.path + ':' + f.sha256).sort().join(' ');
}

export const tabId = crypto.randomUUID();
function broadcast(event) {
  const channel = new BroadcastChannel('atlas-storage');
  channel.postMessage({sender: tabId, event});
  channel.close();
}

async function prune(root, retained) {
  for await (const name of root.keys()) {
    if (name !== retained) await root.removeEntry(name, {recursive: true});
  }
}

async function locked(operation) {
  if (!navigator.locks) throw new Error('Safe offline downloads are unavailable in this browser.');
  return navigator.locks.request('atlas-download', { ifAvailable: true }, lock => {
    if (!lock) throw new Error('Another atlas tab is updating offline content.');
    return operation();
  });
}

export async function recoverDownloads() {
  return locked(async () => {
    const root = await packageRoot();
    const active = await readState('active');
    await prune(root, active?.storageDirectory);
    await writeStates({completed: active ? [active.storageDirectory] : [], transfer: null});
  });
}

export async function downloadRelease(manifest, progress, signal) {
  validateManifest(manifest);
  return locked(async () => {
    const previous = await activeRelease();
    if (previous?.id === manifest.id && digests(previous) === digests(manifest)) {
      return await activeRelease(true);
    }
    const estimate = await navigator.storage.estimate();
    const required = manifest.bytes * 1.15 + 4 * 1024 * 1024;
    if (Number.isFinite(estimate.quota) && estimate.quota - (estimate.usage || 0) < required) {
      throw new Error('Not enough browser storage. Existing offline content has been kept.');
    }
    const root = await packageRoot();
    const name = `download-${crypto.randomUUID()}`;
    const directory = await root.getDirectoryHandle(name, { create: true });
    let files = 0;
    let received = 0;
    let committed = false;
    try {
      await writeState('transfer', { id: manifest.id, directory: name, received: 0 });
      for (const file of manifest.files) {
        signal?.throwIfAborted();
        const response = await fetch(`/${file.path}`, { cache: 'no-store', signal });
        if (!response.ok || response.status === 206) throw new Error('A complete content file could not be downloaded.');
        const handle = await directory.getFileHandle(file.sha256, { create: true });
        const writer = await handle.createWritable();
        let size = 0;
        try {
          const reader = response.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > file.bytes) { await reader.cancel(); throw new Error('Downloaded content exceeds its declared size.'); }
            await writer.write(value);
            received += value.length;
            progress?.({ received, total: manifest.bytes, files, file: file.path });
          }
          await writer.close();
        } catch (error) {
          await writer.abort().catch(() => {});
          throw error;
        }
        if (size !== file.bytes) throw new Error('Content download was incomplete.');
        const stored = await handle.getFile();
        const hash = await fileHash(stored);
        if (hash !== file.sha256) throw new Error('Content checksum failed. Existing offline content has been kept.');
        files++;
        progress?.({received, total: manifest.bytes, files, file: file.path});
      }
      await verifyContents(manifest, directory, signal);
      const active = { ...manifest, storageDirectory: name };
      // This single IndexedDB transaction is the activation point.
      signal?.throwIfAborted();
      await writeStates({ active, completed: [name], transfer: null });
      committed = true;
      broadcast({active: active.id, directory: name});
      // An interrupted cleanup is retried under the lock at the next startup.
      await prune(root, name).catch(() => {});
      return active;
    } catch (error) {
      if (!committed) await root.removeEntry(name, { recursive: true }).catch(() => {});
      await writeState('transfer', null).catch(() => {});
      throw error;
    }
  });
}

export async function removeDownloads() {
  return locked(async () => {
    await writeStates({ active: null, completed: [], transfer: null });
    const root = await packageRoot();
    for await (const [name] of root.entries()) await root.removeEntry(name, { recursive: true });
    broadcast('removed');
  });
}
