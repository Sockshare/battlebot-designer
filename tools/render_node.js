#!/usr/bin/env node
/**
 * Offline render harness: runs the real engine (CPU z-buffer path) and model builders under Node
 * with a stubbed DOM, and writes the frame to a PNG. Used to check the 3D output without a browser.
 *
 *   node tools/render_node.js <out.png> preset=drum xray=1 overlay=electrical teardown=0.6 az=0.62 el=0.36 pose=1 invert=1 cg=1
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const args = Object.fromEntries(process.argv.slice(3).map((a) => a.split('=')));
const out = process.argv[2] || 'out.png';
const ROOT = path.join(__dirname, '..', 'static');

// ---- minimal DOM stub -----------------------------------------------------------
let frame = null;
const fakeCtx = {
  createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  putImageData: (img) => { frame = img; },
};
const fakeCanvas = { width: 0, height: 0, style: {}, getContext: () => fakeCtx, classList: { add() {}, remove() {} }, addEventListener() {} };
const fakeEl = { style: {}, addEventListener() {} };
global.window = global;
global.location = { search: '?sw=1' };
global.innerWidth = 1600;
global.innerHeight = 900;
global.devicePixelRatio = 1;
global.addEventListener = () => {};
global.document = { getElementById: (id) => (id === 'gl' ? fakeCanvas : fakeEl), createElement: () => fakeCanvas };
global.THREE = require(path.join(ROOT, 'three.min.js'));
global.BBPhysics = require(path.join(ROOT, 'bb_physics.js'));
require(path.join(ROOT, 'bb_engine.js'));
require(path.join(ROOT, 'bb_kit.js'));
require(path.join(ROOT, 'bb_modules.js'));
require(path.join(ROOT, 'bb_models.js'));

const E = global.BBEngine, P = global.BBPhysics, Mdl = global.BBModels;
const cfg = JSON.parse(JSON.stringify(P.PRESETS[args.preset] || P.DEFAULT_CFG));
for (const k of Object.keys(P.DEFAULT_CFG)) if (args[k] !== undefined && k !== 'slots') cfg[k] = typeof P.DEFAULT_CFG[k] === 'number' ? Number(args[k]) : args[k];
// slot overrides: front=flame top=none ...
for (const s of P.SLOTS) if (args[s] !== undefined) cfg.slots[s] = args[s] === 'none' ? null : { ...(cfg.slots[s] || {}), type: args[s] };
const build = P.compute(cfg);
const t0 = Date.now();
const model = Mdl.buildBot(build);
const buildMs = Date.now() - t0;
E.scene.add(model.root);
if (args.set) E.setStage(args.set);
const view = { xray: args.xray === '1', overlay: args.overlay || 'none', primer: args.primer === '1' };
Mdl.applyView(model, build, view);
model.cgMarker.visible = args.cg === '1';

const S = model.scale, b = model.bounds;
const dx = b.max.x - b.min.x, dz = b.max.z - b.min.z;
const cz = (b.min.z + b.max.z) / 2;
const teardown = Number(args.teardown || 0);
const stage = args.stage === undefined ? 99 : Number(args.stage);
for (const g of model.explode) { g.position.copy(g.userData.home).addScaledVector(g.userData.ex, Math.min(1, teardown * 1.6)); g.visible = g.userData.stage <= stage; }
E.scene.updateMatrixWorld(true);
{ const u = Math.min(1, Math.max(0, (teardown - 0.2) / 0.8)); Mdl.explodePieces(model, u * u * (3 - 2 * u)); }
const inv = args.invert === '1' ? 1 : 0;
model.root.rotation.z = Math.PI * inv;
model.root.position.set(0, S * build.invertRest * inv, -cz * S);
E.setContact(dx * S * 0.5, dz * S * 0.5);

// optional action pose: rotors turned, actuators at full travel, effects on
if (args.pose === '1') {
  const tt = Number(args.t || 0.4);
  for (const s of build.active) {
    const a = model.anim.slots[s];
    if (a.rotor) a.rotor(0.7);
    if (a.blur && args.blur === '1') a.blur(true);
    if (a.pose) a.pose(Number(args.u || 1));
    if (a.fx) a.fx(1, tt, Number(args.u || 0.3));
  }
  if (model.anim.legs) model.anim.legs.forEach((l) => l.set(0.2, 1));
}
if (view.overlay === 'electrical') {
  for (const w of model.wires) for (const p of w.pulses) { p.mesh.visible = true; p.mesh.position.copy(w.curve.getPoint((0.3 + p.offset) % 1)); }
}

const r = (Math.max(dx, dz) / 2) * S;
const dist = Math.min(14, Math.max(4.4, r / 0.2)) * (1 + 0.6 * teardown) * Number(args.zoom || 1);
E.cam.az = E.cam.tAz = Number(args.az || 0.62);
E.cam.el = E.cam.tEl = Number(args.el || 0.36);
E.cam.dist = E.cam.tDist = dist;
E.cam.target.set(0, S * (0.1 + 0.2 * teardown) + 0.02 * dist, 0);
E.cam.tTarget.copy(E.cam.target);
E.updateCamera(1);
const t1 = Date.now();
E.render();
const first = Date.now() - t1;
const t2 = Date.now();
for (let i = 0; i < 10; i++) E.render();
const perFrame = (Date.now() - t2) / 10;

// ---- composite over the studio background and encode PNG ---------------------------
const W = frame.width, H = frame.height, src = frame.data;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  const k = y / H;
  const bg = [10 + 14 * k, 11 + 15 * k, 14 + 18 * k];
  raw[y * (W * 3 + 1)] = 0;
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, o = y * (W * 3 + 1) + 1 + x * 3, al = src[i + 3] / 255;
    raw[o] = src[i] * al + bg[0] * (1 - al);
    raw[o + 1] = src[i + 1] * al + bg[1] * (1 - al);
    raw[o + 2] = src[i + 2] * al + bg[2] * (1 - al);
  }
}
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (buf) => { let c = -1; for (const v of buf) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));

let tris = 0, meshes = 0;
model.root.traverse((o) => { if (o.isMesh && o.geometry) { meshes++; tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; } });
console.log(`${path.basename(out)}: ${cfg.name} | ${build.massLb.toFixed(1)} lb | meshes ${meshes} tris ${Math.round(tris)} drawn ${Math.round(E.renderer.stats.tris)} wires ${model.wires.length} | build ${buildMs} ms, first frame ${first} ms, steady ${perFrame.toFixed(1)} ms/frame (Node, ${W}x${H})`);
