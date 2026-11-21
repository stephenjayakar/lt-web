1. Download [lt-maker](https://gitlab.com/rainlash/lt-maker), and put it in this folder
2. `npm i`
3. `npm run dev`

## Embrace of the Fog

The compatibility target is
[`LordTweed/Tweeds_Roguelite`](https://gitlab.com/LordTweed/tweeds_roguelite)
at commit `a500736e` (project metadata `EotF` 2.0.1, the version the official
release ships). The project data is not part of the lt-web distribution.
Install an authorized copy at the stable path used by the audit, build, and
browser:

```bash
git clone https://gitlab.com/LordTweed/tweeds_roguelite.git lt-maker/eotf-source
git -C lt-maker/eotf-source checkout a500736e
ln -s eotf-source/Gacha_Game.ltproj lt-maker/eotf.ltproj
npm run audit:eotf
npm run dev
```

Choose **Embrace of the Fog** in the campaign picker.

### Browser package

Create a static browser distribution with the campaign packed into the asset
bundle:

```bash
npm run stage:engine-assets
npm run bundle -- lt-maker/eotf.ltproj public/bundles/eotf.ltproj.zip
npm run build
npm run preview
```

Deploy the contents of `dist/` at the site root. The generated app manifest and
service worker provide installable/offline app-shell behavior; the EOtF bundle
is loaded from `/bundles/eotf.ltproj.zip`. Generate the bundle locally and do
not commit it.

`stage:engine-assets` is required, not optional. `vite dev` serves `/game-data/`
directly out of `lt-maker/`, but a production build has no such middleware and
the campaign zip covers only the `.ltproj` directory. Without the staging step
a packaged deployment boots the campaign with no fonts, menu sprites, or combat
platforms. Both `public/game-data/` and `public/bundles/` are generated and
gitignored.

### Hosted site build

The hosted static site (25 MiB per file) cannot serve the single 387 MB
bundle. `npm run build:site` builds `dist/` for it instead, straight from
`lt-maker/eotf.ltproj` and the engine assets (no staging or bundle step
needed):

```bash
CONVEX_URL=https://<deployment>.convex.cloud npm run build:site
```

Game data ships as content-hashed packs, `dist/packs/<sha256>.bin` plus
`dist/packs/manifest.json` (`scripts/lib/asset-packs.mjs`). The client
(`src/packs/`) downloads the ~30 MB the title needs, then music in the
background; music intro/battle variants, which the web engine never plays,
load only on request. Chunks are verified and kept in Cache Storage by hash,
so returning visits and redeploys download only changed packs. The manifest is
saved there too: a return visit waits at most 4 s for a fresh one and
otherwise boots from the saved copy, so the game starts offline or on a
hanging connection (`src/packs/hosted.ts`). The service worker serves the app
shell cache-first (`public/sw.js`); it leaves `/packs/` to the page. Files Lex
Talionis can never load (music not in `music.json`, Python sources) are
dropped and PNGs are re-encoded losslessly.

To fit the host's 256 MiB archive cap, `build:site` (only) re-encodes the music
with libvorbis — `oggenc` from vorbis-tools, decoding via ffmpeg (`brew install
ffmpeg vorbis-tools`) — at `--music-quality 5` (~160 kbps; `off` keeps the
originals). Names, sample rate, channels and decoded sample counts are
unchanged (each track is verified); transcodes are cached by source hash and
quality. EOtF's `dist/` is about 163 MiB. The build fails if any file reaches
25 MiB, `dist/` reaches 240 MiB, or raw game assets leak outside `dist/packs/`.

### Saves and upgrades

Saves are **local-first** in every build. Save slots and suspend data live in
the `lt-web-saves` IndexedDB database (with a `localStorage` fallback using the
`lt-save:` prefix), and persistent records/achievements/settings in
`localStorage` (`lt-persistent-records-<game-nid>`,
`lt-achievements-<game-nid>`, `lt-web-settings`). A save resolves as soon as
the local write finishes. When the build has a Convex deployment URL
(`VITE_CONVEX_URL`) and the owner is signed in, the same data is mirrored to
Convex in the background and synced between devices (see
[Cloud saves](#cloud-saves-convex)). Save payloads carry a version and are
migrated during load.

### Cloud saves (Convex)

| | Dev | Prod |
|---|---|---|
| Deployment | `dev:<dev-deployment>` | `prod:<prod-deployment>` |
| `VITE_CONVEX_URL` | `https://<dev-deployment>.convex.cloud` | `https://<prod-deployment>.convex.cloud` |
| Google OAuth redirect URI | `https://<dev-deployment>.convex.site/api/auth/callback/google` | `https://<prod-deployment>.convex.site/api/auth/callback/google` |

`.env.local` (gitignored, written by `npx convex dev`) points `npm run dev` at
dev. To run or build against prod, override the URL:
`VITE_CONVEX_URL=https://<prod-deployment>.convex.cloud npm run dev` (or `npm
run build`). Leave `VITE_CONVEX_URL` unset for a local-only build.

- **Auth**: Convex Auth with Google sign-in. Only verified Google emails in the
  deployment's `ALLOWED_EMAILS` env var (currently `aj12ay@gmail.com`) can
  sign in, and every function and HTTP route checks the allowlist again
  (`convex/lib/access.ts`). `SITE_URL` is a comma-separated list of origins
  the game is served from. It controls the OAuth return allowlist and CORS.
  Other deployment env vars are `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET`,
  `JWT_PRIVATE_KEY`, and `JWKS` (see the Convex Auth manual setup docs). Dev
  also has `AUTH_FAKE_LOGIN=true` and `AUTH_FAKE_LOGIN_SECRET`, a test sign-in
  for automated E2E. Never set those on prod.
- **Flow**: boot never waits on the network for long. A stored session is
  trusted offline (identity from the cached `access:me` result or the JWT
  subject) and checked in the background. Without a session, the sign-in gate
  appears only if Convex answers within 4 s; it has a "Play without signing
  in" button, and that choice is remembered. With a session, boot waits at
  most 2.5 s for the first sync, then starts from the device copy while sync
  continues (`src/storage/cloud-boot.ts`).
- **Sync** (`src/storage/cloud-store.ts`): every local write is recorded in a
  sync journal in `localStorage` (`lt-web.cloudSync.v1`: per key `localAt`,
  `cloudAt` and `dirty`), so changes made offline or signed out upload later.
  A background loop reconciles once (`kv:hydrate`), then uploads dirty keys
  one at a time, latest local value wins. Requests time out (10 s calls, 45 s
  blobs), failures back off up to 30 s, the loop pauses while offline and
  resumes on `online`, and nothing throws into the game. Record and settings
  writes are debounced. The top-left pill shows synced / syncing / retrying /
  offline / on-device only, plus sign in and sign out. Values over 256 KiB,
  such as large save dicts, are gzipped into Convex file storage through the
  authenticated `/kv/blob` HTTP route.
- **Conflict rule** (per key): a key with no local change pulls the cloud copy
  if the cloud moved past `cloudAt`, and is removed if the cloud row is gone
  (deleted on another device). A key with a local change is pushed unless the
  cloud also changed and its `updatedAt` is newer than the local write
  (newest wins, ties keep the local copy). Keys with no journal entry (data
  from before local-first sync) take the cloud copy when one exists; a
  local-only save is uploaded on a device that never uploaded its local saves
  and dropped on one that did, and local-only records/settings are uploaded.
  A cloud copy of records, achievements or settings that lands after boot
  reloads the in-memory copy.
- **Deploy functions**: `npx convex dev --once` (dev) and `npx convex deploy`
  (prod).
- **Test/automation mode**: `?harness=true`, `?control=true`, a
  WebDriver-controlled browser (Playwright), or `?storage=local` use the
  on-device backend with no sign-in. `?storage=convex` forces cloud mode, e.g.
  for `node scripts/cloud-e2e.mjs`, the dev E2E. `tests/offline-saves.spec.ts`
  covers cloud mode against a mocked Convex (unreachable, offline, hanging). That script needs a dev
  server on port 5180 and reads the fake-login secret from the gitignored
  `.e2e-fake-login.local`.

### Licensing, credits, and deviations

lt-web and the original Lex Talionis engine are MIT-licensed; see
[`LICENSE.md`](LICENSE.md). EOtF code, writing, art, music, and other project
assets remain the property of their respective authors. Obtain the project
from its publisher, retain its in-game credits, and confirm redistribution
rights before publishing a bundle.

Every item and skill component NID the campaign uses has been compared against
its Lex Talionis Python definition; `npm run audit:eotf` reports the unverified
count, which is zero. `src/engine/eotf-component-support.ts` count-locks the
inventory so a component cannot be added without that comparison.

The release contract and generated compatibility inventory are in
[`PLAN.md`](PLAN.md) and
[`docs/parity/eotf-compat.md`](docs/parity/eotf-compat.md). The inventory
records eight intentional missing catalog aliases whose active replacements
ship with the project. Missing optional assets degrade visibly; missing
behavioral support fails in strict development mode. No campaign-blocking
intentional behavioral deviation is currently recorded.

One intentional deviation affects fonts: Lex Talionis keeps fonts at engine
level, and EOtF ships no `resources/fonts/` of its own. lt-web therefore tries
the campaign's font directory first and falls back to the engine defaults in
`default.ltproj`, so a project without fonts renders bitmap text rather than
degrading to canvas text.


Keyboard bindings follow Python's Controls settings page: a rebound button
gets exactly the chosen key, and a key already bound to another button is
refused. Two web-only differences: buttons never rebound keep the web's extra
default aliases (Enter, Escape, Shift, Tab, WASD), and the page ends with a
Restore Defaults row, because a browser player cannot delete
`saves/config.ini` to reset the keys.

lt-web also probes `resources/tilesets/tileset.json` when the standard
`tilesets.json` manifest is absent. Python globs that directory instead, which
a browser cannot do; the probe covers the loose-prefab layout EOtF ships.
