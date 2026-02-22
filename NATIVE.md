# Native Mobile Builds

Lex Talionis Web supports two paths for native mobile distribution:

1. **Capacitor** — full native wrapper for iOS and Android (recommended)
2. **TWA** — Trusted Web Activity for Android (lighter, PWA-based)

---

## Option 1: Capacitor (iOS + Android)

Capacitor wraps the web app in a native WebView. This gives you:
- App store distribution (iOS App Store, Google Play)
- Full native API access (keep-awake, orientation lock, haptics)
- Offline support via bundled assets

### Setup

```bash
# Install Capacitor (already in devDependencies)
npm install

# Add native platforms
npx cap add ios
npx cap add android

# Build the web app
npm run build

# Optional: bundle game assets for offline play
npm run bundle
cp public/bundles/default.ltproj.zip dist/bundles/

# Sync web build to native projects
npx cap sync
```

### Development

```bash
# Live reload on device
npx cap run ios --livereload --external
npx cap run android --livereload --external

# Open in IDE
npx cap open ios       # opens Xcode
npx cap open android   # opens Android Studio
```

### Building for Release

**iOS:**
1. `npx cap open ios`
2. In Xcode: Product → Archive → Distribute App

**Android:**
1. `npx cap open android`
2. In Android Studio: Build → Generate Signed Bundle/APK

### Recommended Plugins

```bash
# Keep screen awake during gameplay
npm install @capacitor-community/keep-awake

# Lock screen orientation
npm install @capacitor/screen-orientation

# Hide status bar for fullscreen
npm install @capacitor/status-bar

# Haptic feedback for button presses
npm install @capacitor/haptics
```

---

## Option 2: TWA (Android only)

A Trusted Web Activity wraps the PWA in Chrome Custom Tabs — no WebView,
just Chrome rendering the PWA without browser UI. Lighter than Capacitor
but requires the PWA to be hosted at a public HTTPS URL.

### Prerequisites

1. Host the PWA at a public HTTPS URL
2. Ensure the service worker and manifest are working
3. Set up Digital Asset Links (`.well-known/assetlinks.json`)

### Setup with Bubblewrap

```bash
# Install Bubblewrap CLI
npm install -g @nicweb/nicandmicah

# Initialize from your hosted manifest
npx bubblewrap init --manifest https://your-domain.com/manifest.json

# Build the APK
npx bubblewrap build
```

### Configuration

Edit `twa/bubblewrap.config.json`:
- Set `host` to your actual domain
- Update signing key path and alias
- Bump `appVersionCode` for each release

### Digital Asset Links

Create `.well-known/assetlinks.json` on your web server:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.lextalionis.web",
    "sha256_cert_fingerprints": ["YOUR_SHA256_FINGERPRINT"]
  }
}]
```

Get your fingerprint:
```bash
keytool -list -v -keystore lt-web-keystore.jks -alias lt-web
```

---

## Asset Bundling for Offline Play

For native builds, you want game assets available offline:

```bash
# Create the asset bundle
npm run bundle

# Copy to the web build directory
mkdir -p dist/bundles
cp public/bundles/default.ltproj.zip dist/bundles/

# Sync to native projects
npx cap sync
```

The app automatically detects and loads the bundle on startup.
