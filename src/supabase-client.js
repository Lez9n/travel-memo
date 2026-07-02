import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
export const PHOTO_BUCKET = import.meta.env.VITE_SUPABASE_PHOTO_BUCKET || 'travel-memo-photos';
export const APP_NAME = import.meta.env.VITE_APP_NAME || 'Travel Memo';

export const AUTH_PENDING_KEY = 'travel_memo_auth_pending';
export const AUTH_ERROR_KEY = 'travel_memo_last_auth_error';
export const AUTH_DEBUG_KEY = 'travel_memo_last_auth_debug';


export const isSupabaseConfigured = Boolean(
  SUPABASE_URL &&
  SUPABASE_ANON_KEY &&
  SUPABASE_URL.startsWith('https://') &&
  !SUPABASE_URL.includes('YOUR_PROJECT_REF') &&
  !SUPABASE_ANON_KEY.includes('YOUR_SUPABASE')
);

export const supabase = isSupabaseConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // v2.1.20 keeps the stable OAuth behavior from v2.1.7.
        // Supabase handles the PKCE callback in the browser when detectSessionInUrl is true.
        detectSessionInUrl: true,
        flowType: 'pkce',
        storageKey: 'travel-memo-supabase-auth'
      }
    })
  : null;


export function getCachedSupabaseSession() {
  try {
    const storages = [localStorage, sessionStorage];
    for (const storage of storages) {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i) || '';
        const lower = key.toLowerCase();
        if (!(key === 'travel-memo-supabase-auth' || key.startsWith('sb-') || lower.includes('auth-token'))) continue;
        const raw = storage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        const session = parsed?.currentSession || parsed?.session || parsed;
        if (session?.access_token && session?.user?.id) return session;
      }
    }
  } catch (error) {
    console.warn('Unable to read cached Supabase session', error);
  }
  return null;
}

export function getCachedAuthUser() {
  return getCachedSupabaseSession()?.user || null;
}

export async function getCurrentUser() {
  if (!supabase) return getCachedAuthUser();
  try {
    const { data, error } = await withTimeout(supabase.auth.getUser(), 9000, 'get-user-timeout');
    if (error) return getCachedAuthUser();
    return data.user || getCachedAuthUser();
  } catch (error) {
    console.warn('Unable to read current user; using cached auth user if available', error);
    return getCachedAuthUser();
  }
}

export async function getCurrentSession() {
  const cached = getCachedSupabaseSession();
  if (!supabase) return cached;
  try {
    const { data, error } = await withTimeout(supabase.auth.getSession(), 9000, 'get-session-timeout');
    if (error) return cached;
    return data.session || cached;
  } catch (error) {
    console.warn('Unable to read current session; using cached session if available', error);
    return cached;
  }
}


export function setAuthError(message) {
  try {
    const value = String(message || '').trim();
    if (value) localStorage.setItem(AUTH_ERROR_KEY, value);
  } catch (_) {}
}

export function clearAuthError() {
  try { localStorage.removeItem(AUTH_ERROR_KEY); } catch (_) {}
}

export function markAuthPending(reason = 'oauth') {
  try {
    sessionStorage.setItem(AUTH_PENDING_KEY, JSON.stringify({ reason, at: new Date().toISOString(), path: window.location.pathname }));
  } catch (_) {}
}

export function clearAuthPending() {
  try { sessionStorage.removeItem(AUTH_PENDING_KEY); } catch (_) {}
}

export function isAuthPending() {
  try { return Boolean(sessionStorage.getItem(AUTH_PENDING_KEY)); } catch (_) { return false; }
}

export function hasOAuthCallbackParams() {
  const params = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
  return Boolean(
    params.get('code') ||
    params.get('error') ||
    params.get('error_code') ||
    params.get('error_description') ||
    hash.get('access_token') ||
    hash.get('refresh_token') ||
    hash.get('error') ||
    hash.get('error_description')
  );
}

export function clearStaleLogoutMarkers() {
  try {
    sessionStorage.removeItem('tm_force_logout');
    localStorage.removeItem('tm_force_logout');
  } catch (error) {
    console.warn('Unable to clear stale logout markers', error);
  }
}

export async function completeOAuthRedirectIfNeeded() {
  if (!supabase) return null;
  const params = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
  const hasCode = Boolean(params.get('code'));
  const hasTokenHash = Boolean(hash.get('access_token') || hash.get('refresh_token'));
  const oauthError = params.get('error_description') || params.get('error') || hash.get('error_description') || hash.get('error');

  if (oauthError) {
    persistAuthDebug('oauth_error', oauthError);
    setAuthError(oauthError);
    clearAuthPending();
    cleanOAuthUrl(`auth_error=${encodeURIComponent(oauthError)}`);
    return null;
  }

  if (!hasCode && !hasTokenHash) return null;

  clearStaleLogoutMarkers();
  clearAuthError();

  // Supabase normally consumes PKCE callbacks automatically when detectSessionInUrl=true.
  // Some browsers/service-worker states can delay that, so v2.5.4 waits first and then
  // performs a single manual exchange fallback if a code is still present.
  let session = await waitForSupabaseSession(8000);
  if (!session?.user && hasCode && typeof supabase.auth.exchangeCodeForSession === 'function') {
    try {
      const { data, error } = await supabase.auth.exchangeCodeForSession(params.get('code'));
      if (error) throw error;
      session = data?.session || await waitForSupabaseSession(3500);
      persistAuthDebug('oauth_exchange_fallback', session?.user ? 'success' : 'no-session');
    } catch (error) {
      persistAuthDebug('oauth_exchange_fallback_error', error?.message || error);
    }
  }

  if (session?.user) {
    persistAuthDebug('oauth_success', 'session-ready');
    clearAuthPending();
    cleanOAuthUrl();
    return session;
  }

  const message = 'session_not_saved_after_google_login';
  persistAuthDebug('oauth_no_session_after_callback', window.location.href);
  setAuthError(message);
  clearAuthPending();
  cleanOAuthUrl(`auth_error=${encodeURIComponent(message)}`);
  return null;
}

async function waitForSupabaseSession(ms = 6000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    try {
      const { data, error } = await supabase.auth.getSession();
      if (!error && data?.session?.user) return data.session;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 220));
  }
  return null;
}

function cleanOAuthUrl(query = '') {
  try {
    const clean = `${window.location.origin}${window.location.pathname}${query ? `?${query}` : ''}`;
    window.history.replaceState({}, document.title, clean);
  } catch (_) {}
}

function persistAuthDebug(key, value) {
  try {
    localStorage.setItem(AUTH_DEBUG_KEY, JSON.stringify({ key, value: String(value || ''), at: new Date().toISOString() }));
  } catch (_) {}
}

export async function signInWithGoogle() {
  if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า Supabase');
  clearStaleLogoutMarkers();
  clearAuthError();
  markAuthPending('google');
  persistAuthDebug('google_login_start', window.location.origin);
  const redirectTo = `${window.location.origin}${window.location.pathname}`;
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      scopes: 'openid email profile',
      queryParams: { prompt: 'select_account' }
    }
  });
  if (error) throw error;
  return data;
}

export async function signInWithProvider(provider) {
  if (provider !== 'google') throw new Error('Travel Memo v2.5.4 รองรับ Google Login เท่านั้น');
  return signInWithGoogle();
}

function authStorageKeyShouldBeRemoved(key) {
  if (!key) return false;
  const lower = String(key).toLowerCase();
  return (
    key.startsWith('sb-') ||
    lower.includes('supabase.auth') ||
    lower.includes('auth-token') ||
    lower.includes('gotrue') ||
    lower.includes('pkce') ||
    lower.includes('code-verifier') ||
    lower.includes('tm_force_logout') ||
    lower.includes('travel_memo_session') ||
    key === AUTH_PENDING_KEY ||
    key === AUTH_ERROR_KEY ||
    key === AUTH_DEBUG_KEY ||
    key === 'travel-memo-supabase-auth'
  );
}

export function clearSupabaseAuthStorage() {
  for (const storage of [localStorage, sessionStorage]) {
    try {
      const keys = [];
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (authStorageKeyShouldBeRemoved(key)) keys.push(key);
      }
      keys.forEach((key) => storage.removeItem(key));
    } catch (error) {
      console.warn('Unable to clear Supabase auth storage', error);
    }
  }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms))
  ]);
}

export async function signOut() {
  try {
    if (supabase) {
      await withTimeout(supabase.auth.signOut({ scope: 'global' }), 2500, 'global-signout-timeout').catch((error) => {
        console.warn('global sign out failed or timed out', error);
      });
      await withTimeout(supabase.auth.signOut({ scope: 'local' }), 1500, 'local-signout-timeout').catch((error) => {
        console.warn('local sign out failed or timed out', error);
      });
    }
  } finally {
    clearAuthPending();
    clearSupabaseAuthStorage();
  }
}


export async function ensureProfile(user) {
  if (!supabase || !user) return null;
  const metadata = user.user_metadata || {};
  const appMetadata = user.app_metadata || {};
  const profile = {
    id: user.id,
    email: user.email,
    display_name: metadata.full_name || metadata.name || metadata.user_name || user.email?.split('@')[0] || 'Traveler',
    avatar_url: metadata.avatar_url || metadata.picture || metadata.photo_url || '',
    provider: appMetadata.provider || 'google',
    updated_at: new Date().toISOString()
  };

  const { data: existing, error: readError } = await supabase
    .from('profiles')
    .select('id,email,display_name,avatar_url,role,created_at')
    .eq('id', user.id)
    .maybeSingle();

  if (readError && readError.code !== 'PGRST116') throw readError;

  if (!existing) {
    const { data, error } = await supabase
      .from('profiles')
      .insert({ ...profile, role: 'user' })
      .select('id,email,display_name,avatar_url,role,created_at')
      .single();
    if (error) throw error;
    return data;
  }

  const patch = {
    email: profile.email,
    display_name: existing.display_name || profile.display_name,
    avatar_url: profile.avatar_url || existing.avatar_url || '',
    updated_at: profile.updated_at
  };
  const { data, error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', user.id)
    .select('id,email,display_name,avatar_url,role,created_at')
    .single();
  if (error) throw error;
  return data;
}

export function normalizeStoragePath(path) {
  if (!path) return '';
  const value = String(path).trim();
  if (!value || value === 'null' || value === 'undefined') return '';
  if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('blob:') || value.startsWith('data:')) return value;
  return value.replace(/^\/+/, '');
}

export function createPublicPhotoUrl(path) {
  const normalized = normalizeStoragePath(path);
  if (!normalized) return '';
  if (normalized.startsWith('http://') || normalized.startsWith('https://') || normalized.startsWith('blob:') || normalized.startsWith('data:')) return normalized;
  if (supabase) {
    const { data } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(normalized);
    if (data?.publicUrl) return data.publicUrl;
  }
  if (!SUPABASE_URL) return '';
  return `${SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/public/${PHOTO_BUCKET}/${encodeURI(normalized).replace(/%2F/g, '/')}`;
}

export async function createSignedUrl(path, expiresIn = 3600) {
  if (!supabase || !path) return '';
  const normalized = normalizeStoragePath(path);
  if (!normalized) return '';
  if (normalized.startsWith('http://') || normalized.startsWith('https://') || normalized.startsWith('blob:') || normalized.startsWith('data:')) return normalized;
  const { data, error } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrl(normalized, expiresIn);
  if (error) {
    console.warn('Unable to create signed URL', error);
    return '';
  }
  return data?.signedUrl || '';
}
