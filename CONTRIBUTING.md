# Contributing

## Run locally

```
./run.sh
```

This creates or reuses `./.venv`, installs `requirements.txt` (Flask) and starts `server.py` on
port 8105. Open http://127.0.0.1:8105. `PORT` and `HOST` environment variables change the bind
address, for example `PORT=9000 HOST=127.0.0.1 ./run.sh`. `run.sh` does not stop a process that is
already using the port.

The server sends `Cache-Control: no-store` and reloads templates on change, so editing a file under
`static/` or `templates/` only needs a browser reload, not a server restart.

## Run the tests

```
tools/test.sh
```

Needs only Node (the checks have no npm dependencies and do not need a browser or a running
server). It runs a syntax check and then every `tools/check_*.js`, prints a summary and exits
non-zero if any step fails. The whole run takes several minutes; the model-builder check is the
slowest step. CI (`.github/workflows/ci.yml`) runs the same script.

Single checks can be run directly:

```
node tools/check_presets.js matrix
node tools/check_models.js
node tools/check_teardown_spin.js
node tools/check_app.js "preset=franken&act=front,top"
node tools/check_arena.js
```

`tools/check_presets.js` does not set a failing exit status when it finds a bad combination, and
`tools/check_app.js` relies on an uncaught exception to fail; `tools/test.sh` inspects their output
to cover this, so prefer `tools/test.sh` in automation.

Two tools produce images rather than a pass/fail result, and write under `renders/` (git-ignored):

- `node tools/render_node.js <out.png> preset=drum xray=1 ...` renders one frame with the CPU
  renderer under Node, with no browser.
- `tools/shot.sh <name> "<query string>"` takes a headless-Chrome screenshot of a running server on
  port 8105 (requires `google-chrome`).

## Code layout conventions

These are conventions that can be observed in the current code.

- **No build step.** The browser loads plain scripts from `static/`; there is no bundler and no
  `package.json`.
- **Script load order matters.** `templates/index.html` loads the scripts in this order, and each
  file uses globals published by the ones before it:
  1. `three.min.js` (`THREE`)
  2. `bb_physics.js` (`BBPhysics`)
  3. `bb_engine.js` (`BBEngine`)
  4. `bb_kit.js` (`BBKit`)
  5. `bb_modules.js` (`BBModules`)
  6. `bb_models.js` (`BBModels`)
  7. `bb_arena.js` (`BBArena`)
  8. `bb_app.js` (publishes `window.__BBD`, the debug / automation hook the Node checks use)

  A new script has to be added to `templates/index.html` in the right place, and to the `require`
  lists in the `tools/check_*.js` files that load the same chain under Node.
- **Cache-bust query string.** The stylesheets and every `bb_*.js` script tag in
  `templates/index.html` carry the same `?v=<number>` suffix (`three.min.js` has none). Keep the
  numbers in step with each other when changing them.
- **One wrapper per file.** Each `bb_*.js` is a single `'use strict'` function wrapper that publishes
  one global object and starts with a header comment describing the file.
- **Node-loadable cores.** `bb_physics.js` and the simulation half of `bb_arena.js` export through
  `module.exports` when loaded by Node, so the checks can `require` them without a DOM.
- **`bb_physics.js` stays free of DOM and THREE.** It is written as a UMD-style module so that Node
  can `require` it directly; the checks depend on that. Internal units are SI; conversion to lb, mph
  and inches happens when text is produced.
- **Geometry frame.** Models are authored in metres in the bot frame: +Z forward, +X right, Y up,
  floor at y = 0 (see the headers of `bb_kit.js` and `bb_models.js`).
- **Fixed stage.** The UI is laid out on a fixed 1600 x 900 stage that is scaled to the window (see
  the header of `bb.css`).
- **Assets are local.** Fonts and three.js are served from `static/`; nothing is loaded from a CDN.
  If you add or update a bundled third-party file, update `THIRD_PARTY_NOTICES.md`.

## Changes

- Add a line to `CHANGELOG.md` under "Unreleased".
- The version number lives in `VERSION`.
- Do not change the rule numbers or catalog values without also updating the "Rules and accuracy"
  and "Model limits" sections of `README.md`.
- Generated output belongs under `renders/`, which is git-ignored.

## Licence

No licence has been chosen for this project yet (see `README.md`). Until the owner decides, the
terms under which contributions are accepted are also undecided; ask the owner before contributing.
