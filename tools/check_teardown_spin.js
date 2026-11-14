#!/usr/bin/env node
// With the bot fully exploded, every piece inside a turning parent must stay put in the bot frame while the
// parent rotates (only spinning about its own centre). Measures the drift of each piece's centre over a turn.
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', 'static');
const fakeCtx = { createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} };
const fakeCanvas = { width: 0, height: 0, style: {}, getContext: () => fakeCtx, classList: { add() {}, remove() {} }, addEventListener() {} };
global.window = global; global.location = { search: '?sw=1' }; global.innerWidth = 1600; global.innerHeight = 900; global.devicePixelRatio = 1;
global.addEventListener = () => {};
global.document = { getElementById: (id) => (id === 'gl' ? fakeCanvas : { style: {}, addEventListener() {} }), createElement: () => fakeCanvas };
global.THREE = require(path.join(ROOT, 'three.min.js'));
global.BBPhysics = require(path.join(ROOT, 'bb_physics.js'));
for (const f of ['bb_engine.js', 'bb_kit.js', 'bb_modules.js', 'bb_models.js']) require(path.join(ROOT, f));
const P = global.BBPhysics, Mdl = global.BBModels, THREE = global.THREE;
let worst = 0, worstName = '';
for (const k of Object.keys(P.PRESETS)) {
  const build = P.compute(P.PRESETS[k]);
  const model = Mdl.buildBot(build);
  const a = model.anim;
  const centre = (m) => { model.root.updateMatrixWorld(true); return m.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(m.matrixWorld); };
  const pose = (ang) => {
    for (const w of a.wheelsL.concat(a.wheelsR)) w.rotation.x = ang;
    for (const c of a.driveCans) c.mesh.rotation.x = ang * 3;
    for (const s of build.active) { const h = a.slots[s]; if (h.rotor) h.rotor(ang); if (h.cans) h.cans(ang * 2); }
    if (a.legs) a.legs.forEach((l) => l.set(ang / 6.283, 1));
    Mdl.explodePieces(model, 1);
  };
  // only pieces whose own bounding-box centre is on the turning axis are expected to be perfectly still;
  // for the rest, compare against the same turn with the bot assembled (their natural orbit radius)
  const sample = (amount) => {
    const tracks = model.pieces.map(() => []);
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * 6.283;
      if (amount) pose(ang); else { for (const w of a.wheelsL.concat(a.wheelsR)) w.rotation.x = ang; for (const c of a.driveCans) c.mesh.rotation.x = ang * 3; for (const s of build.active) { const h = a.slots[s]; if (h.rotor) h.rotor(ang); if (h.cans) h.cans(ang * 2); } if (a.legs) a.legs.forEach((l) => l.set(ang / 6.283, 1)); Mdl.explodePieces(model, 0); }
      model.pieces.forEach((m, j) => tracks[j].push(centre(m)));
    }
    return tracks.map((t) => { const c = t.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / t.length); return Math.max(...t.map((p) => p.distanceTo(c))); });
  };
  const exploded = sample(1), assembled = sample(0);
  exploded.forEach((r, j) => { const extra = r - assembled[j]; if (extra > worst) { worst = extra; worstName = `${k}: ${model.pieces[j].userData.part}`; } });
}
console.log(`worst extra wobble when exploded: ${(worst * 1000).toFixed(2)} mm (${worstName})`);
process.exit(worst > 0.002 ? 1 : 0);
