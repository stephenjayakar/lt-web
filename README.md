1. Download [lt-maker](https://gitlab.com/rainlash/lt-maker), and put it in this folder
2. `npm i`
3. `npm run dev`

## Embrace of the Fog

The compatibility target is
[`LordTweed/Tweeds_Roguelite`](https://gitlab.com/LordTweed/tweeds_roguelite)
at commit `d9d2975` (project metadata `EotF` 2.0.0). Keep its large game data
outside this repository and expose the project at the stable local path expected
by the audit and tests:

```bash
git clone https://gitlab.com/LordTweed/tweeds_roguelite.git lt-maker/eotf-source
ln -s eotf-source/Gacha_Game.ltproj lt-maker/eotf.ltproj
npm run audit:eotf
npm run dev
```

Choose **Embrace of the Fog** in the campaign picker. The integration is still
under active development; see `PLAN.md` and `docs/parity/eotf-compat.md` for the
current compatibility contract rather than treating a successful boot as proof
that every project-local mechanic is implemented.
