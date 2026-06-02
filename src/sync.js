import { supabase, isSupabaseConfigured, PHOTO_BUCKET, createSignedUrl } from './supabase-client.js';
import * as db from './local-db.js';
import { nowIso } from './utils.js';

const MAX_SYNC_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = [0, 1000, 3000, 10000, 30000];
const STALE_SYNCING_MS = 2 * 60 * 1000;
const SYNC_LOCK_KEY = 'travel_memo_sync_lock_v1';
const SYNC_LOCK_TTL_MS = 90 * 1000;

function isBrowserOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dateValue(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function isTransientSyncError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return ['network', 'fetch', 'timeout', 'rate limit', '429', '503', '502', '504', 'failed to fetch'].some((token) => message.includes(token));
}

function acquireSyncLock(userId) {
  if (typeof localStorage === 'undefined') return { acquired: true, token: 'memory' };
  const now = Date.now();
  const token = `${userId || 'anon'}:${now}:${Math.random().toString(36).slice(2)}`;
  try {
    const current = JSON.parse(localStorage.getItem(SYNC_LOCK_KEY) || 'null');
    if (current?.expires_at && Number(current.expires_at) > now && current.user_id === userId) {
      return { acquired: false, token: current.token };
    }
    localStorage.setItem(SYNC_LOCK_KEY, JSON.stringify({ user_id: userId, token, expires_at: now + SYNC_LOCK_TTL_MS }));
    return { acquired: true, token };
  } catch (_) {
    return { acquired: true, token };
  }
}

function releaseSyncLock(token) {
  if (typeof localStorage === 'undefined' || !token) return;
  try {
    const current = JSON.parse(localStorage.getItem(SYNC_LOCK_KEY) || 'null');
    if (!current || current.token === token) localStorage.removeItem(SYNC_LOCK_KEY);
  } catch (_) {}
}

function queuePriority(item) {
  const order = {
    delete_photo: 0,
    delete_memo: 1,
    delete_trip: 2,
    upsert_trip: 3,
    upsert_memo: 4,
    upsert_photo: 5
  };
  return order[item?.action] ?? 9;
}

function shouldPreserveLocal(local, remote) {
  if (!local || local.deleted_at) return false;
  if (local.sync_status === 'synced') return false;
  return dateValue(local.updated_at || local.created_at) >= dateValue(remote?.updated_at || remote?.created_at);
}

async function mergeRemoteRows(storeName, rows, mapRow) {
  const merged = [];
  for (const row of rows || []) {
    if (!row?.id) continue;
    const next = mapRow(row);
    const local = await db.get(storeName, row.id).catch(() => null);
    merged.push(shouldPreserveLocal(local, next) ? local : next);
  }
  if (merged.length) await db.putMany(storeName, merged);
  return merged.length;
}

async function recordSyncEvent(userId, item, status, errorMessage = null) {
  if (!supabase || !userId || !item) return;
  await supabase.from('sync_events').insert({
    user_id: userId,
    entity_type: item.entity || 'unknown',
    entity_id: item.entity_id || null,
    action: item.action || 'sync',
    status,
    error_message: errorMessage,
    synced_at: status === 'synced' ? nowIso() : null
  }).then(() => {}).catch(() => {});
}


function requireSupabase() {
  if (!isSupabaseConfigured || !supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
}

async function requireUser() {
  requireSupabase();
  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;
  if (!data.user) throw new Error('กรุณาเข้าสู่ระบบก่อนซิงก์');
  return data.user;
}

function cleanRecord(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function stripUnknownPhotoSchemaFields(payload) {
  const blocked = new Set([
    'thumbWidth',
    'thumbHeight',
    'thumb_width',
    'thumb_height',
    'thumbDimensions',
    'thumb_dimensions',
    'photo_caption',
    'description'
  ]);
  return Object.fromEntries(Object.entries(payload || {}).filter(([key]) => !blocked.has(key)));
}

function isPhotoSchemaCacheError(error) {
  const message = String(error?.message || error || '');
  return /Could not find the .+ column of .photos. in the schema cache/i.test(message)
    || (/schema cache/i.test(message) && /photos/i.test(message));
}

async function upsertPhotoPayload(payload) {
  const safePayload = stripUnknownPhotoSchemaFields(payload);
  let { error } = await supabase.from('photos').upsert(safePayload, { onConflict: 'id' });
  if (!error || !isPhotoSchemaCacheError(error)) return { error };

  // If the user's Supabase project has not run the newest optional photo metadata
  // migration yet, retry with the original stable schema so image upload/sync does
  // not get stuck. Captions/sort order remain local until the migration is run.
  const baseColumns = [
    'id', 'user_id', 'memo_id', 'trip_id', 'storage_path', 'thumbnail_path',
    'original_name', 'mime_type', 'width', 'height', 'size_bytes',
    'taken_at', 'created_at', 'updated_at', 'deleted_at'
  ];
  const fallbackPayload = Object.fromEntries(baseColumns
    .filter((key) => Object.prototype.hasOwnProperty.call(safePayload, key))
    .map((key) => [key, safePayload[key]]));
  const fallback = await supabase.from('photos').upsert(fallbackPayload, { onConflict: 'id' });
  return { error: fallback.error };
}

function isSharedRecord(record) {
  return Boolean(record?.shared_access === true || record?.access_level === 'shared' || record?.sync_scope === 'shared');
}

function storeForEntity(entity) {
  if (entity === 'trip') return 'trips';
  if (entity === 'memo') return 'memos';
  if (entity === 'photo') return 'photos';
  return null;
}

function isOwnerRecord(record, userId) {
  if (!record || !userId) return false;
  if (isSharedRecord(record)) return false;
  return !record.user_id || record.user_id === userId;
}

async function getQueueRecord(item) {
  const store = storeForEntity(item?.entity);
  if (!store || !item?.entity_id) return null;
  return db.get(store, item.entity_id).catch(() => null);
}


function getPhotoStoragePath(photo) {
  return photo?.storage_path || photo?.path || photo?.file_path || photo?.object_path || null;
}

function getPhotoThumbPath(photo) {
  return photo?.thumbnail_path || photo?.thumb_path || photo?.thumb_storage_path || photo?.thumbnail_storage_path || null;
}

function normalizeRemotePhoto(photo) {
  const storage_path = getPhotoStoragePath(photo);
  const thumbnail_path = getPhotoThumbPath(photo);
  return {
    ...photo,
    storage_path,
    thumbnail_path,
    caption: photo?.caption || photo?.photo_caption || photo?.description || '',
    sort_order: Number.isFinite(Number(photo?.sort_order)) ? Number(photo.sort_order) : 0
  };
}

function normalizeBundleRows(bundle = {}) {
  const fromJson = (value) => Array.isArray(value) ? value : [];
  return {
    trip: bundle.trip || null,
    memos: fromJson(bundle.memos),
    photos: fromJson(bundle.photos),
    profiles: fromJson(bundle.profiles)
  };
}

async function saveSharedBundle(bundle, userId) {
  const { trip, memos, photos, profiles } = normalizeBundleRows(bundle);
  const stamp = nowIso();
  if (profiles.length) await db.putMany('profiles', profiles);
  if (trip?.id) {
    await db.put('trips', {
      ...trip,
      shared_access: trip.user_id !== userId,
      access_level: trip.user_id === userId ? 'owner' : 'shared',
      sync_status: 'synced',
      last_synced_at: stamp
    });
  }
  if (memos.length) {
    await db.putMany('memos', memos.map((memo) => ({
      ...memo,
      shared_access: memo.user_id !== userId,
      access_level: memo.user_id === userId ? 'owner' : 'shared',
      sync_status: 'synced',
      last_synced_at: stamp
    })));
  }
  if (photos.length) {
    const photosWithUrls = [];
    for (const rawPhoto of photos) {
      const photo = normalizeRemotePhoto(rawPhoto);
      const remote_thumb_url = photo.thumbnail_path ? await createSignedUrl(photo.thumbnail_path, 3600) : '';
      const remote_url = photo.storage_path ? await createSignedUrl(photo.storage_path, 3600) : '';
      photosWithUrls.push({
        ...photo,
        shared_access: photo.user_id !== userId,
        access_level: photo.user_id === userId ? 'owner' : 'shared',
        remote_thumb_url,
        remote_url,
        sync_status: 'synced',
        last_synced_at: stamp
      });
    }
    await mergeRemoteRows('photos', photosWithUrls, (photo) => photo);
  }
  return { trips: trip ? 1 : 0, memos: memos.length, photos: photos.length };
}

function tripPayload(trip, userId) {
  return cleanRecord({
    id: trip.id,
    user_id: userId,
    title: trip.title || 'Untitled Trip',
    description: trip.description || '',
    start_date: trip.start_date || null,
    end_date: trip.end_date || null,
    country: trip.country || '',
    city: trip.city || '',
    status: trip.status || 'done',
    theme: trip.theme || '',
    is_public: Boolean(trip.is_public),
    visibility: trip.visibility || (trip.is_public ? 'public' : 'private'),
    public_slug: trip.public_slug || null,
    public_enabled_at: trip.public_enabled_at || null,
    public_disabled_at: trip.public_disabled_at || null,
    is_visible: trip.is_visible !== false,
    cover_photo_id: trip.cover_photo_id || null,
    created_at: trip.created_at || nowIso(),
    updated_at: trip.updated_at || nowIso(),
    deleted_at: trip.deleted_at || null
  });
}

function memoPayload(memo, userId) {
  return cleanRecord({
    id: memo.id,
    user_id: userId,
    trip_id: memo.trip_id || null,
    title: memo.title || memo.place_name || 'Travel Memo',
    place_name: memo.place_name || '',
    note: memo.note || '',
    diary: memo.diary || '',
    mood: memo.mood || '',
    rating: Number(memo.rating || 0),
    visited_at: memo.visited_at || nowIso(),
    latitude: Number.isFinite(Number(memo.latitude)) ? Number(memo.latitude) : null,
    longitude: Number.isFinite(Number(memo.longitude)) ? Number(memo.longitude) : null,
    country: memo.country || '',
    region: memo.region || '',
    city: memo.city || '',
    tags: Array.isArray(memo.tags) ? memo.tags : [],
    is_public: Boolean(memo.is_public),
    visibility: memo.visibility || (memo.is_public ? 'public' : 'private'),
    is_visible: memo.is_visible !== false,
    created_at: memo.created_at || nowIso(),
    updated_at: memo.updated_at || nowIso(),
    deleted_at: memo.deleted_at || null
  });
}

function photoPayload(photo, userId) {
  return cleanRecord({
    id: photo.id,
    user_id: userId,
    memo_id: photo.memo_id || null,
    trip_id: photo.trip_id || null,
    storage_path: getPhotoStoragePath(photo),
    thumbnail_path: getPhotoThumbPath(photo),
    original_name: photo.original_name || 'photo.jpg',
    mime_type: photo.mime_type || 'image/jpeg',
    width: photo.width || null,
    height: photo.height || null,
    // Do not send local-only camelCase thumbnail dimensions to Supabase.
    // Older/newer DB schemas for public.photos do not include thumbWidth/thumbHeight,
    // and PostgREST rejects unknown columns before the row can sync.
    original_width: photo.original_width || null,
    original_height: photo.original_height || null,
    original_size_bytes: photo.original_size_bytes || null,
    size_bytes: photo.size_bytes || null,
    compression_ratio: photo.compression_ratio ?? null,
    processing_ms: photo.processing_ms || null,
    caption: photo.caption || '',
    sort_order: Number.isFinite(Number(photo.sort_order)) ? Number(photo.sort_order) : 0,
    taken_at: photo.taken_at || null,
    created_at: photo.created_at || nowIso(),
    updated_at: photo.updated_at || nowIso(),
    deleted_at: photo.deleted_at || null
  });
}

async function uploadPhoto(photo, userId) {
  const storagePath = getPhotoStoragePath(photo) || `${userId}/photos/${photo.id}.jpg`;
  const thumbPath = getPhotoThumbPath(photo) || `${userId}/thumbs/${photo.id}.jpg`;

  if (photo.blob) {
    const { error } = await supabase.storage
      .from(PHOTO_BUCKET)
      .upload(storagePath, photo.blob, {
        contentType: photo.mime_type || 'image/jpeg',
        upsert: true
      });
    if (error) throw error;
  }

  const thumbSource = photo.thumbBlob || photo.blob;
  if (thumbSource) {
    const { error } = await supabase.storage
      .from(PHOTO_BUCKET)
      .upload(thumbPath, thumbSource, {
        contentType: 'image/jpeg',
        upsert: true
      });
    if (error) throw error;
  }

  return { storage_path: storagePath, thumbnail_path: thumbPath };
}

async function syncTrip(id, userId) {
  const trip = await db.get('trips', id);
  if (!trip) return { skipped: true, reason: 'trip-not-found' };
  if (!isOwnerRecord(trip, userId)) return { skipped: true, reason: 'trip-not-owned-or-shared' };
  const payload = tripPayload(trip, userId);
  const { error } = await supabase.from('trips').upsert(payload, { onConflict: 'id' });
  if (error) throw error;
  await db.markSynced('trips', id, { user_id: userId });
  return { ok: true };
}

async function syncMemo(id, userId) {
  const memo = await db.get('memos', id);
  if (!memo) return { skipped: true, reason: 'memo-not-found' };
  if (!isOwnerRecord(memo, userId)) return { skipped: true, reason: 'memo-not-owned-or-shared' };
  if (memo.trip_id) {
    const trip = await db.get('trips', memo.trip_id).catch(() => null);
    // Shared trip members may add their own memos into the owner's trip.
    // Do not try to upsert the parent shared trip, but allow this memo because user_id is the current user.
    if (trip && trip.user_id !== userId && memo.user_id === userId) {
      // allowed; RLS will verify accepted membership on insert/update
    } else if (trip) {
      if (!isOwnerRecord(trip, userId)) return { skipped: true, reason: 'parent-trip-not-owned' };
      if (trip.sync_status !== 'synced') await syncTrip(trip.id, userId);
    }
  }
  const payload = memoPayload(memo, userId);
  const { error } = await supabase.from('memos').upsert(payload, { onConflict: 'id' });
  if (error) throw error;
  await db.markSynced('memos', id, { user_id: userId });
  return { ok: true };
}

async function syncPhoto(id, userId) {
  const photo = await db.get('photos', id);
  if (!photo) return { skipped: true, reason: 'photo-not-found' };
  if (!isOwnerRecord(photo, userId)) return { skipped: true, reason: 'photo-not-owned-or-shared' };
  if (photo.memo_id) {
    const memo = await db.get('memos', photo.memo_id).catch(() => null);
    if (memo && !isOwnerRecord(memo, userId) && photo.user_id !== userId) return { skipped: true, reason: 'parent-memo-not-owned' };
    if (memo && memo.sync_status !== 'synced') await syncMemo(memo.id, userId);
  }
  const uploaded = await uploadPhoto(photo, userId);
  const updatedPhoto = { ...photo, ...uploaded, user_id: userId, updated_at: nowIso() };
  const { error } = await upsertPhotoPayload(photoPayload(updatedPhoto, userId));
  if (error) throw error;
  await db.markSynced('photos', id, { ...uploaded, user_id: userId, caption: updatedPhoto.caption || '', sort_order: updatedPhoto.sort_order || 0 });
  return { ok: true };
}


export async function removeRemotePhotoFiles(photo, userId) {
  if (!supabase || !photo || !userId) return;
  const paths = [
    getPhotoStoragePath(photo),
    getPhotoThumbPath(photo),
    `${userId}/photos/${photo.id}.jpg`,
    `${userId}/thumbs/${photo.id}.jpg`
  ].filter(Boolean);
  const uniquePaths = [...new Set(paths)];
  if (uniquePaths.length) await supabase.storage.from(PHOTO_BUCKET).remove(uniquePaths).catch(() => {});
}

async function softDeleteRemote(entity, id, userId) {
  const table = entity === 'trip' ? 'trips' : entity === 'photo' ? 'photos' : 'memos';
  const { error } = await supabase
    .from(table)
    .update({ deleted_at: nowIso(), updated_at: nowIso() })
    .eq('id', id)
    .eq('user_id', userId);
  if (error) throw error;
  if (entity === 'photo') {
    const localPhoto = await db.get('photos', id).catch(() => null);
    await removeRemotePhotoFiles(localPhoto || { id }, userId);
  }
}

async function isForeignQueueItem(item, userId) {
  if (item.user_id && item.user_id !== userId) return true;
  if (item.payload?.user_id && item.payload.user_id !== userId) return true;
  const record = await getQueueRecord(item);
  if (!record) return false;
  if (isSharedRecord(record)) return true;
  return Boolean(record.user_id && record.user_id !== userId);
}

async function isStaleQueueItem(item, userId) {
  if (!item?.entity_id) return true;
  const store = storeForEntity(item.entity);
  if (!store) return true;
  const record = await db.get(store, item.entity_id).catch(() => null);
  if (!record && !String(item.action || '').startsWith('delete_')) return true;
  if (record && !isOwnerRecord(record, userId)) return true;
  return false;
}

export async function cleanupSyncQueueForUser(userId) {
  if (!userId) return { removed: 0, kept: 0, reset: 0 };
  const queue = await db.getAll('syncQueue').catch(() => []);
  let removed = 0;
  let reset = 0;
  const now = Date.now();
  for (const item of queue) {
    if (await isStaleQueueItem(item, userId)) {
      await db.remove('syncQueue', item.id);
      removed += 1;
    } else {
      const lastAttempt = dateValue(item.last_attempt_at);
      const isStaleSyncing = ['syncing', 'retrying'].includes(item.status) && lastAttempt && now - lastAttempt > STALE_SYNCING_MS;
      if (isStaleSyncing || !item.user_id) {
        const record = await getQueueRecord(item);
        await db.put('syncQueue', {
          ...item,
          user_id: item.user_id || record?.user_id || userId,
          record_user_id: record?.user_id || item.record_user_id || null,
          status: isStaleSyncing ? 'pending' : item.status,
          updated_at: nowIso()
        });
        if (isStaleSyncing) reset += 1;
      }
    }
  }
  return { removed, kept: Math.max(0, queue.length - removed), reset };
}

async function processQueueItem(item, userId) {
  if (await isForeignQueueItem(item, userId)) return { skipped: true, reason: 'foreign-local-record' };
  if (item.action === 'upsert_trip') return syncTrip(item.entity_id, userId);
  if (item.action === 'upsert_memo') return syncMemo(item.entity_id, userId);
  if (item.action === 'upsert_photo') return syncPhoto(item.entity_id, userId);
  if (item.action === 'delete_trip') return softDeleteRemote('trip', item.entity_id, userId);
  if (item.action === 'delete_memo') return softDeleteRemote('memo', item.entity_id, userId);
  if (item.action === 'delete_photo') return softDeleteRemote('photo', item.entity_id, userId);
  throw new Error(`Unknown sync action: ${item.action}`);
}

export async function queueAllPending(userId = null) {
  const [trips, memos, photos] = await Promise.all([
    db.getAll('trips'),
    db.getAll('memos'),
    db.getAll('photos')
  ]);
  const queue = await db.getAll('syncQueue');
  const queuedKeys = new Set(queue.map((item) => `${item.action}:${item.entity_id}`));

  const belongsToUser = (item) => !userId || isOwnerRecord(item, userId);
  for (const trip of trips.filter((item) => belongsToUser(item) && item.sync_status !== 'synced')) {
    const action = trip.deleted_at ? 'delete_trip' : 'upsert_trip';
    if (!queuedKeys.has(`${action}:${trip.id}`)) await db.queueSync(action, 'trip', trip.id, { user_id: trip.user_id || userId });
  }
  for (const memo of memos.filter((item) => belongsToUser(item) && item.sync_status !== 'synced')) {
    const action = memo.deleted_at ? 'delete_memo' : 'upsert_memo';
    if (!queuedKeys.has(`${action}:${memo.id}`)) await db.queueSync(action, 'memo', memo.id, { user_id: memo.user_id || userId });
  }
  for (const photo of photos.filter((item) => belongsToUser(item) && item.sync_status !== 'synced')) {
    const action = photo.deleted_at ? 'delete_photo' : 'upsert_photo';
    if (!queuedKeys.has(`${action}:${photo.id}`)) await db.queueSync(action, 'photo', photo.id, { user_id: photo.user_id || userId });
  }
}

export async function syncNow(onProgress = () => {}) {
  if (!isBrowserOnline()) throw new Error('ออฟไลน์อยู่ ระบบจะเก็บไว้และซิงก์อัตโนมัติเมื่อออนไลน์');
  const user = await requireUser();
  const lock = acquireSyncLock(user.id);
  if (!lock.acquired) {
    onProgress({ done: 0, total: 0, message: 'มีแท็บอื่นกำลังซิงก์อยู่' });
    return { ok: false, total: 0, errors: [{ error: new Error('sync locked') }], locked: true };
  }
  try {
    await cleanupSyncQueueForUser(user.id);
    await queueAllPending(user.id);
    const rawQueue = (await db.getAll('syncQueue'))
      .sort((a, b) => queuePriority(a) - queuePriority(b) || dateValue(a.created_at) - dateValue(b.created_at));
    const queue = rawQueue.filter((item) => Number(item.attempts || 0) < MAX_SYNC_ATTEMPTS && item.status !== 'paused');
    const total = queue.length;
    const errors = [];

    if (!total) {
      onProgress({ done: 0, total: 0, message: 'ไม่มีรายการรอซิงก์' });
      return { ok: true, total: 0, errors };
    }

    for (let index = 0; index < queue.length; index += 1) {
      if (!isBrowserOnline()) throw new Error('เครือข่ายออฟไลน์ระหว่างซิงก์');
      const item = queue[index];
      const attempt = Number(item.attempts || 0);
      const baseDelay = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)] || 0;
      const jitter = attempt > 0 ? Math.round(Math.random() * 450) : 0;
      if (attempt > 0 && baseDelay) await sleep(baseDelay + jitter);
      const workingItem = {
        ...item,
        status: attempt > 0 ? 'retrying' : 'syncing',
        last_attempt_at: nowIso(),
        updated_at: nowIso()
      };
      await db.put('syncQueue', workingItem);
      onProgress({ done: index, total, message: `กำลังซิงก์ ${item.entity}` });
      try {
        const itemResult = await processQueueItem(workingItem, user.id);
        await recordSyncEvent(user.id, workingItem, itemResult?.skipped ? 'skipped' : 'synced', itemResult?.reason || null);
        await db.remove('syncQueue', item.id);
      } catch (error) {
        const nextAttempts = attempt + 1;
        const message = error?.message || String(error);
        errors.push({ item: workingItem, error });
        await recordSyncEvent(user.id, workingItem, 'failed', message);
        const transient = isTransientSyncError(error);
        await db.put('syncQueue', {
          ...workingItem,
          attempts: nextAttempts,
          retry_count: nextAttempts,
          status: nextAttempts >= MAX_SYNC_ATTEMPTS ? 'failed' : (transient ? 'retrying' : 'pending'),
          last_error: message,
          updated_at: nowIso()
        });
      }
      onProgress({ done: index + 1, total, message: `ซิงก์แล้ว ${index + 1}/${total}` });
    }

    return { ok: errors.length === 0, total, errors };
  } finally {
    releaseSyncLock(lock.token);
  }
}


async function removeLocalSharedTripBundle(tripId, userId) {
  if (!tripId || !userId) return { trips: 0, memos: 0, photos: 0 };
  let removedTrips = 0;
  let removedMemos = 0;
  let removedPhotos = 0;

  const [localTrips, localMemos, localPhotos] = await Promise.all([
    db.getAll('trips').catch(() => []),
    db.getAll('memos').catch(() => []),
    db.getAll('photos').catch(() => [])
  ]);

  const trip = localTrips.find((item) => item.id === tripId);
  if (trip && trip.user_id !== userId && isSharedRecord(trip)) {
    await db.remove('trips', trip.id);
    removedTrips += 1;
  }

  const memoIdsToRemove = new Set();
  for (const memo of localMemos) {
    if (memo.trip_id === tripId && memo.user_id !== userId && isSharedRecord(memo)) {
      memoIdsToRemove.add(memo.id);
      await db.remove('memos', memo.id);
      removedMemos += 1;
    }
  }

  for (const photo of localPhotos) {
    const belongsToTrip = photo.trip_id === tripId || (photo.memo_id && memoIdsToRemove.has(photo.memo_id));
    if (belongsToTrip && photo.user_id !== userId && isSharedRecord(photo)) {
      await db.remove('photos', photo.id);
      removedPhotos += 1;
    }
  }

  return { trips: removedTrips, memos: removedMemos, photos: removedPhotos };
}

async function cleanupRevokedSharedTrips(userId, allowedSharedTripIds = []) {
  if (!userId) return { trips: 0, memos: 0, photos: 0 };
  const allowed = new Set((allowedSharedTripIds || []).filter(Boolean));
  const localTrips = await db.getAll('trips').catch(() => []);
  const staleSharedTrips = localTrips.filter((trip) =>
    trip?.id &&
    trip.user_id !== userId &&
    isSharedRecord(trip) &&
    !allowed.has(trip.id)
  );

  const total = { trips: 0, memos: 0, photos: 0 };
  for (const trip of staleSharedTrips) {
    const removed = await removeLocalSharedTripBundle(trip.id, userId);
    total.trips += removed.trips;
    total.memos += removed.memos;
    total.photos += removed.photos;
  }
  return total;
}

export async function pullFromCloud(onProgress = () => {}) {
  const user = await requireUser();
  onProgress({ message: 'กำลังดึงคำเชิญ' });
  const { data: invites, error: inviteError } = await supabase
    .from('trip_invites')
    .select('id,trip_id,owner_id,invited_email,role,status,created_at,updated_at,expires_at')
    .order('updated_at', { ascending: false });
  if (inviteError) console.warn('Unable to pull trip invites', inviteError);

  onProgress({ message: 'กำลังดึง Trips' });
  const { data: trips, error: tripError } = await supabase
    .from('trips')
    .select('*')
    .is('deleted_at', null)
    .order('updated_at', { ascending: false });
  if (tripError) throw tripError;

  onProgress({ message: 'กำลังดึง Memos' });
  const { data: memos, error: memoError } = await supabase
    .from('memos')
    .select('*')
    .is('deleted_at', null)
    .order('visited_at', { ascending: false });
  if (memoError) throw memoError;

  onProgress({ message: 'กำลังดึง Photos' });
  const { data: photos, error: photoError } = await supabase
    .from('photos')
    .select('*')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (photoError) throw photoError;

  const ownerIds = [...new Set([
    ...(trips || []).map((item) => item.user_id),
    ...(memos || []).map((item) => item.user_id),
    ...(photos || []).map((item) => item.user_id),
    ...(invites || []).map((item) => item.owner_id)
  ].filter(Boolean))];
  const invitedEmails = [...new Set((invites || [])
    .map((item) => String(item.invited_email || '').trim().toLowerCase())
    .filter(Boolean))];
  const profileRows = [];
  if (ownerIds.length) {
    try {
      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('id,email,display_name,avatar_url,role,created_at')
        .in('id', ownerIds);
      if (!profilesError && profiles?.length) profileRows.push(...profiles);
    } catch (error) {
      console.warn('Unable to pull owner profiles', error);
    }
  }
  if (invitedEmails.length) {
    try {
      const { data: inviteProfiles, error: inviteProfilesError } = await supabase
        .from('profiles')
        .select('id,email,display_name,avatar_url,role,created_at')
        .in('email', invitedEmails);
      if (!inviteProfilesError && inviteProfiles?.length) profileRows.push(...inviteProfiles);
    } catch (error) {
      console.warn('Unable to pull invite profiles', error);
    }
  }
  if (profileRows.length) {
    const uniqueProfiles = [...new Map(profileRows.filter((profile) => profile?.id).map((profile) => [profile.id, profile])).values()];
    await db.putMany('profiles', uniqueProfiles);
  }

  const acceptedTripIdsFromInvites = new Set((invites || [])
    .filter((invite) => String(invite.status || '').toLowerCase() === 'accepted')
    .map((invite) => invite.trip_id)
    .filter(Boolean));
  const accessibleTripIds = new Set((trips || [])
    .filter((trip) => trip?.user_id === user.id || acceptedTripIdsFromInvites.has(trip?.id))
    .map((trip) => trip.id)
    .filter(Boolean));

  const safeTrips = (trips || []).filter((trip) => trip?.user_id === user.id || acceptedTripIdsFromInvites.has(trip?.id));
  const safeMemos = (memos || []).filter((memo) => {
    if (!memo) return false;
    if (memo.user_id === user.id) return true;
    return Boolean(memo.trip_id && accessibleTripIds.has(memo.trip_id));
  });
  const safeMemoIds = new Set(safeMemos.map((memo) => memo.id).filter(Boolean));
  const safePhotos = (photos || []).filter((photo) => {
    if (!photo) return false;
    if (photo.user_id === user.id) return true;
    return Boolean((photo.trip_id && accessibleTripIds.has(photo.trip_id)) || (photo.memo_id && safeMemoIds.has(photo.memo_id)));
  });

  await mergeRemoteRows('trips', safeTrips, (trip) => ({
    ...trip,
    shared_access: trip.user_id !== user.id,
    access_level: trip.user_id === user.id ? 'owner' : 'shared',
    sync_status: 'synced',
    last_synced_at: nowIso()
  }));

  await mergeRemoteRows('memos', safeMemos, (memo) => ({
    ...memo,
    shared_access: memo.user_id !== user.id,
    access_level: memo.user_id === user.id ? 'owner' : 'shared',
    sync_status: 'synced',
    last_synced_at: nowIso()
  }));

  const photosWithUrls = [];
  for (const rawPhoto of safePhotos) {
    const photo = normalizeRemotePhoto(rawPhoto);
    const remote_thumb_url = photo.thumbnail_path ? await createSignedUrl(photo.thumbnail_path, 3600) : '';
    const remote_url = photo.storage_path ? await createSignedUrl(photo.storage_path, 3600) : '';
    photosWithUrls.push({
      ...photo,
      shared_access: photo.user_id !== user.id,
      access_level: photo.user_id === user.id ? 'owner' : 'shared',
      remote_thumb_url,
      remote_url,
      sync_status: 'synced',
      last_synced_at: nowIso()
    });
  }
  await mergeRemoteRows('photos', photosWithUrls, (photo) => photo);

  let sharedBundleStats = { trips: 0, memos: 0, photos: 0 };
  const acceptedSharedTripIds = [...new Set([
    ...safeTrips.filter((trip) => trip.user_id !== user.id).map((trip) => trip.id),
    ...acceptedTripIdsFromInvites
  ].filter(Boolean))];
  for (const tripId of acceptedSharedTripIds) {
    let bundle = null;
    for (const rpcName of ['get_trip_shared_bundle_v2', 'get_trip_shared_bundle']) {
      let data = null;
      let bundleError = null;
      try {
        const result = await supabase.rpc(rpcName, { p_trip_id: tripId });
        data = result?.data;
        bundleError = result?.error;
      } catch (rpcError) {
        bundleError = rpcError;
      }
      if (!bundleError && data) {
        bundle = data;
        break;
      }
      if (bundleError) console.warn(`${rpcName} unavailable for shared trip ${tripId}`, bundleError);
    }
    if (bundle) {
      const stats = await saveSharedBundle(bundle, user.id);
      sharedBundleStats.trips += stats.trips;
      sharedBundleStats.memos += stats.memos;
      sharedBundleStats.photos += stats.photos;
    } else {
      await removeLocalSharedTripBundle(tripId, user.id);
    }
  }

  const allowedSharedTripIds = [...new Set([
    ...safeTrips.filter((trip) => trip.user_id !== user.id).map((trip) => trip.id),
    ...acceptedSharedTripIds
  ].filter(Boolean))];
  const revokedCleanupStats = await cleanupRevokedSharedTrips(user.id, allowedSharedTripIds);
  if (revokedCleanupStats.trips || revokedCleanupStats.memos || revokedCleanupStats.photos) {
    onProgress({ message: `ล้าง Trip ที่ถูกถอดสิทธิ์แล้ว ${revokedCleanupStats.trips} Trip` });
  }

  return {
    user_id: user.id,
    invites: invites?.length || 0,
    trips: Math.max(safeTrips.length, sharedBundleStats.trips),
    memos: Math.max(safeMemos.length, sharedBundleStats.memos),
    photos: Math.max(safePhotos.length, sharedBundleStats.photos)
  };
}

async function safeAdminPhotoSelect() {
  const preferredColumns = 'id,user_id,trip_id,memo_id,size_bytes,storage_path,thumbnail_path,updated_at,created_at,deleted_at';
  const fallbackColumns = 'id,user_id,trip_id,memo_id,updated_at,created_at,deleted_at';
  const preferred = await supabase.from('photos').select(preferredColumns).limit(1000);
  if (!preferred.error) return { data: preferred.data || [], error: null, used_fallback: false, fallback_message: '' };
  const fallback = await supabase.from('photos').select(fallbackColumns).limit(1000);
  return {
    data: fallback.data || [],
    error: fallback.error || null,
    used_fallback: true,
    fallback_message: preferred.error?.message || ''
  };
}

export async function fetchAdminStats() {
  const user = await requireUser();
  const [profileResult, tripsResult, memosResult, photoSafeResult, invitesResult] = await Promise.all([
    supabase.from('profiles').select('id,email,display_name,avatar_url,role,created_at').limit(300),
    supabase.from('trips').select('id,user_id,title,status,start_date,end_date,country,city,updated_at,created_at,deleted_at,is_visible,view_count').order('updated_at', { ascending: false }).limit(800),
    supabase.from('memos').select('id,user_id,trip_id,title,country,city,updated_at,created_at,deleted_at,is_visible,view_count').order('updated_at', { ascending: false }).limit(1000),
    safeAdminPhotoSelect(),
    supabase.from('trip_invites').select('id,trip_id,owner_id,invited_email,role,status,created_at,updated_at').limit(1000)
  ]);

  for (const result of [profileResult, tripsResult, memosResult]) {
    if (result.error) throw result.error;
  }
  if (photoSafeResult.error) throw photoSafeResult.error;

  const schemaChecks = [];
  const optionalPhotoColumns = ['caption', 'sort_order', 'storage_path', 'thumbnail_path', 'thumb_path', 'metadata', 'exif_latitude', 'exif_longitude', 'exif_taken_at'];
  for (const column of optionalPhotoColumns) {
    const { error } = await supabase.from('photos').select(`id,${column}`).limit(1);
    schemaChecks.push({ table: 'photos', column, ok: !error, message: error?.message || '' });
  }
  if (photoSafeResult.used_fallback) {
    schemaChecks.push({ table: 'photos', column: 'admin_photo_select', ok: false, message: photoSafeResult.fallback_message });
  }

  return {
    current_user: user.id,
    profiles: profileResult.data || [],
    trips: tripsResult.data || [],
    memos: memosResult.data || [],
    photos: photoSafeResult.data || [],
    invites: invitesResult.error ? [] : (invitesResult.data || []),
    invite_error: invitesResult.error?.message || '',
    schema_checks: schemaChecks
  };
}
