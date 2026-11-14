#!/usr/bin/env node
/**
 * Builds the 3D model for every chassis x module x hardpoint combination (plus every preset) under Node
 * and exercises each animation handle, to catch builder exceptions and NaN geometry without a browser.
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', 'static');
const fakeCtx = { createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} };
const fakeCanvas = { width: 0, height: 0, style: {}, getContext: () => fakeCtx, classList: { add() {}, remove() {} }, addEventListener() {} };
global.window = global;
global.location = { search: '?sw=1' };
global.innerWidth = 1600; global.innerHeight = 900; global.devicePixelRatio = 1;
global.addEventListener = () => {};
global.document = { getElementById: (id) => (id === 'gl' ? fakeCanvas : { style: {}, addEventListener() {} }), createElement: () => fakeCanvas };
global.THREE = require(path.join(ROOT, 'three.min.js'));
global.BBPhysics = require(path.join(ROOT, 'bb_physics.js'));
for (const f of ['bb_engine.js', 'bb_kit.js', 'bb_modules.js', 'bb_models.js']) require(path.join(ROOT, f));
const P = global.BBPhysics, Mdl = global.BBModels;

let n = 0, bad = 0, maxTris = 0, maxName = '';
function check(label, cfg) {
  n++;
  try {
    const build = P.compute(cfg);
    const model = Mdl.buildBot(build);
    for (const v of [{ xray: true, overlay: 'none' }, { xray: false, overlay: 'thermal' }, { xray: false, overlay: 'electrical' }, { xray: false, overlay: 'none', primer: true }, { xray: false, overlay: 'none' }]) Mdl.applyView(model, build, v);
    model.root.updateMatrixWorld(true);
    for (const u of [0.5, 1, 0]) Mdl.explodePieces(model, u);
    for (const s of build.active) {
      const a = model.anim.slots[s];
      for (const u of [0, 0.5, 1]) { if (a.rotor) a.rotor(u * 3); if (a.cans) a.cans(u * 5); if (a.blur) a.blur(u > 0.5); if (a.pose) a.pose(u); if (a.fx) a.fx(u, u * 2, u); }
    }
    if (model.anim.legs) for (const u of [0, 0.3, 0.7]) model.anim.legs.forEach((l) => l.set(u, 1));
    let tris = 0, nan = false;
    model.root.updateMatrixWorld(true);
    model.root.traverse((o) => {
      if (!o.isMesh) return;
      const pos = o.geometry.attributes.position.array;
      for (let i = 0; i < pos.length; i += 97) if (!Number.isFinite(pos[i])) nan = true;
      if (!o.matrixWorld.elements.every(Number.isFinite)) nan = true;
      tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
    });
    if (nan || !Number.isFinite(model.bounds.max.x)) { bad++; console.log('NaN', label); }
    if (tris > maxTris) { maxTris = tris; maxName = label; }
    Mdl.disposeBot(model);
  } catch (e) { bad++; console.log('THROW', label, e.stack.split('\n').slice(0, 3).join(' | ')); }
}
// QUICK=1 limits the big matrices to a sample (every 7th combination) for a fast smoke run
const QUICK = !!process.env.QUICK;
let qi = 0;
const take = () => !QUICK || qi++ % 7 === 0;
for (const k of Object.keys(P.PRESETS)) check('preset ' + k, P.PRESETS[k]);
// every drive option, optional component, per-face armour, ballast, custom paint, team text and resized hull at once
const ALL_OPTS = {
  wheelCount: 6, tyre: 'soft', magnets: 2, guards: true, twoSpeed: true, susp: true, hub: true, extras: Object.fromEntries(Object.keys(P.EXTRAS).map((k) => [k, true])),
  armorFaces: { front: { mat: 'ar500', t: 8 }, side: { mat: 'ti', t: 4 }, rear: { mat: 'uhmw', t: 10 }, top: { mat: 'cfrp', t: 3 } }, ballastKg: 8, ballastZ: 0.5,
  livery: 'custom', paint: { armor: '#224488', top: '#eeeeee', accent: '#ffcc00' }, text: 'TEAM 42', dimL: 1.2, dimW: 0.85, dimH: 1.1, cls: 'beetle', cluster: true,
};
for (const ch of Object.keys(P.CHASSIS)) for (const fin of ['factory', 'battle']) check(`options ${ch} ${fin}`, { ...P.DEFAULT_CFG, chassis: ch, ...ALL_OPTS, finish: fin, slots: { front: { type: 'flipper', gas: 'co2' }, top: { type: 'melty' } } });
for (const ch of Object.keys(P.CHASSIS)) for (const n of [2, 4, 6, 8]) check(`wheels ${n} on ${ch}`, { ...P.DEFAULT_CFG, chassis: ch, wheelCount: n, guards: n > 4, livery: 'mono', armorFaces: ALL_OPTS.armorFaces });
for (const ch of Object.keys(P.CHASSIS)) for (const t of Object.keys(P.MODULES)) for (const s of P.SLOTS) if (take()) check(`${ch}/${t}/${s}`, { ...P.DEFAULT_CFG, chassis: ch, slots: { [s]: { type: t } } });
for (const w of Object.keys(P.WHEELS)) for (const ch of Object.keys(P.CHASSIS)) check(`wheel ${w} on ${ch}`, { ...P.DEFAULT_CFG, chassis: ch, wheel: w });
for (const f of Object.keys(P.FINISHES)) for (const lv of Object.keys(Mdl.LIVERIES)) check(`finish ${f} ${lv}`, { ...P.DEFAULT_CFG, finish: f, livery: lv, ground: 'skids', parallel: 4, bus: 'isolated' });
// everything at once on every chassis
for (const ch of Object.keys(P.CHASSIS)) check(`full ${ch}`, { ...P.DEFAULT_CFG, chassis: ch, slots: { front: { type: 'drum', count: 2 }, top: { type: 'hammersaw' }, rear: { type: 'flame' }, left: { type: 'coil' }, right: { type: 'hbar', count: 2 } } });
for (const ch of Object.keys(P.CHASSIS)) for (const t of Object.keys(P.MODULES)) { if (t === 'shell') continue; for (const s of ['front', 'top', 'left']) for (const ride of ['fixed', 'spin']) { if (s !== 'top' && ride === 'spin') continue; if (take()) check(`shell+${t}@${s}/${ride} on ${ch}`, { ...P.DEFAULT_CFG, chassis: ch, slots: { rear: { type: 'shell', count: 2, ratio: 3.4, scale: 0.7 }, [s]: { type: t, ride } } }); } }
console.log(`${n} builds, ${bad} bad, largest ${Math.round(maxTris)} tris (${maxName})`);
process.exit(bad ? 1 : 0);
