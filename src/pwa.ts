/**
 * pwa.ts — Progressive Web App registration and update handling.
 *
 * Registers the service worker, handles update notifications, manages
 * the install prompt, and provides an API for interacting with the SW
 * cache (used by the asset bundler to pre-populate the offline cache).
 *
 * Features:
 * - Service worker registration with periodic update checks
 * - beforeinstallprompt capture for deferred install UI
 * - Update detection with callback notification
 * - Cache management (bulk cache, clear, size estimation)
 * - Persistent storage request
 * - Online/offline status tracking
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback fired when a new SW version is available. */
type UpdateCallback = (apply: () => void) => void;

/** Callback fired when online/offline status changes. */
type ConnectivityCallback = (online: boolean) => void;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _swRegistration: ServiceWorkerRegistration | null = null;
let _deferredInstallPrompt: BeforeInstallPromptEvent | null = null;
let _updateCallback: UpdateCallback | null = null;
let _connectivityCallbacks: ConnectivityCallback[] = [];
let _isOnline: boolean = typeof navigator !== 'undefined' ? navigator.onLine : true;

/**
 * Chrome's BeforeInstallPromptEvent (not in lib.dom.d.ts).
 */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Service worker registration
// ---------------------------------------------------------------------------

/**
 * Register the service worker. Call once at app startup.
 * Returns the registration object, or null if SW is not supported.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) {
    console.info('[PWA] Service workers not supported');
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
    });

    _swRegistration = registration;
    console.info('[PWA] Service worker registered, scope:', registration.scope);

    // Check for updates periodically (every 60 minutes)
    setInterval(() => {
      registration.update().catch(() => {
        // Silently ignore update check failures
      });
    }, 60 * 60 * 1000);

    // Listen for new service worker versions
    registration.addEventListener('updatefound', () => {
      const newWorker = registration.installing;
      if (!newWorker) return;

      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          // New version installed and waiting to activate.
          // This means a previous version was already controlling the page.
          console.info('[PWA] New service worker version available');
          if (_updateCallback) {
            _updateCallback(() => {
              applyUpdate();
              window.location.reload();
            });
          }
        }

        if (newWorker.state === 'activated') {
          console.info('[PWA] New service worker activated');
        }
      });
    });

    // If there's already a waiting worker on load, notify immediately
    if (registration.waiting && navigator.serviceWorker.controller) {
      if (_updateCallback) {
        _updateCallback(() => {
          applyUpdate();
          window.location.reload();
        });
      }
    }

    return registration;
  } catch (err) {
    console.warn('[PWA] Service worker registration failed:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Install prompt handling
// ---------------------------------------------------------------------------

/**
 * Set up install prompt capture. Call early (before DOMContentLoaded).
 * Captures the `beforeinstallprompt` event so we can show an install
 * button at an appropriate time in the game UI.
 */
export function setupInstallPrompt(): void {
  window.addEventListener('beforeinstallprompt', (e: Event) => {
    // Prevent the default mini-infobar on mobile
    e.preventDefault();
    _deferredInstallPrompt = e as BeforeInstallPromptEvent;
    console.info('[PWA] Install prompt captured — call showInstallPrompt() to display');
  });

  // Track when the app is installed
  window.addEventListener('appinstalled', () => {
    _deferredInstallPrompt = null;
    console.info('[PWA] App was installed');
  });
}

/**
 * Check if an install prompt is available to show.
 */
export function canInstall(): boolean {
  return _deferredInstallPrompt !== null;
}

/**
 * Show the browser's native install prompt.
 * Returns the user's choice: 'accepted' or 'dismissed'.
 * Returns null if no prompt is available.
 */
export async function showInstallPrompt(): Promise<'accepted' | 'dismissed' | null> {
  if (!_deferredInstallPrompt) return null;

  try {
    await _deferredInstallPrompt.prompt();
    const choice = await _deferredInstallPrompt.userChoice;
    console.info(`[PWA] Install prompt result: ${choice.outcome}`);

    // The prompt can only be used once
    _deferredInstallPrompt = null;
    return choice.outcome;
  } catch (err) {
    console.warn('[PWA] Install prompt failed:', err);
    _deferredInstallPrompt = null;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Update notification
// ---------------------------------------------------------------------------

/**
 * Register a callback to be notified when a new version is available.
 * The callback receives an `apply` function — call it to activate the
 * new version and reload the page.
 */
export function onUpdateAvailable(callback: UpdateCallback): void {
  _updateCallback = callback;
}

/**
 * Check if an update is available for the service worker.
 */
export async function checkForUpdate(): Promise<boolean> {
  if (!_swRegistration) return false;
  try {
    await _swRegistration.update();
    return _swRegistration.waiting !== null;
  } catch {
    return false;
  }
}

/**
 * Force the waiting service worker to activate immediately.
 * Should be followed by a page reload.
 */
export function applyUpdate(): void {
  const waiting = _swRegistration?.waiting;
  if (waiting) {
    waiting.postMessage({ type: 'SKIP_WAITING' });
  }
}

// ---------------------------------------------------------------------------
// Connectivity tracking
// ---------------------------------------------------------------------------

/**
 * Set up online/offline event listeners. Call once at startup.
 */
export function setupConnectivityTracking(): void {
  _isOnline = navigator.onLine;

  window.addEventListener('online', () => {
    _isOnline = true;
    console.info('[PWA] Back online');
    for (const cb of _connectivityCallbacks) cb(true);
  });

  window.addEventListener('offline', () => {
    _isOnline = false;
    console.info('[PWA] Gone offline');
    for (const cb of _connectivityCallbacks) cb(false);
  });
}

/**
 * Register a callback for online/offline changes.
 */
export function onConnectivityChange(callback: ConnectivityCallback): void {
  _connectivityCallbacks.push(callback);
}

/**
 * Check if the app is currently online.
 */
export function isOnline(): boolean {
  return _isOnline;
}

// ---------------------------------------------------------------------------
// Cache management API (communicates with the SW via postMessage)
// ---------------------------------------------------------------------------

/**
 * Request the service worker to cache a list of asset URLs.
 * Used by the asset bundler after extracting a .ltproj zip.
 */
export function cacheAssets(urls: string[]): void {
  const sw = navigator.serviceWorker?.controller;
  if (!sw) {
    console.warn('[PWA] No active service worker to cache assets');
    return;
  }
  sw.postMessage({ type: 'CACHE_ASSETS', payload: { urls } });
}

/**
 * Clear the asset cache (e.g., when loading a different project).
 */
export function clearAssetCache(): void {
  const sw = navigator.serviceWorker?.controller;
  if (!sw) return;
  sw.postMessage({ type: 'CLEAR_ASSET_CACHE' });
}

/**
 * Get the current cache size estimate.
 * Returns { usage: number, quota: number } in bytes.
 */
export async function getCacheSize(): Promise<{ usage: number; quota: number }> {
  if ('storage' in navigator && 'estimate' in navigator.storage) {
    const estimate = await navigator.storage.estimate();
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
  }
  return { usage: 0, quota: 0 };
}

/**
 * Request persistent storage so the browser doesn't evict our cache.
 * Returns true if persistence was granted.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if ('storage' in navigator && 'persist' in navigator.storage) {
    return navigator.storage.persist();
  }
  return false;
}

// ---------------------------------------------------------------------------
// App state detection
// ---------------------------------------------------------------------------

/**
 * Check if the app is running as a PWA (installed / standalone mode).
 */
export function isStandaloneMode(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    (navigator as any).standalone === true // iOS Safari
  );
}

/**
 * Get comprehensive PWA status for display/debugging.
 */
export function getPwaStatus(): {
  standalone: boolean;
  online: boolean;
  swActive: boolean;
  swWaiting: boolean;
  installable: boolean;
} {
  return {
    standalone: isStandaloneMode(),
    online: _isOnline,
    swActive: !!navigator.serviceWorker?.controller,
    swWaiting: !!_swRegistration?.waiting,
    installable: canInstall(),
  };
}
