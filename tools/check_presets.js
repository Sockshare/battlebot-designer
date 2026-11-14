#!/usr/bin/env node
// Prints weight / legality for every preset, and runs the full chassis x module x hardpoint matrix.
'use strict';
const P = require('../static/bb_physics.js');
for (const k of Object.keys(P.PRESETS)) {
  const b = P.compute(P.PRESETS[k]);
  const bad = b.checks.filter((c) => c.status === 'fail').map((c) => `${c.label}: ${c.detail}`);
  const warn = b.checks.filter((c) => c.status === 'warn').map((c) => c.label);
  console.log(`${k.padEnd(9)} ${b.massLb.toFixed(1).padStart(6)} lb  ${(b.drive.topSpeed * P.MS_TO_MPH).toFixed(1).padStart(5)} mph  ${b.legal ? 'LEGAL' : 'FAIL '}  ${bad.join(' | ')}${warn.length ? '  [warn: ' + warn.join(', ') + ']' : ''}`);
}
if (process.argv[2] === 'matrix') {
  let n = 0, bad = 0;
  for (const ch of Object.keys(P.CHASSIS)) for (const t of Object.keys(P.MODULES)) for (const s of P.SLOTS) {
    n++;
    try {
      const b = P.compute({ ...P.DEFAULT_CFG, chassis: ch, slots: { [s]: { type: t } } });
      if (!Number.isFinite(b.mass) || !Number.isFinite(b.cg.z)) { bad++; console.log('NaN', ch, t, s); }
    } catch (e) { bad++; console.log('THROW', ch, t, s, e.message); }
  }
  console.log(`matrix: ${n} combos, ${bad} bad`);
}
