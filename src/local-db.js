import { nowIso, uid } from './utils.js';

const DB_NAME = 'travel_memo_v2';
const DB_VERSION = 3;

let dbPromise;

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      createStore(db, 'memos', { keyPath: 'id' }, [
        ['by_trip', 'trip_id', { unique: false }],
        ['by_visited', 'visited_at', { unique: false }],
        ['by_sync', 'sync_status', { unique: false }]
      ]);
      createStore(db, 'trips', { keyPath: 'id' }, [
        ['by_status', 'status', { unique: false }],
        ['by_sync', 'sync_status', { unique: false }]
      ]);
      createStore(db, 'photos', { keyPath: 'id' }, [
        ['by_memo', 'memo_id', { unique: false }],
        ['by_trip', 'trip_id', { unique: false }],
        ['by_sync', 'sync_status', { unique: false }]
      ]);
      createStore(db, 'settings', { keyPath: 'key' });
      createStore(db, 'syncQueue', { keyPath: 'id' }, [
        ['by_entity', 'entity', { unique: false }],
        ['by_created', 'created_at', { unique: false }]
      ]);
      createStore(db, 'profiles', { keyPath: 'id' });
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function createStore(db, name, options, indexes = []) {
  if (db.objectStoreNames.contains(name)) return;
  const store = db.createObjectStore(name, options);
  indexes.forEach(([indexName, keyPath, indexOptions]) => store.createIndex(indexName, keyPath, indexOptions));
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeTx(storeName, mode = 'readonly') {
  const db = await openDatabase();
  const tx = db.transaction(storeName, mode);
  return { tx, store: tx.objectStore(storeName) };
}

export async function initDb() {
  await openDatabase();
}

export async function getAll(storeName) {
  const { store } = await storeTx(storeName);
  return promisify(store.getAll());
}

export async function get(storeName, id) {
  const { store } = await storeTx(storeName);
  return promisify(store.get(id));
}

export async function put(storeName, value) {
  const { store } = await storeTx(storeName, 'readwrite');
  await promisify(store.put(value));
  return value;
}

export async function putMany(storeName, values = []) {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    values.forEach((value) => store.put(value));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return values;
}

export async function remove(storeName, id) {
  const { store } = await storeTx(storeName, 'readwrite');
  return promisify(store.delete(id));
}

export async function clear(storeName) {
  const { store } = await storeTx(storeName, 'readwrite');
  return promisify(store.clear());
}

export async function clearAllData() {
  const stores = ['memos', 'trips', 'photos', 'settings', 'syncQueue', 'profiles'];
  await Promise.all(stores.map((store) => clear(store)));
}

export async function getByIndex(storeName, indexName, value) {
  const { store } = await storeTx(storeName);
  const index = store.index(indexName);
  return promisify(index.getAll(value));
}

export async function setSetting(key, value) {
  return put('settings', { key, value, updated_at: nowIso() });
}

export async function getSetting(key, fallback = null) {
  const record = await get('settings', key);
  return record ? record.value : fallback;
}


function entityStoreName(entity) {
  if (entity === 'trip' || entity === 'trips') return 'trips';
  if (entity === 'memo' || entity === 'memos') return 'memos';
  if (entity === 'photo' || entity === 'photos') return 'photos';
  return null;
}

function isSharedLocalRecord(record) {
  return Boolean(record?.shared_access === true || record?.access_level === 'shared' || record?.sync_scope === 'shared');
}

async function getQueueOwnerMeta(entity, entityId, payload = {}) {
  const store = entityStoreName(entity);
  if (!store || !entityId) {
    return { user_id: payload?.user_id || null, record_user_id: payload?.user_id || null, shared_access: false };
  }
  const record = await get(store, entityId).catch(() => null);
  return {
    user_id: payload?.user_id || record?.user_id || null,
    record_user_id: record?.user_id || payload?.user_id || null,
    shared_access: isSharedLocalRecord(record),
    access_level: record?.access_level || null
  };
}

export async function queueSync(action, entity, entityId, payload = {}) {
  const meta = await getQueueOwnerMeta(entity, entityId, payload);
  if (meta.shared_access) {
    return {
      id: null,
      action,
      entity,
      entity_id: entityId,
      skipped: true,
      reason: 'shared-records-are-read-only'
    };
  }

  const queue = await getAll('syncQueue');
  const eventHash = `${action}:${entity}:${entityId}:${JSON.stringify(payload || {})}`;
  const existing = queue.find((item) => item.action === action && item.entity_id === entityId);
  if (existing) {
    const updated = {
      ...existing,
      entity,
      user_id: existing.user_id || meta.user_id || null,
      record_user_id: meta.record_user_id || existing.record_user_id || null,
      payload: { ...(existing.payload || {}), ...(payload || {}) },
      status: existing.status === 'syncing' ? 'retrying' : 'pending',
      event_hash: eventHash,
      last_error: null,
      updated_at: nowIso()
    };
    await put('syncQueue', updated);
    return updated;
  }

  const item = {
    id: uid('sync'),
    action,
    entity,
    entity_id: entityId,
    user_id: meta.user_id || null,
    record_user_id: meta.record_user_id || null,
    payload,
    status: 'pending',
    attempts: 0,
    retry_count: 0,
    last_error: null,
    last_attempt_at: null,
    event_hash: eventHash,
    created_at: nowIso(),
    updated_at: nowIso()
  };
  await put('syncQueue', item);
  return item;
}

export async function getQueueSummary() {
  const queue = await getAll('syncQueue');
  const failed = queue.filter((item) => item.last_error || item.status === 'failed').length;
  return {
    total: queue.length,
    failed,
    pending: queue.length - failed,
    attempts: queue.reduce((sum, item) => sum + Number(item.attempts || 0), 0)
  };
}

export async function markSynced(storeName, id, extra = {}) {
  const item = await get(storeName, id);
  if (!item) return null;
  const updated = {
    ...item,
    ...extra,
    sync_status: 'synced',
    last_synced_at: nowIso(),
    updated_at: item.updated_at || nowIso()
  };
  await put(storeName, updated);
  return updated;
}

export async function markPending(storeName, id, extra = {}) {
  const item = await get(storeName, id);
  if (!item) return null;
  const updated = {
    ...item,
    ...extra,
    sync_status: 'pending',
    updated_at: nowIso()
  };
  await put(storeName, updated);
  return updated;
}

export async function getVisible(storeName) {
  const all = await getAll(storeName);
  return all.filter((item) => !item.deleted_at);
}

export async function estimateStorage() {
  if (!navigator.storage?.estimate) return null;
  return navigator.storage.estimate();
}

export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  return navigator.storage.persist();
}
