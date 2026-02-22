#!/usr/bin/env node
/**
 * setup-native.mjs — Set up Capacitor and/or TWA for native mobile builds.
 *
 * Usage:
 *   node scripts/setup-native.mjs capacitor   # Set up Capacitor (iOS + Android)
 *   node scripts/setup-native.mjs twa         # Set up TWA (Android only, via bubblewrap)
 *   node scripts/setup-native.mjs             # Show help
 *
 * Capacitor prerequisites:
 *   - Xcode (for iOS builds)
 *   - Android Studio (for Android builds)
 *   - CocoaPods (for iOS: `sudo gem install cocoapods`)
 *
 * TWA prerequisites:
 *   - Node.js 16+
 *   - Android SDK (bundled with Android Studio)
 *   - Java 11+ JDK
 *   - A deployed HTTPS site with the game + .well-known/assetlinks.json
 *
 * Both approaches start with the same web build:
 *   1. npm run build         (builds TypeScript to dist/)
 *   2. npm run bundle        (optional: packs .ltproj assets into dist/bundles/)
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';

const mode = process.argv[2];

function run(cmd, opts = {}) {
  console.log(`\n  > ${cmd}\n`);
  try {
    execSync(cmd, { stdio: 'inherit', ...opts });
  } catch (err) {
    console.error(`Command failed: ${cmd}`);
    process.exit(1);
  }
}

function checkCommand(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Capacitor setup
// ---------------------------------------------------------------------------

function setupCapacitor() {
  console.log('=== Setting up Capacitor for iOS/Android ===\n');

  // 1. Install Capacitor packages
  console.log('Step 1: Installing Capacitor packages...');
  run('npm install @capacitor/core @capacitor/cli --save-dev');

  // 2. Optional: install useful plugins
  console.log('\nStep 2: Installing recommended plugins...');
  run('npm install @capacitor/status-bar @capacitor/splash-screen --save-dev');

  // 3. Build the web app first
  console.log('\nStep 3: Building web app...');
  run('npm run build');

  // 4. Add platforms
  console.log('\nStep 4: Adding native platforms...');

  if (checkCommand('xcodebuild')) {
    if (!existsSync('ios')) {
      run('npx cap add ios');
    } else {
      console.log('  ios/ already exists, skipping.');
    }
  } else {
    console.log('  Xcode not found — skipping iOS. Install Xcode from the Mac App Store.');
  }

  if (process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || checkCommand('sdkmanager')) {
    if (!existsSync('android')) {
      run('npx cap add android');
    } else {
      console.log('  android/ already exists, skipping.');
    }
  } else {
    console.log('  Android SDK not found — skipping Android. Install Android Studio.');
  }

  // 5. Sync web build to native projects
  console.log('\nStep 5: Syncing web build to native projects...');
  run('npx cap sync');

  console.log(`
=== Capacitor setup complete! ===

Next steps:

  iOS:
    npx cap open ios          # Opens Xcode
    # Select a signing team, then Build & Run

  Android:
    npx cap open android      # Opens Android Studio
    # Build & Run on a device or emulator

  Development workflow:
    1. npm run dev             # Run Vite dev server
    2. npx cap run ios --livereload --external
       OR
       npx cap run android --livereload --external

  Production build:
    1. npm run build
    2. npm run bundle          # optional: include game data
    3. npx cap sync
    4. Build from Xcode/Android Studio

  For offline game data, run:
    npm run bundle
    cp -r public/bundles dist/bundles
    npx cap sync
`);
}

// ---------------------------------------------------------------------------
// TWA setup (Android only, via bubblewrap)
// ---------------------------------------------------------------------------

function setupTwa() {
  console.log('=== Setting up Trusted Web Activity (TWA) for Android ===\n');
  console.log('TWA wraps your deployed web app in a thin Android shell.');
  console.log('The game MUST be hosted on HTTPS for TWA to work.\n');

  // Check prerequisites
  if (!checkCommand('java')) {
    console.error('Error: Java JDK not found. Install Java 11+ JDK first.');
    process.exit(1);
  }

  // Install bubblewrap
  console.log('Step 1: Installing bubblewrap (TWA builder)...');
  run('npm install @nickersoft/bubblewrap --save-dev');

  console.log(`
=== TWA setup notes ===

Before building a TWA, you need:

  1. Deploy your game to an HTTPS URL (e.g., https://lextalionis.example.com)

  2. Update twa-manifest.json:
     - Set "host" to your domain
     - Set "startUrl" to the path on your host
     - Update "packageId" for your app

  3. Set up Digital Asset Links for your domain:
     - Add /.well-known/assetlinks.json to your server
     - See: https://developer.android.com/training/app-links/verify-site-associations

  4. Build the TWA:
     npx bubblewrap build --manifest twa-manifest.json

  5. The APK/AAB will be generated in the twa/ directory.
     Upload to Google Play Store.

  Alternative: Use PWA Builder (https://www.pwabuilder.com/)
  - Enter your game URL
  - It generates a ready-to-submit Play Store package
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (!mode || mode === 'help') {
  console.log(`
Usage: node scripts/setup-native.mjs <mode>

Modes:
  capacitor   Set up Capacitor for iOS + Android native builds
              (bundles the web app inside a native WebView shell)

  twa         Set up TWA (Trusted Web Activity) for Android
              (thin wrapper around your deployed HTTPS web app)

Both modes produce native mobile apps suitable for app store distribution.

Capacitor pros:
  + Works offline (bundles all assets)
  + Access to native APIs (camera, filesystem, etc.)
  + Works on both iOS and Android
  + No HTTPS hosting required

TWA pros:
  + Smaller APK size (loads from web)
  + Automatic updates (no app store review)
  + Uses Chrome's rendering engine
  + Simpler setup
  `);
  process.exit(0);
}

if (mode === 'capacitor') {
  setupCapacitor();
} else if (mode === 'twa') {
  setupTwa();
} else {
  console.error(`Unknown mode: ${mode}`);
  console.error('Use "capacitor" or "twa"');
  process.exit(1);
}
