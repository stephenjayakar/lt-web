/**
 * native.ts — Native platform integration for Capacitor / TWA builds.
 *
 * Detects when the app is running inside a Capacitor WebView or TWA
 * wrapper and provides platform-specific features:
 *
 * - Status bar hiding (fullscreen)
 * - Screen wake lock (prevent dimming during gameplay)
 * - Safe area insets for notched devices
 * - Back button handling (Android)
 * - App state lifecycle (pause/resume for audio)
 *
 * All features are optional — the game runs fine in a normal browser.
 * Native plugins are loaded dynamically to avoid import errors when
 * the packages aren't installed.
 */

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

/** Check if running inside a Capacitor WebView. */
export function isCapacitor(): boolean {
  return typeof (window as any).Capacitor !== 'undefined';
}

/** Check if running as a TWA (Trusted Web Activity). */
export function isTwa(): boolean {
  // TWA sets document.referrer to android-app://
  return document.referrer.startsWith('android-app://');
}

/** Check if running as an installed PWA. */
export function isInstalledPwa(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches ||
    (navigator as any).standalone === true
  );
}

/** Get the current platform type. */
export type Platform = 'capacitor-ios' | 'capacitor-android' | 'twa' | 'pwa' | 'browser';

export function getPlatform(): Platform {
  if (isCapacitor()) {
    const cap = (window as any).Capacitor;
    const platform = cap.getPlatform?.() ?? 'web';
    if (platform === 'ios') return 'capacitor-ios';
    if (platform === 'android') return 'capacitor-android';
  }
  if (isTwa()) return 'twa';
  if (isInstalledPwa()) return 'pwa';
  return 'browser';
}

// ---------------------------------------------------------------------------
// Native feature initialization
// ---------------------------------------------------------------------------

/**
 * Initialize native platform features. Call once at app startup.
 * Safe to call in any environment (browser, PWA, Capacitor, TWA).
 */
export async function initNativePlatform(): Promise<void> {
  const platform = getPlatform();
  console.info(`[Native] Platform: ${platform}`);

  if (isCapacitor()) {
    await initCapacitor();
  }

  // Screen Wake Lock API (works in modern browsers + PWAs + Capacitor)
  await requestWakeLock();

  // Handle visibility change (pause audio when app is backgrounded)
  setupVisibilityHandler();
}

// ---------------------------------------------------------------------------
// Capacitor initialization
// ---------------------------------------------------------------------------

async function initCapacitor(): Promise<void> {
  // Use string-based dynamic imports to avoid TS errors when
  // Capacitor plugins aren't installed as dependencies.
  // These are only loaded at runtime inside a Capacitor WebView.
  try {
    const statusBarModule: any = await (Function('return import("@capacitor/status-bar")')());
    const StatusBar = statusBarModule.StatusBar;
    const Style = statusBarModule.Style;
    await StatusBar.hide();
    await StatusBar.setStyle({ style: Style.Dark });
    console.info('[Native] Status bar hidden');
  } catch {
    // Plugin not installed — that's fine
  }

  try {
    const splashModule: any = await (Function('return import("@capacitor/splash-screen")')());
    const SplashScreen = splashModule.SplashScreen;
    await SplashScreen.hide();
  } catch {
    // Plugin not installed — that's fine
  }

  // Handle Android back button
  const cap = (window as any).Capacitor;
  if (cap.getPlatform?.() === 'android') {
    setupAndroidBackButton();
  }
}

// ---------------------------------------------------------------------------
// Screen Wake Lock
// ---------------------------------------------------------------------------

let _wakeLock: any = null;

/**
 * Request a screen wake lock to prevent the device from sleeping
 * during gameplay. Uses the Screen Wake Lock API (supported in
 * Chrome 84+, Edge 84+, Safari 16.4+).
 */
async function requestWakeLock(): Promise<void> {
  if (!('wakeLock' in navigator)) return;

  try {
    _wakeLock = await (navigator as any).wakeLock.request('screen');
    console.info('[Native] Wake lock acquired');

    _wakeLock.addEventListener('release', () => {
      console.info('[Native] Wake lock released');
    });
  } catch (err) {
    // Wake lock request failed (e.g., page not visible)
    console.info('[Native] Wake lock not available:', (err as Error).message);
  }
}

/** Re-acquire wake lock when the page becomes visible again. */
async function reacquireWakeLock(): Promise<void> {
  if (_wakeLock !== null && _wakeLock.released) {
    await requestWakeLock();
  }
}

// ---------------------------------------------------------------------------
// Visibility handling
// ---------------------------------------------------------------------------

/** Callbacks to notify when app is paused/resumed. */
let _pauseCallbacks: (() => void)[] = [];
let _resumeCallbacks: (() => void)[] = [];

export function onAppPause(callback: () => void): void {
  _pauseCallbacks.push(callback);
}

export function onAppResume(callback: () => void): void {
  _resumeCallbacks.push(callback);
}

function setupVisibilityHandler(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      for (const cb of _pauseCallbacks) cb();
    } else {
      for (const cb of _resumeCallbacks) cb();
      reacquireWakeLock();
    }
  });
}

// ---------------------------------------------------------------------------
// Android back button
// ---------------------------------------------------------------------------

function setupAndroidBackButton(): void {
  // Capacitor's App plugin handles hardware back button
  // We prevent the default behavior (exit app) and instead
  // let the game's input system handle BACK actions
  document.addEventListener('backbutton', (e) => {
    e.preventDefault();
    // The InputManager already handles Escape/Back key
    // This just prevents the app from closing
  });
}

// ---------------------------------------------------------------------------
// Safe area insets
// ---------------------------------------------------------------------------

/**
 * Get safe area insets for notched devices (iPhone X+, Android punch holes).
 * Returns CSS env() values as pixel numbers, or 0 if not supported.
 */
export function getSafeAreaInsets(): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  const getInset = (pos: string): number => {
    const el = document.createElement('div');
    el.style.position = 'fixed';
    el.style.width = '0';
    el.style.height = '0';
    el.style.setProperty('--sat', `env(safe-area-inset-${pos}, 0px)`);
    el.style.paddingTop = 'var(--sat)';
    document.body.appendChild(el);
    const value = el.offsetHeight;
    document.body.removeChild(el);
    return value;
  };

  return {
    top: getInset('top'),
    right: getInset('right'),
    bottom: getInset('bottom'),
    left: getInset('left'),
  };
}
