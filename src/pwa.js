export const CURRENT_SW_VERSION = '2.8.4';
const SW_VERSION_KEY = 'travel_memo_sw_version';
const BOOT_VERSION_KEY = 'travel_memo_boot_version';
const CURRENT_CACHE_NAME = 'travel-memo-v2-8-4';

function isTravelMemoCache(key) {
  return typeof key === 'string' && key.startsWith('travel-memo');
}

export async function clearTravelMemoCaches({ keepCurrent = true, unregister = false } = {}) {
  if ('serviceWorker' in navigator && unregister) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  }
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => isTravelMemoCache(key) && (!keepCurrent || key !== CURRENT_CACHE_NAME))
      .map((key) => caches.delete(key)));
  }
}

export async function unregisterServiceWorkersAndClearCaches() {
  await clearTravelMemoCaches({ keepCurrent: false, unregister: true });
}

export async function clearOldAppShellIfVersionChanged(appVersion = CURRENT_SW_VERSION) {
  if (typeof window === 'undefined') return false;
  try {
    const oldVersion = localStorage.getItem(SW_VERSION_KEY) || localStorage.getItem(BOOT_VERSION_KEY);
    if (oldVersion && oldVersion !== appVersion) {
      await clearTravelMemoCaches({ keepCurrent: false, unregister: true });
      sessionStorage.removeItem('travel_memo_reloaded_for_sw_done');
    }
    localStorage.setItem(SW_VERSION_KEY, appVersion);
    localStorage.setItem(BOOT_VERSION_KEY, appVersion);
    return Boolean(oldVersion && oldVersion !== appVersion);
  } catch (error) {
    console.warn('Unable to clear old app shell cache', error);
    return false;
  }
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.register(`/service-worker.js?v=${CURRENT_SW_VERSION}`, { updateViaCache: 'none' });
    await registration.update().catch(() => null);

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!sessionStorage.getItem('travel_memo_reloaded_for_sw_done')) {
        sessionStorage.setItem('travel_memo_reloaded_for_sw_done', '1');
        window.location.reload();
      }
    });

    if (registration.waiting) {
      registration.waiting.postMessage({ type: 'SKIP_WAITING', version: CURRENT_SW_VERSION });
    }
    if (registration.installing) {
      registration.installing.addEventListener('statechange', () => {
        if (registration.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING', version: CURRENT_SW_VERSION });
      });
    }
    return registration;
  } catch (error) {
    console.warn('Service worker registration failed', error);
    return null;
  }
}

export function setupPwaInstall(button) {
  let promptEvent = null;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    promptEvent = event;
    button?.classList.remove('hidden');
  });

  button?.addEventListener('click', async () => {
    if (!promptEvent) return;
    promptEvent.prompt();
    await promptEvent.userChoice;
    promptEvent = null;
    button.classList.add('hidden');
  });
}

export async function clearBrowserCachesAndReload() {
  await clearTravelMemoCaches({ keepCurrent: false, unregister: true });
  try {
    localStorage.removeItem(SW_VERSION_KEY);
    localStorage.removeItem(BOOT_VERSION_KEY);
  } catch (error) {
    console.warn('Unable to reset service worker version key', error);
  }
  sessionStorage.removeItem('travel_memo_reloaded_for_sw_done');
  const url = new URL(window.location.href);
  url.searchParams.set('cache_bust', Date.now().toString());
  url.searchParams.set('v', CURRENT_SW_VERSION);
  window.location.replace(url.toString());
}
