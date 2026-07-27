1. Download [lt-maker](https://gitlab.com/rainlash/lt-maker), and put it in this folder
2. `npm i`
3. `npm run dev`

## Embrace of the Fog

The compatibility target is
[`LordTweed/Tweeds_Roguelite`](https://gitlab.com/LordTweed/tweeds_roguelite)
at commit `d9d2975` (project metadata `EotF` 2.0.0). The project data is not
part of the lt-web distribution. Install an authorized copy at the stable path
used by the audit, build, and browser:

```bash
git clone https://gitlab.com/LordTweed/tweeds_roguelite.git lt-maker/eotf-source
git -C lt-maker/eotf-source checkout d9d2975
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

### Saves and upgrades

Campaign save slots and suspend data are scoped by game NID in the
`lt-web-saves` IndexedDB database. Browsers without IndexedDB use
`localStorage` keys prefixed with `lt-save:`. Persistent records and
achievements use `lt-persistent-records-<game-nid>` and
`lt-achievements-<game-nid>`. Clearing site data or changing the deployment
origin removes or isolates these saves; back up browser storage before either
operation. Save payloads carry a version and are migrated during load.

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

Two EOtF item components are deliberately not implemented, both cosmetic:

- `item_icon_flash` (2 items) flashes an item icon during the combat preview
  when a condition holds. Combat math and targeting are unaffected.
- `text_color` (2 items) is deprecated in Lex Talionis and its Python
  implementation returns `'white'` for every input, so honouring it would be
  indistinguishable from the default.

lt-web also probes `resources/tilesets/tileset.json` when the standard
`tilesets.json` manifest is absent. Python globs that directory instead, which
a browser cannot do; the probe covers the loose-prefab layout EOtF ships.
