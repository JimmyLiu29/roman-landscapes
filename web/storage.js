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
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
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
    transaction.onerror = () => { db.close(); reject(transaction.error); };
  });
}

export function validateManifest(release) {
  if (release?.schema !== 1 || release.app_schema !== 1 || !/^[a-z0-9-]+$/.test(release.id)) {
    throw new Error('This data version needs a compatible application update or a new download of the current scope.');
  }
  if (!Array.isArray(release.files) || !release.files.length) throw new Error('Empty content package.');
  const paths = new Set();
  let total = 0;
  for (const file of release.files) {
    if (!file.path.startsWith(`packs/${release.id}/`) || !/^[a-zA-Z0-9_./-]+$/.test(file.path)
      || file.path.includes('..') || paths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)
      || !Number.isSafeInteger(file.bytes) || file.bytes <= 0) throw new Error('Invalid package manifest.');
    paths.add(file.path);
    total += file.bytes;
  }
  if (total !== release.bytes) throw new Error('Package size does not match the manifest.');
  const required = ['land.geojson', 'ocean.geojson', 'lakes.geojson', 'rivers.geojson', 'relief.pmtiles', 'sources.json'];
  if (paths.size !== required.length || required.some(name => !paths.has(`packs/${release.id}/${name}`))) {
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

export async function localFile(release, file) {
  const directory = await (await packageRoot()).getDirectoryHandle(release.storageDirectory);
  return (await directory.getFileHandle(file.sha256)).getFile();
}

export async function activeRelease(verifyHashes = false) {
  const active = await readState('active');
  if (!active) return null;
  validateManifest(active);
  for (const file of active.files) {
    const stored = await localFile(active, file);
    if (verifyHashes && await fileHash(stored) !== file.sha256) throw new Error('Saved map checksum mismatch. Remove and download the maps again.');
    if (stored.size !== file.bytes) throw new Error('Saved content is incomplete. Download the package again.');
  }
  return active;
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
    const completed = await readState('completed') || [];
    const active = await readState('active');
    // A committed active release survives even if bookkeeping was interrupted.
    const retained = new Set([...completed, active?.storageDirectory]);
    for await (const [name] of root.entries()) {
      if (!retained.has(name)) await root.removeEntry(name, { recursive: true });
    }
    await writeState('transfer', null);
  });
}

export async function downloadRelease(manifest, progress, signal) {
  validateManifest(manifest);
  return locked(async () => {
    const estimate = await navigator.storage.estimate();
    const required = manifest.bytes * 1.15 + 4 * 1024 * 1024;
    if (estimate.quota && estimate.quota - (estimate.usage || 0) < required) {
      throw new Error('Not enough browser storage. Existing offline content has been kept.');
    }
    const root = await packageRoot();
    const name = `download-${crypto.randomUUID()}`;
    const directory = await root.getDirectoryHandle(name, { create: true });
    await writeState('transfer', { id: manifest.id, directory: name, received: 0 });
    let received = 0;
    let committed = false;
    try {
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
            progress?.({ received, total: manifest.bytes, file: file.path });
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
      }
      const active = { ...manifest, storageDirectory: name };
      // This single IndexedDB transaction is the activation point.
      const completed = await readState('completed') || [];
      signal?.throwIfAborted();
      await writeStates({ active, completed: [...completed, name], transfer: null });
      committed = true;
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
    new BroadcastChannel('atlas-storage').postMessage('removed');
  });
}
