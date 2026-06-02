import './styles.css';
import L from 'leaflet';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import * as db from './local-db.js';
import {
  supabase,
  isSupabaseConfigured,
  signInWithProvider,
  signOut,
  clearSupabaseAuthStorage,
  setAuthError,
  clearAuthError,
  clearAuthPending,
  isAuthPending,
  getCurrentUser,
  getCurrentSession,
  completeOAuthRedirectIfNeeded,
  hasOAuthCallbackParams,
  clearStaleLogoutMarkers,
  ensureProfile,
  createSignedUrl,
  createPublicPhotoUrl,
  getCachedAuthUser
} from './supabase-client.js';
import { syncNow, pullFromCloud, fetchAdminStats, queueAllPending, removeRemotePhotoFiles, cleanupSyncQueueForUser } from './sync.js';
import { CURRENT_SW_VERSION, registerServiceWorker, setupPwaInstall, clearBrowserCachesAndReload, clearOldAppShellIfVersionChanged, clearTravelMemoCaches } from './pwa.js';
import {
  $,
  $$,
  uid,
  nowIso,
  toDatetimeLocal,
  fromDatetimeLocal,
  formatDate,
  formatDateRange,
  formatDateKey,
  escapeHtml,
  parseTags,
  tagsToString,
  sortByDateDesc,
  bytesToSize,
  downloadFile,
  blobToDataUrl,
  compressImageFile,
  normalizePhotoImport,
  createObjectUrl,
  isValidLatLng,
  dayDiff
} from './utils.js';

L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow
});

const APP_VERSION = '2.8.7';
const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

const ICON_SPRITE_URL = '/icons/travel-memo/travel-memo-icons.sprite.svg';

const PHOTO_SCHEMA_ALIGNMENT_COLUMNS = [
  { column: 'thumb_path', label: 'Thumbnail path', required: true, note: 'ใช้ fallback thumbnail และ schema compatibility' },
  { column: 'thumbnail_path', label: 'Thumbnail path legacy', required: true, note: 'ใช้กับ sync/photo fallback หลายเวอร์ชัน' },
  { column: 'caption', label: 'Photo caption', required: true, note: 'เก็บ caption รูปเพื่อแสดงใน Story/Lightbox' },
  { column: 'sort_order', label: 'Sort order', required: true, note: 'จัดลำดับรูปใน Photo Story' },
  { column: 'metadata', label: 'Metadata JSON', required: true, note: 'เก็บ metadata เพิ่มเติมแบบยืดหยุ่น' },
  { column: 'exif_latitude', label: 'EXIF latitude', required: false, note: 'ใช้ดึงพิกัดจากรูปถ่าย' },
  { column: 'exif_longitude', label: 'EXIF longitude', required: false, note: 'ใช้ดึงพิกัดจากรูปถ่าย' },
  { column: 'exif_taken_at', label: 'EXIF taken at', required: false, note: 'ใช้เวลาถ่ายจริงจากรูป' },
  { column: 'original_width', label: 'Original width', required: false, note: 'Diagnostics เท่านั้น' },
  { column: 'original_height', label: 'Original height', required: false, note: 'Diagnostics เท่านั้น' },
  { column: 'compressed_width', label: 'Compressed width', required: false, note: 'Diagnostics เท่านั้น' },
  { column: 'compressed_height', label: 'Compressed height', required: false, note: 'Diagnostics เท่านั้น' },
  { column: 'original_size_bytes', label: 'Original size', required: false, note: 'Diagnostics เท่านั้น' },
  { column: 'compressed_size_bytes', label: 'Compressed size', required: false, note: 'Diagnostics เท่านั้น' },
  { column: 'compression_saved_bytes', label: 'Saved bytes', required: false, note: 'Diagnostics เท่านั้น' }
];

const PHOTO_SCHEMA_ALIGNMENT_SQL = `alter table public.photos
  add column if not exists thumb_path text,
  add column if not exists thumbnail_path text,
  add column if not exists caption text,
  add column if not exists sort_order integer default 0,
  add column if not exists original_width integer,
  add column if not exists original_height integer,
  add column if not exists compressed_width integer,
  add column if not exists compressed_height integer,
  add column if not exists original_size_bytes bigint,
  add column if not exists compressed_size_bytes bigint,
  add column if not exists compression_saved_bytes bigint,
  add column if not exists exif_latitude double precision,
  add column if not exists exif_longitude double precision,
  add column if not exists exif_taken_at timestamptz,
  add column if not exists metadata jsonb default '{}'::jsonb;

create index if not exists idx_photos_memo_id_sort_order on public.photos (memo_id, sort_order);
create index if not exists idx_photos_trip_id_sort_order on public.photos (trip_id, sort_order);
create index if not exists idx_photos_user_id_updated_at on public.photos (user_id, updated_at desc);`;

const PHOTO_SCHEMA_REFRESH_STEPS = `Supabase schema refresh steps\n\n1. Open Supabase Dashboard\n2. Go to SQL Editor and run the latest photo schema migration\n3. Go to Project Settings > API\n4. Click Reload schema / Refresh schema cache\n5. Deploy or open /reset-cache.html in Travel Memo\n6. Open Admin Dashboard and check Schema Alignment`;

function tmIcon(name, className = 'tm-icon') {
  return `<svg class="${className}" aria-hidden="true"><use href="${ICON_SPRITE_URL}#tm-${name}"></use></svg>`;
}

function iconText(name, text, className = 'icon-text') {
  return `<span class="${className}">${tmIcon(name)}<span>${escapeHtml(String(text ?? ''))}</span></span>`;
}

function setButtonBusy(button, busy, label = 'กำลังทำงาน...') {
  if (!button) return;
  if (busy) {
    if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
    button.disabled = true;
    button.classList.add('is-busy');
    button.innerHTML = `${tmIcon('sync')}<span>${escapeHtml(label)}</span>`;
    return;
  }
  button.disabled = false;
  button.classList.remove('is-busy');
  if (button.dataset.originalHtml) {
    button.innerHTML = button.dataset.originalHtml;
    delete button.dataset.originalHtml;
  }
}

function syncTone() {
  const failed = state.syncQueue?.some?.((item) => item.status === 'failed' || item.last_error);
  if (!isSupabaseConfigured || !state.user) return 'neutral';
  if (navigator.onLine === false) return 'offline';
  if (failed) return 'error';
  if (state.isSyncing || state.cloudPullInProgress) return 'syncing';
  if (state.syncQueue?.length) return 'pending';
  return 'ready';
}

function setSyncStatusUi(text = '', options = {}) {
  const label = text || currentSyncStatusText?.() || '';
  const tone = options.tone || syncTone();
  if (els.syncStatusText && label) els.syncStatusText.textContent = label;
  if (els.autoSyncStatus) {
    els.autoSyncStatus.classList.remove('ready', 'pending', 'syncing', 'offline', 'error', 'neutral');
    els.autoSyncStatus.classList.add(tone);
    els.autoSyncStatus.textContent = label || els.autoSyncStatus.textContent || 'พร้อมซิงก์';
  }
  document.documentElement.dataset.syncTone = tone;
}

function setPhotoUploadFeedback({ active = false, done = 0, total = 0, message = '', tone = 'info' } = {}) {
  if (!els.photoUploadStatus) return;
  if (state.photoUploadStatusTimer) clearTimeout(state.photoUploadStatusTimer);
  const percent = total ? Math.min(100, Math.max(0, Math.round((done / total) * 100))) : (active ? 8 : 100);
  els.photoUploadStatus.classList.remove('hidden', 'success', 'error', 'info');
  els.photoUploadStatus.classList.add(tone);
  els.photoUploadStatus.innerHTML = `
    <div class="photo-upload-status-row">
      ${tmIcon(tone === 'success' ? 'cloud-sync' : tone === 'error' ? 'diagnostics' : 'photo')}
      <span>${escapeHtml(message || (active ? 'กำลังเตรียมรูปภาพ...' : 'รูปภาพพร้อมแล้ว'))}</span>
      ${total ? `<small>${done}/${total}</small>` : ''}
    </div>
    <div class="photo-upload-progress"><span style="width:${percent}%"></span></div>
  `;
  if (!active) {
    state.photoUploadStatusTimer = setTimeout(() => els.photoUploadStatus?.classList.add('hidden'), tone === 'error' ? 7000 : 4200);
  }
}

function debounce(callback, delay = 120) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), delay);
  };
}

function closestElement(target, selector) {
  let node = target;
  while (node && node !== document) {
    if (node.matches?.(selector)) return node;
    node = node.parentElement || node.parentNode?.host || node.parentNode;
  }
  return null;
}


const state = {
  view: 'home',
  user: null,
  profile: null,
  trips: [],
  memos: [],
  photos: [],
  profiles: [],
  syncQueue: [],
  selectedPhotos: [],
  memoLocationSource: null,
  photoLightbox: { photos: [], index: 0 },
  photoObjectUrls: new Map(),
  photoUploadStatusTimer: null,
  map: null,
  markerLayer: null,
  mapProvider: null,
  googleMarkers: [],
  googleRouteLine: null,
  leafletRouteLine: null,
  googlePhotoRouteLine: null,
  leafletPhotoRouteLine: null,
  googlePhotoMarkers: [],
  photoMarkerLayer: null,
  googleReplayMarker: null,
  leafletReplayMarker: null,
  routeReplayTimer: null,
  routeReplayIndex: 0,
  routeReplayPlaying: false,
  routeReplayMemos: [],
  toastTimer: null,
  isSyncing: false,
  autoSyncTimer: null,
  autoPullTimer: null,
  cloudPullInProgress: false,
  lastAutoSyncAt: null,
  logoutInProgress: false,
  invites: [],
  inviteLoading: false,
  inviteActionInProgress: false,
  authReady: false,
  homeMemoPage: 1,
  homeTripPage: 1,
  homeMemoPageSize: 4,
  homeTripPageSize: 2,
  lastCloudPullAt: null,
  adminUserSearch: '',
  adminRoleFilter: 'all',
  adminFilterTimer: null,
  adminStatsCache: null,
  timelineFilter: 'all',
  timelineSearchTimer: null,
  mapLocationFilter: 'all',
  timelineFilters: {
    keyword: '',
    dateFrom: '',
    dateTo: '',
    country: '',
    city: '',
    tag: '',
    mood: '',
    rating: '',
    sync: '',
    owner: ''
  },
  authEventTimer: null,
  shareDeepLinkProcessed: false,
  publicShareMode: false,
  publicTripBundle: null
};

const els = {};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const bootTimer = setTimeout(() => {
    console.warn('Travel Memo boot fallback timeout reached; showing auth/home UI');
    state.user = null;
    state.profile = null;
    state.trips = [];
    state.memos = [];
    state.photos = [];
    state.profiles = [];
    state.syncQueue = [];
    state.invites = [];
    try { renderAll(); } catch (error) { hardShowLoginFallback(error); }
  }, 9000);

  try {
    cacheElements();
    setupClientErrorLogging();
    setDefaultDateTime();
    bindEvents();
    setupPwaInstall(els.installButton);
    await withTimeout(clearOldAppShellIfVersionChanged(APP_VERSION), 2500, 'cache-version-check-timeout').catch((error) => console.warn(error));
    await withTimeout(registerServiceWorker(), 2500, 'service-worker-register-timeout').catch((error) => console.warn(error));
    await withTimeout(db.initDb(), 3500, 'indexeddb-init-timeout');
    if (hasPublicShareParams()) {
      const handledPublicShare = await renderPublicShareIfRequested();
      if (handledPublicShare) {
        clearTimeout(bootTimer);
        setupNetworkStatus();
        window.TRAVEL_MEMO_BOOT_OK = true;
        return;
      }
    }
    const hasOauthCallback = hasOAuthCallbackParams();
    if (hasOauthCallback) {
      clearStaleLogoutMarkers();
    } else {
      await withTimeout(handleForcedLogoutOnBoot(), 2500, 'forced-logout-timeout').catch((error) => console.warn(error));
    }
    const oauthSession = await withTimeout(completeOAuthRedirectIfNeeded(), 12000, 'oauth-callback-timeout').catch((error) => {
      console.warn('OAuth callback handling skipped', error);
      return null;
    });
    if (oauthSession?.user) {
      state.user = oauthSession.user;
    }
    await withTimeout(refreshAuth(), 7000, 'refresh-auth-timeout').catch((error) => {
      console.warn('Auth refresh failed; showing login screen', error);
      state.user = null;
      state.profile = null;
    });
    await withTimeout(loadLocalData(), 4500, 'load-local-data-timeout').catch((error) => {
      console.warn('Local data load failed; continuing with empty state', error);
      state.trips = [];
      state.memos = [];
      state.photos = [];
      state.profiles = state.profile ? [state.profile] : [];
      state.syncQueue = [];
      state.invites = [];
    });
    clearTimeout(bootTimer);
    renderAll();
    setupNetworkStatus();
    updateStorageEstimate();
    scheduleAutoSync('init', { delay: 1800 });
    setupAutoCloudRefresh();
    scheduleAutoCloudPull('เปิดแอป', 2200);

    if (supabase) {
      supabase.auth.onAuthStateChange((event) => {
        handleSupabaseAuthEvent(event);
      });
    }
    window.TRAVEL_MEMO_BOOT_OK = true;
  } catch (error) {
    clearTimeout(bootTimer);
    console.error('Travel Memo boot failed', error);
    hardShowLoginFallback(error);
  }
}

function withTimeout(promise, ms, label = 'timeout') {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms))
  ]);
}

function hardShowLoginFallback(error) {
  try {
    const app = document.getElementById('app');
    app?.classList.remove('auth-checking');
    app?.classList.add('logged-out');
    app?.classList.remove('logged-in');
    const panel = document.getElementById('authPanel');
    if (panel) {
      panel.innerHTML = `
        <div class="auth-hero-icon">${tmIcon('app-mark')}</div>
        <h2>เข้าสู่พื้นที่ส่วนตัวของคุณ</h2>
        <p>Travel Memo พร้อมใช้งานแล้ว เข้าสู่ระบบด้วย Google เพื่อเปิด Memo และ Trip ของคุณ</p>
        <div class="google-login-wrap">
          <button id="googleLoginButton" class="google-only-button" type="button" data-auth-provider="google">
            <span class="google-icon" aria-hidden="true">G</span>
            <span>เข้าสู่ระบบด้วย Google</span>
          </button>
        </div>
        <p class="muted small-note">ถ้าหน้านี้ขึ้นหลังอัปเดต ให้กด reset-cache.html หนึ่งครั้ง แล้วลองใหม่</p>
      `;
      const button = document.getElementById('googleLoginButton');
      button?.addEventListener('click', (event) => {
        event.preventDefault();
        startGoogleLogin(button);
      });
    }
  } catch (fallbackError) {
    console.error('Travel Memo hard fallback failed', error, fallbackError);
  }
}

function cacheElements() {
  Object.assign(els, {
    screenTitle: $('#screenTitle'),
    installButton: $('#installButton'),
    networkStatus: $('#networkStatus'),
    authPanel: $('#authPanel'),
    statMemo: $('#statMemo'),
    statTrip: $('#statTrip'),
    statPhoto: $('#statPhoto'),
    statQueue: $('#statQueue'),
    syncStatusText: $('#syncStatusText'),
    syncProgress: $('#syncProgress'),
    syncNowButton: $('#syncNowButton'),
    autoSyncStatus: $('#autoSyncStatus'),
    latestMemos: $('#latestMemos'),
    homeTrips: $('#homeTrips'),
    memoForm: $('#memoForm'),
    memoId: $('#memoId'),
    memoTitle: $('#memoTitle'),
    visitedAt: $('#visitedAt'),
    memoTrip: $('#memoTrip'),
    newTripName: $('#newTripName'),
    placeName: $('#placeName'),
    city: $('#city'),
    region: $('#region'),
    country: $('#country'),
    note: $('#note'),
    rating: $('#rating'),
    ratingPicker: $('#ratingPicker'),
    mood: $('#mood'),
    moodPicker: $('#moodPicker'),
    diary: $('#diary'),
    tags: $('#tags'),
    tagEditor: $('#tagEditor'),
    tagEntry: $('#tagEntry'),
    tagSuggestions: $('#tagSuggestions'),
    latitude: $('#latitude'),
    longitude: $('#longitude'),
    cameraInput: $('#cameraInput'),
    galleryInput: $('#galleryInput'),
    selectedPhotoCount: $('#selectedPhotoCount'),
    photoUploadStatus: $('#photoUploadStatus'),
    photoPreview: $('#photoPreview'),
    locationButton: $('#locationButton'),
    saveMemoButton: $('#saveMemoButton'),
    cancelEditButton: $('#cancelEditButton'),
    tripForm: $('#tripForm'),
    tripId: $('#tripId'),
    tripTitle: $('#tripTitle'),
    tripStatus: $('#tripStatus'),
    tripStart: $('#tripStart'),
    tripEnd: $('#tripEnd'),
    tripCountry: $('#tripCountry'),
    tripCity: $('#tripCity'),
    tripDescription: $('#tripDescription'),
    resetTripButton: $('#resetTripButton'),
    tripSearch: $('#tripSearch'),
    tripList: $('#tripList'),
    timelineTripFilter: $('#timelineTripFilter'),
    memoSearch: $('#memoSearch'),
    timelineHero: $('#timelineHero'),
    timelineHeroStats: $('#timelineHeroStats'),
    timelineFilterChips: $('#timelineFilterChips'),
    timelineDateFrom: $('#timelineDateFrom'),
    timelineDateTo: $('#timelineDateTo'),
    timelineCountryFilter: $('#timelineCountryFilter'),
    timelineCityFilter: $('#timelineCityFilter'),
    timelineTagFilter: $('#timelineTagFilter'),
    timelineMoodFilter: $('#timelineMoodFilter'),
    timelineRatingFilter: $('#timelineRatingFilter'),
    timelineSyncFilter: $('#timelineSyncFilter'),
    timelineOwnerFilter: $('#timelineOwnerFilter'),
    timelineSearchSummary: $('#timelineSearchSummary'),
    timelineTagMoodOverview: $('#timelineTagMoodOverview'),
    timelineAdvancedPanel: $('#timelineAdvancedPanel'),
    timelineList: $('#timelineList'),
    mapTripFilter: $('#mapTripFilter'),
    mapSearchInput: $('#mapSearchInput'),
    mapScopeFilter: $('#mapScopeFilter'),
    mapRouteToggle: $('#mapRouteToggle'),
    fitMapButton: $('#fitMapButton'),
    map: $('#map'),
    mapSummaryPanel: $('#mapSummaryPanel'),
    mapMemoList: $('#mapMemoList'),
    mapReplayPanel: $('#mapReplayPanel'),
    mapReplayPlayButton: $('#mapReplayPlayButton'),
    mapReplayPrevButton: $('#mapReplayPrevButton'),
    mapReplayNextButton: $('#mapReplayNextButton'),
    mapReplayResetButton: $('#mapReplayResetButton'),
    mapReplayStatus: $('#mapReplayStatus'),
    supabaseConfigStatus: $('#supabaseConfigStatus'),
    pullCloudButton: $('#pullCloudButton'),
    syncAllButton: $('#syncAllButton'),
    makePersistentButton: $('#makePersistentButton'),
    openAdminButton: $('#openAdminButton'),
    exportButton: $('#exportButton'),
    importInput: $('#importInput'),
    migrateLegacyButton: $('#migrateLegacyButton'),
    clearLocalButton: $('#clearLocalButton'),
    storageEstimate: $('#storageEstimate'),
    queueRetryButton: $('#queueRetryButton'),
    queueResetFailedButton: $('#queueResetFailedButton'),
    queueClearFailedButton: $('#queueClearFailedButton'),
    queuePanel: $('#queuePanel'),
    diagnosticsButton: $('#diagnosticsButton'),
    clearCacheButton: $('#clearCacheButton'),
    diagnosticsPanel: $('#diagnosticsPanel'),
    adminContent: $('#adminContent'),
    refreshAdminButton: $('#refreshAdminButton'),
    sheetBackdrop: $('#sheetBackdrop'),
    detailSheet: $('#detailSheet'),
    detailSheetContent: $('#detailSheetContent'),
    toast: $('#toast')
  });
}


function getClientErrorLog() {
  try {
    return JSON.parse(localStorage.getItem('travel_memo_client_errors') || '[]');
  } catch (_) {
    return [];
  }
}

function logClientError(source, detail) {
  try {
    const list = getClientErrorLog();
    list.unshift({ source, detail: String(detail || ''), version: APP_VERSION, at: nowIso() });
    localStorage.setItem('travel_memo_client_errors', JSON.stringify(list.slice(0, 30)));
  } catch (_) {}
}

function setupClientErrorLogging() {
  window.addEventListener('error', (event) => {
    logClientError('window.error', event.message || event.error?.message || 'Unknown error');
  });
  window.addEventListener('unhandledrejection', (event) => {
    logClientError('unhandledrejection', event.reason?.message || event.reason || 'Unhandled promise rejection');
  });
}

function handleOpenTrigger(event) {
  const trigger = event.target.closest?.('[data-open]');
  if (!trigger || trigger.disabled) return;
  const view = trigger.dataset.open;
  if (!view) return;
  event.preventDefault();
  event.stopPropagation();
  if (els.detailSheet?.classList.contains('open')) closeSheet();
  if (view === 'add') resetMemoForm();
  openView(view);
  if (view === 'map') {
    initMap();
    setTimeout(() => {
      state.map?.invalidateSize?.();
      fitMapToMarkers(false);
    }, 180);
  }
}

function bindEvents() {
  // v2.1.15: delegated navigation fixes both the fixed bottom nav and
  // dynamically rendered buttons that use data-open after lists refresh.
  document.addEventListener('click', handleOpenTrigger, true);
  document.addEventListener('click', handleTripActionCapture, true);
  setupMobileViewportPolish();

  const bottomNav = document.querySelector('.bottom-nav');
  bottomNav?.addEventListener('touchstart', (event) => {
    const button = event.target.closest('.nav-item[data-open]');
    if (!button || !bottomNav.contains(button)) return;
    button.classList.add('pressing');
  }, { passive: true });

  bottomNav?.addEventListener('touchend', (event) => {
    const button = event.target.closest('.nav-item[data-open]');
    if (!button || !bottomNav.contains(button)) return;
    setTimeout(() => button.classList.remove('pressing'), 140);
  }, { passive: true });

  els.authPanel.addEventListener('click', handleAuthClick);
  document.addEventListener('click', handleGlobalAuthClick);
  document.addEventListener('click', handleInviteNotificationAction);
  document.addEventListener('click', handleAuthClickCapture, true);
  if (els.syncNowButton) els.syncNowButton.addEventListener('click', () => runSync({ includePull: false }));
  els.syncAllButton.addEventListener('click', () => runSync({ includePull: true }));
  els.pullCloudButton.addEventListener('click', pullCloudData);
  els.makePersistentButton.addEventListener('click', requestPersistentStorage);

  els.memoForm.addEventListener('submit', saveMemo);
  els.cameraInput.addEventListener('change', handlePhotoInput);
  els.galleryInput.addEventListener('change', handlePhotoInput);
  els.photoPreview.addEventListener('click', handleSelectedPhotoAction);
  els.photoPreview.addEventListener('input', handleSelectedPhotoInput);
  document.addEventListener('keydown', handlePhotoLightboxKeys);
  els.locationButton?.addEventListener('click', useCurrentLocation);
  els.cancelEditButton.addEventListener('click', resetMemoForm);
  setupTagEditor();
  setupMoodRatingPickers();
  document.addEventListener('click', handleTaxonomyFilterClick);

  els.tripForm.addEventListener('submit', saveTrip);
  els.resetTripButton.addEventListener('click', resetTripForm);
  els.tripSearch.addEventListener('input', renderTrips);
  els.tripList.addEventListener('click', handleTripAction);
  els.homeTrips.addEventListener('click', handleTripAction);

  els.latestMemos.addEventListener('click', handleMemoAction);
  els.latestMemos.addEventListener('click', handleHomePagination);
  els.homeTrips.addEventListener('click', handleHomePagination);
  els.timelineHero?.addEventListener('click', handleTripAction);
  els.timelineHero?.addEventListener('click', handleMemoAction);
  els.timelineHero?.addEventListener('click', handleSheetAction);
  els.timelineList.addEventListener('click', handleMemoAction);
  els.timelineList.addEventListener('click', handleSheetAction);
  els.timelineList.addEventListener('click', handleTimelineSummaryAction);
  els.timelineTripFilter.addEventListener('change', () => { syncTimelineFiltersFromInputs(); renderTimeline(); });
  els.memoSearch.addEventListener('input', handleTimelineSearchInput);
  ['timelineDateFrom','timelineDateTo','timelineCountryFilter','timelineCityFilter','timelineTagFilter','timelineMoodFilter','timelineRatingFilter','timelineSyncFilter','timelineOwnerFilter'].forEach((key) => {
    els[key]?.addEventListener('input', handleTimelineSearchInput);
    els[key]?.addEventListener('change', handleTimelineSearchInput);
  });
  els.timelineSearchSummary?.addEventListener('click', handleTimelineSummaryAction);
  els.timelineFilterChips?.addEventListener('click', handleTimelineFilterClick);

  els.mapTripFilter.addEventListener('change', () => { stopRouteReplay(false); resetRouteReplayState(); renderMapMarkers(); });
  els.mapSearchInput?.addEventListener('input', debounce(() => { stopRouteReplay(false); resetRouteReplayState(); renderMapMarkers(); }, 120));
  els.mapScopeFilter?.addEventListener('change', () => { stopRouteReplay(false); resetRouteReplayState(); renderMapMarkers(); });
  els.mapRouteToggle?.addEventListener('change', () => { stopRouteReplay(false); renderMapMarkers(); });
  els.mapMemoList?.addEventListener('click', handleMapPanelAction);
  els.mapSummaryPanel?.addEventListener('click', handleMapPanelAction);
  document.addEventListener('click', handleMapPanelAction);
  els.fitMapButton?.addEventListener('click', () => fitMapToMarkers(true));

  els.exportButton.addEventListener('click', exportBackup);
  els.importInput.addEventListener('change', importBackup);
  els.migrateLegacyButton.addEventListener('click', migrateLegacyLocalStorage);
  els.clearLocalButton.addEventListener('click', clearLocalData);
  els.queueRetryButton.addEventListener('click', retrySyncQueue);
  els.queueResetFailedButton.addEventListener('click', resetFailedQueue);
  els.queueClearFailedButton.addEventListener('click', clearFailedQueue);
  els.refreshAdminButton.addEventListener('click', renderAdmin);
  els.adminContent.addEventListener('click', handleAdminAction);
  els.adminContent.addEventListener('input', handleAdminInput);
  els.adminContent.addEventListener('change', handleAdminInput);
  els.diagnosticsButton.addEventListener('click', runDiagnostics);
  els.clearCacheButton.addEventListener('click', async () => {
    toast('กำลังล้าง Cache แอป...');
    await clearBrowserCachesAndReload();
  });

  els.sheetBackdrop.addEventListener('click', closeSheet);
  els.detailSheetContent.addEventListener('click', handleSheetAction);
  document.addEventListener('click', handleShareSheetAction);
  document.addEventListener('click', handlePublicShareAction);

  window.addEventListener('online', () => {
    setupNetworkStatus();
    scheduleAutoSync('online', { delay: 800 });
    scheduleAutoCloudPull('online', 1200);
  });
  window.addEventListener('offline', setupNetworkStatus);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      scheduleAutoSync('app-resume', { delay: 1000 });
      scheduleAutoCloudPull('app-resume', 1200);
    }
  });
}


function setDefaultDateTime() {
  els.visitedAt.value = toDatetimeLocal(new Date());
}


function setupMobileViewportPolish() {
  const root = document.documentElement;
  const updateViewport = () => {
    const vv = window.visualViewport;
    const viewportHeight = vv?.height || window.innerHeight || document.documentElement.clientHeight;
    const viewportWidth = vv?.width || window.innerWidth || document.documentElement.clientWidth;
    const keyboardLikelyOpen = Boolean(vv && window.innerHeight - vv.height > 120);
    root.style.setProperty('--app-vh', `${viewportHeight * 0.01}px`);
    root.style.setProperty('--viewport-width', `${Math.round(viewportWidth)}px`);
    root.classList.toggle('keyboard-open', keyboardLikelyOpen);
    document.body.classList.toggle('keyboard-open', keyboardLikelyOpen);
  };
  updateViewport();
  window.addEventListener('resize', updateViewport, { passive: true });
  window.addEventListener('orientationchange', () => setTimeout(updateViewport, 180), { passive: true });
  window.visualViewport?.addEventListener('resize', updateViewport, { passive: true });
  window.visualViewport?.addEventListener('scroll', updateViewport, { passive: true });

  document.addEventListener('focusin', (event) => {
    const target = event.target;
    if (!target?.matches?.('input, textarea, select')) return;
    document.body.classList.add('input-focused');
    setTimeout(() => {
      target.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    }, 180);
  });

  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!document.activeElement?.matches?.('input, textarea, select')) {
        document.body.classList.remove('input-focused');
      }
    }, 140);
  });
}

function scrollActiveViewToTop() {
  const activeScreen = document.querySelector('.screen.active');
  if (activeScreen) activeScreen.scrollTop = 0;
  window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}



function stopAuthBoundTimers() {
  if (state.autoSyncTimer) clearTimeout(state.autoSyncTimer);
  if (state.autoPullTimer) clearTimeout(state.autoPullTimer);
  if (state.authEventTimer) clearTimeout(state.authEventTimer);
  state.autoSyncTimer = null;
  state.autoPullTimer = null;
  state.authEventTimer = null;
}

function resetAuthRuntimeState() {
  stopAuthBoundTimers();
  state.user = null;
  state.profile = null;
  state.trips = [];
  state.memos = [];
  state.photos = [];
  state.profiles = [];
  state.syncQueue = [];
  state.invites = [];
  state.selectedPhotos = [];
  state.lastCloudPullAt = null;
  closeNotificationPanel();
}

function handleSupabaseAuthEvent(event = '') {
  if (state.logoutInProgress) return;
  if (state.authEventTimer) clearTimeout(state.authEventTimer);
  state.authEventTimer = setTimeout(async () => {
    if (state.logoutInProgress) return;
    try {
      await refreshAuth();
      await loadLocalData();
      renderAll();
      if (state.user) {
        scheduleAutoSync(`auth-${event || 'change'}`, { delay: 1200 });
        setupAutoCloudRefresh();
        scheduleAutoCloudPull('หลัง Login', 1800);
      }
    } catch (error) {
      console.warn('Auth state refresh failed', error);
      setAuthError(error?.message || 'auth_state_refresh_failed');
      renderAuthPanel();
    }
  }, 120);
}

async function handleForcedLogoutOnBoot() {
  try {
    const params = new URLSearchParams(window.location.search);
    const force = params.has('logged_out') || sessionStorage.getItem('tm_force_logout');
    // Do not honor a stale localStorage logout marker on normal app boot.
    // Older builds stored this marker permanently, which could immediately sign out
    // users after a successful Google OAuth callback.
    localStorage.removeItem('tm_force_logout');
    if (!force) return;
    sessionStorage.removeItem('tm_force_logout');
    clearAuthPending();
    clearSupabaseAuthStorage();
    try { await db.clear('profiles'); } catch (_) {}
    if (supabase) await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
  } catch (error) {
    console.warn('forced logout cleanup failed', error);
  }
}

async function completeLogout() {
  if (state.logoutInProgress) return;
  state.logoutInProgress = true;
  showNotice('กำลังออกจากระบบ...');

  const logoutUrl = `${window.location.origin}${window.location.pathname}?logged_out=${Date.now()}&v=${APP_VERSION}`;
  try {
    sessionStorage.setItem('tm_force_logout', '1');
    localStorage.removeItem('tm_force_logout');
  } catch (error) {
    console.warn('cannot mark forced logout', error);
  }

  stopAuthBoundTimers();
  resetAuthRuntimeState();
  applyAuthGate();
  renderAuthPanel();

  try {
    await signOut();
  } catch (error) {
    console.warn('Supabase sign out failed, clearing local auth anyway', error);
  }

  try { clearAuthPending(); } catch (_) {}
  try { clearSupabaseAuthStorage(); } catch (error) { console.warn('auth storage clear failed', error); }
  try { await db.clear('profiles'); } catch (error) { console.warn('profile cache clear failed', error); }

  try {
    await clearTravelMemoCaches({ keepCurrent: false, unregister: true });
  } catch (error) {
    console.warn('travel memo cache clear during logout failed', error);
  }

  state.logoutInProgress = false;
  setTimeout(() => {
    window.location.replace(logoutUrl);
  }, 100);
}

async function refreshAuth() {
  try {
    if (sessionStorage.getItem('tm_force_logout')) {
      resetAuthRuntimeState();
      return;
    }
  } catch (_) {}
  if (!isSupabaseConfigured) {
    state.user = null;
    state.profile = null;
    return;
  }

  const session = await getCurrentSession();
  state.user = session?.user || await getCurrentUser() || getCachedAuthUser();

  if (!state.user) {
    resetAuthRuntimeState();
    return;
  }

  try {
    state.profile = await ensureProfile(state.user);
    await db.put('profiles', { ...state.profile, cached_at: nowIso() });
  } catch (error) {
    console.warn('Profile sync failed; keeping authenticated session with fallback profile', error);
    const metadata = state.user.user_metadata || {};
    state.profile = {
      id: state.user.id,
      email: state.user.email,
      display_name: metadata.full_name || metadata.name || state.user.email?.split('@')[0] || 'Traveler',
      avatar_url: metadata.avatar_url || metadata.picture || '',
      role: 'user'
    };
  }
}

async function loadLocalData() {
  const userId = state.user?.id || null;
  if (!userId) {
    state.trips = [];
    state.memos = [];
    state.photos = [];
    state.profiles = [];
    state.syncQueue = [];
    state.invites = [];
    return;
  }

  const [trips, memos, photos, profiles, syncQueue] = await Promise.all([
    db.getVisible('trips'),
    db.getVisible('memos'),
    db.getVisible('photos'),
    db.getAll('profiles'),
    db.getAll('syncQueue')
  ]);
  const isAdmin = state.profile?.role === 'admin';
  const canDisplay = (item) => isAdmin || item.is_visible !== false;
  state.invites = await fetchInviteSnapshots();
  const acceptedTripIds = invitedOrSharedTripIds();
  const canSeeTrip = (trip) => trip?.user_id === userId || acceptedTripIds.has(trip?.id) || trip?.shared_access === true || trip?.access_level === 'shared';
  state.trips = trips.filter((item) => canSeeTrip(item) && canDisplay(item));
  const visibleTripIds = new Set(state.trips.map((trip) => trip.id).filter(Boolean));
  const canSeeMemo = (memo) => {
    if (!memo) return false;
    if (memo.user_id === userId) return true;
    if (!memo.trip_id) return false;
    return visibleTripIds.has(memo.trip_id) && (memo.shared_access === true || memo.access_level === 'shared');
  };
  state.memos = memos.filter((item) => canSeeMemo(item) && canDisplay(item));
  const visibleMemoIds = new Set(state.memos.map((memo) => memo.id).filter(Boolean));
  const canSeePhoto = (photo) => {
    if (!photo) return false;
    if (photo.user_id === userId) return true;
    const inVisibleTrip = photo.trip_id && visibleTripIds.has(photo.trip_id);
    const inVisibleMemo = photo.memo_id && visibleMemoIds.has(photo.memo_id);
    // Shared photo records from older local caches may not have shared_access/access_level
    // stamped yet. If the parent shared Trip/Memo is already visible, show the photo.
    return Boolean(inVisibleTrip || inVisibleMemo);
  };
  state.photos = await hydratePhotoUrls(photos.filter(canSeePhoto));
  state.profiles = profiles || [];
  if (state.profile && !state.profiles.some((profile) => profile.id === state.profile.id)) {
    state.profiles.push(state.profile);
  }
  state.syncQueue = syncQueue.filter((item) => {
    if (item.user_id && item.user_id !== userId) return false;
    if (item.payload?.user_id && item.payload.user_id !== userId) return false;
    return true;
  });
}

async function cacheInviteProfiles(invites = []) {
  if (!supabase || !state.user || !invites.length) return;
  const ownerIds = [...new Set(invites.map((invite) => invite.owner_id).filter(Boolean))];
  const invitedEmails = [...new Set(invites.map((invite) => String(invite.invited_email || '').trim().toLowerCase()).filter(Boolean))];
  const profiles = [];
  try {
    if (ownerIds.length) {
      const { data } = await supabase
        .from('profiles')
        .select('id,email,display_name,avatar_url,role,created_at')
        .in('id', ownerIds);
      if (data?.length) profiles.push(...data);
    }
  } catch (error) {
    console.warn('Invite owner profile cache failed', error);
  }
  try {
    if (invitedEmails.length) {
      const { data } = await supabase
        .from('profiles')
        .select('id,email,display_name,avatar_url,role,created_at')
        .in('email', invitedEmails);
      if (data?.length) profiles.push(...data);
    }
  } catch (error) {
    console.warn('Invitee profile cache failed', error);
  }
  if (!profiles.length) return;
  const byId = new Map([...(state.profiles || []), ...profiles].filter((profile) => profile?.id).map((profile) => [profile.id, profile]));
  state.profiles = [...byId.values()];
  try { await db.putMany('profiles', profiles); } catch (_) {}
}

async function fetchInviteSnapshots() {
  if (!supabase || !state.user) return [];
  try {
    let invites = [];
    const { data, error } = await supabase
      .from('trip_invites')
      .select('id,trip_id,owner_id,invited_email,role,status,created_at,updated_at,expires_at')
      .order('updated_at', { ascending: false });
    if (error) throw error;
    invites = data || [];

    // For invitees, RLS may hide the Trip row until they accept. This RPC returns
    // safe display fields such as trip_title and owner profile for the notification card.
    try {
      const { data: richInvites, error: richError } = await supabase.rpc('list_my_trip_invites');
      if (!richError && Array.isArray(richInvites) && richInvites.length) {
        const byId = new Map(invites.map((invite) => [invite.id, invite]));
        for (const item of richInvites) {
          byId.set(item.id, { ...(byId.get(item.id) || {}), ...item });
        }
        invites = [...byId.values()].sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
      }
    } catch (rpcError) {
      console.warn('Rich invite list unavailable', rpcError);
    }

    await cacheInviteProfiles(invites);
    return invites;
  } catch (error) {
    console.warn('Invite list unavailable', error);
    return [];
  }
}

function applyAuthGate() {
  const loggedIn = Boolean(state.user);
  const app = document.getElementById('app');
  state.authReady = true;
  app?.classList.remove('auth-checking');
  app?.classList.toggle('logged-out', !loggedIn);
  app?.classList.toggle('logged-in', loggedIn);
  if (!loggedIn && state.view !== 'home') openView('home', { silent: true });
}

function renderAll() {
  applyAuthGate();
  renderAuthPanel();
  renderNotificationCenter();
  renderSummary();
  renderTripSelects();
  renderLatestMemos();
  renderHomeTrips();
  renderSelectedPhotos();
  renderMoodRatingPickers();
  renderTrips();
  renderTimeline();
  renderMapMarkers();
  renderSettings();
  renderQueuePanel();
  processShareDeepLink();
}

function setupNetworkStatus() {
  const online = navigator.onLine;
  els.networkStatus.textContent = online ? 'Online' : 'Offline';
  els.networkStatus.classList.toggle('online', online);
  els.networkStatus.classList.toggle('offline', !online);
}


function currentAuthErrorMessage() {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('auth_error') || localStorage.getItem('travel_memo_last_auth_error') || '';
  } catch (_) {
    return '';
  }
}

function clearAuthErrorMessage() {
  try {
    clearAuthError();
    if (window.location.search.includes('auth_error=')) {
      window.history.replaceState({}, document.title, `${window.location.origin}${window.location.pathname}`);
    }
  } catch (_) {}
}

function openView(view, options = {}) {
  if (state.publicShareMode) return;
  if (!state.user && view !== 'home') {
    if (!options.silent) showNotice('เข้าสู่ระบบด้วย Google ก่อนใช้งาน Travel Memo');
    view = 'home';
  }
  state.view = view;
  $$('.screen').forEach((screen) => screen.classList.toggle('active', screen.id === `${view}Screen`));
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.open === view));
  const active = $(`#${view}Screen`);
  els.screenTitle.textContent = active?.dataset.title || 'Travel Memo';
  scrollActiveViewToTop();
  if (view === 'map') {
    initMap();
    setTimeout(() => {
      state.map?.invalidateSize();
      fitMapToMarkers(false);
    }, 140);
  }
  if (view === 'admin') renderAdmin();
}

function renderAuthPanel() {
  if (!isSupabaseConfigured) {
    els.authPanel.innerHTML = `
      <div class="auth-hero-icon">${tmIcon('storage')}</div>
      <h2>โหมด Local</h2>
      <p>ยังไม่ได้ตั้งค่า Supabase ในไฟล์ <code>.env.local</code> แอปยังบันทึกในเครื่องได้ แต่ยังซิงก์ cloud ไม่ได้</p>
      <p class="muted">ตั้งค่า <code>VITE_SUPABASE_URL</code> และ <code>VITE_SUPABASE_ANON_KEY</code> แล้ว deploy บน Vercel เพื่อใช้งานจริง</p>
    `;
    return;
  }

  if (!state.user) {
    els.authPanel.innerHTML = `
      <div class="auth-hero-icon">${tmIcon('app-mark')}</div>
      <h2>เข้าสู่พื้นที่ส่วนตัวของคุณ</h2>
      <p>Travel Memo เป็นพื้นที่ส่วนตัว ต้องเข้าสู่ระบบด้วย Google ก่อนจึงจะเห็น Memo, Trip และรูปภาพของคุณ</p>
      ${isAuthPending() ? `<div class="auth-info-box"><strong>กำลังรอผลจาก Google Login</strong><span>ถ้าหน้าไม่เปลี่ยนหลังจากกลับจาก Google ให้กดปุ่มเข้าสู่ระบบอีกครั้ง</span></div>` : ''}
      ${currentAuthErrorMessage() ? `<div class="auth-error-box"><strong>เข้าสู่ระบบไม่สำเร็จ</strong><span>${escapeHtml(currentAuthErrorMessage())}</span><small>กดปุ่ม Google อีกครั้ง หรือเปิด /reset-cache.html แล้วลองใหม่</small></div>` : ''}
      <div class="google-login-wrap" aria-label="Google login only">
        <button id="googleLoginButton" class="google-only-button" type="button" data-auth-provider="google" aria-label="เข้าสู่ระบบด้วย Google">
          <span class="google-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="30" height="30" focusable="false">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.84z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06L5.84 9.9c.87-2.6 3.3-4.52 6.16-4.52z"/>
            </svg>
          </span>
          <span>เข้าสู่ระบบด้วย Google</span>
        </button>
      </div>
      <p class="muted small-note">ข้อมูลของคุณจะถูกแสดงเฉพาะบัญชีนี้เท่านั้น ส่วน Trip ของคนอื่นจะเห็นได้ต่อเมื่อเจ้าของเชิญผ่านอีเมล</p>
    `;
    bindAuthDirectButtons();
    return;
  }

  const role = state.profile?.role || 'user';
  const avatar = state.profile?.avatar_url || state.user.user_metadata?.avatar_url || state.user.user_metadata?.picture || '';
  const name = state.profile?.display_name || state.user.user_metadata?.full_name || state.user.user_metadata?.name || state.user.email || 'Traveler';
  const provider = state.user.app_metadata?.provider || 'google';
  const notificationCount = notificationCenterCount();
  els.authPanel.innerHTML = `
    <div class="profile-card clean-profile-card">
      <div class="profile-main">
        <div class="profile-avatar">${avatar ? `<img src="${escapeHtml(avatar)}" alt="Profile" />` : escapeHtml((name || 'T').slice(0,1).toUpperCase())}</div>
        <div>
          <div class="profile-kicker">${tmIcon('cloud-sync')}<span>Cloud Profile</span></div>
          <h2>${escapeHtml(name)}</h2>
          <p>${escapeHtml(state.user.email || '')} · ${escapeHtml(provider)} · role: <strong>${escapeHtml(role)}</strong></p>
        </div>
      </div>
      <div class="profile-actions profile-actions-v2129">
        <button id="inviteCenterButton" class="profile-action-button invite-center-button" type="button" data-profile-action="toggle-notifications" aria-label="แจ้งเตือน Trip">
          ${tmIcon('queue')}
          ${notificationCount ? `<b>${notificationCount}</b>` : ''}
          <small>แจ้งเตือน</small>
        </button>
        <button id="profilePullCloudButton" class="profile-action-button profile-sync-button" type="button" aria-label="ดึงข้อมูลจาก Cloud">
          ${tmIcon('cloud-sync')}
          <small>ดึง Cloud</small>
        </button>
        <button id="profileSyncNowButton" class="profile-action-button profile-sync-button primary-sync" type="button" aria-label="ซิงก์ตอนนี้">
          ${tmIcon('sync')}
          <small>ซิงก์</small>
        </button>
        <button id="logoutButton" class="ghost-button danger-soft logout-button" type="button" data-auth-action="logout">${tmIcon('logout')}<span>ออกจากระบบ</span></button>
      </div>
    </div>
    <div id="profileSyncStatusText" class="profile-sync-status" aria-live="polite">พร้อมอัปเดตข้อมูลอัตโนมัติ</div>
  `;
  bindAuthDirectButtons();
  updateAutoSyncStatus();
}

function bindAuthDirectButtons() {
  requestAnimationFrame(() => {
    const googleButton = document.getElementById('googleLoginButton');
    if (googleButton && !googleButton.dataset.bound) {
      googleButton.dataset.bound = '1';
      googleButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        startGoogleLogin(googleButton);
      });
    }
    const inviteCenterButton = document.getElementById('inviteCenterButton');
    if (inviteCenterButton && !inviteCenterButton.dataset.bound) {
      inviteCenterButton.dataset.bound = '1';
      inviteCenterButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const panel = document.getElementById('inviteNotificationPanel');
        if (panel?.classList.contains('expanded')) {
          panel.classList.remove('expanded');
          return;
        }
        // Rebuild on every open so invite/activity buttons always bind through
        // delegated document handlers and never use stale DOM from a prior render.
        renderNotificationCenter({ forceOpen: true });
        markActivityNotificationsSeen();
      });
    }
    const profileSyncNowButton = document.getElementById('profileSyncNowButton');
    if (profileSyncNowButton && !profileSyncNowButton.dataset.bound) {
      profileSyncNowButton.dataset.bound = '1';
      profileSyncNowButton.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        profileSyncNowButton.disabled = true;
        const originalText = profileSyncNowButton.innerHTML;
        profileSyncNowButton.innerHTML = `${tmIcon('sync')}<small>ซิงก์...</small>`;
        try {
          await runSync({ includePull: false });
        } finally {
          profileSyncNowButton.disabled = false;
          profileSyncNowButton.innerHTML = originalText;
        }
      });
    }
    const profilePullCloudButton = document.getElementById('profilePullCloudButton');
    if (profilePullCloudButton && !profilePullCloudButton.dataset.bound) {
      profilePullCloudButton.dataset.bound = '1';
      profilePullCloudButton.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        profilePullCloudButton.disabled = true;
        const originalText = profilePullCloudButton.innerHTML;
        profilePullCloudButton.innerHTML = `${tmIcon('cloud-sync')}<small>กำลังดึง...</small>`;
        try {
          await pullCloudData();
        } finally {
          profilePullCloudButton.disabled = false;
          profilePullCloudButton.innerHTML = originalText;
        }
      });
    }
    const logoutButton = document.getElementById('logoutButton');
    if (logoutButton && !logoutButton.dataset.bound) {
      logoutButton.dataset.bound = '1';
      logoutButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        logoutButton.disabled = true;
        completeLogout();
      });
    }
  });
}

async function handleAuthClick(event) {
  const providerButton = event.target.closest('[data-auth-provider]');
  if (providerButton) {
    event.preventDefault();
    event.stopPropagation();
    await startGoogleLogin(providerButton);
    return;
  }

  const button = event.target.closest('[data-auth-action]');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  if (button.dataset.authAction === 'logout') {
    button.disabled = true;
    await completeLogout();
  }
}

function handleAuthClickCapture(event) {
  const authButton = event.target.closest('[data-auth-provider], [data-auth-action]');
  if (!authButton) return;
  if (!els.authPanel?.contains(authButton)) return;
  event.preventDefault();
  event.stopPropagation();
  if (authButton.dataset.authProvider === 'google') {
    startGoogleLogin(authButton);
  } else if (authButton.dataset.authAction === 'logout') {
    authButton.disabled = true;
    completeLogout();
  }
}

async function handleGlobalAuthClick(event) {
  const authButton = event.target.closest('[data-auth-provider], [data-auth-action]');
  if (!authButton || els.authPanel.contains(authButton)) return;
  event.preventDefault();
  if (authButton.dataset.authProvider) {
    await startGoogleLogin(authButton);
    return;
  }
  if (authButton.dataset.authAction === 'logout') {
    authButton.disabled = true;
    await completeLogout();
  }
}

async function startGoogleLogin(providerButton) {
  const provider = providerButton?.dataset?.authProvider || 'google';
  if (provider !== 'google') {
    showNotice('เวอร์ชันนี้เปิดใช้งาน Google Login เท่านั้น');
    return;
  }
  if (!isSupabaseConfigured) {
    showNotice('ยังไม่ได้ตั้งค่า Supabase สำหรับ Google Login');
    return;
  }
  if (providerButton) providerButton.disabled = true;
  try {
    clearAuthErrorMessage();
    showNotice('กำลังเปิดหน้าเข้าสู่ระบบ Google...');
    await signInWithProvider('google');
  } catch (error) {
    if (providerButton) providerButton.disabled = false;
    const message = providerErrorMessage('google', error);
    setAuthError(message);
    showNotice(message);
  }
}

function providerErrorMessage(provider, error) {
  const detail = error?.message || '';
  if (/Unsupported provider|provider is not enabled|not enabled|not configured/i.test(detail)) {
    return `Google ยังไม่ได้เปิดใน Supabase Auth > Providers หรือ Client ID/Secret ยังไม่ถูกต้อง`;
  }
  if (/redirect|callback|url/i.test(detail)) {
    return `Redirect URL ของ Google ยังไม่ตรง ให้ตรวจ Supabase Auth URL Configuration`;
  }
  return detail || `เข้าสู่ระบบผ่าน ${provider} ไม่สำเร็จ`;
}


function currentUserEmail() {
  return String(state.user?.email || state.profile?.email || '').trim().toLowerCase();
}

function pendingInvitesForCurrentUser() {
  const email = currentUserEmail();
  if (!email) return [];
  return (state.invites || []).filter((invite) => {
    const status = String(invite.status || 'pending').toLowerCase();
    return String(invite.invited_email || '').toLowerCase() === email
      && status === 'pending'
      && (!invite.expires_at || new Date(invite.expires_at) > new Date());
  });
}

function invitedOrSharedTripIds() {
  const email = currentUserEmail();
  return new Set((state.invites || [])
    .filter((invite) => String(invite.invited_email || '').toLowerCase() === email && String(invite.status || '').toLowerCase() === 'accepted')
    .map((invite) => invite.trip_id)
    .filter(Boolean));
}

function canAccessTrip(trip) {
  if (!trip || !state.user) return false;
  if (trip.user_id === state.user.id) return true;
  const acceptedTripIds = invitedOrSharedTripIds();
  if (acceptedTripIds.has(trip.id)) return true;
  return trip.shared_access === true || trip.access_level === 'shared';
}

function canContributeToTrip(trip) {
  if (!trip || !state.user) return false;
  if (trip.user_id === state.user.id) return true;
  const email = currentUserEmail();
  return (state.invites || []).some((invite) => {
    const status = String(invite.status || '').toLowerCase();
    const role = String(invite.role || 'viewer').toLowerCase();
    return invite.trip_id === trip.id
      && String(invite.invited_email || '').toLowerCase() === email
      && status === 'accepted'
      && ['viewer', 'editor', 'member', 'contributor'].includes(role);
  }) || trip.shared_access === true || trip.access_level === 'shared';
}

function shortText(value, limit = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function memoHighlight(memo) {
  return String(memo?.note || '').trim();
}

function memoStory(memo) {
  return String(memo?.diary || '').trim();
}

function memoStoryText(memo) {
  return memoStory(memo);
}

function renderMemoTextPreview(memo, options = {}) {
  const highlight = shortText(memoHighlight(memo), options.highlightLimit || options.noteLimit || 110);
  const story = shortText(memoStory(memo), options.storyLimit || options.diaryLimit || 150);
  if (!highlight && !story) return '';
  return `
    <div class="memo-preview-stack story-preview-stack">
      ${highlight ? `<p class="memo-preview"><strong>Highlight:</strong> ${escapeHtml(highlight)}</p>` : ''}
      ${story ? `<p class="memo-preview diary-preview"><strong>บันทึกการเดินทาง:</strong> ${escapeHtml(story)}</p>` : ''}
    </div>`;
}

function tripNameForInvite(invite) {
  const trip = state.trips.find((item) => item.id === invite.trip_id);
  return invite?.trip_title || trip?.title || 'Trip ที่มีคนเชิญคุณ';
}

function inviteOwnerLabel(invite) {
  const profile = profileById(invite?.owner_id) || profileByEmail(invite?.owner_email);
  return profile?.display_name || invite?.owner_name || invite?.owner_email || 'เจ้าของ Trip';
}

function activitySeenStorageKey() {
  return state.user?.id ? `travel_memo_activity_seen_${state.user.id}` : 'travel_memo_activity_seen_guest';
}

function activitySeenAt() {
  const raw = localStorage.getItem(activitySeenStorageKey());
  const timestamp = raw ? Date.parse(raw) : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function refreshNotificationBadge() {
  const button = document.getElementById('inviteCenterButton');
  if (!button) return;
  const count = notificationCenterCount();
  let badge = button.querySelector('b');
  if (count) {
    if (!badge) {
      badge = document.createElement('b');
      button.insertBefore(badge, button.querySelector('small'));
    }
    badge.textContent = String(count);
  } else if (badge) {
    badge.remove();
  }
}

function markActivityNotificationsSeen(options = {}) {
  if (!state.user) return;
  localStorage.setItem(activitySeenStorageKey(), nowIso());
  refreshNotificationBadge();
  if (options.rerender) requestAnimationFrame(() => renderAuthPanel());
}

function accessibleTripIdSetForNotifications() {
  return new Set((state.trips || [])
    .filter((trip) => !trip.deleted_at && (trip.user_id === state.user?.id || canAccessTrip(trip)))
    .map((trip) => trip.id));
}

function activityNotificationsForCurrentUser() {
  if (!state.user) return [];
  const seenAt = activitySeenAt();
  const tripIds = accessibleTripIdSetForNotifications();
  const byTrip = new Map();
  const addActivity = (tripId, type, item) => {
    if (!tripId || !tripIds.has(tripId)) return;
    if (!item || item.deleted_at || item.user_id === state.user.id) return;
    const timeValue = Date.parse(item.updated_at || item.created_at || item.taken_at || '');
    if (!Number.isFinite(timeValue) || timeValue <= seenAt) return;
    const trip = tripById(tripId);
    const key = `${tripId}:${type}`;
    const current = byTrip.get(key) || {
      id: key,
      tripId,
      type,
      count: 0,
      latest: 0,
      tripTitle: trip?.title || 'Trip ที่แชร์',
      actorIds: new Set()
    };
    current.count += 1;
    current.latest = Math.max(current.latest, timeValue);
    if (item.user_id) current.actorIds.add(item.user_id);
    byTrip.set(key, current);
  };

  (state.memos || []).forEach((memo) => addActivity(memo.trip_id, 'memo', memo));
  const memoTripById = new Map((state.memos || []).filter((memo) => memo?.id).map((memo) => [memo.id, memo.trip_id]));
  (state.photos || []).forEach((photo) => addActivity(photo.trip_id || memoTripById.get(photo.memo_id), 'photo', photo));

  return [...byTrip.values()]
    .sort((a, b) => b.latest - a.latest)
    .map((item) => ({ ...item, actorIds: [...item.actorIds] }));
}

function notificationCenterCount() {
  return pendingInvitesForCurrentUser().length + activityNotificationsForCurrentUser().reduce((sum, item) => sum + item.count, 0);
}

function activityActorLabel(actorIds = []) {
  const names = actorIds
    .map((id) => profileById(id)?.display_name || profileById(id)?.email)
    .filter(Boolean);
  if (!names.length) return 'ผู้ร่วม Trip';
  const unique = [...new Set(names)];
  return unique.length === 1 ? unique[0] : `${unique[0]} และอีก ${unique.length - 1} คน`;
}

function renderNotificationCenter(options = {}) {
  if (!els.authPanel || !state.user) return;
  const pending = pendingInvitesForCurrentUser();
  const activities = activityNotificationsForCurrentUser();
  const existing = document.getElementById('inviteNotificationPanel');
  existing?.remove();
  if (!pending.length && !activities.length && !options.forceOpen) return;
  const panel = document.createElement('section');
  panel.id = 'inviteNotificationPanel';
  panel.className = `invite-notification-panel notification-center-panel glass-card ${options.forceOpen ? 'expanded' : ''}`;
  panel.innerHTML = `
    <div class="invite-notification-head">
      <span class="invite-bell">${tmIcon('queue')}</span>
      <div>
        <strong>แจ้งเตือน ${pending.length + activities.reduce((sum, item) => sum + item.count, 0)} รายการ</strong>
        <p>รวมคำเชิญ Trip และความเคลื่อนไหวใหม่จากผู้สร้างหรือผู้ร่วม Trip เท่านั้น</p>
      </div>
    </div>
    <div class="invite-notification-list notification-center-list">
      ${pending.length ? `<div class="notification-section-title">${tmIcon('user')}<span>คำเชิญเข้าร่วม Trip</span></div>` : ''}
      ${pending.map((invite) => `
        <article class="invite-notification-item notification-item invite-item">
          <div>
            <strong>${escapeHtml(tripNameForInvite(invite))}</strong>
            <small>สิทธิ์: ${escapeHtml(invite.role || 'viewer')} · จาก ${escapeHtml(inviteOwnerLabel(invite))}</small>
          </div>
          <div class="invite-notification-actions">
            <button class="primary-button small-action" type="button" data-invite-action="accept" data-id="${escapeHtml(invite.id)}">เข้าร่วม</button>
            <button class="ghost-button small-action" type="button" data-invite-action="decline" data-id="${escapeHtml(invite.id)}">ปฏิเสธ</button>
          </div>
        </article>`).join('')}
      ${activities.length ? `<div class="notification-section-title">${tmIcon('trips')}<span>ความเคลื่อนไหวใน Trip</span></div>` : ''}
      ${activities.map((activity) => `
        <article class="invite-notification-item notification-item activity-item">
          <div>
            <strong>${escapeHtml(activity.tripTitle)}</strong>
            <small>${activity.type === 'memo' ? 'มี Memo ใหม่' : 'มีรูปภาพใหม่'} ${activity.count} รายการ · โดย ${escapeHtml(activityActorLabel(activity.actorIds))}</small>
          </div>
          <div class="invite-notification-actions">
            <button class="ghost-button small-action" type="button" data-notification-trip-action="view" data-id="${escapeHtml(activity.tripId)}">ดู Trip</button>
            <button class="ghost-button small-action" type="button" data-notification-trip-action="timeline" data-id="${escapeHtml(activity.tripId)}">Timeline</button>
          </div>
        </article>`).join('')}
      ${!pending.length && !activities.length ? '<article class="invite-notification-item notification-item empty-notification"><strong>ยังไม่มีแจ้งเตือนใหม่</strong><small>คำเชิญและ Memo/รูปภาพใหม่จากผู้ร่วม Trip จะแสดงตรงนี้</small></article>' : ''}
    </div>
  `;
  els.authPanel.insertAdjacentElement('beforeend', panel);
  // Do not re-render authPanel here; the notification panel lives inside it.
  // Re-rendering immediately after opening was removing the panel and made
  // invite accept/decline buttons appear unresponsive.
}

function renderInviteNotifications(options = {}) {
  renderNotificationCenter(options);
}

function normalizeRpcTripId(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return normalizeRpcTripId(value[0]);
  if (typeof value === 'object') {
    return value.trip_id || value.p_trip_id || value.id || value.accepted_trip_id || '';
  }
  return String(value || '');
}


function closeNotificationPanel() {
  const panel = document.getElementById('inviteNotificationPanel');
  if (panel) panel.remove();
}

async function openTripFromNotification(tripId, action = 'view') {
  if (!tripId) return;
  markActivityNotificationsSeen({ silent: true });
  closeNotificationPanel();
  await loadLocalData();
  const trip = state.trips.find((item) => item.id === tripId);
  if (!trip) {
    showNotice('ยังไม่พบ Trip นี้ในเครื่อง กำลังดึงข้อมูลจาก Cloud...');
    try {
      await fetchAcceptedTripIntoLocal(tripId);
      await loadLocalData();
    } catch (error) {
      console.warn('notification shared trip pull failed', error);
    }
  }
  if (action === 'timeline') {
    closeSheet();
    openView('timeline');
    if (els.timelineTripFilter) els.timelineTripFilter.value = tripId;
    renderTimeline();
    return;
  }
  openTripSheet(tripId);
}

async function handleInviteNotificationAction(event) {
  const notificationTripButton = event.target.closest?.('[data-notification-trip-action]');
  if (notificationTripButton) {
    event.preventDefault();
    event.stopPropagation();
    const tripId = notificationTripButton.dataset.id;
    const action = notificationTripButton.dataset.notificationTripAction || 'view';
    notificationTripButton.disabled = true;
    try {
      await openTripFromNotification(tripId, action);
    } finally {
      if (notificationTripButton.isConnected) notificationTripButton.disabled = false;
    }
    return;
  }

  const button = event.target.closest?.('[data-invite-action]');
  if (!button || state.inviteActionInProgress) return;
  event.preventDefault();
  event.stopPropagation();
  const action = button.dataset.inviteAction;
  const inviteId = button.dataset.id;
  if (!inviteId || !supabase || !state.user) return;
  state.inviteActionInProgress = true;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = action === 'accept' ? 'กำลังเข้าร่วม...' : 'กำลังปฏิเสธ...';
  try {
    const rpcName = action === 'accept' ? 'accept_trip_invite' : 'decline_trip_invite';
    const { data: rawTripId, error } = await supabase.rpc(rpcName, { p_invite_id: inviteId });
    if (error) throw error;
    const tripId = normalizeRpcTripId(rawTripId) || (state.invites || []).find((invite) => invite.id === inviteId)?.trip_id || '';
    showNotice(action === 'accept' ? 'เข้าร่วม Trip แล้ว กำลังดึงข้อมูล...' : 'ปฏิเสธคำเชิญแล้ว');
    state.invites = await fetchInviteSnapshots();
    if (action === 'accept') {
      let sharedResult = { trips: 0, memos: 0, photos: 0 };
      if (tripId) sharedResult = await fetchAcceptedTripIntoLocal(tripId);
      try {
        await pullCloudData(true);
      } catch (pullError) {
        console.warn('pull after invite accept skipped', pullError);
      }
      await loadLocalData();
      openView('home');
      renderAll();
      const panel = document.getElementById('inviteNotificationPanel');
      panel?.remove();
      showNotice(`เข้าร่วม Trip สำเร็จแล้ว${sharedResult.memos || sharedResult.photos ? ` · โหลด ${sharedResult.memos || 0} Memo / ${sharedResult.photos || 0} รูป` : ''}`);
      scheduleAutoCloudPull('invite-accepted', 1500);
    } else {
      await loadLocalData();
      renderAll();
      renderNotificationCenter({ forceOpen: true });
    }
  } catch (error) {
    console.error('invite action failed', error);
    logClientError('invite_action_failed', error);
    showNotice(error?.message || 'จัดการคำเชิญไม่สำเร็จ');
  } finally {
    state.inviteActionInProgress = false;
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

function normalizeBundleRows(bundle = {}) {
  const fromJson = (value) => Array.isArray(value) ? value : [];
  return {
    trip: bundle.trip || null,
    memos: fromJson(bundle.memos),
    photos: fromJson(bundle.photos),
    profiles: fromJson(bundle.profiles),
    invites: fromJson(bundle.invites)
  };
}

async function saveTripBundleToLocal(bundle, options = {}) {
  if (!bundle || !state.user) return { trips: 0, memos: 0, photos: 0 };
  const { trip, memos, photos, profiles, invites } = normalizeBundleRows(bundle);
  const stamp = nowIso();
  if (profiles.length) {
    const mergedProfiles = [...new Map([...(state.profiles || []), ...profiles].filter((profile) => profile?.id).map((profile) => [profile.id, profile])).values()];
    state.profiles = mergedProfiles;
    await db.putMany('profiles', profiles);
  }
  if (invites.length) {
    const byId = new Map([...(state.invites || []), ...invites].filter((invite) => invite?.id).map((invite) => [invite.id, invite]));
    state.invites = [...byId.values()];
  }
  if (trip?.id) {
    await db.put('trips', {
      ...trip,
      shared_access: trip.user_id !== state.user.id,
      access_level: trip.user_id === state.user.id ? 'owner' : 'shared',
      sync_status: 'synced',
      last_synced_at: stamp
    });
  }
  if (memos.length) {
    await db.putMany('memos', memos.map((memo) => ({
      ...memo,
      shared_access: memo.user_id !== state.user.id,
      access_level: memo.user_id === state.user.id ? 'owner' : 'shared',
      sync_status: 'synced',
      last_synced_at: stamp
    })));
  }
  if (photos.length) {
    const hydrated = await hydratePhotoUrls(photos.map((photo) => ({
      ...photo,
      shared_access: photo.user_id !== state.user.id,
      access_level: photo.user_id === state.user.id ? 'owner' : 'shared',
      sync_status: 'synced',
      last_synced_at: stamp
    })));
    await db.putMany('photos', hydrated);
  }
  if (options.notice !== false && trip?.title) showNotice(`ดึงข้อมูล Trip “${trip.title}” แล้ว`);
  return { trips: trip ? 1 : 0, memos: memos.length, photos: photos.length };
}

async function fetchAcceptedTripIntoLocal(tripId) {
  if (!tripId || !supabase || !state.user) return { trips: 0, memos: 0, photos: 0 };
  try {
    const rpcNames = ['get_trip_shared_bundle_v2', 'get_trip_shared_bundle'];
    for (const rpcName of rpcNames) {
      let bundle = null;
      let bundleError = null;
      try {
        const result = await supabase.rpc(rpcName, { p_trip_id: tripId });
        bundle = result?.data;
        bundleError = result?.error;
      } catch (rpcError) {
        bundleError = rpcError;
      }
      if (!bundleError && bundle) {
        const result = await saveTripBundleToLocal(bundle, { notice: false });
        if (result.trips || result.memos || result.photos) return result;
      }
      if (bundleError) console.warn(`${rpcName} unavailable`, bundleError);
    }

    const { data: trip, error: tripError } = await supabase
      .from('trips')
      .select('*')
      .eq('id', tripId)
      .maybeSingle();
    let savedTrips = 0;
    if (!tripError && trip) {
      await db.put('trips', { ...trip, shared_access: trip.user_id !== state.user.id, access_level: trip.user_id === state.user.id ? 'owner' : 'shared', sync_status: 'synced', last_synced_at: nowIso() });
      savedTrips = 1;
    }
    let memos = [];
    try {
      const { data: memoRows, error: memoError } = await supabase
        .from('memos')
        .select('*')
        .eq('trip_id', tripId)
        .is('deleted_at', null)
        .order('visited_at', { ascending: false });
      if (!memoError && memoRows?.length) memos = memoRows;
    } catch (error) {
      console.warn('Direct shared memo pull failed', error);
    }
    if (memos?.length) await db.putMany('memos', memos.map((memo) => ({ ...memo, shared_access: memo.user_id !== state.user.id, access_level: memo.user_id === state.user.id ? 'owner' : 'shared', sync_status: 'synced', last_synced_at: nowIso() })));
    const memoIds = (memos || []).map((memo) => memo.id).filter(Boolean);
    let photos = [];
    try {
      const photoQuery = supabase
        .from('photos')
        .select('*')
        .or(`trip_id.eq.${tripId}${memoIds.length ? `,memo_id.in.(${memoIds.join(',')})` : ''}`)
        .is('deleted_at', null);
      const { data: photoRows, error: photoError } = await photoQuery;
      if (!photoError && photoRows?.length) photos = photoRows;
    } catch (error) {
      console.warn('Direct shared photo pull failed', error);
    }
    if (photos?.length) {
      const hydrated = await hydratePhotoUrls(photos.map((photo) => ({ ...photo, shared_access: photo.user_id !== state.user.id, access_level: photo.user_id === state.user.id ? 'owner' : 'shared', sync_status: 'synced', last_synced_at: nowIso() })));
      await db.putMany('photos', hydrated);
    }
    return { trips: savedTrips, memos: memos?.length || 0, photos: photos?.length || 0 };
  } catch (error) {
    console.warn('Accepted trip direct pull failed', error);
    logClientError('fetch_shared_trip_failed', error);
    return { trips: 0, memos: 0, photos: 0 };
  }
}

const sharedTripContentLoading = new Set();

function ensureSharedTripContent(tripId) {
  if (!tripId || sharedTripContentLoading.has(tripId)) return;
  const trip = state.trips.find((item) => item.id === tripId);
  if (!trip || trip.user_id === state.user?.id) return;
  const hasMemo = state.memos.some((memo) => memo.trip_id === tripId);
  const hasPhoto = state.photos.some((photo) => photo.trip_id === tripId || state.memos.some((memo) => memo.trip_id === tripId && memo.id === photo.memo_id));
  if (hasMemo && hasPhoto) return;
  sharedTripContentLoading.add(tripId);
  showNotice(hasMemo ? 'กำลังโหลดรูปของ Trip ที่แชร์...' : 'กำลังโหลด Memo และรูปของ Trip ที่แชร์...');
  fetchAcceptedTripIntoLocal(tripId)
    .then(async (result) => {
      await loadLocalData();
      renderAll();
      if ((result?.memos || 0) > 0 || (result?.photos || 0) > 0) {
        openTripSheet(tripId);
        showNotice(`โหลด Trip ที่แชร์แล้ว: ${result.memos || 0} Memo, ${result.photos || 0} รูป`);
      } else {
        showNotice('ยังไม่พบ Memo หรือรูปใน Trip ที่แชร์');
      }
    })
    .catch((error) => {
      console.warn('shared trip content refresh failed', error);
      logClientError('shared_trip_content_refresh_failed', error);
    })
    .finally(() => sharedTripContentLoading.delete(tripId));
}

function renderSummary() {
  els.statMemo.textContent = state.memos.length;
  els.statTrip.textContent = state.trips.length;
  els.statPhoto.textContent = state.photos.length;
  els.statQueue.textContent = state.syncQueue.length;
  const cloud = state.user ? `พื้นที่ส่วนตัว: ${state.user.email}` : 'เข้าสู่ระบบเพื่อเปิดพื้นที่ส่วนตัว';
  const failed = state.syncQueue.filter((item) => item.status === 'failed' || item.last_error).length;
  const syncing = state.syncQueue.filter((item) => item.status === 'syncing' || item.status === 'retrying').length;
  if (els.syncStatusText) els.syncStatusText.textContent = state.syncQueue.length
    ? `${cloud} · รอซิงก์ ${state.syncQueue.length} รายการ${failed ? ` · มีข้อผิดพลาด ${failed}` : syncing ? ' · กำลังซิงก์' : ''}`
    : `${cloud} · ซิงก์แล้ว`;
  els.networkStatus.classList.toggle('pending', state.syncQueue.length > 0);
  updateAutoSyncStatus();
}

function renderTripSelects() {
  const previousMemoTrip = els.memoTrip?.value || '';
  const previousTimelineTrip = els.timelineTripFilter?.value || '';
  const previousMapTrip = els.mapTripFilter?.value || '';
  const tripOptions = sortTrips(state.trips).map((trip) => `<option value="${trip.id}">${escapeHtml(trip.title)}</option>`).join('');
  const options = `<option value="">ไม่จัด Trip</option>${tripOptions}`;
  els.memoTrip.innerHTML = options;
  els.timelineTripFilter.innerHTML = `<option value="">ทุก Memo</option>${tripOptions}`;
  els.mapTripFilter.innerHTML = `<option value="">ทุก Trip</option>${tripOptions}`;

  if ([...els.memoTrip.options].some((option) => option.value === previousMemoTrip)) els.memoTrip.value = previousMemoTrip;
  if ([...els.timelineTripFilter.options].some((option) => option.value === previousTimelineTrip)) els.timelineTripFilter.value = previousTimelineTrip;
  if ([...els.mapTripFilter.options].some((option) => option.value === previousMapTrip)) els.mapTripFilter.value = previousMapTrip;
}

function clampPage(page, totalPages) {
  const safeTotal = Math.max(1, Number(totalPages || 1));
  const safePage = Number(page || 1);
  return Math.min(Math.max(1, safePage), safeTotal);
}

function paginateItems(items, page, pageSize) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = clampPage(page, totalPages);
  const start = (current - 1) * pageSize;
  return { current, totalPages, items: items.slice(start, start + pageSize) };
}

function paginationRange(current, totalPages) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  const pages = new Set([1, totalPages, current, current - 1, current + 1]);
  return [...pages].filter((page) => page >= 1 && page <= totalPages).sort((a, b) => a - b);
}

function renderHomePagination(kind, current, totalPages, totalItems) {
  if (totalPages <= 1) return '';
  const pages = paginationRange(current, totalPages);
  let last = 0;
  const buttons = [];
  for (const page of pages) {
    if (last && page - last > 1) buttons.push('<span class="home-page-ellipsis">…</span>');
    buttons.push(`<button class="home-page-button${page === current ? ' active' : ''}" type="button" data-home-page="${kind}" data-page="${page}" aria-label="หน้า ${page}">${page}</button>`);
    last = page;
  }
  return `<nav class="home-pagination" aria-label="เลือกหน้ารายการ${kind === 'memo' ? ' Memo' : ' Trip'}"><span>${current}/${totalPages} · ทั้งหมด ${totalItems}</span><div>${buttons.join('')}</div></nav>`;
}

function handleHomePagination(event) {
  const button = event.target.closest?.('[data-home-page]');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  const page = Number(button.dataset.page || 1);
  if (button.dataset.homePage === 'memo') {
    state.homeMemoPage = page;
    renderLatestMemos();
  } else if (button.dataset.homePage === 'trip') {
    state.homeTripPage = page;
    renderHomeTrips();
  }
}

function renderLatestMemos() {
  const all = sortByDateDesc(state.memos).filter((memo) => !memo.deleted_at);
  const { current, totalPages, items } = paginateItems(all, state.homeMemoPage, state.homeMemoPageSize);
  state.homeMemoPage = current;
  els.latestMemos.innerHTML = items.length
    ? `${items.map((memo) => renderMemoCard(memo, { home: true })).join('')}${renderHomePagination('memo', current, totalPages, all.length)}`
    : `<div class="empty-state empty-action"><div class="empty-emoji icon-badge">${tmIcon('add-memo')}</div><strong>ยังไม่มี Memo</strong><span>เริ่มจากเช็กอินสั้น ๆ เก็บรูป Highlight และเรื่องเล่าการเดินทางไว้ในที่เดียว</span><button class="primary-button" type="button" data-open="add">${tmIcon('add-memo')}<span>เพิ่ม Memo แรก</span></button></div>`;
}

function renderHomeTrips() {
  const all = sortTrips(state.trips).filter((trip) => !trip.deleted_at);
  const { current, totalPages, items } = paginateItems(all, state.homeTripPage, state.homeTripPageSize);
  state.homeTripPage = current;
  els.homeTrips.innerHTML = items.length
    ? `${items.map((trip) => renderTripCard(trip, { home: true })).join('')}${renderHomePagination('trip', current, totalPages, all.length)}`
    : `<div class="empty-state empty-action"><div class="empty-emoji icon-badge">${tmIcon('trips')}</div><strong>ยังไม่มี Trip</strong><span>สร้าง Trip เพื่อรวม Memo ตามทริป และเชิญเพื่อนดูได้เฉพาะคนที่คุณอนุญาต</span><button class="secondary-button" type="button" data-open="trips">${tmIcon('trips')}<span>สร้าง Trip</span></button></div>`;
}

function sortTrips(trips) {
  return [...trips].sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0));
}

function photosForMemo(memoId) {
  return state.photos
    .filter((photo) => photo.memo_id === memoId && !photo.deleted_at)
    .sort((a, b) => Number(a.sort_order ?? 9999) - Number(b.sort_order ?? 9999) || new Date(a.taken_at || a.created_at || a.updated_at || 0) - new Date(b.taken_at || b.created_at || b.updated_at || 0));
}

function photosForTrip(tripId) {
  const memoIds = new Set(state.memos.filter((memo) => memo.trip_id === tripId && !memo.deleted_at).map((memo) => memo.id));
  return state.photos
    .filter((photo) => !photo.deleted_at && (photo.trip_id === tripId || memoIds.has(photo.memo_id)))
    .sort((a, b) => Number(a.sort_order ?? 9999) - Number(b.sort_order ?? 9999) || new Date(a.taken_at || a.created_at || a.updated_at || 0) - new Date(b.taken_at || b.created_at || b.updated_at || 0));
}

function cleanPhotoPath(path) {
  if (!path) return '';
  const value = String(path).trim();
  if (!value || value === 'null' || value === 'undefined') return '';
  return value.replace(/^\/+/, '');
}

function getPhotoStoragePath(photo) {
  return cleanPhotoPath(
    photo?.storage_path ||
    photo?.path ||
    photo?.file_path ||
    photo?.object_path ||
    photo?.remote_path ||
    photo?.public_path ||
    ''
  );
}

function getPhotoThumbPath(photo) {
  return cleanPhotoPath(
    photo?.thumbnail_path ||
    photo?.thumb_path ||
    photo?.thumb_storage_path ||
    photo?.thumbnail_storage_path ||
    photo?.thumbnail ||
    ''
  );
}

function firstPhotoUrl(...values) {
  return values.find((value) => typeof value === 'string' && value.trim()) || '';
}

async function hydratePhotoUrls(photos = []) {
  const hydrated = [];
  for (const rawPhoto of photos) {
    const storagePath = getPhotoStoragePath(rawPhoto);
    const thumbPath = getPhotoThumbPath(rawPhoto);
    const photo = {
      ...rawPhoto,
      storage_path: storagePath,
      thumbnail_path: thumbPath
    };

    const publicThumbUrl = createPublicPhotoUrl(thumbPath);
    const publicPhotoUrl = createPublicPhotoUrl(storagePath);

    // Prefer freshly-built public URLs from storage_path/thumbnail_path.
    // Older local records may contain expired signed URLs in remote_* fields.
    photo.remote_thumb_url = firstPhotoUrl(
      publicThumbUrl,
      rawPhoto.public_thumb_url,
      rawPhoto.thumbnail_url,
      rawPhoto.thumb_url,
      rawPhoto.remote_thumb_url,
      rawPhoto.signed_thumb_url
    );

    photo.remote_url = firstPhotoUrl(
      publicPhotoUrl,
      rawPhoto.public_url,
      rawPhoto.photo_url,
      rawPhoto.image_url,
      rawPhoto.file_url,
      rawPhoto.url,
      rawPhoto.remote_url,
      rawPhoto.signed_url
    );

    if (!photo.remote_thumb_url && thumbPath) {
      photo.remote_thumb_url = await createSignedUrl(thumbPath, 3600).catch(() => '');
    }
    if (!photo.remote_url && storagePath) {
      photo.remote_url = await createSignedUrl(storagePath, 3600).catch(() => '');
    }

    hydrated.push(photo);
  }
  return hydrated;
}

function tripById(id) {
  return state.trips.find((trip) => trip.id === id);
}

function photoSrc(photo, preferThumb = true) {
  const blob = preferThumb ? (photo.thumbBlob || photo.blob) : (photo.blob || photo.thumbBlob);
  const localUrl = createObjectUrl(blob);
  if (localUrl) return localUrl;

  const thumbUrl = firstPhotoUrl(
    createPublicPhotoUrl(getPhotoThumbPath(photo)),
    photo?.public_thumb_url,
    photo?.thumbnail_url,
    photo?.thumb_url,
    photo?.remote_thumb_url,
    photo?.signed_thumb_url
  );
  const fullUrl = firstPhotoUrl(
    createPublicPhotoUrl(getPhotoStoragePath(photo)),
    photo?.public_url,
    photo?.photo_url,
    photo?.image_url,
    photo?.file_url,
    photo?.url,
    photo?.remote_url,
    photo?.signed_url
  );
  return preferThumb ? (thumbUrl || fullUrl) : (fullUrl || thumbUrl);
}

function photoFallbackSrc(photo) {
  return photoSrc(photo, false) || photoSrc(photo, true) || '';
}

function photoObjectUrl(photo, preferThumb = true) {
  if (!photo) return '';
  const key = `${photo.id || photo.original_name || 'photo'}:${preferThumb ? 'thumb' : 'full'}`;
  if (state.photoObjectUrls?.has(key)) return state.photoObjectUrls.get(key);
  const blob = preferThumb ? (photo.thumbBlob || photo.blob) : (photo.blob || photo.thumbBlob);
  const url = createObjectUrl(blob);
  if (url) state.photoObjectUrls?.set(key, url);
  return url;
}

function renderPhotoImg(photo, options = {}) {
  const thumb = photoSrc(photo, options.preferThumb !== false);
  const full = photoFallbackSrc(photo);
  if (!thumb && !full) return '';
  const alt = escapeHtml(options.alt || photo?.caption || photo?.original_name || 'Travel photo');
  const classes = options.className ? ` class="${escapeHtml(options.className)}"` : '';
  const dataFull = full ? ` data-full-src="${escapeHtml(full)}"` : '';
  const widthAttr = photo?.thumbWidth || photo?.width ? ` width="${Number(photo.thumbWidth || photo.width)}"` : '';
  const heightAttr = photo?.thumbHeight || photo?.height ? ` height="${Number(photo.thumbHeight || photo.height)}"` : '';
  const fallbackAttr = full && thumb !== full ? ` onerror="this.onerror=null;this.src='${escapeHtml(full)}';"` : ` onerror="this.onerror=null;this.closest('.photo-frame, .gallery-photo-frame, .story-photo-frame')?.classList.add('photo-load-failed');"`;
  return `<img${classes} src="${escapeHtml(thumb || full)}"${dataFull}${widthAttr}${heightAttr} alt="${alt}" loading="lazy" decoding="async"${fallbackAttr} />`;
}

function renderPhotoMeta(photo) {
  // Visual photo cards should stay clean: show only the photo and caption when present.
  // Technical image metadata remains available in Diagnostics/Admin, not on user-facing cards.
  return '';
}

function renderThumbRow(photos, limit = 8) {
  if (!photos.length) return '';
  const visible = photos.slice(0, limit);
  const hiddenCount = Math.max(0, photos.length - visible.length);
  return `<div class="thumb-row">${visible.map((photo) => {
    const image = renderPhotoImg(photo, { preferThumb: true, alt: photo.caption || 'Travel photo' });
    const caption = String(photo.caption || '').trim();
    return image ? `<button class="photo-frame thumb-frame" type="button" data-sheet-action="photo-preview" data-lightbox-scope="memo" data-memo-id="${escapeHtml(photo.memo_id || state.currentMemoDetailId || '')}" data-photo-id="${escapeHtml(photo.id)}" data-full-src="${escapeHtml(photoFallbackSrc(photo))}">${image}${caption ? `<span class="thumb-caption">${escapeHtml(shortText(caption, 34))}</span>` : ''}</button>` : '';
  }).join('')}${hiddenCount ? `<span class="thumb-more">+${hiddenCount} รูป</span>` : ''}</div>`;
}

function renderSheetPhotoGrid(photos = [], className = '') {
  const visible = photos.filter(Boolean).slice(0, 36);
  if (!visible.length) return '';
  return `<div class="sheet-photo-grid polished-photo-grid ${escapeHtml(className)}">${visible.map((photo, index) => {
    const full = photoFallbackSrc(photo);
    const image = renderPhotoImg(photo, { preferThumb: true, alt: photo.caption || `Travel photo ${index + 1}` });
    const caption = photo.caption ? `<span class="gallery-photo-caption">${escapeHtml(photo.caption)}</span>` : '';
    return image ? `<button class="gallery-photo-frame" type="button" data-sheet-action="photo-preview" data-lightbox-scope="memo" data-memo-id="${escapeHtml(photo.memo_id || state.currentMemoDetailId || '')}" data-photo-id="${escapeHtml(photo.id)}" data-full-src="${escapeHtml(full)}"><span class="gallery-photo-index">${index + 1}</span>${image}${caption}</button>` : '';
  }).join('')}</div>`;
}

function allLightboxPhotos() {
  const map = new Map();
  [...(state.photos || []), ...(state.selectedPhotos || [])]
    .filter((photo) => photo && !photo.deleted_at && photoFallbackSrc(photo))
    .forEach((photo) => map.set(photo.id || photoFallbackSrc(photo), photo));
  return [...map.values()];
}

function findLightboxPhoto(photoOrSrc) {
  if (!photoOrSrc) return null;
  if (typeof photoOrSrc === 'object' && photoOrSrc.id) return photoOrSrc;
  const value = String(photoOrSrc || '');
  return [...(state.selectedPhotos || []), ...(state.photos || [])]
    .find((photo) => photo && !photo.deleted_at && (photo.id === value || photoFallbackSrc(photo) === value || photoSrc(photo, true) === value)) || null;
}

function tripIdForPhoto(photo) {
  if (!photo) return '';
  if (photo.trip_id) return photo.trip_id;
  const memo = state.memos.find((item) => item.id === photo.memo_id);
  return memo?.trip_id || '';
}

function lightboxScopedPhotos(targetPhoto, options = {}) {
  if (Array.isArray(options.photos) && options.photos.length) return dedupePhotos(options.photos).filter((photo) => photoFallbackSrc(photo));

  const selectedHasTarget = targetPhoto?.id && (state.selectedPhotos || []).some((photo) => photo.id === targetPhoto.id);
  if (options.scope === 'selected' || selectedHasTarget) {
    return dedupePhotos(state.selectedPhotos || []).filter((photo) => photoFallbackSrc(photo));
  }

  const scope = options.scope || '';
  const detailIsTrip = els.detailSheet?.classList.contains('trip-detail-sheet');
  const detailIsMemo = els.detailSheet?.classList.contains('memo-reading-sheet');
  const memoId = options.memoId || targetPhoto?.memo_id || (detailIsMemo ? state.currentMemoDetailId : '');
  const tripId = options.tripId || targetPhoto?.trip_id || tripIdForPhoto(targetPhoto) || (detailIsTrip ? state.currentTripDetailId : '');

  if ((scope === 'trip' || detailIsTrip) && tripId) {
    return dedupePhotos(photosForTrip(tripId)).filter((photo) => photoFallbackSrc(photo));
  }
  if ((scope === 'memo' || detailIsMemo || memoId) && memoId) {
    return dedupePhotos(photosForMemo(memoId)).filter((photo) => photoFallbackSrc(photo));
  }
  return targetPhoto && photoFallbackSrc(targetPhoto) ? [targetPhoto] : [];
}

function openPhotoLightbox(photoOrSrc, alt = 'Travel photo', options = {}) {
  const matchedPhoto = findLightboxPhoto(photoOrSrc);
  const scoped = lightboxScopedPhotos(matchedPhoto, options);
  let photos = scoped;
  let index = -1;
  if (matchedPhoto?.id) index = photos.findIndex((photo) => photo.id === matchedPhoto.id);
  if (index < 0 && typeof photoOrSrc === 'string') {
    index = photos.findIndex((photo) => photoFallbackSrc(photo) === photoOrSrc || photoSrc(photo, true) === photoOrSrc);
  }
  if (index < 0) {
    const src = matchedPhoto ? photoFallbackSrc(matchedPhoto) : (typeof photoOrSrc === 'string' ? photoOrSrc : photoFallbackSrc(photoOrSrc));
    if (!src || /^[-a-z0-9]{8,}/i.test(src) && !src.includes('/') && !src.startsWith('blob:') && !src.startsWith('data:')) return;
    photos = [{ id: matchedPhoto?.id || 'single', src, caption: matchedPhoto?.caption || alt, ...matchedPhoto }];
    index = 0;
  }
  state.photoLightbox = { photos, index, scope: options.scope || 'context' };
  renderPhotoLightbox();
}

function renderPhotoLightbox() {
  document.querySelector('.photo-lightbox')?.remove();
  const photos = state.photoLightbox?.photos || [];
  const index = Number(state.photoLightbox?.index || 0);
  const photo = photos[index];
  const src = photo?.src || photoFallbackSrc(photo);
  if (!src) return;
  const caption = String(photo?.caption || '').trim();
  const altText = caption || 'Travel photo';
  const count = photos.length > 1 ? `${index + 1} / ${photos.length}` : '';
  const lightbox = document.createElement('div');
  lightbox.className = 'photo-lightbox photo-lightbox-gallery';
  lightbox.innerHTML = `
    <div class="photo-lightbox-panel" role="dialog" aria-modal="true" aria-label="ดูรูปภาพ">
      <button class="photo-lightbox-close" type="button" aria-label="ปิดรูปภาพ" data-lightbox-action="close">×</button>
      ${photos.length > 1 ? `<button class="photo-lightbox-nav prev" type="button" aria-label="รูปก่อนหน้า" data-lightbox-action="prev">‹</button><button class="photo-lightbox-nav next" type="button" aria-label="รูปถัดไป" data-lightbox-action="next">›</button>` : ''}
      <img src="${escapeHtml(src)}" alt="${escapeHtml(altText)}" />
      ${(caption || count) ? `<div class="photo-lightbox-caption">${caption ? `<strong>${escapeHtml(caption)}</strong>` : ''}${count ? `<span>${escapeHtml(count)}</span>` : ''}</div>` : ''}
    </div>
  `;
  lightbox.addEventListener('click', (event) => {
    const action = event.target.closest('[data-lightbox-action]')?.dataset.lightboxAction;
    if (action === 'close' || event.target === lightbox) {
      lightbox.remove();
      return;
    }
    if (action === 'prev') shiftPhotoLightbox(-1);
    if (action === 'next') shiftPhotoLightbox(1);
  });
  let startX = 0;
  lightbox.addEventListener('touchstart', (event) => { startX = event.touches?.[0]?.clientX || 0; }, { passive: true });
  lightbox.addEventListener('touchend', (event) => {
    const endX = event.changedTouches?.[0]?.clientX || 0;
    const delta = endX - startX;
    if (Math.abs(delta) > 48) shiftPhotoLightbox(delta > 0 ? -1 : 1);
  }, { passive: true });
  document.body.appendChild(lightbox);
}

function shiftPhotoLightbox(delta) {
  const photos = state.photoLightbox?.photos || [];
  if (photos.length <= 1) return;
  state.photoLightbox.index = (Number(state.photoLightbox.index || 0) + delta + photos.length) % photos.length;
  renderPhotoLightbox();
}

function handlePhotoLightboxKeys(event) {
  if (!document.querySelector('.photo-lightbox')) return;
  if (event.key === 'Escape') document.querySelector('.photo-lightbox')?.remove();
  if (event.key === 'ArrowLeft') shiftPhotoLightbox(-1);
  if (event.key === 'ArrowRight') shiftPhotoLightbox(1);
}

function renderSyncChip(item) {
  const status = item.sync_status || 'local';
  const label = status === 'synced' ? 'Cloud' : status === 'pending' ? 'รอซิงก์' : 'Local';
  const icon = status === 'synced' ? 'cloud-sync' : status === 'pending' ? 'sync' : 'storage';
  const tone = status === 'synced' ? 'synced' : status === 'pending' ? 'pending' : 'local';
  return `<span class="chip sync-state ${tone}">${tmIcon(icon)}<span>${label}</span></span>`;
}


function profileById(userId) {
  if (!userId) return null;
  if (state.profile?.id === userId) return state.profile;
  return (state.profiles || []).find((profile) => profile.id === userId) || null;
}

function profileByEmail(email) {
  if (!email) return null;
  const normalized = String(email).toLowerCase();
  return (state.profiles || []).find((profile) => String(profile.email || '').toLowerCase() === normalized) || null;
}

function initialsFromText(text = 'T') {
  return String(text || 'T').trim().slice(0, 1).toUpperCase() || 'T';
}

function avatarMarkup(profile, fallbackText = 'T', className = 'mini-avatar') {
  const src = profile?.avatar_url || '';
  if (src) return `<span class="${className}"><img src="${escapeHtml(src)}" alt="${escapeHtml(profile?.display_name || profile?.email || 'Profile')}" /></span>`;
  return `<span class="${className} fallback">${escapeHtml(initialsFromText(profile?.display_name || profile?.email || fallbackText))}</span>`;
}

function creatorLabel(item) {
  const profile = profileById(item?.user_id);
  if (profile) return profile.display_name || profile.email || 'Traveler';
  if (item?.user_id === state.user?.id) return state.profile?.display_name || state.user?.email || 'คุณ';
  return 'เจ้าของที่แชร์';
}

function creatorBadge(item, label = 'สร้างโดย') {
  const profile = profileById(item?.user_id);
  const name = creatorLabel(item);
  return `<div class="creator-chip">${avatarMarkup(profile, name)}<span><small>${escapeHtml(label)}</small><strong>${escapeHtml(name)}</strong></span></div>`;
}

function viewCountText(item) {
  const count = Number(item?.view_count || 0);
  return `${count.toLocaleString('th-TH')} ครั้ง`;
}

function renderViewChip(item) {
  return `<span class="chip view-chip">${tmIcon('view')}<span>${viewCountText(item)}</span></span>`;
}

function renderHiddenChip(item) {
  return item?.is_visible === false ? `<span class="chip danger-chip">${tmIcon('hidden')}<span>ซ่อนอยู่</span></span>` : '';
}

function invitedPeopleForTrip(tripId) {
  return (state.invites || [])
    .filter((invite) => invite.trip_id === tripId && !['revoked','declined'].includes(String(invite.status || '').toLowerCase()))
    .map((invite) => ({ invite, profile: profileByEmail(invite.invited_email), email: invite.invited_email }));
}

function invitedAvatarsMarkup(tripId, limit = 5) {
  const people = invitedPeopleForTrip(tripId);
  if (!people.length) return '';
  const avatars = people.slice(0, limit).map(({ profile, email }) => avatarMarkup(profile, email, 'invite-avatar')).join('');
  const extra = people.length > limit ? `<span class="invite-avatar more">+${people.length - limit}</span>` : '';
  return `<div class="invite-avatars" title="${escapeHtml(people.map((p) => p.email).join(', '))}">${avatars}${extra}</div>`;
}

function inviteStatusLabel(status) {
  const value = String(status || 'pending').toLowerCase();
  const labels = {
    pending: 'รอตอบรับ',
    accepted: 'เข้าร่วมแล้ว',
    declined: 'ปฏิเสธแล้ว',
    revoked: 'ถูกลบแล้ว'
  };
  return labels[value] || value;
}

function inviteStatusClass(status) {
  const value = String(status || 'pending').toLowerCase();
  if (value === 'accepted') return 'accepted';
  if (value === 'declined' || value === 'revoked') return 'danger';
  return 'pending';
}

function detailBlock(title, value, icon = '', options = {}) {
  const hasValue = value !== undefined && value !== null && String(value).trim() !== '';
  if (!hasValue && options.optional) return '';
  const displayValue = hasValue ? value : (options.placeholder ?? '-');
  const safeValue = options.html ? String(displayValue) : escapeHtml(String(displayValue));
  return `<section class="detail-block ${options.wide ? 'wide' : ''}">
    <h4>${icon ? `<span>${icon}</span>` : ''}${escapeHtml(title)}</h4>
    <div class="detail-value">${options.multiline ? String(safeValue).replaceAll('\n', '<br>') : safeValue}</div>
  </section>`;
}

async function incrementViewCounter(kind, id) {
  if (!id) return;
  const storeName = kind === 'trip' ? 'trips' : 'memos';
  const rpcName = kind === 'trip' ? 'increment_trip_view' : 'increment_memo_view';
  const rpcArgs = kind === 'trip' ? { p_trip_id: id } : { p_memo_id: id };
  try {
    const localItem = await db.get(storeName, id);
    if (localItem) {
      const updated = { ...localItem, view_count: Number(localItem.view_count || 0) + 1, last_viewed_at: nowIso() };
      await db.put(storeName, updated);
      const target = state[storeName].find((item) => item.id === id);
      if (target) {
        target.view_count = updated.view_count;
        target.last_viewed_at = updated.last_viewed_at;
      }
    }
  } catch (_) {}
  if (supabase && state.user) {
    supabase.rpc(rpcName, rpcArgs).then(({ data, error }) => {
      if (error) return;
      const target = state[storeName].find((item) => item.id === id);
      if (target && Number.isFinite(Number(data))) target.view_count = Number(data);
    }).catch(() => {});
  }
}

function inviteSummaryForTrip(tripId) {
  const invites = (state.invites || []).filter((invite) => invite.trip_id === tripId);
  if (!invites.length) return '';
  const active = invites.filter((invite) => !['revoked','declined'].includes(String(invite.status || '').toLowerCase())).length;
  const pending = invites.filter((invite) => String(invite.status || '').toLowerCase() === 'pending').length;
  const accepted = invites.filter((invite) => String(invite.status || '').toLowerCase() === 'accepted').length;
  return `<div class="meta-line invite-line">${iconText('group', `เชิญ ${active} อีเมล · เปิดดูได้ ${accepted}${pending ? ` · รอตอบรับ ${pending}` : ''}`)}${invitedAvatarsMarkup(tripId)}</div>`;
}


function statusLabel(status) {
  const value = String(status || '').trim().toLowerCase();
  const labels = {
    draft: 'แบบร่าง',
    planned: 'วางแผน',
    active: 'กำลังเดินทาง',
    completed: 'จบทริปแล้ว',
    done: 'จบทริปแล้ว',
    archived: 'เก็บถาวร',
    hidden: 'ซ่อนอยู่',
    public: 'เผยแพร่',
    private: 'ส่วนตัว',
    synced: 'ซิงก์แล้ว',
    local: 'ในเครื่อง',
    pending: 'รอซิงก์',
    failed: 'ซิงก์ล้มเหลว'
  };
  return labels[value] || (value ? value.replaceAll('_', ' ') : 'กำลังเดินทาง');
}

function isTripFinished(trip) {
  const value = String(trip?.status || '').toLowerCase();
  return ['done', 'completed', 'archived'].includes(value);
}

function tripStatusTone(trip) {
  const value = String(trip?.status || '').toLowerCase();
  if (['done', 'completed', 'archived'].includes(value)) return 'done';
  if (value === 'active') return 'active';
  if (value === 'planned') return 'planned';
  return 'neutral';
}

function renderTripStatusChip(trip, className = 'trip-status-chip') {
  const icon = isTripFinished(trip) ? 'check-in' : String(trip?.status || '').toLowerCase() === 'active' ? 'route' : 'calendar';
  return `<span class="${className} ${tripStatusTone(trip)}">${tmIcon(icon)}<span>${escapeHtml(statusLabel(trip?.status))}</span></span>`;
}

function renderMemoCard(memo, options = {}) {
  const trip = tripById(memo.trip_id);
  const photos = photosForMemo(memo.id);
  const location = [memo.place_name, memo.city, memo.country].filter(Boolean).join(' · ') || 'ยังไม่ระบุสถานที่';
  const sharedBadge = memo.user_id !== state.user?.id ? `<span class="chip shared-chip">${tmIcon('group')}<span>Shared</span></span>` : '';
  return `
    <article class="memo-card glass-card" data-id="${memo.id}">
      <div class="memo-topline">
        <div>
          <div class="card-kicker">${tmIcon('memo')}<span>Memo</span></div>
          <h3>${escapeHtml(memo.title || memo.place_name || 'Travel Memo')}</h3>
          <div class="meta-line">${tmIcon('calendar')}<span>${formatDate(memo.visited_at, { numeric: true })} · ${escapeHtml(location)}</span></div>
          ${trip ? `<div class="meta-line">${tmIcon('trips')}<span>Trip: ${escapeHtml(trip.title)}</span></div>` : ''}
        </div>
        <div class="chip-stack">${sharedBadge}${renderHiddenChip(memo)}${renderViewChip(memo)}${renderSyncChip(memo)}</div>
      </div>
      <div class="card-creator-row">${creatorBadge(memo, 'ผู้สร้าง Memo')}</div>
      ${renderThumbRow(photos, options.home ? 3 : 8)}
      ${renderMemoTextPreview(memo, options.home ? { highlightLimit: 80, storyLimit: 96 } : {})}
      <div class="memo-actions compact-actions">
        <button class="icon-button primary-soft" type="button" data-action="view-memo" data-id="${memo.id}">${tmIcon('read')}<span>อ่าน</span></button>
        <button class="icon-button" type="button" data-action="share-memo" data-id="${memo.id}">${tmIcon('route')}<span>แชร์</span></button>
        ${memo.user_id === state.user?.id ? `<details class="card-more"><summary>⋯</summary><div><button type="button" data-action="edit-memo" data-id="${memo.id}">${tmIcon('edit')}<span>แก้ไข Memo</span></button><button class="danger" type="button" data-action="delete-memo" data-id="${memo.id}">${tmIcon('trash')}<span>ลบ Memo</span></button></div></details>` : ''}
      </div>
    </article>
  `;
}

function renderTripCard(trip, options = {}) {
  const memos = state.memos.filter((memo) => memo.trip_id === trip.id);
  const photos = photosForTrip(trip.id);
  const dates = formatDateRange(trip.start_date, trip.end_date, { fallback: 'ยังไม่ระบุวัน' });
  const isOwner = trip.user_id === state.user?.id;
  const canContribute = canContributeToTrip(trip);
  return `
    <article class="trip-card glass-card" data-id="${trip.id}">
      <div class="trip-topline">
        <div>
          <div class="card-kicker">${tmIcon('trips')}<span>Trip ${isOwner ? 'ส่วนตัว' : 'ที่แชร์กับคุณ'}</span></div>
          <h3>${escapeHtml(trip.title)}</h3>
          <div class="meta-line">${tmIcon('calendar')}<span>${escapeHtml(dates)} · ${escapeHtml(trip.country || trip.city || 'ไม่ระบุปลายทาง')}</span></div>
          <div class="meta-line">${tmIcon('memo')}<span>${memos.length} Memo · ${photos.length} รูป · ${statusLabel(trip.status)}</span></div>
          ${isOwner ? inviteSummaryForTrip(trip.id) : invitedAvatarsMarkup(trip.id)}
        </div>
        <div class="chip-stack">${!isOwner ? `<span class="chip shared-chip">${tmIcon('group')}<span>Shared</span></span>` : ''}${renderTripStatusChip(trip)}${renderHiddenChip(trip)}${renderViewChip(trip)}${renderSyncChip(trip)}</div>
      </div>
      <div class="card-creator-row">${creatorBadge(trip, 'ผู้สร้าง Trip')}</div>
      ${trip.description ? `<p>${escapeHtml(shortText(trip.description, options.home ? 90 : 150))}</p>` : ''}
      <div class="trip-actions compact-actions">
        <button class="icon-button primary-soft" type="button" data-trip-action="view" data-id="${trip.id}">${tmIcon('view')}<span>ดู Trip</span></button>
        <button class="icon-button" type="button" data-trip-action="timeline" data-id="${trip.id}">${tmIcon('timeline')}<span>Timeline</span></button>
        ${canContribute ? `<button class="icon-button" type="button" data-trip-action="add" data-id="${trip.id}">${tmIcon('add-memo')}<span>Memo</span></button>` : ''}
        ${isOwner ? `<button class="icon-button" type="button" data-trip-action="invite" data-id="${trip.id}">${tmIcon('user')}<span>เชิญ</span></button>
        <details class="card-more"><summary>⋯</summary><div><button type="button" data-trip-action="edit" data-id="${trip.id}">${tmIcon('edit')}<span>แก้ไข Trip</span></button>${!isTripFinished(trip) ? `<button type="button" data-trip-action="finish" data-id="${trip.id}">${tmIcon('check-in')}<span>จบ Trip</span></button>` : ''}<button class="danger" type="button" data-trip-action="delete" data-id="${trip.id}">${tmIcon('trash')}<span>ลบ Trip</span></button></div></details>` : ''}
      </div>
    </article>
  `;
}


function locationSourceLabel(source = '') {
  const value = String(source || '').toLowerCase();
  const labels = {
    jpeg_exif_gps: 'EXIF GPS',
    xmp_gps: 'EXIF GPS',
    exif_gps: 'EXIF GPS',
    metadata_gps: 'EXIF GPS',
    metadata_exif: 'EXIF GPS',
    photo_latlng: 'GPS จากรูป',
    current_location: 'ตำแหน่งปัจจุบัน',
    map_picker: 'เลือกจากแผนที่',
    manual: 'Manual'
  };
  return labels[value] || (value ? value.replaceAll('_', ' ') : 'Manual');
}

function distanceMeters(aLat, aLng, bLat, bLng) {
  const lat1 = Number(aLat), lng1 = Number(aLng), lat2 = Number(bLat), lng2 = Number(bLng);
  if (!isValidLatLng(lat1, lng1) || !isValidLatLng(lat2, lng2)) return null;
  const toRad = (deg) => deg * Math.PI / 180;
  const r = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distanceLabel(meters) {
  const value = Number(meters || 0);
  if (!Number.isFinite(value)) return '';
  if (value < 1000) return `${Math.round(value)} ม.`;
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} กม.`;
}

function currentMemoFormLocation() {
  const lat = Number(els.latitude?.value);
  const lng = Number(els.longitude?.value);
  return isValidLatLng(lat, lng) ? { lat, lng } : null;
}

function photoGpsMemoDistance(photo, memoLocation = currentMemoFormLocation()) {
  const gps = photoGpsPoint(photo);
  if (!gps || !memoLocation) return null;
  return distanceMeters(memoLocation.lat, memoLocation.lng, gps.lat, gps.lng);
}

function photoLocationControlMarkup(photo) {
  const gps = photoGpsPoint(photo);
  if (!gps) return '';
  const source = locationSourceLabel(gps.source || photo.location_source || 'photo_latlng');
  return `<div class="photo-gps-overlay" title="รูปนี้มี GPS: ${escapeHtml(source)}">
    <button class="photo-use-gps-pin" type="button" data-photo-use-gps="${escapeHtml(photo.id)}" aria-label="ใช้พิกัดจากรูปนี้กับ Memo" title="ใช้พิกัดจากรูปนี้กับ Memo">${tmIcon('location')}</button>
    <span class="photo-gps-chip" title="${escapeHtml(photoGpsDebugText(photo))}">GPS</span>
  </div>`;
}

function memoLocationSource(memo = {}) {
  if (memo.location_source) return memo.location_source;
  if (isValidLatLng(memo.latitude, memo.longitude)) return 'manual';
  return '';
}

function applyPhotoGpsToMemoFields(photo, options = {}) {
  const gps = photoGpsPoint(photo) || { lat: Number(photo?.latitude), lng: Number(photo?.longitude), source: photo?.location_source || 'photo_latlng' };
  const lat = Number(gps.lat);
  const lng = Number(gps.lng);
  if (!isValidLatLng(lat, lng)) return false;
  const currentLat = Number(els.latitude?.value);
  const currentLng = Number(els.longitude?.value);
  const hasCurrent = isValidLatLng(currentLat, currentLng) && !(Math.abs(currentLat) < 0.000001 && Math.abs(currentLng) < 0.000001);
  const shouldFill = options.force || !hasCurrent;
  if (!shouldFill) return false;
  els.latitude.value = lat.toFixed(6);
  els.longitude.value = lng.toFixed(6);
  state.memoLocationSource = gps.source || photo?.location_source || 'exif_gps';
  els.latitude.dispatchEvent(new Event('input', { bubbles: true }));
  els.longitude.dispatchEvent(new Event('input', { bubbles: true }));
  if (!options.silent) showNotice(`ใช้พิกัดจากรูปแล้ว · ${locationSourceLabel(state.memoLocationSource)}`);
  renderSelectedPhotos();
  return true;
}

function selectedPhotoDuplicateKey(photo) {
  return `${photo.original_name || ''}:${photo.original_size_bytes || photo.size_bytes || 0}:${photo.taken_at || ''}`;
}

function photoExifStatusLabel(photo) {
  if (photoGpsPoint(photo)) return 'มี GPS';
  const status = photo?.metadata?.exif_status || photo?.exif_status || '';
  const labels = {
    unsupported_heic: 'HEIC ยังอ่าน GPS ไม่ได้',
    unsupported_type: 'ไฟล์นี้อ่าน EXIF GPS ไม่ได้',
    exif_without_gps: 'มี EXIF แต่ไม่มี GPS',
    gps_ifd_no_valid_latlng: 'พบ GPS แต่ค่าไม่สมบูรณ์',
    no_exif_gps: 'ไม่พบ EXIF GPS',
    read_error: 'อ่าน EXIF ไม่สำเร็จ'
  };
  return labels[status] || 'ไม่พบ GPS';
}

function photoGpsDebugText(photo) {
  const gps = photoGpsPoint(photo);
  if (gps) return `GPS ${gps.lat.toFixed(6)}, ${gps.lng.toFixed(6)} · ${gps.source}`;
  const status = photo?.metadata?.exif_status || photo?.exif_status || 'unknown';
  const error = photo?.metadata?.exif_error || photo?.exif_error || '';
  return `${photoExifStatusLabel(photo)}${error ? ` · ${error}` : ''} · ${status}`;
}

async function handlePhotoInput(event) {
  const input = event?.target;
  const files = Array.from(input?.files || []).filter((file) => file && file.type?.startsWith('image/'));
  if (!files.length) {
    if (input) input.value = '';
    return;
  }

  showNotice(`กำลังเตรียมรูปภาพ 0/${files.length}...`);
  setPhotoUploadFeedback({ active: true, done: 0, total: files.length, message: `กำลังเตรียมรูปภาพ 0/${files.length}` });
  const prepared = [];
  let gpsFilledFromPhoto = false;
  let gpsPhotoCount = 0;
  let skippedPhotoCount = 0;
  const existingKeys = new Set(state.selectedPhotos.map(selectedPhotoDuplicateKey));
  for (const [index, file] of files.entries()) {
    try {
      showNotice(`กำลังย่อรูป ${index + 1}/${files.length}...`);
      setPhotoUploadFeedback({ active: true, done: index, total: files.length, message: `กำลังย่อรูป ${index + 1}/${files.length}` });
      const compressed = await compressImageFile(file);
      const record = {
        ...compressed,
        id: uid(),
        memo_id: els.memoId?.value || null,
        trip_id: els.memoTrip?.value || null,
        user_id: state.user?.id || null,
        storage_path: null,
        thumbnail_path: null,
        caption: '',
        sort_order: state.selectedPhotos.length + prepared.length,
        sync_status: 'pending',
        deleted_at: null,
        updated_at: nowIso(),
        exif_latitude: compressed.exif_latitude ?? compressed.latitude ?? null,
        exif_longitude: compressed.exif_longitude ?? compressed.longitude ?? null,
        metadata: { ...(compressed.metadata || {}) }
      };
      if (record.has_exif_gps && isValidLatLng(Number(record.latitude), Number(record.longitude))) {
        gpsPhotoCount += 1;
        if (!gpsFilledFromPhoto && applyPhotoGpsToMemoFields(record, { silent: true })) gpsFilledFromPhoto = true;
      }
      const key = selectedPhotoDuplicateKey(record);
      if (existingKeys.has(key)) { skippedPhotoCount += 1; continue; }
      existingKeys.add(key);
      prepared.push(record);
      setPhotoUploadFeedback({ active: true, done: index + 1, total: files.length, message: `เตรียมรูปแล้ว ${index + 1}/${files.length}` });
    } catch (error) {
      console.warn('Cannot prepare selected photo', error);
      logClientError('photo-input', error?.message || error);
      skippedPhotoCount += 1;
      showNotice(`ข้ามรูป ${escapeHtml(file.name || '')} เพราะอ่านไฟล์ไม่ได้`, { tone: 'warning' });
    }
  }

  state.selectedPhotos = [...state.selectedPhotos, ...prepared].map((photo, index) => ({ ...photo, sort_order: index }));
  renderSelectedPhotos();
  if (input) input.value = '';
  if (prepared.length) {
    const gpsText = gpsFilledFromPhoto ? ' · เติมพิกัดจาก EXIF แล้ว' : gpsPhotoCount ? ' · พบ GPS ในรูป แต่ช่องพิกัดมีค่าอยู่แล้ว' : '';
    const skippedText = skippedPhotoCount ? ` · ข้าม ${skippedPhotoCount} รูป` : '';
    setPhotoUploadFeedback({ active: false, done: prepared.length, total: files.length, tone: 'success', message: `เพิ่มรูปภาพแล้ว ${prepared.length} รูป${gpsText}${skippedText}` });
    showNotice(`เพิ่มรูปภาพแล้ว ${prepared.length} รูป${gpsText}${skippedText}`, { tone: 'success' });
  } else {
    setPhotoUploadFeedback({ active: false, done: 0, total: files.length, tone: 'error', message: skippedPhotoCount ? `ไม่มีรูปใหม่ · ข้าม ${skippedPhotoCount} รูป` : 'ไม่มีรูปใหม่ที่ต้องเพิ่ม' });
    showNotice('ไม่มีรูปใหม่ที่ต้องเพิ่ม', { tone: 'warning' });
  }
}

function renderSelectedPhotos() {
  if (els.selectedPhotoCount) {
    els.selectedPhotoCount.textContent = state.selectedPhotos.length
      ? `${state.selectedPhotos.length} รูปที่เลือก`
      : 'ยังไม่ได้เลือกรูป';
  }
  if (!els.photoPreview) return;
  if (!state.selectedPhotos.length) {
    els.photoPreview.innerHTML = '';
    return;
  }

  els.photoPreview.innerHTML = state.selectedPhotos.map((photo, index) => {
    const src = photo.remote_thumb_url || photo.remote_url || photo.local_url || photoObjectUrl(photo, true) || photoObjectUrl(photo, false);
    const name = escapeHtml(photo.original_name || 'รูปภาพ');
    return `
      <div class="photo-thumb photo-thumb-editor" data-photo-id="${photo.id}" data-has-gps="${photo.has_exif_gps ? 'true' : 'false'}">
        ${src ? `<button class="photo-thumb-preview" type="button" data-selected-photo-preview="${photo.id}" aria-label="ดูรูป ${name}"><img src="${src}" alt="${name}" loading="lazy" decoding="async" /></button>` : `<div class="photo-placeholder">${tmIcon('photo')}</div>`}
        <div class="photo-thumb-toolbar">
          <button type="button" aria-label="เลื่อนรูปขึ้น" data-photo-move="up" data-photo-id="${photo.id}" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" aria-label="เลื่อนรูปล่าง" data-photo-move="down" data-photo-id="${photo.id}" ${index === state.selectedPhotos.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" aria-label="ลบรูป ${name}" data-remove-photo="${photo.id}">×</button>
        </div>
        ${photoLocationControlMarkup(photo)}
        <div class="photo-thumb-meta"><strong>${index + 1}</strong></div>
        <input class="photo-caption-input" data-photo-caption="${photo.id}" value="${escapeHtml(photo.caption || '')}" placeholder="Caption รูปนี้" maxlength="120" />
      </div>
    `;
  }).join('');
}

function moveSelectedPhoto(id, direction) {
  const index = state.selectedPhotos.findIndex((photo) => photo.id === id);
  if (index < 0) return;
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= state.selectedPhotos.length) return;
  const next = [...state.selectedPhotos];
  [next[index], next[target]] = [next[target], next[index]];
  state.selectedPhotos = next.map((photo, sortIndex) => ({ ...photo, sort_order: sortIndex }));
  renderSelectedPhotos();
}

function handleSelectedPhotoInput(event) {
  const input = event.target.closest?.('[data-photo-caption]');
  if (!input) return;
  const id = input.dataset.photoCaption;
  state.selectedPhotos = state.selectedPhotos.map((photo) => photo.id === id ? { ...photo, caption: input.value, updated_at: nowIso() } : photo);
}

function flushSelectedPhotoCaptionInputs() {
  if (!els.photoPreview) return;
  const captionInputs = els.photoPreview.querySelectorAll('[data-photo-caption]');
  if (!captionInputs.length) return;
  const captions = new Map([...captionInputs].map((input) => [input.dataset.photoCaption, String(input.value || '')]));
  state.selectedPhotos = state.selectedPhotos.map((photo) => {
    if (!captions.has(photo.id)) return photo;
    const caption = captions.get(photo.id);
    return String(photo.caption || '') === caption ? photo : { ...photo, caption, updated_at: nowIso(), sync_status: photo.sync_status === 'synced' ? 'pending' : photo.sync_status };
  });
}

function handleSelectedPhotoAction(event) {
  const preview = event.target.closest?.('[data-selected-photo-preview]');
  if (preview) {
    event.preventDefault();
    openPhotoLightbox(preview.dataset.selectedPhotoPreview, 'Travel photo', { scope: 'selected' });
    return;
  }
  const move = event.target.closest?.('[data-photo-move]');
  if (move) {
    event.preventDefault();
    moveSelectedPhoto(move.dataset.photoId, move.dataset.photoMove);
    return;
  }
  const useGps = event.target.closest?.('[data-photo-use-gps]');
  if (useGps) {
    event.preventDefault();
    event.stopPropagation();
    const photo = state.selectedPhotos.find((item) => item.id === useGps.dataset.photoUseGps);
    if (!photo || !applyPhotoGpsToMemoFields(photo, { force: true })) showNotice('รูปนี้ไม่มี GPS ที่ใช้งานได้');
    return;
  }
  const button = event.target.closest?.('[data-remove-photo]');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  const id = button.dataset.removePhoto;
  state.selectedPhotos = state.selectedPhotos.filter((photo) => photo.id !== id).map((photo, index) => ({ ...photo, sort_order: index }));
  renderSelectedPhotos();
}

async function saveMemo(event) {
  event.preventDefault();
  if (!state.user) {
    showNotice('กรุณาเข้าสู่ระบบด้วย Google ก่อนบันทึก Memo');
    openView('home');
    return;
  }

  setButtonBusy(els.saveMemoButton, true, 'กำลังบันทึก...');
  showNotice('กำลังบันทึก Memo...', { tone: 'sync', detail: 'บันทึกในเครื่องก่อน แล้วคิวซิงก์จะส่งขึ้น Cloud อัตโนมัติ' });
  flushSelectedPhotoCaptionInputs();

  try {
  const now = nowIso();
  let tripId = els.memoTrip.value || null;

  if (els.newTripName.value.trim()) {
    const trip = {
      id: uid(),
      user_id: state.user?.id || null,
      title: els.newTripName.value.trim(),
      description: '',
      start_date: els.visitedAt.value ? els.visitedAt.value.slice(0, 10) : null,
      end_date: els.visitedAt.value ? els.visitedAt.value.slice(0, 10) : null,
      country: els.country.value.trim(),
      city: els.city.value.trim(),
      status: 'done',
      theme: '',
      is_public: false,
      visibility: 'private',
      public_slug: null,
      public_enabled_at: null,
      public_disabled_at: null,
      is_visible: true,
      view_count: 0,
      cover_photo_id: null,
      sync_status: 'pending',
      created_at: now,
      updated_at: now,
      deleted_at: null
    };
    await db.put('trips', trip);
    await db.queueSync('upsert_trip', 'trip', trip.id);
    tripId = trip.id;
  }

  const editingId = els.memoId.value;
  const existing = editingId ? await db.get('memos', editingId) : null;
  const lat = Number(els.latitude.value);
  const lng = Number(els.longitude.value);
  const title = els.memoTitle.value.trim() || buildAutoMemoTitle();
  const memo = {
    id: editingId || uid(),
    user_id: state.user?.id || existing?.user_id || null,
    trip_id: tripId,
    title,
    place_name: els.placeName.value.trim(),
    note: els.note.value.trim(),
    diary: els.diary.value.trim(),
    mood: els.mood.value,
    rating: Number(els.rating.value || 0),
    visited_at: fromDatetimeLocal(els.visitedAt.value),
    latitude: isValidLatLng(lat, lng) ? lat : null,
    longitude: isValidLatLng(lat, lng) ? lng : null,
    location_source: isValidLatLng(lat, lng) ? (state.memoLocationSource || existing?.location_source || 'manual') : null,
    country: els.country.value.trim(),
    region: els.region.value.trim(),
    city: els.city.value.trim(),
    tags: getTagList(),
    is_public: false,
    visibility: existing?.visibility || 'private',
    is_visible: existing?.is_visible !== false,
    view_count: Number(existing?.view_count || 0),
    sync_status: 'pending',
    created_at: existing?.created_at || now,
    updated_at: now,
    deleted_at: null
  };

  if (!memo.place_name && !memo.city && !memo.country && !memo.note && !memo.diary && !state.selectedPhotos.length) {
    toast('เพิ่มรูป สถานที่ หรือโน้ตอย่างน้อยหนึ่งอย่างก่อนบันทึก');
    return;
  }

  await db.put('memos', memo);
  await db.queueSync('upsert_memo', 'memo', memo.id);

  const oldPhotos = editingId ? await db.getByIndex('photos', 'by_memo', editingId) : [];
  const selectedIds = new Set(state.selectedPhotos.map((photo) => photo.id));
  for (const oldPhoto of oldPhotos.filter((photo) => !selectedIds.has(photo.id))) {
    await db.put('photos', { ...oldPhoto, deleted_at: now, sync_status: 'pending', updated_at: now });
    await db.queueSync('delete_photo', 'photo', oldPhoto.id);
  }

  const oldPhotoById = new Map((oldPhotos || []).map((oldPhoto) => [oldPhoto.id, oldPhoto]));
  for (const [photoIndex, photo] of state.selectedPhotos.entries()) {
    const oldPhoto = oldPhotoById.get(photo.id) || null;
    const nextCaption = String(photo.caption || '').trim();
    const hasCaptionChanged = String(oldPhoto?.caption || '') !== nextCaption;
    const hasSortChanged = Number(oldPhoto?.sort_order ?? -1) !== photoIndex;
    const hasTripChanged = (oldPhoto?.trip_id || null) !== (tripId || null);
    const hasMemoChanged = (oldPhoto?.memo_id || null) !== memo.id;
    const shouldSyncPhoto = !oldPhoto || photo.sync_status !== 'synced' || hasCaptionChanged || hasSortChanged || hasTripChanged || hasMemoChanged;
    const photoRecord = {
      ...photo,
      memo_id: memo.id,
      trip_id: tripId,
      user_id: state.user?.id || photo.user_id || null,
      caption: nextCaption,
      sort_order: photoIndex,
      latitude: isValidLatLng(Number(photo.latitude), Number(photo.longitude)) ? Number(photo.latitude) : null,
      longitude: isValidLatLng(Number(photo.latitude), Number(photo.longitude)) ? Number(photo.longitude) : null,
      exif_latitude: isValidLatLng(Number(photo.exif_latitude ?? photo.latitude), Number(photo.exif_longitude ?? photo.longitude)) ? Number(photo.exif_latitude ?? photo.latitude) : null,
      exif_longitude: isValidLatLng(Number(photo.exif_latitude ?? photo.latitude), Number(photo.exif_longitude ?? photo.longitude)) ? Number(photo.exif_longitude ?? photo.longitude) : null,
      has_exif_gps: Boolean(photo.has_exif_gps || photoGpsPoint(photo)),
      exif_taken_at: photo.exif_taken_at || null,
      location_source: photo.location_source || (photoGpsPoint(photo)?.source || null),
      metadata: { ...(photo.metadata || {}) },
      sync_status: shouldSyncPhoto ? 'pending' : 'synced',
      updated_at: shouldSyncPhoto ? now : (photo.updated_at || oldPhoto?.updated_at || now)
    };
    await db.put('photos', photoRecord);
    if (shouldSyncPhoto) await db.queueSync('upsert_photo', 'photo', photoRecord.id, { user_id: photoRecord.user_id });
  }

  await loadLocalData();
  resetMemoForm();
  renderAll();
  openView('home');
  renderLatestMemos();
  renderHomeTrips();
  toast(editingId ? 'แก้ไข Memo แล้ว · รอซิงก์อัตโนมัติ' : 'บันทึก Memo แล้ว · รอซิงก์อัตโนมัติ');
  setSyncStatusUi(`รอซิงก์ ${state.syncQueue.length} รายการ`, { tone: 'pending' });
  scheduleAutoSync('memo-saved', { delay: 1000 });
  } catch (error) {
    console.error('save memo failed', error);
    logClientError('save_memo_failed', error);
    toast(error?.message || 'บันทึก Memo ไม่สำเร็จ');
  } finally {
    setButtonBusy(els.saveMemoButton, false);
  }
}

function buildAutoMemoTitle() {
  return els.placeName.value.trim() || els.city.value.trim() || els.country.value.trim() || `Memo ${formatDate(new Date())}`;
}

function getTagList() {
  return parseTags(els.tags?.value || '');
}

function setTagList(tags = []) {
  const clean = [...new Set((Array.isArray(tags) ? tags : parseTags(tags)).map(normalizeTaxonomyValue).filter(Boolean))];
  if (els.tags) els.tags.value = tagsToString(clean);
  renderTagEditor(clean);
}

function addTagsFromInput(value) {
  const parsed = String(value || '').split(/[\s,;]+/).map(normalizeTaxonomyValue).filter(Boolean);
  const next = [...getTagList().map(normalizeTaxonomyValue), ...parsed];
  setTagList(next);
  if (els.tagEntry) els.tagEntry.value = '';
  renderTagSuggestions('');
}

function removeTag(tag) {
  setTagList(getTagList().filter((item) => item !== tag));
}

function normalizeTaxonomyValue(value = '') {
  return String(value || '').trim().replace(/^#/, '').toLowerCase();
}

function allMemoTags() {
  const counts = new Map();
  for (const memo of state.memos || []) {
    for (const tag of memo.tags || []) {
      const clean = normalizeTaxonomyValue(tag);
      if (!clean) continue;
      counts.set(clean, (counts.get(clean) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function moodOptions() {
  return [
    ['happy', 'สุขใจ', '😊'],
    ['calm', 'สงบ', '🌿'],
    ['excited', 'ตื่นเต้น', '✨'],
    ['tired', 'เหนื่อยแต่คุ้ม', '🏕️'],
    ['surprised', 'เซอร์ไพรส์', '🎉'],
    ['adventure', 'ผจญภัย', '🧭'],
    ['romantic', 'โรแมนติก', '🌙'],
    ['family', 'ครอบครัว', '👨‍👩‍👧'],
    ['nature', 'ธรรมชาติ', '⛰️'],
    ['food', 'อาหาร', '🍜']
  ];
}

function moodLabel(value) {
  const found = moodOptions().find(([id]) => id === String(value || ''));
  return found ? found[1] : String(value || '');
}

function moodEmoji(value) {
  const found = moodOptions().find(([id]) => id === String(value || ''));
  return found ? found[2] : '😊';
}

function ratingText(value) {
  const n = Number(value || 0);
  return ({ 5: 'ประทับใจมาก', 4: 'ดีมาก', 3: 'ปานกลาง', 2: 'พอใช้', 1: 'ไม่ค่อยประทับใจ' })[n] || 'ยังไม่ให้คะแนน';
}

function renderMoodRatingPickers() {
  if (els.ratingPicker && els.rating) {
    const current = Number(els.rating.value || 5);
    els.ratingPicker.innerHTML = [5, 4, 3, 2, 1].map((rating) => `<button class="rating-pick ${rating === current ? 'active' : ''}" type="button" data-rating-pick="${rating}" aria-pressed="${rating === current}"><span>${'★'.repeat(rating)}</span><small>${escapeHtml(ratingText(rating))}</small></button>`).join('');
  }
  if (els.moodPicker && els.mood) {
    const current = els.mood.value || 'happy';
    els.moodPicker.innerHTML = moodOptions().map(([id, label, icon]) => `<button class="mood-pick ${id === current ? 'active' : ''}" type="button" data-mood-pick="${escapeHtml(id)}" aria-pressed="${id === current}"><span>${icon}</span><small>${escapeHtml(label)}</small></button>`).join('');
  }
}

function setupMoodRatingPickers() {
  els.ratingPicker?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-rating-pick]');
    if (!button) return;
    els.rating.value = button.dataset.ratingPick;
    renderMoodRatingPickers();
  });
  els.moodPicker?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-mood-pick]');
    if (!button) return;
    els.mood.value = button.dataset.moodPick;
    renderMoodRatingPickers();
  });
  els.rating?.addEventListener('change', renderMoodRatingPickers);
  els.mood?.addEventListener('change', renderMoodRatingPickers);
}

function renderTagSuggestions(query = '') {
  if (!els.tagSuggestions) return;
  const q = normalizeTaxonomyValue(query);
  const current = new Set(getTagList().map(normalizeTaxonomyValue));
  const suggestions = allMemoTags()
    .filter(([tag]) => tag && !current.has(tag) && (!q || tag.includes(q)))
    .slice(0, 8);
  els.tagSuggestions.innerHTML = suggestions.length
    ? suggestions.map(([tag, count]) => `<button type="button" class="tag-suggestion" data-tag-suggestion="${escapeHtml(tag)}"><span>#${escapeHtml(tag)}</span><small>${count} Memo</small></button>`).join('')
    : '';
}

function handleTagEntryInput() {
  renderTagSuggestions(els.tagEntry?.value || '');
}

function handleTagSuggestionClick(event) {
  const button = event.target.closest('[data-tag-suggestion]');
  if (!button) return;
  addTagsFromInput(button.dataset.tagSuggestion);
  renderTagSuggestions('');
  els.tagEntry?.focus();
}

function renderTagEditor(tags = getTagList()) {
  if (!els.tagEditor) return;
  els.tagEditor.innerHTML = tags.length
    ? tags.map((tag) => `<button class="tag-chip removable" type="button" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)} <span>×</span></button>`).join('')
    : '<span class="tag-empty-hint">ยังไม่มี tag</span>';
}

function setupTagEditor() {
  if (!els.tagEditor || !els.tagEntry) return;
  renderTagEditor([]);
  els.tagEntry.addEventListener('input', handleTagEntryInput);
  els.tagSuggestions?.addEventListener('click', handleTagSuggestionClick);
  els.tagEntry.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',' || event.key === ';') {
      event.preventDefault();
      addTagsFromInput(els.tagEntry.value);
    }
  });
  els.tagEntry.addEventListener('blur', () => {
    setTimeout(() => {
      if (els.tagEntry.value.trim()) addTagsFromInput(els.tagEntry.value);
      renderTagSuggestions('');
    }, 160);
  });
  els.tagEditor.addEventListener('click', (event) => {
    const button = event.target.closest('[data-tag]');
    if (button) removeTag(button.dataset.tag);
  });
}

function resetMemoForm() {
  els.memoForm.reset();
  setTagList([]);
  if (els.tagEntry) els.tagEntry.value = '';
  els.memoId.value = '';
  els.saveMemoButton.textContent = 'บันทึก Memo';
  els.cancelEditButton.classList.add('hidden');
  state.selectedPhotos = [];
  state.memoLocationSource = null;
  setDefaultDateTime();
  renderSelectedPhotos();
  renderMoodRatingPickers();
}

async function editMemo(id) {
  const memo = await db.get('memos', id);
  if (!memo) return;
  els.memoId.value = memo.id;
  els.memoTitle.value = memo.title || '';
  els.visitedAt.value = toDatetimeLocal(memo.visited_at);
  els.memoTrip.value = memo.trip_id || '';
  els.newTripName.value = '';
  els.placeName.value = memo.place_name || '';
  els.city.value = memo.city || '';
  els.region.value = memo.region || '';
  els.country.value = memo.country || '';
  els.note.value = memo.note || '';
  els.rating.value = String(memo.rating || 5);
  els.mood.value = memo.mood || 'happy';
  renderMoodRatingPickers();
  els.diary.value = memo.diary || '';
  setTagList(memo.tags || []);
  els.latitude.value = memo.latitude ?? '';
  els.longitude.value = memo.longitude ?? '';
  state.memoLocationSource = memo.location_source || (isValidLatLng(memo.latitude, memo.longitude) ? 'manual' : null);
  state.selectedPhotos = await db.getByIndex('photos', 'by_memo', memo.id);
  state.selectedPhotos = state.selectedPhotos.filter((photo) => !photo.deleted_at).sort((a, b) => Number(a.sort_order ?? 9999) - Number(b.sort_order ?? 9999) || new Date(a.taken_at || a.created_at || 0) - new Date(b.taken_at || b.created_at || 0));
  els.saveMemoButton.textContent = 'บันทึกการแก้ไข';
  els.cancelEditButton.classList.remove('hidden');
  renderSelectedPhotos();
  openView('add');
}

async function deleteMemo(id) {
  const memo = await db.get('memos', id);
  if (!memo) return;
  if (!confirm('ลบ Memo นี้หรือไม่? ข้อมูลจะถูกซิงก์เป็นรายการลบเมื่อออนไลน์')) return;
  const now = nowIso();
  await db.put('memos', { ...memo, deleted_at: now, sync_status: 'pending', updated_at: now });
  await db.queueSync('delete_memo', 'memo', id);
  const photos = await db.getByIndex('photos', 'by_memo', id);
  for (const photo of photos) {
    await db.put('photos', { ...photo, deleted_at: now, sync_status: 'pending', updated_at: now });
    await db.queueSync('delete_photo', 'photo', photo.id);
  }
  await loadLocalData();
  renderAll();
  closeSheet();
  toast('ลบ Memo แล้ว · เตรียมซิงก์อัตโนมัติ');
  scheduleAutoSync('memo-deleted', { delay: 1000 });
}

function safeFilename(value = 'travel-memo') {
  return String(value || 'travel-memo')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'travel-memo';
}

function memoShareText(memo) {
  const trip = tripById(memo.trip_id);
  const location = [memo.place_name, memo.city, memo.country].filter(Boolean).join(' · ');
  const lines = [
    memo.title || memo.place_name || 'Travel Memo',
    trip ? `Trip: ${trip.title}` : '',
    location,
    formatDate(memo.visited_at || memo.created_at, { numeric: true, timeStyle: 'short' }),
    memoHighlight(memo) ? `Highlight: ${memoHighlight(memo)}` : '',
    memoStory(memo) ? shortText(memoStory(memo), 220) : ''
  ];
  return lines.filter(Boolean).join('\n');
}

function tripShareText(trip) {
  const memos = memosForTripChronological(trip.id);
  const photos = photosForTrip(trip.id);
  const places = uniqueTripDestinations(memos, trip).slice(0, 8);
  const lines = [
    trip.title || 'Travel Memo Trip',
    [trip.country, trip.city].filter(Boolean).join(' · '),
    formatDateRange(trip.start_date, trip.end_date, { fallback: 'ยังไม่ระบุวัน' }),
    `${memos.length} Memo · ${photos.length} รูป · ${tripTotalDays(trip, memos) || '-'} วัน`,
    places.length ? `จุดหมาย: ${places.join(', ')}` : '',
    trip.description ? shortText(trip.description, 260) : '',
    memos.length ? `Highlight: ${memos.slice(0, 3).map((memo) => memo.title || memo.place_name || 'Memo').join(' / ')}` : ''
  ];
  return lines.filter(Boolean).join('\n');
}

function shareTargetUrl(kind, id) {
  const url = new URL(window.location.origin + window.location.pathname);
  if (kind === 'memo') url.searchParams.set('m', id);
  if (kind === 'trip') url.searchParams.set('t', id);
  return url.toString();
}

function publicTripUrl(tripOrSlug) {
  const slug = typeof tripOrSlug === 'string' ? tripOrSlug : tripOrSlug?.public_slug;
  if (!slug) return '';
  const url = new URL(window.location.origin + window.location.pathname);
  url.searchParams.set('publicTrip', slug);
  return url.toString();
}

function hasPublicShareParams() {
  try {
    const params = new URLSearchParams(window.location.search);
    return Boolean(params.get('publicTrip') || params.get('p'));
  } catch (_) {
    return false;
  }
}

function publicSlugBase(title = 'trip') {
  return String(title || 'trip')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9ก-๙]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42)
    .toLowerCase() || 'trip';
}

function createPublicTripSlug(trip = {}) {
  const base = publicSlugBase(trip.title || trip.city || trip.country || 'trip');
  return `${base}-${uid().replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase()}`;
}

function isTripPublic(trip = {}) {
  return trip?.is_public === true && Boolean(trip?.public_slug);
}

function publicShareTitle(trip = {}) {
  return trip?.title || 'Travel Memo Trip';
}

function publicShareDescription(trip = {}, memos = []) {
  const bestMemo = [...(memos || [])].find((memo) => memoHighlight(memo) || memoStory(memo));
  const pieces = [
    trip.description,
    bestMemo ? `${bestMemo.title || bestMemo.place_name || 'Memo'}: ${memoHighlight(bestMemo) || memoStory(bestMemo)}` : '',
    [trip.country, trip.city].filter(Boolean).join(' · '),
    formatDateRange(trip.start_date, trip.end_date, { fallback: '' })
  ].filter(Boolean);
  return shortText(pieces.join(' · '), 210) || 'Public Travel Memo story แบบ read-only พร้อมรูปภาพและไทม์ไลน์การเดินทาง';
}

function setPublicMetaTags(trip = {}, photos = [], memos = []) {
  const title = `${publicShareTitle(trip)} · Travel Memo`;
  const description = publicShareDescription(trip, memos);
  const image = photos.map((photo) => photoSrc(photo, true)).find(Boolean) || `${window.location.origin}/icons/icon-512.png`;
  const pageUrl = trip?.public_slug ? publicTripUrl(trip) : window.location.href;
  document.title = title;
  const setMeta = (selector, attr, value) => {
    if (!value) return;
    let node = document.head.querySelector(selector);
    if (!node) {
      node = document.createElement('meta');
      const match = selector.match(/\[(name|property)="([^"]+)"\]/);
      if (match) node.setAttribute(match[1], match[2]);
      document.head.appendChild(node);
    }
    node.setAttribute(attr, value);
  };
  let canonical = document.head.querySelector('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement('link');
    canonical.setAttribute('rel', 'canonical');
    document.head.appendChild(canonical);
  }
  canonical.setAttribute('href', pageUrl);
  setMeta('meta[name="description"]', 'content', description);
  setMeta('meta[property="og:site_name"]', 'content', 'Travel Memo');
  setMeta('meta[property="og:locale"]', 'content', 'th_TH');
  setMeta('meta[property="og:title"]', 'content', title);
  setMeta('meta[property="og:description"]', 'content', description);
  setMeta('meta[property="og:type"]', 'content', 'article');
  setMeta('meta[property="og:url"]', 'content', pageUrl);
  setMeta('meta[property="og:image"]', 'content', image);
  setMeta('meta[property="og:image:alt"]', 'content', `${publicShareTitle(trip)} Travel Memo cover`);
  setMeta('meta[name="twitter:card"]', 'content', 'summary_large_image');
  setMeta('meta[property="twitter:card"]', 'content', 'summary_large_image');
  setMeta('meta[property="twitter:title"]', 'content', title);
  setMeta('meta[property="twitter:description"]', 'content', description);
  setMeta('meta[property="twitter:image"]', 'content', image);
}

async function fetchPublicTripBundle(slug) {
  if (!supabase || !slug) throw new Error('Public share ต้องใช้ Supabase');
  const { data: trip, error: tripError } = await supabase
    .from('trips')
    .select('*')
    .eq('public_slug', slug)
    .eq('is_public', true)
    .is('deleted_at', null)
    .maybeSingle();
  if (tripError) throw tripError;
  if (!trip) throw new Error('ไม่พบ Public Trip หรือ Trip นี้ถูกปิด public link แล้ว');

  const { data: memosRaw, error: memoError } = await supabase
    .from('memos')
    .select('*')
    .eq('trip_id', trip.id)
    .eq('is_visible', true)
    .is('deleted_at', null)
    .order('visited_at', { ascending: true });
  if (memoError) throw memoError;
  const memos = memosRaw || [];
  let photos = [];
  if (memos.length) {
    const memoIds = memos.map((memo) => memo.id).filter(Boolean);
    const { data: photosRaw, error: photoError } = await supabase
      .from('photos')
      .select('*')
      .in('memo_id', memoIds)
      .is('deleted_at', null)
      .order('sort_order', { ascending: true });
    if (photoError) throw photoError;
    const visibleMemoIds = new Set(memoIds);
    photos = await hydratePhotoUrls((photosRaw || []).filter((photo) => visibleMemoIds.has(photo.memo_id)));
  }
  return { trip, memos, photos };
}

function publicPhotosForMemo(memoId, photos = []) {
  return photos
    .filter((photo) => photo.memo_id === memoId && !photo.deleted_at)
    .sort((a, b) => Number(a.sort_order ?? 9999) - Number(b.sort_order ?? 9999) || new Date(a.taken_at || a.created_at || a.updated_at || 0) - new Date(b.taken_at || b.created_at || b.updated_at || 0));
}

function publicPhotoButton(photo, className = 'public-photo-button', label = 'ดูรูปภาพ') {
  const src = photoSrc(photo, true);
  if (!photo || !src) return '';
  return `<button class="${className}" type="button" data-public-action="photo-lightbox" data-photo-id="${escapeHtml(photo.id)}" aria-label="${escapeHtml(label)}"><img src="${escapeHtml(src)}" alt="${escapeHtml(photo.caption || label)}" loading="lazy" />${photo.caption ? `<span>${escapeHtml(shortText(photo.caption, 56))}</span>` : ''}</button>`;
}

function publicGeoMemos(memos = []) {
  return (memos || []).filter((memo) => isValidLatLng(memo.latitude, memo.longitude));
}

function renderPublicMapPointsSection(trip = {}, memos = []) {
  const geoMemos = publicGeoMemos(memos);
  const places = uniqueTripDestinations(geoMemos, trip).slice(0, 8);
  if (!geoMemos.length && !places.length) return '';
  return `<section class="public-section public-map-points glass-card">
    <div class="public-section-head"><h2>${tmIcon('map')}<span>Map Points</span></h2><small>${geoMemos.length} จุดบนแผนที่</small></div>
    ${places.length ? `<div class="public-map-place-list">${places.map((place) => `<span>${escapeHtml(place)}</span>`).join('')}</div>` : ''}
    <div class="public-map-mini-list">${geoMemos.slice(0, 6).map((memo) => `<article><strong>${escapeHtml(memo.title || memo.place_name || 'Memo')}</strong><span>${escapeHtml([memo.place_name, memo.city, memo.country].filter(Boolean).join(' · ') || `${memo.latitude}, ${memo.longitude}`)}</span></article>`).join('')}</div>
  </section>`;
}

function renderPublicTripPage(bundle) {
  const { trip, memos = [], photos = [] } = bundle;
  state.publicShareMode = true;
  state.publicTripBundle = bundle;
  const app = document.getElementById('app');
  const main = document.querySelector('.app-main');
  app?.classList.remove('auth-checking', 'logged-in', 'logged-out');
  app?.classList.add('public-share-mode');
  const screenTitle = document.getElementById('screenTitle');
  if (screenTitle) screenTitle.textContent = 'Public Trip Story';
  const sortedMemos = [...memos].sort((a, b) => new Date(a.visited_at || a.created_at || 0) - new Date(b.visited_at || b.created_at || 0));
  const coverPhoto = photos.map((photo) => photoSrc(photo, true)).find(Boolean);
  const places = uniqueTripDestinations(sortedMemos, trip);
  const storyText = String(trip.description || '').trim();
  const grouped = new Map();
  for (const memo of sortedMemos) {
    const key = storyDateKey(memo.visited_at || memo.created_at);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(memo);
  }
  const heroPhotoStrip = photos.slice(0, 6).map((photo, index) => publicPhotoButton(photo, 'public-hero-thumb public-photo-button', `ดูรูปไฮไลต์ ${index + 1}`)).join('');
  setPublicMetaTags(trip, photos, sortedMemos);
  if (!main) return;
  main.innerHTML = `
    <section class="public-trip-page public-trip-story-page">
      <article class="public-story-hero glass-card">
        <div class="public-story-hero-copy">
          <p class="eyebrow">Public Travel Memo</p>
          <h1>${escapeHtml(trip.title || 'Trip Story')}</h1>
          <p class="public-story-subtitle">${escapeHtml([trip.country, trip.city].filter(Boolean).join(' · ') || 'Travel story')}</p>
          <div class="public-trip-chips public-story-chips">
            <span>${tmIcon('calendar')} ${escapeHtml(formatDateRange(trip.start_date, trip.end_date, { fallback: 'ยังไม่ระบุวัน' }))}</span>
            <span>${tmIcon('memo')} ${sortedMemos.length} Memo</span>
            <span>${tmIcon('photo')} ${photos.length} รูป</span>
            <span>${tmIcon('location')} ${places.length} จุดหมาย</span>
          </div>
          ${storyText ? `<p class="public-story-intro">${escapeHtml(shortText(storyText, 260))}</p>` : ''}
        </div>
        <div class="public-story-cover-wrap public-story-highlights-only">
          ${heroPhotoStrip ? `<div class="public-hero-strip public-hero-strip-six">${heroPhotoStrip}</div>` : `<div class="public-trip-cover-fallback">${tmIcon('gallery')}<span>ยังไม่มีรูปไฮไลต์</span></div>`}
        </div>
      </article>
      <section class="public-section public-story-overview glass-card">
        <div class="public-section-head"><h2>${tmIcon('read')}<span>เรื่องเล่าการเดินทาง</span></h2><small>read-only public story</small></div>
        <div class="public-overview-grid">
          <article><strong>${sortedMemos.length}</strong><span>ตอน</span></article>
          <article><strong>${photos.length}</strong><span>รูปภาพ</span></article>
          <article><strong>${places.length}</strong><span>จุดหมาย</span></article>
          <article><strong>${tripTotalDays(trip, sortedMemos) || '-'}</strong><span>วัน</span></article>
        </div>
        ${places.length ? `<p class="public-place-line">${tmIcon('location')} ${escapeHtml(places.slice(0, 5).join(' · '))}${places.length > 5 ? ` +${places.length - 5}` : ''}</p>` : ''}
      </section>
      <section class="public-section public-story-timeline glass-card">
        <div class="public-section-head"><h2>${tmIcon('timeline')}<span>Story Timeline</span></h2><small>${sortedMemos.length} chapter</small></div>
        <div class="public-story-day-list">
          ${sortedMemos.length ? Array.from(grouped.entries()).map(([dateKey, items]) => `<section class="public-story-day">
            <header class="public-story-day-head"><span>${escapeHtml(tripDayLabel(trip, dateKey))}</span><small>${items.length} Memo</small></header>
            <div class="public-story-day-items">${items.map((memo, index) => {
              const memoPhotos = publicPhotosForMemo(memo.id, photos);
              const firstPhoto = memoPhotos[0];
              const img = firstPhoto ? photoSrc(firstPhoto, true) : '';
              const location = [memo.place_name, memo.city, memo.country].filter(Boolean).join(' · ') || 'ไม่ระบุสถานที่';
              const gallery = memoPhotos.slice(1, 5).map((photo) => publicPhotoButton(photo, 'public-inline-photo public-photo-button', 'ดูรูปใน Memo')).join('');
              return `<article class="public-story-card ${img ? 'has-cover' : 'text-only'}">
                <div class="public-story-card-index"><span>${index + 1}</span></div>
                ${img ? publicPhotoButton(firstPhoto, 'public-story-card-cover public-photo-button', `ดูรูป ${memo.title || 'Memo photo'}`) : `<div class="public-memo-fallback">${tmIcon('memo')}</div>`}
                <div class="public-story-card-body">
                  <small>${tmIcon('calendar')} ${formatDate(memo.visited_at || memo.created_at, { numeric: true, timeStyle: 'short' })}</small>
                  <h3>${escapeHtml(memo.title || memo.place_name || 'Travel Memo')}</h3>
                  <p class="muted">${tmIcon('location')} ${escapeHtml(location)}</p>
                  ${memoHighlight(memo) ? `<p class="public-highlight"><strong>Highlight:</strong> ${escapeHtml(memoHighlight(memo))}</p>` : ''}
                  ${memoStory(memo) ? `<p class="public-story-text">${escapeHtml(shortText(memoStory(memo), 380))}</p>` : ''}
                  ${gallery ? `<div class="public-inline-gallery">${gallery}</div>` : ''}
                  ${memoPhotos.length ? `<span class="public-photo-count-chip">${tmIcon('photo')} ${memoPhotos.length} รูป</span>` : ''}
                </div>
              </article>`;
            }).join('')}</div>
          </section>`).join('') : `<div class="empty-state compact">Trip นี้ยังไม่มี Memo ที่เปิดเผย</div>`}
        </div>
      </section>
      ${photos.length ? `<section class="public-section public-photo-highlights glass-card"><div class="public-section-head"><h2>${tmIcon('gallery')}<span>Photo Highlights</span></h2><small>${Math.min(photos.length, 12)} / ${photos.length} รูป</small></div><div class="public-photo-grid public-masonry-grid">${photos.slice(0, 12).map((photo) => publicPhotoButton(photo, 'public-masonry-photo public-photo-button', 'ดูรูปไฮไลต์')).join('')}</div></section>` : ''}
      <section class="public-share-footer glass-card">
        <strong>Travel Memo</strong>
        <span>หน้า public นี้เป็นแบบ read-only แสดงเฉพาะ Memo และรูปที่เปิดเผยใน Trip นี้เท่านั้น</span>
        <button class="primary-button" type="button" data-public-action="copy-link">${tmIcon('route')}<span>คัดลอกลิงก์ Public</span></button>
        <button class="ghost-button" type="button" data-public-action="login">${tmIcon('login')}<span>เข้าสู่ Travel Memo</span></button>
      </section>
    </section>
  `;
}

async function renderPublicShareIfRequested() {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get('publicTrip') || params.get('p');
  if (!slug) return false;
  const app = document.getElementById('app');
  app?.classList.remove('auth-checking');
  app?.classList.add('public-share-mode');
  const main = document.querySelector('.app-main');
  if (main) main.innerHTML = `<section class="public-trip-page"><div class="public-loading glass-card">${tmIcon('sync')}<strong>กำลังโหลด Public Trip...</strong></div></section>`;
  try {
    const bundle = await fetchPublicTripBundle(slug);
    renderPublicTripPage(bundle);
  } catch (error) {
    if (main) main.innerHTML = `<section class="public-trip-page"><div class="empty-state error-empty glass-card"><strong>เปิด Public Trip ไม่สำเร็จ</strong><span>${escapeHtml(error.message || String(error))}</span><small>Trip นี้อาจถูกปิด public link อยู่ หรือ Supabase schema/RLS ยังไม่สดหลังเปิด Public ใหม่</small><button class="primary-button" type="button" data-public-action="login">เข้าสู่ Travel Memo</button></div></section>`;
  }
  return true;
}

function handlePublicShareAction(event) {
  const button = event.target.closest?.('[data-public-action]');
  if (!button) return;
  event.preventDefault();
  const action = button.dataset.publicAction;
  if (action === 'copy-link') {
    copyTextToClipboard(window.location.href, 'คัดลอก Public link แล้ว');
  }
  if (action === 'photo-lightbox') {
    const photoId = button.dataset.photoId || '';
    const publicPhotos = state.publicTripBundle?.photos || [];
    const photo = publicPhotos.find((item) => item.id === photoId);
    if (photo) openPhotoLightbox(photo, photo.caption || 'Travel photo', { scope: 'public', photos: publicPhotos });
  }
  if (action === 'login') {
    const url = new URL(window.location.origin + window.location.pathname);
    window.location.href = url.toString();
  }
}

async function enableTripPublicShare(id) {
  const trip = state.trips.find((item) => item.id === id) || await db.get('trips', id).catch(() => null);
  if (!trip || trip.user_id !== state.user?.id) return showNotice('เปิด Public link ได้เฉพาะเจ้าของ Trip');
  if (!confirm(`เปิด Public Link สำหรับ Trip "${trip.title || 'Trip'}" หรือไม่?\nคนที่มีลิงก์จะอ่าน Trip นี้แบบ read-only ได้`)) return;
  const now = nowIso();
  const updated = {
    ...trip,
    is_public: true,
    visibility: 'public',
    public_slug: trip.public_slug || createPublicTripSlug(trip),
    public_enabled_at: now,
    public_disabled_at: null,
    sync_status: 'pending',
    updated_at: now
  };
  await db.put('trips', updated);
  await db.queueSync('upsert_trip', 'trip', updated.id);
  state.trips = state.trips.map((item) => item.id === updated.id ? updated : item);
  if (supabase) {
    try {
      const { error } = await supabase.from('trips').update({ is_public: true, visibility: 'public', public_slug: updated.public_slug, public_enabled_at: updated.public_enabled_at, public_disabled_at: null, updated_at: updated.updated_at }).eq('id', updated.id);
      if (error) throw error;
      await db.markSynced('trips', updated.id, { user_id: state.user.id });
    } catch (error) {
      console.warn('Public trip update queued after remote error', error);
      showNotice('เปิด Public link ในเครื่องแล้ว แต่ Cloud ยังรอซิงก์ ตรวจ migration/RLS ถ้าขึ้น error');
    }
  }
  await loadLocalData();
  if (els.detailSheet?.classList.contains('open')) openTripSheet(updated.id);
  await copyTextToClipboard(publicTripUrl(updated), 'เปิด Public link และคัดลอกลิงก์แล้ว');
  scheduleAutoSync('public-trip-enabled', { delay: 700 });
}

async function disableTripPublicShare(id) {
  const trip = state.trips.find((item) => item.id === id) || await db.get('trips', id).catch(() => null);
  if (!trip || trip.user_id !== state.user?.id) return showNotice('ปิด Public link ได้เฉพาะเจ้าของ Trip');
  if (!confirm(`ปิด Public Link ของ Trip "${trip.title || 'Trip'}" หรือไม่?`)) return;
  const now = nowIso();
  const updated = { ...trip, is_public: false, visibility: 'private', public_disabled_at: now, sync_status: 'pending', updated_at: now };
  await db.put('trips', updated);
  await db.queueSync('upsert_trip', 'trip', updated.id);
  state.trips = state.trips.map((item) => item.id === updated.id ? updated : item);
  if (supabase) {
    try {
      const { error } = await supabase.from('trips').update({ is_public: false, visibility: 'private', public_disabled_at: now, updated_at: now }).eq('id', updated.id);
      if (error) throw error;
      await db.markSynced('trips', updated.id, { user_id: state.user.id });
    } catch (error) {
      console.warn('Disable public trip queued after remote error', error);
    }
  }
  await loadLocalData();
  if (els.detailSheet?.classList.contains('open')) openTripSheet(updated.id);
  showNotice('ปิด Public link แล้ว');
  scheduleAutoSync('public-trip-disabled', { delay: 700 });
}

async function copyPublicTripLink(id) {
  const trip = state.trips.find((item) => item.id === id) || await db.get('trips', id).catch(() => null);
  if (!trip || !isTripPublic(trip)) return showNotice('Trip นี้ยังไม่ได้เปิด Public Link');
  await copyTextToClipboard(publicTripUrl(trip), 'คัดลอก Public link แล้ว');
}

async function updateTripPublicFields(id, patch = {}, { admin = false, notice = 'อัปเดต Public link แล้ว' } = {}) {
  const trip = state.trips.find((item) => item.id === id) || await db.get('trips', id).catch(() => null);
  if (!trip) throw new Error('ไม่พบ Trip');
  if (!admin && trip.user_id !== state.user?.id) throw new Error('จัดการ Public link ได้เฉพาะเจ้าของ Trip');
  const updated = { ...trip, ...patch, sync_status: 'pending', updated_at: nowIso() };
  await db.put('trips', updated);
  await db.queueSync('upsert_trip', 'trip', updated.id);
  state.trips = state.trips.map((item) => item.id === updated.id ? updated : item);
  if (supabase) {
    try {
      const remotePatch = { ...patch, updated_at: updated.updated_at };
      const { error } = await supabase.from('trips').update(remotePatch).eq('id', updated.id);
      if (error) throw error;
      await db.markSynced('trips', updated.id, { user_id: updated.user_id });
    } catch (error) {
      console.warn('Public link update queued after remote error', error);
      toast('อัปเดตในเครื่องแล้ว รอซิงก์ Cloud');
    }
  }
  await loadLocalData();
  if (els.detailSheet?.classList.contains('open')) openTripSheet(updated.id);
  scheduleAutoSync('public-trip-update', { delay: 700 });
  showNotice(notice);
  return updated;
}

async function regenerateTripPublicLink(id, options = {}) {
  const trip = state.trips.find((item) => item.id === id) || await db.get('trips', id).catch(() => null);
  if (!trip) return showNotice('ไม่พบ Trip');
  if (!options.admin && trip.user_id !== state.user?.id) return showNotice('เปลี่ยน Public link ได้เฉพาะเจ้าของ Trip');
  const now = nowIso();
  const updated = await updateTripPublicFields(id, {
    is_public: true,
    visibility: 'public',
    public_slug: createPublicTripSlug(trip),
    public_enabled_at: now,
    public_disabled_at: null
  }, { admin: Boolean(options.admin), notice: 'สร้าง Public link ใหม่แล้ว ลิงก์เก่าจะใช้ไม่ได้' });
  await copyTextToClipboard(publicTripUrl(updated), 'สร้างและคัดลอก Public link ใหม่แล้ว');
}

async function revokeTripPublicLink(id, options = {}) {
  const trip = state.trips.find((item) => item.id === id) || await db.get('trips', id).catch(() => null);
  if (!trip) return showNotice('ไม่พบ Trip');
  if (!options.admin && trip.user_id !== state.user?.id) return showNotice('ยกเลิก Public link ได้เฉพาะเจ้าของ Trip');
  if (!confirm(`ยกเลิก Public Link ของ Trip "${trip.title || 'Trip'}" และทำให้ลิงก์เดิมใช้ไม่ได้หรือไม่?`)) return;
  await updateTripPublicFields(id, {
    is_public: false,
    visibility: 'private',
    public_slug: null,
    public_disabled_at: nowIso()
  }, { admin: Boolean(options.admin), notice: 'ยกเลิก Public link แล้ว ลิงก์เดิมใช้ไม่ได้' });
}

function buildSharePayload(kind, item) {
  const isTrip = kind === 'trip';
  const title = isTrip ? (item?.title || 'Travel Memo Trip') : (item?.title || item?.place_name || 'Travel Memo');
  const text = isTrip ? tripShareText(item) : memoShareText(item);
  const publicUrl = isTrip && isTripPublic(item) ? publicTripUrl(item) : '';
  const url = publicUrl || shareTargetUrl(kind, item?.id || '');
  return { kind, id: item?.id || '', title, text, url, publicUrl, isPublic: Boolean(publicUrl), message: `${text}

${url}`.trim() };
}

function socialShareLinks(payload) {
  const url = encodeURIComponent(payload.url);
  const text = encodeURIComponent(payload.text || payload.title || 'Travel Memo');
  const title = encodeURIComponent(payload.title || 'Travel Memo');
  return [
    { key: 'facebook', label: 'Facebook', icon: 'f', href: `https://www.facebook.com/sharer/sharer.php?u=${url}` },
    { key: 'x', label: 'X', icon: '𝕏', href: `https://twitter.com/intent/tweet?text=${text}&url=${url}` },
    { key: 'line', label: 'LINE', icon: 'L', href: `https://social-plugins.line.me/lineit/share?url=${url}` },
    { key: 'whatsapp', label: 'WhatsApp', icon: 'W', href: `https://wa.me/?text=${encodeURIComponent(payload.message)}` },
    { key: 'email', label: 'Email', icon: '@', href: `mailto:?subject=${title}&body=${encodeURIComponent(payload.message)}` },
    { key: 'instagram', label: 'Instagram', icon: '◎', href: 'https://www.instagram.com/', copyOnly: true }
  ];
}

async function copyTextToClipboard(text, message = 'คัดลอกแล้ว') {
  await navigator.clipboard?.writeText(String(text || '')).catch(() => null);
  toast(message);
}

function openSocialShareSheet(payload) {
  document.querySelector('.tm-share-sheet-backdrop')?.remove();
  const backdrop = document.createElement('div');
  backdrop.className = 'tm-share-sheet-backdrop';
  backdrop.innerHTML = `
    <section class="tm-share-sheet glass-card" role="dialog" aria-modal="true" aria-label="แชร์ Travel Memo">
      <div class="tm-share-head">
        <div>
          <span class="card-kicker">${tmIcon('route')}<span>Share</span></span>
          <h3>${escapeHtml(payload.title)}</h3>
          <p>แชร์ไปยังโซเชียล หรือคัดลอกลิงก์สำหรับส่งต่อ</p>
        </div>
        <button class="ghost-button compact sheet-close-button" type="button" data-share-action="close" aria-label="ปิด">×</button>
      </div>
      <div class="tm-share-preview">
        <strong>${escapeHtml(payload.isPublic ? 'Public Trip link' : payload.kind === 'trip' ? 'Trip share link' : 'Memo share link')}</strong>
        <code>${escapeHtml(payload.url)}</code>
      </div>
      <div class="tm-share-grid">
        ${navigator.share ? `<button class="tm-social-button native" type="button" data-share-action="native">${tmIcon('route')}<span>แชร์ด้วยเครื่อง</span></button>` : ''}
        ${socialShareLinks(payload).map((item) => `
          <button class="tm-social-button ${escapeHtml(item.key)}" type="button" data-share-platform="${escapeHtml(item.key)}" data-href="${escapeHtml(item.href)}" ${item.copyOnly ? 'data-copy-only="1"' : ''}>
            <span class="tm-social-icon">${escapeHtml(item.icon)}</span><span>${escapeHtml(item.label)}</span>
          </button>`).join('')}
      </div>
      <div class="tm-share-actions">
        <button class="secondary-button" type="button" data-share-action="copy-link">${tmIcon('memo')}<span>Copy link</span></button>
        <button class="ghost-button" type="button" data-share-action="copy-text">${tmIcon('read')}<span>Copy text</span></button>
      </div>
      <p class="muted small-note">Instagram ไม่รองรับ web share โดยตรง จึงคัดลอกลิงก์ให้ก่อนแล้วเปิด Instagram เพื่อวางในโพสต์หรือข้อความได้</p>
    </section>
  `;
  backdrop.__sharePayload = payload;
  document.body.appendChild(backdrop);
}

async function handleShareSheetAction(event) {
  const root = document.querySelector('.tm-share-sheet-backdrop');
  const actionButton = event.target.closest?.('[data-share-action]');
  const platformButton = event.target.closest?.('[data-share-platform]');
  if (!root || (!actionButton && !platformButton && event.target !== root)) return;
  const payload = root.__sharePayload;
  if (!payload) return;
  if (event.target === root || actionButton?.dataset.shareAction === 'close') {
    root.remove();
    return;
  }
  if (actionButton?.dataset.shareAction === 'copy-link') {
    await copyTextToClipboard(payload.url, 'คัดลอกลิงก์แล้ว');
    return;
  }
  if (actionButton?.dataset.shareAction === 'copy-text') {
    await copyTextToClipboard(payload.message, 'คัดลอกข้อความแชร์แล้ว');
    return;
  }
  if (actionButton?.dataset.shareAction === 'native') {
    try {
      await navigator.share({ title: payload.title, text: payload.text, url: payload.url });
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
      await copyTextToClipboard(payload.message, 'แชร์ไม่สำเร็จ จึงคัดลอกข้อความแทน');
      return;
    }
  }
  if (platformButton) {
    const href = platformButton.dataset.href;
    const isCopyOnly = platformButton.dataset.copyOnly === '1';
    if (isCopyOnly) await copyTextToClipboard(payload.url, 'คัดลอกลิงก์แล้ว นำไปวางใน Instagram ได้');
    if (href) window.open(href, '_blank', 'noopener,noreferrer');
  }
}

function processShareDeepLink() {
  if (state.publicShareMode || state.shareDeepLinkProcessed || !state.user) return;
  try {
    const params = new URLSearchParams(window.location.search);
    const memoId = params.get('m') || params.get('memo');
    const tripId = params.get('t') || params.get('trip');
    if (!memoId && !tripId) return;
    const targetId = memoId || tripId;
    const exists = memoId ? state.memos.some((memo) => memo.id === targetId) : state.trips.some((trip) => trip.id === targetId);
    if (!exists) return;
    state.shareDeepLinkProcessed = true;
    setTimeout(() => {
      if (memoId) openMemoSheet(memoId);
      if (tripId) openTripSheet(tripId);
      window.history.replaceState({}, document.title, `${window.location.origin}${window.location.pathname}`);
    }, 250);
  } catch (error) {
    console.warn('share deep link skipped', error);
  }
}

async function shareMemo(id) {
  const memo = state.memos.find((item) => item.id === id);
  if (!memo) return;
  openSocialShareSheet(buildSharePayload('memo', memo));
}

async function shareTrip(id) {
  const trip = state.trips.find((item) => item.id === id);
  if (!trip) return;
  openSocialShareSheet(buildSharePayload('trip', trip));
}

function plainObjectWithoutBlobs(item = {}) {
  const clone = { ...item };
  delete clone.blob;
  delete clone.thumbBlob;
  return clone;
}

async function exportMemoJson(id) {
  const memo = state.memos.find((item) => item.id === id);
  if (!memo) return;
  const trip = tripById(memo.trip_id);
  const photos = photosForMemo(id).map(plainObjectWithoutBlobs);
  const payload = { schema_version: 'travel-memo-memo-v1', exported_at: nowIso(), trip: trip ? plainObjectWithoutBlobs(trip) : null, memo: plainObjectWithoutBlobs(memo), photos };
  downloadFile(`travel-memo-${safeFilename(memo.title || memo.place_name || memo.id)}.json`, JSON.stringify(payload, null, 2));
  toast('Export Memo JSON แล้ว');
}

async function exportTripJson(id) {
  const trip = state.trips.find((item) => item.id === id);
  if (!trip) return;
  const memos = memosForTripChronological(id).map(plainObjectWithoutBlobs);
  const photos = photosForTrip(id).map(plainObjectWithoutBlobs);
  const payload = { schema_version: 'travel-memo-trip-v1', exported_at: nowIso(), trip: plainObjectWithoutBlobs(trip), memos, photos };
  downloadFile(`travel-memo-trip-${safeFilename(trip.title || trip.id)}.json`, JSON.stringify(payload, null, 2));
  toast('Export Trip JSON แล้ว');
}

function htmlEscapeForTemplate(value = '') {
  return escapeHtml(value).replaceAll('\n', '<br>');
}

function imageHtmlForPhoto(photo, captionLimit = 160) {
  const src = photoFallbackSrc(photo);
  if (!src) return '';
  const caption = String(photo.caption || '').trim();
  return `<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(caption || photo.original_name || 'Travel photo')}" loading="lazy" />${caption ? `<figcaption>${escapeHtml(shortText(caption, captionLimit))}</figcaption>` : ''}</figure>`;
}

function exportDocumentShell(title, body) {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapeHtml(title)}</title><style>
    :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#0f172a;background:#f8fafc}body{margin:0;padding:32px;background:linear-gradient(135deg,#ecfeff,#fff7ed)}main{max-width:960px;margin:0 auto;background:rgba(255,255,255,.92);border:1px solid #dbeafe;border-radius:28px;padding:32px;box-shadow:0 24px 80px rgba(15,23,42,.12)}h1{font-size:clamp(2rem,5vw,4rem);line-height:1;margin:.2em 0}h2{margin-top:2rem}.meta{color:#64748b;font-weight:700}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:24px 0}.stats div{border:1px solid #ccfbf1;border-radius:18px;padding:14px;background:#f0fdfa}.memo{border-top:1px solid #e2e8f0;padding:24px 0}.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px}figure{margin:0;border-radius:18px;overflow:hidden;background:#fff;border:1px solid #e2e8f0}img{width:100%;height:auto;display:block}figcaption{padding:10px 12px;color:#475569;font-size:.95rem}article{line-height:1.75}.footer{margin-top:32px;color:#64748b;font-size:.9rem}</style></head><body><main>${body}<p class="footer">Exported from Travel Memo · ${escapeHtml(formatDate(nowIso(), { numeric: true, timeStyle: 'short' }))}</p></main></body></html>`;
}

async function exportMemoHtml(id) {
  const memo = state.memos.find((item) => item.id === id);
  if (!memo) return;
  const trip = tripById(memo.trip_id);
  const photos = photosForMemo(id);
  const location = [memo.place_name, memo.city, memo.country].filter(Boolean).join(' · ') || 'ไม่ระบุสถานที่';
  const body = `<p class="meta">${trip ? `Trip: ${escapeHtml(trip.title)} · ` : ''}${escapeHtml(location)} · ${escapeHtml(formatDate(memo.visited_at || memo.created_at, { numeric: true, timeStyle: 'short' }))}</p><h1>${escapeHtml(memo.title || memo.place_name || 'Travel Memo')}</h1>${memoHighlight(memo) ? `<h2>Highlight</h2><article>${htmlEscapeForTemplate(memoHighlight(memo))}</article>` : ''}${memoStory(memo) ? `<h2>บันทึกการเดินทาง</h2><article>${htmlEscapeForTemplate(memoStory(memo))}</article>` : ''}${photos.length ? `<h2>Photo Story</h2><div class="gallery">${photos.map((photo) => imageHtmlForPhoto(photo)).join('')}</div>` : ''}`;
  downloadFile(`travel-memo-${safeFilename(memo.title || memo.place_name || memo.id)}.html`, exportDocumentShell(memo.title || 'Travel Memo', body), 'text/html');
  toast('Export Memo HTML แล้ว');
}

async function exportTripHtml(id) {
  const trip = state.trips.find((item) => item.id === id);
  if (!trip) return;
  const memos = memosForTripChronological(id);
  const photos = photosForTrip(id);
  const places = uniqueTripDestinations(memos, trip);
  const cover = tripCoverPhoto(photos);
  const body = `${cover ? imageHtmlForPhoto(cover, 100) : ''}<p class="meta">${escapeHtml([trip.country, trip.city].filter(Boolean).join(' · ') || 'Travel Memo')} · ${escapeHtml(formatDateRange(trip.start_date, trip.end_date, { fallback: 'ยังไม่ระบุวัน' }))}</p><h1>${escapeHtml(trip.title || 'Trip Story')}</h1>${trip.description ? `<article>${htmlEscapeForTemplate(trip.description)}</article>` : ''}<section class="stats"><div><strong>${memos.length}</strong><br/>Memo</div><div><strong>${photos.length}</strong><br/>รูปภาพ</div><div><strong>${tripTotalDays(trip, memos) || '-'}</strong><br/>วัน</div><div><strong>${places.length}</strong><br/>จุดหมาย</div></section>${places.length ? `<p class="meta">จุดหมาย: ${escapeHtml(places.slice(0, 12).join(' · '))}</p>` : ''}<h2>Story Timeline</h2>${memos.map((memo) => { const memoPhotos = photosForMemo(memo.id).slice(0, 4); const loc = [memo.place_name, memo.city, memo.country].filter(Boolean).join(' · '); return `<section class="memo"><p class="meta">${escapeHtml(formatDate(memo.visited_at || memo.created_at, { numeric: true, timeStyle: 'short' }))}${loc ? ` · ${escapeHtml(loc)}` : ''}</p><h2>${escapeHtml(memo.title || memo.place_name || 'Memo')}</h2>${memoHighlight(memo) ? `<article><strong>Highlight:</strong> ${htmlEscapeForTemplate(memoHighlight(memo))}</article>` : ''}${memoStory(memo) ? `<article>${htmlEscapeForTemplate(shortText(memoStory(memo), 1000))}</article>` : ''}${memoPhotos.length ? `<div class="gallery">${memoPhotos.map((photo) => imageHtmlForPhoto(photo)).join('')}</div>` : ''}</section>`; }).join('')}`;
  downloadFile(`travel-memo-trip-${safeFilename(trip.title || trip.id)}.html`, exportDocumentShell(trip.title || 'Trip Story', body), 'text/html');
  toast('Export Trip HTML แล้ว');
}

async function handleMemoAction(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const id = button.dataset.id;
  const action = button.dataset.action;
  if (action === 'view-memo') openMemoSheet(id);
  if (action === 'edit-memo') editMemo(id);
  if (action === 'share-memo') shareMemo(id);
  if (action === 'export-memo-html') exportMemoHtml(id);
  if (action === 'export-memo-json') exportMemoJson(id);
  if (action === 'copy-memo-share') { const memo = state.memos.find((item) => item.id === id); if (memo) copyTextToClipboard(memoShareText(memo), 'คัดลอกข้อความ Memo แล้ว'); }
  if (action === 'delete-memo') deleteMemo(id);
}


function memoReadingNeighbors(memo, trip = null) {
  if (!memo) return { previous: null, next: null, list: [] };
  const list = trip?.id
    ? memosForTripChronological(trip.id)
    : sortByDateDesc(state.memos).filter((item) => !item.deleted_at);
  const index = list.findIndex((item) => item.id === memo.id);
  return {
    previous: index > 0 ? list[index - 1] : null,
    next: index >= 0 && index < list.length - 1 ? list[index + 1] : null,
    list
  };
}

function renderMemoHeroPhoto(memo, photos = []) {
  const primary = photos[0];
  if (!primary) {
    return `<section class="memo-reading-hero no-photo">
      <div class="memo-reading-hero-fallback">${tmIcon('memo')}<span>Travel Memo</span></div>
    </section>`;
  }
  const image = renderPhotoImg(primary, { preferThumb: false, alt: primary.caption || memo.title || 'Memo hero photo', className: 'memo-reading-hero-img' });
  if (!image) return '';
  return `<section class="memo-reading-hero has-photo">
    <button class="memo-reading-hero-button" type="button" data-sheet-action="photo-preview" data-lightbox-scope="memo" data-memo-id="${escapeHtml(memo.id)}" data-photo-id="${escapeHtml(primary.id)}" data-full-src="${escapeHtml(photoFallbackSrc(primary))}">
      ${image}
      ${primary.caption ? `<span class="memo-reading-hero-caption">${escapeHtml(primary.caption)}</span>` : ''}
    </button>
  </section>`;
}

function renderMemoMetaChips(memo, trip, photos = []) {
  const chips = [];
  chips.push(`<span>${tmIcon('calendar')} ${formatDate(memo.visited_at, { numeric: true, timeStyle: 'short' })}</span>`);
  if (trip) chips.push(`<span>${tmIcon('trips')} ${escapeHtml(trip.title || 'Trip')}</span>`);
  if (photos.length) chips.push(`<span>${tmIcon('photo')} ${photos.length} รูป</span>`);
  if (isValidLatLng(memo.latitude, memo.longitude)) chips.push(`<span>${tmIcon('map')} ${escapeHtml(locationSourceLabel(memoLocationSource(memo)))}</span>`);
  if (memo.rating) chips.push(`<span>${tmIcon('rating')} ${escapeHtml(String(memo.rating))}/5 · ${escapeHtml(ratingText(memo.rating))}</span>`);
  if (memo.mood) chips.push(`<button type="button" data-filter-mood="${escapeHtml(memo.mood)}">${tmIcon('mood')} ${escapeHtml(moodLabel(memo.mood))}</button>`);
  return `<div class="memo-reading-meta-chips">${chips.join('')}</div>`;
}

function renderMemoReadingContent(memo) {
  const highlight = memoHighlight(memo);
  const story = memoStory(memo);
  const sections = [];
  if (highlight) sections.push(`<section class="memo-reading-section memo-highlight-section"><h3>${tmIcon('mood')}<span>Highlight</span></h3><p>${escapeHtml(highlight).replaceAll('\n', '<br>')}</p></section>`);
  if (story) sections.push(`<section class="memo-reading-section memo-story-section"><h3>${tmIcon('read')}<span>บันทึกการเดินทาง</span></h3><article>${escapeHtml(story).replaceAll('\n', '<br>')}</article></section>`);
  if (!sections.length) sections.push(`<section class="memo-reading-section empty-reading-section"><h3>${tmIcon('memo')}<span>ยังไม่มีเรื่องเล่า</span></h3><p>เพิ่ม Highlight หรือ Story เพื่อให้ Memo นี้อ่านเหมือนบทหนึ่งของการเดินทาง</p></section>`);
  return `<div class="memo-reading-content">${sections.join('')}</div>`;
}

function renderMemoPhotoStorySection(photos = []) {
  if (!photos.length) return '';
  return `<section class="memo-reading-section memo-photo-story-section">
    <div class="memo-reading-section-head"><h3>${tmIcon('gallery')}<span>Photo Story</span></h3><small>${photos.length} รูป</small></div>
    <div class="memo-reading-photo-grid">${photos.map((photo, index) => {
      const image = renderPhotoImg(photo, { preferThumb: true, alt: photo.caption || `Photo ${index + 1}` });
      if (!image) return '';
      const caption = String(photo.caption || '').trim();
      return `<button class="memo-reading-photo-card" type="button" data-sheet-action="photo-preview" data-lightbox-scope="memo" data-memo-id="${escapeHtml(photo.memo_id || state.currentMemoDetailId || '')}" data-photo-id="${escapeHtml(photo.id)}" data-full-src="${escapeHtml(photoFallbackSrc(photo))}">
        <span class="memo-reading-photo-index">${index + 1}</span>
        ${image}
        ${caption ? `<span class="memo-reading-photo-info"><strong>${escapeHtml(caption)}</strong></span>` : ''}
      </button>`;
    }).join('')}</div>
  </section>`;
}

function renderMemoReadingNavigation(memo, trip) {
  const { previous, next } = memoReadingNeighbors(memo, trip);
  if (!previous && !next) return '';
  const navCard = (item, label, direction) => item ? `<button class="memo-nav-card ${direction}" type="button" data-sheet-action="view-memo" data-id="${escapeHtml(item.id)}" ${trip ? `data-trip-id="${escapeHtml(trip.id)}"` : ''}>
    <small>${escapeHtml(label)}</small>
    <strong>${escapeHtml(shortText(item.title || item.place_name || 'Travel Memo', 46))}</strong>
    <span>${formatDate(item.visited_at || item.created_at, { numeric: true })}</span>
  </button>` : `<span class="memo-nav-card disabled"><small>${escapeHtml(label)}</small><strong>-</strong></span>`;
  return `<section class="memo-reading-section memo-nav-section">
    ${navCard(previous, 'ตอนก่อนหน้า', 'previous')}
    ${navCard(next, 'ตอนถัดไป', 'next')}
  </section>`;
}

function renderRelatedMemos(memo, trip) {
  if (!trip?.id) return '';
  const related = memosForTripChronological(trip.id)
    .filter((item) => item.id !== memo.id)
    .slice(0, 4);
  if (!related.length) return '';
  return `<section class="memo-reading-section related-memo-section">
    <div class="memo-reading-section-head"><h3>${tmIcon('timeline')}<span>Memo ใน Trip เดียวกัน</span></h3><small>${related.length} รายการ</small></div>
    <div class="related-memo-list">${related.map((item) => `<button type="button" data-sheet-action="view-memo" data-id="${escapeHtml(item.id)}" data-trip-id="${escapeHtml(trip.id)}">
      <span>${formatDate(item.visited_at || item.created_at, { numeric: true })}</span>
      <strong>${escapeHtml(shortText(item.title || item.place_name || 'Travel Memo', 54))}</strong>
      <small>${escapeHtml([item.place_name, item.city, item.country].filter(Boolean).join(' · ') || 'ไม่ระบุสถานที่')}</small>
    </button>`).join('')}</div>
  </section>`;
}

function openMemoSheet(id, options = {}) {
  els.detailSheet?.classList.remove('trip-detail-sheet');
  els.detailSheet?.classList.add('memo-reading-sheet');
  state.currentMemoDetailId = id;
  state.currentTripDetailId = options.fromTripId || '';
  const memo = state.memos.find((item) => item.id === id);
  if (!memo) return;
  incrementViewCounter('memo', id);
  const trip = tripById(memo.trip_id);
  const photos = photosForMemo(id);
  const locationText = [memo.place_name, memo.city, memo.region, memo.country].filter(Boolean).join(' · ') || 'ไม่ระบุสถานที่';
  const tagText = memo.tags?.length ? memo.tags.join(', ') : '';
  const fromTripId = options.fromTripId || trip?.id || '';
  els.detailSheetContent.innerHTML = `
    <div class="section-heading sheet-title-row memo-reading-title-row">
      <div>
        <div class="card-kicker">${tmIcon('read')}<span>Memo Reading</span></div>
        <h2>${escapeHtml(memo.title || memo.place_name || 'Travel Memo')}</h2>
        <p>${escapeHtml(locationText)} · ${formatDate(memo.visited_at, { numeric: true, timeStyle: 'short' })}</p>
      </div>
      <div class="sheet-title-actions">
        ${fromTripId ? `<button class="ghost-button compact sheet-back-button" type="button" data-sheet-action="back-trip" data-id="${escapeHtml(fromTripId)}">← กลับไป Trip</button>` : ''}
        <button class="ghost-button compact sheet-close-button" type="button" data-sheet-action="close" aria-label="ปิด">×</button>
      </div>
    </div>
    ${renderMemoHeroPhoto(memo, photos)}
    <div class="memo-reading-shell">
      <aside class="memo-reading-side">
        <div class="sheet-owner-row memo-reading-owner-row">
          ${creatorBadge(memo, 'ผู้สร้าง Memo')}
          ${renderViewChip(memo)}
          ${renderHiddenChip(memo)}
        </div>
        ${renderMemoMetaChips(memo, trip, photos)}
        ${renderTaxonomyChips(memo)}
        <div class="detail-grid memo-reading-info-grid">
          ${trip ? detailBlock('Trip', trip.title, tmIcon('trips'), { wide: true }) : ''}
          ${detailBlock('วันที่', formatDate(memo.visited_at, { numeric: true, timeStyle: 'short' }), tmIcon('calendar'))}
          ${detailBlock('สถานที่', locationText, tmIcon('location'), { wide: true })}
          ${detailBlock('คะแนน', memo.rating ? `${memo.rating}/5` : '', tmIcon('rating'), { optional: true })}
          ${detailBlock('Mood', memo.mood ? moodLabel(memo.mood) : '', tmIcon('mood'), { optional: true })}
          ${detailBlock('Tags', tagText, tmIcon('tag'), { optional: true })}
          ${detailBlock('พิกัด', isValidLatLng(memo.latitude, memo.longitude) ? `${memo.latitude}, ${memo.longitude} · ${locationSourceLabel(memoLocationSource(memo))}` : '', tmIcon('map'), { optional: true })}
        </div>
        <div class="memo-actions sheet-actions memo-reading-actions export-action-row">
          ${memo.user_id === state.user?.id ? `<button class="icon-button" type="button" data-sheet-action="edit" data-id="${memo.id}">${tmIcon('edit')}<span>แก้ไข</span></button>` : ''}
          <button class="icon-button primary-soft" type="button" data-sheet-action="share" data-id="${memo.id}">${tmIcon('route')}<span>แชร์</span></button>
          ${isValidLatLng(memo.latitude, memo.longitude) ? `<button class="icon-button" type="button" data-sheet-action="memo-map" data-id="${memo.id}">${tmIcon('map')}<span>แผนที่</span></button>` : ''}
          ${memo.user_id === state.user?.id ? `<button class="icon-button danger" type="button" data-sheet-action="delete" data-id="${memo.id}">${tmIcon('trash')}<span>ลบ</span></button>` : ''}
        </div>
      </aside>
      <main class="memo-reading-main">
        ${renderMemoReadingContent(memo)}
        ${renderMemoPhotoStorySection(photos)}
        ${renderMemoReadingNavigation(memo, trip)}
        ${renderRelatedMemos(memo, trip)}
      </main>
    </div>
  `;
  els.sheetBackdrop.classList.remove('hidden');
  els.detailSheet.classList.add('open', 'centered-detail', 'memo-reading-sheet');
  els.detailSheet.setAttribute('aria-hidden', 'false');
}

function closeSheet() {
  state.currentMemoDetailId = '';
  state.currentTripDetailId = '';
  els.sheetBackdrop.classList.add('hidden');
  els.detailSheet.classList.remove('open', 'centered-detail', 'trip-detail-sheet', 'memo-reading-sheet');
  els.detailSheet.setAttribute('aria-hidden', 'true');
}

async function handleSheetAction(event) {
  const photoTrigger = event.target.closest('[data-sheet-action="photo-preview"]');
  if (photoTrigger) {
    event.preventDefault();
    event.stopPropagation();
    const img = photoTrigger.querySelector('img');
    openPhotoLightbox(photoTrigger.dataset.photoId || photoTrigger.dataset.fullSrc || img?.dataset.fullSrc || img?.src, img?.alt || 'Travel photo', { scope: photoTrigger.dataset.lightboxScope || '', memoId: photoTrigger.dataset.memoId || '', tripId: photoTrigger.dataset.tripId || '' });
    return;
  }
  const button = event.target.closest('[data-sheet-action]');
  if (!button) return;
  const action = button.dataset.sheetAction;
  const id = button.dataset.id;
  if (action === 'close') closeSheet();
  if (action === 'edit') { closeSheet(); editMemo(id); }
  if (action === 'share') shareMemo(id);
  if (action === 'copy-memo-share') { const memo = state.memos.find((item) => item.id === id); if (memo) copyTextToClipboard(memoShareText(memo), 'คัดลอกข้อความ Memo แล้ว'); }
  if (action === 'memo-export-html') exportMemoHtml(id);
  if (action === 'memo-export-json') exportMemoJson(id);
  if (action === 'trip-share') shareTrip(id);
  if (action === 'trip-public-enable') await enableTripPublicShare(id);
  if (action === 'trip-public-disable') await disableTripPublicShare(id);
  if (action === 'trip-public-copy') await copyPublicTripLink(id);
  if (action === 'copy-trip-share') { const trip = state.trips.find((item) => item.id === id); if (trip) copyTextToClipboard(tripShareText(trip), 'คัดลอกข้อความ Trip แล้ว'); }
  if (action === 'trip-export-html') exportTripHtml(id);
  if (action === 'trip-export-json') exportTripJson(id);
  if (action === 'delete') deleteMemo(id);
  if (action === 'view-memo') { openMemoSheet(id, { fromTripId: button.dataset.tripId }); }
  if (action === 'back-trip') { openTripSheet(id); }
  if (action === 'memo-map') { const memo = state.memos.find((item) => item.id === id); closeSheet(); if (memo?.trip_id && els.mapTripFilter) els.mapTripFilter.value = memo.trip_id; openView('map'); setTimeout(() => { renderMapMarkers(); state.map?.invalidateSize?.(); }, 80); }
  if (action === 'trip-timeline') { closeSheet(); els.timelineTripFilter.value = id; openView('timeline'); renderTimeline(); }
  if (action === 'trip-map') { closeSheet(); if (els.mapTripFilter) els.mapTripFilter.value = id; openView('map'); setTimeout(() => { renderMapMarkers(); state.map?.invalidateSize?.(); }, 80); }
  if (action === 'trip-add') { const trip = state.trips.find((item) => item.id === id); closeSheet(); resetMemoForm(); if (trip) { els.memoTrip.value = id; els.country.value = trip.country || ''; els.city.value = trip.city || ''; } openView('add'); }
  if (action === 'trip-invite') { const trip = state.trips.find((item) => item.id === id); if (trip) inviteTripMember(trip); }
  if (action === 'invite-revoke') { revokeTripInvite(id, button.dataset.tripId); }
  if (action === 'trip-edit') { const trip = state.trips.find((item) => item.id === id); closeSheet(); if (trip) startTripEdit(trip); }
  if (action === 'trip-finish') { await finishTrip(id); }
}

async function saveTrip(event) {
  event.preventDefault();
  if (!state.user) {
    showNotice('กรุณาเข้าสู่ระบบด้วย Google ก่อนสร้าง Trip');
    openView('home');
    return;
  }
  const now = nowIso();
  const editingId = els.tripId.value;
  const existing = editingId ? await db.get('trips', editingId) : null;
  const trip = {
    id: editingId || uid(),
    user_id: state.user?.id || existing?.user_id || null,
    title: els.tripTitle.value.trim(),
    description: els.tripDescription.value.trim(),
    start_date: els.tripStart.value || null,
    end_date: els.tripEnd.value || null,
    country: els.tripCountry.value.trim(),
    city: els.tripCity.value.trim(),
    status: els.tripStatus.value,
    theme: existing?.theme || '',
    is_public: existing?.is_public || false,
    visibility: existing?.visibility || 'private',
    public_slug: existing?.public_slug || null,
    public_enabled_at: existing?.public_enabled_at || null,
    public_disabled_at: existing?.public_disabled_at || null,
    is_visible: existing?.is_visible !== false,
    view_count: Number(existing?.view_count || 0),
    cover_photo_id: existing?.cover_photo_id || null,
    sync_status: 'pending',
    created_at: existing?.created_at || now,
    updated_at: now,
    deleted_at: null
  };
  await db.put('trips', trip);
  await db.queueSync('upsert_trip', 'trip', trip.id);
  await loadLocalData();
  resetTripForm();
  renderAll();
  toast(editingId ? 'แก้ไข Trip แล้ว · เตรียมซิงก์อัตโนมัติ' : 'สร้าง Trip แล้ว · เตรียมซิงก์อัตโนมัติ');
  scheduleAutoSync('trip-saved', { delay: 1000 });
}

function resetTripForm() {
  els.tripForm.reset();
  els.tripId.value = '';
  els.tripStatus.value = 'planned';
}

function renderTrips() {
  const keyword = (els.tripSearch?.value || '').trim().toLowerCase();
  const trips = sortTrips(state.trips).filter((trip) => {
    const haystack = [trip.title, trip.description, trip.country, trip.city, trip.status].join(' ').toLowerCase();
    return !keyword || haystack.includes(keyword);
  });
  els.tripList.innerHTML = trips.length
    ? trips.map(renderTripCard).join('')
    : `<div class="empty-state">ยังไม่มี Trip ที่ตรงกับการค้นหา</div>`;
}



function memosForTripChronological(tripId) {
  return state.memos
    .filter((memo) => memo.trip_id === tripId && !memo.deleted_at)
    .sort((a, b) => new Date(a.visited_at || a.created_at || 0) - new Date(b.visited_at || b.created_at || 0));
}

function tripDateOnly(value) {
  if (!value) return '';
  const raw = String(value).trim();
  const direct = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (direct) return `${direct[1]}-${direct[2]}-${direct[3]}`;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function storyDateKey(value) {
  return tripDateOnly(value) || formatDateKey(value);
}

function tripMemoDateKeys(memos = []) {
  return [...new Set(memos
    .map((memo) => storyDateKey(memo.visited_at || memo.created_at))
    .filter(Boolean))]
    .sort();
}

function compareDateKey(a, b) {
  if (!a || !b) return 0;
  return a.localeCompare(b);
}

function tripDateBounds(trip, memos = []) {
  const tripStart = tripDateOnly(trip?.start_date);
  const tripEnd = tripDateOnly(trip?.end_date);
  const memoDates = tripMemoDateKeys(memos);
  if (tripStart && tripEnd) {
    return compareDateKey(tripEnd, tripStart) >= 0
      ? { start: tripStart, end: tripEnd, source: 'trip' }
      : { start: tripEnd, end: tripStart, source: 'trip-swapped' };
  }
  if (tripStart) {
    const memoEnd = memoDates.length ? memoDates[memoDates.length - 1] : tripStart;
    return { start: tripStart, end: compareDateKey(memoEnd, tripStart) >= 0 ? memoEnd : tripStart, source: 'trip-start' };
  }
  if (tripEnd) {
    const memoStart = memoDates.length ? memoDates[0] : tripEnd;
    return { start: compareDateKey(memoStart, tripEnd) <= 0 ? memoStart : tripEnd, end: tripEnd, source: 'trip-end' };
  }
  if (memoDates.length) return { start: memoDates[0], end: memoDates[memoDates.length - 1], source: 'memo-range' };
  return { start: '', end: '', source: 'empty' };
}

function tripDateRangeText(trip, memos = []) {
  const bounds = tripDateBounds(trip, memos);
  return formatDateRange(bounds.start, bounds.end, { fallback: 'ยังไม่ระบุวัน' });
}

function tripStoryIntroMeta(trip, memos = []) {
  const parts = [];
  const dateRange = tripDateRangeText(trip, memos);
  if (dateRange && dateRange !== 'ยังไม่ระบุวัน') parts.push(dateRange);
  const place = placeSummaryForMemos(memos, trip);
  if (place && place !== 'ยังไม่ระบุปลายทาง') parts.push(place);
  parts.push(tripDurationText(trip, memos));
  return parts.filter(Boolean).join(' · ');
}

function tripDayLabel(trip, dateKey) {
  let label = formatDate(dateKey, { dateStyle: 'full' });
  const bounds = tripDateBounds(trip, memosForTripChronological(trip?.id));
  if (bounds.start) {
    const dayNo = dayDiff(bounds.start, dateKey) + 1;
    if (Number.isFinite(dayNo) && dayNo > 0) label = `Day ${dayNo} · ${label}`;
  }
  return label;
}


function photosForMemos(memos = []) {
  const memoIds = new Set(memos.map((memo) => memo.id).filter(Boolean));
  return state.photos
    .filter((photo) => memoIds.has(photo.memo_id) && !photo.deleted_at)
    .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0) || new Date(a.created_at || 0) - new Date(b.created_at || 0));
}

function timelineMemoHasStory(memo) {
  return Boolean(String(memoHighlight(memo) || memoStory(memo) || '').trim());
}

function timelineMemoHasLocation(memo) {
  return isValidLatLng(memo.latitude, memo.longitude) || Boolean([memo.place_name, memo.city, memo.region, memo.country].filter(Boolean).length);
}

function tripTotalDays(trip, memos = []) {
  const bounds = tripDateBounds(trip, memos);
  if (bounds.start && bounds.end) {
    const days = dayDiff(bounds.start, bounds.end) + 1;
    if (Number.isFinite(days) && days > 0) return days;
  }
  return 0;
}

function tripDurationText(trip, memos = []) {
  const days = tripTotalDays(trip, memos);
  return days ? `${days} วัน` : 'ยังไม่มีวันเดินทาง';
}

function tripDayNumber(trip, dateKey, fallback = 1) {
  const bounds = tripDateBounds(trip, memosForTripChronological(trip?.id));
  if (bounds.start && dateKey) {
    const dayNo = dayDiff(bounds.start, dateKey) + 1;
    if (Number.isFinite(dayNo) && dayNo > 0) return dayNo;
  }
  return fallback;
}

function tripDateLabel(dateKey) {
  return formatDate(dateKey, { dateStyle: 'full' });
}

function placeSummaryForMemos(memos = [], trip = null) {
  const places = [...new Set(memos.flatMap((memo) => [memo.city, memo.country]).filter(Boolean))];
  if (places.length) return places.slice(0, 3).join(' · ') + (places.length > 3 ? ` +${places.length - 3}` : '');
  return [trip?.city, trip?.country].filter(Boolean).join(' · ') || 'ยังไม่ระบุปลายทาง';
}

function renderTimelineHero(memos = [], trip = null, contextMemos = memos) {
  if (!els.timelineHero) return '';
  els.timelineHero.classList.toggle('trip-selected', Boolean(trip));
  els.timelineHero.classList.toggle('all-stories', !trip);
  const statsMemos = trip ? contextMemos : memos;
  const photos = photosForMemos(statsMemos);
  const places = statsMemos.filter(timelineMemoHasLocation).length;
  const days = trip ? tripTotalDays(trip, statsMemos) : [...new Set(memos.map((memo) => storyDateKey(memo.visited_at || memo.created_at)).filter(Boolean))].length;
  const title = trip ? escapeHtml(trip.title || 'Trip Story') : 'ทุกเรื่องเล่าการเดินทาง';
  const subtitle = trip
    ? `${escapeHtml(tripDateRangeText(trip, statsMemos))} · ${escapeHtml(placeSummaryForMemos(statsMemos, trip))}`
    : `${memos.length} Memo · ${photos.length} รูป · ${days || 0} วัน`;
  const coverPhotos = photos.slice(0, 5);
  const cover = coverPhotos.length
    ? `<div class="timeline-cover-strip">${coverPhotos.map((photo, index) => {
        const image = renderPhotoImg(photo, { preferThumb: true, alt: photo.caption || `Story photo ${index + 1}` });
        return image ? `<button class="timeline-cover-photo" type="button" data-sheet-action="photo-preview" data-lightbox-scope="memo" data-memo-id="${escapeHtml(photo.memo_id || state.currentMemoDetailId || '')}" data-photo-id="${escapeHtml(photo.id)}" data-full-src="${escapeHtml(photoFallbackSrc(photo))}">${image}</button>` : '';
      }).join('')}</div>`
    : `<div class="timeline-cover-empty">${tmIcon('timeline')}<span>เริ่มเล่าเรื่องด้วย Memo และรูปแรกของทริป</span></div>`;
  els.timelineHero.innerHTML = `
    <div class="timeline-hero-copy">
      <p class="eyebrow">${trip ? 'Trip Story Timeline' : 'Travel Story Timeline'}</p>
      <h2>${title}</h2>
      <p>${subtitle}</p>
      <div class="timeline-hero-actions">
        ${trip ? `<button class="secondary-button compact" type="button" data-trip-action="view" data-id="${escapeHtml(trip.id)}">${tmIcon('view')}<span>ดู Trip</span></button>` : ''}
        <button class="primary-button compact" type="button" data-open="add">${tmIcon('add-memo')}<span>เพิ่ม Memo</span></button>
      </div>
    </div>
    ${cover}
    <div class="timeline-hero-stats" id="timelineHeroStats">
      <article><strong>${memos.length}</strong><span>Memo</span></article>
      <article><strong>${photos.length}</strong><span>รูป</span></article>
      <article><strong>${days || 0}</strong><span>วัน</span></article>
      <article><strong>${places}</strong><span>จุดหมาย</span></article>
    </div>
  `;
}

function applyTimelineTaxonomyFilter(kind, value) {
  openView('timeline');
  if (kind === 'tag') {
    state.timelineFilter = 'all';
    if (els.timelineTagFilter) els.timelineTagFilter.value = normalizeTaxonomyValue(value);
  }
  if (kind === 'mood') {
    state.timelineFilter = 'all';
    if (els.timelineMoodFilter) els.timelineMoodFilter.value = String(value || '');
  }
  syncTimelineFiltersFromInputs();
  renderTimeline();
}

function handleTaxonomyFilterClick(event) {
  const tagButton = event.target.closest('[data-filter-tag]');
  if (tagButton) {
    event.preventDefault();
    closeSheet();
    applyTimelineTaxonomyFilter('tag', tagButton.dataset.filterTag);
    return;
  }
  const moodButton = event.target.closest('[data-filter-mood]');
  if (moodButton) {
    event.preventDefault();
    closeSheet();
    applyTimelineTaxonomyFilter('mood', moodButton.dataset.filterMood);
  }
}

function renderTaxonomyChips(memo) {
  const tags = (memo.tags || []).map(normalizeTaxonomyValue).filter(Boolean);
  const tagHtml = tags.map((tag) => `<button type="button" class="taxonomy-chip tag-chip-link" data-filter-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</button>`).join('');
  const mood = String(memo.mood || '').trim();
  const moodHtml = mood ? `<button type="button" class="taxonomy-chip mood-chip-link" data-filter-mood="${escapeHtml(mood)}"><span>${moodEmoji(mood)}</span>${escapeHtml(moodLabel(mood))}</button>` : '';
  const ratingHtml = memo.rating ? `<span class="taxonomy-chip rating-chip-static">${'★'.repeat(Number(memo.rating || 0))} <small>${escapeHtml(ratingText(memo.rating))}</small></span>` : '';
  if (!tagHtml && !moodHtml && !ratingHtml) return '';
  return `<div class="taxonomy-chip-row">${moodHtml}${ratingHtml}${tagHtml}</div>`;
}

function renderTimelineTagMoodOverview(memos = []) {
  if (!els.timelineTagMoodOverview) return;
  const tagCounts = new Map();
  const moodCounts = new Map();
  for (const memo of memos) {
    for (const tag of memo.tags || []) {
      const clean = normalizeTaxonomyValue(tag);
      if (clean) tagCounts.set(clean, (tagCounts.get(clean) || 0) + 1);
    }
    const mood = normalizeTaxonomyValue(memo.mood || '');
    if (mood) moodCounts.set(mood, (moodCounts.get(mood) || 0) + 1);
  }
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10);
  const topMoods = [...moodCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (!topTags.length && !topMoods.length) {
    els.timelineTagMoodOverview.innerHTML = '';
    return;
  }
  els.timelineTagMoodOverview.innerHTML = `<div class="tag-mood-overview-card">
    ${topTags.length ? `<section><h4>${tmIcon('tag')}<span>Tag ที่ใช้บ่อย</span></h4><div class="taxonomy-chip-row">${topTags.map(([tag, count]) => `<button type="button" class="taxonomy-chip tag-chip-link" data-filter-tag="${escapeHtml(tag)}">#${escapeHtml(tag)} <small>${count}</small></button>`).join('')}</div></section>` : ''}
    ${topMoods.length ? `<section><h4>${tmIcon('mood')}<span>Mood</span></h4><div class="taxonomy-chip-row">${topMoods.map(([mood, count]) => `<button type="button" class="taxonomy-chip mood-chip-link" data-filter-mood="${escapeHtml(mood)}"><span>${moodEmoji(mood)}</span>${escapeHtml(moodLabel(mood))} <small>${count}</small></button>`).join('')}</div></section>` : ''}
  </div>`;
}

function handleTimelineSearchInput() {
  syncTimelineFiltersFromInputs();
  clearTimeout(state.timelineSearchTimer);
  state.timelineSearchTimer = setTimeout(() => renderTimeline(), 120);
}

function syncTimelineFiltersFromInputs() {
  state.timelineFilters = {
    keyword: String(els.memoSearch?.value || '').trim(),
    dateFrom: String(els.timelineDateFrom?.value || '').trim(),
    dateTo: String(els.timelineDateTo?.value || '').trim(),
    country: String(els.timelineCountryFilter?.value || '').trim(),
    city: String(els.timelineCityFilter?.value || '').trim(),
    tag: normalizeTaxonomyValue(els.timelineTagFilter?.value || ''),
    mood: String(els.timelineMoodFilter?.value || '').trim(),
    rating: String(els.timelineRatingFilter?.value || '').trim(),
    sync: String(els.timelineSyncFilter?.value || '').trim(),
    owner: String(els.timelineOwnerFilter?.value || '').trim()
  };
}

function handleTimelineFilterClick(event) {
  const button = event.target.closest('[data-timeline-filter]');
  if (!button) return;
  state.timelineFilter = button.dataset.timelineFilter || 'all';
  syncTimelineFiltersFromInputs();
  renderTimeline();
}

function handleTimelineSummaryAction(event) {
  const button = event.target.closest('[data-timeline-summary-action]');
  if (!button) return;
  if (button.dataset.timelineSummaryAction === 'clear') clearTimelineSearchFilters();
}

function clearTimelineSearchFilters() {
  state.timelineFilter = 'all';
  state.timelineFilters = { keyword: '', dateFrom: '', dateTo: '', country: '', city: '', tag: '', mood: '', rating: '', sync: '', owner: '' };
  if (els.memoSearch) els.memoSearch.value = '';
  if (els.timelineDateFrom) els.timelineDateFrom.value = '';
  if (els.timelineDateTo) els.timelineDateTo.value = '';
  if (els.timelineCountryFilter) els.timelineCountryFilter.value = '';
  if (els.timelineCityFilter) els.timelineCityFilter.value = '';
  if (els.timelineTagFilter) els.timelineTagFilter.value = '';
  if (els.timelineMoodFilter) els.timelineMoodFilter.value = '';
  if (els.timelineRatingFilter) els.timelineRatingFilter.value = '';
  if (els.timelineSyncFilter) els.timelineSyncFilter.value = '';
  if (els.timelineOwnerFilter) els.timelineOwnerFilter.value = '';
  renderTimeline();
}

function updateTimelineFilterButtons() {
  if (!els.timelineFilterChips) return;
  els.timelineFilterChips.querySelectorAll('[data-timeline-filter]').forEach((button) => {
    button.classList.toggle('active', button.dataset.timelineFilter === state.timelineFilter);
  });
}

function memoPhotoCaptions(memo) {
  return photosForMemo(memo.id).map((photo) => photo.caption || '').filter(Boolean);
}

function timelineMemoSearchText(memo) {
  const trip = tripById(memo.trip_id);
  return [
    memo.title,
    memo.place_name,
    memo.city,
    memo.region,
    memo.country,
    memo.note,
    memo.diary,
    memo.mood,
    memo.rating,
    memo.sync_status,
    trip?.title,
    trip?.city,
    trip?.country,
    ...(memo.tags || []),
    ...memoPhotoCaptions(memo)
  ].filter(Boolean).join(' ').toLowerCase();
}

function timelineMemoMatchesAdvancedFilters(memo) {
  const filters = state.timelineFilters || {};
  const dateKey = storyDateKey(memo.visited_at || memo.created_at);
  if (filters.dateFrom && (!dateKey || compareDateKey(dateKey, filters.dateFrom) < 0)) return false;
  if (filters.dateTo && (!dateKey || compareDateKey(dateKey, filters.dateTo) > 0)) return false;
  if (filters.country && !String(memo.country || '').toLowerCase().includes(filters.country.toLowerCase())) return false;
  if (filters.city && !String(memo.city || '').toLowerCase().includes(filters.city.toLowerCase())) return false;
  if (filters.tag) {
    const tags = (memo.tags || []).map(normalizeTaxonomyValue);
    if (!tags.some((tag) => tag.includes(filters.tag))) return false;
  }
  if (filters.mood && normalizeTaxonomyValue(memo.mood || '') !== normalizeTaxonomyValue(filters.mood)) return false;
  if (filters.rating && Number(memo.rating || 0) < Number(filters.rating)) return false;
  if (filters.sync && String(memo.sync_status || 'local') !== filters.sync) return false;
  if (filters.owner === 'own' && memo.user_id !== state.user?.id) return false;
  if (filters.owner === 'shared' && memo.user_id === state.user?.id) return false;
  return true;
}

function timelineMemoMatchesQuickFilter(memo) {
  if (state.timelineFilter === 'photos') return photosForMemo(memo.id).length > 0;
  if (state.timelineFilter === 'places') return timelineMemoHasLocation(memo);
  if (state.timelineFilter === 'notes') return timelineMemoHasStory(memo);
  if (state.timelineFilter === 'captions') return memoPhotoCaptions(memo).some((caption) => String(caption || '').trim());
  if (state.timelineFilter === 'own') return memo.user_id === state.user?.id;
  if (state.timelineFilter === 'shared') return memo.user_id !== state.user?.id;
  if (state.timelineFilter === 'pending') return String(memo.sync_status || 'local') === 'pending' || photosForMemo(memo.id).some((photo) => String(photo.sync_status || 'local') === 'pending');
  return true;
}

function timelineActiveFilterLabels(trip = null) {
  const filters = state.timelineFilters || {};
  const quickLabels = {
    photos: 'มีรูป', places: 'มีพิกัด', notes: 'มีเรื่องเล่า', captions: 'มี Caption', own: 'ของฉัน', shared: 'Shared', pending: 'Pending Sync'
  };
  const labels = [];
  if (trip) labels.push(`Trip: ${trip.title || 'Trip'}`);
  if (state.timelineFilter && state.timelineFilter !== 'all') labels.push(quickLabels[state.timelineFilter] || state.timelineFilter);
  if (filters.keyword) labels.push(`คำค้น: ${filters.keyword}`);
  if (filters.dateFrom || filters.dateTo) labels.push(`วันที่: ${filters.dateFrom || 'เริ่ม'} - ${filters.dateTo || 'ล่าสุด'}`);
  if (filters.country) labels.push(`ประเทศ: ${filters.country}`);
  if (filters.city) labels.push(`เมือง: ${filters.city}`);
  if (filters.tag) labels.push(`#${filters.tag}`);
  if (filters.mood) labels.push(`Mood: ${moodLabel(filters.mood)}`);
  if (filters.rating) labels.push(`${filters.rating}+ ดาว`);
  if (filters.sync) labels.push(`Sync: ${filters.sync}`);
  if (filters.owner) labels.push(filters.owner === 'own' ? 'เฉพาะของฉัน' : 'เฉพาะ Shared');
  return labels;
}

function renderTimelineSearchSummary(memos, allContextMemos, trip = null) {
  if (!els.timelineSearchSummary) return;
  const photos = photosForMemos(memos);
  const tripCount = new Set(memos.map((memo) => memo.trip_id).filter(Boolean)).size;
  const places = [...new Set(memos.flatMap((memo) => [memo.city, memo.country]).filter(Boolean))];
  const labels = timelineActiveFilterLabels(trip);
  const hasFilters = labels.length > 0;
  els.timelineSearchSummary.innerHTML = `
    <div class="timeline-result-count">${tmIcon('diagnostics')}<span>พบ ${memos.length} Memo จาก ${tripCount || (trip ? 1 : 0)} Trip · ${photos.length} รูป · ${places.length} จุดหมาย</span></div>
    ${hasFilters ? `<div class="timeline-active-filters">${labels.slice(0, 8).map((label) => `<span>${escapeHtml(label)}</span>`).join('')}<button class="ghost-button compact" type="button" data-timeline-summary-action="clear">${tmIcon('sync')}<span>ล้างตัวกรอง</span></button></div>` : `<div class="timeline-active-filters muted"><span>ค้นหาและกรองจากข้อมูลในเครื่องทันที ไม่โหลดหน้าใหม่</span></div>`}
  `;
}

function renderStoryDaySummary(items = []) {
  const photos = photosForMemos(items);
  const places = [...new Set(items.flatMap((memo) => [memo.city, memo.country]).filter(Boolean))];
  const start = items[0]?.visited_at || items[0]?.created_at;
  const end = items[items.length - 1]?.visited_at || items[items.length - 1]?.created_at;
  return `<div class="story-day-summary">
    <span>${tmIcon('memo')} ${items.length} Memo</span>
    <span>${tmIcon('photo')} ${photos.length} รูป</span>
    ${places.length ? `<span>${tmIcon('location')} ${escapeHtml(places.slice(0, 2).join(' · '))}${places.length > 2 ? ` +${places.length - 2}` : ''}</span>` : ''}
    ${start && end && start !== end ? `<span>${tmIcon('calendar')} ${formatDate(start, { timeStyle: 'short' })} - ${formatDate(end, { timeStyle: 'short' })}</span>` : ''}
  </div>`;
}

function renderPhotoStoryForMemo(memo, limit = 4) {
  const photos = photosForMemo(memo.id).slice(0, limit);
  if (!photos.length) return '';
  return `<div class="story-photo-strip">${photos.map((photo, index) => {
    const image = renderPhotoImg(photo, { preferThumb: true, alt: photo.caption || `Photo ${index + 1}` });
    const full = photoFallbackSrc(photo);
    return image ? `<button class="story-photo-frame" type="button" data-sheet-action="photo-preview" data-lightbox-scope="memo" data-memo-id="${escapeHtml(memo.id)}" data-photo-id="${escapeHtml(photo.id)}" data-full-src="${escapeHtml(full)}"><span>${index + 1}</span>${image}${photo.caption ? `<em>${escapeHtml(shortText(photo.caption, 42))}</em>` : ''}</button>` : '';
  }).join('')}</div>`;
}

function renderTimelineMemoStoryCard(memo, options = {}) {
  const trip = tripById(memo.trip_id);
  const photos = photosForMemo(memo.id);
  const location = [memo.place_name, memo.city, memo.country].filter(Boolean).join(' · ') || 'ไม่ระบุสถานที่';
  const creator = creatorBadge(memo, 'ผู้สร้าง Memo');
  const highlight = memoHighlight(memo);
  const story = memoStory(memo);
  const primaryPhoto = photos[0];
  const heroImage = primaryPhoto ? renderPhotoImg(primaryPhoto, { preferThumb: true, alt: primaryPhoto.caption || memo.title || 'Story photo' }) : '';
  const storyLength = String(story || '').trim().length;
  const badge = photos.length ? `<span>${tmIcon('photo')} ${photos.length} รูป</span>` : '';
  return `
    <article class="timeline-story-card story-chapter-card glass-card ${primaryPhoto ? 'has-photo' : 'text-only'}">
      <div class="story-chapter-marker"><span>${tmIcon('timeline')}</span></div>
      ${primaryPhoto && heroImage ? `<button class="story-chapter-cover" type="button" data-sheet-action="photo-preview" data-lightbox-scope="memo" data-memo-id="${escapeHtml(memo.id)}" data-photo-id="${escapeHtml(primaryPhoto.id)}" data-full-src="${escapeHtml(photoFallbackSrc(primaryPhoto))}">${heroImage}${primaryPhoto.caption ? `<em>${escapeHtml(shortText(primaryPhoto.caption, 72))}</em>` : ''}</button>` : ''}
      <div class="story-chapter-body">
        <button class="timeline-story-main story-chapter-main" type="button" data-${options.sheet ? 'sheet-' : ''}action="view-memo" data-id="${escapeHtml(memo.id)}" ${trip ? `data-trip-id="${escapeHtml(trip.id)}"` : ''}>
          <span class="story-time">${tmIcon('calendar')} ${formatDate(memo.visited_at, { numeric: true, timeStyle: 'short' })}</span>
          <strong>${escapeHtml(memo.title || memo.place_name || 'Travel Memo')}</strong>
          <small>${tmIcon('location')} ${escapeHtml(location)}</small>
        </button>
        <div class="story-card-meta">${creator}${badge}${trip ? `<span>${tmIcon('trips')} ${escapeHtml(trip.title)}</span>` : ''}</div>
        ${renderTaxonomyChips(memo)}
        ${highlight ? `<p class="memo-preview story-highlight"><strong>Highlight:</strong> ${escapeHtml(shortText(highlight, 150))}</p>` : ''}
        ${story ? `<p class="memo-preview diary-preview story-body-preview"><strong>Story:</strong> ${escapeHtml(shortText(story, options.sheet ? 220 : 260))}${storyLength > (options.sheet ? 220 : 260) ? '…' : ''}</p>` : ''}
        ${photos.length > 1 ? renderPhotoStoryForMemo(memo, options.sheet ? 6 : 5) : ''}
        <div class="story-chapter-actions">
          <button class="ghost-button compact" type="button" data-${options.sheet ? 'sheet-' : ''}action="view-memo" data-id="${escapeHtml(memo.id)}" ${trip ? `data-trip-id="${escapeHtml(trip.id)}"` : ''}>${tmIcon('read')}<span>อ่านตอนนี้</span></button>
          ${isValidLatLng(memo.latitude, memo.longitude) ? `<button class="ghost-button compact" type="button" data-open="map">${tmIcon('map')}<span>ดูแผนที่</span></button>` : ''}
        </div>
      </div>
    </article>`;
}

function renderTripStoryTimeline(trip) {
  const memos = memosForTripChronological(trip.id);
  if (!memos.length) return `<div class="empty-state compact-empty">ยังไม่มี Memo ใน Trip นี้</div>`;
  const groups = new Map();
  for (const memo of memos) {
    const key = storyDateKey(memo.visited_at || memo.created_at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(memo);
  }
  return `<div class="trip-story-view">${Array.from(groups.entries()).map(([dateKey, items]) => `
    <section class="story-day-group">
      <div class="story-day-head"><span>${escapeHtml(tripDayLabel(trip, dateKey))}</span><small>${items.length} Memo</small></div>
      <div class="story-day-items">${items.map((memo) => renderTimelineMemoStoryCard(memo, { sheet: true })).join('')}</div>
    </section>`).join('')}</div>`;
}


function uniqueTripDestinations(memos = [], trip = null) {
  const values = [];
  const add = (value) => {
    const clean = String(value || '').trim();
    if (clean && !values.some((item) => item.toLowerCase() === clean.toLowerCase())) values.push(clean);
  };
  if (trip) {
    add([trip.city, trip.country].filter(Boolean).join(' · '));
    add(trip.country);
  }
  memos.forEach((memo) => {
    add([memo.city, memo.country].filter(Boolean).join(' · '));
    add(memo.place_name);
  });
  return values.filter(Boolean);
}

function tripGeoMemos(memos = []) {
  return memos.filter((memo) => isValidLatLng(memo.latitude, memo.longitude));
}

function dedupePhotos(photos = []) {
  const seen = new Set();
  return (photos || []).filter((photo) => {
    if (!photo || photo.deleted_at) return false;
    const key = photo.id || photo.storage_path || photo.thumb_path || photo.thumbnail_path || photo.local_url || photo.preview_url || photo.data_url || `${photo.memo_id || ''}:${photo.original_name || photo.name || ''}:${photo.size_bytes || photo.size || ''}`;
    const normalized = String(key || '').trim();
    if (!normalized) return true;
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function tripPhotoHighlights(photos = [], limit = 10) {
  return dedupePhotos(photos)
    .sort((a, b) => {
      const captionScore = Number(Boolean(b.caption)) - Number(Boolean(a.caption));
      if (captionScore) return captionScore;
      return Number(a.sort_order ?? 9999) - Number(b.sort_order ?? 9999) || new Date(a.taken_at || a.created_at || 0) - new Date(b.taken_at || b.created_at || 0);
    })
    .slice(0, limit);
}

function tripCoverPhoto(photos = []) {
  return tripPhotoHighlights(photos, 1)[0] || null;
}

function tripAccessLabel(trip, isOwner, canContribute) {
  if (isOwner) return 'Trip ของฉัน';
  if (canContribute) return 'Shared Trip · เพิ่ม Memo ได้';
  return 'Shared Trip · อ่านอย่างเดียว';
}

function renderTripHero(trip, memos, photos, options = {}) {
  const isOwner = Boolean(options.isOwner);
  const canContribute = Boolean(options.canContribute);
  const cover = tripCoverPhoto(photos);
  const coverSrc = cover ? photoFallbackSrc(cover) : '';
  const destination = [trip.country, trip.city].filter(Boolean).join(' · ') || 'ยังไม่ระบุปลายทาง';
  const dates = formatDateRange(trip.start_date, trip.end_date, { fallback: 'ยังไม่ระบุวัน' });
  const owner = creatorLabel(trip);
  return `
    <section class="trip-detail-hero ${coverSrc ? 'has-cover' : 'no-cover'}">
      ${coverSrc ? `<img src="${escapeHtml(coverSrc)}" alt="${escapeHtml(trip.title || 'Trip cover')}" loading="lazy" decoding="async" />` : `<div class="trip-hero-fallback">${tmIcon('trips')}</div>`}
      <div class="trip-hero-overlay">
        <div class="trip-hero-kicker">
          <span>${tmIcon(isOwner ? 'user' : 'group')}<span>${escapeHtml(tripAccessLabel(trip, isOwner, canContribute))}</span></span>
          ${renderTripStatusChip(trip)}
        </div>
        <h2>${escapeHtml(trip.title || 'Trip Story')}</h2>
        <p>${tmIcon('location')}<span>${escapeHtml(destination)}</span></p>
        <p>${tmIcon('calendar')}<span>${escapeHtml(dates)}</span></p>
        <small>ผู้สร้าง Trip: ${escapeHtml(owner)}</small>
      </div>
    </section>`;
}

function renderTripOverviewStats(trip, memos, photos, invitePeople) {
  const destinations = uniqueTripDestinations(memos, trip);
  const geoCount = tripGeoMemos(memos).length;
  const days = tripTotalDays(trip, memos);
  return `<section class="trip-overview-grid">
    <article>${tmIcon('calendar')}<strong>${days || '-'}</strong><span>วันเดินทาง</span></article>
    <article>${tmIcon('memo')}<strong>${memos.length}</strong><span>Memo</span></article>
    <article>${tmIcon('photo')}<strong>${photos.length}</strong><span>รูปภาพ</span></article>
    <article>${tmIcon('location')}<strong>${destinations.length}</strong><span>จุดหมาย</span></article>
    <article>${tmIcon('map')}<strong>${geoCount}</strong><span>มีพิกัด</span></article>
    <article>${tmIcon('group')}<strong>${invitePeople.length}</strong><span>ผู้ร่วม Trip</span></article>
  </section>`;
}

function renderTripPhotoHighlights(trip, photos) {
  const highlights = tripPhotoHighlights(photos, 10);
  if (!highlights.length) {
    return `<section class="trip-detail-section trip-photo-highlights"><div class="trip-section-head"><h3>${tmIcon('gallery')}<span>Photo Highlights</span></h3></div><div class="empty-state compact-empty">ยังไม่มีรูปใน Trip นี้</div></section>`;
  }
  return `<section class="trip-detail-section trip-photo-highlights">
    <div class="trip-section-head"><h3>${tmIcon('gallery')}<span>Photo Highlights</span></h3><small>${highlights.length} รูปเด่นจากทริปนี้</small></div>
    <div class="trip-highlight-grid">${highlights.map((photo, index) => {
      const src = photoFallbackSrc(photo);
      const img = renderPhotoImg(photo, { preferThumb: true, alt: photo.caption || `Trip photo ${index + 1}` });
      if (!src || !img) return '';
      return `<button class="trip-highlight-photo" type="button" data-sheet-action="photo-preview" data-lightbox-scope="trip" data-trip-id="${escapeHtml(trip.id)}" data-photo-id="${escapeHtml(photo.id)}" data-full-src="${escapeHtml(src)}">${img}${photo.caption ? `<span>${escapeHtml(shortText(photo.caption, 54))}</span>` : ''}</button>`;
    }).join('')}</div>
  </section>`;
}

function renderTripMapSummary(trip, memos) {
  const geoMemos = tripGeoMemos(memos);
  const places = uniqueTripDestinations(geoMemos, null).slice(0, 6);
  return `<section class="trip-detail-section trip-map-summary">
    <div class="trip-section-head"><h3>${tmIcon('map')}<span>Map Points</span></h3><small>${geoMemos.length} Memo มีพิกัด</small></div>
    ${geoMemos.length ? `<div class="trip-place-list">${places.map((place) => `<span>${escapeHtml(place)}</span>`).join('')}</div>` : `<div class="empty-state compact-empty">ยังไม่มี Memo ที่มีพิกัดใน Trip นี้</div>`}
  </section>`;
}

function renderTripSharedAccess(trip, invitePeople, options = {}) {
  const isOwner = Boolean(options.isOwner);
  const canContribute = Boolean(options.canContribute);
  const ownerText = creatorLabel(trip);
  return `<section class="trip-detail-section trip-shared-access">
    <div class="trip-section-head"><h3>${tmIcon('group')}<span>Shared Access</span></h3><small>${escapeHtml(isOwner ? 'จัดการผู้ร่วม Trip' : tripAccessLabel(trip, false, canContribute))}</small></div>
    <div class="shared-access-card">
      <div>${creatorBadge(trip, 'เจ้าของ Trip')}</div>
      <p>${isOwner ? 'คุณเป็นผู้สร้าง Trip นี้ สามารถเชิญสมาชิก เพิ่ม Memo และจบ Trip ได้' : `คุณกำลังดู Trip ที่แชร์โดย ${escapeHtml(ownerText)}${canContribute ? ' และสามารถเพิ่ม Memo ได้' : ' แบบอ่านอย่างเดียว'}`}</p>
      ${invitePeople.length ? `<div class="invite-detail-list compact-shared-list">${invitePeople.slice(0, 8).map(({ profile, email, invite }) => `<div class="invite-person participant-card">${avatarMarkup(profile, email, 'invite-avatar')}<span><strong>${escapeHtml(profile?.display_name || email)}</strong><small>${escapeHtml(email)} · ${escapeHtml(inviteStatusLabel(invite.status))}</small></span></div>`).join('')}</div>` : '<span class="muted">ยังไม่มีผู้ร่วม Trip</span>'}
    </div>
  </section>`;
}

function renderTripSharePreview(trip, memos = [], photos = []) {
  const places = uniqueTripDestinations(memos, trip);
  const previewText = tripShareText(trip);
  const isOwner = trip.user_id === state.user?.id;
  const publicUrl = isTripPublic(trip) ? publicTripUrl(trip) : '';
  return `<section class="trip-detail-section trip-share-preview public-share-control">
    <div class="trip-section-head"><h3>${tmIcon('route')}<span>Share</span></h3><small>${publicUrl ? 'Public read-only link พร้อมใช้งาน' : 'แชร์ Trip หรือเปิด Public link'}</small></div>
    <div class="share-preview-card">
      <strong>${escapeHtml(trip.title || 'Trip Story')}</strong>
      <small>${escapeHtml(formatDateRange(trip.start_date, trip.end_date, { fallback: 'ยังไม่ระบุวัน' }))}</small>
      <p>${escapeHtml(shortText(previewText, 150))}</p>
      <div class="share-preview-stats"><span>${memos.length} Memo</span><span>${photos.length} รูป</span><span>${places.length} จุดหมาย</span></div>
      <div class="public-share-status ${publicUrl ? 'enabled' : 'private'}">
        ${tmIcon(publicUrl ? 'view' : 'hidden')}
        <span>${publicUrl ? 'Public read-only เปิดอยู่' : 'Private / เฉพาะคนมีสิทธิ์'}</span>
      </div>
      ${publicUrl ? `<code class="public-share-url">${escapeHtml(publicUrl)}</code>` : ''}
      <div class="share-preview-actions public-share-actions">
        <button class="icon-button primary-soft" type="button" data-sheet-action="trip-share" data-id="${escapeHtml(trip.id)}">${tmIcon('route')}<span>แชร์</span></button>
        ${isOwner && !publicUrl ? `<button class="icon-button" type="button" data-sheet-action="trip-public-enable" data-id="${escapeHtml(trip.id)}">${tmIcon('view')}<span>เปิด Public</span></button>` : ''}
        ${publicUrl ? `<button class="icon-button" type="button" data-sheet-action="trip-public-copy" data-id="${escapeHtml(trip.id)}">${tmIcon('memo')}<span>Copy Public</span></button>` : ''}
        ${isOwner && publicUrl ? `<button class="icon-button danger-soft" type="button" data-sheet-action="trip-public-disable" data-id="${escapeHtml(trip.id)}">${tmIcon('hidden')}<span>ปิด Public</span></button>` : ''}
      </div>
      <p class="muted small-note">Public link เป็น read-only และแสดงเฉพาะ Memo/รูปใน Trip นี้ที่มองเห็นได้เท่านั้น</p>
    </div>
  </section>`;
}

function activityShortTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const todayKey = formatDateKey(nowIso());
  const itemKey = formatDateKey(date.toISOString());
  const time = date.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  if (todayKey === itemKey) return `วันนี้ ${time}`;
  return `${date.toLocaleDateString('th-TH', { day: '2-digit', month: 'short' })} ${time}`;
}

function renderSharedTripActivity(tripId) {
  const activities = [];
  const memos = state.memos.filter((memo) => memo.trip_id === tripId && !memo.deleted_at);
  for (const memo of memos) {
    activities.push({
      type: 'memo',
      at: memo.updated_at || memo.created_at || memo.visited_at,
      user_id: memo.user_id,
      text: memo.title || memo.place_name || 'Memo ใหม่',
      place: [memo.place_name, memo.city, memo.country].filter(Boolean).join(' · ')
    });
  }
  const photos = photosForTrip(tripId);
  for (const photo of photos) {
    activities.push({
      type: 'photo',
      at: photo.updated_at || photo.created_at || photo.taken_at,
      user_id: photo.user_id,
      text: photo.caption || 'รูปภาพใหม่',
      place: photo.caption ? 'Photo caption' : 'Photo'
    });
  }
  const sorted = activities
    .filter((item) => item.at)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 6);
  if (!sorted.length) return '';
  return `<section class="detail-block wide trip-activity-block compact-trip-activity activity-timeline-panel"><h4>${tmIcon('queue')}<span>ความเคลื่อนไหวล่าสุด</span><small>${sorted.length} รายการ</small></h4><div class="activity-compact-list">${sorted.map((item) => {
    const profile = profileById(item.user_id);
    const actor = profile?.display_name || profile?.email || 'ผู้ร่วม Trip';
    const fullTime = formatDate(item.at, { numeric: true, timeStyle: 'short' });
    const shortTime = activityShortTime(item.at);
    const label = item.type === 'memo' ? 'Memo' : 'รูปภาพ';
    const title = `${label}: ${item.text}\nโดย ${actor}\n${fullTime}${item.place ? `\n${item.place}` : ''}`;
    return `<div class="activity-compact-item activity-rich-item" tabindex="0" title="${escapeHtml(title)}" data-tooltip="${escapeHtml(`${actor} · ${fullTime}`)}">
      <span class="activity-avatar-wrap">${avatarMarkup(profile, actor, 'activity-avatar')}</span>
      <span class="activity-main"><strong>${escapeHtml(shortText(item.text, 30))}</strong><small><span>${escapeHtml(label)}</span><span>${escapeHtml(shortTime)}</span></small></span>
      <span class="activity-kind">${item.type === 'memo' ? tmIcon('memo') : tmIcon('photo')}</span>
    </div>`;
  }).join('')}</div></section>`;
}

function openTripSheet(id, options = {}) {
  const trip = state.trips.find((item) => item.id === id) || options.trip || null;
  if (!trip) {
    showNotice('ไม่พบ Trip นี้ในเครื่อง ลองดึงข้อมูลจาก Cloud อีกครั้ง');
    return;
  }
  if (!state.trips.some((item) => item.id === trip.id)) state.trips.push(trip);
  try {
    renderTripSheetUnsafe(id);
  } catch (error) {
    console.error('Trip detail render failed', error);
    logClientError('openTripSheet', error?.message || error);
    try {
      renderTripSheetFallback(id, error);
    } catch (fallbackError) {
      console.error('Trip detail fallback failed', fallbackError);
      logClientError('openTripSheetFallback', fallbackError?.message || fallbackError);
      renderTripSheetEmergency(trip, fallbackError || error);
    }
  }
}

function renderTripSheetEmergency(trip, error = null) {
  state.currentTripDetailId = trip?.id || '';
  state.currentMemoDetailId = '';
  const memos = state.memos.filter((memo) => memo.trip_id === trip.id && !memo.deleted_at);
  const photos = photosForTrip(trip.id);
  const canContribute = canContributeToTrip(trip);
  const isOwner = trip.user_id === state.user?.id;
  const destination = [trip.country, trip.city].filter(Boolean).join(' · ') || 'ยังไม่ระบุปลายทาง';
  const dates = formatDateRange(trip.start_date, trip.end_date, { fallback: 'ยังไม่ระบุวัน' });
  els.detailSheetContent.innerHTML = `
    <div class="section-heading sheet-title-row trip-detail-title-row">
      <div>
        <div class="card-kicker">${tmIcon('trips')}<span>Trip Detail</span></div>
        <h2>${escapeHtml(trip.title || 'Trip')}</h2>
        <p>${escapeHtml(destination)} · ${escapeHtml(dates)}</p>
      </div>
      <button class="ghost-button compact sheet-close-button" type="button" data-sheet-action="close" aria-label="ปิด">×</button>
    </div>
    ${error ? `<div class="empty-state compact error-empty">เปิด Trip Detail โหมดพื้นฐาน เนื่องจากส่วนแสดงผลเต็มมีปัญหา: ${escapeHtml(error.message || String(error))}</div>` : ''}
    <div class="sheet-owner-row">
      ${creatorBadge(trip, 'ผู้สร้าง Trip')}
      ${renderTripStatusChip(trip)}
      ${renderViewChip(trip)}
    </div>
    <div class="sheet-stat-grid">
      <article><strong>${memos.length}</strong><span>Memo</span></article>
      <article><strong>${photos.length}</strong><span>รูปภาพ</span></article>
      <article><strong>${tripTotalDays(trip, memos) || '-'}</strong><span>วันเดินทาง</span></article>
    </div>
    <div class="memo-actions sheet-actions">
      ${canContribute ? `<button class="icon-button" type="button" data-sheet-action="trip-add" data-id="${trip.id}">${tmIcon('add-memo')}<span>เพิ่ม Memo</span></button>` : ''}
      <button class="icon-button primary-soft" type="button" data-sheet-action="trip-timeline" data-id="${trip.id}">${tmIcon('timeline')}<span>Timeline</span></button>
      ${isOwner ? `<button class="icon-button" type="button" data-sheet-action="trip-edit" data-id="${trip.id}">${tmIcon('edit')}<span>แก้ไข</span></button>` : ''}
    </div>
  `;
  els.sheetBackdrop.classList.remove('hidden');
  els.detailSheet.classList.add('open', 'centered-detail', 'trip-detail-sheet');
  els.detailSheet.setAttribute('aria-hidden', 'false');
}

function renderTripSheetFallback(id, error = null) {
  const trip = state.trips.find((item) => item.id === id);
  if (!trip) return;
  const memos = memosForTripChronological(id);
  const photos = photosForTrip(id);
  const isOwner = trip.user_id === state.user?.id;
  const canContribute = canContributeToTrip(trip);
  const destination = [trip.country, trip.city].filter(Boolean).join(' · ') || 'ยังไม่ระบุปลายทาง';
  const dates = formatDateRange(trip.start_date, trip.end_date, { fallback: 'ยังไม่ระบุวัน' });
  els.detailSheetContent.innerHTML = `
    <div class="section-heading sheet-title-row trip-detail-title-row">
      <div>
        <div class="card-kicker">${tmIcon('trips')}<span>Trip Detail</span></div>
        <h2>${escapeHtml(trip.title || 'Trip')}</h2>
        <p>${escapeHtml(destination)} · ${escapeHtml(dates)}</p>
      </div>
      <button class="ghost-button compact sheet-close-button" type="button" data-sheet-action="close" aria-label="ปิด">×</button>
    </div>
    <div class="sheet-owner-row">
      ${creatorBadge(trip, 'ผู้สร้าง Trip')}
      ${renderTripStatusChip(trip)}
      ${renderViewChip(trip)}
      ${renderHiddenChip(trip)}
    </div>
    ${error ? `<div class="empty-state compact error-empty">โหลด Trip Detail แบบเต็มไม่สำเร็จ จึงเปิดโหมดพื้นฐานแทน: ${escapeHtml(error.message || String(error))}</div>` : ''}
    <div class="sheet-stat-grid">
      <article><strong>${memos.length}</strong><span>Memo</span></article>
      <article><strong>${photos.length}</strong><span>รูปภาพ</span></article>
      <article><strong>${tripTotalDays(trip, memos) || '-'}</strong><span>วันเดินทาง</span></article>
    </div>
    <div class="memo-actions sheet-actions">
      ${canContribute ? `<button class="icon-button" type="button" data-sheet-action="trip-add" data-id="${trip.id}">${tmIcon('add-memo')}<span>เพิ่ม Memo</span></button>` : ''}
      <button class="icon-button primary-soft" type="button" data-sheet-action="trip-timeline" data-id="${trip.id}">${tmIcon('timeline')}<span>Timeline</span></button>
      ${isOwner ? `<button class="icon-button" type="button" data-sheet-action="trip-invite" data-id="${trip.id}">${tmIcon('user')}<span>เชิญ</span></button><button class="icon-button" type="button" data-sheet-action="trip-edit" data-id="${trip.id}">${tmIcon('edit')}<span>แก้ไข</span></button>` : ''}
    </div>
    ${renderTripPhotoHighlights(trip, photos)}
    ${renderTripStoryTimeline(trip)}
  `;
  els.sheetBackdrop.classList.remove('hidden');
  els.detailSheet.classList.add('open', 'centered-detail', 'trip-detail-sheet');
  els.detailSheet.setAttribute('aria-hidden', 'false');
}

function renderTripSheetUnsafe(id) {
  state.currentTripDetailId = id;
  state.currentMemoDetailId = '';
  const trip = state.trips.find((item) => item.id === id);
  if (!trip) return;
  incrementViewCounter('trip', id);
  const memos = memosForTripChronological(id);
  const photos = photosForTrip(trip.id);
  const isOwner = trip.user_id === state.user?.id;
  const canContribute = canContributeToTrip(trip);
  if (!isOwner && (!state.memos.some((memo) => memo.trip_id === id) || !photos.length)) ensureSharedTripContent(id);
  const invitePeople = invitedPeopleForTrip(trip.id);
  const geoMemos = tripGeoMemos(memos);
  els.detailSheetContent.innerHTML = `
    <div class="section-heading sheet-title-row trip-detail-title-row">
      <div>
        <div class="card-kicker">${tmIcon('trips')}<span>Trip Detail</span></div>
      </div>
      <button class="ghost-button compact sheet-close-button" type="button" data-sheet-action="close" aria-label="ปิด">×</button>
    </div>
    ${renderTripHero(trip, memos, photos, { isOwner, canContribute })}
    ${renderTripOverviewStats(trip, memos, photos, invitePeople)}
    <div class="trip-detail-actions">
      ${canContribute ? `<button class="primary-button" type="button" data-sheet-action="trip-add" data-id="${trip.id}">${tmIcon('add-memo')}<span>เพิ่ม Memo ใน Trip นี้</span></button>` : ''}
      <button class="secondary-button" type="button" data-sheet-action="trip-timeline" data-id="${trip.id}">${tmIcon('timeline')}<span>ดู Story Timeline</span></button>
      ${geoMemos.length ? `<button class="ghost-button" type="button" data-sheet-action="trip-map" data-id="${trip.id}">${tmIcon('map')}<span>ดูแผนที่</span></button>` : ''}
      <button class="ghost-button primary-soft" type="button" data-sheet-action="trip-share" data-id="${trip.id}">${tmIcon('route')}<span>แชร์ Trip</span></button>
      ${isOwner ? `<button class="ghost-button" type="button" data-sheet-action="trip-invite" data-id="${trip.id}">${tmIcon('user')}<span>เชิญเพื่อน</span></button>${!isTripFinished(trip) ? `<button class="ghost-button primary-soft" type="button" data-sheet-action="trip-finish" data-id="${trip.id}">${tmIcon('check-in')}<span>จบ Trip</span></button>` : ''}<button class="ghost-button" type="button" data-sheet-action="trip-edit" data-id="${trip.id}">${tmIcon('edit')}<span>แก้ไข Trip</span></button>` : ''}
    </div>
    <div class="trip-detail-layout">
      <div class="trip-detail-main">
        ${renderTripPhotoHighlights(trip, photos)}
        <section class="trip-detail-section trip-story-preview">
          <div class="trip-section-head"><h3>${tmIcon('timeline')}<span>Story Timeline</span></h3><small>${memos.length} chapter</small></div>
          <p class="muted small-note story-help">อ่าน Memo ต่อเนื่องตามวันและเวลา พร้อมรูปที่เรียงตามลำดับอัปโหลด</p>
          ${renderTripStoryTimeline(trip)}
        </section>
      </div>
      <aside class="trip-detail-side">
        ${renderTripMapSummary(trip, memos)}
        ${renderTripSharePreview(trip, memos, photos)}
        ${renderTripSharedAccess(trip, invitePeople, { isOwner, canContribute })}
        ${isTripFinished(trip) ? `<section class="trip-detail-section done-note">${detailBlock('สถานะ Trip', 'ทริปนี้จบแล้ว แต่ยังเปิดดูเรื่องเล่าและรูปภาพได้ตามปกติ', tmIcon('check-in'), { wide: true })}</section>` : ''}
        ${renderSharedTripActivity(trip.id)}
      </aside>
    </div>
  `;
  els.sheetBackdrop.classList.remove('hidden');
  els.detailSheet.classList.add('open', 'centered-detail', 'trip-detail-sheet');
  els.detailSheet.setAttribute('aria-hidden', 'false');
}

function startTripEdit(trip) {
  els.tripId.value = trip.id;
  els.tripTitle.value = trip.title || '';
  els.tripStatus.value = trip.status || 'done';
  els.tripStart.value = trip.start_date || '';
  els.tripEnd.value = trip.end_date || '';
  els.tripCountry.value = trip.country || '';
  els.tripCity.value = trip.city || '';
  els.tripDescription.value = trip.description || '';
  openView('trips');
  scrollActiveViewToTop();
}

async function handleTripActionCapture(event) {
  const button = closestElement(event.target, '[data-trip-action]');
  if (!button || button.disabled) return;
  event.preventDefault();
  event.stopPropagation();
  event.__tmTripActionHandled = true;
  await processTripAction(button, event);
}

async function handleTripAction(event) {
  if (event.__tmTripActionHandled) return;
  const button = closestElement(event.target, '[data-trip-action]');
  if (!button || button.disabled) return;
  event.preventDefault();
  event.stopPropagation();
  event.__tmTripActionHandled = true;
  await processTripAction(button, event);
}

async function processTripAction(button, event = null) {
  const card = closestElement(button, '[data-id]');
  const id = button.dataset.id || card?.dataset?.id || '';
  const action = button.dataset.tripAction;
  if (!id || !action) return;
  const trip = state.trips.find((item) => item.id === id) || await db.get('trips', id).catch(() => null);
  if (!trip) {
    showNotice('ไม่พบ Trip นี้ในเครื่อง ลองดึงข้อมูลจาก Cloud อีกครั้ง');
    return;
  }
  if (!state.trips.some((item) => item.id === trip.id)) state.trips.push(trip);

  if (action === 'view') {
    openTripSheet(id, { trip });
    return;
  }
  if (action === 'timeline') {
    els.timelineTripFilter.value = id;
    openView('timeline');
    renderTimeline();
    return;
  }
  if (action === 'add') {
    resetMemoForm();
    els.memoTrip.value = id;
    els.country.value = trip.country || '';
    els.city.value = trip.city || '';
    openView('add');
    return;
  }
  if (action === 'edit') {
    startTripEdit(trip);
    return;
  }
  if (action === 'invite') {
    inviteTripMember(trip);
    return;
  }
  if (action === 'share') {
    shareTrip(id);
    return;
  }
  if (action === 'public-enable') { await enableTripPublicShare(id); return; }
  if (action === 'public-disable') { await disableTripPublicShare(id); return; }
  if (action === 'public-copy') { await copyPublicTripLink(id); return; }
  if (action === 'export-html') {
    exportTripHtml(id);
    return;
  }
  if (action === 'export-json') {
    exportTripJson(id);
    return;
  }
  if (action === 'copy-share') {
    copyTextToClipboard(tripShareText(trip), 'คัดลอกข้อความ Trip แล้ว');
    return;
  }
  if (action === 'delete') {
    deleteTrip(id);
    return;
  }
  if (action === 'finish') {
    await finishTrip(id);
  }
}

async function finishTrip(id) {
  const trip = state.trips.find((item) => item.id === id) || await db.get('trips', id).catch(() => null);
  if (!trip || trip.user_id !== state.user?.id) return;
  if (isTripFinished(trip)) {
    showNotice('Trip นี้ถูกระบุว่าจบแล้ว');
    return;
  }
  if (!confirm(`จบ Trip "${trip.title || 'Trip'}" หรือไม่?
ยังสามารถเปิดดู Memo, รูปภาพ และ Timeline ได้ตามปกติ`)) return;
  const now = nowIso();
  const updated = { ...trip, status: 'done', end_date: trip.end_date || now.slice(0, 10), sync_status: 'pending', updated_at: now };
  await db.put('trips', updated);
  await db.queueSync('upsert_trip', 'trip', updated.id);
  await loadLocalData();
  renderAll();
  if (!els.sheetBackdrop.classList.contains('hidden')) openTripSheet(updated.id);
  showNotice('จบ Trip แล้ว · ยังเปิดดูเรื่องเล่าได้ตามปกติ');
  scheduleAutoSync('trip-finished', { delay: 900 });
}

async function inviteTripMember(trip) {
  if (!state.user || trip.user_id !== state.user.id) return;
  const raw = prompt('ใส่อีเมลสมาชิกที่ต้องการเชิญ\nใส่ได้หลายอีเมล โดยคั่นด้วย comma, space หรือขึ้นบรรทัดใหม่');
  if (!raw) return;
  const emails = [...new Set(String(raw)
    .split(/[\s,;]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean))];
  if (!emails.length) return;
  const invalidFormat = emails.filter((email) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email));
  if (invalidFormat.length) {
    showNotice(`รูปแบบอีเมลไม่ถูกต้อง: ${invalidFormat.join(', ')}`);
    return;
  }
  if (!supabase) {
    showNotice('ต้องเชื่อมต่อ Supabase ก่อนเชิญสมาชิก');
    return;
  }
  try {
    const valid = [];
    const notFound = [];
    for (const email of emails) {
      const { data, error } = await supabase.rpc('registered_user_exists_by_email', { p_email: email });
      if (error) throw error;
      if (data === true) valid.push(email);
      else notFound.push(email);
    }
    if (notFound.length) {
      showNotice(`ไม่มีอีเมลนี้ในระบบ: ${notFound.join(', ')}`);
      if (!valid.length) return;
    }
    const sent = [];
    for (const email of valid) {
      const { error } = await supabase.rpc('create_or_reset_trip_invite', {
        p_trip_id: trip.id,
        p_invited_email: email,
        p_role: 'viewer'
      });
      if (error) throw error;
      sent.push(email);
    }
    state.invites = await fetchInviteSnapshots();
    renderTrips();
    renderHomeTrips();
    refreshNotificationBadge();
    if (els.detailSheet?.classList.contains('open')) openTripSheet(trip.id);
    showNotice(`ส่งคำเชิญแล้ว ${sent.length} อีเมล${notFound.length ? ` · ไม่พบ ${notFound.length} อีเมล` : ''}`);
  } catch (error) {
    showNotice(error.message || 'เชิญสมาชิกไม่สำเร็จ');
  }
}

async function refreshInviteUiAfterOwnerAction(tripId, message) {
  state.invites = await fetchInviteSnapshots();
  await loadLocalData();
  renderAll();
  if (tripId) openTripSheet(tripId);
  showNotice(message);
}

async function revokeTripInvite(inviteId, tripId) {
  if (!inviteId || !state.user || !supabase) return;
  const invite = (state.invites || []).find((item) => item.id === inviteId);
  if (!invite || invite.owner_id !== state.user.id) return;
  if (!confirm(`ลบคำเชิญของ ${invite.invited_email || 'ผู้ใช้นี้'} ออกจาก Trip นี้หรือไม่?`)) return;
  try {
    const { error } = await supabase.rpc('revoke_trip_invite', { p_invite_id: inviteId });
    if (error) throw error;
    await refreshInviteUiAfterOwnerAction(tripId || invite.trip_id, 'ลบผู้ได้รับเชิญออกจาก Trip แล้ว');
  } catch (error) {
    try {
      const { error: updateError } = await supabase
        .from('trip_invites')
        .update({ status: 'revoked', updated_at: nowIso() })
        .eq('id', inviteId)
        .eq('owner_id', state.user.id);
      if (updateError) throw updateError;
      await refreshInviteUiAfterOwnerAction(tripId || invite.trip_id, 'ลบคำเชิญแล้ว');
    } catch (fallbackError) {
      showNotice(fallbackError.message || error.message || 'ลบคำเชิญไม่สำเร็จ');
    }
  }
}

async function resetTripInviteToPending(inviteId, tripId) {
  if (!inviteId || !state.user || !supabase) return;
  const invite = (state.invites || []).find((item) => item.id === inviteId);
  if (!invite || invite.owner_id !== state.user.id) return;
  if (!confirm(`ตั้งคำเชิญของ ${invite.invited_email || 'ผู้ใช้นี้'} กลับเป็นรอตอบรับหรือไม่?`)) return;
  try {
    const { error } = await supabase.rpc('reset_trip_invite_pending', { p_invite_id: inviteId });
    if (error) throw error;
    await refreshInviteUiAfterOwnerAction(tripId || invite.trip_id, 'ตั้งคำเชิญกลับเป็นรอตอบรับแล้ว');
  } catch (error) {
    showNotice(error.message || 'ตั้งคำเชิญเป็นรอตอบรับไม่สำเร็จ');
  }
}

async function deleteTrip(id) {
  const trip = await db.get('trips', id);
  if (!trip) return;
  if (!confirm('ลบ Trip นี้หรือไม่? Memo ใน Trip จะถูกเก็บไว้แต่ไม่จัดกลุ่ม')) return;
  const now = nowIso();
  await db.put('trips', { ...trip, deleted_at: now, sync_status: 'pending', updated_at: now });
  await db.queueSync('delete_trip', 'trip', id);
  const memos = await db.getByIndex('memos', 'by_trip', id);
  for (const memo of memos) {
    await db.put('memos', { ...memo, trip_id: null, sync_status: 'pending', updated_at: now });
    await db.queueSync('upsert_memo', 'memo', memo.id);
  }
  await loadLocalData();
  renderAll();
  toast('ลบ Trip แล้ว และเก็บ Memo ไว้แบบไม่จัด Trip · เตรียมซิงก์อัตโนมัติ');
  scheduleAutoSync('trip-deleted', { delay: 1000 });
}

function renderTimeline() {
  syncTimelineFiltersFromInputs();
  const tripId = els.timelineTripFilter.value;
  const keyword = (state.timelineFilters.keyword || '').trim().toLowerCase();
  const trip = tripId ? tripById(tripId) : null;
  let memos = [...state.memos]
    .filter((memo) => !memo.deleted_at)
    .sort((a, b) => new Date(a.visited_at || a.created_at || 0) - new Date(b.visited_at || b.created_at || 0));
  if (tripId) memos = memos.filter((memo) => memo.trip_id === tripId);
  const timelineContextMemos = [...memos];

  if (keyword) memos = memos.filter((memo) => timelineMemoSearchText(memo).includes(keyword));
  memos = memos.filter(timelineMemoMatchesQuickFilter).filter(timelineMemoMatchesAdvancedFilters);

  updateTimelineFilterButtons();
  renderTimelineHero(memos, trip, timelineContextMemos);
  renderTimelineSearchSummary(memos, timelineContextMemos, trip);
  renderTimelineTagMoodOverview(memos);

  if (!memos.length) {
    const emptyTitle = trip ? 'ไม่พบ Story ใน Trip นี้' : 'ไม่พบ Story Timeline';
    const hint = timelineActiveFilterLabels(trip).length ? 'ลองล้างตัวกรอง หรือค้นหาจากชื่อเมือง ประเทศ แท็ก หรือ caption รูปอีกครั้ง' : 'เพิ่ม Memo พร้อมรูป พิกัด หรือบันทึกสั้น ๆ เพื่อให้ Timeline กลายเป็นเรื่องเล่าการเดินทาง';
    els.timelineList.innerHTML = `<div class="empty-state empty-action story-empty-state"><div class="empty-emoji icon-badge">${tmIcon('timeline')}</div><strong>${emptyTitle}</strong><span>${escapeHtml(hint)}</span><div class="empty-actions-row"><button class="ghost-button" type="button" data-timeline-summary-action="clear">${tmIcon('sync')}<span>ล้างตัวกรอง</span></button><button class="primary-button" type="button" data-open="add">${tmIcon('add-memo')}<span>เพิ่ม Memo</span></button></div></div>`;
    return;
  }

  const groups = new Map();
  for (const memo of memos) {
    const key = storyDateKey(memo.visited_at || memo.created_at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(memo);
  }

  const intro = trip ? `<section class="story-intro-card glass-card"><div><p class="eyebrow">เริ่มต้นเรื่องเล่า</p><h3>${escapeHtml(trip.title || 'Trip Story')}</h3><p>${escapeHtml(tripStoryIntroMeta(trip, timelineContextMemos))}</p></div><span>${tmIcon('plane')}</span></section>` : '';
  els.timelineList.innerHTML = intro + Array.from(groups.entries()).map(([dateKey, items], index) => {
    const labelTrip = trip || tripById(items[0]?.trip_id);
    const dayNo = labelTrip ? tripDayNumber(labelTrip, dateKey, index + 1) : index + 1;
    const dayLabel = labelTrip ? tripDateLabel(dateKey) : formatDate(dateKey, { dateStyle: 'full' });
    return `
      <article class="day-group story-timeline-group story-day-chapter" style="--story-index:${dayNo}">
        <div class="story-day-head">
          <div><span class="day-number">Day ${dayNo}</span><h3>${escapeHtml(dayLabel)}</h3></div>
          ${renderStoryDaySummary(items)}
        </div>
        <div class="day-items story-day-items story-chapter-list">${items.map((memo) => renderTimelineMemoStoryCard(memo)).join('')}</div>
      </article>
    `;
  }).join('');
}

async function loadGoogleMapsScript() {
  if (!GOOGLE_MAPS_API_KEY) return null;
  if (window.google?.maps) return window.google.maps;
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-google-maps="travel-memo"]');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.google.maps), { once: true });
      existing.addEventListener('error', reject, { once: true });
      return;
    }
    const script = document.createElement('script');
    script.dataset.googleMaps = 'travel-memo';
    script.async = true;
    script.defer = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GOOGLE_MAPS_API_KEY)}&libraries=marker`;
    script.onload = () => resolve(window.google.maps);
    script.onerror = () => reject(new Error('โหลด Google Maps ไม่สำเร็จ'));
    document.head.appendChild(script);
  });
}


async function useCurrentLocation(event) {
  event?.preventDefault?.();
  if (!('geolocation' in navigator)) {
    showNotice('อุปกรณ์นี้ไม่รองรับการใช้ตำแหน่งปัจจุบัน');
    return;
  }

  showNotice('กำลังอ่านตำแหน่งปัจจุบัน...');
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const lat = Number(position?.coords?.latitude);
      const lng = Number(position?.coords?.longitude);
      if (!isValidLatLng(lat, lng)) {
        showNotice('ไม่สามารถอ่านพิกัดจากอุปกรณ์ได้');
        return;
      }
      setFormLocation(lat, lng, 'current_location');
      showNotice('ใช้ตำแหน่งปัจจุบันแล้ว');
    },
    (error) => {
      console.warn('Current location unavailable', error);
      const message = error?.code === 1
        ? 'เบราว์เซอร์ยังไม่ได้รับสิทธิ์ใช้ตำแหน่ง'
        : 'ไม่สามารถอ่านตำแหน่งปัจจุบันได้ ลองเลือกจากแผนที่แทน';
      showNotice(message);
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 60000
    }
  );
}

function setFormLocation(lat, lng, source = 'map_picker') {
  els.latitude.value = Number(lat).toFixed(6);
  els.longitude.value = Number(lng).toFixed(6);
  state.memoLocationSource = source;
  renderSelectedPhotos();
  openView('add');
  toast(source === 'current_location' ? 'ใช้ตำแหน่งปัจจุบันแล้ว' : 'เลือกพิกัดจากแผนที่แล้ว · กลับไปบันทึก Memo ได้เลย');
}

function mapSearchTextForMemo(memo) {
  const trip = tripById(memo.trip_id);
  const photos = photosForMemo(memo.id);
  return [
    memo.title,
    memo.place_name,
    memo.city,
    memo.region,
    memo.country,
    memo.note,
    memo.diary,
    ...(memo.tags || []),
    memo.mood,
    trip?.title,
    ...photos.map((photo) => photo.caption).filter(Boolean)
  ].filter(Boolean).join(' ').toLowerCase();
}

function mapVisibleMemos() {
  const tripId = els.mapTripFilter?.value || '';
  const query = String(els.mapSearchInput?.value || '').trim().toLowerCase();
  const scope = els.mapScopeFilter?.value || 'all';
  return state.memos
    .filter((memo) => !memo.deleted_at && isValidLatLng(Number(memo.latitude), Number(memo.longitude)))
    .filter((memo) => !tripId || memo.trip_id === tripId)
    .filter((memo) => {
      if (scope === 'own') return memo.user_id === state.user?.id;
      if (scope === 'shared') return memo.user_id !== state.user?.id || memo.shared_access;
      if (scope === 'photo') return photosForMemo(memo.id).length > 0;
      return true;
    })
    .filter((memo) => !query || mapSearchTextForMemo(memo).includes(query))
    .sort((a, b) => new Date(a.visited_at || a.created_at || 0) - new Date(b.visited_at || b.created_at || 0));
}

function photoGpsPoint(photo) {
  const candidates = [
    [photo?.latitude, photo?.longitude, 'photo_latlng'],
    [photo?.exif_latitude, photo?.exif_longitude, 'exif_gps'],
    [photo?.metadata?.exif_latitude, photo?.metadata?.exif_longitude, 'metadata_exif'],
    [photo?.metadata?.gps?.latitude, photo?.metadata?.gps?.longitude, 'metadata_gps'],
    [photo?.metadata?.gps?.lat, photo?.metadata?.gps?.lng, 'metadata_gps'],
    [photo?.metadata?.latitude, photo?.metadata?.longitude, 'metadata_latlng']
  ];
  for (const [latRaw, lngRaw, source] of candidates) {
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (isValidLatLng(lat, lng)) return { lat, lng, source };
  }
  return null;
}

function photosForMemoWithGps(memoId, photos = state.photos) {
  return (photos || []).filter((photo) => photo.memo_id === memoId && !photo.deleted_at && photoGpsPoint(photo));
}

function memoHasLocation(memo) {
  return isValidLatLng(Number(memo?.latitude), Number(memo?.longitude));
}

function buildLocationRepairStats(memos = state.memos, photos = state.photos) {
  const activeMemos = (memos || []).filter((memo) => !memo.deleted_at);
  const activePhotos = (photos || []).filter((photo) => !photo.deleted_at);
  const photosByMemo = new Map();
  for (const photo of activePhotos) {
    if (!photo.memo_id) continue;
    if (!photosByMemo.has(photo.memo_id)) photosByMemo.set(photo.memo_id, []);
    photosByMemo.get(photo.memo_id).push(photo);
  }
  const missing = activeMemos.filter((memo) => !memoHasLocation(memo));
  const withLocation = activeMemos.length - missing.length;
  const photosWithGps = activePhotos.filter((photo) => photoGpsPoint(photo)).length;
  const repairable = missing.filter((memo) => (photosByMemo.get(memo.id) || []).some((photo) => photoGpsPoint(photo)));
  const ownRepairable = repairable.filter((memo) => memo.user_id === state.user?.id && !memo.shared_access);
  const sharedSkipped = repairable.length - ownRepairable.length;
  return { total: activeMemos.length, withLocation, missing: missing.length, photosWithGps, repairable: repairable.length, ownRepairable: ownRepairable.length, sharedSkipped };
}

function locationRepairReportText(stats = buildLocationRepairStats()) {
  return `Travel Memo ${APP_VERSION} Location Report\n` +
    `Memo ทั้งหมด: ${stats.total}\n` +
    `มีพิกัด: ${stats.withLocation}\n` +
    `ไม่มีพิกัด: ${stats.missing}\n` +
    `รูปที่มี EXIF/GPS: ${stats.photosWithGps}\n` +
    `ซ่อมได้จากรูป: ${stats.repairable}\n` +
    `ซ่อมได้และเป็นของบัญชีนี้: ${stats.ownRepairable}\n` +
    `ข้ามเพราะเป็น Shared/read-only: ${stats.sharedSkipped}`;
}

async function repairMemoLocationsFromPhotoGps() {
  if (!state.user?.id) return { fixed: 0, skippedShared: 0, repairable: 0 };
  const [memos, photos] = await Promise.all([
    db.getAll('memos').catch(() => []),
    db.getAll('photos').catch(() => [])
  ]);
  const photosByMemo = new Map();
  for (const photo of photos.filter((item) => !item.deleted_at)) {
    if (!photo.memo_id) continue;
    if (!photosByMemo.has(photo.memo_id)) photosByMemo.set(photo.memo_id, []);
    photosByMemo.get(photo.memo_id).push(photo);
  }
  let fixed = 0;
  let repairable = 0;
  let skippedShared = 0;
  for (const memo of memos.filter((item) => !item.deleted_at && !memoHasLocation(item))) {
    const gpsPhoto = (photosByMemo.get(memo.id) || []).find((photo) => photoGpsPoint(photo));
    const gps = photoGpsPoint(gpsPhoto);
    if (!gps) continue;
    repairable += 1;
    if (memo.user_id !== state.user.id || memo.shared_access) {
      skippedShared += 1;
      continue;
    }
    const next = {
      ...memo,
      latitude: gps.lat,
      longitude: gps.lng,
      location_source: gps.source,
      sync_status: 'pending',
      updated_at: nowIso()
    };
    await db.put('memos', next);
    await db.queueSync('upsert_memo', 'memo', memo.id, { user_id: memo.user_id || state.user.id, location_repair: true, source: gps.source });
    fixed += 1;
  }
  if (fixed) await loadLocalData();
  return { fixed, skippedShared, repairable };
}

function mapMemoThumb(memo) {
  const photo = photosForMemo(memo.id)[0];
  const img = photo ? renderPhotoImg(photo, { preferThumb: true, alt: photo.caption || memo.title || 'Travel photo' }) : '';
  return img ? `<div class="map-memo-thumb">${img}</div>` : `<div class="map-memo-thumb placeholder">${tmIcon('map')}</div>`;
}

function renderMapPopupContent(memo) {
  const trip = tripById(memo.trip_id);
  const photos = photosForMemo(memo.id);
  const title = memo.title || memo.place_name || 'Travel Memo';
  const place = [memo.place_name, memo.city, memo.country].filter(Boolean).join(' · ') || 'ไม่ระบุสถานที่';
  const photo = photos[0];
  const image = photo ? renderPhotoImg(photo, { preferThumb: true, alt: photo.caption || title }) : '';
  return `
    <article class="map-popup-card">
      ${image ? `<div class="map-popup-photo">${image}</div>` : ''}
      <div class="map-popup-body">
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(place)}</span>
        <small>${escapeHtml(formatDate(memo.visited_at, { numeric: true }))}${trip ? ` · ${escapeHtml(trip.title)}` : ''}</small>
        <button class="primary-button compact" type="button" data-map-action="open-memo" data-id="${escapeHtml(memo.id)}">${tmIcon('read')}<span>อ่าน Memo</span></button>
      </div>
    </article>`;
}

function mapRouteStatusMarkup(selectedTrip, memos) {
  if (!selectedTrip) return '';
  if (!memos.length) return `<div class="map-route-note warn">${tmIcon('map')}<span>Trip นี้ยังไม่มี Memo ที่มีพิกัด</span></div>`;
  if (memos.length === 1) return `<div class="map-route-note info">${tmIcon('location')}<span>Trip นี้มีจุดเดียว จึงยังไม่มีเส้นทางให้เล่น Route Replay</span></div>`;
  return `<div class="map-route-note">${tmIcon('route')}<span>เรียงเส้นทางตามวันและเวลา Memo · ${memos.length} จุด</span></div>`;
}

function renderMapSummary(memos) {
  if (!els.mapSummaryPanel) return;
  const tripCount = new Set(memos.map((memo) => memo.trip_id).filter(Boolean)).size;
  const places = [...new Set(memos.flatMap((memo) => [memo.city, memo.country]).filter(Boolean))];
  const photoCount = memos.reduce((sum, memo) => sum + photosForMemo(memo.id).length, 0);
  const selectedTrip = tripById(els.mapTripFilter?.value);
  els.mapSummaryPanel.innerHTML = `
    <div class="map-summary-head">
      <div><strong>${selectedTrip ? escapeHtml(selectedTrip.title) : 'Map Summary'}</strong><small>${selectedTrip ? 'Trip map mode' : 'ทุกความทรงจำที่มีพิกัด'}</small></div>
      ${memos.length ? `<button class="ghost-button compact" type="button" data-map-action="fit">${tmIcon('map')}<span>Fit</span></button>` : ''}
    </div>
    <div class="map-summary-grid">
      <article><strong>${memos.length}</strong><span>จุด</span></article>
      <article><strong>${tripCount}</strong><span>Trip</span></article>
      <article><strong>${photoCount}</strong><span>รูป</span></article>
      <article><strong>${places.length}</strong><span>จุดหมาย</span></article>
    </div>
    ${mapRouteStatusMarkup(selectedTrip, memos)}
    <div class="map-location-quality">
      ${(() => { const stats = buildLocationRepairStats(); return `${tmIcon('location')}<span>พิกัด Memo ${stats.withLocation}/${stats.total}</span>${stats.ownRepairable ? `<small>ซ่อมจากรูปได้ ${stats.ownRepairable}</small>` : `<small>รูปมี GPS ${stats.photosWithGps}</small>`}`; })()}
    </div>
  `;
}

function renderMapMemoList(memos) {
  if (!els.mapMemoList) return;
  if (!memos.length) {
    els.mapMemoList.innerHTML = `<div class="empty-state compact-empty">${tmIcon('map')}<strong>ยังไม่มี Memo ที่มีพิกัด</strong><span>เพิ่มพิกัดจาก Quick Capture, EXIF GPS หรือเลือกจากแผนที่</span></div>`;
    return;
  }
  els.mapMemoList.innerHTML = `
    <div class="map-list-head"><strong>Memo บนแผนที่</strong><small>${memos.length} รายการ</small></div>
    <div class="map-list-items">
      ${memos.slice(0, 48).map((memo, index) => {
        const trip = tripById(memo.trip_id);
        const place = [memo.place_name, memo.city, memo.country].filter(Boolean).join(' · ') || 'ไม่ระบุสถานที่';
        const spreadNote = '';
        return `<button class="map-memo-row" type="button" data-map-action="focus-memo" data-id="${escapeHtml(memo.id)}">
          ${mapMemoThumb(memo)}
          <span><strong>${index + 1}. ${escapeHtml(shortText(memo.title || memo.place_name || 'Travel Memo', 44))}</strong><small>${escapeHtml(place)}</small><small>${escapeHtml(formatDate(memo.visited_at, { numeric: true }))}${trip ? ` · ${escapeHtml(trip.title)}` : ''}</small>${spreadNote}</span>
        </button>`;
      }).join('')}
    </div>`;
}

function clearMapRouteLine() {
  if (state.mapProvider === 'google') {
    state.googleRouteLine?.setMap?.(null);
    state.googleRouteLine = null;
    return;
  }
  if (state.leafletRouteLine && state.map?.removeLayer) {
    state.map.removeLayer(state.leafletRouteLine);
    state.leafletRouteLine = null;
  }
}

function renderMapRouteLine(memos) {
  clearMapRouteLine();
  const selectedTrip = els.mapTripFilter?.value || '';
  const showRoute = els.mapRouteToggle?.checked !== false;
  if (!selectedTrip || !showRoute || memos.length < 2) return;
  const points = memos.map((memo) => ({ lat: Number(memo.latitude), lng: Number(memo.longitude) })).filter((point) => isValidLatLng(point.lat, point.lng));
  if (points.length < 2) return;
  if (state.mapProvider === 'google' && window.google?.maps) {
    state.googleRouteLine = new window.google.maps.Polyline({
      path: points,
      geodesic: true,
      strokeColor: '#0f766e',
      strokeOpacity: 0.72,
      strokeWeight: 4,
      map: state.map
    });
    return;
  }
  if (state.mapProvider === 'leaflet' && state.map) {
    state.leafletRouteLine = L.polyline(points.map((point) => [point.lat, point.lng]), { color: '#0f766e', weight: 4, opacity: 0.72, lineCap: 'round' }).addTo(state.map);
  }
}

function focusMapMemo(id) {
  const memo = state.memos.find((item) => item.id === id);
  if (!memo || !state.map || !isValidLatLng(memo.latitude, memo.longitude)) return;
  const lat = Number(memo.latitude);
  const lng = Number(memo.longitude);
  if (state.mapProvider === 'google') {
    state.map.panTo({ lat, lng });
    state.map.setZoom(Math.max(state.map.getZoom?.() || 5, 13));
    const marker = state.googleMarkers.find((item) => item.__memoId === id);
    if (marker?.__info) marker.__info.open({ anchor: marker, map: state.map });
  } else {
    state.map.setView([lat, lng], Math.max(state.map.getZoom?.() || 5, 13), { animate: true });
    state.markerLayer?.getLayers?.().forEach((layer) => {
      if (layer.__memoId === id && layer.openPopup) layer.openPopup();
    });
  }
}

function handleMapPanelAction(event) {
  const button = event.target.closest?.('[data-map-action]');
  if (!button) return;
  const action = button.dataset.mapAction;
  const id = button.dataset.id;
  if (!['open-memo','focus-memo','focus-photo','fit','replay-play','replay-prev','replay-next','replay-reset'].includes(action)) return;
  event.preventDefault();
  event.stopPropagation();
  if (action === 'open-memo') openMemoSheet(id);
  if (action === 'focus-memo') focusMapMemo(id);
  if (action === 'focus-photo') focusMapPhoto(id);
  if (action === 'fit') fitMapToMarkers(true);
  if (action === 'replay-play') playRouteReplay();
  if (action === 'replay-prev') stepRouteReplay(-1);
  if (action === 'replay-next') stepRouteReplay(1);
  if (action === 'replay-reset') resetRouteReplayPlayback();
}

function initMap() {
  if (state.map) return;
  if (GOOGLE_MAPS_API_KEY) {
    state.mapProvider = 'google';
    loadGoogleMapsScript()
      .then(() => initGoogleMap())
      .catch((error) => {
        console.warn(error);
        state.mapProvider = 'leaflet';
        initLeafletMap();
        showNotice('Google Maps โหลดไม่สำเร็จ ใช้แผนที่สำรอง OpenStreetMap');
      });
    return;
  }
  state.mapProvider = 'leaflet';
  initLeafletMap();
}

function initLeafletMap() {
  if (state.map) return;
  state.map = L.map(els.map, { zoomControl: true }).setView([13.7563, 100.5018], 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(state.map);
  state.markerLayer = L.layerGroup().addTo(state.map);
  state.photoMarkerLayer = L.layerGroup().addTo(state.map);
  state.map.on('click', (event) => setFormLocation(event.latlng.lat, event.latlng.lng));
  renderMapMarkers();
}

function initGoogleMap() {
  if (state.map) return;
  const center = { lat: 13.7563, lng: 100.5018 };
  state.map = new window.google.maps.Map(els.map, {
    center,
    zoom: 5,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    gestureHandling: 'greedy'
  });
  state.map.addListener('click', (event) => setFormLocation(event.latLng.lat(), event.latLng.lng()));
  renderMapMarkers();
}


function resetRouteReplayState() {
  state.routeReplayIndex = 0;
  state.routeReplayPlaying = false;
  state.routeReplayMemos = [];
  clearRouteReplayMarker();
}

function clearRouteReplayMarker() {
  if (state.googleReplayMarker?.setMap) state.googleReplayMarker.setMap(null);
  state.googleReplayMarker = null;
  if (state.leafletReplayMarker && state.map?.removeLayer) state.map.removeLayer(state.leafletReplayMarker);
  state.leafletReplayMarker = null;
  document.querySelectorAll('.map-memo-row.replay-active').forEach((node) => node.classList.remove('replay-active'));
}

function stopRouteReplay(updateUi = true) {
  if (state.routeReplayTimer) clearInterval(state.routeReplayTimer);
  state.routeReplayTimer = null;
  state.routeReplayPlaying = false;
  if (updateUi) updateMapReplayButtons();
}

function currentReplayMemos(memos = mapVisibleMemos()) {
  const selectedTrip = els.mapTripFilter?.value || '';
  if (!selectedTrip) return [];
  return memos
    .filter((memo) => memo.trip_id === selectedTrip && isValidLatLng(memo.latitude, memo.longitude))
    .sort((a, b) => new Date(a.visited_at || a.created_at || 0) - new Date(b.visited_at || b.created_at || 0));
}

function renderMapReplayPanel(memos) {
  const replayMemos = currentReplayMemos(memos);
  state.routeReplayMemos = replayMemos;
  if (!els.mapReplayPanel) return;
  const enabled = replayMemos.length >= 2;
  els.mapReplayPanel.classList.toggle('disabled', !enabled);
  if (els.mapReplayStatus) {
    const selectedTrip = tripById(els.mapTripFilter?.value);
    els.mapReplayStatus.textContent = enabled
      ? `${selectedTrip?.title || 'Trip'} · ${replayMemos.length} จุด · เล่นตามวันและเวลา Memo`
      : 'เลือก Trip ที่มีอย่างน้อย 2 จุดเพื่อเล่นเส้นทาง';
  }
  if (!enabled) {
    stopRouteReplay(false);
    clearRouteReplayMarker();
    state.routeReplayIndex = 0;
  } else if (state.routeReplayIndex >= replayMemos.length) {
    state.routeReplayIndex = 0;
  }
  updateMapReplayButtons();
}

function updateMapReplayButtons() {
  const enabled = (state.routeReplayMemos || []).length >= 2;
  [els.mapReplayPrevButton, els.mapReplayPlayButton, els.mapReplayNextButton, els.mapReplayResetButton].forEach((button) => {
    if (button) button.disabled = !enabled;
  });
  if (els.mapReplayPlayButton) els.mapReplayPlayButton.innerHTML = state.routeReplayPlaying ? `${tmIcon('sync')}<span>พัก</span>` : `${tmIcon('plane')}<span>เล่น</span>`;
  if (enabled && els.mapReplayStatus) {
    const memo = state.routeReplayMemos[state.routeReplayIndex];
    if (memo) {
      const place = [memo.place_name, memo.city, memo.country].filter(Boolean).join(' · ') || memo.title || 'Travel Memo';
      els.mapReplayStatus.textContent = `${state.routeReplayIndex + 1}/${state.routeReplayMemos.length} · ${shortText(place, 42)} · ${formatDate(memo.visited_at || memo.created_at, { numeric: true })}`;
    }
  }
}

function showRouteReplayStep(index = state.routeReplayIndex, options = {}) {
  const replayMemos = state.routeReplayMemos || [];
  if (!replayMemos.length || !state.map) return;
  const safeIndex = Math.min(Math.max(Number(index || 0), 0), replayMemos.length - 1);
  state.routeReplayIndex = safeIndex;
  const memo = replayMemos[safeIndex];
  if (!memo || !isValidLatLng(memo.latitude, memo.longitude)) return;
  clearRouteReplayMarker();
  const lat = Number(memo.latitude);
  const lng = Number(memo.longitude);
  if (state.mapProvider === 'google' && window.google?.maps) {
    state.googleReplayMarker = new window.google.maps.Marker({
      position: { lat, lng },
      map: state.map,
      title: memo.title || memo.place_name || 'Replay point',
      label: `${safeIndex + 1}`,
      zIndex: 9999
    });
    state.map.panTo({ lat, lng });
    state.map.setZoom(Math.max(state.map.getZoom?.() || 5, 11));
    const marker = state.googleMarkers.find((item) => item.__memoId === memo.id);
    if (marker?.__info) marker.__info.open({ anchor: marker, map: state.map });
  } else {
    state.leafletReplayMarker = L.circleMarker([lat, lng], {
      radius: 13,
      color: '#0f766e',
      weight: 3,
      fillColor: '#5eead4',
      fillOpacity: 0.45,
      className: 'map-replay-pulse'
    }).addTo(state.map);
    state.map.setView([lat, lng], Math.max(state.map.getZoom?.() || 5, 11), { animate: true });
    state.markerLayer?.getLayers?.().forEach((layer) => {
      if (layer.__memoId === memo.id && layer.openPopup && options.openPopup !== false) layer.openPopup();
    });
  }
  const row = document.querySelector(`.map-memo-row[data-id="${CSS.escape(String(memo.id))}"]`);
  if (row) {
    row.classList.add('replay-active');
    row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  updateMapReplayButtons();
}

function playRouteReplay() {
  const replayMemos = state.routeReplayMemos || [];
  if (replayMemos.length < 2) return;
  if (state.routeReplayPlaying) {
    stopRouteReplay(true);
    return;
  }
  state.routeReplayPlaying = true;
  showRouteReplayStep(state.routeReplayIndex);
  state.routeReplayTimer = setInterval(() => {
    if (state.routeReplayIndex >= replayMemos.length - 1) {
      stopRouteReplay(true);
      return;
    }
    showRouteReplayStep(state.routeReplayIndex + 1);
  }, 1800);
  updateMapReplayButtons();
}

function stepRouteReplay(delta) {
  const replayMemos = state.routeReplayMemos || [];
  if (replayMemos.length < 2) return;
  stopRouteReplay(false);
  const next = Math.min(Math.max(state.routeReplayIndex + delta, 0), replayMemos.length - 1);
  showRouteReplayStep(next);
}

function resetRouteReplayPlayback() {
  stopRouteReplay(false);
  state.routeReplayIndex = 0;
  showRouteReplayStep(0, { openPopup: false });
}

function mapVisiblePhotoPoints(memos = mapVisibleMemos()) {
  const memoIds = new Set(memos.map((memo) => memo.id));
  const memoById = new Map(memos.map((memo) => [memo.id, memo]));
  return (state.photos || [])
    .map((photo, index) => {
      const memo = memoById.get(photo.memo_id);
      const gps = photoGpsPoint(photo);
      if (!memo || !gps || !isValidLatLng(gps.lat, gps.lng)) return null;
      return { photo, memo, gps, index };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.memo.visited_at || a.memo.created_at || 0) - new Date(b.memo.visited_at || b.memo.created_at || 0) || Number(a.photo.sort_order || 0) - Number(b.photo.sort_order || 0));
}

function memoPhotoLocationSpread(memo) {
  const memoPhotos = photosForMemo(memo.id)
    .map((photo) => ({ photo, gps: photoGpsPoint(photo) }))
    .filter((item) => item.gps && isValidLatLng(item.gps.lat, item.gps.lng));
  if (memoPhotos.length < 2) return { count: memoPhotos.length, maxDistance: 0, farFromMemo: 0 };
  let maxDistance = 0;
  for (let i = 0; i < memoPhotos.length; i += 1) {
    for (let j = i + 1; j < memoPhotos.length; j += 1) {
      const d = distanceMeters(memoPhotos[i].gps.lat, memoPhotos[i].gps.lng, memoPhotos[j].gps.lat, memoPhotos[j].gps.lng) || 0;
      maxDistance = Math.max(maxDistance, d);
    }
  }
  const farFromMemo = isValidLatLng(memo.latitude, memo.longitude)
    ? memoPhotos.filter(({ gps }) => (distanceMeters(memo.latitude, memo.longitude, gps.lat, gps.lng) || 0) > 300).length
    : 0;
  return { count: memoPhotos.length, maxDistance, farFromMemo };
}

function photoClusterSummary(memos = mapVisibleMemos()) {
  return memos
    .map((memo) => ({ memo, spread: memoPhotoLocationSpread(memo) }))
    .filter(({ spread }) => spread.count >= 2 && spread.maxDistance > 300);
}

function clearMapPhotoMarkers() {
  state.googlePhotoMarkers = [];
  state.photoMarkerLayer?.clearLayers?.();
}

function clearMapPhotoRouteLine() {
  if (state.mapProvider === 'google') {
    state.googlePhotoRouteLine?.setMap?.(null);
    state.googlePhotoRouteLine = null;
    return;
  }
  if (state.leafletPhotoRouteLine && state.map?.removeLayer) {
    state.map.removeLayer(state.leafletPhotoRouteLine);
    state.leafletPhotoRouteLine = null;
  }
}

function renderMapMarkers() {
  if (!state.map) return;
  const memos = mapVisibleMemos();
  renderMapSummary(memos);
  renderMapReplayPanel(memos);
  renderMapMemoList(memos);
  if (state.mapProvider === 'google') {
    state.googleMarkers.forEach((marker) => marker.setMap(null));
    state.googleMarkers = [];
    clearMapPhotoMarkers();
    clearMapPhotoRouteLine();
    for (const memo of memos) {
      const marker = new window.google.maps.Marker({
        position: { lat: Number(memo.latitude), lng: Number(memo.longitude) },
        map: state.map,
        title: memo.title || memo.place_name || 'Travel Memo'
      });
      const info = new window.google.maps.InfoWindow({ content: renderMapPopupContent(memo) });
      marker.__memoId = memo.id;
      marker.__info = info;
      marker.addListener('click', () => info.open({ anchor: marker, map: state.map }));
      state.googleMarkers.push(marker);
    }
    renderMapRouteLine(memos);
    return;
  }
  if (!state.markerLayer) return;
  state.markerLayer.clearLayers();
  clearMapPhotoMarkers();
  clearMapPhotoRouteLine();
  for (const memo of memos) {
    const marker = L.marker([Number(memo.latitude), Number(memo.longitude)]);
    marker.__memoId = memo.id;
    marker.bindPopup(renderMapPopupContent(memo), { maxWidth: 280, className: 'travel-memo-map-popup' });
    marker.addTo(state.markerLayer);
  }
  renderMapRouteLine(memos);
}

function fitMapToMarkers(force = false) {
  if (!state.map) return;
  const memos = mapVisibleMemos();
  if (!memos.length) {
    if (force) toast('ยังไม่มี Memo ที่มีพิกัดตามตัวกรองนี้');
    return;
  }
  if (state.mapProvider === 'google') {
    const bounds = new window.google.maps.LatLngBounds();
    memos.forEach((memo) => bounds.extend({ lat: Number(memo.latitude), lng: Number(memo.longitude) }));
    state.map.fitBounds(bounds);
    return;
  }
  const points = memos.map((memo) => [Number(memo.latitude), Number(memo.longitude)]);
  if (points.length === 1) {
    state.map.setView(points[0], 13);
    return;
  }
  const bounds = L.latLngBounds(points);
  state.map.fitBounds(bounds.pad(0.18));
}

async function runSync({ includePull = false, silent = false, force = false } = {}) {
  if (state.isSyncing && !force) {
    if (!silent) toast('กำลังซิงก์อยู่ กรุณารอสักครู่');
    return { ok: false, total: 0, errors: [{ error: new Error('sync in progress') }] };
  }
  if (force && state.isSyncing) state.isSyncing = false;
  if (!isSupabaseConfigured) {
    if (!silent) toast('ยังไม่ได้ตั้งค่า Supabase');
    return;
  }
  if (!state.user) {
    if (!silent) toast('กรุณาเข้าสู่ระบบก่อนซิงก์');
    return;
  }
  state.isSyncing = true;
  setButtonBusy(els.syncAllButton, true, includePull ? 'ซิงก์และดึง Cloud...' : 'กำลังซิงก์...');
  if (els.syncNowButton) setButtonBusy(els.syncNowButton, true, 'กำลังซิงก์...');
  setSyncStatusUi('กำลังส่งข้อมูลค้างขึ้น Cloud...', { tone: 'syncing' });
  if (els.syncProgress) els.syncProgress.style.width = '4%';
  try {
    const cleanup = await cleanupSyncQueueForUser(state.user.id).catch(() => ({ removed: 0 }));
    if (cleanup.removed && !silent) toast(`ล้างคิวเก่า ${cleanup.removed} รายการก่อนซิงก์`);
    const result = await syncNow(({ done, total, message }) => {
      const progressText = total ? `${message || 'กำลังซิงก์'} · ${done}/${total}` : (message || 'กำลังซิงก์');
      setSyncStatusUi(progressText, { tone: 'syncing' });
      if (els.syncProgress) els.syncProgress.style.width = total ? `${Math.max(6, Math.round((done / total) * 100))}%` : '100%';
    });
    if (includePull) await pullCloudData(true);
    await loadLocalData();
    state.lastAutoSyncAt = nowIso();
    renderAll();
    if (els.syncProgress) els.syncProgress.style.width = '100%';
    if (!silent) toast(result.ok ? 'ซิงก์สำเร็จ · ข้อมูลบน Cloud ล่าสุดแล้ว' : `ซิงก์บางรายการไม่สำเร็จ ${result.errors.length} รายการ`);
  } catch (error) {
    if (!silent) toast(error.message || 'ซิงก์ไม่สำเร็จ');
  } finally {
    state.isSyncing = false;
    setButtonBusy(els.syncAllButton, false);
    if (els.syncNowButton) setButtonBusy(els.syncNowButton, false);
    updateAutoSyncStatus();
    setTimeout(() => { if (els.syncProgress) els.syncProgress.style.width = '0'; }, 700);
  }
}

function scheduleAutoSync(reason = 'auto', options = {}) {
  const delay = options.delay ?? 1500;
  if (!isSupabaseConfigured || !state.user || navigator.onLine === false) {
    updateAutoSyncStatus();
    return;
  }
  if (state.autoSyncTimer) clearTimeout(state.autoSyncTimer);
  state.autoSyncTimer = setTimeout(async () => {
    state.autoSyncTimer = null;
    if (!state.syncQueue.length) {
      await queueAllPending().catch(() => {});
      await loadLocalData();
      renderSummary();
    }
    if (!state.syncQueue.length || state.isSyncing) {
      updateAutoSyncStatus();
      return;
    }
    updateAutoSyncStatus(`Auto Sync: ${reason}`);
    await runSync({ includePull: false, silent: true });
  }, delay);
  updateAutoSyncStatus('รอซิงก์อัตโนมัติ');
}

function formatClock(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}

function currentSyncStatusText(customText = '') {
  if (customText) return customText;
  if (!isSupabaseConfigured) return 'Local only';
  if (!state.user) return 'รอ Login';
  if (navigator.onLine === false) return `Offline · รอซิงก์ ${state.syncQueue.length}`;
  if (state.cloudPullInProgress) return 'กำลังดึงข้อมูลล่าสุดจาก Cloud...';
  if (state.isSyncing) return 'กำลังส่งข้อมูลค้างขึ้น Cloud...';
  if (state.syncQueue.length) return `มีข้อมูลรอซิงก์ ${state.syncQueue.length} รายการ`;
  if (state.lastCloudPullAt) return `อัปเดตล่าสุด ${formatClock(state.lastCloudPullAt)}`;
  if (state.lastAutoSyncAt) return `ซิงก์ล่าสุด ${formatClock(state.lastAutoSyncAt)}`;
  return 'พร้อมอัปเดตข้อมูลอัตโนมัติ';
}

function updateAutoSyncStatus(customText = '') {
  const text = currentSyncStatusText(customText);
  const tone = syncTone();
  setSyncStatusUi(text, { tone });
  const profileStatus = document.getElementById('profileSyncStatusText');
  if (profileStatus) {
    profileStatus.textContent = text;
    profileStatus.classList.remove('ready', 'pending', 'syncing', 'offline', 'error', 'neutral');
    profileStatus.classList.add(tone);
    profileStatus.classList.toggle('pending', ['pending', 'syncing', 'error', 'offline'].includes(tone));
  }
}


function setupAutoCloudRefresh() {
  if (state.autoPullTimer) {
    clearInterval(state.autoPullTimer);
    state.autoPullTimer = null;
  }
  if (!isSupabaseConfigured || !state.user) return;
  state.autoPullTimer = setInterval(() => {
    scheduleAutoCloudPull('interval', 0);
  }, 60000);
}

function scheduleAutoCloudPull(reason = 'auto', delay = 2000) {
  if (!isSupabaseConfigured || !state.user || navigator.onLine === false || document.hidden) return;
  if (state.cloudPullInProgress || state.inviteActionInProgress) return;
  setTimeout(async () => {
    if (!state.user || state.cloudPullInProgress || state.inviteActionInProgress || navigator.onLine === false || document.hidden) return;
    try {
      await pullCloudData(true);
      updateAutoSyncStatus(reason === 'interval' ? 'อัปเดต Cloud อัตโนมัติแล้ว' : `อัปเดต Cloud: ${reason}`);
    } catch (error) {
      console.warn('auto cloud pull skipped', error);
    }
  }, delay);
}

async function pullCloudData(silent = false) {
  if (state.cloudPullInProgress) return { skipped: true, trips: 0, memos: 0, photos: 0 };
  const activeButton = document.activeElement?.id === 'pullCloudButton' ? els.pullCloudButton : null;
  const button = silent ? null : (activeButton || els.pullCloudButton || els.syncAllButton);
  state.cloudPullInProgress = true;
  updateAutoSyncStatus('กำลังดึงข้อมูลล่าสุดจาก Cloud...');
  if (!silent) {
    showNotice('กำลังดึงข้อมูลจาก Cloud...');
    if (els.syncStatusText) els.syncStatusText.textContent = 'กำลังดึงข้อมูลจาก Cloud...';
  }
  if (button && !silent) setButtonBusy(button, true, 'กำลังดึงข้อมูล...');
  try {
    const result = await pullFromCloud(({ message }) => {
      if (els.syncStatusText) els.syncStatusText.textContent = message;
      if (!silent && message) showNotice(message);
    });
    await loadLocalData();
    state.lastCloudPullAt = nowIso();
    renderAll();
    if (els.syncStatusText) els.syncStatusText.textContent = `ดึง Cloud แล้ว: ${result.trips} Trip, ${result.memos} Memo, ${result.photos} รูป`;
    if (!silent) toast(`ดึง Cloud แล้ว: ${result.trips} Trip, ${result.memos} Memo, ${result.photos} รูป`);
    return result;
  } catch (error) {
    logClientError('pull_cloud_failed', error);
    if (els.syncStatusText) els.syncStatusText.textContent = error.message || 'ดึงข้อมูลจาก Cloud ไม่สำเร็จ';
    if (!silent) toast(error.message || 'ดึงข้อมูลจาก Cloud ไม่สำเร็จ');
    throw error;
  } finally {
    state.cloudPullInProgress = false;
    if (button && !silent) setButtonBusy(button, false);
  }
}

function renderSettings() {
  els.supabaseConfigStatus.innerHTML = isSupabaseConfigured
    ? `เชื่อมต่อ Supabase แล้ว${state.user ? ` · ${escapeHtml(state.user.email || '')}` : ' · กรุณาเข้าสู่ระบบ'}`
    : 'ยังไม่ได้ตั้งค่า Supabase URL / Anon Key';
  els.openAdminButton.classList.toggle('hidden', state.profile?.role !== 'admin');
}

async function updateStorageEstimate() {
  const estimate = await db.estimateStorage();
  if (!estimate) {
    els.storageEstimate.textContent = 'Browser นี้ยังไม่รองรับ Storage Estimate API';
    return;
  }
  els.storageEstimate.textContent = `ใช้ไปประมาณ ${bytesToSize(estimate.usage || 0)} จาก quota ${bytesToSize(estimate.quota || 0)}`;
}

async function requestPersistentStorage() {
  const ok = await db.requestPersistentStorage();
  toast(ok ? 'Browser อนุญาตให้เก็บข้อมูลแบบ persistent แล้ว' : 'Browser ยังไม่ให้สิทธิ์ persistent storage');
  updateStorageEstimate();
}

async function exportBackup() {
  const [trips, memos, photos] = await Promise.all([
    db.getAll('trips'),
    db.getAll('memos'),
    db.getAll('photos')
  ]);
  toast('กำลังเตรียมไฟล์สำรอง...');
  const exportPhotos = [];
  for (const photo of photos) {
    exportPhotos.push({
      ...photo,
      blobData: photo.blob ? await blobToDataUrl(photo.blob) : null,
      thumbData: photo.thumbBlob ? await blobToDataUrl(photo.thumbBlob) : null,
      blob: undefined,
      thumbBlob: undefined
    });
  }
  const payload = {
    schema_version: 'travel-memo-v2',
    exported_at: nowIso(),
    trips,
    memos,
    photos: exportPhotos
  };
  downloadFile(`travel-memo-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2));
  toast('ส่งออก JSON แล้ว');
}

async function importBackup(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    if (payload.schema_version !== 'travel-memo-v2') throw new Error('ไฟล์นี้ไม่ใช่ backup v2');
    await db.putMany('trips', payload.trips || []);
    await db.putMany('memos', payload.memos || []);
    const photos = [];
    for (const photo of payload.photos || []) {
      const blob = photo.blobData ? await (await fetch(photo.blobData)).blob() : null;
      const thumbBlob = photo.thumbData ? await (await fetch(photo.thumbData)).blob() : null;
      photos.push({ ...photo, blob, thumbBlob, blobData: undefined, thumbData: undefined });
    }
    await db.putMany('photos', photos);
    await queueAllPending();
    await loadLocalData();
    state.lastCloudPullAt = nowIso();
    renderAll();
    toast('นำเข้า backup แล้ว');
  } catch (error) {
    toast(error.message || 'นำเข้า backup ไม่สำเร็จ');
  } finally {
    event.target.value = '';
  }
}

async function migrateLegacyLocalStorage() {
  const rawEntries = localStorage.getItem('travelMemo.entries.v1');
  const rawTrips = localStorage.getItem('travelMemo.trips.v1.2');
  if (!rawEntries && !rawTrips) {
    toast('ไม่พบข้อมูล v1.2 ใน localStorage ของ browser นี้');
    return;
  }
  if (!confirm('ย้ายข้อมูลจาก v1.2 เข้า IndexedDB หรือไม่? ข้อมูลเดิมจะยังอยู่ใน localStorage')) return;
  try {
    const legacyTrips = rawTrips ? JSON.parse(rawTrips) : [];
    const legacyEntries = rawEntries ? JSON.parse(rawEntries) : [];
    const now = nowIso();
    const tripMap = new Map();

    for (const legacy of legacyTrips) {
      const trip = {
        id: legacy.id || uid(),
        user_id: state.user?.id || null,
        title: legacy.name || legacy.title || 'Untitled Trip',
        description: legacy.notes || '',
        start_date: legacy.startDate || null,
        end_date: legacy.endDate || null,
        country: legacy.country || '',
        city: legacy.city || '',
        status: legacy.status || 'done',
        theme: legacy.theme || '',
        is_public: false,
        visibility: 'private',
        cover_photo_id: null,
        sync_status: 'pending',
        created_at: legacy.createdAt || now,
        updated_at: legacy.updatedAt || now,
        deleted_at: null
      };
      tripMap.set(legacy.id, trip.id);
      await db.put('trips', trip);
      await db.queueSync('upsert_trip', 'trip', trip.id);
    }

    for (const legacy of legacyEntries) {
      let tripId = legacy.tripId ? tripMap.get(legacy.tripId) || legacy.tripId : null;
      if (!tripId && legacy.trip) {
        const existing = [...tripMap.values()].map((id) => state.trips.find((trip) => trip.id === id)).find((trip) => trip?.title === legacy.trip);
        if (existing) tripId = existing.id;
      }
      const memoId = legacy.id || uid();
      const memo = {
        id: memoId,
        user_id: state.user?.id || null,
        trip_id: tripId,
        title: legacy.title || legacy.place || legacy.city || 'Travel Memo',
        place_name: legacy.place || '',
        note: legacy.story || '',
        diary: legacy.notes || '',
        mood: 'happy',
        rating: Number(legacy.rating || 5),
        visited_at: legacy.date ? new Date(`${legacy.date}T12:00:00`).toISOString() : now,
        latitude: Number.isFinite(Number(legacy.lat)) ? Number(legacy.lat) : null,
        longitude: Number.isFinite(Number(legacy.lng)) ? Number(legacy.lng) : null,
        country: legacy.country || '',
        region: legacy.province || '',
        city: legacy.city || '',
        tags: Array.isArray(legacy.tags) ? legacy.tags : parseTags(legacy.tags),
        is_public: false,
        visibility: 'private',
        sync_status: 'pending',
        created_at: legacy.createdAt || now,
        updated_at: legacy.updatedAt || now,
        deleted_at: null
      };
      await db.put('memos', memo);
      await db.queueSync('upsert_memo', 'memo', memo.id);
      for (const legacyPhoto of legacy.photos || []) {
        const photo = await normalizePhotoImport(legacyPhoto, memo.id, tripId);
        if (photo) {
          await db.put('photos', photo);
          await db.queueSync('upsert_photo', 'photo', photo.id);
        }
      }
    }
    await loadLocalData();
    state.lastCloudPullAt = nowIso();
    renderAll();
    toast(`ย้ายข้อมูลแล้ว: ${legacyTrips.length} Trip, ${legacyEntries.length} Memo`);
  } catch (error) {
    toast(error.message || 'ย้ายข้อมูลไม่สำเร็จ');
  }
}

async function clearLocalData() {
  if (!confirm('ล้างข้อมูลทั้งหมดในเครื่องนี้หรือไม่? ควรส่งออก JSON ก่อน')) return;
  await db.clearAllData();
  state.selectedPhotos = [];
  await loadLocalData();
  renderAll();
  toast('ล้างข้อมูลในเครื่องแล้ว');
}

function adminStatCard(icon, label, value, hint = '') {
  return `<article class="admin-card admin-overview-card"><span class="admin-card-icon">${tmIcon(icon)}</span><div><small>${escapeHtml(label)}</small><strong>${escapeHtml(String(value))}</strong>${hint ? `<em>${escapeHtml(hint)}</em>` : ''}</div></article>`;
}

function healthPill(label, ok, message = '') {
  return `<div class="admin-health-item ${ok ? 'ok' : 'warn'}"><strong>${ok ? tmIcon('check-in') : tmIcon('diagnostics')}<span>${escapeHtml(label)}</span></strong><small>${escapeHtml(message || (ok ? 'พร้อมใช้งาน' : 'ควรตรวจสอบ'))}</small></div>`;
}

function queueTypeSummary(queue = []) {
  const byStatus = queue.reduce((acc, item) => {
    const status = item.last_error ? 'failed' : (item.status || 'pending');
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  return { pending: byStatus.pending || 0, syncing: byStatus.syncing || 0, retrying: byStatus.retrying || 0, failed: byStatus.failed || 0, total: queue.length };
}

function adminHealthSummaryPanel({ queueSummary, schemaMissing, orphanPhotos, missingPathPhotos, locationStats, storage, photoBytes }) {
  const issues = [];
  if (!isSupabaseConfigured) issues.push('ยังไม่ได้ตั้งค่า Supabase env');
  if (schemaMissing.length) issues.push(`Schema photos ต้องตรวจ ${schemaMissing.length} รายการ`);
  if (queueSummary.failed) issues.push(`Queue ล้มเหลว ${queueSummary.failed} รายการ`);
  if (missingPathPhotos) issues.push(`รูปไม่มี path ${missingPathPhotos} รายการ`);
  if (orphanPhotos) issues.push(`รูปไม่มี parent ${orphanPhotos} รายการ`);
  if (locationStats.ownRepairable) issues.push(`Memo ซ่อม GPS ได้ ${locationStats.ownRepairable} รายการ`);
  const tone = issues.length ? 'warn' : 'ok';
  return `<article class="admin-card span-4 admin-production-health ${tone}">
    <div>
      <h3>${tmIcon(tone === 'ok' ? 'cloud-sync' : 'diagnostics')}<span>Production Health</span></h3>
      <p>${tone === 'ok' ? 'ระบบหลักพร้อมใช้งาน ไม่มีปัญหาสำคัญใน queue, schema, photo และ location' : 'ยังมีรายการที่ควรตรวจ แต่ระบบยังใช้งานต่อได้'}</p>
    </div>
    <div class="admin-production-health-grid">
      <span><strong>${queueSummary.failed}</strong><small>Queue failed</small></span>
      <span><strong>${schemaMissing.length}</strong><small>Schema warning</small></span>
      <span><strong>${missingPathPhotos}</strong><small>Photo path</small></span>
      <span><strong>${storage?.usage ? bytesToSize(storage.usage) : '-'}</strong><small>Local storage</small></span>
    </div>
    ${issues.length ? `<details class="admin-compact-details admin-health-issues" open><summary>${tmIcon('diagnostics')}<span>รายการที่ควรตรวจ</span></summary><ul>${issues.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></details>` : `<div class="admin-ok-line">${tmIcon('check-in')}<span>พร้อมใช้งานจริง · รูป ${bytesToSize(photoBytes)} · พิกัด Memo ${locationStats.withLocation}/${locationStats.total}</span></div>`}
  </article>`;
}

function tripOwnerLabel(userId, profiles = []) {
  const profile = profiles.find((item) => item.id === userId);
  return profile?.display_name || profile?.email || userId || '-';
}


function adminUserActivity(profile, stats) {
  const rows = [
    ...(stats.trips || []).filter((item) => item.user_id === profile.id),
    ...(stats.memos || []).filter((item) => item.user_id === profile.id),
    ...(stats.photos || []).filter((item) => item.user_id === profile.id)
  ];
  const latest = rows
    .map((item) => new Date(item.updated_at || item.created_at || 0).getTime())
    .filter((time) => Number.isFinite(time) && time > 0)
    .sort((a, b) => b - a)[0];
  return latest ? formatDate(new Date(latest).toISOString(), { numeric: true, timeStyle: 'short' }) : 'ยังไม่มี activity';
}

function adminUserCounts(userId, stats) {
  const countOwned = (rows) => (rows || []).filter((item) => item.user_id === userId && !item.deleted_at).length;
  return {
    trips: countOwned(stats.trips),
    memos: countOwned(stats.memos),
    photos: countOwned(stats.photos)
  };
}

function adminFilteredProfiles(stats) {
  const keyword = String(state.adminUserSearch || '').trim().toLowerCase();
  const roleFilter = state.adminRoleFilter || 'all';
  return [...(stats.profiles || [])]
    .filter((profile) => {
      if (roleFilter !== 'all' && String(profile.role || 'user') !== roleFilter) return false;
      if (!keyword) return true;
      return [profile.email, profile.display_name, profile.id, profile.role].join(' ').toLowerCase().includes(keyword);
    })
    .sort((a, b) => {
      const roleOrder = String(b.role || 'user').localeCompare(String(a.role || 'user'));
      if (roleOrder) return roleOrder;
      return String(a.email || a.display_name || '').localeCompare(String(b.email || b.display_name || ''));
    });
}

function adminUserManagementRows(stats) {
  const rows = adminFilteredProfiles(stats);
  const visible = rows.slice(0, 18);
  if (!visible.length) return '<div class="empty-state compact-empty">ไม่พบผู้ใช้ตามเงื่อนไข</div>';
  return `${visible.map((profile) => {
    const counts = adminUserCounts(profile.id, stats);
    const role = profile.role || 'user';
    const isSelf = profile.id === state.user?.id;
    return `
      <div class="admin-row admin-user-row">
        <div class="admin-user-main">
          ${avatarMarkup(profile, profile.email || profile.display_name || 'U', 'invite-avatar')}
          <div>
            <strong>${escapeHtml(profile.display_name || profile.email || profile.id)}</strong>
            <span>${escapeHtml(profile.email || profile.id || '-')}</span>
            <small>${counts.trips} Trip · ${counts.memos} Memo · ${counts.photos} รูป · ล่าสุด ${escapeHtml(adminUserActivity(profile, stats))}</small>
          </div>
        </div>
        <div class="admin-user-role-actions">
          <select class="admin-role-select" data-admin-user-role="${escapeHtml(profile.id)}" ${isSelf ? 'disabled' : ''} aria-label="Role ของผู้ใช้">
            <option value="user" ${role === 'user' ? 'selected' : ''}>user</option>
            <option value="admin" ${role === 'admin' ? 'selected' : ''}>admin</option>
          </select>
          <button class="ghost-button compact" type="button" data-admin-action="update-user-role" data-id="${escapeHtml(profile.id)}" ${isSelf ? 'disabled title="ไม่ควรเปลี่ยน role ของบัญชีที่กำลังใช้งาน"' : ''}>${tmIcon('admin')}<span>บันทึก</span></button>
        </div>
      </div>`;
  }).join('')}${rows.length > visible.length ? `<div class="admin-list-note">แสดง 18 จาก ${rows.length} ผู้ใช้ ใช้ช่องค้นหาเพื่อกรองให้แคบลง</div>` : ''}`;
}


function updateAdminUserFilterView(stats = state.adminStatsCache) {
  if (!stats) return;
  const list = document.querySelector('.admin-user-list');
  if (list) list.innerHTML = adminUserManagementRows(stats);
  const all = stats.profiles || [];
  const admins = all.filter((profile) => String(profile.role || 'user') === 'admin').length;
  const users = all.length - admins;
  const count = adminFilteredProfiles(stats).length;
  const summary = document.querySelector('.admin-user-management summary em');
  if (summary) summary.textContent = `${count}/${all.length} users · ${admins} admin · ${users} user`;
}

function adminUserManagementPanel(stats) {
  const all = stats.profiles || [];
  const admins = all.filter((profile) => String(profile.role || 'user') === 'admin').length;
  const users = all.length - admins;
  return `
    <details class="admin-card span-4 admin-compact-details admin-user-management" open>
      <summary>${tmIcon('user')}<span>User Management</span><em>${all.length} users · ${admins} admin · ${users} user</em></summary>
      <div class="admin-user-toolbar">
        <label class="admin-search-box">${tmIcon('view')}<input type="search" data-admin-input="user-search" value="${escapeHtml(state.adminUserSearch || '')}" placeholder="ค้นหา email, ชื่อ, user id หรือ role" /></label>
        <select data-admin-input="role-filter" class="admin-role-filter" aria-label="กรอง role">
          <option value="all" ${state.adminRoleFilter === 'all' ? 'selected' : ''}>ทุก role</option>
          <option value="admin" ${state.adminRoleFilter === 'admin' ? 'selected' : ''}>admin</option>
          <option value="user" ${state.adminRoleFilter === 'user' ? 'selected' : ''}>user</option>
        </select>
        <button class="ghost-button compact" type="button" data-admin-action="clear-user-filter">${tmIcon('sync')}<span>ล้างตัวกรอง</span></button>
      </div>
      <div class="admin-list admin-user-list">${adminUserManagementRows(stats)}</div>
    </details>`;
}

function adminTripInsightRows(stats) {
  const memosByTrip = new Map();
  const photosByTrip = new Map();
  for (const memo of stats.memos || []) {
    if (!memo.trip_id || memo.deleted_at) continue;
    memosByTrip.set(memo.trip_id, (memosByTrip.get(memo.trip_id) || 0) + 1);
  }
  const memoTrip = new Map((stats.memos || []).map((memo) => [memo.id, memo.trip_id]));
  for (const photo of stats.photos || []) {
    if (photo.deleted_at) continue;
    const tripId = photo.trip_id || memoTrip.get(photo.memo_id);
    if (!tripId) continue;
    photosByTrip.set(tripId, (photosByTrip.get(tripId) || 0) + 1);
  }
  const inviteByTrip = new Map();
  for (const invite of stats.invites || []) {
    if (!invite.trip_id || ['revoked','declined'].includes(String(invite.status || '').toLowerCase())) continue;
    inviteByTrip.set(invite.trip_id, (inviteByTrip.get(invite.trip_id) || 0) + 1);
  }
  return (stats.trips || [])
    .filter((trip) => !trip.deleted_at)
    .slice(0, 8)
    .map((trip) => `
      <div class="admin-row admin-shared-row">
        <div>
          <strong>${escapeHtml(trip.title || 'Trip')}</strong>
          <span>${renderTripStatusChip(trip)} · ${memosByTrip.get(trip.id) || 0} Memo · ${photosByTrip.get(trip.id) || 0} รูป · แชร์ ${inviteByTrip.get(trip.id) || 0} คน</span>
          <small>ผู้สร้าง: ${escapeHtml(tripOwnerLabel(trip.user_id, stats.profiles))}</small>
        </div>
        <button class="ghost-button compact" type="button" data-admin-action="inspect-trip" data-id="${escapeHtml(trip.id)}">${tmIcon('view')}<span>ดูสรุป</span></button>
      </div>`).join('') || '<div class="empty-state compact-empty">ยังไม่มี Trip ให้ตรวจสอบ</div>';
}

function adminPublicShareRows(stats) {
  const memosByTrip = new Map();
  const photosByTrip = new Map();
  const memoTrip = new Map((stats.memos || []).map((memo) => [memo.id, memo.trip_id]));
  for (const memo of stats.memos || []) {
    if (!memo.trip_id || memo.deleted_at) continue;
    memosByTrip.set(memo.trip_id, (memosByTrip.get(memo.trip_id) || 0) + 1);
  }
  for (const photo of stats.photos || []) {
    if (photo.deleted_at) continue;
    const tripId = photo.trip_id || memoTrip.get(photo.memo_id);
    if (!tripId) continue;
    photosByTrip.set(tripId, (photosByTrip.get(tripId) || 0) + 1);
  }
  const rows = (stats.trips || []).filter((trip) => !trip.deleted_at && (trip.is_public || trip.public_slug));
  if (!rows.length) return '<div class="empty-state compact-empty">ยังไม่มี Trip ที่เปิด Public หรือเคยมี public slug</div>';
  return rows.slice(0, 12).map((trip) => {
    const url = trip.public_slug ? publicTripUrl(trip) : '';
    const active = isTripPublic(trip);
    return `<div class="admin-row admin-public-row ${active ? 'public-active' : 'public-inactive'}">
      <div>
        <strong>${escapeHtml(trip.title || 'Trip')}</strong>
        <span>${active ? 'Public เปิดอยู่' : 'Private / slug ถูกปิด'} · ${memosByTrip.get(trip.id) || 0} Memo · ${photosByTrip.get(trip.id) || 0} รูป</span>
        <small>${url ? escapeHtml(url) : 'ไม่มี public slug'} · ผู้สร้าง ${escapeHtml(tripOwnerLabel(trip.user_id, stats.profiles))}</small>
      </div>
      <div class="admin-row-actions">
        ${url ? `<button class="ghost-button compact" type="button" data-admin-action="public-copy" data-id="${escapeHtml(trip.id)}">${tmIcon('memo')}<span>Copy</span></button>` : ''}
        ${active ? `<button class="ghost-button compact" type="button" data-admin-action="public-open" data-id="${escapeHtml(trip.id)}">${tmIcon('view')}<span>Open</span></button>` : ''}
      </div>
    </div>`;
  }).join('');
}

function adminPublicShareInspectorPanel(stats) {
  const publicTrips = (stats.trips || []).filter((trip) => !trip.deleted_at && trip.is_public && trip.public_slug).length;
  const slugs = (stats.trips || []).filter((trip) => !trip.deleted_at && trip.public_slug).length;
  return `<details class="admin-card span-4 admin-compact-details admin-public-inspector" open>
    <summary>${tmIcon('view')}<span>Public Share Inspector</span><em>${publicTrips} public · ${slugs} slug</em></summary>
    <div class="admin-warning-box compact">${tmIcon('diagnostics')}<span>Public Inspector ใช้ตรวจ Trip ที่เปิด public, คัดลอกลิงก์ และเปิดดูหน้า read-only ได้จากจุดเดียว</span></div>
    <div class="admin-list">${adminPublicShareRows(stats)}</div>
  </details>`;
}


function adminPhotoSchemaAlignmentPanel(stats = {}) {
  const checks = stats.schema_checks || [];
  const byColumn = new Map(checks.map((item) => [item.column, item]));
  const rows = PHOTO_SCHEMA_ALIGNMENT_COLUMNS.map((item) => {
    const check = byColumn.get(item.column);
    const ok = check ? Boolean(check.ok) : true;
    const status = ok ? 'พร้อม' : (item.required ? 'ต้องแก้' : 'แนะนำ');
    const statusClass = ok ? 'ok' : (item.required ? 'danger' : 'warn');
    return `<div class="admin-schema-row ${statusClass}">
      <span>${tmIcon(ok ? 'check-in' : 'diagnostics')}</span>
      <div><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.column)} · ${escapeHtml(item.note)}</small>${check?.message ? `<em>${escapeHtml(shortText(check.message, 140))}</em>` : ''}</div>
      <b>${escapeHtml(status)}</b>
    </div>`;
  }).join('');
  const missingRequired = PHOTO_SCHEMA_ALIGNMENT_COLUMNS.filter((item) => item.required && byColumn.get(item.column)?.ok === false).length;
  const missingOptional = PHOTO_SCHEMA_ALIGNMENT_COLUMNS.filter((item) => !item.required && byColumn.get(item.column)?.ok === false).length;
  const headline = missingRequired ? `ต้องแก้ ${missingRequired} column` : missingOptional ? `แนะนำเพิ่ม ${missingOptional} column` : 'Schema พร้อม';
  return `<article class="admin-card span-4 admin-schema-card">
    <div class="admin-section-headline">
      <div><h3>${tmIcon('storage')}<span>Supabase Schema Alignment</span></h3><p>ตรวจ photos schema สำหรับ caption, sort order, thumbnail path, EXIF และ metadata ให้ตรงกับระบบรูปปัจจุบัน</p></div>
      <span class="admin-schema-badge ${missingRequired ? 'danger' : missingOptional ? 'warn' : 'ok'}">${escapeHtml(headline)}</span>
    </div>
    <div class="admin-tool-grid admin-schema-tool-grid">
      <button class="ghost-button" type="button" data-admin-action="copy-photo-schema-sql">${tmIcon('memo')}<span>Copy migration SQL</span></button>
      <button class="ghost-button" type="button" data-admin-action="copy-schema-refresh-steps">${tmIcon('sync')}<span>Copy refresh steps</span></button>
    </div>
    <details class="admin-compact-details admin-schema-details" ${missingRequired || missingOptional ? 'open' : ''}>
      <summary>${tmIcon('diagnostics')}<span>ดู schema checklist</span></summary>
      <div class="admin-schema-list">${rows}</div>
    </details>
  </article>`;
}

async function renderAdmin() {
  if (state.view !== 'admin') return;
  if (state.profile?.role !== 'admin') {
    els.adminContent.innerHTML = `<div class="empty-state">บัญชีนี้ยังไม่ใช่ admin</div>`;
    return;
  }
  els.adminContent.innerHTML = `<div class="empty-state">กำลังโหลด Admin Dashboard...</div>`;
  try {
    const [stats, localQueue, storage] = await Promise.all([
      fetchAdminStats(),
      db.getAll('syncQueue').catch(() => []),
      db.estimateStorage().catch(() => null)
    ]);
    state.adminStatsCache = stats;
    const activeTrips = stats.trips.filter((item) => !item.deleted_at);
    const activeMemos = stats.memos.filter((item) => !item.deleted_at);
    const activePhotos = stats.photos.filter((item) => !item.deleted_at);
    const photoBytes = activePhotos.reduce((sum, photo) => sum + Number(photo.size_bytes || 0), 0);
    const sharedTripCount = new Set((stats.invites || []).filter((invite) => !['revoked','declined'].includes(String(invite.status || '').toLowerCase())).map((invite) => invite.trip_id)).size;
    const queueSummary = queueTypeSummary(localQueue);
    const schemaMissing = (stats.schema_checks || []).filter((item) => !item.ok);
    const orphanPhotos = activePhotos.filter((photo) => !photo.memo_id && !photo.trip_id).length;
    const missingPathPhotos = activePhotos.filter((photo) => !photo.storage_path && !photo.thumbnail_path && !photo.thumb_path && !photo.thumbnail_storage_path && !photo.thumb_storage_path).length;
    const locationStats = buildLocationRepairStats(activeMemos, activePhotos);

    const tripRows = activeTrips.slice(0, 10).map((trip) => `
      <div class="admin-row">
        <div><strong>${escapeHtml(trip.title || 'Trip')}</strong><span>${renderTripStatusChip(trip)} · ${Number(trip.view_count || 0).toLocaleString('th-TH')} views · ${trip.is_visible === false ? 'ซ่อนอยู่' : 'แสดงอยู่'}</span></div>
        <div class="admin-row-actions">
          <button class="ghost-button compact" type="button" data-admin-action="toggle-trip" data-id="${escapeHtml(trip.id)}" data-visible="${trip.is_visible === false ? 'true' : 'false'}">${trip.is_visible === false ? 'เปิดแสดง' : 'ซ่อน'}</button>
          ${!isTripFinished(trip) ? `<button class="secondary-button compact" type="button" data-admin-action="finish-trip" data-id="${escapeHtml(trip.id)}">${tmIcon('check-in')}<span>จบ Trip</span></button>` : ''}
        </div>
      </div>`).join('') || '<div class="empty-state compact-empty">ยังไม่มี Trip</div>';

    const memoRows = activeMemos.slice(0, 10).map((memo) => `
      <div class="admin-row">
        <div><strong>${escapeHtml(memo.title || 'Memo')}</strong><span>${Number(memo.view_count || 0).toLocaleString('th-TH')} views · ${escapeHtml(memo.country || memo.city || '')} · ${memo.is_visible === false ? 'ซ่อนอยู่' : 'แสดงอยู่'}</span></div>
        <button class="ghost-button compact" type="button" data-admin-action="toggle-memo" data-id="${escapeHtml(memo.id)}" data-visible="${memo.is_visible === false ? 'true' : 'false'}">${memo.is_visible === false ? 'เปิดแสดง' : 'ซ่อน'}</button>
      </div>`).join('') || '<div class="empty-state compact-empty">ยังไม่มี Memo</div>';

    const queueRows = localQueue
      .sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0))
      .slice(0, 8)
      .map((item) => `<div class="admin-row ${item.last_error ? 'admin-row-warn' : ''}"><div><strong>${escapeHtml(item.entity || '-')} · ${escapeHtml(item.action || '-')}</strong><span>${escapeHtml(item.status || (item.last_error ? 'failed' : 'pending'))} · attempts ${Number(item.attempts || item.retry_count || 0)}</span>${item.last_error ? `<small>${escapeHtml(shortText(item.last_error, 120))}</small>` : ''}</div></div>`)
      .join('') || '<div class="empty-state compact-empty">ไม่มี queue ในเครื่องของบัญชีนี้</div>';

    els.adminContent.innerHTML = `
      <section class="admin-dashboard-hero span-4">
        <div><p class="eyebrow">Admin Control Center</p><h3>ภาพรวมระบบ Travel Memo</h3><p>ดูสุขภาพระบบ คิวซิงก์ รูปภาพ Trip ที่แชร์ และเครื่องมือด่วนในหน้าเดียว</p></div>
        <span>${tmIcon('admin')}</span>
      </section>
      ${adminStatCard('user', 'Users', stats.profiles.length)}
      ${adminStatCard('trips', 'Trips', activeTrips.length, `${activeTrips.filter(isTripFinished).length} จบแล้ว`)}
      ${adminStatCard('memo', 'Memos', activeMemos.length)}
      ${adminStatCard('photo', 'Photos', activePhotos.length, bytesToSize(photoBytes))}
      ${adminStatCard('group', 'Shared Trips', sharedTripCount)}
      ${adminStatCard('queue', 'Queue Failed', queueSummary.failed, `${queueSummary.total} queue ในเครื่อง`)}
      ${adminStatCard('storage', 'Local Storage', storage?.usage ? bytesToSize(storage.usage) : 'ไม่ทราบ')}
      ${adminStatCard('cloud-sync', 'Cloud', isSupabaseConfigured ? 'พร้อม' : 'ไม่พร้อม')}

      ${adminHealthSummaryPanel({ queueSummary, schemaMissing, orphanPhotos, missingPathPhotos, locationStats, storage, photoBytes })}

      <article class="admin-card span-2 admin-health-card">
        <h3>${tmIcon('diagnostics')}<span>System Health</span></h3>
        <div class="admin-health-grid">
          ${healthPill('Supabase', isSupabaseConfigured, isSupabaseConfigured ? 'ตั้งค่า env แล้ว' : 'ยังไม่ได้ตั้งค่า env')}
          ${healthPill('Schema photos', !schemaMissing.length, schemaMissing.length ? `ขาด/ยัง cache ไม่สด: ${schemaMissing.map((item) => item.column).join(', ')}` : 'caption / sort_order / path พร้อม')}
          ${healthPill('Sync Queue', queueSummary.failed === 0, queueSummary.failed ? `ล้มเหลว ${queueSummary.failed} รายการ` : 'ไม่มีคิวล้มเหลว')}
          ${healthPill('Photo Records', orphanPhotos === 0 && missingPathPhotos === 0, `${orphanPhotos} รูปไม่มี parent · ${missingPathPhotos} รูปไม่มี path`)}
          ${healthPill('Location Data', locationStats.missing === 0 || locationStats.ownRepairable === 0, locationStats.missing ? `${locationStats.missing} Memo ไม่มีพิกัด · ซ่อมได้ ${locationStats.ownRepairable}` : 'ทุก Memo มีพิกัดแล้ว')}
        </div>
        ${schemaMissing.length ? `<div class="admin-warning-box">${tmIcon('diagnostics')}<span>Photo schema warning: Admin จะโหลดแบบ fallback ได้ แต่ถ้า caption/sort order/path ไม่ sync ให้รัน migration ล่าสุด และกด Refresh schema ใน Supabase API settings</span></div>` : ''}
      </article>

      ${adminPhotoSchemaAlignmentPanel(stats)}

      <article class="admin-card span-2 admin-quick-tools">
        <h3>${tmIcon('settings')}<span>Quick Tools</span></h3>
        <div class="admin-tool-grid admin-repair-tool-grid">
          <button class="secondary-button" type="button" data-admin-action="retry-queue">${tmIcon('sync')}<span>Retry Queue</span></button>
          <button class="ghost-button" type="button" data-admin-action="reset-failed">${tmIcon('queue')}<span>Reset Failed</span></button>
          <button class="ghost-button" type="button" data-admin-action="pull-cloud">${tmIcon('cloud-sync')}<span>Pull Cloud</span></button>
          <button class="ghost-button" type="button" data-admin-action="run-diagnostics">${tmIcon('diagnostics')}<span>Run Diagnostics</span></button>
          <button class="ghost-button" type="button" data-admin-action="copy-error-summary">${tmIcon('memo')}<span>Copy Errors</span></button>
          <button class="ghost-button" type="button" data-admin-action="export-diagnostics-json">${tmIcon('backup')}<span>Export JSON</span></button>
          <button class="ghost-button" type="button" data-admin-action="copy-photo-schema-sql">${tmIcon('memo')}<span>Copy Schema SQL</span></button>
          <button class="ghost-button" type="button" data-admin-action="repair-shared-trips">${tmIcon('group')}<span>Repair Shared</span></button>
          <button class="ghost-button" type="button" data-admin-action="requeue-photo-sync">${tmIcon('photo')}<span>Requeue Photos</span></button>
          <button class="ghost-button" type="button" data-admin-action="repair-photo-paths">${tmIcon('storage')}<span>Repair Paths</span></button>
          <button class="ghost-button" type="button" data-admin-action="repair-location-gps">${tmIcon('location')}<span>Repair GPS</span></button>
          <button class="ghost-button" type="button" data-admin-action="copy-location-report">${tmIcon('map')}<span>Copy Location</span></button>
          <button class="danger-button" type="button" data-admin-action="clear-failed">${tmIcon('trash')}<span>Clear Failed</span></button>
        </div>
      </article>

      <article class="admin-card span-4 admin-repair-card">
        <h3>${tmIcon('settings')}<span>Repair Tools</span></h3>
        <p class="muted small-note">เครื่องมือซ่อม local data / queue สำหรับแก้ปัญหารูปไม่ขึ้น, shared trip cache เก่า หรือคิวซิงก์ค้าง โดยไม่ลบ Memo/Trip/Photo จริง</p>
        <div id="adminRepairPanel" class="admin-repair-panel">
          <span>${tmIcon('diagnostics')} กดเครื่องมือด้านบนเพื่อเริ่มตรวจหรือซ่อมข้อมูล</span>
        </div>
      </article>

      <article class="admin-card span-4 admin-location-repair-card">
        <h3>${tmIcon('location')}<span>Location Repair</span></h3>
        <p class="muted small-note">ตรวจ Memo ที่ยังไม่มีพิกัด และเติม latitude/longitude จากรูปที่มี EXIF GPS เฉพาะ Memo ของบัญชีนี้</p>
        <div class="admin-location-grid">
          <span><strong>${locationStats.withLocation}</strong><small>มีพิกัด</small></span>
          <span><strong>${locationStats.missing}</strong><small>ไม่มีพิกัด</small></span>
          <span><strong>${locationStats.photosWithGps}</strong><small>รูปมี GPS</small></span>
          <span><strong>${locationStats.ownRepairable}</strong><small>ซ่อมได้</small></span>
        </div>
        ${locationStats.sharedSkipped ? `<div class="admin-warning-box compact">${tmIcon('group')}<span>มี ${locationStats.sharedSkipped} Memo จาก shared trip ที่ซ่อมได้แต่เป็น read-only จึงไม่แก้ข้อมูลให้</span></div>` : ''}
      </article>

      <article class="admin-card span-4 admin-ops-card">
        <h3>${tmIcon('diagnostics')}<span>Ops Monitor</span></h3>
        <div class="admin-ops-grid">
          <section class="admin-ops-panel">
            <div class="admin-ops-head"><strong>${tmIcon('queue')} Queue</strong><span>${queueSummary.failed ? `${queueSummary.failed} failed` : 'OK'}</span></div>
            <div class="queue-summary admin-queue-summary"><span>ทั้งหมด ${queueSummary.total}</span><span>รอ ${queueSummary.pending}</span><span>ทำงาน ${queueSummary.syncing + queueSummary.retrying}</span><span>ล้มเหลว ${queueSummary.failed}</span></div>
          </section>
          <section class="admin-ops-panel">
            <div class="admin-ops-head"><strong>${tmIcon('photo')} Photo</strong><span>${schemaMissing.length ? 'Schema warning' : 'OK'}</span></div>
            <div class="diagnostics-table admin-mini-table">
              <div><strong>Storage</strong><span>${bytesToSize(photoBytes)}</span></div>
              <div><strong>Missing</strong><span>${orphanPhotos} parent · ${missingPathPhotos} path</span></div>
              <div><strong>Schema</strong><span>${schemaMissing.length ? schemaMissing.map((item) => item.column).join(', ') : 'พร้อม'}</span></div>
            </div>
          </section>
        </div>
        <details class="admin-compact-details">
          <summary>${tmIcon('queue')}<span>ดู queue ล่าสุด</span></summary>
          <div class="admin-list">${queueRows}</div>
        </details>
      </article>

      ${adminUserManagementPanel(stats)}
      ${adminPublicShareInspectorPanel(stats)}

      <details class="admin-card span-4 admin-compact-details admin-shared-inspector" open>
        <summary>${tmIcon('group')}<span>Shared Trip Inspector</span></summary>
        <div class="admin-list">${adminTripInsightRows(stats)}</div>
      </details>

      <details class="admin-card span-2 admin-compact-details">
        <summary>${tmIcon('trips')}<span>Trip ล่าสุด · เปิด/ปิด/จบ Trip</span></summary>
        <div class="admin-list">${tripRows}</div>
      </details>
      <details class="admin-card span-2 admin-compact-details">
        <summary>${tmIcon('memo')}<span>Memo ล่าสุด · เปิด/ปิดการแสดงผล</span></summary>
        <div class="admin-list">${memoRows}</div>
      </details>
    `;
  } catch (error) {
    els.adminContent.innerHTML = `<div class="empty-state">โหลด Admin ไม่สำเร็จ: ${escapeHtml(error.message)}</div>`;
  }
}


function handleAdminInput(event) {
  const field = event.target.closest?.('[data-admin-input]');
  if (!field || state.profile?.role !== 'admin') return;
  const type = field.dataset.adminInput;
  if (type === 'user-search') {
    state.adminUserSearch = field.value || '';
    updateAdminUserFilterView();
    return;
  }
  if (type === 'role-filter') {
    state.adminRoleFilter = field.value || 'all';
    updateAdminUserFilterView();
  }
}

async function handleAdminAction(event) {
  const button = event.target.closest('[data-admin-action]');
  if (!button || state.profile?.role !== 'admin') return;
  const action = button.dataset.adminAction;
  const id = button.dataset.id;
  button.disabled = true;
  try {
    if (action === 'clear-user-filter') { state.adminUserSearch = ''; state.adminRoleFilter = 'all'; document.querySelector('[data-admin-input="user-search"]') && (document.querySelector('[data-admin-input="user-search"]').value = ''); const roleFilter = document.querySelector('[data-admin-input="role-filter"]'); if (roleFilter) roleFilter.value = 'all'; updateAdminUserFilterView(); return; }
    if (action === 'update-user-role') { await adminUpdateUserRole(id); return; }
    if (action === 'retry-queue') { await retrySyncQueue(); return; }
    if (action === 'reset-failed') { await resetFailedQueue(true); await renderAdmin(); return; }
    if (action === 'clear-failed') { await clearFailedQueue(); await renderAdmin(); return; }
    if (action === 'pull-cloud') { await pullCloudData(false); await renderAdmin(); return; }
    if (action === 'run-diagnostics') { await runDiagnostics(); return; }
    if (action === 'copy-diagnostics') {
      const text = `Travel Memo ${APP_VERSION}\nQueue: ${state.syncQueue.length}\nTrips: ${state.trips.length}\nMemos: ${state.memos.length}\nPhotos: ${state.photos.length}\nCache: ${window.TRAVEL_MEMO_CACHE_NAME || '-'}`;
      await navigator.clipboard?.writeText(text);
      showNotice('คัดลอก Diagnostics summary แล้ว');
      return;
    }
    if (action === 'copy-photo-schema-sql') {
      await navigator.clipboard?.writeText(PHOTO_SCHEMA_ALIGNMENT_SQL);
      setAdminRepairStatus('คัดลอก photo schema migration SQL แล้ว', 'ok');
      showNotice('คัดลอก migration SQL แล้ว');
      return;
    }
    if (action === 'copy-schema-refresh-steps') {
      await navigator.clipboard?.writeText(PHOTO_SCHEMA_REFRESH_STEPS);
      setAdminRepairStatus('คัดลอกขั้นตอน Refresh schema แล้ว', 'ok');
      showNotice('คัดลอกขั้นตอน refresh schema แล้ว');
      return;
    }
    if (action === 'inspect-trip') {
      const trip = state.trips.find((item) => item.id === id) || await db.get('trips', id).catch(() => null);
      if (trip) openTripSheet(id); else showNotice('Trip นี้ยังไม่อยู่ใน cache ของบัญชีนี้');
      return;
    }
    if (action === 'public-copy') { await copyPublicTripLink(id); return; }
    if (action === 'public-open') {
      const trip = state.trips.find((item) => item.id === id) || await db.get('trips', id).catch(() => null);
      if (trip?.public_slug) window.open(publicTripUrl(trip), '_blank', 'noopener');
      return;
    }
    if (action === 'finish-trip') {
      await adminUpdateTripStatus(id, 'done');
      return;
    }
    if (action === 'repair-location-gps') {
      await adminRepairLocationsFromPhotoGps();
      return;
    }
    if (action === 'copy-location-report') {
      await adminCopyLocationReport();
      return;
    }
    if (!supabase) throw new Error('ต้องเชื่อมต่อ Supabase ก่อน');
    const visible = button.dataset.visible === 'true';
    const table = action === 'toggle-trip' ? 'trips' : action === 'toggle-memo' ? 'memos' : '';
    if (!table) return;
    const { error } = await supabase.from(table).update({ is_visible: visible, updated_at: nowIso() }).eq('id', id);
    if (error) throw error;
    const localItem = await db.get(table, id).catch(() => null);
    if (localItem) await db.put(table, { ...localItem, is_visible: visible, updated_at: nowIso() });
    showNotice(visible ? 'เปิดการแสดงผลแล้ว' : 'ซ่อนรายการแล้ว');
    await loadLocalData();
    state.lastCloudPullAt = nowIso();
    renderAll();
    await renderAdmin();
  } catch (error) {
    showNotice(error.message || 'ทำรายการ Admin ไม่สำเร็จ');
  } finally {
    button.disabled = false;
  }
}



function setAdminRepairStatus(message, tone = '') {
  const panel = document.getElementById('adminRepairPanel');
  if (panel) panel.innerHTML = `<span class="${tone ? `admin-repair-${tone}` : ''}">${tmIcon(tone === 'ok' ? 'check-in' : tone === 'warn' ? 'diagnostics' : 'settings')} ${escapeHtml(message)}</span>`;
}

async function getAdminDiagnosticsSnapshot() {
  const queue = await db.getAll('syncQueue').catch(() => []);
  const trips = await db.getAll('trips').catch(() => []);
  const memos = await db.getAll('memos').catch(() => []);
  const photos = await db.getAll('photos').catch(() => []);
  const storage = await db.estimateStorage().catch(() => null);
  return {
    version: APP_VERSION,
    cache: window.TRAVEL_MEMO_CACHE_NAME || '-',
    generated_at: nowIso(),
    user: state.user?.email || state.user?.id || '-',
    queue: queue.map(({ id, entity, entity_id, action, status, attempts, retry_count, last_error, updated_at }) => ({ id, entity, entity_id, action, status, attempts, retry_count, last_error, updated_at })),
    counts: { trips: trips.length, memos: memos.length, photos: photos.length, queue: queue.length },
    storage,
    schema_warnings: (state.adminStatsCache?.schema_checks || []).filter((item) => !item.ok)
  };
}

async function adminCopyErrorSummary() {
  const queue = await db.getAll('syncQueue').catch(() => []);
  const failed = queue.filter((item) => item.last_error || item.status === 'failed');
  const text = failed.length
    ? failed.slice(0, 25).map((item, index) => `${index + 1}. ${item.entity || '-'}:${item.entity_id || '-'} ${item.action || '-'} / ${item.status || 'failed'} / ${item.last_error || '-'}`).join('\n')
    : `Travel Memo ${APP_VERSION}: ไม่มี sync error ในคิวของเครื่องนี้`;
  await navigator.clipboard?.writeText(text);
  setAdminRepairStatus(failed.length ? `คัดลอก error summary แล้ว ${failed.length} รายการ` : 'ไม่มี error ให้คัดลอก', failed.length ? 'warn' : 'ok');
  showNotice('คัดลอก Error Summary แล้ว');
}

async function adminExportDiagnosticsJson() {
  const snapshot = await getAdminDiagnosticsSnapshot();
  downloadFile(`travel-memo-admin-diagnostics-${APP_VERSION}.json`, JSON.stringify(snapshot, null, 2), 'application/json');
  setAdminRepairStatus('ส่งออก Diagnostics JSON แล้ว', 'ok');
}

async function adminRepairSharedTrips() {
  setAdminRepairStatus('กำลัง repair shared trip cache...');
  await pullCloudData(false);
  const [trips, memos, photos] = await Promise.all([db.getAll('trips'), db.getAll('memos'), db.getAll('photos')]);
  const memoTrip = new Map(memos.map((memo) => [memo.id, memo.trip_id]));
  const visibleTripIds = new Set(trips.filter((trip) => !trip.deleted_at).map((trip) => trip.id));
  let fixedPhotos = 0;
  for (const photo of photos) {
    const tripId = photo.trip_id || memoTrip.get(photo.memo_id);
    if (!tripId || !visibleTripIds.has(tripId)) continue;
    const next = { ...photo, trip_id: photo.trip_id || tripId };
    if (photo.user_id !== state.user?.id && !photo.shared_access) {
      next.shared_access = true;
      next.access_level = 'shared';
    }
    if (JSON.stringify(next) !== JSON.stringify(photo)) {
      await db.put('photos', next);
      fixedPhotos += 1;
    }
  }
  await loadLocalData();
  renderAll();
  setAdminRepairStatus(`Repair shared trips แล้ว · อัปเดตรูป ${fixedPhotos} รายการ`, 'ok');
}

async function adminRequeuePhotoSync() {
  const photos = await db.getAll('photos').catch(() => []);
  let queued = 0;
  for (const photo of photos) {
    if (photo.deleted_at || photo.shared_access || (photo.user_id && photo.user_id !== state.user?.id)) continue;
    await db.put('photos', { ...photo, sync_status: 'pending', updated_at: nowIso() });
    const result = await db.queueSync(photo.deleted_at ? 'delete_photo' : 'upsert_photo', 'photo', photo.id, { user_id: photo.user_id || state.user?.id });
    if (!result?.skipped) queued += 1;
  }
  await loadLocalData();
  await renderQueuePanel();
  setAdminRepairStatus(`Requeue photo sync แล้ว ${queued} รายการ`, queued ? 'ok' : 'warn');
}

async function adminRepairPhotoPaths() {
  const photos = await db.getAll('photos').catch(() => []);
  let fixed = 0;
  for (const photo of photos) {
    if (!photo.id || photo.shared_access || (photo.user_id && photo.user_id !== state.user?.id)) continue;
    const storagePath = photo.storage_path || photo.path || photo.file_path || photo.object_path || `${photo.user_id || state.user?.id}/photos/${photo.id}.jpg`;
    const thumbnailPath = photo.thumbnail_path || photo.thumb_path || photo.thumb_storage_path || photo.thumbnail_storage_path || `${photo.user_id || state.user?.id}/thumbs/${photo.id}.jpg`;
    if (storagePath !== photo.storage_path || thumbnailPath !== photo.thumbnail_path) {
      await db.put('photos', { ...photo, storage_path: storagePath, thumbnail_path: thumbnailPath, sync_status: photo.sync_status === 'synced' ? 'pending' : photo.sync_status, updated_at: nowIso() });
      await db.queueSync('upsert_photo', 'photo', photo.id, { user_id: photo.user_id || state.user?.id });
      fixed += 1;
    }
  }
  await loadLocalData();
  setAdminRepairStatus(`Repair photo paths แล้ว ${fixed} รายการ`, fixed ? 'ok' : 'warn');
}

async function adminRepairLocationsFromPhotoGps() {
  setAdminRepairStatus('กำลังซ่อมพิกัด Memo จาก EXIF GPS...');
  const result = await repairMemoLocationsFromPhotoGps();
  await renderQueuePanel();
  renderAll();
  if (state.view === 'map') renderMapMarkers();
  setAdminRepairStatus(`Repair GPS แล้ว ${result.fixed} Memo · ซ่อมได้ทั้งหมด ${result.repairable} · shared/read-only ${result.skippedShared}`, result.fixed ? 'ok' : 'warn');
  showNotice(result.fixed ? `เติมพิกัดจากรูปแล้ว ${result.fixed} Memo` : 'ยังไม่มี Memo ของคุณที่ซ่อมพิกัดได้');
  await renderAdmin();
}

async function adminCopyLocationReport() {
  const [memos, photos] = await Promise.all([db.getAll('memos').catch(() => []), db.getAll('photos').catch(() => [])]);
  const stats = buildLocationRepairStats(memos, photos);
  await navigator.clipboard?.writeText(locationRepairReportText(stats));
  setAdminRepairStatus('คัดลอก Location report แล้ว', 'ok');
  showNotice('คัดลอก Location report แล้ว');
}


async function adminUpdateUserRole(id) {
  if (!id || !supabase) throw new Error('ต้องเชื่อมต่อ Supabase ก่อน');
  if (id === state.user?.id) throw new Error('ไม่อนุญาตให้เปลี่ยน role ของบัญชีที่กำลังใช้งาน เพื่อป้องกันล็อกตัวเองออกจาก Admin');
  const select = document.querySelector(`[data-admin-user-role="${CSS.escape(id)}"]`);
  const role = select?.value === 'admin' ? 'admin' : 'user';
  let { error } = await supabase.from('profiles').update({ role, updated_at: nowIso() }).eq('id', id);
  if (error && /updated_at|schema cache|column/i.test(String(error.message || ''))) {
    const fallback = await supabase.from('profiles').update({ role }).eq('id', id);
    error = fallback.error;
  }
  if (error) throw error;
  const localProfile = state.profiles.find((profile) => profile.id === id);
  if (localProfile) {
    localProfile.role = role;
    localProfile.updated_at = nowIso();
    await db.put('profiles', localProfile).catch(() => null);
  }
  showNotice(`อัปเดต role เป็น ${role} แล้ว`);
  await loadLocalData();
  await renderAdmin();
}

async function adminUpdateTripStatus(id, status) {
  if (!id) return;
  const now = nowIso();
  if (supabase) {
    const { error } = await supabase.from('trips').update({ status, end_date: now.slice(0, 10), updated_at: now }).eq('id', id);
    if (error) throw error;
  }
  const localItem = await db.get('trips', id).catch(() => null);
  if (localItem) await db.put('trips', { ...localItem, status, end_date: localItem.end_date || now.slice(0, 10), sync_status: 'pending', updated_at: now });
  await loadLocalData();
  renderAll();
  showNotice('อัปเดตสถานะ Trip แล้ว');
  await renderAdmin();
}

async function renderQueuePanel() {
  if (!els.queuePanel) return;
  const queue = await db.getAll('syncQueue').catch(() => []);
  if (!queue.length) {
    els.queuePanel.innerHTML = `<div class="empty-state compact success-empty empty-state-with-icon">${tmIcon('cloud-sync')}<span>ไม่มีรายการรอซิงก์ ข้อมูลในเครื่องและ Cloud ตรงกันแล้ว</span></div>`;
    return;
  }
  const failed = queue.filter((item) => item.status === 'failed' || item.last_error);
  const active = queue.filter((item) => ['syncing', 'retrying'].includes(item.status));
  const pending = queue.filter((item) => !item.last_error && !['syncing', 'retrying'].includes(item.status));
  const rows = queue
    .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at))
    .slice(0, 16)
    .map((item) => {
      const status = item.status || (item.last_error ? 'failed' : 'pending');
      const queueStatusLabel = {
        pending: `${tmIcon('queue')}<span>รอซิงก์</span>`,
        syncing: `${tmIcon('cloud-sync')}<span>กำลังซิงก์</span>`,
        retrying: `${tmIcon('sync')}<span>ลองใหม่</span>`,
        failed: `${tmIcon('diagnostics')}<span>ล้มเหลว</span>`,
        paused: `${tmIcon('storage')}<span>พักไว้</span>`
      }[status] || `${tmIcon('queue')}<span>รอซิงก์</span>`;
      return `
        <div class="queue-row ${item.last_error ? 'failed' : ''} ${escapeHtml(status)}">
          <div>
            <strong>${escapeHtml(item.entity || '-')} · ${escapeHtml(item.action || '-')}</strong>
            <span>${escapeHtml(item.entity_id || '')}</span>
            ${item.last_error ? `<small>${escapeHtml(item.last_error)}</small>` : ''}
          </div>
          <span>${queueStatusLabel}<br><small>${Number(item.attempts || item.retry_count || 0)} ครั้ง</small></span>
        </div>
      `;
    }).join('');
  els.queuePanel.innerHTML = `
    <div class="queue-summary">
      <span>ทั้งหมด ${queue.length}</span>
      <span>รอซิงก์ ${pending.length}</span>
      <span>กำลังทำงาน ${active.length}</span>
      <span>ล้มเหลว ${failed.length}</span>
    </div>
    <div class="queue-list">${rows}</div>
  `;
}

async function retrySyncQueue() {
  const button = els.queueRetryButton;
  setButtonBusy(button, true, 'กำลังซิงก์คิว...');
  try {
    toast('กำลังเตรียมคิวซิงก์');
    await resetFailedQueue(false);
    const cleanup = await cleanupSyncQueueForUser(state.user?.id);
    if (cleanup.removed) toast(`ล้างคิวที่ไม่เกี่ยวกับบัญชีนี้ ${cleanup.removed} รายการ`);
    await queueAllPending(state.user?.id);
    await loadLocalData();
    state.lastCloudPullAt = nowIso();
    renderAll();
    if (!state.syncQueue.length) {
      toast('ไม่มีรายการรอซิงก์');
      return;
    }
    const result = await runSync({ includePull: false, silent: false, force: true });
    await loadLocalData();
    state.lastCloudPullAt = nowIso();
    renderAll();
    await renderQueuePanel();
    if (result?.errors?.length) toast(`ยังมีคิวล้มเหลว ${result.errors.length} รายการ ดูรายละเอียดด้านล่าง`);
  } catch (error) {
    toast(error.message || 'ลองซิงก์คิวไม่สำเร็จ');
  } finally {
    setButtonBusy(button, false);
  }
}

async function resetFailedQueue(showMessage = true) {
  const cleanup = await cleanupSyncQueueForUser(state.user?.id).catch(() => ({ removed: 0 }));
  const queue = await db.getAll('syncQueue');
  const failed = queue.filter((item) => item.last_error || Number(item.attempts || 0) > 0);
  await Promise.all(failed.map((item) => db.put('syncQueue', {
    ...item,
    attempts: 0,
    retry_count: 0,
    status: 'pending',
    last_error: null,
    updated_at: nowIso()
  })));
  await loadLocalData();
  renderAll();
  if (showMessage) {
    const cleanedText = cleanup.removed ? ` · ล้างคิวเก่า ${cleanup.removed}` : '';
    toast(failed.length ? `รีเซ็ตคิว ${failed.length} รายการแล้ว${cleanedText}` : `ไม่มีคิวที่ล้มเหลว${cleanedText}`);
  }
}

async function clearFailedQueue() {
  const cleanup = await cleanupSyncQueueForUser(state.user?.id).catch(() => ({ removed: 0 }));
  const queue = await db.getAll('syncQueue');
  const failed = queue.filter((item) => item.last_error || Number(item.attempts || 0) >= 5 || item.status === 'failed');
  if (!failed.length && !cleanup.removed) {
    toast('ไม่มีคิวที่ล้มเหลวให้ล้าง');
    return;
  }
  const count = failed.length + Number(cleanup.removed || 0);
  if (!confirm(`ล้างคิวที่ล้มเหลว/คิวเก่า ${count} รายการ? ข้อมูลในเครื่องยังอยู่ แต่รายการคิวนี้จะถูกลบ`)) return;
  await Promise.all(failed.map((item) => db.remove('syncQueue', item.id)));
  await loadLocalData();
  renderAll();
  toast(`ล้างคิวแล้ว ${count} รายการ`);
}

async function runDiagnostics() {
  const button = els.diagnosticsButton;
  setButtonBusy(button, true, 'กำลังตรวจ...');
  if (els.diagnosticsPanel) els.diagnosticsPanel.innerHTML = '<div class="empty-state compact">กำลังตรวจระบบ...</div>';
  try {
  const queue = await db.getAll('syncQueue').catch(() => []);
  const memos = await db.getAll('memos').catch(() => []);
  const photos = await db.getAll('photos').catch(() => []);
  const storage = await db.estimateStorage().catch(() => null);
  const locationStats = buildLocationRepairStats(memos, photos);
  let sessionEmail = '-';
  let cloudCheck = 'ยังไม่ได้เช็ก';
  let profileRole = state.profile?.role || '-';

  if (!isSupabaseConfigured) {
    cloudCheck = 'ไม่ได้ตั้งค่า VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY ใน Vercel หรือยังไม่ได้ Redeploy';
  } else if (!state.user) {
    cloudCheck = 'ตั้งค่า Supabase แล้ว แต่ยังไม่ได้เข้าสู่ระบบ';
  } else {
    sessionEmail = state.user.email || '-';
    try {
      const { error } = await supabase.from('profiles').select('id').limit(1);
      cloudCheck = error ? `เชื่อมต่อ DB ไม่ผ่าน: ${error.message}` : 'เชื่อมต่อ DB ผ่าน';
    } catch (error) {
      cloudCheck = `เชื่อมต่อ DB ไม่ผ่าน: ${error.message}`;
    }
  }

  const failed = queue.filter((item) => item.last_error);
  const activePhotos = photos.filter((item) => !item.deleted_at);
  const totalPhotoBytes = activePhotos.reduce((sum, item) => sum + Number(item.size_bytes || 0), 0);
  const totalOriginalPhotoBytes = activePhotos.reduce((sum, item) => sum + Number(item.original_size_bytes || item.size_bytes || 0), 0);
  const avgCompression = totalOriginalPhotoBytes ? Math.round((1 - (totalPhotoBytes / totalOriginalPhotoBytes)) * 100) : 0;
  const lines = [
    ['เวอร์ชัน', `${APP_VERSION} · boot ${window.TRAVEL_MEMO_BOOT_VERSION || '-'}`],
    ['ออนไลน์', navigator.onLine ? 'Online' : 'Offline'],
    ['App Cache', window.TRAVEL_MEMO_CACHE_NAME || `travel-memo-v${APP_VERSION.replaceAll('.', '-')}`],
    ['Map Provider', GOOGLE_MAPS_API_KEY ? 'Google Maps' : 'OpenStreetMap fallback'],
    ['Supabase Env', isSupabaseConfigured ? 'พร้อม' : 'ไม่พร้อม'],
    ['Auth Pending', isAuthPending() ? 'มีรายการ login ค้างอยู่' : 'ไม่มี'],
    ['บัญชี', sessionEmail],
    ['Role', profileRole],
    ['Cloud Check', cloudCheck],
    ['Memo ในเครื่อง', memos.filter((item) => !item.deleted_at).length],
    ['รูปในเครื่อง', activePhotos.length],
    ['Memo มีพิกัด', `${locationStats.withLocation}/${locationStats.total}`],
    ['Memo ซ่อมพิกัดได้', locationStats.ownRepairable],
    ['รูปมี GPS', locationStats.photosWithGps],
    ['ขนาดรูปหลังย่อ', bytesToSize(totalPhotoBytes)],
    ['ประหยัดพื้นที่รูป', avgCompression > 0 ? `${avgCompression}%` : '-'],
    ['Queue รอซิงก์', queue.length],
    ['Queue failed', failed.length],
    ['Queue syncing/retrying', queue.filter((item) => ['syncing','retrying'].includes(item.status)).length],
    ['Cloud Pull', state.cloudPullInProgress ? 'กำลังดึงข้อมูล' : (state.lastCloudPullAt ? `ล่าสุด ${formatClock(state.lastCloudPullAt)}` : '-')],
    ['Queue error', failed.length ? failed.map((item) => item.last_error).slice(0, 3).join(' | ') : 'ไม่มี'],
    ['Client errors', getClientErrorLog().length ? `${getClientErrorLog().length} รายการล่าสุด` : 'ไม่มี'],
    ['Viewport', `${Math.round(window.visualViewport?.width || window.innerWidth)} x ${Math.round(window.visualViewport?.height || window.innerHeight)}`],
    ['Keyboard', document.body.classList.contains('keyboard-open') ? 'เปิดอยู่' : 'ปิดอยู่'],
    ['Storage local', storage?.usage ? `${bytesToSize(storage.usage)} / ${bytesToSize(storage.quota || 0)}` : 'ไม่ทราบ']
  ];
  const healthCards = [
    ['Cloud', isSupabaseConfigured && state.user && cloudCheck === 'เชื่อมต่อ DB ผ่าน', cloudCheck],
    ['Queue', failed.length === 0, failed.length ? `${failed.length} รายการล้มเหลว` : 'ไม่มีคิวล้มเหลว'],
    ['Photo', activePhotos.length >= 0, `${activePhotos.length} รูป · ${bytesToSize(totalPhotoBytes)}`],
    ['Location', locationStats.missing === 0 || locationStats.ownRepairable === 0, locationStats.missing ? `${locationStats.missing} Memo ไม่มีพิกัด` : 'พิกัดครบ'],
    ['Cache', true, window.TRAVEL_MEMO_CACHE_NAME || `travel-memo-v${APP_VERSION.replaceAll('.', '-')}`]
  ];
  els.diagnosticsPanel.innerHTML = `
    <div class="diagnostics-health-strip">
      ${healthCards.map(([label, ok, value]) => `<span class="${ok ? 'ok' : 'warn'}">${tmIcon(ok ? 'check-in' : 'diagnostics')}<strong>${escapeHtml(label)}</strong><small>${escapeHtml(String(value))}</small></span>`).join('')}
    </div>
    <details class="diagnostics-detail-block" open>
      <summary>${tmIcon('diagnostics')}<span>รายละเอียดระบบ</span></summary>
      <div class="diagnostics-table">${lines.map(([label, value]) => `<div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(String(value))}</span></div>`).join('')}</div>
    </details>`;
  toast('ตรวจสถานะระบบแล้ว', { tone: 'success' });
  } catch (error) {
    els.diagnosticsPanel.innerHTML = `<div class="empty-state compact error-empty">ตรวจระบบไม่สำเร็จ: ${escapeHtml(error.message || String(error))}</div>`;
    toast(error.message || 'ตรวจระบบไม่สำเร็จ');
  } finally {
    setButtonBusy(button, false);
  }
}

function showNotice(message, options = {}) {
  clearTimeout(state.toastTimer);
  document.querySelectorAll('.tm-alert-popup').forEach((node) => node.remove());
  const tone = options.tone || (String(message || '').includes('ไม่สำเร็จ') || String(message || '').includes('ล้มเหลว') ? 'error' : options.type || 'info');
  const icon = tone === 'success' ? 'cloud-sync' : tone === 'warning' ? 'diagnostics' : tone === 'error' ? 'diagnostics' : tone === 'sync' ? 'sync' : 'app-mark';
  const popup = document.createElement('div');
  popup.className = `tm-alert-popup ${escapeHtml(tone)}`;
  popup.setAttribute('role', 'alert');
  popup.innerHTML = `
    <div class="tm-alert-icon">${tmIcon(icon)}</div>
    <div class="tm-alert-copy"><div class="tm-alert-message">${escapeHtml(String(message))}</div>${options.detail ? `<small>${escapeHtml(String(options.detail))}</small>` : ''}</div>
  `;
  document.body.appendChild(popup);
  requestAnimationFrame(() => popup.classList.add('show'));
  state.toastTimer = setTimeout(() => {
    popup.classList.remove('show');
    setTimeout(() => popup.remove(), 180);
  }, options.duration || (tone === 'error' ? 4600 : 3000));
}

function toast(message, options = {}) {
  showNotice(message, options);
}
