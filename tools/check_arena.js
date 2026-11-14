// Arena regression check: plain Node, no dependencies.  Usage: node tools/check_arena.js
// 1. botSpec must digest every preset and every chassis x module x slot combination without throwing or NaN.
// 2. Seeded AI-vs-AI matches must terminate with a winner, deal damage, stay finite and be reproducible.
const P = require('../static/bb_physics.js');
const A = require('../static/bb_arena.js');

let failures = 0;
const fail = (msg) => { failures++; console.log('FAIL  ' + msg); };

// walk any value and report the first non-finite number (Infinity is allowed only for unlimited ammo)
function badNumber(v, path, seen) {
  if (typeof v === 'number') return Number.isNaN(v) || (!Number.isFinite(v) && !/shots$/.test(path)) ? path : null;
  if (!v || typeof v !== 'object' || seen.has(v)) return null;
  seen.add(v);
  for (const k of Object.keys(v)) { const r = badNumber(v[k], path + '.' + k, seen); if (r) return r; }
  return null;
}

// ---- 1. specs ---------------------------------------------------------------------------------------
let specs = 0;
function checkSpec(label, cfg) {
  try {
    const spec = A.botSpec(P.compute(cfg));
    specs++;
    const bad = badNumber(spec, 'spec', new Set());
    if (bad) fail(`${label}: non-finite ${bad}`);
    if (spec.hull.length < 3 || !(spec.radius > 0)) fail(`${label}: degenerate hull`);
    for (const w of spec.weapons) if (!w.zone || !(w.reach > 0)) fail(`${label}: weapon ${w.type} has no strike zone`);
    return spec;
  } catch (e) { fail(`${label}: threw ${e.stack.split('\n').slice(0, 2).join(' | ')}`); return null; }
}
for (const name of Object.keys(P.PRESETS)) checkSpec('preset ' + name, P.PRESETS[name]);
const MODULE_SAMPLE = ['vdisk', 'drum', 'hbar', 'shell', 'ring', 'hammersaw', 'hammer', 'drill', 'punch', 'melty', 'flipper', 'lifter', 'suplex', 'crusher', 'grabber', 'flame', 'arc', 'spike', 'net', 'cannon', 'harpoon', 'forks', 'plow', 'spikes', 'srimech'];
for (const chassis of Object.keys(P.CHASSIS)) {
  for (const type of MODULE_SAMPLE) {
    for (const slot of P.SLOTS) checkSpec(`${chassis}/${type}@${slot}`, { ...P.DEFAULT_CFG, chassis, slots: { [slot]: { ...P.DEFAULT_MOD, type } } });
  }
  // every hardpoint filled at once
  checkSpec(`${chassis}/full`, { ...P.DEFAULT_CFG, chassis, slots: { front: { ...P.DEFAULT_MOD, type: 'drum' }, top: { ...P.DEFAULT_MOD, type: 'hammer' }, rear: { ...P.DEFAULT_MOD, type: 'flipper' }, left: { ...P.DEFAULT_MOD, type: 'saw' }, right: { ...P.DEFAULT_MOD, type: 'flame' } } });
}
// a module the arena has never heard of, with almost nothing filled in, must still produce a spec
try {
  const b = P.compute(P.PRESETS.vertical);
  b.mods.top = { type: 'tractor_beam', kind: 'mystery' }; b.mods.left = { type: 'broken', spin: {}, mount: { x: NaN } };
  const bad = badNumber(A.botSpec(b), 'spec', new Set());
  if (bad) fail('unknown module: non-finite ' + bad);
  specs++;
} catch (e) { fail('unknown module threw ' + e.message); }
console.log(`specs: ${specs} bot specs built (${Object.keys(P.PRESETS).length} presets, ${Object.keys(P.CHASSIS).length} chassis x ${MODULE_SAMPLE.length} modules x ${P.SLOTS.length} slots)`);

// ---- 2. matches -------------------------------------------------------------------------------------
const names = Object.keys(P.PRESETS);
const LEVELS = ['rookie', 'veteran', 'champion'];
const pairings = [];
for (let i = 0; i < names.length; i++) pairings.push([names[i], names[(i + 3) % names.length], LEVELS[i % 3], 1000 + i]);
for (let i = 0; i < 4; i++) pairings.push([names[i], names[(i + 5) % names.length], 'champion', 2000 + i]);

function run(pa, pb, level, seed, hazards) {
  const m = A.createMatch(P.compute(P.PRESETS[pa]), P.compute(P.PRESETS[pb]), { seed, difficulty: level, hazards });
  let steps = 0;
  while (!m.over && steps < 12000) { A.stepMatch(m, 1 / 60, null); steps++; }
  return m;
}
const signature = (m) => JSON.stringify([m.t.toFixed(4), m.result && m.result.winner, m.bots.map((b) => [b.x.toFixed(5), b.y.toFixed(5), b.stat.dmg.toFixed(1)]), m.events.length]);

let withDamage = 0, kos = 0;
const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
for (const [pa, pb, level, seed] of pairings) {
  const label = `${pa} v ${pb}`;
  let m;
  try { m = run(pa, pb, level, seed); } catch (e) { fail(`${label}: threw ${e.stack.split('\n').slice(0, 3).join(' | ')}`); continue; }
  const r = m.result;
  if (!m.over || !r) { fail(`${label}: did not terminate`); continue; }
  if (r.winner !== 0 && r.winner !== 1) fail(`${label}: no winner`);
  if (r.method !== 'KO' && r.method !== 'JD') fail(`${label}: bad method ${r.method}`);
  if (r.method === 'JD' && !r.doubleKo && m.t < A.MATCH_S - 0.1) fail(`${label}: judges' decision before the clock ran out`);
  if (r.votes[0] + r.votes[1] !== 3) fail(`${label}: judges' votes do not add up`);
  for (const j of r.judges) if (j.total[0] + j.total[1] !== 11) fail(`${label}: ${j.name} did not award 11 points`);
  // the live state, the recording and the event log all have to stay finite
  const bad = badNumber({ bots: m.bots.map((b) => ({ ...b, spec: null })), proj: m.proj, hz: m.hz, frames: m.frames, events: m.events, result: r }, 'match', new Set());
  if (bad) fail(`${label}: non-finite ${bad}`);
  if (m.frames.length < m.steps / A.REC_EVERY) fail(`${label}: recording is short (${m.frames.length} frames)`);
  if (signature(run(pa, pb, level, seed)) !== signature(m)) fail(`${label}: same seed gave a different match`);
  const dmg = m.bots.map((b) => b.stat.dmg);
  if (dmg[0] + dmg[1] > 1000) withDamage++;
  if (r.method === 'KO') kos++;
  const how = r.method === 'KO' ? `KO at ${clock(m.t)}` : `JUDGES ${r.split}${r.doubleKo ? ' (double KO)' : ''}`;
  console.log(`${label.padEnd(20)} ${level.padEnd(8)} seed ${seed}  ${m.bots[r.winner].spec.name.padEnd(15)} by ${how.padEnd(16)} dmg ${(dmg[0] / 1000).toFixed(0).padStart(4)}/${(dmg[1] / 1000).toFixed(0).padEnd(4)} kJ  hits ${String(m.bots[0].stat.hits).padStart(3)}/${String(m.bots[1].stat.hits).padEnd(3)} biggest ${(m.big ? m.big.dmg / 1000 : 0).toFixed(1).padStart(5)} kJ @ ${m.big ? clock(m.big.t) : '-'}  events ${m.events.length}`);
}
if (withDamage < Math.ceil(pairings.length * 0.75)) fail(`damage was dealt in only ${withDamage} of ${pairings.length} matches`);

// hazards off must really be off, and hazards on must be able to hurt
try {
  const off = run('flipper', 'crusher', 'rookie', 77, { saws: false, pulverizer: false, screws: false, pit: false, flames: false });
  if (off.events.some((e) => e.type === 'hit' && ['saw', 'pulverizer', 'screws'].includes(e.kind)) || off.events.some((e) => e.type === 'pit' || e.type === 'pitopen')) fail('hazards switched off still acted');
  if (off.hz.saws.length || off.hz.flames.length || off.hz.pulv || off.hz.pit || off.hz.screws) fail('hazards switched off still exist');
} catch (e) { fail('hazard toggle run threw ' + e.message); }

// player-driven path: scripted sticks, mouse target and auto-fire must all be accepted
try {
  const m = A.createMatch(P.compute(P.PRESETS.drum), P.compute(P.PRESETS.hammer), { seed: 5, difficulty: 'rookie' });
  for (let i = 0; i < 3600 && !m.over; i++) A.stepMatch(m, 1 / 60, i < 1200 ? { throttle: 1, turn: Math.sin(i / 40) * 0.3, primary: i % 90 === 0, fire: { front: i % 200 === 0 } } : { target: { x: m.bots[1].x, y: m.bots[1].y }, autoFire: true, fire: {} });
  const bad = badNumber({ bots: m.bots.map((b) => ({ ...b, spec: null })), frames: m.frames }, 'match', new Set());
  if (bad) fail('player-driven match: non-finite ' + bad);
  if (Math.hypot(m.bots[0].x + 3.3, m.bots[0].y) < 0.5 && !m.over) fail('player bot never moved under stick input');
} catch (e) { fail('player-driven match threw ' + e.stack.split('\n').slice(0, 3).join(' | ')); }

// ---- 3. browser half against a stub DOM ---------------------------------------------------------------
// No real canvas here, so this proves nothing about how the arena LOOKS. It does execute every draw routine,
// the HUD, the result card and the replay controls, which catches typos and bad state in code Node never
// otherwise reaches.
function uiSmoke() {
  const calls = { draw: 0 };
  // an object that accepts any property read, write or call (canvas contexts, gradients, style objects)
  const blob = () => new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => 1 : k === 'length' ? 0 : (t[k] !== undefined ? t[k] : (t[k] = blob()))),
    set: (t, k, v) => { t[k] = v; return true; },
    apply: () => { calls.draw++; return blob(); },
  });
  const listeners = { root: {}, window: {} };
  const node = (tag) => {
    const n = {
      tag, children: [], style: {}, dataset: {}, className: '', textContent: '', innerHTML: '', value: '0', width: 230, height: 230, disabled: false,
      classList: { toggle() {}, add() {}, remove() {} }, parentNode: { querySelectorAll: () => [] },
      appendChild(c) { n.children.push(c); return c; }, remove() {}, getContext: () => blob(),
      addEventListener(type, fn) { if (n.className === 'bba-root') listeners.root[type] = fn; },
      querySelector: () => node('x'), querySelectorAll: () => [], closest: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 900 }),
    };
    return n;
  };
  const saved = {};
  const globals = {
    self: global,
    document: { createElement: node, body: node('body'), getElementById: () => node('x'), activeElement: null },
    window: { innerWidth: 1600, innerHeight: 900, addEventListener(type, fn) { listeners.window[type] = fn; }, removeEventListener() {} },
    localStorage: { getItem: () => JSON.stringify({ 'SAVED ONE': P.PRESETS.vertical, BROKEN: 42 }) },
    requestAnimationFrame: (fn) => { globals.pending = fn; return 1; }, cancelAnimationFrame() {},
  };
  for (const k of ['self', 'document', 'window', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame']) { saved[k] = Object.getOwnPropertyDescriptor(global, k); Object.defineProperty(global, k, { value: globals[k], configurable: true, writable: true }); }
  const file = require.resolve('../static/bb_arena.js');
  delete require.cache[file];
  try {
    require(file);
    const api = global.BBArena;
    if (!api || typeof api.open !== 'function' || typeof api.close !== 'function' || typeof api.isOpen !== 'function') throw new Error('window.BBArena API missing');
    // opponents: the real presets plus one synthetic bot per module type, so every drawing style is exercised
    const presets = { ...P.PRESETS };
    const chassis = Object.keys(P.CHASSIS);
    Object.keys(P.MODULES).forEach((type, i) => { presets['syn_' + type] = { ...P.DEFAULT_CFG, name: 'SYN ' + type, chassis: chassis[i % chassis.length], text: 'T' + i, slots: { [P.SLOTS[i % 5]]: { ...P.DEFAULT_MOD, type }, [P.SLOTS[(i + 2) % 5]]: { ...P.DEFAULT_MOD, type } } }; });
    let closed = 0, ts = 0;
    const frames = (n) => { for (let i = 0; i < n && globals.pending; i++) { ts += 1000 / 60; const fn = globals.pending; fn(ts); } };
    const click = (act, v, extra) => listeners.root.click({ target: { closest: (sel) => (sel === '[data-act]' ? { dataset: { act, v, ...(extra || {}) }, disabled: false, parentNode: { querySelectorAll: () => [] } } : null) } });
    const key = (type, code) => listeners.window[type]({ type, code, repeat: false, target: { tagName: 'BODY' }, preventDefault() {}, stopPropagation() {} });
    api.open({ build: P.compute({ ...P.PRESETS.franken, cls: 'feather' }), presets, onClose: () => closed++ });
    if (!api.isOpen()) throw new Error('isOpen() false after open()');
    frames(3);
    const ids = Object.keys(presets).map((k) => 'preset:' + k).concat(['garage:SAVED ONE']);
    let fights = 0;
    ids.forEach((id, i) => {
      click('opp', id);                                // portrait + tale of the tape for every opponent
      if (i % 4) return;
      click('diff', ['rookie', 'veteran', 'champion'][i % 3]);
      if (i === 0) { click('hazard', 'pit'); click('hazard', 'pit'); click('drive', 'mouse'); click('autofire'); }
      click('autopilot'); click('start'); frames(900); click('autopilot');   // 15 s with the AI driving the player
      click('newopp'); fights++;
    });
    // one full match driven through the input paths: keys, pad, pointer, pause, then result and replay
    click('opp', 'preset:hammer'); click('start');
    key('keydown', 'KeyW'); key('keydown', 'Space'); frames(120); key('keyup', 'KeyW'); key('keydown', 'KeyD'); key('keydown', 'Digit1'); key('keydown', 'ArrowUp'); frames(30); key('keyup', 'ArrowUp'); key('keydown', 'ArrowLeft'); frames(30); key('keyup', 'ArrowLeft'); key('keyup', 'KeyD'); key('keyup', 'Digit1'); key('keyup', 'Space');
    key('keydown', 'KeyP'); frames(10); key('keydown', 'KeyP'); key('keydown', 'KeyM'); key('keydown', 'KeyF');
    listeners.root.pointermove({ type: 'pointermove', clientX: 900, clientY: 450, target: {} });
    listeners.root.pointerdown({ type: 'pointerdown', clientX: 900, clientY: 450, target: { closest: (sel) => (sel === '[data-pad]' ? { dataset: { pad: 'fr' } } : null) } });
    frames(60); listeners.root.pointerup({ type: 'pointerup', clientX: 900, clientY: 450, target: {} });
    click('weapon', 'front', { bot: '0' });
    frames(13000);                                     // more than a full 3:00 plus the end banner
    click('replay'); frames(200); click('rp-speed', '0.25'); frames(50); click('rp-play'); click('rp-play'); click('bighit'); frames(120);
    listeners.root.input({ target: { id: 'bba-rp-seek', value: '3.5' } }); frames(5); click('rp-start'); click('rp-speed', '2'); frames(6000);
    click('rp-exit'); frames(5); click('rematch'); frames(30); click('exit');
    if (api.isOpen()) throw new Error('isOpen() true after EXIT');
    if (closed !== 1) throw new Error(`onClose called ${closed} times`);
    api.close();                                       // closing twice must be harmless
    console.log(`ui smoke (stub DOM, no pixels): ${ids.length} opponent cards, ${fights} short fights, 1 full match with replay, ${calls.draw} canvas calls, no exceptions`);
  } catch (e) { fail('ui smoke: ' + e.stack.split('\n').slice(0, 4).join(' | ')); } finally {
    for (const k of Object.keys(saved)) { if (saved[k]) Object.defineProperty(global, k, saved[k]); else delete global[k]; }
    delete global.BBArena; delete require.cache[file];
  }
}
uiSmoke();

console.log(`matches: ${pairings.length} run, ${kos} knockouts, ${pairings.length - kos} judges' decisions, damage dealt in ${withDamage}`);
console.log(failures ? `ARENA CHECK FAILED: ${failures} problem(s)` : 'ARENA CHECK PASSED');
process.exit(failures ? 1 : 0);
