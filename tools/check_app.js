#!/usr/bin/env node
/**
 * Smoke test for the application layer under Node: loads every script against a permissive fake DOM,
 * runs the main loop for a number of frames in studio and factory mode, and exercises the public hooks.
 * It cannot check layout, only that the code runs without throwing or hanging.
 *   node tools/check_app.js "preset=franken&act=front,top"
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', 'static');
const fakeCtx = { createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), putImageData() {}, fillRect() {}, drawImage() {}, fillText() {}, createRadialGradient: () => ({ addColorStop() {} }), createLinearGradient: () => ({ addColorStop() {} }) };
const els = {};
function makeEl(id) {
  const base = {
    id, style: {}, dataset: {}, children: [], _html: '', textContent: '', value: '0', disabled: false, scrollTop: 0, width: 0, height: 0,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, appendChild(c) { base.children.push(c); return c; }, remove() {}, setAttribute() {}, setPointerCapture() {}, click() {},
    querySelectorAll: () => [], querySelector: () => makeEl('q'), closest: () => null, matches: () => false,
    getContext: () => fakeCtx, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 900 }), toDataURL: () => 'data:,',
    get firstElementChild() { return makeEl('child'); },
  };
  Object.defineProperty(base, 'innerHTML', { get: () => base._html, set: (v) => { base._html = String(v); } });
  return base;
}
const getEl = (id) => els[id] || (els[id] = makeEl(id));
global.window = global;
global.location = { search: '?sw=1&' + (process.argv[2] || '') };
global.innerWidth = 1600; global.innerHeight = 900; global.devicePixelRatio = 1;
global.addEventListener = () => {};
const store = {};
global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
global.document = { getElementById: getEl, createElement: () => makeEl('new'), body: makeEl('body'), querySelectorAll: () => [] };
let raf = null;
global.requestAnimationFrame = (fn) => { raf = fn; };
global.performance = { now: () => clock };
let clock = 0;
global.THREE = require(path.join(ROOT, 'three.min.js'));
global.BBPhysics = require(path.join(ROOT, 'bb_physics.js'));
for (const f of ['bb_engine.js', 'bb_kit.js', 'bb_modules.js', 'bb_models.js', 'bb_app.js']) require(path.join(ROOT, f));

const B = global.__BBD, P = global.BBPhysics;
const frames = (n) => { for (let i = 0; i < n; i++) { clock += 33; const fn = raf; raf = null; fn(clock); } };
const t0 = Date.now();
frames(20);
console.log('studio ok:', B.state.cfg.name, '| test bar:', getEl('test-bar').innerHTML.replace(/<[^>]+>/g, '|').replace(/\|+/g, ' | ').slice(0, 200));
// fire every module on every preset, drive, flip view modes
for (const k of Object.keys(P.PRESETS)) {
  B.load(P.PRESETS[k]);
  for (const s of B.getBuild().active) B.trigger(s);
  B.state.test.driveOn = true;
  for (const v of [{ xray: true }, { overlay: 'electrical' }, { overlay: 'thermal' }, { overlay: 'none', xray: false, labels: true }]) { Object.assign(B.state.view, v); frames(6); }
  B.state.view.labels = false;
  frames(40);
}
console.log('presets ok');
// factory floor: walk all stations, installing a module at each hardpoint station
B.setMode('factory');
const pick = { front: 'flame', top: 'cannon', rear: 'arc', left: 'net', right: 'coil' };
for (let i = 0; i < B.STATIONS.length; i++) {
  B.goStation(i, true);
  const st = B.STATIONS[i];
  if (st.slot) B.install(st.slot, pick[st.slot]);
  frames(45);
  if (!getEl('cfg-body').innerHTML) throw new Error('empty station body at ' + st.id);
}
console.log('factory ok:', B.getBuild().active.join(','), '| station body chars', getEl('cfg-body').innerHTML.length);
B.setMode('studio');
for (const s of P.SLOTS) B.install(s, null);
frames(10);
B.setCfg('chassis', 'dog'); B.install('top', 'shell'); frames(10);
// feature expansion: every new chassis and module on the test stand, weight classes, cluster, options, undo / redo, random builds
for (const ch of ['hexapod', 'tracked', 'tri', 'pancake', 'delta', 'ushape', 'hframe', 'puck']) { B.setCfg('chassis', ch); B.state.test.driveOn = true; frames(8); }
B.setCfg('chassis', 'box');
for (const s of P.SLOTS) B.install(s, null);
for (const t of ['ring', 'angled', 'twin', 'flail', 'drill', 'punch', 'melty', 'grablift', 'suplex', 'harpoon', 'tail']) {
  B.install('front', t);
  if (B.getBuild().mods.front.type !== t) throw new Error('could not install ' + t);
  B.trigger('front'); frames(30); B.state.teardown = 0.8; frames(4); B.state.teardown = 0;
}
B.install('front', 'flipper');
B.patch({ cluster: true, wheelCount: 6, tyre: 'soft', magnets: 2, guards: true, twoSpeed: true, susp: true, hub: true, extras: Object.fromEntries(Object.keys(P.EXTRAS).map((k) => [k, true])),
  armorFaces: { front: { mat: 'ar500', t: 8 }, side: { mat: 'ti', t: 4 }, rear: { mat: 'uhmw', t: 10 }, top: { mat: 'cfrp', t: 3 } }, ballastKg: 6, ballastZ: -0.5, livery: 'custom', paint: { armor: '#224488', top: '#eeeeee', accent: '#ffcc00' }, text: 'TEAM 42' });
frames(10);
for (const tab of ['chassis', 'hard', 'drive', 'power', 'armor', 'paint']) { B.state.tab = tab; B.setCfg('finish', B.state.cfg.finish === 'worn' ? 'battle' : 'worn'); if (!getEl('cfg-body').innerHTML) throw new Error('empty tab ' + tab); }
for (const cls of Object.keys(P.CLASSES)) { B.setCfg('cls', cls); frames(3); }
B.setCfg('cls', 'beetle');
const pct = getEl('load-pct').textContent, lim = getEl('load-max').textContent;
if (!/1\.5 LB/.test(lim)) throw new Error('class limit not shown per bot: ' + lim);
const depth = B.hist.i;
B.undo(); B.undo(); frames(3); B.redo(); frames(3);
if (B.hist.i !== depth - 1) throw new Error('undo / redo index wrong');
const link = B.encodeShare(B.state.cfg), back = B.decodeShare(link);
if (JSON.stringify(P.normalize(back)) !== JSON.stringify(B.state.cfg)) throw new Error('share link does not round-trip');
let legal = 0;
for (let i = 0; i < 6; i++) { B.surpriseMe(); if (B.getBuild().legal) legal++; frames(4); }
console.log(`expansion ok: load "${pct}" of "${lim}" | share link ${link.length} chars | ${legal}/6 random builds legal`);
console.log(`all ok in ${Date.now() - t0} ms, ${B.triCount()} tris in the last build`);
