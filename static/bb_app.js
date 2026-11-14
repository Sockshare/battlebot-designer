/**
 * BattleBot Designer — application layer.
 * STUDIO: open hardpoint configurator, live engineering HUD, view modes, per-module test stand, exports.
 * FACTORY FLOOR: the same build assembled station by station, each part lowered in as it is chosen.
 */
(function () {
  'use strict';
  const E = window.BBEngine;
  const P = window.BBPhysics;
  const Mdl = window.BBModels;
  const THREE = E.THREE;
  const { KG_TO_LB, MS_TO_MPH, M_TO_IN, N_TO_LBF, SLOTS, SLOT_NAMES } = P;
  const $ = (id) => document.getElementById(id);
  const clamp = E.clamp;
  const lerp = E.lerp;
  const fmt = (v, d) => Number(v).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  const query = new URLSearchParams(window.location.search);
  const STORE_KEY = 'bbd_garage_v2';
  const LAST_KEY = 'bbd_last_v2';

  const CAT_ORDER = ['STRUCTURE', 'ARMOR', 'DRIVE', 'ELECTRICAL', 'WEAPON'];
  const CAT_COLORS = { STRUCTURE: '#7d8591', ARMOR: '#ff5a1f', DRIVE: '#d9d6cd', ELECTRICAL: '#3b82f6', WEAPON: '#f2b632' };
  const TABS = [['chassis', 'CHASSIS'], ['hard', 'HARDPOINTS'], ['drive', 'DRIVE'], ['power', 'POWER'], ['armor', 'ARMOR'], ['paint', 'PAINT']];
  const NUM_KEYS = new Set(['cells', 'parallel', 'driveRatio', 'armorT', 'count', 'teeth', 'scale', 'ratio', 'pressure', 'wheelCount', 'magnets', 'dimL', 'dimW', 'dimH', 'ballastKg', 'ballastZ']);
  const BOOL_KEYS = new Set(['cluster', 'guards', 'twoSpeed', 'susp', 'hub']);
  const VERSION = '0.1.0';
  const MAT_SHORT = { ar500: 'AR500', hardox: 'HARDOX', mild: 'A36', ti: 'TI', al7075: '7075', cfrp: 'CFRP', uhmw: 'UHMW' };
  const FACE_NAMES = { front: 'FRONT', side: 'SIDES', rear: 'REAR', top: 'TOP' };
  const SLOT_SHORT = { front: 'FRONT', top: 'TOP', rear: 'REAR', left: 'LEFT', right: 'RIGHT' };
  // sensible starting values when a module is first bolted on
  const MOD_DEFAULTS = {
    drum: { teeth: 2, motor: 'wm_m', count: 2, ratio: 1.0, scale: 0.95 }, egg: { motor: 'wm_m', ratio: 1.0, teeth: 2 }, hbar: { ratio: 2.0, teeth: 2 }, under: { ratio: 1.6, teeth: 2 },
    shell: { teeth: 2, count: 2, ratio: 3.4, scale: 0.7 }, saw: { motor: 'wm_s', esc: 'esc_160', ratio: 1.5 }, hammersaw: { motor: 'wm_m', esc: 'esc_160', ratio: 1.0 },
    hammer: { motor: 'wm_m', esc: 'esc_160' }, axe: { motor: 'wm_m', esc: 'esc_160' }, lifter: { motor: 'wm_s', esc: 'esc_160' }, crusher: { motor: 'wm_m', esc: 'esc_160' },
    ring: { teeth: 2, count: 2, ratio: 4.5, scale: 0.7 }, twin: { teeth: 1 }, flail: { ratio: 2.0, teeth: 3 }, drill: { motor: 'wm_s', esc: 'esc_160', ratio: 1.0 },
    grablift: { motor: 'wm_s', esc: 'esc_160' }, suplex: { motor: 'wm_m', esc: 'esc_160' },
  };
  const STATIONS = [
    { id: 'frame', label: 'FRAME', stage: 0, tab: 'chassis', blurb: 'Pick the chassis. Everything else bolts to it, and any chassis accepts any module.' },
    { id: 'drive', label: 'DRIVETRAIN', stage: 1, tab: 'drive', blurb: 'Motors, gearboxes, wheels, tyres and drive options. Walkers get one actuator per leg instead.' },
    { id: 'power', label: 'POWER', stage: 2, tab: 'power', blurb: 'Battery chemistry, series cells for voltage, parallel packs for current, and optional components.' },
    { id: 'control', label: 'CONTROL', stage: 3, tab: 'control', blurb: 'Speed controllers, receiver and the wiring harness that ties it together.' },
    { id: 'front', label: 'FRONT HARDPOINT', stage: 4, slot: 'front', blurb: 'Bolt any module to the front, or leave it empty.' },
    { id: 'top', label: 'TOP HARDPOINT', stage: 5, slot: 'top', blurb: 'The deck mount: overhead arms, turrets, shells, anything.' },
    { id: 'rear', label: 'REAR HARDPOINT', stage: 6, slot: 'rear', blurb: 'A second weapon, a self-righting arm or rear protection.' },
    { id: 'left', label: 'LEFT HARDPOINT', stage: 7, slot: 'left', blurb: 'Side mount on the left flank.' },
    { id: 'right', label: 'RIGHT HARDPOINT', stage: 8, slot: 'right', blurb: 'Side mount on the right flank.' },
    { id: 'armor', label: 'ARMOR', stage: 9, tab: 'armor', blurb: 'Plate stock and thickness, uniform or face by face. Panels arrive in primer.' },
    { id: 'paint', label: 'PAINT SHOP', stage: 10, tab: 'paint', blurb: 'Livery, custom colours, team lettering and finish.' },
    { id: 'rollout', label: 'ROLL-OUT', stage: 10, tab: 'rollout', blurb: 'Final inspection before the arena.' },
  ];

  // ---------------------------------------------------------------------------
  // STATE
  // ---------------------------------------------------------------------------
  // a build travels in a link as base64url-encoded JSON (?b=...)
  const encodeShare = (cfg) => btoa(unescape(encodeURIComponent(JSON.stringify(cfg)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const decodeShare = (str) => { try { const c = JSON.parse(decodeURIComponent(escape(atob(String(str).trim().replace(/-/g, '+').replace(/_/g, '/'))))); return c && c.chassis && c.slots ? c : null; } catch (e) { return null; } };
  function initialCfg() {
    if (query.get('b')) { const shared = decodeShare(query.get('b')); if (shared) return shared; }
    if (query.get('preset') && P.PRESETS[query.get('preset')]) return P.PRESETS[query.get('preset')];
    try {
      const last = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
      if (last && last.chassis && last.slots) return last;
    } catch (e) { /* ignore corrupt storage */ }
    return P.PRESETS.vertical;
  }

  const state = {
    cfg: P.normalize(initialCfg()),
    build: null,
    model: null,
    mode: 'studio',
    station: 0,
    drop: null,
    tab: TABS.some((t) => t[0] === query.get('tab')) ? query.get('tab') : 'chassis',
    slot: SLOTS.includes(query.get('slot')) ? query.get('slot') : null,
    hpTab: query.get('hp') === 'tune' ? 'tune' : 'module',
    view: {
      labels: query.get('labels') === '1',
      xray: query.get('xray') === '1',
      overlay: ['electrical', 'thermal'].includes(query.get('overlay')) ? query.get('overlay') : 'none',
      cg: query.get('cg') === '1',
      invert: query.get('invert') === '1',
      turntable: query.get('turn') === '1',
      primer: false,
    },
    teardown: clamp(parseFloat(query.get('teardown') || '0') || 0, 0, 1),
    invertF: 0,
    orbit: { az: parseFloat(query.get('az') || '0.62'), el: parseFloat(query.get('el') || '0.34'), zoom: parseFloat(query.get('zoom') || '1'), turn: 0 },
    frame: { cz: 0, r: 1.3 },
    test: null,
    time: 0,
    callouts: [],
  };
  const firstSlot = (cfg) => SLOTS.find((s) => cfg.slots[s]) || 'front';
  // Weight classes: the maths runs at heavyweight scale; anything shown to the user is rescaled to the chosen class.
  // sc() rescales every "number + unit" in a finished string; lbS / kgS / usd format single numbers.
  const kNow = () => (state.build ? state.build.u.k : 1);
  const sc = (str) => P.scaleText(str, kNow());
  const adp = (v) => { const a = Math.abs(v); return fmt(v, a >= 100 ? 1 : a >= 1 ? 2 : a >= 0.01 ? 3 : 4); };
  const lbS = (kg) => adp(kg * KG_TO_LB * Math.pow(kNow(), 3));
  const kgS = (kg) => adp(kg * Math.pow(kNow(), 3));
  const leg = (v) => fmt(v, v >= 10 ? 1 : v >= 1 ? 2 : 3); // compact figures for the mass legend
  const limS = (v) => String(Math.round(v * 100) / 100);
  const usd = (v) => '$' + fmt(v, v < 100 ? 2 : 0);
  // undo / redo: a stack of configurations; slider drags within a short window collapse into one step
  const hist = { stack: [], i: -1, at: 0, lock: false };
  if (!state.slot) state.slot = firstSlot(state.cfg);

  const loadTicksEl = $('load-ticks');
  for (let i = 0; i < 28; i++) loadTicksEl.appendChild(document.createElement('span'));
  const loadTickSpans = Array.from(loadTicksEl.children);
  $('meta-renderer').textContent = E.isSoftware ? 'CPU RASTER' : 'WEBGL';

  // hardpoint marker: shows where the selected mount is, even when it is empty
  const marker = new THREE.Group();
  {
    const mat = new THREE.MeshBasicMaterial({ color: '#ff5a1f', transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.085, 0.1, 28), mat);
    const ring2 = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.036, 20), mat);
    const tick = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.008, 0.16), mat);
    tick.position.z = 0.08;
    marker.add(ring, ring2, tick);
    marker.visible = false;
  }

  // ---------------------------------------------------------------------------
  // BUILD / REBUILD
  // ---------------------------------------------------------------------------
  function resetTest() {
    const b = state.build;
    const t = { driveOn: false, wheelW: 0, wheelAngle: 0, legPhase: 0, legAmp: 0, iD: 0, slots: {} };
    for (const s of b.active) {
      const o = b.mods[s], a = state.model.anim.slots[s];
      t.slots[s] = {
        kind: o.action.kind, on: false, t: 0, omega: 0, angle: 0, canAngle: 0, i: 0, u: 0, target: 0, phase: 'idle', timer: 0, level: 0, fxU: 0, cool: 0,
        shots: o.flip ? o.flip.shots : o.punch ? o.punch.shots : o.launch ? o.launch.shots : 0, fuel: o.flame ? o.flame.burnS : 0,
        chop: a.pose && o.action.kind === 'spin' ? { phase: 'idle', u: 0, timer: 0 } : null,
      };
    }
    state.test = t;
    renderTestBar();
  }

  function rebuild(opts) {
    state.build = P.compute(state.cfg);
    state.cfg = state.build.cfg;
    if (!hist.lock) {
      const snap = JSON.stringify(state.cfg), now = Date.now();
      if (hist.stack[hist.i] !== snap) {
        if (hist.i >= 0 && now - hist.at < 700 && hist.i === hist.stack.length - 1 && hist.i > 0) hist.stack[hist.i] = snap;
        else { hist.stack.length = hist.i + 1; hist.stack.push(snap); if (hist.stack.length > 80) hist.stack.shift(); hist.i = hist.stack.length - 1; }
        hist.at = now;
      }
    }
    if (state.model) {
      state.model.root.remove(marker);
      E.scene.remove(state.model.root);
      Mdl.disposeBot(state.model);
    }
    state.model = Mdl.buildBot(state.build);
    state.model.root.add(marker);
    E.scene.add(state.model.root);
    applyView();
    const b = state.model.bounds, S = state.model.scale;
    const dx = b.max.x - b.min.x, dz = b.max.z - b.min.z;
    // a cluster shows its second bot alongside, so the pair is framed together
    const pairOff = state.cfg.cluster ? dx / 2 + 0.1 : 0;
    state.frame = { cz: (b.min.z + b.max.z) / 2, r: (Math.max(dx + 2 * pairOff, dz) / 2) * S, dx, dz, top: b.max.y, pairOff };
    E.setContact((dx + 2 * pairOff) * S * 0.5, dz * S * 0.5);
    resetTest();
    buildCallouts();
    placeMarker();
    if (state.mode === 'factory' && !(opts && opts.noDrop)) startDrop();
    try { localStorage.setItem(LAST_KEY, JSON.stringify(state.cfg)); } catch (e) { /* storage unavailable */ }
  }

  function applyView() {
    state.view.primer = state.mode === 'factory' && STATIONS[state.station].id === 'armor';
    Mdl.applyView(state.model, state.build, state.view);
    state.model.cgMarker.visible = state.view.cg;
    syncTwin();
  }

  // Second bot of a cluster pair: a static copy of the first (same geometry and materials, flattened into one group).
  const twin = new THREE.Group();
  E.scene.add(twin);
  const _inv = new THREE.Matrix4();
  function syncTwin() {
    while (twin.children.length) twin.remove(twin.children[0]);
    twin.visible = false;
    if (!state.cfg.cluster || !state.model) return;
    const root = state.model.root;
    // the copy is taken at rest: undo the teardown offsets first
    for (const g of state.model.explode) g.position.copy(g.userData.home);
    Mdl.explodePieces(state.model, 0);
    root.updateMatrixWorld(true);
    _inv.copy(root.matrixWorld).invert();
    for (const mesh of state.model.meshes) {
      const ud = mesh.userData;
      if (ud.role === 'fx' || ud.role === 'pulse' || !mesh.visible) continue;
      const c = new THREE.Mesh(mesh.geometry, mesh.material);
      c.matrixAutoUpdate = false;
      c.matrix.multiplyMatrices(_inv, mesh.matrixWorld);
      c.castShadow = mesh.castShadow;
      twin.add(c);
    }
    twin.scale.setScalar(state.model.scale);
  }

  function placeMarker() {
    const lay = state.build.layout, m = lay.mounts[state.slot];
    const show = (state.mode === 'factory' && !!STATIONS[state.station].slot) || (state.mode === 'studio' && state.tab === 'hard');
    marker.visible = show && !!m;
    if (!m) return;
    if (m.kind === 'deck') { marker.position.set(0, lay.deckY + 0.004, 0); marker.rotation.set(-Math.PI / 2, 0, 0); }
    else { marker.position.set(m.x + Math.sin(m.rot) * 0.004, m.cy, m.z + Math.cos(m.rot) * 0.004); marker.rotation.set(0, m.rot, 0); }
  }

  // A change is refused if it would make two modules need the same space (or block a line of fire).
  // Returns the offending conflict, or null when the change is fine.
  function refused(nextCfg) {
    const trial = P.compute(nextCfg);
    const before = new Set(state.build.conflicts.map((c) => c.text));
    const fresh = trial.conflicts.filter((c) => !before.has(c.text));
    if (!fresh.length) return null;
    state.notice = { text: fresh[0].text, until: state.time + 4.5 };
    renderTabBody();
    return fresh[0];
  }
  const blockCache = new Map();
  // would bolting `type` onto `slot` interfere with what is already installed?
  function blockedBy(slot, type) {
    const key = JSON.stringify(state.cfg) + slot + type;
    if (!blockCache.has(key)) {
      if (blockCache.size > 400) blockCache.clear();
      const trial = P.compute({ ...state.cfg, slots: { ...state.cfg.slots, [slot]: modFor(slot, type) } });
      const hit = trial.conflicts.find((c) => c.a === slot || c.b === slot);
      blockCache.set(key, hit ? hit.text : null);
    }
    return blockCache.get(key);
  }

  function setCfg(key, value, live) {
    const next = P.normalize({ ...state.cfg, [key]: value });
    if (refused(next)) return;
    state.cfg = next;
    rebuild();
    renderHud();
    if (!live) renderTabBody();
    else { const el = $('val-' + key); if (el) el.textContent = sc(sliderText(key, state.cfg[key])); }
  }

  function setSlot(slot, mod, live, key) {
    const next = P.normalize({ ...state.cfg, slots: { ...state.cfg.slots, [slot]: mod } });
    if (mod && refused(next)) return;
    state.cfg = next;
    rebuild();
    renderHud();
    if (!live) renderTabBody();
    else { const el = $('val-m-' + key); if (el) el.textContent = sc(modSliderText(key)); }
  }
  const setMod = (key, value, live) => { const cur = state.cfg.slots[state.slot]; if (cur) setSlot(state.slot, { ...cur, [key]: value }, live, key); };
  function modFor(slot, type) {
    const cur = state.cfg.slots[slot];
    const keep = cur && P.MODULES[cur.type].kind === P.MODULES[type].kind ? cur : {};
    return { ...P.DEFAULT_MOD, ...keep, ...(MOD_DEFAULTS[type] || {}), type };
  }
  function installModule(slot, type) {
    if (!type) return setSlot(slot, null);
    setSlot(slot, modFor(slot, type));
  }

  function loadCfg(cfg) {
    state.cfg = P.normalize(cfg);
    state.slot = firstSlot(state.cfg);
    rebuild({ noDrop: true });
    renderAll();
  }
  // direct edit that needs no interference check (paint, lettering, extras, per-face armour)
  function patchCfg(patch, live) {
    state.cfg = P.normalize({ ...state.cfg, ...patch });
    rebuild({ noDrop: true });
    renderHud();
    if (!live) renderTabBody();
  }
  function timeTravel(step) {
    const j = hist.i + step;
    if (j < 0 || j >= hist.stack.length) return;
    hist.i = j;
    hist.lock = true;
    state.cfg = P.normalize(JSON.parse(hist.stack[j]));
    if (!state.cfg.slots[state.slot]) state.slot = firstSlot(state.cfg);
    rebuild({ noDrop: true });
    hist.lock = false;
    renderAll();
  }
  function syncHistButtons() { $('b-undo').disabled = hist.i <= 0; $('b-redo').disabled = hist.i >= hist.stack.length - 1; }
  const faceCfg = () => state.cfg.armorFaces || Object.fromEntries(P.FACES.map((fc) => [fc, { ...P.faceOf(state.cfg, fc) }]));
  function setFace(face, key, val, live) {
    const af = faceCfg();
    af[face] = { ...af[face], [key]: val };
    patchCfg({ armorFaces: af }, live);
    if (live) { const el = $('val-f-' + face); if (el) el.textContent = sc(`${af[face].t.toFixed(1)} MM`); }
  }

  // ---------------------------------------------------------------------------
  // CONFIGURATOR HTML
  // ---------------------------------------------------------------------------
  const inch = (m, d) => fmt(m * M_TO_IN, d === undefined ? 1 : d);
  const lb = (kg, d) => fmt(kg * KG_TO_LB, d === undefined ? 1 : d);

  function sliderText(key, v) {
    if (key === 'driveRatio') return `${Number(v).toFixed(1)} : 1`;
    if (key === 'armorT') return `${Number(v).toFixed(1)} MM · ${(v / 25.4).toFixed(3)} IN`;
    const ch = state.build.chassis;
    if (key === 'dimL') return `${Math.round(v * 100)}% · ${inch(ch.L)} IN`;
    if (key === 'dimW') return `${Math.round(v * 100)}% · ${inch(ch.W)} IN`;
    if (key === 'dimH') return `${Math.round(v * 100)}% · ${inch(ch.H)} IN`;
    if (key === 'ballastKg') return Number(v) > 0 ? `${lb(Number(v))} LB` : 'NONE';
    if (key === 'ballastZ') return Number(v) === 0 ? 'CENTRED' : `${Math.round(Math.abs(v) * 100)}% ${v > 0 ? 'FRONT' : 'REAR'}`;
    return String(v);
  }
  function modSliderText(key) {
    const o = state.build.mods[state.slot], md = state.cfg.slots[state.slot];
    if (!o || !md) return '';
    if (key === 'scale') {
      if (o.spin) return `${inch(o.geo.tipR * 2)} IN · ${lb(o.geo.mass)} LB`;
      return `${Math.round(md.scale * 100)}% · ${lb(o.mass)} LB`;
    }
    if (key === 'ratio') return `${md.ratio.toFixed(2)} : 1`;
    if (key === 'pressure') return `${fmt(md.pressure)} BAR · ${fmt(md.pressure * 14.5038)} PSI`;
    return String(md[key]);
  }

  const opt = (attr, val, name, spec, active, tag, tagCls) =>
    `<button class="opt${active ? ' active' : ''}" ${attr}="${val}"><span class="opt-name">${name}</span><span class="opt-spec">${spec}</span>${tag ? `<span class="opt-tag ${tagCls || ''}">${tag}</span>` : ''}</button>`;
  const cfgOpt = (key, val, name, spec, active, tag) => opt(`data-key="${key}" data-val`, val, name, spec, active, tag);
  const seg = (attr, items, cur) =>
    `<div class="seg">${items.map(([v, label, dis]) => `<button ${attr} data-val="${v}" class="${String(v) === String(cur) ? 'active' : ''}"${dis ? ' disabled' : ''}>${label}</button>`).join('')}</div>`;
  const cfgSeg = (key, items, cur) => seg(`data-key="${key}"`, items, cur);
  const modSeg = (key, items, cur) => seg(`data-mod="${key}"`, items, cur);
  const slider = (key, label, min, max, step) =>
    `<div class="ctl"><div class="ctl-head"><span>${label}</span><b id="val-${key}">${sliderText(key, state.cfg[key])}</b></div><input type="range" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${state.cfg[key]}"></div>`;
  const modSlider = (key, label, min, max, step) =>
    `<div class="ctl"><div class="ctl-head"><span>${label}</span><b id="val-m-${key}">${modSliderText(key)}</b></div><input type="range" data-mod="${key}" min="${min}" max="${max}" step="${step}" value="${state.cfg.slots[state.slot][key]}"></div>`;
  const sec = (title, right) => `<div class="sec"><span>${title}</span>${right ? `<b>${right}</b>` : ''}</div>`;
  const escItems = () => Object.entries(P.ESCS).map(([k, e]) => [k, `${e.cont} A · ${e.maxS}S`]);
  const tog = (key, label, on) => `<button class="tog${on ? ' active' : ''}" data-key="${key}" data-val="${!on}"><i></i>${label}</button>`;

  function htmlChassis() {
    const c = state.cfg, b = state.build, ch = b.chassis;
    let h = sec('WEIGHT CLASS', `${b.u.className}`);
    h += '<div class="seg cls">' + Object.entries(P.CLASSES).map(([k, cl]) => `<button data-key="cls" data-val="${k}" class="${c.cls === k ? 'active' : ''}" title="${cl.name}">${cl.lb}&nbsp;LB</button>`).join('') + '</div>';
    h += cfgSeg('cluster', [['false', 'SINGLE BOT'], ['true', 'CLUSTER · TWO BOTS']], String(c.cluster));
    h += `<div class="note">${c.cluster ? 'Two identical bots share the class limit, so each may weigh half of it.' : 'Smaller classes are shown as scale models of the same design: lengths, masses, voltages and energies all shrink together.'}</div>`;
    h += sec('CHASSIS', `${lb(b.parts.find((p) => p.id === 'frame').total)} LB FRAME`);
    for (const [k, cs] of Object.entries(P.CHASSIS)) h += cfgOpt('chassis', k, cs.name, `${cs.desc} · ${inch(cs.L, 0)} × ${inch(cs.W, 0)} × ${inch(cs.H)} IN`, c.chassis === k, cs.legs ? `${cs.legs}&nbsp;LEGS` : cs.tracks ? 'TRACKS' : cs.caster ? '2WD+CASTER' : `${cs.wheels}WD`);
    h += sec('DIMENSIONS', `${inch(ch.L, 0)} × ${inch(ch.W, 0)} × ${inch(ch.H)} IN`);
    h += slider('dimL', ch.shape === 'round' ? 'DIAMETER' : 'LENGTH', 0.8, 1.25, 0.01);
    if (ch.shape !== 'round') h += slider('dimW', 'WIDTH', 0.8, 1.25, 0.01);
    h += slider('dimH', 'HEIGHT', 0.8, 1.25, 0.01);
    h += sec('BALLAST');
    h += slider('ballastKg', 'TUNGSTEN BALLAST', 0, 20, 0.5);
    h += slider('ballastZ', 'POSITION', -1, 1, 0.1);
    h += `<div class="note">Every chassis is bare and exposes five hardpoints (front, top, rear, left, right). Any module can go on any of them unless it would get in the way of a module that is already fitted. Ballast moves the centre of mass without changing anything else.</div>`;
    return h;
  }

  function htmlModuleCatalog() {
    const c = state.cfg, cur = c.slots[state.slot];
    let h = cfgOptRaw('data-install', '', 'EMPTY', 'NOTHING ON THIS HARDPOINT', !cur);
    let nBlocked = 0;
    const others = SLOTS.filter((s) => s !== state.slot && c.slots[s]).length;
    if (others) h += `<div class="note">Modules that would get in the way of what is already installed, or block its line of fire, are marked <b>BLOCKED</b> and cannot be fitted here.</div>`;
    for (const cat of P.MODULE_CATS) {
      h += sec(cat);
      for (const [k, m] of Object.entries(P.MODULES)) {
        if (m.cat !== cat) continue;
        const tag = m.legal === 'exhibition' ? 'EXHIBITION' : m.legal === 'restricted' ? 'RESTRICTED' : '';
        const why = cur && cur.type === k ? null : blockedBy(state.slot, k);
        if (why) { h += `<button class="opt blocked" disabled title="${why}"><span class="opt-name">${m.name}</span><span class="opt-spec">DOES NOT FIT · ${why}</span><span class="opt-tag hot">BLOCKED</span></button>`; nBlocked++; }
        else h += opt('data-install', k, m.name, m.desc, cur && cur.type === k, tag, m.legal === 'exhibition' ? 'hot' : 'warn');
      }
    }
    return h;
  }
  function cfgOptRaw(attr, val, name, spec, active) { return opt(attr, val, name, spec, active); }

  function htmlModuleTune() {
    const c = state.cfg, md = c.slots[state.slot], o = state.build.mods[state.slot];
    if (!md || !o) return `<div class="note">Nothing installed on the ${SLOT_NAMES[state.slot]} hardpoint. Pick a module from the parts bin first.</div>`;
    const def = o.def;
    let h = sec(def.name, `${lb(o.mass)} LB`);
    const sh = state.build.layout.shell;
    if (sh && sh.slot !== state.slot) {
      h += `<div class="note"><b>Full-body shell fitted.</b> The shell encloses the chassis, so this module cannot stay bolted to the chassis.</div>`;
      if (state.slot === 'top') {
        h += modSeg('ride', [['fixed', 'STATIONARY MAST'], ['spin', 'BOLTED TO SHELL']], md.ride);
        h += `<div class="note">${md.ride === 'spin' ? 'Bolted to the shell roof: it spins with the shell and is powered through a slip ring.' : 'Sits still on a platform carried by a hollow centre mast that passes through the shell hub; wiring runs up the bore.'}</div>`;
      } else h += `<div class="note">Side hardpoints move onto the shell wall: this module <b>spins with the shell</b> and is powered through a slip ring. Fit a matching module on the opposite side to keep the shell balanced.</div>`;
    }
    if (def.kind !== 'melty') h += modSlider('scale', 'SIZE', 0.7, 1.3, 0.01);
    else h += `<div class="note">The controller spins the whole bot with the drive motors and pulses them once per turn to move. Spin speed comes from the drive: change the drive motor, gearing and wheels to tune it, and keep the centre of mass on the spin axis.</div>`;
    if (def.teeth && def.teeth.length > 1) h += modSeg('teeth', def.teeth.map((t) => [t, `${t} ${t === 1 ? 'TOOTH' : 'TEETH'}`]), md.teeth);
    if (P.MOTORIZED.has(def.kind)) {
      h += sec(def.kind === 'crusher' ? 'PUMP MOTOR' : def.kind === 'lifter' ? 'LIFT MOTOR' : 'WEAPON MOTOR');
      for (const [k, m] of Object.entries(P.WEAPON_MOTORS)) h += opt('data-mod="motor" data-val', k, m.name, `${m.kv} KV · ${m.iMax} A BURST · ${lb(m.kg)} LB`, md.motor === k);
      if (def.multi) h += modSeg('count', [[1, 'SINGLE MOTOR'], [2, 'DUAL MOTORS']], md.count);
      h += modSlider('ratio', def.kind === 'spinner' || def.kind === 'armsaw' ? 'REDUCTION (MOTOR : ROTOR)' : 'GEARING MULTIPLIER', 0.6, 6, 0.05);
      if (def.kind === 'spinner' || def.kind === 'armsaw') { h += sec('TRANSMISSION'); h += modSeg('trans', Object.entries(P.TRANSMISSIONS).map(([k, t]) => [k, t.name]), md.trans); }
      h += sec('SPEED CONTROLLER');
      h += modSeg('esc', escItems(), md.esc);
    }
    if (P.PRESSURIZED.has(def.kind)) {
      h += sec('PNEUMATICS');
      h += modSeg('gas', Object.entries(P.GAS).map(([k, g]) => [k, g.name]), md.gas);
      h += modSlider('pressure', 'BUFFER PRESSURE', 20, 80, 1);
      h += `<div class="note">${md.gas === 'co2' ? 'Liquid CO2 gives many more shots from a lighter bottle, but its vapour pressure caps the buffer near 55 bar and it loses force as the bottle chills.' : 'Nitrogen is stored at 300 bar and regulated down to the buffer pressure. Higher pressure hits harder but uses more gas per shot.'}</div>`;
    }
    if (def.legal === 'exhibition') h += `<div class="note"><b>Exhibition only.</b> This module is modelled for fun and is not legal at real combat-robot events.</div>`;
    else if (def.legal === 'restricted') h += `<div class="note"><b>Restricted.</b> Real events allow this only within event-specific limits.</div>`;
    return h;
  }

  function htmlHardpoints(showMap) {
    const c = state.cfg;
    let h = '';
    if (showMap) {
      h += '<div class="hp-map"><div class="hp-body"></div>';
      for (const s of SLOTS) {
        const md = c.slots[s];
        h += `<button class="hp-pad hp-${s}${md ? ' full' : ''}${state.slot === s ? ' active' : ''}" data-slot="${s}"><b>${SLOT_SHORT[s]}</b><span>${md ? P.MODULES[md.type].name : 'EMPTY'}</span></button>`;
      }
      h += '</div>';
    }
    h += seg('data-hp', [['module', 'PARTS BIN'], ['tune', 'TUNE MODULE', !c.slots[state.slot]]], state.hpTab === 'tune' && c.slots[state.slot] ? 'tune' : 'module');
    h += state.hpTab === 'tune' && c.slots[state.slot] ? htmlModuleTune() : htmlModuleCatalog();
    return h;
  }

  function htmlDrive(withEsc) {
    const c = state.cfg, b = state.build, lay = b.layout, ch = b.chassis;
    const n = lay.driveMotors.length;
    let h = sec(b.isDog ? 'LEG ACTUATOR MOTOR' : 'DRIVE MOTOR', `x${n}`);
    for (const [k, m] of Object.entries(P.DRIVE_MOTORS)) h += cfgOpt('driveMotor', k, m.name, `${m.kv} KV · ${m.iMax} A BURST · ${lb(m.kg)} LB`, c.driveMotor === k);
    h += slider('driveRatio', 'GEARBOX RATIO', 4, 40, 0.5);
    if (!b.isDog) {
      h += sec('WHEELS', `x${lay.wheels.length}`);
      for (const [k, w] of Object.entries(P.WHEELS)) h += cfgOpt('wheel', k, w.name, `Ø${inch(w.d)} IN · μ ${w.mu.toFixed(2)} · ${lb(w.kg)} LB${w.strafe ? ' · STRAFES' : ''}`, c.wheel === k);
      const fixed = ch.shape === 'round' || ch.tracks || ch.caster;
      h += sec('WHEEL COUNT', fixed ? 'FIXED BY THIS CHASSIS' : '');
      h += cfgSeg('wheelCount', [[0, 'STOCK', fixed], [2, '2', fixed], [4, '4', fixed], [6, '6', fixed], [8, '8', fixed]], c.wheelCount);
      h += sec('TYRE COMPOUND', `μ ${b.drive.mu.toFixed(2)}`);
      h += cfgSeg('tyre', Object.entries(P.TYRES).map(([k, t]) => [k, t.name]), c.tyre);
      h += `<div class="note">${P.TYRES[c.tyre].note.charAt(0) + P.TYRES[c.tyre].note.slice(1).toLowerCase()}.</div>`;
      h += sec('FLOOR MAGNETS', c.magnets ? `${fmt(b.drive.downforce)} N` : '');
      h += cfgSeg('magnets', [[0, 'NONE'], [1, '1 PAIR'], [2, '2 PAIRS'], [3, '3 PAIRS']], c.magnets);
    }
    h += sec('DRIVE OPTIONS');
    h += '<div class="togs">' + tog('twoSpeed', 'TWO-SPEED GEARBOX', c.twoSpeed) + (b.isDog ? '' : tog('hub', 'HUB MOTORS', c.hub) + tog('susp', 'SUSPENSION', c.susp) + tog('guards', 'WHEEL GUARDS', c.guards)) + '</div>';
    if (withEsc) { h += sec('DRIVE ESC', 'x2'); h += cfgSeg('driveEsc', escItems(), c.driveEsc); }
    const how = b.isDog ? `${ch.legs} leg actuators, one per leg${ch.legs > 4 ? ', walking as two alternating tripods' : ', driven in a trot'}. Wheel choices do not apply to a walker.`
      : c.hub ? 'One motor inside every wheel hub: no chains to lose, more motors to carry.'
        : ch.tracks ? 'Two motors, each driving a rubber track over four road wheels.'
          : lay.nW >= 4 ? 'Two motors, each chained to every wheel on its side.' : 'Two motors, each direct-driving one wheel. The axle is placed under the centre of mass.';
    h += `<div class="note">${how} Two-speed gearboxes push in low gear and sprint in high. Suspension keeps the tyres loaded; guards close the wheel arches; magnets add grip on a steel floor only.</div>`;
    return h;
  }

  function htmlPower() {
    const c = state.cfg, b = state.build;
    let h = sec('BATTERY', `${fmt(b.electrical.whTotal)} WH TOTAL`);
    for (const [k, bt] of Object.entries(P.BATTERIES)) h += cfgOpt('battery', k, bt.name, `${bt.vCell} V/CELL · ${fmt(bt.ah * bt.c)} A MAX PER PACK`, c.battery === k);
    h += sec('CELLS IN SERIES', `${b.electrical.vNom.toFixed(1)} V`);
    h += cfgSeg('cells', P.CELL_OPTIONS.map((s) => [s, `${s}S`]), c.cells);
    h += sec('PACKS IN PARALLEL', `${lb(b.electrical.packKg * c.parallel)} LB`);
    h += cfgSeg('parallel', [1, 2, 3, 4].map((n) => [n, `${n}P`]), c.parallel);
    h += sec('BUS ARCHITECTURE');
    h += cfgSeg('bus', [['shared', 'SHARED BUS'], ['isolated', 'ISOLATED', c.parallel < 2]], b.electrical.isolated ? 'isolated' : 'shared');
    h += `<div class="note">Isolated gives the drive its own pack and master switch, so weapon current cannot sag the drive. Needs at least 2 packs.</div>`;
    const nx = Object.keys(P.EXTRAS).filter((k) => c.extras[k]).length;
    h += sec('COMPONENTS', nx ? `${nx} FITTED` : 'OPTIONAL');
    for (const [k, x] of Object.entries(P.EXTRAS)) h += `<button class="opt${c.extras[k] ? ' active' : ''}" data-extra="${k}"><span class="opt-name">${x.name}</span><span class="opt-spec">${x.spec} · ${lb(x.kg, 2)} LB</span><span class="opt-tag">${c.extras[k] ? 'FITTED' : 'ADD'}</span></button>`;
    return h;
  }

  function htmlControl() {
    const c = state.cfg, b = state.build, e = b.electrical;
    let h = sec('DRIVE ESC', 'x2');
    h += cfgSeg('driveEsc', escItems(), c.driveEsc);
    h += sec('HARNESS');
    h += `<div class="st-sum"><span>MAIN WIRE</span><span>${e.gaugeAwg} AWG SILICONE</span><span>MAIN FUSE</span><span>${e.fuseA} A</span><span>MASTER SWITCHES</span><span>${b.layout.switches.length}</span><span>WEAPON ESCS</span><span>${e.nWeaponEsc}</span><span>RECEIVER</span><span>2.4 GHZ · FAILSAFE</span></div>`;
    h += `<div class="note">Wire gauge and fuse are sized from the peak bus current. Weapon speed controllers arrive with their modules at the hardpoint stations and stack on top of the packs.</div>`;
    return h;
  }

  function htmlArmor() {
    const c = state.cfg, b = state.build;
    let h = sec('ARMOR', `${lb(b.byCat.ARMOR)} LB`);
    h += seg('data-armor', [['uniform', 'ONE PLATE SPEC'], ['faces', 'FACE BY FACE']], c.armorFaces ? 'faces' : 'uniform');
    if (!c.armorFaces) {
      h += sec('ARMOR MATERIAL');
      for (const [k, m] of Object.entries(P.MATERIALS)) h += cfgOpt('armorMat', k, m.name, `${m.note} · ${fmt(m.rho)} KG/M³ · ${fmt(m.yieldMPa)} MPA`, c.armorMat === k);
      h += slider('armorT', 'PERIMETER THICKNESS', 2, 12, 0.5);
      h += `<div class="note">Areal density ${fmt(b.armor.arealKgM2, 1)} KG/M² · plate strength index ${fmt(b.armor.strengthIdx, 1)} (yield × thickness², a relative bending-strength comparison). The top plate is 60% of the perimeter thickness.</div>`;
    } else {
      for (const fc of P.FACES) {
        const f = c.armorFaces[fc], m = P.MATERIALS[f.mat];
        h += sec(FACE_NAMES[fc], `${m.name}`);
        h += '<div class="seg mats">' + Object.keys(P.MATERIALS).map((k) => `<button data-face="${fc}" data-fkey="mat" data-val="${k}" class="${f.mat === k ? 'active' : ''}">${MAT_SHORT[k]}</button>`).join('') + '</div>';
        h += `<div class="ctl"><div class="ctl-head"><span>THICKNESS</span><b id="val-f-${fc}">${f.t.toFixed(1)} MM</b></div><input type="range" data-face="${fc}" data-fkey="t" min="${fc === 'top' ? 1.5 : 2}" max="12" step="0.5" value="${f.t}"></div>`;
      }
      h += `<div class="note">Put the heavy plate where the hits land and save weight elsewhere. Each face shows its own stock on bare edges; pick the BARE METAL livery to see the materials themselves.</div>`;
    }
    return h;
  }

  function htmlPaint() {
    const c = state.cfg;
    const cur = c.paint || (() => { const lv = Mdl.LIVERIES[c.livery] || Mdl.LIVERIES.signal; return { armor: lv.armor, top: lv.top, accent: lv.accent }; })();
    let h = sec('LIVERY');
    h += '<div class="swatches">';
    for (const [k, lv] of Object.entries(Mdl.LIVERIES)) h += `<button class="swatch${c.livery === k ? ' active' : ''}" data-key="livery" data-val="${k}"><i style="background:${lv.armor}"></i><i style="background:${lv.top}"></i><i style="background:${lv.accent}"></i>${lv.name}</button>`;
    h += '</div>';
    h += sec('CUSTOM COLOURS', c.livery === 'custom' ? 'IN USE' : '');
    h += `<div class="paint-row${c.livery === 'custom' ? ' active' : ''}">${[['armor', 'BODY'], ['top', 'TOP PLATE'], ['accent', 'ACCENT']].map(([k, n]) => `<label><input type="color" data-paint="${k}" value="${cur[k]}"><span>${n}</span></label>`).join('')}</div>`;
    h += `<div class="note">Pick any colour to switch the build to a custom livery.</div>`;
    h += sec('TEAM LETTERING', c.text ? 'ON THE ARMOUR' : 'NONE');
    h += `<div class="text-row"><input type="text" id="team-text" maxlength="10" placeholder="TEAM NAME" value="${c.text}" spellcheck="false"><button class="sim-btn" data-act="text">APPLY</button></div>`;
    h += `<div class="note">Up to 10 letters and digits, stencilled on the side armour and the battery hatch.</div>`;
    h += sec('FINISH');
    h += cfgSeg('finish', Object.entries(P.FINISHES).map(([k, n]) => [k, n]), c.finish);
    h += `<div class="note">Factory fresh has painted plate edges and no marks. Pit worn shows bare edges and scratches. Battle scarred adds gouges. The unit number on the armour comes from the digits in the build name.</div>`;
    return h;
  }

  function htmlRollout() {
    const b = state.build;
    const mods = b.active.map((s) => `<span>${SLOT_NAMES[s]}</span><span>${b.mods[s].def.name}</span>`).join('') || '<span>HARDPOINTS</span><span>ALL EMPTY</span>';
    let h = `<div class="st-sum"><span>CHASSIS</span><span>${b.chassis.name}</span>${mods}<span>CLASS</span><span>${b.u.className}${b.u.count > 1 ? ' · CLUSTER' : ''}</span><span>WEIGHT</span><span style="color:${b.massLb > 250 ? 'var(--accent)' : 'var(--ink)'}">${fmt(b.massLb, 1)} LB / 250 LB</span><span>EST. COST</span><span>${usd(b.cost)}</span><span>TOP SPEED</span><span>${fmt(b.drive.topSpeed * MS_TO_MPH, 1)} MPH</span><span>PACK</span><span>${b.electrical.S}S${b.electrical.P}P · ${fmt(b.electrical.whTotal)} WH</span><span>PARTS</span><span>${b.parts.reduce((a, p) => a + p.qty, 0)}</span></div>`;
    h += sec('INSPECTION', b.fails ? `${b.fails} FAIL` : b.warns ? `${b.warns} WARN` : 'ALL PASS');
    const order = { fail: 0, warn: 1, info: 2, pass: 3 };
    h += b.checks.slice().sort((x, y) => order[x.status] - order[y.status]).slice(0, 9).map((x) => `<div class="check ${x.status}"><i></i><div><b>${x.label}</b><span>${x.detail}</span></div></div>`).join('');
    h += `<div style="height:8px"></div><button class="opt active" data-act="rollout"><span class="opt-name">ROLL OUT TO THE ARENA ▶</span><span class="opt-spec">OPEN THIS BUILD IN THE STUDIO TEST STAND</span></button>`;
    h += `<button class="opt" data-act="save"><span class="opt-name">SAVE TO GARAGE</span><span class="opt-spec">STORED IN THIS BROWSER</span></button>`;
    return h;
  }

  function tabHtml() {
    if (state.mode === 'factory') {
      const st = STATIONS[state.station];
      let h = `<div class="st-eyebrow">STATION ${String(state.station + 1).padStart(2, '0')} / ${STATIONS.length}</div><div class="st-head">${st.label}</div><div class="note">${st.blurb}</div>`;
      if (st.slot) h += htmlHardpoints(false);
      else if (st.tab === 'chassis') h += htmlChassis();
      else if (st.tab === 'drive') h += htmlDrive(false);
      else if (st.tab === 'power') h += htmlPower();
      else if (st.tab === 'control') h += htmlControl();
      else if (st.tab === 'armor') h += htmlArmor();
      else if (st.tab === 'paint') h += htmlPaint();
      else h += htmlRollout();
      return h;
    }
    if (state.tab === 'chassis') return htmlChassis();
    if (state.tab === 'hard') return htmlHardpoints(true);
    if (state.tab === 'drive') return htmlDrive(true);
    if (state.tab === 'power') return htmlPower();
    if (state.tab === 'armor') return htmlArmor();
    return htmlPaint();
  }

  function renderTabs() {
    $('cfg-tabs').innerHTML = TABS.map(([k, label]) => `<button class="cfg-tab${state.tab === k ? ' active' : ''}" data-tab="${k}">${label}</button>`).join('');
    $('station-rail').innerHTML = STATIONS.map((st, i) => `<button class="st-dot${i === state.station ? ' active' : i < state.station ? ' done' : ''}" data-station="${i}" title="${st.label}">${i + 1}</button>`).join('');
    $('build-title').textContent = state.mode === 'factory' ? 'FACTORY FLOOR' : 'BUILD';
    $('st-prev').disabled = state.station === 0;
    $('st-next').textContent = state.station >= STATIONS.length - 1 ? 'TO THE ARENA ▶' : 'NEXT STATION ▶';
  }
  function renderTabBody() {
    const body = $('cfg-body');
    const scroll = body.scrollTop;
    body.innerHTML = sc(tabHtml());
    body.scrollTop = scroll;
  }

  $('cfg-tabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (!t) return;
    state.tab = t.dataset.tab;
    renderTabs();
    $('cfg-body').scrollTop = 0;
    renderTabBody();
    placeMarker();
  });
  $('cfg-body').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t || t.disabled) return;
    const d = t.dataset;
    if (d.slot) { state.slot = d.slot; state.hpTab = 'module'; placeMarker(); renderTabBody(); renderHud(); return; }
    if (d.hp) { state.hpTab = d.hp; $('cfg-body').scrollTop = 0; renderTabBody(); return; }
    if (d.install !== undefined) { installModule(state.slot, d.install || null); return; }
    if (d.mod) { setMod(d.mod, NUM_KEYS.has(d.mod) ? Number(d.val) : d.val, false); return; }
    if (d.extra) { patchCfg({ extras: { ...state.cfg.extras, [d.extra]: !state.cfg.extras[d.extra] } }); return; }
    if (d.armor) { patchCfg({ armorFaces: d.armor === 'faces' ? faceCfg() : null }); return; }
    if (d.face) { setFace(d.face, d.fkey, d.val, false); return; }
    if (d.act === 'text') { patchCfg({ text: $('team-text').value }); return; }
    if (d.act === 'rollout') { setMode('studio'); return; }
    if (d.act === 'save') { saveBuild(); t.querySelector('.opt-name').textContent = 'SAVED ✓'; return; }
    if (d.key) setCfg(d.key, BOOL_KEYS.has(d.key) ? d.val === 'true' : NUM_KEYS.has(d.key) ? Number(d.val) : d.val, false);
  });
  $('cfg-body').addEventListener('input', (e) => {
    const t = e.target;
    if (!t.matches('input[type=range]')) return;
    if (t.dataset.mod) setMod(t.dataset.mod, Number(t.value), true);
    else if (t.dataset.face) setFace(t.dataset.face, 't', Number(t.value), true);
    else if (t.dataset.key) setCfg(t.dataset.key, Number(t.value), true);
  });
  $('cfg-body').addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('input[type=range]')) renderTabBody();
    else if (t.dataset.paint) {
      const lv = Mdl.LIVERIES[state.cfg.livery] || Mdl.LIVERIES.signal;
      const base = state.cfg.paint || { armor: lv.armor, top: lv.top, accent: lv.accent };
      patchCfg({ livery: 'custom', paint: { ...base, [t.dataset.paint]: t.value } });
    } else if (t.id === 'team-text') patchCfg({ text: t.value });
  });

  // ---------------------------------------------------------------------------
  // FACTORY FLOOR
  // ---------------------------------------------------------------------------
  const stageOfStation = () => STATIONS[state.station].stage;
  function startDrop() {
    const stage = stageOfStation();
    const any = state.model.explode.some((g) => g.userData.stage === stage && g.children.length);
    state.drop = any && STATIONS[state.station].id !== 'paint' && STATIONS[state.station].id !== 'rollout' ? { stage, t: 0 } : null;
  }
  function goStation(i, animate) {
    state.station = clamp(i, 0, STATIONS.length - 1);
    const st = STATIONS[state.station];
    if (st.slot) { state.slot = st.slot; state.hpTab = 'module'; }
    applyView();
    if (animate) startDrop(); else state.drop = null;
    placeMarker();
    renderTabs();
    $('cfg-body').scrollTop = 0;
    renderTabBody();
    renderHud();
  }
  function setMode(mode) {
    state.mode = mode;
    document.body.classList.toggle('factory', mode === 'factory');
    document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    syncTwin();
    E.setStage(mode === 'factory' ? 'factory' : 'arena');
    state.view.invert = false;
    state.view.turntable = false;
    state.drop = null;
    if (mode === 'factory') { state.teardown = 0; goStation(0, true); }
    else { applyView(); placeMarker(); renderAll(); }
    resetTest();
    card.style.display = 'none';
  }
  $('mode-switch').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    if (b.dataset.mode === 'arena') { if (window.BBArena) window.BBArena.open({ build: state.build, presets: P.PRESETS, onClose: () => {} }); return; }
    if (b.dataset.mode !== state.mode) setMode(b.dataset.mode);
  });
  $('station-rail').addEventListener('click', (e) => { const b = e.target.closest('[data-station]'); if (b) goStation(Number(b.dataset.station), Number(b.dataset.station) > state.station); });
  $('st-prev').addEventListener('click', () => goStation(state.station - 1, false));
  $('st-next').addEventListener('click', () => { if (state.station >= STATIONS.length - 1) setMode('studio'); else goStation(state.station + 1, true); });
  $('st-new').addEventListener('click', () => {
    const n = String(Math.floor(Math.random() * 89) + 10);
    state.cfg = P.normalize({ ...P.DEFAULT_CFG, name: 'UNIT ' + n, cls: state.cfg.cls, finish: 'factory', slots: { front: null, top: null, rear: null, left: null, right: null } });
    state.station = 0;
    rebuild({ noDrop: true });
    goStation(0, true);
  });

  // ---------------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------------
  const kv = (rows) => rows.map(([k, v, bad]) => `<span class="k">${k}</span><span class="v${bad ? ' bad' : ''}">${v}</span>`).join('');
  const statusOf = (id) => { const c = state.build.checks.find((x) => x.id === id); return c ? c.status : 'pass'; };
  const moduleNames = (b) => (b.active.length ? b.active.map((s) => b.mods[s].def.name).join(' + ') : 'NO MODULES');

  function renderHud() {
    const b = state.build, c = state.cfg, e = b.electrical;
    $('hdr-title').textContent = c.name;
    $('hdr-subtitle').textContent = `${b.chassis.name} / ${moduleNames(b)}`;
    $('hdr-eyebrow').textContent = `BATTLEBOT DESIGNER · ${b.u.className}${b.u.count > 1 ? ' ×2' : ''}`;
    $('load-mid').textContent = `${limS(b.u.limitLb / 2)} LB`;
    $('load-max').textContent = `${limS(b.u.limitLb)} LB LIMIT${b.u.count > 1 ? ' EACH' : ''}`;
    syncHistButtons();

    const frac = b.massLb / P.LIMITS.weightLb;
    const on = Math.min(28, Math.round(frac * 28));
    loadTickSpans.forEach((sp, i) => { sp.className = i < on ? (frac > 1 ? 'over' : i >= 25 ? 'burst' : 'on') : ''; });
    $('load-pct').textContent = `${lbS(b.mass)} / ${limS(b.u.limitLb)} LB`;
    $('load-pct').style.color = frac > 1 ? 'var(--accent)' : '';

    const total = b.checks.filter((x) => x.status !== 'info').length;
    const passed = b.checks.filter((x) => x.status === 'pass').length;
    $('meta-checks').textContent = `${passed} / ${total}`;
    $('meta-status').textContent = b.fails ? `${b.fails} FAIL${b.fails > 1 ? 'S' : ''}` : b.warns ? `${b.warns} WARNING${b.warns > 1 ? 'S' : ''}` : 'ALL CLEAR';
    $('meta-status-dot').className = b.fails ? 'status-dot warn' : 'status-dot';

    // module panel: the selected hardpoint, or the first occupied one
    const shown = b.mods[state.slot] ? state.slot : b.active[0];
    const o = shown ? b.mods[shown] : null;
    $('w-chips').innerHTML = b.active.map((s) => `<button class="slot-chip${s === shown ? ' active' : ''}" data-slot="${s}">${SLOT_SHORT[s]}</button>`).join('');
    if (o) {
      $('w-title').textContent = o.def.name;
      const hero = sc(`${o.hero.v} ${o.hero.u}`), cut = o.hero.u ? hero.lastIndexOf(' ') : -1;
      $('w-hero').textContent = cut < 0 ? o.hero.v : hero.slice(0, cut);
      $('w-hero-unit').textContent = cut < 0 ? '' : hero.slice(cut + 1);
      $('w-hero-lbl').textContent = o.hero.l;
      const rows = o.rows.slice(0, 5);
      if (o.spin && b.dyn.biteSlot === shown) rows[3] = ['BITE AT TOP SPEED', `${fmt(b.dyn.bite * 1000)} MM<small>${inch(b.dyn.bite, 2)} IN</small>`];
      $('w-rows').innerHTML = sc(kv(rows));
    } else {
      $('w-title').textContent = 'MODULE';
      $('w-hero').textContent = '—';
      $('w-hero-unit').textContent = '';
      $('w-hero-lbl').textContent = 'NO MODULES INSTALLED';
      $('w-rows').innerHTML = kv([['HARDPOINTS', '5 FREE'], ['TIP', 'OPEN THE HARDPOINTS TAB']]);
    }
    state.shown = shown;
    drawSpinChart();

    const wb = e.weaponBus, db = e.driveBus;
    $('e-rows').innerHTML = sc(kv([
      ['PACK', `${e.S}S${e.P}P · ${e.vNom.toFixed(1)} V<small>${fmt(e.whTotal)} WH</small>`],
      [e.isolated ? 'WEAPON BUS PEAK' : 'BUS PEAK', `${fmt(wb.iPeak)} A<small>/ ${fmt(wb.iMax)} A RATED</small>`, statusOf('crate') === 'fail'],
      [e.isolated ? 'DRIVE BUS PEAK' : 'DRIVE SHARE', `${fmt(b.drive.iPeak)} A${e.isolated ? `<small>/ ${fmt(db.iMax)} A RATED</small>` : ''}`],
      ['MIN VOLTAGE', `${Math.min(wb.vMin, db.vMin).toFixed(1)} V<small>${Math.min(wb.vMinCell, db.vMinCell).toFixed(2)} V/CELL</small>`, statusOf('sag') === 'fail'],
      ['MATCH ENERGY', `${fmt(e.whNeeded)} WH<small>/ ${fmt(e.whUsable)} WH USABLE</small>`, statusOf('energy') === 'fail'],
      ['HARNESS · FUSE', `${e.gaugeAwg} AWG<small>${e.fuseA} A FUSE</small>`],
    ]));

    const d = b.drive, dyn = b.dyn;
    const rows = [
      ['TOP SPEED', `${fmt(d.topSpeed * MS_TO_MPH, 1)} MPH<small>${d.topSpeed.toFixed(1)} M/S</small>`],
      ['PUSH FORCE', `${fmt(d.push * N_TO_LBF)} LBF<small>${d.stallRisk ? 'MOTOR-LIMITED' : 'TRACTION-LIMITED'}</small>`, d.stallRisk],
    ];
    if (dyn.gyroTurnLimit !== undefined) rows.push(['GYRO TURN LIMIT', `${fmt((dyn.gyroTurnLimit * 180) / Math.PI)} °/S<small>AT FULL SPEED</small>`, statusOf('gyro') === 'fail']);
    else if (dyn.reactionTorque !== undefined) rows.push(['SPIN-UP REACTION', `${fmt(dyn.reactionTorque)} N·M<small>/ ${fmt(dyn.yawGrip)} N·M GRIP</small>`, statusOf('react') !== 'pass']);
    else rows.push(['ACCELERATION', `${(d.accel / P.G).toFixed(2)}G`]);
    rows.push(['CG', `${b.cg.z >= 0 ? '+' : ''}${inch(b.cg.z)} IN FWD<small>${inch(b.cg.y)} IN HIGH</small>`]);
    rows.push(['IF FLIPPED', b.invertible ? 'DRIVES INVERTED' : b.selfRights ? 'SELF-RIGHTS' : 'STRANDED', !b.invertible && !b.selfRights]);
    $('d-rows').innerHTML = sc(kv(rows));

    const order = { fail: 0, warn: 1, info: 2, pass: 3 };
    const sorted = b.checks.slice().sort((x, y) => order[x.status] - order[y.status]);
    $('checks-list').innerHTML = sorted.map((x) => `<div class="check ${x.status}"><i></i><div><b>${x.label}</b><span>${sc(x.detail)}</span></div></div>`).join('');
    const sum = $('checks-summary');
    sum.textContent = b.fails ? `${b.fails} FAIL` : b.warns ? `${b.warns} WARN` : 'ALL PASS';
    sum.className = b.fails ? 'pill orange' : b.warns ? 'pill neutral' : 'pill green';

    const scaleLb = Math.max(b.massLb, P.LIMITS.weightLb) * 1.04;
    $('mass-bar').innerHTML = CAT_ORDER.map((cat) => `<div style="width:${(((b.byCat[cat] || 0) * KG_TO_LB) / scaleLb) * 100}%;background:${CAT_COLORS[cat]}" title="${cat}"></div>`).join('');
    $('mass-limit').style.left = `${(P.LIMITS.weightLb / scaleLb) * 100}%`;
    $('mass-legend').innerHTML = CAT_ORDER.map((cat) => `<span><i style="background:${CAT_COLORS[cat]}"></i>${cat}<small>${leg((b.byCat[cat] || 0) * KG_TO_LB * Math.pow(kNow(), 3))}</small></span>`).join('') +
      `<span style="margin-left:auto">COST<small>${usd(b.cost)}</small></span><span>TOTAL<small style="color:${frac > 1 ? 'var(--accent)' : 'var(--ink)'}">${lbS(b.mass)} LB</small></span>`;

    $('v-labels').classList.toggle('active', state.view.labels);
    $('v-xray').classList.toggle('active', state.view.xray);
    $('v-elec').classList.toggle('active', state.view.overlay === 'electrical');
    $('v-thermal').classList.toggle('active', state.view.overlay === 'thermal');
    $('v-cg').classList.toggle('active', state.view.cg);
    $('v-invert').classList.toggle('active', state.view.invert);
    $('v-turn').classList.toggle('active', state.view.turntable);
    $('v-teardown').value = String(Math.round(state.teardown * 100));
  }
  $('sys-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sys]');
    if (!b) return;
    const drive = b.dataset.sys === 'drive';
    $('e-rows').style.display = drive ? 'none' : '';
    $('d-rows').style.display = drive ? '' : 'none';
    $('sys-title').textContent = drive ? 'DRIVE · STABILITY' : 'ELECTRICAL';
    $('sys-tabs').querySelectorAll('.sys-tab').forEach((q) => q.classList.toggle('active', q === b));
  });
  $('w-chips').addEventListener('click', (e) => { const b = e.target.closest('[data-slot]'); if (!b) return; state.slot = b.dataset.slot; placeMarker(); renderHud(); if (state.tab === 'hard' || state.mode === 'factory') renderTabBody(); });

  function drawSpinChart() {
    const o = state.shown ? state.build.mods[state.shown] : null;
    const svg = $('w-chart');
    if (!o || !o.spin || !o.spin.curve.length) { svg.innerHTML = ''; return; }
    const s = o.spin, Wc = 150, Hc = 56;
    const tMax = s.tEnd, wMax = s.wFinal || 1;
    const pts = s.curve.map((p) => `${((p.t / tMax) * Wc).toFixed(1)},${(Hc - (p.w / wMax) * (Hc - 4)).toFixed(1)}`).join(' ');
    let h = `<line x1="0" y1="${Hc}" x2="${Wc}" y2="${Hc}" stroke="#3a3f4a" stroke-width="1"/>`;
    h += `<polyline points="${pts}" fill="none" stroke="#ff5a1f" stroke-width="2.2"/>`;
    if (s.t90 !== null) { const x = (s.t90 / tMax) * Wc; h += `<line x1="${x.toFixed(1)}" y1="2" x2="${x.toFixed(1)}" y2="${Hc}" stroke="#c4c6cb" stroke-width="0.8" stroke-dasharray="2 2"/>`; }
    h += `<circle id="w-chart-dot" cx="0" cy="${Hc}" r="3.6" fill="#ecebe6" style="display:none"/>`;
    h += `<text x="${Wc}" y="${Hc + 13}" text-anchor="end" font-family="JetBrains Mono" font-size="10.5" fill="#9aa0ab" letter-spacing="0.5">${sc(`RPM VS TIME · ${tMax.toFixed(tMax < 10 ? 1 : 0)} S`)}</text>`;
    svg.innerHTML = h;
  }

  function renderAll() {
    renderTabs();
    renderTabBody();
    renderHud();
    renderTestBar();
  }

  // ---------------------------------------------------------------------------
  // VIEW CONTROLS
  // ---------------------------------------------------------------------------
  function refreshView() { applyView(); renderHud(); }
  $('v-labels').addEventListener('click', () => { state.view.labels = !state.view.labels; refreshView(); });
  $('v-xray').addEventListener('click', () => { state.view.xray = !state.view.xray; refreshView(); });
  $('v-elec').addEventListener('click', () => { state.view.overlay = state.view.overlay === 'electrical' ? 'none' : 'electrical'; refreshView(); });
  $('v-thermal').addEventListener('click', () => { state.view.overlay = state.view.overlay === 'thermal' ? 'none' : 'thermal'; refreshView(); });
  $('v-cg').addEventListener('click', () => { state.view.cg = !state.view.cg; if (state.view.cg) state.view.xray = true; refreshView(); });
  $('v-invert').addEventListener('click', () => { state.view.invert = !state.view.invert; refreshView(); });
  $('v-turn').addEventListener('click', () => { state.view.turntable = !state.view.turntable; refreshView(); });
  $('v-teardown').addEventListener('input', (e) => { state.teardown = Number(e.target.value) / 100; });

  // ---------------------------------------------------------------------------
  // TEST STAND — one control per installed module
  // ---------------------------------------------------------------------------
  function testLabel(slot) {
    const o = state.build.mods[slot], t = state.test.slots[slot], pre = SLOT_SHORT[slot] + ' · ';
    switch (t.kind) {
      case 'spin': return pre + (t.on ? 'SPIN DOWN' : 'SPIN UP');
      case 'swing': return pre + 'STRIKE';
      case 'fire': return `${pre}${o.action.verb} · ${t.shots}`;
      case 'toggle': return pre + (t.target ? o.action.back : o.action.verb);
      case 'burn': return pre + (t.on ? 'CUT FUEL' : 'IGNITE') + sc(` · ${Math.ceil(t.fuel)} S`);
      case 'arc': return pre + (t.cool > 0 ? `CHARGING ${t.cool.toFixed(1)}` : 'DISCHARGE');
      case 'shoot': return `${pre}FIRE · ${t.shots}`;
      default: return '';
    }
  }
  const testActive = (t) => t.on || t.phase !== 'idle' || t.target === 1 || t.level > 0.05 || t.fxU > 0;
  function renderTestBar() {
    if (!state.test || !state.build) return;
    let h = '<span class="t-label">TEST STAND</span>';
    for (const s of state.build.active) {
      const t = state.test.slots[s];
      if (t.kind === 'none') continue;
      h += `<button class="sim-btn go" data-test="${s}">${testLabel(s)}</button>`;
      if (t.chop) h += `<button class="sim-btn go" data-chop="${s}">${SLOT_SHORT[s]} · CHOP</button>`;
    }
    h += `<button class="sim-btn go" data-test="drive">${state.build.isDog ? 'WALK' : 'DRIVE'}</button>`;
    h += `<button class="sim-btn" data-test="stop" style="margin-left:auto">ALL STOP</button>`;
    $('test-bar').innerHTML = h;
    syncTestButtons();
  }
  function syncTestButtons() {
    const t = state.test;
    $('test-bar').querySelectorAll('[data-test]').forEach((b) => {
      const s = b.dataset.test;
      if (s === 'drive') b.classList.toggle('active', t.driveOn);
      else if (t.slots[s]) { const txt = testLabel(s); if (b.textContent !== txt) b.textContent = txt; b.classList.toggle('active', testActive(t.slots[s])); }
    });
    $('test-bar').querySelectorAll('[data-chop]').forEach((b) => b.classList.toggle('active', t.slots[b.dataset.chop].chop.phase !== 'idle'));
  }

  function trigger(slot) {
    const t = state.test.slots[slot], o = state.build.mods[slot];
    if (!t) return;
    if (t.kind === 'spin') {
      t.on = !t.on;
      if (t.on) { const hit = o.spin.curve.find((pt) => pt.w >= t.omega); t.t = hit ? hit.t : o.spin.tEnd; }
    } else if (t.kind === 'swing') { if (t.phase === 'idle') { t.phase = 'down'; t.timer = 0; } }
    else if (t.kind === 'fire') { if (t.phase === 'idle' && t.shots > 0) { t.phase = 'up'; t.timer = 0; t.shots -= 1; } }
    else if (t.kind === 'toggle') t.target = t.target ? 0 : 1;
    else if (t.kind === 'burn') { if (t.fuel > 0) t.on = !t.on; }
    else if (t.kind === 'arc') { if (t.cool <= 0 && t.phase === 'idle') { t.phase = 'zap'; t.timer = 0; } }
    else if (t.kind === 'shoot') { if (t.fxU === 0 && t.shots > 0) { t.fxU = 0.0001; t.shots -= o.type === 'cannon' ? Math.min(6, t.shots) : 1; } }
  }
  $('test-bar').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.chop) { const c = state.test.slots[d.chop].chop; if (c.phase === 'idle') { c.phase = 'down'; c.timer = 0; } }
    else if (d.test === 'drive') state.test.driveOn = !state.test.driveOn;
    else if (d.test === 'stop') { const keep = state.test; resetTest(); for (const s of Object.keys(keep.slots)) if (state.test.slots[s]) { state.test.slots[s].omega = keep.slots[s].omega; state.test.slots[s].angle = keep.slots[s].angle; state.test.slots[s].shots = keep.slots[s].shots; state.test.slots[s].fuel = keep.slots[s].fuel; } }
    else trigger(d.test);
    syncTestButtons();
  });

  function sampleCurve(curve, time) {
    if (!curve.length) return { w: 0, i: 0 };
    const idx = Math.min(curve.length - 1, Math.max(0, Math.floor(time / 0.1)));
    const a = curve[idx], b2 = curve[Math.min(curve.length - 1, idx + 1)];
    const u = clamp((time - a.t) / 0.1, 0, 1);
    return { w: lerp(a.w, b2.w, u), i: lerp(a.i, b2.i, u) };
  }
  const ease = (x) => x * x * (3 - 2 * x);
  const SHOT_TIME = { spike: 1.5, net: 1.3, coil: 0.6, cannon: 1.2, harpoon: 2.6 };

  function stepTest(dt) {
    const T = state.test, b = state.build;
    for (const slot of b.active) {
      const t = T.slots[slot], o = b.mods[slot];
      t.i = 0;
      if (t.kind === 'spin') {
        const s = o.spin;
        if (t.on) {
          t.t += dt;
          if (t.t >= s.tEnd) { t.omega = s.wFinal; t.i = s.iHold; }
          else { const p = sampleCurve(s.curve, t.t); t.omega = p.w; t.i = p.i; }
        } else { t.omega *= Math.exp(-dt / 3.5); if (t.omega < 0.5) t.omega = 0; }
        t.angle += Math.min(t.omega, 34) * dt;
        t.canAngle += Math.min(t.omega * o.md.ratio, 44) * dt;
        if (t.chop) {
          const c = t.chop;
          c.timer += dt;
          if (c.phase === 'down') { c.u = Math.min(1, c.u + dt / 0.3); if (c.u >= 1) { c.phase = 'hold'; c.timer = 0; } }
          else if (c.phase === 'hold') { if (c.timer > 0.7) c.phase = 'up'; }
          else if (c.phase === 'up') { c.u = Math.max(0, c.u - dt / 1.0); if (c.u <= 0) c.phase = 'idle'; }
        }
      } else if (t.kind === 'swing') {
        t.timer += dt;
        const down = Math.max(0.08, o.hammer.swingS * 0.5);
        if (t.phase === 'down') { t.u = Math.min(1, t.u + dt / down); t.i = o.iPeak; if (t.u >= 1) { t.phase = 'hold'; t.timer = 0; } }
        else if (t.phase === 'hold') { if (t.timer > 0.35) t.phase = 'up'; }
        else if (t.phase === 'up') { t.u = Math.max(0, t.u - dt / 0.9); t.i = o.iPeak * 0.2; if (t.u <= 0) t.phase = 'idle'; }
      } else if (t.kind === 'fire') {
        t.timer += dt;
        if (t.phase === 'up') { t.u = Math.min(1, t.u + dt / 0.09); if (t.u >= 1) { t.phase = 'hold'; t.timer = 0; } }
        else if (t.phase === 'hold') { if (t.timer > 0.35) t.phase = 'down'; }
        else if (t.phase === 'down') { t.u = Math.max(0, t.u - dt / 0.9); if (t.u <= 0) t.phase = 'idle'; }
      } else if (t.kind === 'toggle') {
        const span = clamp(o.action.timeS || 0.5, 0.25, 5);
        const dir = Math.sign(t.target - t.u);
        if (dir !== 0) {
          t.u = clamp(t.u + (dir * dt) / (dir > 0 ? span : Math.min(span, 1.2)), 0, 1);
          t.i = dir > 0 ? o.iPeak : o.iPeak * 0.3;
          t.phase = Math.abs(t.target - t.u) < 1e-4 ? 'idle' : 'move';
        } else t.phase = 'idle';
      } else if (t.kind === 'burn') {
        if (t.on) { t.fuel = Math.max(0, t.fuel - dt); if (t.fuel <= 0) t.on = false; t.i = o.iPeak; }
        t.level = clamp(t.level + (t.on ? dt * 3.5 : -dt * 5), 0, 1);
      } else if (t.kind === 'arc') {
        if (t.phase === 'zap') { t.timer += dt; t.level = 1; if (t.timer > 0.7) { t.phase = 'idle'; t.level = 0; t.cool = o.arc.rechargeS; } }
        else if (t.cool > 0) { t.cool = Math.max(0, t.cool - dt); t.i = o.iPeak; }
      } else if (t.kind === 'shoot') {
        if (t.fxU > 0) { t.fxU += dt / (SHOT_TIME[o.type] || 1); t.i = o.iPeak; if (t.fxU >= 1) t.fxU = 0; }
      }
    }
    // drive (free on the stand)
    const rEff = b.isDog ? 0.28 / (2 * Math.PI) : b.layout.wR;
    const wTarget = T.driveOn ? b.drive.topSpeed / rEff : 0;
    T.wheelW = lerp(T.wheelW, wTarget, 1 - Math.exp(-dt * 3));
    T.wheelAngle += Math.min(T.wheelW, 30) * dt;
    T.legAmp = lerp(T.legAmp, T.driveOn ? 1 : 0, 1 - Math.exp(-dt * 4));
    T.legPhase += dt * Math.min(2.4, 0.6 + b.drive.topSpeed * 0.5) * (T.legAmp > 0.02 ? 1 : 0);
    T.iD = T.driveOn ? b.drive.iPeak * 0.12 : 0;
  }

  const _tmp = new THREE.Vector3();
  function poseModel(dt) {
    const m = state.model, a = m.anim, T = state.test, b = state.build, S = m.scale;
    // teardown, factory stage mask and the lowering-in animation
    const factory = state.mode === 'factory';
    const maxStage = factory ? stageOfStation() : 99;
    let dropOff = 0;
    if (state.drop) {
      state.drop.t += dt / 1.1;
      dropOff = (1 - ease(clamp(state.drop.t, 0, 1))) * 0.95;
      if (state.drop.t >= 1.25) state.drop = null;
    }
    let hx = 0, hy = 0, hz = 0, hn = 0;
    for (const g of m.explode) {
      const ud = g.userData;
      g.visible = ud.stage <= maxStage;
      g.position.copy(ud.home).addScaledVector(ud.ex, Math.min(1, state.teardown * 1.6));
      if (state.drop && ud.stage === state.drop.stage && g.children.length) { g.position.y += dropOff; hx += ud.home.x; hz += ud.home.z; hn++; }
    }
    // hoist follows whatever is being lowered
    const hoisting = factory && state.drop && hn > 0 && state.drop.t < 1.12;
    E.hoist.visible = !!hoisting;
    if (hoisting) { hy = (state.frame.top + 0.12 + dropOff) * S; E.hoist.position.set((hx / hn) * S, hy, (hz / hn - state.frame.cz) * S); }

    state.invertF = lerp(state.invertF, state.view.invert ? 1 : 0, 1 - Math.exp(-dt * 5));
    const f = state.invertF;
    m.root.rotation.z = Math.PI * f;
    const off = state.frame.pairOff * S;
    m.root.position.set(-off, S * (b.invertRest * f + Math.sin(Math.PI * f) * 0.18), -state.frame.cz * S);
    // a melty-brain bot is its own rotor: the whole model turns about the vertical axis
    let whole = 0;
    for (const slot of b.active) if (a.slots[slot].whole) whole = T.slots[slot].angle;
    m.root.rotation.y = whole;
    // the cluster twin stands beside the first bot while the build is whole and upright
    twin.visible = twin.children.length > 0 && !factory && state.teardown < 0.02 && f < 0.01;
    if (twin.visible) { twin.position.set(off, 0, -state.frame.cz * S); twin.rotation.y = whole; }

    for (const slot of b.active) {
      const t = T.slots[slot], h = a.slots[slot], o = b.mods[slot];
      if (h.rotor) h.rotor(t.angle);
      if (h.cans) h.cans(t.canAngle);
      if (h.blur) h.blur(o.spin ? t.omega > o.spin.wFinal * 0.25 : false);
      if (h.pose) h.pose(t.chop ? ease(t.chop.u) : t.kind === 'fire' || t.kind === 'swing' ? t.u : ease(t.u));
      if (h.fx) h.fx(t.level, state.time, t.fxU);
    }
    for (const w of a.wheelsL) w.rotation.x = T.wheelAngle;
    for (const w of a.wheelsR) w.rotation.x = T.wheelAngle;
    for (const c of a.driveCans) c.mesh.rotation.x = T.wheelAngle * 3;
    if (a.legs) for (const l of a.legs) l.set(T.legPhase, T.legAmp);
    if (marker.visible) { const p = 1 + 0.18 * Math.sin(state.time * 5); marker.scale.set(p, p, 1); }
    // pieces last, once every wheel, rotor, arm and leg has its pose for this frame
    Mdl.explodePieces(m, ease(clamp((state.teardown - 0.2) / 0.8, 0, 1)));

    // current-flow pulses
    const elec = state.view.overlay === 'electrical';
    const e = b.electrical;
    let iW = 0;
    for (const s of b.active) iW += T.slots[s].i;
    T.iW = iW;
    for (const w of m.wires) {
      let cur = 0, ref = 1;
      if (w.bus === 'drive') { cur = T.iD; ref = Math.max(1, b.drive.iPeak); }
      else if (w.bus === 'main') { cur = e.isolated ? iW : iW + T.iD; ref = Math.max(1, e.weaponBus.iPeak); }
      else if (w.bus === 'signal') { cur = 1; ref = 12; }
      else { const s = w.bus.slice(2); cur = T.slots[s] ? T.slots[s].i : 0; ref = Math.max(1, b.mods[s] ? b.mods[s].iPeak : 1); }
      const active = elec && cur > 0.01 && w.parent.visible;
      const speed = 0.22 + 1.5 * Math.min(1, cur / ref);
      for (const p of w.pulses) {
        p.mesh.visible = active;
        if (active) p.mesh.position.copy(w.curve.getPoint((state.time * speed + p.offset) % 1));
      }
    }
    void _tmp;
  }

  function renderLive() {
    const T = state.test, b = state.build, e = b.electrical;
    if (state.mode === 'factory' && !(state.notice && state.time < state.notice.until)) {
      const st = STATIONS[state.station];
      $('mode-eyebrow').textContent = `FACTORY FLOOR · STATION ${state.station + 1} OF ${STATIONS.length}`;
      $('mode-big').textContent = st.label;
      const parts = b.parts.reduce((a, p) => a + p.qty, 0);
      $('mode-sub').textContent = sc(st.slot ? (b.mods[st.slot] ? `${b.mods[st.slot].def.name} INSTALLED · ${fmt(b.mods[st.slot].mass * KG_TO_LB, 1)} LB${b.mods[st.slot].mount.onShell ? ' · RIDES ON THE SHELL' : b.mods[st.slot].mount.onMast ? ' · ON THE STATIONARY MAST' : ''}` : 'HARDPOINT EMPTY · PICK A MODULE FROM THE PARTS BIN') : `${fmt(b.massLb, 1)} LB SPECIFIED · ${parts} PARTS`);
      return;
    }
    if (state.notice && state.time < state.notice.until) { $('mode-eyebrow').textContent = 'CHANGE REFUSED'; $('mode-big').textContent = 'DOES NOT FIT'; $('mode-sub').textContent = state.notice.text; return; }
    const iBus = (T.iW || 0) + (e.isolated ? 0 : T.iD);
    const vBus = e.vNom - iBus * e.weaponBus.r;
    const elecTxt = `${fmt(iBus)} A · ${vBus.toFixed(1)} V`;
    const live = b.active.filter((s) => testActive(T.slots[s]) || T.slots[s].omega > 0 || (T.slots[s].chop && T.slots[s].chop.phase !== 'idle'));
    let big = 'SAFE', sub = 'ALL SYSTEMS AT REST';
    const focus = live.includes(state.shown) ? state.shown : live[0];
    if (focus) {
      const t = T.slots[focus], o = b.mods[focus];
      const name = `${SLOT_SHORT[focus]} ${o.def.name}`;
      if (t.kind === 'spin') {
        const s = o.spin, rpm = (t.omega * 60) / (2 * Math.PI), tip = t.omega * o.geo.tipR * MS_TO_MPH, ke = (0.5 * o.geo.inertia * t.omega * t.omega) / 1000;
        big = s.whole && t.on ? (t.omega >= s.wFinal * 0.985 ? 'FULL SPIN' : 'SPINNING UP') : t.chop && t.chop.phase !== 'idle' ? 'CHOPPING' : t.on ? (t.omega >= s.wFinal * 0.985 ? 'AT SPEED' : 'SPINNING UP') : 'COASTING DOWN';
        sub = `${name} · ${fmt(rpm)} RPM · ${fmt(tip)} MPH · ${fmt(ke, 1)} KJ`;
      } else if (t.kind === 'swing') { big = t.phase === 'down' ? 'STRIKE' : 'RESETTING'; sub = `${name} · ${fmt(o.hammer.E / 1000, 2)} KJ PER HIT · ${fmt(o.hammer.tipSpeed * MS_TO_MPH)} MPH HEAD`; }
      else if (t.kind === 'fire') { const fp = o.flip || o.punch; big = 'FIRING'; sub = `${name} · ${t.shots} / ${fp.shots} SHOTS LEFT · ${fmt(fp.force / 1000, 1)} KN`; }
      else if (t.kind === 'toggle') { big = t.phase === 'move' ? (t.target ? 'ACTUATING' : 'RETURNING') : 'HOLDING'; sub = `${name} · ${o.hero.v} ${o.hero.u} ${o.hero.l}`; }
      else if (t.kind === 'burn') { big = 'FLAME ON'; sub = `${name} · ${fmt(o.flame.kw * t.level)} KW · ${Math.ceil(t.fuel)} S OF FUEL`; }
      else if (t.kind === 'arc') { big = 'DISCHARGE'; sub = `${name} · ${fmt(o.arc.E)} J · ${fmt(o.arc.kv * 1000)} V`; }
      else if (t.kind === 'shoot') { big = 'FIRING'; sub = `${name} · ${fmt(o.launch.v)} M/S · ${t.shots} LEFT`; }
      if (live.length > 1) big = 'WEAPONS HOT';
      sub += ` · ${elecTxt}`;
      const dot = $('w-chart-dot');
      const ts = T.slots[state.shown];
      if (dot && ts && ts.kind === 'spin') {
        const s = b.mods[state.shown].spin;
        if (ts.on && ts.t < s.tEnd) { dot.style.display = ''; dot.setAttribute('cx', ((ts.t / s.tEnd) * 150).toFixed(1)); dot.setAttribute('cy', (56 - (ts.omega / (s.wFinal || 1)) * 52).toFixed(1)); }
        else dot.style.display = 'none';
      }
    }
    if (T.driveOn) { if (!focus) { big = b.isDog ? 'WALKING' : 'DRIVING'; sub = ''; } sub += `${sub ? ' · ' : ''}${b.isDog ? 'GAIT' : 'WHEELS'} ${fmt(b.drive.topSpeed * MS_TO_MPH, 1)} MPH FREE`; }
    if (state.view.invert) big = b.invertible ? 'INVERTED · DRIVES' : b.selfRights ? 'INVERTED · SELF-RIGHTS' : 'INVERTED · STRANDED';
    $('mode-eyebrow').textContent = state.view.overlay === 'thermal' ? 'TEST STAND · THERMAL = PEAK LOAD VS RATING' : state.view.overlay === 'electrical' ? 'TEST STAND · CURRENT FLOW' : 'TEST STAND';
    $('mode-big').textContent = big;
    $('mode-sub').textContent = sc(sub);
    syncTestButtons();
  }

  // ---------------------------------------------------------------------------
  // CALLOUTS
  // ---------------------------------------------------------------------------
  const calloutLayer = $('callouts-layer');
  const calloutSvg = $('callout-svg');

  function buildCallouts() {
    const b = state.build, c = state.cfg, e = b.electrical, A = state.model.anchors;
    const list = [];
    const add = (id, title, sub) => { if (A[id] && list.length < 10) list.push({ id, title, sub: sc(sub) }); };
    for (const s of b.active) {
      const o = b.mods[s];
      const key = ['rotor', 'arm', 'beak', 'claws', 'turret', 'tool', 'head', 'ram', 'brain'].map((k) => `${s}:${k}`).find((k) => A[k]);
      if (key) add(key, o.def.name, `${SLOT_NAMES[s]} · ${o.hero.v} ${o.hero.u}`);
    }
    const s0 = b.mods[state.slot] ? state.slot : b.active[0];
    if (s0) {
      const o = b.mods[s0];
      add(`${s0}:motor0`, o.kind === 'crusher' ? 'PUMP MOTOR' : 'WEAPON MOTOR', `${P.WEAPON_MOTORS[o.md.motor].name} · ${P.WEAPON_MOTORS[o.md.motor].kv} KV`);
      add(`${s0}:esc0`, 'WEAPON ESC', P.ESCS[o.md.esc].name);
      for (const [k, t] of [['cyl', 'RAM'], ['fuel', 'PROPANE BOTTLE'], ['caps', 'CAPACITOR BANK'], ['feed', 'FEED / SUPPLY']]) if (A[`${s0}:${k}`]) { const p = b.parts.find((q) => q.id === `${s0}:${k}`); add(`${s0}:${k}`, p ? p.name : t, p ? p.spec : ''); }
    }
    add('pack_0', 'BATTERY PACK', `${e.S}S${e.P}P · ${e.vNom.toFixed(1)} V · ${fmt(e.whTotal)} WH`);
    add('switch_0', 'MASTER SWITCH', `REMOVABLE LINK · ${e.fuseA} A FUSE`);
    add('bus_0', 'BUSBARS', `${e.gaugeAwg} AWG HARNESS`);
    add(A.dmotor_1 ? 'dmotor_1' : 'dmotor_0', b.isDog ? 'LEG MOTOR' : 'DRIVE MOTOR', `${P.DRIVE_MOTORS[c.driveMotor].name} · ${c.driveRatio.toFixed(1)}:1`);
    if (b.isDog) add('legs', 'LEG ASSEMBLY', b.chassis.legs > 4 ? '2-DOF · TRIPOD GAIT' : '2-DOF · TROT GAIT');
    if (b.chassis.tracks) add('tracks', 'RUBBER TRACK', 'KEVLAR-CORD BELT');
    for (const k of Object.keys(P.EXTRAS)) if (c.extras[k]) add('x_' + k, P.EXTRAS[k].name, P.EXTRAS[k].spec);
    add('desc_1', 'DRIVE ESC', P.ESCS[c.driveEsc].name);
    add('rx', 'RECEIVER', 'FAILSAFE · 5 V BEC');
    calloutLayer.innerHTML = list.map((l, i) => `<div class="callout-item" id="co-${i}"><div class="callout-title"><i></i>${l.title}</div><div class="callout-sub">${l.sub}</div></div>`).join('');
    state.callouts = list.map((l, i) => ({ ...l, el: $('co-' + i), anchor: A[l.id] }));
    calloutSvg.innerHTML = '';
  }

  const _wp = new THREE.Vector3();
  const isShown = (obj) => { for (let o = obj; o; o = o.parent) if (!o.visible) return false; return true; };
  function renderCallouts() {
    if (!state.view.labels) {
      if (calloutSvg.innerHTML) calloutSvg.innerHTML = '';
      for (const c of state.callouts) c.el.style.opacity = '0';
      return;
    }
    const pts = [];
    for (const c of state.callouts) {
      if (!isShown(c.anchor)) { c.el.style.opacity = '0'; continue; }
      c.anchor.getWorldPosition(_wp);
      const p = E.projectToStage(_wp);
      pts.push({ c, x: p.x, y: p.y });
    }
    const sides = { left: pts.filter((p) => p.x < 800), right: pts.filter((p) => p.x >= 800) };
    let svg = '';
    for (const side of ['left', 'right']) {
      const arr = sides[side].sort((p, q) => p.y - q.y);
      const yMin = 268, yMax = 632, gap = 46;
      let prev = -1e9;
      arr.forEach((p) => { p.ly = Math.max(clamp(p.y, yMin, yMax), prev + gap); prev = p.ly; });
      let over = arr.length ? arr[arr.length - 1].ly - yMax : 0;
      for (let i = arr.length - 1; i >= 0 && over > 0; i--) { arr[i].ly -= over; if (i > 0) over = Math.max(0, arr[i - 1].ly + gap - arr[i].ly); }
      for (const p of arr) {
        const lx = side === 'left' ? 436 : 1164;
        const elbow = side === 'left' ? lx + 120 : lx - 120;
        svg += `<path d="M${p.x.toFixed(1)} ${p.y.toFixed(1)} L${elbow} ${p.ly.toFixed(1)} L${side === 'left' ? lx + 4 : lx - 4} ${p.ly.toFixed(1)}" fill="none" stroke="#ff5a1f" stroke-width="1.3" opacity="0.95"/>`;
        svg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.4" fill="#ff5a1f"/>`;
        const el = p.c.el;
        el.style.opacity = '1';
        el.style.top = `${(p.ly - 34).toFixed(1)}px`;
        if (side === 'left') { el.style.left = `${lx}px`; el.style.right = ''; el.style.textAlign = 'left'; }
        else { el.style.left = ''; el.style.right = `${1600 - lx}px`; el.style.textAlign = 'right'; }
        el.firstElementChild.style.justifyContent = side === 'left' ? 'flex-start' : 'flex-end';
      }
    }
    calloutSvg.innerHTML = svg;
  }

  // ---------------------------------------------------------------------------
  // ORBIT + CLICK-TO-INSPECT
  // ---------------------------------------------------------------------------
  let drag = null;
  E.canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY };
    E.canvas.classList.add('dragging');
    E.canvas.setPointerCapture(e.pointerId);
  });
  E.canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    state.orbit.az -= (e.clientX - drag.x) * 0.0065;
    state.orbit.el = clamp(state.orbit.el + (e.clientY - drag.y) * 0.005, 0.03, 1.4);
    drag.x = e.clientX; drag.y = e.clientY;
  });
  E.canvas.addEventListener('pointerup', (e) => {
    E.canvas.classList.remove('dragging');
    if (drag && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) inspectAt(e.clientX, e.clientY);
    drag = null;
  });
  E.canvas.addEventListener('pointercancel', () => { drag = null; E.canvas.classList.remove('dragging'); });
  E.canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.orbit.zoom = clamp(state.orbit.zoom * Math.exp(e.deltaY * 0.0011), 0.45, 1.9);
  }, { passive: false });

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  const card = $('inspect-card');
  function inspectAt(cx, cy) {
    const rect = E.canvas.getBoundingClientRect();
    mouse.x = ((cx - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((cy - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, E.camera);
    const M = state.model.M;
    const hits = raycaster.intersectObject(state.model.root, true).filter((h) => {
      const ud = h.object.userData;
      if (!ud || !ud.part || ud.role === 'fx' || ud.role === 'decal' || !isShown(h.object)) return false;
      const mat = h.object.material;
      return !(mat === M.ghost || mat === M.dim);
    });
    if (!hits.length) { card.style.display = 'none'; return; }
    const id = hits[0].object.userData.part;
    const part = state.build.parts.find((p) => p.id === id);
    if (!part) { card.style.display = 'none'; return; }
    const load = Mdl.partLoad(state.build, id);
    card.innerHTML = sc(`<span class="x" id="inspect-x">✕</span><div style="color:var(--accent);font-weight:700;margin-bottom:4px">PART · ${part.cat}${part.slot ? ' · ' + SLOT_NAMES[part.slot] + ' HARDPOINT' : ''}</div>
      <h4>${part.name}</h4><div style="color:var(--ink-soft)">${part.spec}</div>
      <div class="grid"><span>MASS</span><span>${lb(part.total, 2)} LB · ${fmt(part.total, 2)} KG${part.qty > 1 ? ` (x${part.qty})` : ''}</span>
      <span>SHARE</span><span>${((part.total / state.build.mass) * 100).toFixed(1)}% OF BOT</span>
      <span>POSITION</span><span>${inch(part.pos.x)} × ${inch(part.pos.y)} × ${inch(part.pos.z)} IN</span>
      <span>EST. COST</span><span>${usd(part.usd)}</span>
      ${load !== null ? `<span>PEAK LOAD</span><span style="color:${load > 1 ? '#ff7a5c' : '#58d68d'};font-weight:700">${fmt(load * 100)}% OF RATING</span>` : ''}</div>`);
    card.style.display = 'block';
    $('inspect-x').addEventListener('click', () => { card.style.display = 'none'; });
    if (part.slot && part.slot !== state.slot) { state.slot = part.slot; placeMarker(); renderHud(); if (state.tab === 'hard' && state.mode === 'studio') renderTabBody(); }
  }

  // ---------------------------------------------------------------------------
  // GARAGE, PARTS LIST, TALE OF THE TAPE, SNAPSHOT
  // ---------------------------------------------------------------------------
  const readGarage = () => { try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch (e) { return {}; } };
  const cfgLine = (cfg) => { const mods = SLOTS.filter((s) => cfg.slots && cfg.slots[s]).map((s) => P.MODULES[cfg.slots[s].type].name); return `${P.CHASSIS[cfg.chassis].name} / ${mods.join(' + ') || 'NO MODULES'}`; };
  const garagePop = $('garage-pop');
  function renderGarage() {
    const saved = readGarage();
    let h = sec('PRESET STARTING POINTS', `${Object.keys(P.PRESETS).length}`);
    for (const [k, cfg] of Object.entries(P.PRESETS)) h += opt('data-preset', k, cfg.name, cfgLine(cfg), false);
    h += sec('SAVED BUILDS', `${Object.keys(saved).length}`);
    if (!Object.keys(saved).length) h += `<div class="note">Nothing saved yet. SAVE stores the current build in this browser.</div>`;
    for (const [name, cfg] of Object.entries(saved)) h += opt('data-saved', name, name, cfgLine(P.normalize(cfg)), false, '<span data-del="1">DELETE</span>');
    garagePop.innerHTML = h;
  }
  function toggleGarage(show) {
    const open = show === undefined ? garagePop.style.display !== 'block' : show;
    if (open) renderGarage();
    garagePop.style.display = open ? 'block' : 'none';
    $('b-garage').classList.toggle('active', open);
  }
  $('b-garage').addEventListener('click', () => toggleGarage());
  $('brand-box').addEventListener('click', () => toggleGarage());
  garagePop.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.preset) { loadCfg(P.PRESETS[t.dataset.preset]); toggleGarage(false); if (state.mode === 'factory') goStation(STATIONS.length - 1, false); return; }
    const saved = readGarage();
    const name = t.dataset.saved;
    if (e.target.dataset.del) { delete saved[name]; localStorage.setItem(STORE_KEY, JSON.stringify(saved)); renderGarage(); return; }
    if (saved[name]) { loadCfg(saved[name]); toggleGarage(false); if (state.mode === 'factory') goStation(STATIONS.length - 1, false); }
  });
  function saveBuild() {
    const saved = readGarage();
    saved[state.cfg.name] = state.cfg;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(saved)); } catch (e) { return false; }
    return true;
  }
  $('b-save').addEventListener('click', () => {
    if (!saveBuild()) return;
    const btn = $('b-save');
    btn.textContent = 'SAVED';
    btn.classList.add('active');
    setTimeout(() => { btn.textContent = 'SAVE'; btn.classList.remove('active'); }, 1100);
  });
  $('hdr-title-wrap').addEventListener('click', () => {
    const name = window.prompt('Build name (digits become the unit number on the armour)', state.cfg.name);
    if (!name) return;
    state.cfg = { ...state.cfg, name: name.trim().toUpperCase().slice(0, 16) || state.cfg.name };
    rebuild({ noDrop: true });
    renderHud();
  });

  function download(name, href) {
    const a = document.createElement('a');
    a.download = name;
    a.href = href;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  const fileStem = () => state.cfg.name.replace(/[^A-Z0-9]+/gi, '_');

  const backdrop = $('modal-backdrop');
  function openModal(title, bodyHtml, actions) {
    $('modal-title').textContent = title;
    $('modal-body').innerHTML = bodyHtml;
    const act = $('modal-actions');
    act.innerHTML = '';
    for (const [label, fn] of actions.concat([['CLOSE', closeModal]])) {
      const btn = document.createElement('button');
      btn.className = 'sim-btn';
      btn.textContent = label;
      btn.addEventListener('click', fn);
      act.appendChild(btn);
    }
    backdrop.style.display = 'block';
  }
  function closeModal() { backdrop.style.display = 'none'; }
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });

  function openBom() {
    const b = state.build;
    let rows = '';
    for (const cat of CAT_ORDER) {
      const parts = b.parts.filter((p) => p.cat === cat);
      if (!parts.length) continue;
      rows += `<tr class="cat"><td colspan="4">${cat}</td><td class="n">${lbS(b.byCat[cat])}</td><td class="n">${kgS(b.byCat[cat])}</td><td class="n">${((b.byCat[cat] / b.mass) * 100).toFixed(1)}%</td><td class="n">${usd(parts.reduce((a, p) => a + p.usd, 0))}</td></tr>`;
      for (const p of parts) rows += `<tr><td></td><td>${p.slot ? SLOT_SHORT[p.slot] + ' · ' : ''}${sc(p.name)}</td><td>${sc(p.spec)}</td><td class="n">${p.qty}</td><td class="n">${lbS(p.total)}</td><td class="n">${kgS(p.total)}</td><td class="n">${((p.total / b.mass) * 100).toFixed(1)}%</td><td class="n">${usd(p.usd)}</td></tr>`;
    }
    rows += `<tr class="total"><td colspan="4">TOTAL PER BOT · ${b.u.className} LIMIT ${limS(b.u.limitLb)} LB</td><td class="n">${lbS(b.mass)}</td><td class="n">${kgS(b.mass)}</td><td class="n">100%</td><td class="n">${usd(b.cost / b.u.count)}</td></tr>`;
    if (b.u.count > 1) rows += `<tr class="total"><td colspan="4">CLUSTER OF ${b.u.count}</td><td class="n">${lbS(b.mass * b.u.count)}</td><td class="n">${kgS(b.mass * b.u.count)}</td><td class="n"></td><td class="n">${usd(b.cost)}</td></tr>`;
    openModal(`PARTS LIST · ${state.cfg.name}`,
      `<table class="bom-table"><thead><tr><th style="width:18px"></th><th>PART</th><th>SPECIFICATION</th><th class="n">QTY</th><th class="n">LB</th><th class="n">KG</th><th class="n">SHARE</th><th class="n">EST. USD</th></tr></thead><tbody>${rows}</tbody></table><div class="note" style="margin-top:12px">Prices are rough estimates for budgeting, not quotes.</div>`,
      [['DOWNLOAD CSV', () => download(`${fileStem()}_parts.csv`, 'data:text/csv;charset=utf-8,' + encodeURIComponent(P.bomCsv(b)))]]);
  }
  $('b-bom').addEventListener('click', openBom);

  function composeShot() {
    const c = document.createElement('canvas');
    c.width = 1600; c.height = 900;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(800, 420, 60, 800, 420, 900);
    grad.addColorStop(0, '#1b1f27'); grad.addColorStop(0.6, '#0e1014'); grad.addColorStop(1, '#07080a');
    g.fillStyle = grad;
    g.fillRect(0, 0, 1600, 900);
    E.render();
    g.drawImage(E.canvas, 0, 0, 1600, 900);
    return c;
  }
  function cropStage(src) {
    const c = document.createElement('canvas');
    c.width = 752; c.height = 600;
    c.getContext('2d').drawImage(src, 424, 130, 752, 600, 0, 0, 752, 600);
    return c;
  }

  function tapeStats() {
    const b = state.build;
    const stats = [[b.u.className, `${fmt(b.massLb, 1)} LB`]];
    for (const s of b.active.slice(0, 3)) { const o = b.mods[s]; stats.push([`${SLOT_SHORT[s]} · ${o.hero.l}`, `${o.hero.v} ${o.hero.u}`]); }
    stats.push(['TOP SPEED', `${fmt(b.drive.topSpeed * MS_TO_MPH, 1)} MPH`], ['PUSH', `${fmt(b.drive.push * N_TO_LBF)} LBF`],
      ['PACK', `${b.electrical.S}S${b.electrical.P}P · ${fmt(b.electrical.whTotal)} WH`], ['ARMOR', `${P.faceOf(state.cfg, 'front').t.toFixed(1)} MM ${MAT_SHORT[P.faceOf(state.cfg, 'front').mat]} FRONT`]);
    return stats.slice(0, 8).map(([k, v]) => [k, sc(v)]);
  }

  function openTape() {
    const b = state.build;
    const shot = cropStage(composeShot());
    const stats = tapeStats();
    const html = `<div class="tape"><div class="tape-img"><img src="${shot.toDataURL('image/png')}" alt="bot render"/></div><div>
      <div class="tape-sub" style="color:var(--accent)">TALE OF THE TAPE</div>
      <div class="tape-name">${state.cfg.name}</div>
      <div class="tape-sub">${b.chassis.name} / ${moduleNames(b)}</div>
      <div class="tape-stats">${stats.map(([k, v]) => `<div class="tape-stat"><b>${v}</b><span>${k}</span></div>`).join('')}</div>
      <div class="note" style="margin-top:16px">${b.fails ? `${b.fails} engineering check(s) failing — not competition-legal as configured.` : b.warns ? `${b.warns} engineering warning(s) open.` : 'All engineering checks pass.'} Figures come from this app's simplified model and representative component specs.</div>
    </div></div>`;
    openModal(`TALE OF THE TAPE · ${state.cfg.name}`, html, [['DOWNLOAD PNG', () => {
      const c = document.createElement('canvas');
      c.width = 1600; c.height = 900;
      const g = c.getContext('2d');
      g.fillStyle = '#07080a'; g.fillRect(0, 0, 1600, 900);
      g.drawImage(shot, 40, 40);
      g.fillStyle = '#ff5a1f'; g.fillRect(40, 660, 752, 6);
      g.fillStyle = '#ecebe6'; g.font = '800 92px Inter, sans-serif'; g.textBaseline = 'top';
      g.fillText(state.cfg.name, 40, 690);
      g.fillStyle = '#9aa0ab'; g.font = '600 20px "JetBrains Mono", monospace';
      g.fillText(`${b.chassis.name} / ${moduleNames(b)}`.toUpperCase().slice(0, 62), 44, 804);
      stats.forEach(([k, v], i) => {
        const y = 52 + i * 100;
        g.fillStyle = '#ff5a1f'; g.fillRect(850, y, 6, 78);
        g.fillStyle = '#ecebe6'; g.font = '700 44px Inter, sans-serif'; g.fillText(v, 874, y - 2);
        g.fillStyle = '#9aa0ab'; g.font = '600 19px "JetBrains Mono", monospace'; g.fillText(k, 876, y + 54);
      });
      download(`${fileStem()}_tale_of_the_tape.png`, c.toDataURL('image/png'));
    }]]);
  }
  $('b-tape').addEventListener('click', openTape);
  $('b-snap').addEventListener('click', () => download(`${fileStem()}_snapshot.png`, cropStage(composeShot()).toDataURL('image/png')));

  // ---------------------------------------------------------------------------
  // TOOLS: undo / redo, share + import, compare, surprise me, spec sheet, about, arena
  // ---------------------------------------------------------------------------
  $('b-undo').addEventListener('click', () => timeTravel(-1));
  $('b-redo').addEventListener('click', () => timeTravel(1));
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || /INPUT|TEXTAREA/.test(document.activeElement.tagName) || (window.BBArena && window.BBArena.isOpen())) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); timeTravel(-1); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); timeTravel(1); }
  });

  const toolsPop = $('tools-pop');
  function toggleTools(show) {
    const open = show === undefined ? toolsPop.style.display !== 'block' : show;
    toolsPop.style.display = open ? 'block' : 'none';
    $('b-tools').classList.toggle('active', open);
  }
  $('b-tools').addEventListener('click', () => toggleTools());
  toolsPop.addEventListener('click', (e) => { if (e.target.closest('button')) toggleTools(false); });

  function openShare() {
    const link = `${window.location.origin}${window.location.pathname}?b=${encodeShare(state.cfg)}`;
    const html = `<div class="share">
      <div class="sec"><span>SHARE THIS BUILD</span></div>
      <div class="note">Anyone who opens this link gets this exact build. The whole configuration is inside the link; nothing is uploaded.</div>
      <textarea id="share-link" readonly spellcheck="false">${link}</textarea>
      <div class="sec"><span>IMPORT A BUILD</span></div>
      <div class="note">Paste a share link (or the code after <b>?b=</b>, or the contents of a build file) and press LOAD, or pick a build file.</div>
      <textarea id="share-in" spellcheck="false" placeholder="PASTE A LINK OR BUILD FILE HERE"></textarea>
      <div class="share-row"><button class="sim-btn hot" id="share-load">LOAD PASTED BUILD</button><label class="sim-btn file-btn">OPEN BUILD FILE<input type="file" id="share-file" accept=".json,application/json"></label><span id="share-msg"></span></div>
    </div>`;
    openModal(`SHARE / IMPORT · ${state.cfg.name}`, html, [
      ['COPY LINK', () => { const ta = $('share-link'); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (err) { ok = false; } if (navigator.clipboard) navigator.clipboard.writeText(ta.value).then(() => { $('share-msg').textContent = 'LINK COPIED'; }, () => { $('share-msg').textContent = ok ? 'LINK COPIED' : 'SELECT THE LINK AND COPY IT'; }); else $('share-msg').textContent = ok ? 'LINK COPIED' : 'SELECT THE LINK AND COPY IT'; }],
      ['DOWNLOAD BUILD FILE', () => download(`${fileStem()}.bbd.json`, 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify({ app: 'BattleBot Designer', version: VERSION, build: state.cfg }, null, 2)))],
    ]);
    const take = (text) => {
      let cfg = null;
      const t = String(text || '').trim();
      if (t[0] === '{') { try { const j = JSON.parse(t); cfg = j.build || j; } catch (err) { cfg = null; } }
      else { const m = t.match(/[?&]b=([^&#\s]+)/); cfg = decodeShare(m ? m[1] : t); }
      if (!cfg || !cfg.chassis || !cfg.slots) { $('share-msg').textContent = 'THAT IS NOT A BUILD'; return; }
      loadCfg(cfg);
      closeModal();
    };
    $('share-load').addEventListener('click', () => take($('share-in').value));
    $('share-file').addEventListener('change', (e) => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => take(r.result); r.readAsText(f); });
  }

  function openCompare() {
    const saved = readGarage();
    const choices = [].concat(Object.entries(P.PRESETS).map(([k, c]) => ['p:' + k, c.name + ' (PRESET)', c]), Object.entries(saved).map(([n, c]) => ['s:' + n, n + ' (SAVED)', c]));
    const row = (label, f) => [label, f];
    const rowsDef = [
      row('CLASS', (b) => b.u.className + (b.u.count > 1 ? ' CLUSTER' : '')), row('CHASSIS', (b) => b.chassis.name),
      row('WEIGHT', (b) => `${fmt(b.massLb, 1)} LB`), row('EST. COST', (b) => usd(b.cost)),
      row('TOP SPEED', (b) => `${fmt(b.drive.topSpeed * MS_TO_MPH, 1)} MPH`), row('PUSH', (b) => `${fmt(b.drive.push * N_TO_LBF)} LBF`),
      row('STORED KINETIC ENERGY', (b) => `${fmt(b.dyn.keTotal / 1000, 1)} KJ`), row('PACK', (b) => `${b.electrical.S}S${b.electrical.P}P · ${fmt(b.electrical.whTotal)} WH`),
      row('PEAK BUS CURRENT', (b) => `${fmt(b.electrical.weaponBus.iPeak)} A`),
      row('FRONT ARMOUR', (b) => `${P.faceOf(b.cfg, 'front').t.toFixed(1)} MM ${MAT_SHORT[P.faceOf(b.cfg, 'front').mat]}`),
      row('IF FLIPPED', (b) => (b.invertible ? 'DRIVES INVERTED' : b.selfRights ? 'SELF-RIGHTS' : 'STRANDED')),
      row('CHECKS', (b) => (b.fails ? `${b.fails} FAIL` : b.warns ? `${b.warns} WARN` : 'ALL PASS')),
    ].concat(SLOTS.map((sl) => row(SLOT_NAMES[sl], (b) => (b.mods[sl] ? `${b.mods[sl].def.name} · ${b.mods[sl].hero.v} ${b.mods[sl].hero.u}` : '—'))));
    const draw = (key) => {
      const pick = choices.find((c) => c[0] === key) || choices[0];
      const a = state.build, b2 = P.compute(pick[2]);
      const cell = (b, f) => P.scaleText(f(b), b.u.k);
      $('cmp-body').innerHTML = `<table class="bom-table cmp"><thead><tr><th></th><th>${a.cfg.name} (CURRENT)</th><th>${b2.cfg.name}</th></tr></thead><tbody>${rowsDef.map(([l, f]) => `<tr><td>${l}</td><td>${cell(a, f)}</td><td>${cell(b2, f)}</td></tr>`).join('')}</tbody></table>`;
    };
    openModal('COMPARE BUILDS', `<div class="share-row"><span class="cmp-lbl">COMPARE THE CURRENT BUILD WITH</span><select id="cmp-pick">${choices.map((c) => `<option value="${c[0]}">${c[1]}</option>`).join('')}</select></div><div id="cmp-body"></div>`, []);
    $('cmp-pick').addEventListener('change', (e) => draw(e.target.value));
    draw(choices[0][0]);
  }

  // random legal build in the current weight class: draw until the engineering checks pass
  function surpriseMe() {
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const rnd = (a, b2, step) => Math.round((a + Math.random() * (b2 - a)) / step) * step;
    const types = Object.keys(P.MODULES), liveries = Object.keys(Mdl.LIVERIES);
    let best = null;
    for (let i = 0; i < 400; i++) {
      const slots = { front: null, top: null, rear: null, left: null, right: null };
      const order = SLOTS.slice().sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * 3));
      for (const sl of order) { const t = pick(types); slots[sl] = { ...P.DEFAULT_MOD, ...(MOD_DEFAULTS[t] || {}), type: t, scale: rnd(0.7, 1.0, 0.05) }; }
      const cfg = P.normalize({
        ...P.DEFAULT_CFG, name: 'RX-' + String(10 + Math.floor(Math.random() * 89)), cls: state.cfg.cls, chassis: pick(Object.keys(P.CHASSIS)), wheel: pick(['w4', 'w6', 'w6', 'w8', 'w10']),
        driveMotor: pick(['dm_m', 'dm_m', 'dm_l']), driveRatio: rnd(8, 18, 1), battery: pick(['lipo5', 'lipo8', 'lipo12']), parallel: 1 + Math.floor(Math.random() * 3), bus: pick(['shared', 'isolated']),
        armorMat: pick(Object.keys(P.MATERIALS)), armorT: rnd(2, 6, 0.5), livery: pick(liveries), finish: pick(Object.keys(P.FINISHES)), tyre: pick(Object.keys(P.TYRES)), slots,
      });
      const b = P.compute(cfg);
      const active = b.active.some((sl) => b.mods[sl].kind !== 'passive' && b.mods[sl].kind !== 'srimech');
      const score = b.fails * 10 + b.warns + (active ? 0 : 50);
      if (!best || score < best.score) best = { cfg, score };
      if (b.fails === 0 && active && b.warns <= 4) break;
    }
    loadCfg(best.cfg);
  }

  // printable one-page specification in a new window
  function openSpecSheet() {
    const b = state.build, shot = cropStage(composeShot()).toDataURL('image/png');
    const k = b.u.k, S = (str) => P.scaleText(str, k);
    const order = { fail: 0, warn: 1, info: 2, pass: 3 };
    const stats = tapeStats().concat([['EST. COST', usd(b.cost)], ['PARTS', String(b.parts.reduce((a, p) => a + p.qty, 0))]]);
    const mods = b.active.map((sl) => { const o = b.mods[sl]; return `<h3>${SLOT_NAMES[sl]} · ${o.def.name}</h3><table>${[[o.hero.l, `${o.hero.v} ${o.hero.u}`]].concat(o.rows).map(([a, v]) => `<tr><td>${a}</td><td>${S(String(v)).replace(/<small>/g, ' · ').replace(/<\/small>/g, '')}</td></tr>`).join('')}</table>`; }).join('');
    const parts = b.parts.map((p) => `<tr><td>${p.cat}</td><td>${p.slot ? SLOT_SHORT[p.slot] + ' · ' : ''}${S(p.name)}</td><td>${S(p.spec)}</td><td class="n">${p.qty}</td><td class="n">${lbS(p.total)}</td><td class="n">${usd(p.usd)}</td></tr>`).join('');
    const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${state.cfg.name} · specification</title><style>
      body{font:13px/1.45 Arial,Helvetica,sans-serif;color:#111;margin:28px;max-width:980px}h1{font-size:34px;margin:0}h2{font-size:15px;letter-spacing:1px;border-bottom:2px solid #111;padding-bottom:3px;margin:22px 0 8px}h3{font-size:13px;margin:12px 0 4px}
      .sub{color:#555;letter-spacing:.5px;text-transform:uppercase}.top{display:flex;gap:22px;align-items:flex-start;margin-top:14px}.top img{width:470px;background:#0e1014;border-radius:4px}
      .stats{display:grid;grid-template-columns:1fr 1fr;gap:8px 18px;flex:1}.stats div{border-left:4px solid #ff5a1f;padding-left:8px}.stats b{display:block;font-size:19px}.stats span{font-size:11px;color:#555;text-transform:uppercase}
      table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ccc;padding:3px 6px;text-align:left;font-size:12px}td.n,th.n{text-align:right}.fail{color:#b3200a;font-weight:bold}.warn{color:#8a5a00}
      .cols{columns:2;column-gap:26px}.cols h3{break-after:avoid}button{font:bold 13px Arial;padding:8px 14px;margin:0 0 14px}@media print{button{display:none}body{margin:10mm}}</style></head><body>
      <button onclick="window.print()">PRINT / SAVE AS PDF</button>
      <div class="sub">BattleBot Designer v${VERSION} · specification sheet</div><h1>${state.cfg.name}</h1>
      <div class="sub">${b.u.className}${b.u.count > 1 ? ' cluster' : ''} · ${b.chassis.name} / ${moduleNames(b)}</div>
      <div class="top"><img src="${shot}" alt="render"><div class="stats">${stats.map(([a, v]) => `<div><b>${v}</b><span>${a}</span></div>`).join('')}</div></div>
      <h2>HARDPOINT MODULES</h2><div class="cols">${mods || '<p>No modules installed.</p>'}</div>
      <h2>ENGINEERING CHECKS</h2><table>${b.checks.slice().sort((x, y) => order[x.status] - order[y.status]).map((x) => `<tr><td class="${x.status}">${x.status.toUpperCase()}</td><td>${x.label}</td><td>${S(x.detail)}</td></tr>`).join('')}</table>
      <h2>PARTS LIST</h2><table><tr><th>CATEGORY</th><th>PART</th><th>SPECIFICATION</th><th class="n">QTY</th><th class="n">LB</th><th class="n">EST. USD</th></tr>${parts}<tr><th colspan="4">TOTAL PER BOT</th><th class="n">${lbS(b.mass)}</th><th class="n">${usd(b.cost / b.u.count)}</th></tr></table>
      <p class="sub" style="margin-top:18px">Figures come from a simplified model with representative component specs; prices are rough estimates.</p></body></html>`;
    const w = window.open('', '_blank');
    if (!w) { openModal('SPEC SHEET', '<div class="note">The browser blocked the new window. Allow pop-ups for this page, or use the download instead.</div>', [['DOWNLOAD HTML', () => download(`${fileStem()}_spec_sheet.html`, 'data:text/html;charset=utf-8,' + encodeURIComponent(doc))]]); return; }
    w.document.open(); w.document.write(doc); w.document.close();
  }

  function openAbout() {
    openModal(`ABOUT · BATTLEBOT DESIGNER v${VERSION}`, `<div class="about">
      <p><b>BattleBot Designer</b> is a design studio for TV-style combat robots: ${Object.keys(P.CHASSIS).length} chassis, ${Object.keys(P.MODULES).length} hardpoint modules, ${Object.keys(P.CLASSES).length} weight classes, a full electrical model, a piece-by-piece factory floor and an arena.</p>
      <div class="sec"><span>WHAT THE NUMBERS ARE</span></div>
      <p>The catalogue holds representative component classes, not datasheet values for real products. Kinetic weapons, drive, battery and wiring use first-principles formulas; thermal, electrical and projectile weapons use simplified, game-level models. Smaller weight classes are shown as scale models of the heavyweight calculation. Prices are rough estimates. Do not build a real machine from these figures.</p>
      <div class="sec"><span>KEYS</span></div>
      <p>Drag to orbit · wheel to zoom · click a part to inspect it · Ctrl+Z / Ctrl+Y to undo and redo.</p>
      <div class="sec"><span>RENDERER</span></div>
      <p>${E.isSoftware ? 'WebGL is not available here, so the built-in CPU renderer is drawing the scene.' : 'WebGL renderer.'} three.js is used for geometry and maths (MIT licence). See THIRD_PARTY_NOTICES.md in the repository.</p></div>`, []);
  }
  $('b-share').addEventListener('click', openShare);
  $('b-compare').addEventListener('click', openCompare);
  $('b-random').addEventListener('click', surpriseMe);
  $('b-spec').addEventListener('click', openSpecSheet);
  $('b-about').addEventListener('click', openAbout);

  // ---------------------------------------------------------------------------
  // MAIN LOOP
  // ---------------------------------------------------------------------------
  rebuild({ noDrop: true });
  renderAll();
  E.fitViewport();
  if (query.get('mode') === 'factory') {
    setMode('factory');
    goStation(parseInt(query.get('station') || '0', 10) || 0, false);
    if (query.get('drop')) { startDrop(); if (state.drop) state.drop.t = parseFloat(query.get('drop')); }
  }

  // automation: ?act=front,top holds those modules in their active state; ?t= seconds into a spin-up
  for (const s of (query.get('act') || '').split(',').filter(Boolean)) {
    const t = state.test.slots[s], o = state.build.mods[s];
    if (!t) continue;
    if (t.kind === 'spin') { t.on = true; t.t = parseFloat(query.get('t') || '99'); t.omega = o.spin.wFinal; if (t.chop && query.get('chop') === '1') { t.chop.phase = 'hold'; t.chop.u = 1; t.chop.timer = -1e6; } }
    else if (t.kind === 'swing' || t.kind === 'fire') { t.phase = 'hold'; t.u = 1; t.timer = -1e6; }
    else if (t.kind === 'toggle') { t.target = 1; t.u = 1; }
    else if (t.kind === 'burn') { t.on = true; t.level = 1; t.fuel = 1e6; }
    else if (t.kind === 'arc') { t.phase = 'zap'; t.timer = -1e6; t.level = 1; }
    else if (t.kind === 'shoot') { t.fxU = 0.3; SHOT_TIME[o.type] = 1e6; }
  }
  if (query.get('drive') === '1') state.test.driveOn = true;
  if (query.get('invert') === '1') state.invertF = 1;
  syncTestButtons();
  if (query.get('modal') === 'bom') openBom();
  if (query.get('modal') === 'share') openShare();
  if (query.get('modal') === 'compare') openCompare();
  if (query.get('modal') === 'about') openAbout();
  if (query.get('tools') === '1') toggleTools(true);
  // automation: ?arena=1 opens the pre-match screen, ?arena=go also starts the match
  if (query.get('arena') && window.BBArena) {
    window.BBArena.open({ build: state.build, presets: P.PRESETS, onClose: () => {} });
    if (query.get('arena') === 'go') setTimeout(() => { const go = document.querySelector('.bba-start'); if (go) go.click(); }, 300);
  }
  if (query.get('garage') === '1') toggleGarage(true);

  let last = performance.now() * 0.001;
  let lastLive = 0;
  let frames = 0, fpsT = last, fps = 0;
  let camReady = false; // first frame snaps to the framed view instead of easing in
  function tick(nowMs) {
    requestAnimationFrame(tick);
    if (window.BBArena && window.BBArena.isOpen()) {
      last = nowMs * 0.001;
      return;
    }
    const now = nowMs * 0.001;
    const dt = Math.min(0.05, Math.max(0.001, now - last));
    last = now;
    state.time += dt;
    if (state.view.turntable && !drag) state.orbit.turn += dt * 0.4;

    stepTest(dt);
    poseModel(dt);

    const S = state.model.scale;
    const baseDist = clamp(state.frame.r / 0.18, 4.8, 16) * (1 + 1.0 * state.teardown);
    E.cam.tAz = state.orbit.az + state.orbit.turn;
    E.cam.tEl = state.orbit.el;
    E.cam.tDist = baseDist * state.orbit.zoom;
    E.cam.tTarget.set(0, S * (0.08 + 0.3 * state.teardown) + 0.012 * E.cam.tDist, 0);
    if (!camReady) { camReady = true; E.cam.az = E.cam.tAz; E.cam.el = E.cam.tEl; E.cam.dist = E.cam.tDist; E.cam.target.copy(E.cam.tTarget); }
    E.updateCamera(dt);
    E.render();
    renderCallouts();

    frames++;
    if (now - fpsT > 1) { fps = frames / (now - fpsT); frames = 0; fpsT = now; }
    if (now - lastLive > 0.1) { lastLive = now; renderLive(); }
  }
  requestAnimationFrame(tick);
  if (query.get('modal') === 'tape') setTimeout(openTape, 600);

  // Debug / automation hooks
  window.__BBD = {
    state, STATIONS,
    getFps: () => fps,
    getBuild: () => state.build,
    setCfg: (k, v) => setCfg(k, v, false),
    install: (slot, type) => installModule(slot, type), blockedBy,
    load: (cfg) => loadCfg(cfg), patch: (p) => patchCfg(p), undo: () => timeTravel(-1), redo: () => timeTravel(1), hist, surpriseMe, encodeShare, decodeShare, sc,
    setMode, goStation, trigger,
    triCount: () => { let n = 0; state.model.root.traverse((o) => { if (o.isMesh && o.geometry) n += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; }); return Math.round(n); },
  };
})();
