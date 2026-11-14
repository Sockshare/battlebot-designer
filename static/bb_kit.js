/**
 * BattleBot Designer — model kit: liveries, materials and the geometry helpers shared by the
 * chassis / drivetrain builders (bb_models.js) and the hardpoint module builders (bb_modules.js).
 *
 * Everything is authored in metres in the bot frame (+Z forward, +X right, Y up, floor at y = 0).
 */
(function () {
  'use strict';
  const E = window.BBEngine;
  const THREE = E.THREE;

  const LIVERIES = {
    signal: { name: 'SIGNAL ORANGE', armor: '#e2481f', top: '#d9d6cd', accent: '#141416' },
    hazard: { name: 'HAZARD YELLOW', armor: '#e8ad12', top: '#1b1d21', accent: '#1b1d21' },
    cobalt: { name: 'COBALT', armor: '#1a50c0', top: '#d6dae2', accent: '#f59e0b' },
    viper: { name: 'VIPER RED', armor: '#a81414', top: '#141518', accent: '#e8ebf0' },
    olive: { name: 'OLIVE DRAB', armor: '#56633a', top: '#2a2e22', accent: '#e07a00' },
    mono: { name: 'BARE METAL', armor: '#9aa0a8', top: '#868c94', accent: '#e2481f', bare: true },
    graphite: { name: 'GRAPHITE', armor: '#2a2f3a', top: '#1a1d24', accent: '#00b4d8' },
    arctic: { name: 'ARCTIC WHITE', armor: '#e4e2da', top: '#cfd4d9', accent: '#0077b6' },
    rust: { name: 'RUST BUCKET', armor: '#7a3b1e', top: '#3a2a22', accent: '#f2b61b' },
    gunship: { name: 'GUNSHIP GREY', armor: '#3d4349', top: '#2a2e33', accent: '#d62828' },
    toxic: { name: 'TOXIC GREEN', armor: '#6cc21a', top: '#15171a', accent: '#b517d6' },
    carbon: { name: 'CARBON BLACK', armor: '#17181b', top: '#101114', accent: '#e11d2e' },
    desert: { name: 'DESERT TAN', armor: '#b79a6a', top: '#8c7650', accent: '#2a2a2a' },
    royal: { name: 'ROYAL PURPLE', armor: '#5b21b6', top: '#e9e4f5', accent: '#fbbf24' },
  };

  // bare colour / roughness of each armour stock, shown on plate edges and wherever paint is worn through
  const STOCK = {
    ar500: ['#666c75', 0.28, 0.96], hardox: ['#5c626b', 0.30, 0.95], mild: ['#746e68', 0.38, 0.92], ti: ['#b2aba0', 0.22, 0.98],
    al7075: ['#cfd5dc', 0.20, 0.98], cfrp: ['#17191d', 0.22, 0.45], uhmw: ['#ebe8df', 0.48, 0.05],
  };

  const std = (color, roughness, metalness, extra) => new THREE.MeshStandardMaterial(Object.assign({ color, roughness, metalness, envMapIntensity: 1.55 }, extra || {}));
  const basic = (color, opacity, extra) => new THREE.MeshBasicMaterial(Object.assign({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1, side: THREE.DoubleSide }, extra || {}));
  const glow = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });

  const lum = (c) => { const q = new THREE.Color(c); return 0.3 * q.r + 0.59 * q.g + 0.11 * q.b; };
  // keep the accent if it reads against the surface, otherwise fall back to off-white or near-black
  const contrast = (accent, surface) => (Math.abs(lum(accent) - lum(surface)) > 0.2 ? accent : lum(surface) > 0.4 ? '#101012' : '#e6e3da');

  function makeMaterials(cfg, battery) {
    // a custom livery carries its own three colours on the build
    const lv = cfg.livery === 'custom' && cfg.paint ? { name: 'CUSTOM', armor: cfg.paint.armor, top: cfg.paint.top, accent: cfg.paint.accent } : LIVERIES[cfg.livery] || LIVERIES.signal;
    const stock = STOCK[cfg.armorMat] || STOCK.ar500;
    const fin = cfg.finish;
    const pr = fin === 'factory' ? 0.19 : fin === 'worn' ? 0.32 : 0.44; // automotive metallic clearcoat roughness
    const pm = fin === 'factory' ? 0.46 : fin === 'worn' ? 0.38 : 0.32;
    const bare = std(stock[0], stock[1] + (fin === 'battle' ? 0.08 : 0), stock[2]);
    const paint = (c) => (lv.bare ? std(stock[0], stock[1], stock[2]) : std(c, pr, pm));
    const armor = paint(lv.armor);
    const top = lv.bare ? std(new THREE.Color(stock[0]).multiplyScalar(0.9), stock[1], stock[2]) : std(lv.top, pr + 0.03, pm * 0.85);
    // machined bevel edges catch bright specular highlights
    const edge = fin === 'factory' && !lv.bare ? std(new THREE.Color(stock[0]).multiplyScalar(1.08), 0.22, 0.92) : bare;
    // per-face armour: each face shows its own plate stock on bare edges (and all over on a bare-metal livery)
    const PH = window.BBPhysics, faces = {};
    for (const fc of PH.FACES) {
      if (!cfg.armorFaces) { faces[fc] = { armor: fc === 'top' ? top : armor, edge }; continue; }
      const st = STOCK[PH.faceOf(cfg, fc).mat] || stock, col = fc === 'top' ? lv.top : lv.armor;
      faces[fc] = {
        armor: lv.bare ? std(fc === 'top' ? new THREE.Color(st[0]).multiplyScalar(0.9) : st[0], st[1], st[2]) : std(col, pr + (fc === 'top' ? 0.03 : 0), fc === 'top' ? pm * 0.85 : pm),
        edge: std(new THREE.Color(st[0]).multiplyScalar(1.05), st[1], st[2]),
      };
    }
    return {
      lv, faces,
      armor, top, edge, bare,
      armorShell: lv.bare ? std(stock[0], stock[1], stock[2], { side: THREE.DoubleSide }) : std(lv.armor, pr, pm, { side: THREE.DoubleSide }),
      accent: std(lv.accent, 0.28, 0.42),
      decal: std(contrast(lv.accent, lv.bare ? stock[0] : lv.armor), 0.36, 0.22),
      decalTop: std(contrast(lv.accent, lv.bare ? stock[0] : lv.top), 0.36, 0.22),
      decalDark: std('#0c0d10', 0.42, 0.2),
      decalLight: std('#f0ede4', 0.38, 0.18),
      scratch: std(new THREE.Color(stock[0]).multiplyScalar(1.32), 0.22, 0.92),
      gouge: std('#141518', 0.55, 0.65),
      soot: std('#0a0a0c', 0.88, 0.05),
      // structure
      frame: std('#adb4be', 0.26, 0.96),
      frameDark: std('#26292f', 0.36, 0.88),
      pocket: std('#686f78', 0.40, 0.94),
      chromoly: std('#22262c', 0.30, 0.88),
      weld: std('#9c8e7b', 0.38, 0.94),
      steel: std('#ced4dc', 0.16, 1.0),
      toolSteel: std('#767e8a', 0.20, 0.98),
      weapon: std('#8d96a3', 0.22, 0.98),
      hardened: std('#3b4656', 0.18, 0.96),
      edgeSteel: std('#e4e8ee', 0.10, 1.0),
      blued: std('#384b78', 0.20, 0.96),
      bolt: std('#181a1f', 0.28, 0.92),
      boltZinc: std('#d8d2b2', 0.22, 0.98),
      brass: std('#d4a843', 0.20, 0.98),
      anoRed: std('#c81922', 0.20, 0.92),
      anoBlue: std('#1e5fe0', 0.20, 0.92),
      anoBlack: std('#14161a', 0.24, 0.90),
      anoGold: std('#dfa42c', 0.20, 0.94),
      uhmw: std('#e8e5dc', 0.52, 0.05),
      uhmwBlack: std('#181a1e', 0.50, 0.08),
      rubber: std('#121316', 0.78, 0.06),
      rubberWorn: std('#232529', 0.84, 0.05),
      hub: std('#cfd5dd', 0.20, 0.98),
      motorCan: std('#181a20', 0.24, 0.94),
      copper: std('#d47b3e', 0.22, 0.98),
      gearbox: std('#9ba2ac', 0.24, 0.96),
      chain: std('#3e434b', 0.32, 0.95),
      belt: std('#141518', 0.72, 0.05),
      pulley: std('#b8bec7', 0.20, 0.98),
      // electrical
      pack: std(battery.chem === 'LiPo' ? '#1e4ec4' : battery.chem === 'LiFePO4' ? '#229954' : '#c26b1d', 0.42, 0.18),
      packLabel: std('#f5c832', 0.42, 0.12),
      packCap: std('#121316', 0.45, 0.15),
      strap: std('#eae7df', 0.62, 0.05),
      esc: std('#181b21', 0.34, 0.55),
      escFin: std('#bd241c', 0.22, 0.94),
      pcb: std('#0f5c38', 0.40, 0.22),
      cap: std('#254788', 0.28, 0.65),
      capBig: std('#1b1e24', 0.28, 0.65),
      wireRed: std('#dc2222', 0.42, 0.08),
      wireBlk: std('#121316', 0.48, 0.08),
      phaseA: std('#f0bc42', 0.42, 0.08),
      phaseB: std('#2e70d8', 0.42, 0.08),
      phaseC: std('#e85628', 0.42, 0.08),
      signal: std('#f2f2ec', 0.48, 0.05),
      switchBody: std('#c81422', 0.32, 0.22),
      fuse: std('#e6a42e', 0.28, 0.35),
      rx: std('#1e2228', 0.38, 0.22),
      led: std('#3dff88', 0.18, 0.0, { emissive: '#2ce874', emissiveIntensity: 1.8 }),
      ledRed: std('#ff4230', 0.18, 0.0, { emissive: '#ff2e1c', emissiveIntensity: 1.9 }),
      ledBlue: std('#52b4ff', 0.18, 0.0, { emissive: '#3296ff', emissiveIntensity: 1.8 }),
      lens: std('#080a0e', 0.04, 0.82),
      // fluid power / thermal
      tank: std('#e2dfd5', 0.24, 0.48),
      tankRed: std('#c4241e', 0.26, 0.45),
      tankBlue: std('#2e529c', 0.26, 0.45),
      hose: std('#9ca3ad', 0.28, 0.94),
      hoseBlk: std('#181a1e', 0.52, 0.15),
      ceramic: std('#f0ede5', 0.25, 0.08),
      scorched: std('#4d3c31', 0.38, 0.92),
      // view-mode materials
      ghost: std(lv.bare ? stock[0] : lv.armor, 0.4, 0.1, { transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide }),
      dim: std('#7f858d', 0.6, 0.05, { transparent: true, opacity: 0.06, depthWrite: false, side: THREE.DoubleSide }),
      cool: std('#3d5f8c', 0.6, 0.05),
      primer: std('#8e9299', 0.5, 0.15),
      primerDark: std('#6f737a', 0.5, 0.15),
      // effects
      sweep: glow(lv.bare ? '#b8c4d8' : lv.armor, 0.26),
      sweepSteel: glow('#b0c4de', 0.28),
      flameCore: glow('#fff6d0', 0.95),
      flameMid: glow('#ffa224', 0.68),
      flameOuter: glow('#ff3e0a', 0.42),
      flameBlue: glow('#42a8ff', 0.78),
      flamePuff: glow('#ff6014', 0.26),
      arc: glow('#c8e4ff', 0.98),
      arcGlow: glow('#6496ff', 0.48),
      muzzle: glow('#ffda85', 0.94),
      tracer: glow('#fff0b5', 0.90),
      smoke: basic('#2a2a2c', 0.32),
      pulse: basic('#ffffff', 1),
      cg: basic('#ff5a2a', 1),
      cgDark: basic('#f4f2ec', 1),
    };
  }

  // ---- seeded random -------------------------------------------------------------
  function rng(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    let a = h >>> 0;
    return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  // ---- geometry helpers ------------------------------------------------------------
  const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const _zAxis = new THREE.Vector3(0, 0, 1);
  const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _one = new THREE.Vector3(1, 1, 1);

  function cylA(r, len, seg, axis, rTop, open) {
    const g = new THREE.CylinderGeometry(rTop === undefined || rTop === null ? r : rTop, r, len, seg, 1, !!open);
    if (axis === 'x') g.rotateZ(-Math.PI / 2);
    else if (axis === 'z') g.rotateX(Math.PI / 2);
    return g;
  }
  const along = (axis, v) => (axis === 'x' ? [v, 0, 0] : axis === 'y' ? [0, v, 0] : [0, 0, v]);
  const rotY = (dx, dz, a) => [dx * Math.cos(a) + dz * Math.sin(a), -dx * Math.sin(a) + dz * Math.cos(a)];

  // move a geometry: rotate (XYZ euler) then translate. Returns the same geometry.
  function at(geo, x, y, z, rx, ry, rz, order) {
    _e.set(rx || 0, ry || 0, rz || 0, order || 'XYZ');
    _m4.compose(new THREE.Vector3(x || 0, y || 0, z || 0), _q.setFromEuler(_e), _one);
    geo.applyMatrix4(_m4);
    return geo;
  }
  // geometry whose local +Z runs from a to b (for struts and rods)
  function aim(geo, a, b) {
    const A = V(a), B = V(b), d = B.clone().sub(A);
    _m4.compose(A.clone().add(B).multiplyScalar(0.5), _q.setFromUnitVectors(_zAxis, d.normalize()), _one);
    geo.applyMatrix4(_m4);
    return geo;
  }

  // merge geometries (position + normal, indexed or not) into one; groups are dropped
  function merge(list) {
    let nV = 0, nI = 0;
    for (const g of list) { nV += g.attributes.position.count; nI += g.index ? g.index.count : g.attributes.position.count; }
    const pos = new Float32Array(nV * 3), nor = new Float32Array(nV * 3), idx = new (nV > 65535 ? Uint32Array : Uint16Array)(nI);
    let vo = 0, io = 0;
    for (const g of list) {
      const p = g.attributes.position, n = g.attributes.normal;
      pos.set(p.array, vo * 3);
      if (n) nor.set(n.array, vo * 3);
      if (g.index) { const a = g.index.array; for (let i = 0; i < a.length; i++) idx[io + i] = a[i] + vo; io += a.length; }
      else { for (let i = 0; i < p.count; i++) idx[io + i] = vo + i; io += p.count; }
      vo += p.count;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    return out;
  }

  function put(ctx, geo, mat, parent, part, role, x, y, z) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x || 0, y || 0, z || 0);
    m.userData = { part, role, base: mat };
    m.castShadow = role !== 'fx' && role !== 'decal' && role !== 'pulse' && role !== 'wire';
    parent.add(m);
    ctx.meshes.push(m);
    return m;
  }
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

  function strut(ctx, a, b, w, h, mat, parent, part, role) {
    const A = V(a), B = V(b);
    return put(ctx, aim(box(w, h, A.distanceTo(B)), a, b), mat, parent, part, role);
  }
  function rod(ctx, a, b, r, mat, parent, part, role, seg) {
    const A = V(a), B = V(b);
    return put(ctx, aim(cylA(r, A.distanceTo(B), seg || 8, 'z'), a, b), mat, parent, part, role);
  }
  // Re-aim a unit-length (z) mesh between two points every frame.
  function stretch(mesh, A, B) {
    const d = B.clone().sub(A);
    const len = d.length();
    mesh.position.copy(A).addScaledVector(d, 0.5);
    mesh.quaternion.setFromUnitVectors(_zAxis, d.normalize());
    mesh.scale.z = Math.max(1e-4, len);
  }

  // ---- plates: extruded outlines with a chamfer; material group 0 = faces, 1 = edges ----
  function shapeOf(pts, holes) {
    const s = new THREE.Shape(pts.map((p) => new THREE.Vector2(p[0], p[1])));
    for (const h of holes || []) {
      if (h.r) { const path = new THREE.Path(); path.absarc(h.x, h.y, h.r, 0, Math.PI * 2, true); s.holes.push(path); }
      else s.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p[0], p[1]))));
    }
    return s;
  }
  function extrude(pts, t, bevel, holes, curve) {
    const b = Math.min(bevel === undefined ? 0.0025 : bevel, t * 0.45);
    const g = new THREE.ExtrudeGeometry(shapeOf(pts, holes), { depth: t - 2 * b, bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments: 1, curveSegments: curve || 5 });
    g.translate(0, 0, -(t - 2 * b) / 2);
    return g;
  }
  // horizontal plate: outline given as [x, z]; occupies y in [-t/2, t/2]
  function plateXZ(pts, t, bevel, holes) {
    const flip = (p) => (p.r ? { x: p.x, y: -p.y, r: p.r } : [p[0], -p[1]]);
    const g = extrude(pts.map(flip), t, bevel, (holes || []).map((h) => (h.r ? flip(h) : h.map(flip))));
    g.rotateX(-Math.PI / 2);
    return g;
  }
  // vertical plate lying in the z-y plane: outline given as [z, y]; thickness along x, centred
  function plateZY(pts, t, bevel, holes) {
    const g = extrude(pts, t, bevel, holes);
    g.rotateY(-Math.PI / 2);
    return g;
  }
  // vertical plate facing z: outline given as [x, y]; thickness along z, centred
  const plateXY = (pts, t, bevel, holes) => extrude(pts, t, bevel, holes);
  const rectPts = (w, h) => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];

  // ---- fasteners: one merged mesh per call ---------------------------------------------
  // pts: [x, y, z]; axis: direction the head faces ('x','-x','y','-y','z','-z')
  function bolts(ctx, parent, part, pts, axis, r, mat, role) {
    if (!pts.length) return null;
    const rr = r || 0.0055, h = rr * 0.9;
    const geos = pts.map((p) => {
      const g = new THREE.CylinderGeometry(rr, rr, h, 6);
      const ax = axis.replace('-', ''), sgn = axis[0] === '-' ? -1 : 1;
      if (ax === 'x') g.rotateZ(-Math.PI / 2); else if (ax === 'z') g.rotateX(Math.PI / 2);
      const off = along(ax, sgn * h * 0.5);
      g.translate(p[0] + off[0], p[1] + off[1], p[2] + off[2]);
      return g;
    });
    const bm = put(ctx, merge(geos), mat || ctx.M.bolt, parent, part, role || 'struct');
    bm.castShadow = false;
    bm.userData.fastener = true; // lifts clear of its plate in the teardown
    return bm;
  }
  const linspace = (a, b, n) => Array.from({ length: n }, (_, i) => (n === 1 ? (a + b) / 2 : a + ((b - a) * i) / (n - 1)));

  // ---- shared components ------------------------------------------------------------------
  // brushless outrunner: stator + windings visible through the bell, mounting face, shaft
  function motor(ctx, parent, part, spec, axis, pos, role) {
    const M = ctx.M;
    const g = new THREE.Group();
    g.position.set(pos.x, pos.y, pos.z);
    parent.add(g);
    const r = spec.d / 2, l = spec.l, R = role || 'elec';
    const brushed = /BRUSHED/.test(spec.name);
    const can = new THREE.Group();
    g.add(can);
    if (brushed) {
      put(ctx, cylA(r, l * 0.86, 18, axis), M.motorCan, g, part, R);
      put(ctx, cylA(r * 1.02, l * 0.1, 18, axis), M.anoGold, g, part, R, ...along(axis, -l * 0.4));
      put(ctx, cylA(r * 0.3, l * 0.16, 10, axis), M.steel, can, part, R, ...along(axis, l * 0.5));
    } else {
      // fixed stator with copper windings
      put(ctx, cylA(r * 0.8, l * 0.6, 12, axis), M.copper, g, part, R);
      put(ctx, cylA(r * 0.95, l * 0.07, 16, axis), M.frameDark, g, part, R, ...along(axis, -l * 0.46));
      // rotating bell: two rings and a front cap leave a window on the windings
      put(ctx, cylA(r, l * 0.22, 18, axis), M.motorCan, can, part, R, ...along(axis, -l * 0.28));
      put(ctx, cylA(r, l * 0.2, 18, axis), M.motorCan, can, part, R, ...along(axis, l * 0.26));
      put(ctx, cylA(r * 0.6, l * 0.08, 14, axis, r * 0.98), M.anoRed, can, part, R, ...along(axis, l * 0.4));
      put(ctx, cylA(r * 0.16, l * 0.2, 8, axis), M.steel, can, part, R, ...along(axis, l * 0.52));
      const ribs = [];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2, c = Math.cos(a) * r * 0.97, s = Math.sin(a) * r * 0.97;
        const rib = axis === 'x' ? at(box(l * 0.3, r * 0.2, 0.004), 0, s, c, -a) : axis === 'y' ? at(box(r * 0.2, l * 0.3, 0.004), s, 0, c, 0, a) : at(box(r * 0.2, 0.004, l * 0.3), c, s, 0, 0, 0, a + Math.PI / 2);
        ribs.push(rib);
      }
      put(ctx, merge(ribs), M.motorCan, can, part, R);
    }
    return { g, can, axis };
  }

  function esc(ctx, parent, part, spec, pos) {
    const M = ctx.M;
    const g = new THREE.Group();
    g.position.set(pos.x, pos.y, pos.z);
    g.rotation.y = pos.rotY || 0;
    parent.add(g);
    const [len, h, w] = spec.dims;
    put(ctx, box(w, h * 0.2, len), M.pcb, g, part, 'elec', 0, -h * 0.4, 0);
    put(ctx, box(w * 0.96, h * 0.42, len * 0.8), M.esc, g, part, 'elec', 0, -h * 0.09, len * 0.06);
    const fins = [];
    for (let i = 0; i < 7; i++) fins.push(at(box(w * 0.9, h * 0.38, len * 0.035), 0, h * 0.31, -len * 0.27 + i * len * 0.105));
    put(ctx, merge(fins), M.escFin, g, part, 'elec');
    const caps = [];
    for (let i = -1; i <= 1; i++) caps.push(at(cylA(w * 0.13, h * 0.9, 10, 'y'), i * w * 0.3, 0, -len * 0.5 - w * 0.13));
    put(ctx, merge(caps), M.cap, g, part, 'elec');
    put(ctx, box(w * 0.5, h * 0.02, len * 0.3), M.decalLight, g, part, 'elec', 0, h * 0.125, len * 0.3);
    return g;
  }

  function batteryPack(ctx, parent, part, pack, pos) {
    const M = ctx.M;
    const g = new THREE.Group();
    g.position.set(pos.x, pos.y, pos.z);
    g.rotation.y = pos.rotY || 0;
    parent.add(g);
    put(ctx, box(pack.w, pack.h, pack.len), M.pack, g, part, 'elec');
    put(ctx, box(pack.w + 0.0016, pack.h + 0.0016, pack.len * 0.3), M.packLabel, g, part, 'elec', 0, 0, -pack.len * 0.08);
    put(ctx, merge([at(box(pack.w * 0.94, pack.h * 0.94, 0.008), 0, 0, pack.len / 2 + 0.003), at(box(pack.w * 0.94, pack.h * 0.94, 0.006), 0, 0, -pack.len / 2 - 0.002)]), M.packCap, g, part, 'elec');
    put(ctx, merge([at(box(pack.w + 0.004, pack.h + 0.004, 0.016), 0, 0, pack.len * 0.3), at(box(pack.w + 0.004, pack.h + 0.004, 0.016), 0, 0, -pack.len * 0.34)]), M.strap, g, part, 'elec');
    put(ctx, box(0.024, 0.009, 0.014), M.fuse, g, part, 'elec', pack.w * 0.25, pack.h / 2 + 0.0045, pack.len / 2 - 0.02);
    return g;
  }

  // pneumatic / gas bottle lying along an axis: domed ends, neck, regulator
  function bottle(ctx, parent, part, r, len, axis, mat, x, y, z, role) {
    const M = ctx.M;
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    const R = role || 'weapon';
    const pts = [[0.001, -len / 2], [r * 0.7, -len / 2 + r * 0.12], [r, -len / 2 + r * 0.55], [r, len / 2 - r * 0.6], [r * 0.7, len / 2 - r * 0.15], [r * 0.3, len / 2], [r * 0.3, len / 2 + r * 0.3]].map((p) => new THREE.Vector2(p[0], p[1]));
    const lathe = new THREE.LatheGeometry(pts, 14);
    if (axis === 'x') lathe.rotateZ(-Math.PI / 2); else if (axis === 'z') lathe.rotateX(Math.PI / 2);
    const body = put(ctx, lathe, mat, g, part, R);
    body.material = mat; mat.side = THREE.DoubleSide;
    put(ctx, cylA(r * 0.42, r * 0.5, 8, axis), M.brass, g, part, R, ...along(axis, len / 2 + r * 0.5));
    put(ctx, cylA(r * 1.02, len * 0.08, 14, axis), M.decalDark, g, part, R, ...along(axis, -len * 0.12));
    return g;
  }

  // ---- 5 x 7 stencil lettering for team / sponsor text --------------------------------------
  const FONT = {
    A: '01110 10001 10001 11111 10001 10001 10001', B: '11110 10001 10001 11110 10001 10001 11110', C: '01110 10001 10000 10000 10000 10001 01110',
    D: '11110 10001 10001 10001 10001 10001 11110', E: '11111 10000 10000 11110 10000 10000 11111', F: '11111 10000 10000 11110 10000 10000 10000',
    G: '01110 10001 10000 10111 10001 10001 01111', H: '10001 10001 10001 11111 10001 10001 10001', I: '01110 00100 00100 00100 00100 00100 01110',
    J: '00111 00010 00010 00010 00010 10010 01100', K: '10001 10010 10100 11000 10100 10010 10001', L: '10000 10000 10000 10000 10000 10000 11111',
    M: '10001 11011 10101 10101 10001 10001 10001', N: '10001 11001 10101 10011 10001 10001 10001', O: '01110 10001 10001 10001 10001 10001 01110',
    P: '11110 10001 10001 11110 10000 10000 10000', Q: '01110 10001 10001 10001 10101 10010 01101', R: '11110 10001 10001 11110 10100 10010 10001',
    S: '01111 10000 10000 01110 00001 00001 11110', T: '11111 00100 00100 00100 00100 00100 00100', U: '10001 10001 10001 10001 10001 10001 01110',
    V: '10001 10001 10001 10001 10001 01010 00100', W: '10001 10001 10001 10101 10101 11011 10001', X: '10001 10001 01010 00100 01010 10001 10001',
    Y: '10001 10001 01010 00100 00100 00100 00100', Z: '11111 00001 00010 00100 01000 10000 11111',
    0: '01110 10001 10011 10101 11001 10001 01110', 1: '00100 01100 00100 00100 00100 00100 01110', 2: '01110 10001 00001 00010 00100 01000 11111',
    3: '11110 00001 00001 01110 00001 00001 11110', 4: '00010 00110 01010 10010 11111 00010 00010', 5: '11111 10000 11110 00001 00001 10001 01110',
    6: '00110 01000 10000 11110 10001 10001 01110', 7: '11111 00001 00010 00100 01000 01000 01000', 8: '01110 10001 10001 01110 10001 10001 01110',
    9: '01110 10001 10001 01111 00001 00010 01100',
  };
  // boxes spelling `str` in a local x-y plane, centred on the origin; h = cap height, t = thickness
  function textGeos(str, h, t) {
    const px = h / 7, adv = px * 6, out = [];
    let x0 = -(str.length * adv - px) / 2;
    for (const chr of str) {
      const rows = FONT[chr] ? FONT[chr].split(' ') : null;
      if (rows) rows.forEach((row, r) => {
        // one box per horizontal run of lit pixels
        for (let c = 0; c < 5; c++) {
          if (row[c] !== '1') continue;
          let e = c;
          while (e + 1 < 5 && row[e + 1] === '1') e++;
          const g = new THREE.BoxGeometry((e - c + 1) * px, px, t);
          g.translate(x0 + ((c + e + 1) / 2) * px, h / 2 - (r + 0.5) * px, 0);
          out.push(g);
          c = e;
        }
      });
      x0 += adv;
    }
    return out;
  }
  const textWidth = (str, h) => (str.length * 6 - 1) * (h / 7);

  function group(parent, ex, stage) {
    const g = new THREE.Group();
    g.userData.ex = ex ? V(ex) : new THREE.Vector3();
    g.userData.home = new THREE.Vector3();
    g.userData.stage = stage || 0;
    parent.add(g);
    return g;
  }

  window.BBKit = {
    THREE, SCALE: 2.0, LIVERIES, STOCK, makeMaterials, std, basic, glow, rng,
    V, cylA, along, rotY, at, aim, merge, put, box, strut, rod, stretch,
    shapeOf, extrude, plateXZ, plateZY, plateXY, rectPts, bolts, linspace,
    motor, esc, batteryPack, bottle, group, textGeos, textWidth,
  };
})();
