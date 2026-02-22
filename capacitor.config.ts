/**
 * Capacitor configuration for native iOS/Android builds.
 *
 * This wraps the web-built game in a native WebView shell for
 * app store distribution on iOS and Android.
 *
 * Prerequisites:
 *   npm install @capacitor/core @capacitor/cli   (already in devDependencies)
 *   npx cap add ios       # adds ios/ directory (requires Xcode)
 *   npx cap add android   # adds android/ directory (requires Android Studio)
 *
 * Quick start:
 *   npm run setup:capacitor     # interactive setup (installs, builds, syncs)
 *
 * Manual workflow:
 *   1. npm run build            # build the web app to dist/
 *   2. npm run bundle           # optional: pack .ltproj into dist/bundles/
 *   3. npx cap sync             # copy dist/ to native projects + sync plugins
 *   4. npx cap open ios         # open in Xcode → Build & Run
 *      npx cap open android     # open in Android Studio → Build & Run
 *
 * Development with live reload:
 *   1. npm run dev                              # start Vite dev server
 *   2. Uncomment the `server.url` line below and set to your LAN IP
 *   3. npx cap run ios --livereload --external
 *      npx cap run android --livereload --external
 *
 * For offline play, bundle the game data:
 *   npm run bundle
 *   cp -r public/bundles dist/bundles
 *   npx cap sync
 */

import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.lextalionis.web',
  appName: 'Lex Talionis',
  webDir: 'dist',

  // Server configuration
  server: {
    // Uncomment for live reload during development:
    // url: 'http://192.168.1.xxx:3000',
    // cleartext: true,

    // Use HTTPS scheme on Android for service worker support
    androidScheme: 'https',

    // Allow loading from localhost in debug builds
    allowNavigation: ['localhost'],
  },

  // iOS-specific settings
  ios: {
    contentInset: 'automatic',
    allowsLinkPreview: false,
    preferredContentMode: 'mobile',
    // Disable bounce/overscroll for game feel
    scrollEnabled: false,
  },

  // Android-specific settings
  android: {
    backgroundColor: '#000000',
    allowMixedContent: true,
    // Immersive mode for full-screen gaming (hides nav/status bars)
    // Handled via the StatusBar plugin at runtime
  },

  // Plugin configuration
  plugins: {
    // StatusBar — hide for fullscreen gaming
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#000000',
    },

    // SplashScreen — show a brief splash while the WebView loads
    SplashScreen: {
      launchShowDuration: 2000,
      launchAutoHide: true,
      backgroundColor: '#000000',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      // Use the PWA icons as splash screen
      splashFullScreen: true,
      splashImmersive: true,
    },

    // KeepAwake — prevent screen dimming during gameplay
    // Install: npm install @capacitor-community/keep-awake
    // KeepAwake: {},

    // Screen Orientation — lock if desired
    // Install: npm install @capacitor/screen-orientation
    // ScreenOrientation: {},
  },
};

export default config;
