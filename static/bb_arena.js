/**
 * BattleBot Designer — ARENA mode.
 *
 * Part 1 (ArenaCore) is a pure, seeded, fixed-step combat simulation with no DOM access, so it runs in Node
 * for testing: createMatch / stepMatch / judge / botSpec. Part 2 (browser only) is the 2D canvas renderer,
 * HUD and replay, exposed as window.BBArena = { open, close, isOpen }.
 *
 * All simulation maths is in the heavyweight reference space used by BBPhysics; smaller weight classes are
 * scale models of it, so only displayed text is rescaled (BBPhysics.scaleText).
 * Bot frame matches BBPhysics: +Z forward, +X right. Arena frame: x right, y down the screen, heading th
 * measured from +x, so forward = (cos th, sin th) and right = (-sin th, cos th).
 */
(function (root) {
  'use strict';
  const IS_NODE = typeof module === 'object' && !!module.exports;
  const PHYS = IS_NODE ? require('./bb_physics.js') : null;
  // resolved lazily in the browser so script order relative to bb_physics.js does not matter
  const PH = () => PHYS || root.BBPhysics;

  // ===========================================================================
  // PART 1 — SIMULATION CORE
  // ===========================================================================
  const ArenaCore = (function () {
    const ARENA = 5;            // half-width of the square arena floor, metres
    const STEP = 1 / 60;        // the step the UI and the tests both use
    const MATCH_S = 180;
    const KO_COUNT = 10;
    const REC_EVERY = 2;        // record every 2nd step (30 Hz); replay interpolates between frames
    const FIRE_S = 14;          // a battery fire burns this long; power dies 6 s after ignition
    const FACES = ['front', 'left', 'right', 'rear', 'top'];
    const SLOTS = ['front', 'top', 'rear', 'left', 'right'];
    const LEVELS = {
      rookie: { name: 'ROOKIE', react: 0.45, speed: 0.62, aimTol: 0.5, spinMin: 0.3, patience: 1.5, hazard: 0, fireLag: 0.35, smart: 0 },
      veteran: { name: 'VETERAN', react: 0.22, speed: 0.85, aimTol: 0.3, spinMin: 0.6, patience: 4, hazard: 1, fireLag: 0.12, smart: 0 },
      champion: { name: 'CHAMPION', react: 0.08, speed: 1, aimTol: 0.16, spinMin: 0.82, patience: 7, hazard: 2, fireLag: 0, smart: 1 },
    };
    // copied from bb_kit.js (that file needs THREE, so it cannot be required here)
    const LIVERIES = {
      signal: { armor: '#e2481f', top: '#d9d6cd', accent: '#141416' }, hazard: { armor: '#e8ad12', top: '#1b1d21', accent: '#1b1d21' },
      cobalt: { armor: '#1a50c0', top: '#d6dae2', accent: '#f59e0b' }, viper: { armor: '#a81414', top: '#141518', accent: '#e8ebf0' },
      olive: { armor: '#56633a', top: '#2a2e22', accent: '#e07a00' }, mono: { armor: '#9aa0a8', top: '#868c94', accent: '#e2481f' },
      graphite: { armor: '#2a2f3a', top: '#1a1d24', accent: '#00b4d8' }, arctic: { armor: '#e4e2da', top: '#cfd4d9', accent: '#0077b6' },
      rust: { armor: '#7a3b1e', top: '#3a2a22', accent: '#f2b61b' }, gunship: { armor: '#3d4349', top: '#2a2e33', accent: '#d62828' },
      toxic: { armor: '#6cc21a', top: '#15171a', accent: '#b517d6' }, carbon: { armor: '#17181b', top: '#101114', accent: '#e11d2e' },
      desert: { armor: '#b79a6a', top: '#8c7650', accent: '#2a2a2a' }, royal: { armor: '#5b21b6', top: '#e9e4f5', accent: '#fbbf24' },
    };

    const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
    const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const wrap = (a) => { const t = Math.PI * 2; return ((((a + Math.PI) % t) + t) % t) - Math.PI; };
    const approach = (v, target, step) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step));

    // mulberry32: the whole match draws from one seeded stream so a given seed always replays identically
    function rand(m) {
      m.seed = (m.seed + 0x6d2b79f5) | 0;
      let t = Math.imul(m.seed ^ (m.seed >>> 15), 1 | m.seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    const hash01 = (a, b) => rand({ seed: (Math.imul(a | 0, 2654435761) ^ Math.imul(b | 0, 40503)) | 0 });

    // ---- geometry -----------------------------------------------------------------------------------
    const toWorld = (b, lx, lz) => { const c = Math.cos(b.th), s = Math.sin(b.th); return { x: b.x + c * lz - s * lx, y: b.y + s * lz + c * lx }; };
    const toLocal = (b, wx, wy) => { const c = Math.cos(b.th), s = Math.sin(b.th), dx = wx - b.x, dy = wy - b.y; return { x: -dx * s + dy * c, z: dx * c + dy * s }; };
    function pointInPoly(poly, x, z) {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
      }
      return inside;
    }
    function closestOnPoly(poly, x, z) {
      if (pointInPoly(poly, x, z)) return { x, z, d: 0 };
      let best = { x, z, d: Infinity };
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[j], b = poly[i], ex = b[0] - a[0], ez = b[1] - a[1];
        const u = clamp(((x - a[0]) * ex + (z - a[1]) * ez) / (ex * ex + ez * ez || 1), 0, 1);
        const qx = a[0] + ex * u, qz = a[1] + ez * u, d = Math.hypot(x - qx, z - qz);
        if (d < best.d) best = { x: qx, z: qz, d };
      }
      return best;
    }
    const hullWorld = (b) => b.spec.hull.map((v) => { const p = toWorld(b, v[0], v[1]); return [p.x, p.y]; });
    // which armour plate a point on (or near) the hull belongs to
    function faceAt(spec, lx, lz) {
      const zc = (spec.zF + spec.zR) / 2, nz = (lz - zc) / ((spec.zF - spec.zR) / 2), nx = lx / spec.halfW;
      return Math.abs(nz) >= Math.abs(nx) ? (nz > 0 ? 'front' : 'rear') : nx > 0 ? 'right' : 'left';
    }
    // separating-axis test for two convex polygons in world space; returns the minimum push from A to B
    function sat(pa, pb, ca, cb) {
      let depth = Infinity, nx = 0, ny = 0;
      for (const poly of [pa, pb]) {
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          let ax = poly[i][1] - poly[j][1], ay = poly[j][0] - poly[i][0];
          const len = Math.hypot(ax, ay) || 1; ax /= len; ay /= len;
          let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
          for (const v of pa) { const d = v[0] * ax + v[1] * ay; a0 = Math.min(a0, d); a1 = Math.max(a1, d); }
          for (const v of pb) { const d = v[0] * ax + v[1] * ay; b0 = Math.min(b0, d); b1 = Math.max(b1, d); }
          const o = Math.min(a1, b1) - Math.max(a0, b0);
          if (o <= 0) return null;
          if (o < depth) { depth = o; nx = ax; ny = ay; }
        }
      }
      if ((cb.x - ca.x) * nx + (cb.y - ca.y) * ny < 0) { nx = -nx; ny = -ny; }
      return { depth, nx, ny };
    }

    // ---- bot spec: everything the arena needs from a BBPhysics build, as plain data ------------------
    const circlePts = (r, n) => Array.from({ length: n }, (_, i) => [Math.sin((i / n) * Math.PI * 2) * r, Math.cos((i / n) * Math.PI * 2) * r]);

    function bodyShape(build) {
      const lay = build.layout || {}, ch = build.chassis || {};
      const shape = ch.shape || lay.shape || 'box';
      const fp = lay.footprint || {};
      const halfL = num(fp.zFront, num(ch.L, 0.8) / 2), fullHW = num(fp.xHalf, num(ch.W, 0.7) / 2);
      const bw = num(lay.bodyHalfW, fullHW), nose = num(lay.nose, 0);
      let zF = halfL + nose, zR = -halfL, halfW = fullHW, outline, hull;
      const rect = (hw) => [[-hw, zF], [hw, zF], [hw, zR], [-hw, zR]];
      if (shape === 'round') {
        const R = num(lay.Rb, fullHW);
        zF = R; zR = -R; halfW = R; outline = circlePts(R, 24); hull = circlePts(R, 12);
      } else if (shape === 'hex') {
        const c = Math.min(num(lay.cut, 0.17 * halfL * 2), bw * 0.6, halfL * 0.6);
        outline = hull = [[-(bw - c), zF], [bw - c, zF], [bw, zF - c], [bw, zR + c], [bw - c, zR], [-(bw - c), zR], [-bw, zR + c], [-bw, zF - c]];
      } else if (shape === 'delta') {
        const t = clamp(num(lay.taper, 0.3), 0.1, 1);
        outline = hull = [[-bw * t, zF], [bw * t, zF], [bw, zR], [-bw, zR]];
      } else if (shape === 'ushape' || shape === 'hframe') {
        const n = lay.notch || {}, nh = clamp(num(n.half, bw * 0.44), 0.03, bw - 0.05), nf = num(n.f, 0), nr = num(n.r, 0);
        outline = [[-bw, zF]];
        if (nf > 0) outline.push([-nh, zF], [-nh, zF - nf], [nh, zF - nf], [nh, zF]);
        outline.push([bw, zF], [bw, zR]);
        if (nr > 0) outline.push([nh, zR], [nh, zR + nr], [-nh, zR + nr], [-nh, zR]);
        outline.push([-bw, zR]);
        hull = rect(bw);
      } else {
        outline = rect(bw);
        // outboard wheels and walker legs stick out past the body, and they are what the other bot runs into
        let reach = fullHW;
        for (const lg of lay.legs || []) reach = Math.max(reach, Math.abs(num(lg.x, 0)) + 0.03);
        halfW = reach; hull = rect(reach);
      }
      let radius = 0;
      for (const v of hull) radius = Math.max(radius, Math.hypot(v[0], v[1]));
      return { shape, outline, hull, zF, zR, halfW, bodyHalfW: shape === 'round' ? halfW : bw, radius, nose, noseZ: zF - nose };
    }

    // one weapon / attachment: sim numbers, a strike zone in the bot frame and a drawing style
    function weaponSpec(m, slot, body) {
      const kind = m.kind || (m.def && m.def.kind) || 'passive', type = String(m.type || 'unknown');
      const mount = m.mount || {}, geo = m.geo || {}, axis = m.axis || geo.axis;
      const mx = num(mount.x, 0), mz = num(mount.z, 0), rot = num(mount.rot, 0);
      // hardpoints face one of four ways, so every strike zone is an axis-aligned box (or a circle) in the bot frame
      const dir = { x: Math.round(Math.sin(rot)), z: Math.round(Math.cos(rot)) };
      if (!dir.x && !dir.z) dir.z = 1;
      const edge = dir.z > 0 ? body.zF : dir.z < 0 ? -body.zR : body.halfW;
      const w = {
        slot, type, kind, name: (m.def && m.def.name) || type.toUpperCase(), mx, mz, rot, dir, deck: mount.kind === 'deck',
        mode: 'passive', effect: 'none', style: 'generic', energy: 0, pierce: 1, cycle: 1, shots: Infinity, tau: 1, dur: 0, dps: 0, fuel: 0,
        range: 0, speed: 0, overhead: false, vertical: false, full: false, ram: 1, deflect: 1, wedge: false, selfRight: !!m.selfRight, threat: 0,
        hp: 20000 + num(m.mass, 10) * 300,
      };
      const solid = ((m.env && m.env.solid) || []).filter((b) => Array.isArray(b) && b.length >= 6 && b.every(Number.isFinite));
      const fire = ((m.env && m.env.fire) || []).filter((b) => Array.isArray(b) && b.length >= 6 && b.every(Number.isFinite));
      // a box given as a distance range along the mount direction plus a half-width
      const along = (a0, a1, hw) => (dir.z
        ? { x0: mx - hw, x1: mx + hw, z0: Math.min(dir.z * a0, dir.z * a1), z1: Math.max(dir.z * a0, dir.z * a1) }
        : { z0: mz - hw, z1: mz + hw, x0: Math.min(dir.x * a0, dir.x * a1), x1: Math.max(dir.x * a0, dir.x * a1) });
      const span = (r) => (dir.z ? { a0: dir.z > 0 ? r.z0 : -r.z1, a1: dir.z > 0 ? r.z1 : -r.z0, lo: r.x0, hi: r.x1 } : { a0: dir.x > 0 ? r.x0 : -r.x1, a1: dir.x > 0 ? r.x1 : -r.x0, lo: r.z0, hi: r.z1 });
      const unspan = (q) => (dir.z ? { x0: q.lo, x1: q.hi, z0: Math.min(dir.z * q.a0, dir.z * q.a1), z1: Math.max(dir.z * q.a0, dir.z * q.a1) } : { z0: q.lo, z1: q.hi, x0: Math.min(dir.x * q.a0, dir.x * q.a1), x1: Math.max(dir.x * q.a0, dir.x * q.a1) });
      const union = (list) => list.reduce((u, b) => ({ x0: Math.min(u.x0, b[0]), x1: Math.max(u.x1, b[1]), z0: Math.min(u.z0, b[4]), z1: Math.max(u.z1, b[5]) }), { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity });
      // Only the part of a mechanism that pokes out past the hull can touch the other bot. A weapon that sits
      // wholly over its own deck is widened to clear the hull edge, otherwise it could never land a hit in 2D.
      const stickOut = (r, trim) => {
        const q = span(r);
        if (trim) q.a0 = Math.max(q.a0, edge - 0.05);
        q.a1 = Math.max(q.a1, edge + 0.15, q.a0 + 0.2);
        if (q.hi - q.lo < 0.08) { const c = (q.hi + q.lo) / 2; q.lo = c - 0.04; q.hi = c + 0.04; }
        return unspan(q);
      };
      const contactZone = (trim) => stickOut(solid.length ? union(solid) : along(edge, edge + 0.3, 0.15), trim);
      // ranged weapons: muzzle at the near end of the model's fire volume, zone = the path of the jet / shot
      const rangedZone = (len, hw) => {
        const q = fire.length ? span(union([fire[0]])) : { a0: edge + 0.1, a1: edge + 0.5, lo: (dir.z ? mx : mz) - 0.04, hi: (dir.z ? mx : mz) + 0.04 };
        const c = (q.lo + q.hi) / 2;
        w.muzzle = dir.z ? { x: c, z: dir.z * q.a0 } : { x: dir.x * q.a0, z: c };
        return unspan({ a0: q.a0, a1: q.a0 + len, lo: c - hw, hi: c + hw });
      };

      if (m.meltySpin) {
        w.mode = 'spin'; w.style = 'melty'; w.full = true;
        w.energy = num(m.meltySpin.ke, 0); w.tau = Math.max(0.15, num(m.meltySpin.t90, 1) / 2.3);
        w.zone = { x: 0, z: 0, r: Math.max(num(m.meltySpin.reach, 0), body.radius + 0.05) };
        w.threat = w.energy * 0.5 + 500;
      } else if (kind === 'armsaw') {
        w.mode = 'spin'; w.style = 'hammer'; w.sawHead = true; w.overhead = true; w.pierce = 1.6;
        w.energy = num(m.spin && m.spin.ke, 0); w.tau = Math.max(0.15, num(m.spin && m.spin.t90, 1) / 2.3);
        w.zone = contactZone(true); w.threat = w.energy * 0.5 * w.pierce;
      } else if (kind === 'spinner' || m.spin) {
        const sp = m.spin || {};
        w.mode = 'spin'; w.energy = num(sp.ke, 0); w.tau = Math.max(0.15, num(sp.t90, 2) / 2.3);
        if (axis === 'y') {
          const R = num(geo.tipR, num(geo.R, 0.3));
          w.full = type === 'shell' || type === 'ring' || !!geo.center;
          if (w.full || w.deck) { w.zone = { x: 0, z: 0, r: Math.max(R, (w.full ? body.radius : Math.max(body.halfW, body.zF)) + (w.full ? 0.04 : 0.12)) }; } else {
            const rp = geo.rotorPos || { x: 0, z: 0.3 }, c = Math.cos(rot), s = Math.sin(rot);
            w.zone = { x: mx + num(rp.x, 0) * c + num(rp.z, 0.3) * s, z: mz - num(rp.x, 0) * s + num(rp.z, 0.3) * c, r: R };
          }
          w.style = w.full ? 'shell' : 'bar';
        } else {
          w.zone = stickOut(solid.length ? union([solid[0]]) : along(edge, edge + 0.3, 0.15), false);
          w.vertical = axis !== 'z';
          w.style = axis === 'z' || type === 'drill' ? 'drill' : type === 'twin' ? 'twin' : num(geo.halfX, 0) > 0.1 ? 'drum' : 'disk';
          if (w.style === 'drill') w.pierce = 6; else if (type === 'saw') w.pierce = 1.6;
        }
        w.threat = w.energy * 0.5 * w.pierce;
      } else if (m.hammer) {
        w.mode = 'trigger'; w.effect = 'hammer'; w.style = 'hammer'; w.overhead = true; w.pierce = type === 'axe' ? 5 : 4;
        w.energy = num(m.hammer.E, 800); w.cycle = clamp(num(m.hammer.swingS, 0.2) * 2 + 0.5, 0.5, 2);
        w.zone = contactZone(true); w.threat = (w.energy * w.pierce * 2) / w.cycle;
      } else if (m.flip) {
        w.mode = 'trigger'; w.effect = 'flip'; w.style = 'flipper'; w.cycle = 0.9;
        w.energy = num(m.flip.energy, 3000); w.shots = Math.max(0, Math.round(num(m.flip.shots, 10)));
        w.zone = contactZone(true); w.threat = 30000;
      } else if (m.punch) {
        w.mode = 'trigger'; w.effect = 'punch'; w.style = 'punch'; w.cycle = 0.7; w.pierce = 2;
        w.energy = num(m.punch.energy, 3000); w.shots = Math.max(0, Math.round(num(m.punch.shots, 10)));
        w.zone = contactZone(true); w.threat = w.energy * 2;
      } else if (m.lift) {
        w.mode = 'trigger'; w.effect = 'lift'; w.style = 'lifter'; w.cycle = 2 + clamp(num(m.lift.timeS, 0.5), 0.2, 2);
        w.energy = num(m.lift.liftKg, 300) * 9.81 * 0.3; w.throwP = type === 'suplex' ? 0.6 : m.grab ? 0.3 : 0.15;
        w.zone = contactZone(true); w.threat = 12000;
      } else if (m.crush) {
        w.mode = 'channel'; w.style = 'crusher'; w.overhead = true; w.pierce = 3;
        w.dur = clamp(num(m.crush.closeS, 2), 0.8, 4); w.cycle = w.dur + 1;
        w.energy = num(m.crush.tipForce, 50000) * 0.05; w.dps = (w.energy * w.pierce) / w.dur;
        w.zone = contactZone(true); w.threat = w.energy * w.pierce;
      } else if (m.grab) {
        w.mode = 'channel'; w.style = 'grabber'; w.dur = 1.6; w.cycle = 2.6;
        w.energy = num(m.grab.force, 800) * 0.4; w.dps = w.energy / w.dur;
        w.zone = contactZone(true); w.threat = 2000;
      } else if (m.flame) {
        w.mode = 'hold'; w.style = 'flame'; w.fuel = num(m.flame.burnS, 20); w.range = clamp(num(m.flame.rangeM, 1.2), 0.4, 3);
        w.dps = num(m.flame.kw, 300) * 1000 * 0.005;   // only a sliver of the jet's heat ends up in the plate
        w.zone = rangedZone(w.range, 0.24); w.threat = w.dps * 2;
      } else if (m.arc) {
        w.mode = 'trigger'; w.effect = 'arc'; w.style = 'arc'; w.energy = num(m.arc.E, 1000); w.cycle = Math.max(0.4, num(m.arc.rechargeS, 1.5));
        w.range = 1.0; w.zone = rangedZone(w.range, 0.3); w.threat = w.energy * 3;
      } else if (m.launch) {
        const payload = geo.payload || type;
        w.mode = 'trigger'; w.effect = 'shoot'; w.style = 'gun'; w.payload = payload;
        w.energy = num(m.launch.E, 500); w.shots = Math.max(0, Math.round(num(m.launch.shots, 10)));
        w.speed = clamp(num(m.launch.v, 40), 12, 30);  // slowed to something the eye can follow
        w.cycle = payload === 'cannon' ? 0.25 : payload === 'coil' ? 0.35 : 1;
        w.pierce = payload === 'net' ? 0 : payload === 'coil' ? 3 : payload === 'spike' ? 2 : payload === 'harpoon' ? 1.5 : 1;
        w.range = 6; w.zone = rangedZone(w.range, 0.2); w.threat = payload === 'net' ? 3000 : (w.energy * w.pierce) / w.cycle;
      } else {
        w.zone = contactZone(true);
        w.style = ['forks', 'plow', 'ramp', 'spikes', 'tail', 'srimech'].includes(type) ? type : 'generic';
        w.ram = type === 'spikes' ? 3 : type === 'tail' ? 2 : 1;
        w.deflect = type === 'plow' ? 0.5 : type === 'ramp' ? 0.55 : type === 'forks' ? 0.7 : 1;
        w.wedge = type === 'ramp' || type === 'forks' || type === 'plow';
      }

      // where the weapon points and how far it reaches, for the AI and the drawing code
      const z = w.zone, cx = z.r ? z.x : (z.x0 + z.x1) / 2, cz = z.r ? z.z : (z.z0 + z.z1) / 2;
      w.omni = !!z.r && Math.hypot(cx, cz) < 0.05;
      w.aim = w.omni ? 0 : Math.atan2(cx, cz);
      w.reach = z.r ? Math.hypot(cx, cz) + z.r : Math.max(Math.abs(z.x0), Math.abs(z.x1), Math.abs(z.z0), Math.abs(z.z1));
      // the same zone in the mount frame (a = outward, b = lateral), which is the frame modules are drawn in
      const c = Math.cos(rot), s = Math.sin(rot);
      const inMount = (x, zz) => ({ a: (x - mx) * s + (zz - mz) * c, b: (x - mx) * c - (zz - mz) * s });
      if (z.r) { const q = inMount(z.x, z.z); w.vis = { a: q.a, b: q.b, r: z.r }; } else {
        const p = inMount(z.x0, z.z0), q = inMount(z.x1, z.z1);
        w.vis = { a0: Math.min(p.a, q.a), a1: Math.max(p.a, q.a), b0: Math.min(p.b, q.b), b1: Math.max(p.b, q.b) };
      }
      if (w.muzzle) { const q = inMount(w.muzzle.x, w.muzzle.z); w.vis.ma = q.a; w.vis.mb = q.b; }
      return w;
    }

    function botSpec(build) {
      const ph = PH();
      const cfg = build.cfg || {}, lay = build.layout || {}, ch = build.chassis || {}, drv = build.drive || {}, dyn = build.dyn || {};
      const body = bodyShape(build);
      const lv = (cfg.livery === 'custom' && cfg.paint) || LIVERIES[cfg.livery] || LIVERIES.signal;
      const mass = Math.max(5, num(build.mass, 100));
      const topSpeed = clamp(num(drv.topSpeed, 3), 0.3, 12), track = Math.max(0.2, num(build.track, body.halfW * 2));
      const spec = {
        name: String(cfg.name || 'UNIT'), text: String(cfg.text || ''), chassis: cfg.chassis, ...body,
        colors: { armor: lv.armor, top: lv.top, accent: lv.accent },
        wheels: (lay.wheels || []).map((q) => ({ x: num(q.x, 0), z: num(q.z, 0), r: num(lay.wR, 0.07), w: num(lay.wheelW, 0.05) })),
        legs: (lay.legs || []).map((q) => ({ x: num(q.x, 0), z: num(q.z, 0) })),
        tracks: !!ch.tracks, caster: lay.caster ? { x: num(lay.caster.x, 0), z: num(lay.caster.z, 0) } : null, tube: body.shape === 'tube',
        mass, massLb: num(build.massLb, mass * 2.2), topSpeed, accel: clamp(num(drv.accel, 6), 1, 20), push: num(drv.push, 400),
        turnRate: clamp((topSpeed / track) * (drv.legs ? 0.7 : 1), 2.2, 6.5), strafe: !!drv.strafe, legged: !!drv.legs,
        gyroLimit: num(dyn.gyroTurnLimit, 99), invertible: !!build.invertible, selfRights: !!build.selfRights,
        legal: build.legal !== false, k: num(build.u && build.u.k, 1), className: (build.u && build.u.className) || 'HEAVYWEIGHT',
        shockMounted: !!(cfg.extras && cfg.extras.shock), armour: {}, weapons: [],
      };
      // armour: a plate's capacity to soak up weapon energy grows with yield strength and thickness
      for (const f of FACES) {
        let a = null;
        try { a = ph.faceOf(cfg, f === 'left' || f === 'right' ? 'side' : f); } catch (e) { a = null; }
        const mat = (a && ph.MATERIALS[a.mat]) || ph.MATERIALS[cfg.armorMat] || { name: 'PLATE', yieldMPa: 500, rho: 4000 };
        const t = num(a && a.t, num(cfg.armorT, 5));
        spec.armour[f] = { hp: 9000 + 32 * mat.yieldMPa * t, mat: mat.name, t, burns: mat.rho < 2000 };
      }
      spec.driveHp = 24000 + mass * 90;
      spec.batteryHp = 50000 * (cfg.extras && cfg.extras.batbox ? 2.2 : 1);
      for (const s of SLOTS) {
        const m = build.mods && build.mods[s];
        if (!m) continue;
        let w;
        // an unknown or half-specified module must never take the arena down: it becomes a dumb attachment
        try { w = weaponSpec(m, s, body); } catch (e) { w = weaponSpec({ type: m.type, mount: m.mount }, s, body); }
        spec.weapons.push(w);
      }
      spec.primary = -1;
      spec.weapons.forEach((w, i) => { if (w.mode !== 'passive' && (spec.primary < 0 || w.threat > spec.weapons[spec.primary].threat)) spec.primary = i; });
      return spec;
    }

    // ---- match state --------------------------------------------------------------------------------
    function makeBot(spec, idx, x, th) {
      const hp = {};
      for (const f of FACES) hp[f] = spec.armour[f].hp;
      return {
        idx, spec, x, y: 0, th, vx: 0, vy: 0, om: 0, bodyAng: 0, inv: false, air: 0, stun: 0, slow: 0, held: 0, slip: 0, righting: 0,
        hp, sub: { driveL: spec.driveHp, driveR: spec.driveHp, battery: spec.batteryHp }, fire: 0, fireTick: 0, fireBy: -1, power: true,
        w: spec.weapons.map((w) => ({ spin: 0, on: true, cd: 0, shots: w.shots, fuel: w.fuel, act: 0, anim: 0, acc: 0, tick: 0, ang: 0, dead: false, hp: w.hp, prev: false, lag: 0 })),
        cd: { saw: 0, grind: 0, burn: 0, wall: 0 }, count: 0, ko: false, out: false, lastTouchT: -9, lastHitT: -9,
        stat: { dmg: 0, hits: 0, aggr: 0, ctrl: 0, breaches: 0, disables: 0, flips: 0, big: 0 },
      };
    }

    function makeHazards(on) {
      const h = on || {};
      return {
        saws: h.saws === false ? [] : [[-1.9, -1.7, 0], [1.9, -1.7, 2], [-1.9, 1.7, 4], [1.9, 1.7, 6]].map((q) => ({ x: q[0], y: q[1], len: 1.1, phase: q[2], up: 0 })),
        pulv: h.pulverizer === false ? null : { x: -4.1, y: -4.1, r: 0.95, cd: 0, anim: 0 },
        screws: h.screws === false ? null : { y: ARENA - 0.42, x0: -3.2, x1: 3.2 },
        pit: h.pit === false ? null : { x: 4.0, y: -4.0, h: 0.75, openAt: 90, open: 0 },
        flames: h.flames === false ? [] : [[0, -2.7, 1], [0, 2.5, 4.5]].map((q) => ({ x: q[0], y: q[1], phase: q[2], on: 0 })),
      };
    }

    /** options: { seed, difficulty: 'rookie'|'veteran'|'champion', playerDifficulty, hazards: { saws, pulverizer, screws, pit, flames } } */
    function createMatch(playerBuild, opponentBuild, options) {
      const opt = options || {};
      const seed = (num(opt.seed, 1) | 0) || 1;
      const level = LEVELS[opt.difficulty] ? opt.difficulty : 'veteran';
      const m = {
        seed, seed0: seed, t: 0, steps: 0, over: false, result: null, events: [], frames: [], proj: [], big: null,
        bots: [makeBot(botSpec(playerBuild), 0, -3.3, 0), makeBot(botSpec(opponentBuild), 1, 3.3, Math.PI)],
        hz: makeHazards(opt.hazards), limit: MATCH_S,
        ai: [LEVELS[opt.playerDifficulty] ? opt.playerDifficulty : level, level].map((lv) => ({ level: lv, state: 'approach', timer: 0, until: 0, goalX: 0, goalY: 0, stuckT: 0, spinT: 0, commit: false, lx: 0, ly: 0, side: 1, weapon: -1 })),
      };
      m.frames.push(snap(m));
      return m;
    }

    const emit = (m, type, o) => { const e = Object.assign({ t: m.t, type }, o); m.events.push(e); return e; };

    // ---- damage model -------------------------------------------------------------------------------
    function disable(m, b, key, label, src) {
      emit(m, 'disable', { to: b.idx, x: b.x, y: b.y, text: `${b.spec.name}: ${label}` });
      if (src.by >= 0 && src.by !== b.idx) m.bots[src.by].stat.disables++;
      if (key === 'battery') { b.fire = FIRE_S; b.fireBy = src.by; }
    }
    // energy that got past (or leaked through) a plate lands on whatever is bolted behind that face
    function internal(m, b, face, amount, src, shockOnly) {
      if (amount <= 0) return;
      const wi = b.spec.weapons.findIndex((w) => w.slot === face);
      const shares = face === 'left' ? [['driveL', 0.7], ['w', 0.3]] : face === 'right' ? [['driveR', 0.7], ['w', 0.3]]
        : face === 'front' ? [['w', 0.6], ['driveL', 0.2], ['driveR', 0.2]]
          : face === 'rear' ? [['battery', 0.5], ['w', 0.3], ['driveL', 0.1], ['driveR', 0.1]]
            : [['w', 0.35], ['battery', 0.35], ['driveL', 0.15], ['driveR', 0.15]];
      for (const [key, share] of shares) {
        let k = key;
        // an empty hardpoint has nothing to break, so its share goes to the nearest vital part instead
        if (k === 'w' && (wi < 0 || b.w[wi].dead)) k = face === 'left' ? 'driveL' : face === 'right' ? 'driveR' : 'battery';
        // shock through an intact plate rattles motors and mechanisms, but only a breach lets a weapon reach the packs
        if (k === 'battery' && shockOnly) continue;
        if (k === 'w') {
          const ws = b.w[wi];
          ws.hp -= amount * share;
          if (ws.hp <= 0) { ws.dead = true; ws.on = false; ws.act = 0; disable(m, b, 'w', `${b.spec.weapons[wi].name} DISABLED`, src); }
        } else if (b.sub[k] > 0) {
          b.sub[k] -= amount * share;
          if (b.sub[k] <= 0) disable(m, b, k, k === 'battery' ? 'BATTERY FIRE' : k === 'driveL' ? 'LEFT DRIVE DEAD' : 'RIGHT DRIVE DEAD', src);
        }
      }
    }
    // src: { by: attacker index or -1, kind, x, y, quiet }
    function damage(m, to, face, amount, src) {
      const b = m.bots[to];
      if (!(amount > 0) || b.out) return;
      const before = b.hp[face], absorbed = Math.min(before, amount);
      b.hp[face] = before - absorbed;
      const attacker = src.by >= 0 && src.by !== to ? m.bots[src.by] : null;
      if (before > 0 && b.hp[face] <= 0) {
        emit(m, 'breach', { to, face, x: src.x, y: src.y, text: `${b.spec.name}: ${face.toUpperCase()} ARMOUR BREACHED` });
        if (attacker) attacker.stat.breaches++;
      }
      // shock always leaks a little into the electronics behind an intact plate; isolators cut that down
      internal(m, b, face, amount - absorbed, src, false);
      internal(m, b, face, absorbed * (b.spec.shockMounted ? 0.02 : 0.04), src, true);
      if (attacker) {
        attacker.stat.dmg += amount; attacker.stat.hits++; attacker.stat.big = Math.max(attacker.stat.big, amount);
        if (!src.hazard) attacker.lastHitT = m.t;
      }
      if (!src.quiet) {
        emit(m, 'hit', { to, by: src.by, face, kind: src.kind, dmg: amount, x: src.x, y: src.y });
        if (!m.big || amount > m.big.dmg) m.big = { t: m.t, dmg: amount, x: src.x, y: src.y, by: src.by, to, kind: src.kind };
      }
    }
    function flip(m, b, by) {
      b.inv = !b.inv; b.air = Math.max(b.air, 0.7); b.righting = 0;
      const stranded = b.inv && !b.spec.invertible;
      emit(m, 'flip', { to: b.idx, x: b.x, y: b.y, text: `${b.spec.name} ${b.inv ? (stranded ? 'IS FLIPPED' : 'FLIPPED - RUNS INVERTED') : 'IS BACK ON ITS WHEELS'}` });
      if (by >= 0 && by !== b.idx) { m.bots[by].stat.flips++; m.bots[by].stat.ctrl += 4; }
    }
    // throw both bots apart with a share of the hit energy
    function knock(m, a, b, E, spinSide) {
      let nx = b.x - a.x, ny = b.y - a.y;
      const d = Math.hypot(nx, ny) || 1; nx /= d; ny /= d;
      const dvB = Math.min(7, Math.sqrt((2 * 0.12 * E) / b.spec.mass)), dvA = Math.min(4, Math.sqrt((2 * 0.05 * E) / a.spec.mass));
      // a horizontal rotor throws the target sideways as well as away
      b.vx += (nx - ny * spinSide * 0.6) * dvB; b.vy += (ny + nx * spinSide * 0.6) * dvB;
      b.om += (rand(m) - 0.5) * dvB * 1.5 + spinSide * dvB * 0.6;
      a.vx -= nx * dvA; a.vy -= ny * dvA; a.om -= spinSide * dvA * 0.8;
    }

    // world-space contact between a weapon's strike zone and the other bot's hull, or null
    function zoneContact(a, w, b) {
      const z = w.zone, hb = b.spec.hull;
      if (z.r) {
        const c = toWorld(a, z.x, z.z), lc = toLocal(b, c.x, c.y), q = closestOnPoly(hb, lc.x, lc.z);
        return q.d > z.r ? null : toWorld(b, q.x, q.z);
      }
      let n = 0, sx = 0, sy = 0;
      for (const v of hb) {
        const p = toWorld(b, v[0], v[1]), l = toLocal(a, p.x, p.y);
        if (l.x >= z.x0 && l.x <= z.x1 && l.z >= z.z0 && l.z <= z.z1) { n++; sx += p.x; sy += p.y; }
      }
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        const p = toWorld(a, z.x0 + ((z.x1 - z.x0) * i) / 3, z.z0 + ((z.z1 - z.z0) * j) / 3), l = toLocal(b, p.x, p.y);
        if (pointInPoly(hb, l.x, l.z)) { n++; sx += p.x; sy += p.y; }
      }
      return n ? { x: sx / n, y: sy / n } : null;
    }
    const struckFace = (w, b, c) => { if (w.overhead) return 'top'; const l = toLocal(b, c.x, c.y); return faceAt(b.spec, l.x, l.z); };

    function fireTrigger(m, a, b, w, ws, wi) {
      ws.cd = w.cycle; ws.anim = 1; ws.shots--;
      const c = b.out ? null : zoneContact(a, w, b);
      emit(m, 'fire', { by: a.idx, w: wi, x: a.x, y: a.y });
      if (w.effect === 'shoot') {
        const p = toWorld(a, w.muzzle.x, w.muzzle.z), ang = a.th + w.rot + (rand(m) - 0.5) * 0.05;
        m.proj.push({ x: p.x, y: p.y, vx: Math.cos(ang) * w.speed, vy: Math.sin(ang) * w.speed, E: w.energy, pierce: w.pierce, kind: w.payload, by: a.idx, life: 1.2 });
        return;
      }
      if (w.effect === 'arc') {
        const p = toWorld(a, w.muzzle.x, w.muzzle.z);
        const end = c || toWorld(a, w.muzzle.x + w.dir.x * w.range, w.muzzle.z + w.dir.z * w.range);
        emit(m, 'arc', { by: a.idx, x: p.x, y: p.y, x2: end.x, y2: end.y });
        if (!c) return;
        // a discharge goes around the armour: it stuns the drive and cooks whatever is behind the nearest face
        b.stun = Math.max(b.stun, clamp(0.25 + w.energy / 4000, 0.3, 1));
        const face = struckFace(w, b, c);
        internal(m, b, face, w.energy * 1.2, { by: a.idx });
        a.stat.dmg += w.energy * 1.2; a.stat.hits++; a.lastHitT = m.t;
        emit(m, 'hit', { to: b.idx, by: a.idx, face, kind: 'arc', dmg: w.energy * 1.2, x: c.x, y: c.y });
        return;
      }
      if (!c) return;
      const face = struckFace(w, b, c), src = { by: a.idx, kind: w.effect, x: c.x, y: c.y };
      if (w.effect === 'hammer') { damage(m, b.idx, face, w.energy * w.pierce, src); b.stun = Math.max(b.stun, 0.12); }
      else if (w.effect === 'punch') { damage(m, b.idx, face, w.energy * w.pierce, src); knock(m, a, b, w.energy, 0); }
      else if (w.effect === 'flip') {
        damage(m, b.idx, face, w.energy * 0.25, src);
        knock(m, a, b, w.energy * 0.6, 0); b.air = Math.max(b.air, 0.9);
        if (rand(m) < 0.7) flip(m, b, a.idx);
      } else if (w.effect === 'lift') {
        damage(m, b.idx, face, w.energy, src);
        b.air = Math.max(b.air, 1.0); a.stat.ctrl += 2;
        if (rand(m) < w.throwP) flip(m, b, a.idx);
      }
    }

    function updateWeapons(m, i, inp, dt) {
      const a = m.bots[i], b = m.bots[1 - i], sp = a.spec;
      for (let wi = 0; wi < sp.weapons.length; wi++) {
        const w = sp.weapons[wi], ws = a.w[wi];
        const alive = !ws.dead && a.power && !a.out;
        const held = alive && (!!inp.fire[w.slot] || (inp.primary && wi === sp.primary));
        const pressed = held && !ws.prev;
        ws.prev = held;
        ws.cd = Math.max(0, ws.cd - dt);
        if (w.mode !== 'spin') ws.anim = Math.max(0, ws.anim - dt * 3);
        if (w.mode === 'spin') {
          if (pressed) ws.on = !ws.on;
          // exponential approach matches the shape of the model's spin-up curve (t90 = 2.3 time constants)
          if (alive && ws.on) ws.spin += ((1 - ws.spin) * dt) / w.tau; else ws.spin = Math.max(0, ws.spin - dt / 3);
          ws.ang += ws.spin * 38 * dt;
          if (w.style === 'melty') a.bodyAng += ws.spin * 16 * dt;
          if (ws.cd <= 0 && ws.spin > 0.08 && !b.out) {
            const c = zoneContact(a, w, b);
            if (c) {
              const E = w.energy * ws.spin * ws.spin;
              ws.spin *= 0.45; ws.cd = 0.4;   // the rotor gives up most of its energy and has to spin back up
              damage(m, b.idx, struckFace(w, b, c), E * 0.5 * w.pierce, { by: i, kind: 'spin', x: c.x, y: c.y });
              if (!w.overhead) knock(m, a, b, E, w.vertical ? 0 : 1);
              if (w.vertical) {
                b.air = Math.max(b.air, clamp(E / 25000, 0.12, 0.9));
                if (rand(m) < clamp((E * 0.5) / 150000, 0.02, 0.12)) flip(m, b, i);
              }
            }
          }
        } else if (w.mode === 'trigger') {
          if (held && ws.cd <= 0 && ws.shots > 0) fireTrigger(m, a, b, w, ws, wi);
        } else if (w.mode === 'channel') {
          if (held && ws.cd <= 0 && ws.act <= 0) { ws.act = w.dur; ws.cd = w.cycle; ws.acc = 0; ws.tick = 0.3; emit(m, 'fire', { by: i, w: wi, x: a.x, y: a.y }); }
          if (ws.act > 0) {
            ws.act = alive ? Math.max(0, ws.act - dt) : 0;
            ws.anim = 1 - ws.act / w.dur;
            const c = alive && !b.out ? zoneContact(a, w, b) : null;
            if (c) {
              b.held = Math.max(b.held, 0.15); ws.acc += w.dps * dt; ws.tick -= dt;
              if (ws.tick <= 0 || ws.act <= 0) { damage(m, b.idx, struckFace(w, b, c), ws.acc, { by: i, kind: 'crush', x: c.x, y: c.y }); ws.acc = 0; ws.tick = 0.3; }
            } else if (ws.act < w.dur - 0.3) ws.act = 0;   // jaws closed on nothing: reopen
          }
        } else if (w.mode === 'hold') {
          const on = held && ws.fuel > 0;
          ws.act = on ? 1 : 0;
          if (on) {
            ws.fuel -= dt;
            const c = b.out ? null : zoneContact(a, w, b);
            if (c) {
              const face = struckFace(w, b, c);
              ws.acc += w.dps * dt * (b.spec.armour[face].burns ? 2.5 : 1); ws.tick -= dt;   // polymer and laminate plates burn
              if (ws.tick <= 0) { damage(m, b.idx, face, ws.acc, { by: i, kind: 'flame', x: c.x, y: c.y }); ws.acc = 0; ws.tick = 0.3; }
            }
          }
        }
      }
    }

    function updateProjectiles(m, dt) {
      for (let k = m.proj.length - 1; k >= 0; k--) {
        const p = m.proj[k], b = m.bots[1 - p.by], a = m.bots[p.by];
        let done = false;
        // sub-step so a fast round cannot tunnel through a hull
        for (let s = 0; s < 3 && !done; s++) {
          p.x += (p.vx * dt) / 3; p.y += (p.vy * dt) / 3;
          const l = toLocal(b, p.x, p.y);
          if (!b.out && pointInPoly(b.spec.hull, l.x, l.z)) {
            done = true;
            if (p.kind === 'net') { b.slow = Math.max(b.slow, 4); a.stat.ctrl += 3; emit(m, 'net', { to: b.idx, x: p.x, y: p.y, text: `${b.spec.name} IS TANGLED` }); } else {
              damage(m, b.idx, faceAt(b.spec, l.x, l.z), p.E * p.pierce, { by: p.by, kind: 'shot', x: p.x, y: p.y });
              if (p.kind === 'harpoon') { const d = Math.hypot(a.x - b.x, a.y - b.y) || 1; b.vx += ((a.x - b.x) / d) * 3; b.vy += ((a.y - b.y) / d) * 3; a.stat.ctrl += 2; }
            }
          } else if (Math.abs(p.x) > ARENA || Math.abs(p.y) > ARENA) { done = true; emit(m, 'spark', { x: clamp(p.x, -ARENA, ARENA), y: clamp(p.y, -ARENA, ARENA) }); }
        }
        p.life -= dt;
        if (done || p.life <= 0) m.proj.splice(k, 1);
      }
    }

    // ---- driving ------------------------------------------------------------------------------------
    const stranded = (b) => b.inv && !b.spec.invertible;
    const immobile = (b) => b.out || !b.power || (b.sub.driveL <= 0 && b.sub.driveR <= 0) || stranded(b);

    function updateBot(m, b, inp, dt) {
      const sp = b.spec;
      for (const k of ['air', 'stun', 'slow', 'held', 'slip']) if (b[k] > 0) b[k] = Math.max(0, b[k] - dt);
      for (const k in b.cd) b.cd[k] = Math.max(0, b.cd[k] - dt);
      if (b.out) return;
      if (b.fire > 0) {
        b.fire = Math.max(0, b.fire - dt); b.fireTick -= dt;
        if (b.fireTick <= 0) { b.fireTick = 0.5; damage(m, b.idx, 'top', 900, { by: b.fireBy, kind: 'fire', x: b.x, y: b.y, quiet: true }); }
        if (b.fire <= FIRE_S - 6 && b.power) { b.power = false; emit(m, 'disable', { to: b.idx, x: b.x, y: b.y, text: `${sp.name}: POWER LOST` }); }
      }
      // self-righting: a dedicated arm takes a moment; a flipper can do it with a shot of gas
      if (stranded(b) && b.air <= 0 && b.power) {
        const arm = b.w.findIndex((ws, k) => !ws.dead && (sp.weapons[k].selfRight || (sp.weapons[k].effect === 'flip' && ws.shots > 0)));
        if (arm >= 0) {
          b.righting += dt;
          if (b.righting >= (sp.weapons[arm].selfRight ? 1.6 : 0.8)) {
            if (sp.weapons[arm].effect === 'flip') b.w[arm].shots--;
            b.w[arm].anim = 1; b.inv = false; b.righting = 0; b.air = 0.35;
            emit(m, 'right', { to: b.idx, x: b.x, y: b.y, text: `${sp.name} SELF-RIGHTS` });
          }
        }
      } else b.righting = 0;

      const c = Math.cos(b.th), s = Math.sin(b.th);
      let vf = b.vx * c + b.vy * s, vs = -b.vx * s + b.vy * c;
      if (b.air <= 0) {
        const canDrive = b.power && b.stun <= 0 && b.held <= 0 && !stranded(b);
        let l = clamp(inp.throttle + inp.turn, -1, 1), r = clamp(inp.throttle - inp.turn, -1, 1);
        if (b.sub.driveL <= 0) l = 0;
        if (b.sub.driveR <= 0) r = 0;
        const scale = (b.slow > 0 ? 0.45 : 1) * (b.slip > 0 ? 0.4 : 1);
        // a vertical rotor at speed lifts a wheel if the bot is yawed too fast (the model's gyro turn limit)
        let turnRate = sp.turnRate;
        sp.weapons.forEach((w, k) => { if (w.vertical && b.w[k].spin > 0.2) turnRate = Math.min(turnRate, Math.max(1.5, sp.gyroLimit / (b.w[k].spin * b.w[k].spin))); });
        if (canDrive) {
          vf = approach(vf, ((l + r) / 2) * sp.topSpeed * scale, sp.accel * dt);
          vs = approach(vs, sp.strafe ? inp.strafe * sp.topSpeed * 0.7 * scale : 0, (sp.strafe ? sp.accel : 14) * dt);
          b.om = approach(b.om, ((l - r) / 2) * turnRate, 30 * dt);
        } else { vf = approach(vf, 0, 5 * dt); vs = approach(vs, 0, 6 * dt); b.om = approach(b.om, 0, 8 * dt); }
      } else { vf *= 1 - 0.4 * dt; vs *= 1 - 0.4 * dt; b.om *= 1 - 0.5 * dt; }
      b.vx = vf * c - vs * s; b.vy = vf * s + vs * c;
      b.x += b.vx * dt; b.y += b.vy * dt; b.th = wrap(b.th + b.om * dt);
    }

    // what is bolted to the face of `b` that touches the other bot (ram spikes hurt, plows deflect, wedges get under)
    const faceGear = (b, face) => b.spec.weapons.find((w, k) => w.slot === face && w.mode === 'passive' && !b.w[k].dead) || null;

    function collideBots(m, dt) {
      const a = m.bots[0], b = m.bots[1];
      if (a.out || b.out) return;
      if (Math.hypot(a.x - b.x, a.y - b.y) > a.spec.radius + b.spec.radius) return;
      const hit = sat(hullWorld(a), hullWorld(b), a, b);
      if (!hit) return;
      const ma = a.spec.mass, mb = b.spec.mass, { nx, ny } = hit;
      a.x -= (nx * hit.depth * mb) / (ma + mb); a.y -= (ny * hit.depth * mb) / (ma + mb);
      b.x += (nx * hit.depth * ma) / (ma + mb); b.y += (ny * hit.depth * ma) / (ma + mb);
      a.lastTouchT = b.lastTouchT = m.t;
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const la = toLocal(a, cx, cy), lb = toLocal(b, cx, cy), fa = faceAt(a.spec, la.x, la.z), fb = faceAt(b.spec, lb.x, lb.z);
      const ga = faceGear(a, fa), gb = faceGear(b, fb);
      const vrel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (vrel < 0) {
        const j = (-(1 + 0.25) * vrel) / (1 / ma + 1 / mb);
        a.vx -= (j / ma) * nx; a.vy -= (j / ma) * ny; b.vx += (j / mb) * nx; b.vy += (j / mb) * ny;
        const E = 0.5 * ((ma * mb) / (ma + mb)) * vrel * vrel;
        if (E > 150) {
          damage(m, 1, fb, E * 0.6 * (ga ? ga.ram : 1) * (gb ? gb.deflect : 1), { by: 0, kind: 'ram', x: cx, y: cy });
          damage(m, 0, fa, E * 0.6 * (gb ? gb.ram : 1) * (ga ? ga.deflect : 1), { by: 1, kind: 'ram', x: cx, y: cy });
        }
      }
      // a wedge, fork set or sloped nose gets under the other bot and takes weight off its wheels
      const under = (bot, face, gear) => (gear && gear.wedge) || (face === 'front' && bot.spec.nose > 0);
      if (under(a, fa, ga) && !under(b, fb, gb)) b.slip = Math.max(b.slip, 0.3);
      if (under(b, fb, gb) && !under(a, fa, ga)) a.slip = Math.max(a.slip, 0.3);
      // control: whoever is moving the pair in their own direction is winning the shove
      const push = ((a.vx + b.vx) / 2) * nx + ((a.vy + b.vy) / 2) * ny;
      if (push > 0.3) a.stat.ctrl += dt; else if (push < -0.3) b.stat.ctrl += dt;
    }

    function collideWalls(m, b) {
      if (b.out) return;
      for (const v of hullWorld(b)) {
        for (const ax of ['x', 'y']) {
          const p = ax === 'x' ? v[0] : v[1], over = Math.abs(p) - ARENA;
          if (over <= 0) continue;
          const sgn = Math.sign(p), vk = ax === 'x' ? 'vx' : 'vy';
          b[ax] -= sgn * over;
          if (b[vk] * sgn > 0) {
            const sp = b[vk] * sgn;
            if (sp > 2.5 && b.cd.wall <= 0) {
              b.cd.wall = 0.4;
              const l = toLocal(b, v[0], v[1]);
              damage(m, b.idx, faceAt(b.spec, l.x, l.z), 0.5 * b.spec.mass * sp * sp * 0.4, { by: m.t - b.lastTouchT < 1 ? 1 - b.idx : -1, hazard: true, kind: 'wall', x: v[0] - (ax === 'x' ? sgn * over : 0), y: v[1] - (ax === 'y' ? sgn * over : 0) });
            }
            b[vk] = -b[vk] * 0.3;
          }
        }
      }
    }

    // ---- hazards ------------------------------------------------------------------------------------
    function updateHazards(m, dt) {
      const hz = m.hz;
      for (const s of hz.saws) { const p = (m.t + s.phase) % 8; s.up = p < 3 ? clamp(p / 0.3, 0, 1) * clamp((3 - p) / 0.3, 0, 1) : 0; }
      for (const f of hz.flames) { const p = (m.t + f.phase) % 7; f.on = p < 1.6 ? 1 : 0; }
      if (hz.pulv) { hz.pulv.cd = Math.max(0, hz.pulv.cd - dt); hz.pulv.anim = Math.max(0, hz.pulv.anim - dt * 2.5); }
      if (hz.pit) {
        const was = hz.pit.open;
        hz.pit.open = clamp((m.t - hz.pit.openAt) / 1.5, 0, 1);
        if (!was && hz.pit.open) emit(m, 'pitopen', { x: hz.pit.x, y: hz.pit.y, text: 'THE PIT IS OPEN' });
      }
      for (const b of m.bots) {
        if (b.out) continue;
        // a bot shoved into a hazard counts for whoever was just in contact with it
        const by = m.t - b.lastTouchT < 1 ? 1 - b.idx : -1;
        const src = (kind, x, y) => { if (by >= 0) m.bots[by].stat.ctrl += 3; return { by, hazard: true, kind, x, y }; };
        const inHull = (x, y) => { const l = toLocal(b, x, y); return pointInPoly(b.spec.hull, l.x, l.z) ? l : null; };
        for (const s of hz.saws) {
          if (s.up < 0.6 || b.cd.saw > 0 || b.air > 0) continue;
          for (let k = 0; k < 5; k++) {
            const y = s.y + (k / 4 - 0.5) * s.len, l = inHull(s.x, y);
            if (!l) continue;
            b.cd.saw = 0.6;
            damage(m, b.idx, faceAt(b.spec, l.x, l.z), 7000, src('saw', s.x, y));
            const d = Math.hypot(b.x - s.x, b.y - s.y) || 1;
            b.vx += ((b.x - s.x) / d) * 3; b.vy += ((b.y - s.y) / d) * 3 - 1; b.om += (rand(m) - 0.5) * 6; b.air = Math.max(b.air, 0.3);
            break;
          }
        }
        const pv = hz.pulv;
        if (pv && pv.cd <= 0 && Math.hypot(b.x - pv.x, b.y - pv.y) < pv.r + b.spec.radius * 0.5) {
          pv.cd = 1.6; pv.anim = 1; b.stun = Math.max(b.stun, 0.3);
          damage(m, b.idx, 'top', 9000, src('pulverizer', b.x, b.y));
        }
        const sc = hz.screws;
        if (sc && b.cd.grind <= 0 && b.x > sc.x0 && b.x < sc.x1) {
          let low = null;
          for (const v of hullWorld(b)) if (v[1] > sc.y && (!low || v[1] > low[1])) low = v;
          if (low) {
            b.cd.grind = 0.33; b.vx += 0.8;   // the screws drag the bot along the wall
            const l = toLocal(b, low[0], low[1]);
            damage(m, b.idx, faceAt(b.spec, l.x, l.z), 1100, src('screws', low[0], low[1]));
          }
        }
        for (const f of hz.flames) {
          if (!f.on || b.cd.burn > 0) continue;
          const l = inHull(f.x, f.y);
          if (l) { b.cd.burn = 0.33; const face = faceAt(b.spec, l.x, l.z); damage(m, b.idx, face, 1200 * (b.spec.armour[face].burns ? 2.5 : 1), src('flame', f.x, f.y)); }
        }
        const pit = hz.pit;
        if (pit && pit.open > 0.6 && b.air <= 0 && Math.abs(b.x - pit.x) < pit.h && Math.abs(b.y - pit.y) < pit.h) {
          b.out = true; b.ko = true; b.vx = b.vy = b.om = 0; b.x = pit.x; b.y = pit.y;
          if (by >= 0) m.bots[by].stat.ctrl += 10;
          emit(m, 'pit', { to: b.idx, x: pit.x, y: pit.y, text: `${b.spec.name} IS IN THE PIT` });
        }
      }
    }
    // active danger areas as circles, for the AI
    function dangerZones(m) {
      const z = [], hz = m.hz;
      for (const s of hz.saws) { const p = (m.t + s.phase) % 8; if (p < 3.2 || p > 7.2) z.push({ x: s.x, y: s.y, r: 0.7 }); }
      for (const f of hz.flames) { const p = (m.t + f.phase) % 7; if (p < 1.8 || p > 6.4) z.push({ x: f.x, y: f.y, r: 0.45 }); }
      if (hz.pulv) z.push({ x: hz.pulv.x, y: hz.pulv.y, r: hz.pulv.r + 0.2 });
      if (hz.pit && m.t > hz.pit.openAt - 2) z.push({ x: hz.pit.x, y: hz.pit.y, r: hz.pit.h * 1.3 });
      return z;
    }

    // ---- AI -----------------------------------------------------------------------------------------
    // tank steering toward a point; mode 'fwd' | 'rev' | 'any' (whichever end is nearer to pointing there)
    function steerTo(me, gx, gy, speed, mode) {
      const d = Math.hypot(gx - me.x, gy - me.y), ang = Math.atan2(gy - me.y, gx - me.x);
      const fe = wrap(ang - me.th), re = wrap(ang + Math.PI - me.th);
      const rev = mode === 'rev' || (mode === 'any' && Math.abs(re) < Math.abs(fe)), err = rev ? re : fe;
      return { throttle: (rev ? -1 : 1) * speed * clamp(d * 1.6, 0, 1) * Math.max(0, Math.cos(err)), turn: clamp(err * 2.2, -1, 1) };
    }
    // hold the trigger of every weapon that would connect right now (also used for the player's AUTO-FIRE)
    function autoFire(m, i, lag, dt) {
      const me = m.bots[i], foe = m.bots[1 - i], fire = {};
      me.spec.weapons.forEach((w, k) => {
        const ws = me.w[k];
        if (ws.dead || w.mode === 'passive') return;
        if (w.mode === 'spin') { if (!ws.on && !ws.prev) fire[w.slot] = true; return; }
        const ready = !foe.out && !foe.ko && (w.mode !== 'trigger' || ws.shots > 0) && zoneContact(me, w, foe);
        ws.lag = ready ? ws.lag + dt : 0;
        if (ready && ws.lag >= lag) fire[w.slot] = true;
      });
      return fire;
    }
    function pickWeapon(me) {
      let best = -1;
      me.spec.weapons.forEach((w, k) => {
        const ws = me.w[k];
        if (ws.dead || w.mode === 'passive' || (w.mode === 'trigger' && ws.shots <= 0) || (w.mode === 'hold' && ws.fuel <= 0)) return;
        if (best < 0 || w.threat > me.spec.weapons[best].threat) best = k;
      });
      return best;
    }
    // slow path: pick a state and a goal a few times a second (the reaction time is the difficulty)
    function aiDecide(m, i) {
      const ai = m.ai[i], me = m.bots[i], foe = m.bots[1 - i], D = LEVELS[ai.level], sp = me.spec;
      const dist = Math.hypot(foe.x - me.x, foe.y - me.y);
      const moved = Math.hypot(me.x - ai.lx, me.y - ai.ly);
      ai.lx = me.x; ai.ly = me.y;
      ai.weapon = pickWeapon(me);
      const w = ai.weapon >= 0 ? sp.weapons[ai.weapon] : null, ws = w ? me.w[ai.weapon] : null;
      const lim = ARENA - sp.radius - 0.15;
      const setGoal = (x, y) => { ai.goalX = clamp(x, -lim, lim); ai.goalY = clamp(y, -lim, D.hazard && m.hz.screws ? Math.min(lim, m.hz.screws.y - sp.radius) : lim); };
      const away = (px, py, d) => { const q = Math.hypot(me.x - px, me.y - py) || 1; setGoal(me.x + ((me.x - px) / q) * d, me.y + ((me.y - py) / q) * d); };

      if (stranded(me)) { ai.state = 'recover'; return; }
      const zones = D.hazard ? dangerZones(m) : [];
      const danger = zones.find((z) => Math.hypot(me.x - z.x, me.y - z.y) < z.r + sp.radius * 0.8);
      if (danger) { ai.state = 'evade'; ai.until = m.t + 0.3; away(danger.x, danger.y, 1.6); return; }
      if (m.t < ai.until) return;
      // nothing has moved and nothing has been hit for a while: back out and try another angle
      const trying = ai.state === 'approach' || ai.state === 'attack' || ai.state === 'push';
      ai.stuckT = trying && moved < 0.03 && m.t - me.lastHitT > 1.5 ? ai.stuckT + D.react : 0;
      if (ai.stuckT > 1.2) { ai.state = 'unstick'; ai.until = m.t + 0.7; ai.stuckT = 0; ai.side = rand(m) < 0.5 ? -1 : 1; return; }
      // a foe that cannot move is left for the count by a rookie; better drivers keep hitting it
      if (immobile(foe) && !D.hazard) { ai.state = 'idle'; return; }

      if (w && w.mode === 'spin') {
        if (ws.spin >= D.spinMin || m.t - me.lastHitT < 0.3) { ai.spinT = 0; ai.commit = false; }
        // just landed a hit and the rotor is slow: back off to spin up again (veterans and up)
        if (D.hazard && m.t - me.lastHitT < D.react + 0.05 && ws.spin < D.spinMin * 0.7) { ai.state = 'retreat'; ai.until = m.t + Math.min(1.2, w.tau); away(foe.x, foe.y, 2.2); return; }
        if (ws.spin < D.spinMin && !ai.commit) {
          ai.spinT += D.react;
          if (ai.spinT > D.patience) ai.commit = true;   // cannot wait for ever on a slow rotor
          else { ai.state = 'spinup'; if (dist < 3) away(foe.x, foe.y, 2); else setGoal(me.x, me.y); return; }
        }
      }
      // a champion with nothing left to hit with shoves the foe toward the nearest live hazard
      if (!w && D.smart && zones.length) {
        const z = zones.reduce((p, q) => (Math.hypot(q.x - foe.x, q.y - foe.y) < Math.hypot(p.x - foe.x, p.y - foe.y) ? q : p));
        const q = Math.hypot(foe.x - z.x, foe.y - z.y) || 1;
        ai.state = 'push'; setGoal(foe.x + ((foe.x - z.x) / q) * 0.9, foe.y + ((foe.y - z.y) / q) * 0.9); return;
      }
      const reach = w ? w.reach : sp.zF, standoff = reach + foe.spec.radius * 0.55;
      const aim = w ? w.aim : 0, aimErr = w && w.omni ? 0 : wrap(Math.atan2(foe.y - me.y, foe.x - me.x) - me.th - aim);
      if (dist > standoff + 1.2) {
        ai.state = 'approach';
        let gx = foe.x, gy = foe.y;
        if (D.smart) {
          // go for the weakest plate that is not the top
          let weak = 'front';
          for (const f of ['left', 'right', 'rear']) if (foe.hp[f] / foe.spec.armour[f].hp < foe.hp[weak] / foe.spec.armour[weak].hp - 0.15) weak = f;
          const off = weak === 'front' ? [0, 1] : weak === 'rear' ? [0, -1] : weak === 'left' ? [-1, 0] : [1, 0];
          const p = toWorld(foe, off[0] * standoff, off[1] * standoff);
          gx = p.x; gy = p.y;
        }
        // skirt round a live hazard that lies on the straight line to the goal
        for (const z of zones) {
          const ex = gx - me.x, ey = gy - me.y, L = Math.hypot(ex, ey) || 1, u = clamp(((z.x - me.x) * ex + (z.y - me.y) * ey) / (L * L), 0, 1);
          const px = me.x + ex * u, py = me.y + ey * u, d = Math.hypot(px - z.x, py - z.y), clear = z.r + sp.radius + 0.3;
          if (d < clear && u > 0.05 && u < 0.95) { const q = d || 1; gx = z.x + ((px - z.x) / q) * (clear + 0.4); gy = z.y + ((py - z.y) / q) * (clear + 0.4); break; }
        }
        setGoal(gx, gy);
      } else if (Math.abs(aimErr) > D.aimTol) ai.state = 'lineup';
      else ai.state = 'attack';
    }
    // fast path: turn the current state into stick inputs every step
    function aiInput(m, i, dt) {
      const ai = m.ai[i], me = m.bots[i], foe = m.bots[1 - i], D = LEVELS[ai.level], sp = me.spec;
      ai.timer -= dt;
      if (ai.timer <= 0) { ai.timer = D.react; aiDecide(m, i); }
      const out = { throttle: 0, turn: 0, strafe: 0, primary: false, fire: autoFire(m, i, D.fireLag, dt) };
      const w = ai.weapon >= 0 ? sp.weapons[ai.weapon] : null;
      const aim = w ? w.aim : 0, side = Math.abs(aim) > Math.PI / 4 && Math.abs(aim) < (3 * Math.PI) / 4, rear = Math.abs(aim) >= (3 * Math.PI) / 4;
      const toFoe = Math.atan2(foe.y - me.y, foe.x - me.x), faceErr = w && w.omni ? 0 : wrap(toFoe - me.th - aim);
      const drive = (s) => { out.throttle = s.throttle; out.turn = s.turn; };
      if (ai.state === 'evade' || ai.state === 'retreat') drive(steerTo(me, ai.goalX, ai.goalY, D.speed, 'any'));
      else if (ai.state === 'spinup') {
        if (Math.hypot(ai.goalX - me.x, ai.goalY - me.y) > 0.3) drive(steerTo(me, ai.goalX, ai.goalY, D.speed, rear ? 'fwd' : 'rev')); else out.turn = clamp(faceErr * 2.2, -1, 1);
      } else if (ai.state === 'approach' || ai.state === 'push') drive(steerTo(me, ai.goalX, ai.goalY, D.speed, rear ? 'rev' : 'fwd'));
      else if (ai.state === 'lineup') out.turn = clamp(faceErr * 2.5, -1, 1);
      else if (ai.state === 'attack') {
        out.turn = clamp(faceErr * 2.5, -1, 1);
        if (side) out.strafe = Math.sign(aim) * D.speed; else out.throttle = (rear ? -1 : 1) * D.speed;
      } else if (ai.state === 'unstick') { out.throttle = (rear ? 1 : -1) * 0.8; out.turn = ai.side * 0.7; }
      return out;
    }

    // ---- stepping, scoring, recording ----------------------------------------------------------------
    function playerInput(m, input, dt) {
      const out = { throttle: clamp(num(input.throttle, 0), -1, 1), turn: clamp(num(input.turn, 0), -1, 1), strafe: clamp(num(input.strafe, 0), -1, 1), primary: !!input.primary, fire: Object.assign({}, input.fire) };
      const me = m.bots[0];
      // mouse driving: head for the pointer, stop when on top of it
      if (input.target && Number.isFinite(input.target.x) && Number.isFinite(input.target.y) && Math.hypot(input.target.x - me.x, input.target.y - me.y) > 0.25) Object.assign(out, steerTo(me, input.target.x, input.target.y, 1, 'fwd'));
      if (input.autoFire) Object.assign(out.fire, autoFire(m, 0, 0, dt));
      return out;
    }

    function snap(m) {
      return {
        t: m.t,
        bots: m.bots.map((b) => ({
          x: b.x, y: b.y, th: b.th, body: b.bodyAng, inv: b.inv, air: b.air, stun: b.stun, slow: b.slow, held: b.held, fire: b.fire, power: b.power, out: b.out, ko: b.ko,
          count: b.count, righting: b.righting, speed: Math.hypot(b.vx, b.vy),
          hp: FACES.map((f) => b.hp[f] / b.spec.armour[f].hp), sub: [b.sub.driveL > 0, b.sub.driveR > 0, b.sub.battery > 0],
          w: b.w.map((ws) => ({ spin: ws.spin, on: ws.on, anim: ws.anim, act: ws.act, ang: ws.ang, shots: ws.shots, fuel: ws.fuel, cd: ws.cd, dead: ws.dead })),
        })),
        proj: m.proj.map((p) => ({ x: p.x, y: p.y, vx: p.vx, vy: p.vy, kind: p.kind })),
        hz: { saws: m.hz.saws.map((s) => s.up), flames: m.hz.flames.map((f) => f.on), pulv: m.hz.pulv ? m.hz.pulv.anim : 0, pit: m.hz.pit ? m.hz.pit.open : 0 },
        ai: m.ai[1].state,
      };
    }

    /** Advance the match by dt. `input` is the player's sticks; pass null to let the AI drive the player too. */
    function stepMatch(m, dt, input) {
      if (m.over) return m;
      dt = clamp(num(dt, STEP), 0.001, 0.05);
      const ins = [input ? playerInput(m, input, dt) : aiInput(m, 0, dt), aiInput(m, 1, dt)];
      m.t += dt; m.steps++;
      for (const b of m.bots) updateBot(m, b, ins[b.idx], dt);
      updateWeapons(m, 0, ins[0], dt); updateWeapons(m, 1, ins[1], dt);
      updateProjectiles(m, dt);
      collideBots(m, dt);
      for (const b of m.bots) collideWalls(m, b);
      updateHazards(m, dt);
      for (const b of m.bots) {
        const foe = m.bots[1 - b.idx];
        // aggression: closing on the opponent under power; control: the opponent cannot do what it wants
        const d = Math.hypot(foe.x - b.x, foe.y - b.y) || 1, closing = (b.vx * (foe.x - b.x) + b.vy * (foe.y - b.y)) / d;
        if (closing > 0.5 && !immobile(b)) b.stat.aggr += dt * (d < 2.5 ? 2 : 1);
        if (m.t - b.lastHitT < 0.5) b.stat.aggr += dt * 2;
        if (!foe.out && (foe.held > 0 || foe.stun > 0 || foe.air > 0 || stranded(foe) || foe.slip > 0)) b.stat.ctrl += dt * 2;
        if (!b.ko) { b.count = immobile(b) ? b.count + dt : 0; if (b.count >= KO_COUNT) { b.ko = true; emit(m, 'ko', { to: b.idx, x: b.x, y: b.y, text: `${b.spec.name} IS COUNTED OUT` }); } }
      }
      if (m.bots[0].ko || m.bots[1].ko || m.t >= m.limit) { m.over = true; m.result = judge(m); }
      if (m.over || m.steps % REC_EVERY === 0) m.frames.push(snap(m));
      return m;
    }

    /** Three judges each split 5 damage + 3 aggression + 3 control points between the bots. */
    function judge(m) {
      const s = m.bots.map((b) => b.stat);
      const metric = {
        damage: s.map((q, i) => q.dmg + 6000 * q.breaches + 9000 * q.disables + (stranded(m.bots[1 - i]) ? 15000 : 0)),
        aggression: s.map((q) => q.aggr), control: s.map((q) => q.ctrl),
      };
      const CATS = [['damage', 5], ['aggression', 3], ['control', 3]];
      const votes = [0, 0];
      const judges = [0, 1, 2].map((j) => {
        const scores = {}, total = [0, 0];
        CATS.forEach(([cat, max], c) => {
          const a = metric[cat][0], b = metric[cat][1];
          // each judge sees the fight slightly differently, but the same way every time for a given seed
          const share = clamp((a + b > 0 ? a / (a + b) : 0.5) + (hash01(m.seed0, j * 16 + c) - 0.5) * 0.14, 0, 1);
          const pa = Math.round(share * max);
          scores[cat] = [pa, max - pa]; total[0] += pa; total[1] += max - pa;
        });
        const vote = total[0] !== total[1] ? (total[0] > total[1] ? 0 : 1) : metric.damage[0] >= metric.damage[1] ? 0 : 1;
        votes[vote]++;
        return { name: `JUDGE ${j + 1}`, scores, total, vote };
      });
      const ko = m.bots.map((b) => b.ko);
      const byKo = ko[0] !== ko[1];
      const winner = byKo ? (ko[0] ? 1 : 0) : votes[0] > votes[1] ? 0 : 1;
      return {
        method: byKo ? 'KO' : 'JD', winner, votes, split: `${Math.max(votes[0], votes[1])}-${Math.min(votes[0], votes[1])}`, judges, time: m.t,
        doubleKo: ko[0] && ko[1], stats: s.map((q) => ({ damage: q.dmg, hits: q.hits, biggest: q.big, flips: q.flips, breaches: q.breaches, disables: q.disables })),
      };
    }

    return { createMatch, stepMatch, judge, botSpec, snap, ARENA, STEP, MATCH_S, KO_COUNT, REC_EVERY, FACES, SLOTS, LEVELS, clamp, wrap, hash01 };
  })();

  if (IS_NODE) module.exports = ArenaCore;

  // ===========================================================================
  // PART 2 — BROWSER: 2D RENDERER, HUD, REPLAY
  // ===========================================================================
  if (typeof document !== 'undefined') {
    const C = ArenaCore, ARENA = C.ARENA, STEP = C.STEP, clamp = C.clamp;
    // the overlay is a fixed 1600 x 900 stage scaled to the window, like the main app
    const STAGE_W = 1600, STAGE_H = 900, AX = 395, AY = 80, AS = 810, PX = AS / (2 * ARENA);
    const sx = (x) => AX + (x + ARENA) * PX, sy = (y) => AY + (y + ARENA) * PX;
    const TAU = Math.PI * 2;
    const FACE_NAMES = ['FRONT', 'LEFT', 'RIGHT', 'REAR', 'TOP'];
    const SIDE_COLORS = ['#ff5a1f', '#3aa0ff'];
    const HAZARDS = [['saws', 'KILL SAWS'], ['pulverizer', 'PULVERIZER'], ['screws', 'WALL SCREWS'], ['flames', 'FLAME JETS'], ['pit', 'PIT (OPENS AT 1:30)']];
    const AI_LABEL = { approach: 'CLOSING IN', lineup: 'LINING UP', attack: 'ATTACKING', spinup: 'SPINNING UP', retreat: 'BACKING OFF', evade: 'AVOIDING HAZARD', recover: 'STRANDED', unstick: 'BREAKING FREE', push: 'SHOVING', idle: 'WAITING FOR THE COUNT' };
    const STEEL = '#aab0b8', STEEL_DARK = '#3b4048', STEEL_LIGHT = '#dde1e6';
    let ui = null;

    // ---- small helpers ------------------------------------------------------------------------------
    const frac = (v) => v - Math.floor(v);
    const hash = (a, b) => C.hash01(a, b);
    const rgb = (hex) => { const n = parseInt(String(hex).slice(1), 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
    // f < 1 darkens toward black, f > 1 lightens toward white
    const shade = (hex, f) => { const c = rgb(hex).map((v) => Math.round(clamp(f <= 1 ? v * f : v + (255 - v) * (f - 1), 0, 255))); return `rgb(${c[0]},${c[1]},${c[2]})`; };
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const scaled = (str, k) => { const ph = PH(); return ph && ph.scaleText ? ph.scaleText(str, k) : str; };
    const clock = (t) => { const s = Math.max(0, Math.ceil(t - 1e-6)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    const makeCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
    // bot-frame points are [x, z]; on the canvas the bot is drawn with +z along canvas x, so a plain rotate(th) orients it
    const trace = (ctx, pts) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[1], p[0]) : ctx.moveTo(p[1], p[0]))); ctx.closePath(); };
    const box = (ctx, a0, b0, a1, b1, fill) => { ctx.fillStyle = fill; ctx.fillRect(a0, b0, a1 - a0, b1 - b0); };
    const disc = (ctx, a, b, r, fill) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(a, b, Math.max(0, r), 0, TAU); ctx.fill(); };
    const line = (ctx, a0, b0, a1, b1, w, stroke) => { ctx.strokeStyle = stroke; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(a0, b0); ctx.lineTo(a1, b1); ctx.stroke(); };

    function insetPoly(pts, d) {
      const n = pts.length;
      let area = 0;
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; area += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]; }
      const sg = area > 0 ? 1 : -1;
      return pts.map((p, i) => {
        const a = pts[(i + n - 1) % n], b = pts[(i + 1) % n];
        const l1 = Math.hypot(p[0] - a[0], p[1] - a[1]) || 1, l2 = Math.hypot(b[0] - p[0], b[1] - p[1]) || 1;
        const n1 = [(-(p[1] - a[1]) / l1) * sg, ((p[0] - a[0]) / l1) * sg], n2 = [(-(b[1] - p[1]) / l2) * sg, ((b[0] - p[0]) / l2) * sg];
        let bx = n1[0] + n2[0], bz = n1[1] + n2[1];
        const bl = Math.hypot(bx, bz) || 1; bx /= bl; bz /= bl;
        const k = d / Math.max(0.35, bx * n1[0] + bz * n1[1]);
        return [p[0] + bx * k, p[1] + bz * k];
      });
    }

    // ---- static arena art (drawn once per match) ------------------------------------------------------
    function buildFloor(hz) {
      const cv = makeCanvas(STAGE_W, STAGE_H), g = cv.getContext('2d');
      const bg = g.createRadialGradient(800, 470, 200, 800, 470, 1000);
      bg.addColorStop(0, '#14171c'); bg.addColorStop(1, '#050608');
      g.fillStyle = bg; g.fillRect(0, 0, STAGE_W, STAGE_H);
      // steel floor: 2 m plates, each a slightly different tone, with seams and bolt rows
      const plate = PX * 2;
      for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
        const v = 38 + Math.round(hash(i * 7 + 1, j * 13 + 5) * 12);
        g.fillStyle = `rgb(${v},${v + 3},${v + 8})`;
        g.fillRect(AX + i * plate, AY + j * plate, plate, plate);
      }
      g.globalAlpha = 0.05;
      for (let k = 0; k < 420; k++) {   // brushed-steel streaks and old scuffs
        const x = AX + hash(k, 1) * AS, y = AY + hash(k, 2) * AS, len = 20 + hash(k, 3) * 90, a = hash(k, 4) * TAU;
        line(g, x, y, clamp(x + Math.cos(a) * len, AX, AX + AS), clamp(y + Math.sin(a) * len, AY, AY + AS), 1 + hash(k, 5) * 2, hash(k, 6) < 0.5 ? '#000' : '#fff');
      }
      g.globalAlpha = 1;
      for (let i = 0; i <= 5; i++) {
        line(g, AX + i * plate, AY, AX + i * plate, AY + AS, 3, 'rgba(0,0,0,0.6)'); line(g, AX + i * plate + 2, AY, AX + i * plate + 2, AY + AS, 1, 'rgba(255,255,255,0.07)');
        line(g, AX, AY + i * plate, AX + AS, AY + i * plate, 3, 'rgba(0,0,0,0.6)'); line(g, AX, AY + i * plate + 2, AX + AS, AY + i * plate + 2, 1, 'rgba(255,255,255,0.07)');
      }
      for (let i = 0; i <= 5; i++) for (let k = 0; k <= 20; k++) for (const off of [-7, 7]) {
        if (i < 5 || off < 0) { disc(g, AX + i * plate + off, AY + k * (AS / 20), 2.4, '#15171a'); disc(g, AX + i * plate + off - 0.6, AY + k * (AS / 20) - 0.6, 1, 'rgba(255,255,255,0.25)'); }
      }
      // painted markings: centre ring and the two starting squares
      g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,0.13)';
      g.beginPath(); g.arc(sx(0), sy(0), PX * 1.1, 0, TAU); g.stroke();
      [[-3.3, SIDE_COLORS[0]], [3.3, SIDE_COLORS[1]]].forEach(([x, col]) => { g.strokeStyle = col; g.globalAlpha = 0.45; g.lineWidth = 4; g.strokeRect(sx(x) - PX * 0.75, sy(0) - PX * 0.75, PX * 1.5, PX * 1.5); g.globalAlpha = 1; });
      const chevrons = (x, y, w, h) => {   // yellow / black hazard border
        g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
        g.fillStyle = '#d6a514'; g.fillRect(x, y, w, h); g.strokeStyle = '#14161a'; g.lineWidth = 7;
        for (let q = -h; q < w + h; q += 18) { g.beginPath(); g.moveTo(x + q, y + h); g.lineTo(x + q + h, y); g.stroke(); }
        g.restore();
      };
      for (const s of hz.saws) { const w = 30, h = s.len * PX + 26; chevrons(sx(s.x) - w / 2, sy(s.y) - h / 2, w, h); box(g, sx(s.x) - 5, sy(s.y) - (s.len * PX) / 2, sx(s.x) + 5, sy(s.y) + (s.len * PX) / 2, '#050506'); }
      for (const f of hz.flames) {
        const r = 0.3 * PX; chevrons(sx(f.x) - r - 8, sy(f.y) - r - 8, 2 * r + 16, 2 * r + 16); box(g, sx(f.x) - r, sy(f.y) - r, sx(f.x) + r, sy(f.y) + r, '#0b0c0e');
        for (let k = -2; k <= 2; k++) line(g, sx(f.x) - r, sy(f.y) + k * 8, sx(f.x) + r, sy(f.y) + k * 8, 3, '#3a3d44');
      }
      if (hz.pulv) {
        const p = hz.pulv; g.strokeStyle = 'rgba(214,40,40,0.75)'; g.lineWidth = 5;
        g.beginPath(); g.arc(sx(p.x), sy(p.y), p.r * PX, 0, TAU); g.stroke(); g.beginPath(); g.arc(sx(p.x), sy(p.y), p.r * PX * 0.45, 0, TAU); g.stroke();
      }
      if (hz.screws) { const s = hz.screws; chevrons(sx(s.x0), sy(s.y) - 8, (s.x1 - s.x0) * PX, 8); box(g, sx(s.x0), sy(s.y), sx(s.x1), AY + AS, '#0c0d10'); }
      if (hz.pit) {
        const p = hz.pit, h = p.h * PX; chevrons(sx(p.x) - h - 10, sy(p.y) - h - 10, 2 * h + 20, 2 * h + 20); box(g, sx(p.x) - h, sy(p.y) - h, sx(p.x) + h, sy(p.y) + h, '#2a2d33');
        g.fillStyle = 'rgba(255,255,255,0.3)'; g.font = '700 22px "JetBrains Mono", monospace'; g.textAlign = 'center'; g.fillText('PIT', sx(p.x), sy(p.y) + 8);
      }
      // kick plate, then the polycarbonate wall seen from above with its steel posts
      g.lineWidth = 8; g.strokeStyle = '#4a505a'; g.strokeRect(AX - 4, AY - 4, AS + 8, AS + 8);
      g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,0.25)'; g.strokeRect(AX - 8, AY - 8, AS + 16, AS + 16);
      g.lineWidth = 16; g.strokeStyle = 'rgba(150,200,235,0.16)'; g.strokeRect(AX - 17, AY - 17, AS + 34, AS + 34);
      g.lineWidth = 1.5; g.strokeStyle = 'rgba(210,235,255,0.4)'; g.strokeRect(AX - 25, AY - 25, AS + 50, AS + 50);
      for (let k = 0; k <= 5; k++) for (const e of [0, 1]) {
        box(g, AX + k * plate - 6, e ? AY + AS + 8 : AY - 26, AX + k * plate + 6, e ? AY + AS + 26 : AY - 8, '#5a616c');
        box(g, e ? AX + AS + 8 : AX - 26, AY + k * plate - 6, e ? AX + AS + 26 : AX - 8, AY + k * plate + 6, '#5a616c');
      }
      return cv;
    }
    // floodlight pools and a vignette, composited over everything in the arena
    function buildLight() {
      const cv = makeCanvas(AS, AS), g = cv.getContext('2d');
      for (const [x, y] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const lg = g.createRadialGradient(x * AS, y * AS, 0, x * AS, y * AS, AS * 0.42);
        lg.addColorStop(0, 'rgba(255,248,230,0.10)'); lg.addColorStop(1, 'rgba(255,248,230,0)');
        g.fillStyle = lg; g.fillRect(0, 0, AS, AS);
      }
      const vg = g.createRadialGradient(AS / 2, AS / 2, AS * 0.3, AS / 2, AS / 2, AS * 0.75);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.5)');
      g.fillStyle = vg; g.fillRect(0, 0, AS, AS);
      return cv;
    }

    // ---- modules ------------------------------------------------------------------------------------
    // Drawn in the mount frame: a = outward from the hardpoint, b = lateral. Sizes come from the strike zone, so what
    // is drawn is what can hit.
    function drawModule(g, w, ws, col, t) {
      const v = w.vis, R = v.r ? { a0: v.a - v.r, a1: v.a + v.r, b0: v.b - v.r, b1: v.b + v.r } : v;
      const { a0, a1, b0, b1 } = R, bm = (b0 + b1) / 2, bw = b1 - b0, al = a1 - a0;
      const spin = ws.spin, fast = spin > 0.3;
      g.save();
      g.translate(w.mz, w.mx); g.rotate(w.rot);
      if (ws.dead) g.globalAlpha = 0.55;
      const steel = ws.dead ? '#5a5d62' : STEEL, tool = ws.dead ? '#6b6e73' : STEEL_LIGHT;
      switch (w.style) {
        case 'disk': case 'twin': {
          const offs = w.style === 'twin' ? [-bw * 0.3, bw * 0.3] : [0];
          box(g, Math.min(0, a0), b0 - 0.035, (a0 + a1) / 2, b0 - 0.005, STEEL_DARK); box(g, Math.min(0, a0), b1 + 0.005, (a0 + a1) / 2, b1 + 0.035, STEEL_DARK);
          line(g, (a0 + a1) / 2, b0 - 0.03, (a0 + a1) / 2, b1 + 0.03, 0.03, '#23262b');
          for (const o of offs) {
            if (fast) box(g, a0, bm + o - 0.04, a1, bm + o + 0.04, `rgba(220,225,232,${0.12 + 0.2 * spin})`);
            box(g, a0, bm + o - 0.018, a1, bm + o + 0.018, tool);
            // the tooth flashing past the top of the disk
            box(g, a0 + frac(ws.ang / TAU) * al * 0.9, bm + o - 0.03, a0 + frac(ws.ang / TAU) * al * 0.9 + al * 0.1, bm + o + 0.03, fast ? '#fff' : col.accent);
          }
          break;
        }
        case 'drum': {
          box(g, Math.min(0, a0), b0 - 0.03, a1 - al * 0.3, b0, STEEL_DARK); box(g, Math.min(0, a0), b1, a1 - al * 0.3, b1 + 0.03, STEEL_DARK);
          box(g, a0, b0, a1, b1, '#4c5159');
          for (let k = 0; k < 3; k++) { const f = frac(ws.ang / TAU + k / 3); box(g, a0 + f * al * 0.86, b0, a0 + f * al * 0.86 + al * 0.14, b1, k === 0 ? col.accent : tool); }
          if (fast) box(g, a0, b0, a1, b1, `rgba(225,230,236,${0.25 + 0.4 * spin})`);
          line(g, a0, b0, a0, b1, 0.012, 'rgba(0,0,0,0.5)'); line(g, a1, b0, a1, b1, 0.012, 'rgba(255,255,255,0.5)');
          break;
        }
        case 'bar': {
          if (!w.deck) box(g, Math.min(0, v.a - 0.02), v.b - 0.07, v.a, v.b + 0.07, STEEL_DARK);
          if (fast) {
            const rg = g.createRadialGradient(v.a, v.b, v.r * 0.2, v.a, v.b, v.r);
            rg.addColorStop(0, 'rgba(210,216,224,0.05)'); rg.addColorStop(1, `rgba(225,230,236,${0.14 + 0.3 * spin})`);
            disc(g, v.a, v.b, v.r, rg);
            g.strokeStyle = `rgba(255,255,255,${0.3 + 0.5 * spin})`; g.lineWidth = 0.012; g.beginPath(); g.arc(v.a, v.b, v.r, 0, TAU); g.stroke();
          }
          for (let k = 0; k < (fast ? 3 : 1); k++) {
            g.save(); g.translate(v.a, v.b); g.rotate(ws.ang + k * 1.1); g.globalAlpha *= fast ? 0.35 : 1;
            box(g, -v.r, -0.05, v.r, 0.05, tool); box(g, -v.r, -0.05, -v.r + 0.07, 0.05, col.accent); box(g, v.r - 0.07, -0.05, v.r, 0.05, col.accent);
            g.restore();
          }
          disc(g, v.a, v.b, Math.min(0.09, v.r * 0.3), '#23262b');
          break;
        }
        case 'shell': {
          const dome = w.type === 'shell';
          if (dome) { const rg = g.createRadialGradient(v.a - v.r * 0.3, v.b - v.r * 0.3, v.r * 0.1, v.a, v.b, v.r); rg.addColorStop(0, shade(col.top, 1.25)); rg.addColorStop(1, shade(col.armor, 0.7)); disc(g, v.a, v.b, v.r * 0.97, rg); }
          g.strokeStyle = shade(col.armor, dome ? 0.55 : 0.85); g.lineWidth = v.r * 0.14; g.beginPath(); g.arc(v.a, v.b, v.r * 0.92, 0, TAU); g.stroke();
          for (let k = 0; k < 3; k++) {
            g.save(); g.translate(v.a, v.b); g.rotate(ws.ang * 0.6 + (k * TAU) / 3);
            if (dome) line(g, v.r * 0.2, 0, v.r * 0.85, 0, 0.012, 'rgba(0,0,0,0.35)');
            box(g, v.r * 0.9, -0.05, v.r, 0.05, fast ? '#fff' : tool);
            g.restore();
          }
          if (fast) { g.strokeStyle = `rgba(255,255,255,${0.15 + 0.4 * spin})`; g.lineWidth = 0.03; g.beginPath(); g.arc(v.a, v.b, v.r * 0.985, 0, TAU); g.stroke(); }
          break;
        }
        case 'melty':
          // the whole bot is the weapon: just a heading beacon, plus the swept circle once it is turning
          if (spin > 0.1) { g.strokeStyle = `rgba(255,255,255,${0.2 * spin})`; g.lineWidth = 0.02; g.beginPath(); g.arc(v.a, v.b, v.r, 0, TAU); g.stroke(); }
          disc(g, 0, 0, 0.05, '#101114'); disc(g, 0, 0, 0.03, spin > 0.1 ? '#ff3b30' : '#7a1d18');
          break;
        case 'drill': {
          box(g, Math.min(0, a0), bm - 0.06, a0 + al * 0.3, bm + 0.06, STEEL_DARK);
          g.fillStyle = tool; g.beginPath(); g.moveTo(a0 + al * 0.25, bm - bw * 0.5); g.lineTo(a1, bm); g.lineTo(a0 + al * 0.25, bm + bw * 0.5); g.closePath(); g.fill();
          for (let k = 0; k < 4; k++) { const f = frac(ws.ang / TAU + k / 4), x = a0 + al * (0.25 + 0.7 * f), hw = bw * 0.5 * (1 - f); line(g, x, bm - hw, x + al * 0.06, bm + hw, 0.012, '#4a4f57'); }
          break;
        }
        case 'hammer': {
          // top view of an overhead arm: the head travels from over the deck out to the strike point
          const out = w.mode === 'spin' ? (ws.on && !ws.dead ? 1 : 0.15) : clamp(ws.anim * 1.6, 0, 1);
          const rest = a0 - 0.22, head = rest + (a1 - 0.07 - rest) * out, pivot = rest - 0.16;
          disc(g, pivot, bm, 0.06, STEEL_DARK);
          line(g, pivot, bm, head, bm, 0.045, steel);
          if (w.sawHead) {
            if (fast) box(g, head - 0.13, bm - 0.035, head + 0.13, bm + 0.035, `rgba(220,225,232,${0.2 + 0.3 * spin})`);
            box(g, head - 0.12, bm - 0.014, head + 0.12, bm + 0.014, tool); box(g, head - 0.05, bm - 0.05, head + 0.05, bm - 0.02, STEEL_DARK);
          } else if (w.type === 'axe') { g.fillStyle = tool; g.beginPath(); g.moveTo(head - 0.05, bm - 0.1); g.lineTo(head + 0.09, bm); g.lineTo(head - 0.05, bm + 0.1); g.closePath(); g.fill(); } else {
            box(g, head - 0.06, bm - 0.09, head + 0.06, bm + 0.09, '#2a2d33'); box(g, head - 0.045, bm - 0.075, head + 0.045, bm + 0.075, tool);
          }
          break;
        }
        case 'flipper': {
          const up = ws.anim;   // the plate looks shorter and brighter as it swings up toward the camera
          const tip = a1 - al * 0.45 * up;
          g.fillStyle = shade(col.armor, 0.85 + 0.6 * up); g.beginPath(); g.moveTo(a0, b0); g.lineTo(tip, b0 + bw * 0.08); g.lineTo(tip, b1 - bw * 0.08); g.lineTo(a0, b1); g.closePath(); g.fill();
          line(g, tip, b0 + bw * 0.08, tip, b1 - bw * 0.08, 0.02, STEEL_LIGHT); line(g, a0 + al * 0.3, b0 + 0.02, a0 + al * 0.3, b1 - 0.02, 0.01, 'rgba(0,0,0,0.4)');
          break;
        }
        case 'lifter': {
          const tip = a1 - al * 0.4 * ws.anim;
          for (const b of [b0 + bw * 0.2, b1 - bw * 0.2]) { g.fillStyle = steel; g.beginPath(); g.moveTo(a0, b - 0.03); g.lineTo(tip, b - 0.008); g.lineTo(tip, b + 0.008); g.lineTo(a0, b + 0.03); g.closePath(); g.fill(); }
          box(g, a0, b0 + bw * 0.15, a0 + 0.05, b1 - bw * 0.15, STEEL_DARK);
          if (w.type !== 'lifter') line(g, a0 - 0.1, bm, tip - al * 0.2, bm, 0.035, col.accent);   // clamp / suplex arm
          break;
        }
        case 'crusher': {
          const close = ws.act > 0 ? ws.anim : 0, tip = a0 + al * (0.55 + 0.4 * close);
          for (const b of [bm - 0.1, bm + 0.1]) line(g, a0, b, a1 - 0.03, b, 0.03, STEEL_DARK);
          box(g, a0 - 0.3, bm - 0.045, a0, bm + 0.045, '#565c66');
          g.fillStyle = shade(col.armor, 1 + 0.3 * close); g.beginPath(); g.moveTo(a0 - 0.15, bm - 0.08); g.lineTo(tip - 0.1, bm - 0.04); g.lineTo(tip, bm); g.lineTo(tip - 0.1, bm + 0.04); g.lineTo(a0 - 0.15, bm + 0.08); g.closePath(); g.fill();
          disc(g, tip - 0.02, bm, 0.018, STEEL_LIGHT);
          break;
        }
        case 'grabber': {
          const close = ws.act > 0 ? ws.anim : 0;
          for (const sgn of [-1, 1]) {
            const b = sgn < 0 ? b0 : b1, inb = b - sgn * (bw * 0.5 - 0.04) * close;
            g.strokeStyle = steel; g.lineWidth = 0.035; g.lineJoin = 'round'; g.beginPath(); g.moveTo(a0, b - sgn * 0.02); g.lineTo(a0 + al * 0.6, inb + sgn * 0.02); g.lineTo(a1, inb - sgn * 0.06); g.stroke();
          }
          box(g, a0 - 0.02, b0, a0 + 0.04, b1, STEEL_DARK);
          break;
        }
        case 'punch': {
          const ext = 0.3 + 0.7 * ws.anim;
          box(g, a0 - 0.22, bm - 0.05, a0 + 0.02, bm + 0.05, '#565c66'); box(g, a0 - 0.22, bm - 0.05, a0 - 0.19, bm + 0.05, col.accent);
          box(g, a0, bm - 0.018, a0 + al * ext - 0.06, bm + 0.018, tool);
          g.fillStyle = tool; g.beginPath(); g.moveTo(a0 + al * ext - 0.07, bm - 0.04); g.lineTo(a0 + al * ext, bm); g.lineTo(a0 + al * ext - 0.07, bm + 0.04); g.closePath(); g.fill();
          break;
        }
        case 'flame': {
          disc(g, v.ma - 0.3, v.mb, 0.09, '#b4231c'); disc(g, v.ma - 0.3, v.mb, 0.05, '#7d1712');
          box(g, v.ma - 0.26, v.mb - 0.025, v.ma, v.mb + 0.025, STEEL_DARK); box(g, v.ma - 0.04, v.mb - 0.035, v.ma, v.mb + 0.035, '#1b1d21');
          if (ws.act > 0) {
            g.globalCompositeOperation = 'lighter';
            for (let k = 0; k < 14; k++) {
              const f = frac(k / 14 + t * 2.6), wob = Math.sin(t * 23 + k * 2.1) * 0.05 * f;
              disc(g, v.ma + f * w.range, v.mb + wob, 0.04 + f * 0.2, `rgba(255,${Math.round(220 - 150 * f)},${Math.round(90 * (1 - f))},${0.5 * (1 - f)})`);
            }
            g.globalCompositeOperation = 'source-over';
          } else disc(g, v.ma + 0.015, v.mb, 0.012, '#5bc0ff');   // pilot light
          break;
        }
        case 'arc': {
          box(g, v.ma - 0.3, v.mb - 0.1, v.ma - 0.14, v.mb + 0.1, '#30343c'); box(g, v.ma - 0.28, v.mb - 0.08, v.ma - 0.16, v.mb + 0.08, col.accent);
          for (const sgn of [-1, 1]) { line(g, v.ma - 0.16, v.mb + sgn * 0.07, v.ma, v.mb + sgn * 0.04, 0.02, '#c98b2b'); disc(g, v.ma - 0.1, v.mb + sgn * 0.06, 0.022, '#e9e6dc'); }
          if (!ws.dead && ws.cd <= 0) { g.globalCompositeOperation = 'lighter'; disc(g, v.ma, v.mb, 0.03 + 0.012 * Math.sin(t * 40), 'rgba(120,190,255,0.8)'); g.globalCompositeOperation = 'source-over'; }
          break;
        }
        case 'gun': {
          const kick = ws.anim * 0.05;
          disc(g, v.ma - 0.34, v.mb, 0.12, '#30343c'); disc(g, v.ma - 0.34, v.mb, 0.085, shade(col.armor, 0.8));
          box(g, v.ma - 0.34 - kick, v.mb - 0.028, v.ma - kick, v.mb + 0.028, STEEL_DARK); box(g, v.ma - 0.06 - kick, v.mb - 0.036, v.ma - kick, v.mb + 0.036, '#1b1d21');
          if (ws.anim > 0.6) { g.globalCompositeOperation = 'lighter'; disc(g, v.ma + 0.06, v.mb, 0.1 * ws.anim, 'rgba(255,220,150,0.9)'); g.globalCompositeOperation = 'source-over'; }
          break;
        }
        case 'forks':
          for (let k = 0; k < 4; k++) { const b = b0 + bw * (0.1 + (0.8 * k) / 3); g.fillStyle = steel; g.beginPath(); g.moveTo(a0, b - 0.025); g.lineTo(a1, b); g.lineTo(a0, b + 0.025); g.closePath(); g.fill(); }
          break;
        case 'plow':
          g.fillStyle = shade(col.armor, 0.9); g.beginPath(); g.moveTo(a0, b0); g.quadraticCurveTo(a1 + al * 0.5, bm, a0, b1); g.lineTo(a0, b1 - 0.04); g.quadraticCurveTo(a1, bm, a0, b0 + 0.04); g.closePath(); g.fill();
          g.strokeStyle = STEEL_LIGHT; g.lineWidth = 0.012; g.beginPath(); g.moveTo(a0, b0); g.quadraticCurveTo(a1 + al * 0.5, bm, a0, b1); g.stroke();
          break;
        case 'ramp': {
          const rg = g.createLinearGradient(a0, 0, a1, 0); rg.addColorStop(0, shade(col.armor, 1.15)); rg.addColorStop(1, shade(col.armor, 0.6));
          g.fillStyle = rg; g.beginPath(); g.moveTo(a0, b0); g.lineTo(a1, b0 + bw * 0.06); g.lineTo(a1, b1 - bw * 0.06); g.lineTo(a0, b1); g.closePath(); g.fill();
          line(g, a1, b0 + bw * 0.06, a1, b1 - bw * 0.06, 0.012, STEEL_LIGHT);
          break;
        }
        case 'spikes':
          box(g, a0, b0, a0 + 0.04, b1, STEEL_DARK);
          for (let k = 0; k < 3; k++) { const b = b0 + bw * (0.18 + 0.32 * k); g.fillStyle = tool; g.beginPath(); g.moveTo(a0 + 0.03, b - 0.035); g.lineTo(a1, b); g.lineTo(a0 + 0.03, b + 0.035); g.closePath(); g.fill(); }
          break;
        case 'tail':
          line(g, a0, bm, a1 - 0.06, bm, 0.035, steel); box(g, a1 - 0.12, bm - 0.07, a1, bm + 0.07, '#2a2d33'); box(g, a1 - 0.1, bm - 0.055, a1 - 0.02, bm + 0.055, col.accent);
          break;
        case 'srimech': {
          const sweep = ws.anim;
          disc(g, a0 - 0.08, bm, 0.05, STEEL_DARK); line(g, a0 - 0.08, bm, a0 + al * (0.5 + 0.5 * sweep), bm + bw * 0.3 * (1 - sweep), 0.03, steel);
          disc(g, a0 + al * (0.5 + 0.5 * sweep), bm + bw * 0.3 * (1 - sweep), 0.035, col.accent);
          break;
        }
        default:
          box(g, a0, b0, a1, b1, STEEL_DARK); box(g, a0 + 0.015, b0 + 0.015, a1 - 0.015, b1 - 0.015, '#565c66');
          line(g, a0, b0, a1, b1, 0.01, 'rgba(0,0,0,0.4)'); line(g, a0, b1, a1, b0, 0.01, 'rgba(0,0,0,0.4)');
      }
      g.restore();
    }

    // ---- bots ---------------------------------------------------------------------------------------
    const LIGHT = [-0.55, -0.83];   // floodlights sit up-screen and to the left; bevels are lit in world space
    function drawBot(g, spec, bs, t, cx, cy, scale) {
      const th = bs.th + bs.body, lift = 1 + Math.min(bs.air, 0.9) * 0.22;
      const under = bs.inv;   // belly up: bare baseplate, no deck gear
      const col = under ? { armor: shade(spec.colors.armor, 0.5), top: '#262a31', accent: '#565c66' } : spec.colors;
      g.save();
      g.translate(cx, cy); g.rotate(th); g.scale(scale * lift, scale * lift);
      g.lineJoin = 'round';
      const moving = clamp(bs.speed / Math.max(0.5, spec.topSpeed), 0, 1);
      // walker legs swing in alternating pairs
      spec.legs.forEach((lg, k) => {
        const sw = Math.sin(t * 14 * moving + (k % 2 ? 0 : Math.PI) + (lg.z > 0 ? 0 : Math.PI)) * 0.07 * (moving > 0.05 ? 1 : 0);
        const sgn = Math.sign(lg.x) || 1, fx = lg.x + sgn * 0.05, fz = lg.z + sw;
        line(g, lg.z, sgn * spec.bodyHalfW * 0.8, lg.z + sw * 0.4, sgn * (Math.abs(lg.x) - 0.03), 0.05, '#3b4048');
        line(g, lg.z + sw * 0.4, sgn * (Math.abs(lg.x) - 0.03), fz, fx, 0.04, STEEL);
        disc(g, fz, fx, 0.035, '#15171a');
      });
      const drawWheels = () => {
        if (spec.tracks && spec.wheels.length) {
          for (const sgn of [-1, 1]) {
            const side = spec.wheels.filter((q) => Math.sign(q.x) === sgn);
            if (!side.length) continue;
            const z0 = Math.min(...side.map((q) => q.z)) - side[0].r, z1 = Math.max(...side.map((q) => q.z)) + side[0].r, x = side[0].x, hw = side[0].w * 0.7;
            box(g, z0, x - hw, z1, x + hw, '#0f1012');
            for (let k = 0; k < 14; k++) { const z = z0 + frac(k / 14 + t * moving * 2) * (z1 - z0); line(g, z, x - hw, z, x + hw, 0.012, '#2c2f35'); }
          }
          return;
        }
        for (const q of spec.wheels) {
          box(g, q.z - q.r, q.x - q.w / 2, q.z + q.r, q.x + q.w / 2, '#0f1012');
          for (let k = 0; k < 5; k++) { const z = q.z - q.r + frac(k / 5 + t * moving * 3) * 2 * q.r; line(g, z, q.x - q.w / 2, z, q.x + q.w / 2, 0.01, '#30333a'); }
        }
        if (spec.caster) disc(g, spec.caster.z, spec.caster.x, 0.03, '#0f1012');
      };
      drawWheels();
      // side plates: one lit strip per hull edge, so the bevel reads as 3D while the bot turns
      const out = spec.outline, inn = insetPoly(out, 0.035), n = out.length;
      const cs = Math.cos(th), sn = Math.sin(th);
      let area = 0;
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; area += out[i][0] * out[j][1] - out[j][0] * out[i][1]; }
      const sg = area > 0 ? 1 : -1;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, ex = out[j][0] - out[i][0], ez = out[j][1] - out[i][1], el = Math.hypot(ex, ez) || 1;
        const nx = (ez / el) * sg, nz = (-ex / el) * sg;   // outward normal in the bot frame
        const lit = (nz * cs - nx * sn) * LIGHT[0] + (nz * sn + nx * cs) * LIGHT[1];
        g.fillStyle = shade(col.armor, 0.9 + 0.4 * lit);
        g.beginPath(); g.moveTo(out[i][1], out[i][0]); g.lineTo(out[j][1], out[j][0]); g.lineTo(inn[j][1], inn[j][0]); g.lineTo(inn[i][1], inn[i][0]); g.closePath(); g.fill();
      }
      trace(g, inn);
      if (spec.tube && !under) {
        // open spaceframe: dark bay with the cage tubes visible
        g.fillStyle = '#121418'; g.fill();
        for (const p of [[0, 2], [1, 3]]) line(g, inn[p[0]][1], inn[p[0]][0], inn[p[1]][1], inn[p[1]][0], 0.03, shade(col.armor, 0.9));
        line(g, 0, inn[0][0], 0, inn[1][0], 0.03, shade(col.armor, 0.9));
        box(g, spec.zR + 0.1, -0.12, spec.zR + 0.3, 0.12, '#2f6fb0');
      } else {
        const tg = g.createLinearGradient(spec.zR, -spec.halfW, spec.zF, spec.halfW);
        tg.addColorStop(0, shade(col.top, 0.82)); tg.addColorStop(0.5, shade(col.top, 1.08)); tg.addColorStop(1, shade(col.top, 0.88));
        g.fillStyle = tg; g.fill();
      }
      g.save();
      trace(g, inn); g.clip();
      if (spec.nose > 0) {   // sloped nose plate
        const ng = g.createLinearGradient(spec.noseZ, 0, spec.zF, 0); ng.addColorStop(0, shade(col.armor, 1.2)); ng.addColorStop(1, shade(col.armor, 0.65));
        box(g, spec.noseZ, -spec.halfW, spec.zF, spec.halfW, ng); line(g, spec.noseZ, -spec.halfW, spec.noseZ, spec.halfW, 0.012, 'rgba(0,0,0,0.45)');
      }
      if (!under && !spec.tube) {
        const len = spec.zF - spec.zR;
        box(g, spec.zR + len * 0.16, -spec.halfW, spec.zR + len * 0.24, spec.halfW, col.accent);
        line(g, spec.zR + len * 0.5, -spec.halfW, spec.zR + len * 0.5, spec.halfW, 0.008, 'rgba(0,0,0,0.3)');
        if (spec.text) { g.save(); g.translate(spec.zR + len * 0.36, 0); g.rotate(Math.PI / 2); g.scale(0.01, 0.01); g.fillStyle = col.accent; g.font = '800 9px Inter, sans-serif'; g.textAlign = 'center'; g.fillText(spec.text, 0, 3); g.restore(); }
      }
      if (under) for (const q of [[0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]]) box(g, q[0] * spec.zF - 0.05, q[1] * spec.halfW * 2 - 0.03, q[0] * spec.zF + 0.05, q[1] * spec.halfW * 2 + 0.03, '#1a1d22');
      g.restore();
      inn.forEach((p) => disc(g, p[1] * 0.9, p[0] * 0.9, 0.012, 'rgba(0,0,0,0.45)'));
      if (under) drawWheels();
      // armour damage: gouges build up along a face, and a breached face shows a torn, glowing hole
      const mids = [[spec.zF - 0.07, 0, 0], [0, -spec.halfW + 0.07, 1], [0, spec.halfW - 0.07, 1], [spec.zR + 0.07, 0, 0], [(spec.zF + spec.zR) / 2 + 0.1, 0, 0]];
      bs.hp.forEach((h, f) => {
        const m = mids[f], along = f === 4 ? 0.2 : (m[2] ? spec.zF - spec.zR : spec.halfW * 2) * 0.4;
        const marks = Math.round((1 - h) * 7);
        for (let k = 0; k < marks; k++) {
          const u = (hash(f * 31 + k, 7) - 0.5) * 2 * along, a = hash(f * 31 + k, 9) * TAU, len = 0.03 + hash(f * 31 + k, 11) * 0.06;
          const z = m[0] + (m[2] ? u : 0), x = m[1] + (m[2] ? 0 : u);
          line(g, z, x, z + Math.cos(a) * len, x + Math.sin(a) * len, 0.014, 'rgba(10,10,12,0.75)'); line(g, z, x, z + Math.cos(a) * len * 0.6, x + Math.sin(a) * len * 0.6, 0.005, 'rgba(230,230,235,0.6)');
        }
        if (h <= 0) {
          g.fillStyle = '#060607'; g.beginPath();
          for (let k = 0; k < 9; k++) { const a = (k / 9) * TAU, r = 0.045 + hash(f * 17 + k, 3) * 0.05; if (k) g.lineTo(m[0] + Math.cos(a) * r, m[1] + Math.sin(a) * r); else g.moveTo(m[0] + Math.cos(a) * r, m[1] + Math.sin(a) * r); }
          g.closePath(); g.fill();
          g.strokeStyle = `rgba(255,${120 + Math.round(60 * Math.sin(t * 9 + f))},40,0.8)`; g.lineWidth = 0.008; g.stroke();
        }
      });
      spec.weapons.forEach((w, k) => { if (!(under && w.deck)) drawModule(g, w, bs.w[k], col, t); });
      if (bs.slow > 0) {   // tangled in a net
        g.strokeStyle = 'rgba(230,230,220,0.55)'; g.lineWidth = 0.008;
        for (let k = -4; k <= 4; k++) { g.beginPath(); g.moveTo(spec.zR, k * 0.1 - 0.3); g.lineTo(spec.zF, k * 0.1 + 0.3); g.moveTo(spec.zR, k * 0.1 + 0.3); g.lineTo(spec.zF, k * 0.1 - 0.3); g.stroke(); }
      }
      if (bs.stun > 0) {
        g.globalCompositeOperation = 'lighter'; g.strokeStyle = 'rgba(140,200,255,0.9)'; g.lineWidth = 0.012;
        for (let k = 0; k < 4; k++) { const s = Math.floor(t * 30) * 7 + k; g.beginPath(); g.moveTo((hash(s, 1) - 0.5) * spec.zF * 2, (hash(s, 2) - 0.5) * spec.halfW * 2); g.lineTo((hash(s, 3) - 0.5) * spec.zF * 2, (hash(s, 4) - 0.5) * spec.halfW * 2); g.stroke(); }
      }
      g.restore();
    }

    // ---- hazards (moving parts) ---------------------------------------------------------------------
    function drawHazards(g, hz, hs, t) {
      hz.saws.forEach((s, k) => {
        const up = hs.saws[k] || 0;
        if (up <= 0) return;
        const h = (s.len * PX * up) / 2, x = sx(s.x), y = sy(s.y);
        box(g, x - 7, y - h, x + 7, y + h, 'rgba(230,234,240,0.25)'); box(g, x - 2.5, y - h, x + 2.5, y + h, '#e4e8ee');
        for (let q = 0; q < 6; q++) { const f = frac(q / 6 + t * 9); box(g, x - 4, y - h + f * 2 * h - 2, x + 4, y - h + f * 2 * h + 2, '#8d939c'); }
        g.globalCompositeOperation = 'lighter';
        for (let q = 0; q < 5; q++) { const s2 = Math.floor(t * 40) * 5 + q + k * 100; line(g, x, y - h, x + (hash(s2, 1) - 0.5) * 26, y - h - hash(s2, 2) * 22, 1.5, 'rgba(255,200,90,0.8)'); }
        g.globalCompositeOperation = 'source-over';
      });
      if (hz.screws) {
        const s = hz.screws, y0 = sy(s.y) + 4, y1 = AY + AS - 3;
        g.save(); g.beginPath(); g.rect(sx(s.x0), y0, (s.x1 - s.x0) * PX, y1 - y0); g.clip();
        box(g, sx(s.x0), y0, sx(s.x1), y1, '#6c727b');
        for (let x = sx(s.x0) - 40 + frac(t * 1.5) * 28; x < sx(s.x1) + 40; x += 28) { line(g, x, y0, x + 16, y1, 7, '#2c2f35'); line(g, x + 9, y0, x + 25, y1, 2, 'rgba(255,255,255,0.35)'); }
        g.restore();
      }
      if (hz.pit && hs.pit > 0) {
        const p = hz.pit, h = p.h * PX, x = sx(p.x), y = sy(p.y);
        const pg = g.createRadialGradient(x, y, h * 0.2, x, y, h * 1.2); pg.addColorStop(0, '#000'); pg.addColorStop(1, '#16181c');
        box(g, x - h, y - h, x + h, y + h, pg);
        box(g, x - h, y - h, x + h, y - h + 2 * h * (1 - hs.pit), '#2a2d33');   // the lid sliding away
        g.strokeStyle = 'rgba(0,0,0,0.8)'; g.lineWidth = 3; g.strokeRect(x - h, y - h, 2 * h, 2 * h);
      }
      hz.flames.forEach((f, k) => {
        if (!hs.flames[k]) return;
        g.globalCompositeOperation = 'lighter';
        for (let q = 0; q < 12; q++) {
          const u = frac(q / 12 + t * 2.2), a = hash(q, k + 3) * TAU;
          disc(g, sx(f.x) + Math.cos(a) * u * 20, sy(f.y) + Math.sin(a) * u * 20 - u * 26, 8 + u * 22, `rgba(255,${Math.round(210 - 140 * u)},${Math.round(80 * (1 - u))},${0.5 * (1 - u)})`);
        }
        g.globalCompositeOperation = 'source-over';
      });
    }
    // the pulverizer swings over the bots, so it is drawn after them
    function drawPulverizer(g, hz, hs) {
      if (!hz.pulv) return;
      const p = hz.pulv, x = sx(p.x), y = sy(p.y), raised = 1 - hs.pulv, size = 46 + raised * 16;
      box(g, x - size / 2 + 6 + raised * 14, y - size / 2 + 8 + raised * 18, x + size / 2 + 6 + raised * 14, y + size / 2 + 8 + raised * 18, 'rgba(0,0,0,0.4)');
      line(g, AX + 6, AY + 6, x, y, 16, '#4a505a'); line(g, AX + 6, AY + 6, x, y, 6, '#6d747e');
      box(g, x - size / 2, y - size / 2, x + size / 2, y + size / 2, '#2a2d33'); box(g, x - size / 2 + 5, y - size / 2 + 5, x + size / 2 - 5, y + size / 2 - 5, raised > 0.5 ? '#8a9099' : '#b9bec6');
      disc(g, AX + 10, AY + 10, 15, '#30343b');
    }

    // ---- effects: a pure function of the event log and the time, so live play and replay share it -----
    const eventIndex = (ev, t) => { let lo = 0, hi = ev.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (ev[mid].t <= t) lo = mid + 1; else hi = mid; } return lo; };
    function shakeAt(ev, t) {
      let amp = 0;
      for (let i = eventIndex(ev, t) - 1; i >= 0 && t - ev[i].t < 0.25; i--) if (ev[i].type === 'hit') amp += (ev[i].dmg / 2500) * (1 - (t - ev[i].t) / 0.25);
      amp = Math.min(amp, 9);
      return [Math.sin(t * 91) * amp, Math.cos(t * 77) * amp];
    }
    function drawEffects(g, m, t, k) {
      const ev = m.events;
      for (let i = eventIndex(ev, t) - 1; i >= 0 && t - ev[i].t < 1.4; i--) {
        const e = ev[i], age = t - e.t, x = sx(e.x), y = sy(e.y);
        if (e.type === 'hit' && e.kind !== 'flame' && e.kind !== 'fire') {
          const blue = e.kind === 'arc', nSpark = Math.round(clamp(e.dmg / 500, 5, 44)), life = 0.55;
          if (age < life) {
            g.globalCompositeOperation = 'lighter'; g.lineCap = 'round';
            for (let q = 0; q < nSpark; q++) {
              const a = hash(i * 131 + q, 1) * TAU, sp = 70 + hash(i * 131 + q, 2) * 330, d = sp * age * (1 - age * 0.7), fade = 1 - age / life;
              const c = blue ? `rgba(150,200,255,${fade})` : `rgba(255,${Math.round(150 + 100 * fade)},${Math.round(60 + 160 * fade * hash(q, i))},${fade})`;
              line(g, x + Math.cos(a) * d, y + Math.sin(a) * d + 120 * age * age, x + Math.cos(a) * (d + 4 + sp * 0.035), y + Math.sin(a) * (d + 4 + sp * 0.035) + 120 * age * age, 1.8, c);
            }
            if (age < 0.09) { const r = 14 + Math.sqrt(e.dmg) * 0.45; const fg = g.createRadialGradient(x, y, 0, x, y, r); fg.addColorStop(0, 'rgba(255,255,240,0.95)'); fg.addColorStop(1, 'rgba(255,200,120,0)'); disc(g, x, y, r, fg); }
            if (e.dmg > 6000) { g.strokeStyle = `rgba(255,255,255,${0.5 * (1 - age / life)})`; g.lineWidth = 2.5; g.beginPath(); g.arc(x, y, 12 + age * 190, 0, TAU); g.stroke(); }
            g.globalCompositeOperation = 'source-over'; g.lineCap = 'butt';
          }
          if (e.dmg >= 4000 && age < 1.1) {
            g.globalAlpha = clamp(2 - age * 2, 0, 1); g.font = '700 19px "JetBrains Mono", monospace'; g.textAlign = 'center';
            g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.fillStyle = e.to === 0 ? '#ff9a73' : '#ffe9a8';
            const txt = scaled(`${(e.dmg / 1000).toFixed(1)} KJ`, k);
            g.strokeText(txt, x, y - 22 - age * 34); g.fillText(txt, x, y - 22 - age * 34); g.globalAlpha = 1;
          }
        } else if (e.type === 'breach' && age < 1.3) {
          const colr = m.bots[e.to].spec.colors.armor;
          for (let q = 0; q < 9; q++) {   // torn plate fragments
            const a = hash(i * 17 + q, 5) * TAU, sp = 60 + hash(i * 17 + q, 6) * 160, d = sp * age * (1 - age * 0.35), s = 3 + hash(i * 17 + q, 7) * 5;
            g.save(); g.translate(x + Math.cos(a) * d, y + Math.sin(a) * d); g.rotate(a + age * 9); g.globalAlpha = clamp(1.3 - age, 0, 1);
            box(g, -s, -s * 0.6, s, s * 0.6, q % 2 ? colr : '#9aa0a8'); g.restore();
          }
          g.globalAlpha = clamp(1.6 - age * 1.4, 0, 1); g.font = '800 22px Inter, sans-serif'; g.textAlign = 'center'; g.lineWidth = 5; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.fillStyle = '#ff4433';
          g.strokeText('ARMOUR BREACHED', x, y - 44 - age * 20); g.fillText('ARMOUR BREACHED', x, y - 44 - age * 20); g.globalAlpha = 1;
        } else if (e.type === 'arc' && age < 0.2) {
          g.globalCompositeOperation = 'lighter';
          const x2 = sx(e.x2), y2 = sy(e.y2), seed = i * 53 + Math.floor(t * 40);
          for (const [lw, c] of [[7, 'rgba(90,150,255,0.4)'], [2.2, 'rgba(235,245,255,0.95)']]) {
            g.strokeStyle = c; g.lineWidth = lw; g.beginPath(); g.moveTo(x, y);
            for (let q = 1; q < 7; q++) g.lineTo(x + ((x2 - x) * q) / 7 + (hash(seed, q) - 0.5) * 22, y + ((y2 - y) * q) / 7 + (hash(seed, q + 9) - 0.5) * 22);
            g.lineTo(x2, y2); g.stroke();
          }
          g.globalCompositeOperation = 'source-over';
        } else if ((e.type === 'flip' || e.type === 'pit' || e.type === 'ko' || e.type === 'net' || e.type === 'right') && age < 1.2) {
          const label = e.type === 'flip' ? 'FLIPPED' : e.type === 'pit' ? 'IN THE PIT' : e.type === 'ko' ? 'KNOCKOUT' : e.type === 'net' ? 'TANGLED' : 'SELF-RIGHTED';
          g.strokeStyle = `rgba(255,255,255,${0.6 * (1 - age / 1.2)})`; g.lineWidth = 3; g.beginPath(); g.arc(x, y, 30 + age * 90, 0, TAU); g.stroke();
          g.globalAlpha = clamp(1.5 - age * 1.3, 0, 1); g.font = '800 22px Inter, sans-serif'; g.textAlign = 'center'; g.lineWidth = 5; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.fillStyle = '#fff';
          g.strokeText(label, x, y - 50 - age * 16); g.fillText(label, x, y - 50 - age * 16); g.globalAlpha = 1;
        } else if (e.type === 'spark' && age < 0.3) {
          g.globalCompositeOperation = 'lighter';
          for (let q = 0; q < 6; q++) { const a = hash(i * 7 + q, 1) * TAU, d = 120 * age; line(g, x + Math.cos(a) * d, y + Math.sin(a) * d, x + Math.cos(a) * (d + 6), y + Math.sin(a) * (d + 6), 1.5, `rgba(255,220,140,${1 - age / 0.3})`); }
          g.globalCompositeOperation = 'source-over';
        }
      }
    }
    // smoke and flame rising off a bot; "up" on screen stands in for height
    function drawSmoke(g, bs, t, idx) {
      const burning = bs.fire > 0, hurt = bs.hp.some((h) => h <= 0) || !bs.power;
      if ((!burning && !hurt) || bs.out) return;
      const x = sx(bs.x), y = sy(bs.y), n = burning ? 12 : 6;
      for (let q = 0; q < n; q++) {
        const f = frac(q / n + t * (burning ? 0.9 : 0.5)), wob = Math.sin(t * 2 + q * 1.7) * 10 * f;
        disc(g, x + (hash(q, idx + 40) - 0.5) * 30 + f * 46 + wob, y + (hash(q, idx + 50) - 0.5) * 30 - f * 80, 7 + f * 30, `rgba(${burning ? '20,20,22' : '70,72,78'},${(burning ? 0.5 : 0.28) * (1 - f)})`);
      }
      if (burning) {
        g.globalCompositeOperation = 'lighter';
        for (let q = 0; q < 9; q++) { const f = frac(q / 9 + t * 2.4); disc(g, x + (hash(q, idx + 60) - 0.5) * 34, y + (hash(q, idx + 70) - 0.5) * 34 - f * 30, 6 + (1 - f) * 12, `rgba(255,${Math.round(200 - 130 * f)},50,${0.55 * (1 - f)})`); }
        g.globalCompositeOperation = 'source-over';
      }
    }
    // permanent floor marks, stamped once per event onto their own canvas
    function stampDecal(g, e, i) {
      if (e.type !== 'hit' && e.type !== 'breach' && e.type !== 'flip') return;
      const x = sx(e.x) - AX, y = sy(e.y) - AY;
      if (e.type === 'breach' || e.kind === 'flame' || e.kind === 'arc' || e.kind === 'fire') {
        const r = e.type === 'breach' ? 46 : 26, sg = g.createRadialGradient(x, y, 0, x, y, r);
        sg.addColorStop(0, `rgba(0,0,0,${e.type === 'breach' ? 0.5 : 0.22})`); sg.addColorStop(1, 'rgba(0,0,0,0)');
        disc(g, x, y, r, sg);
        return;
      }
      const cuts = e.type === 'flip' ? 2 : Math.round(clamp(e.dmg / 2500, 1, 5)), len = e.type === 'flip' ? 30 : clamp(Math.sqrt(e.dmg) * 0.35, 6, 46);
      for (let q = 0; q < cuts; q++) {
        const a = hash(i * 11 + q, 1) * TAU, ox = (hash(i * 11 + q, 2) - 0.5) * 20, oy = (hash(i * 11 + q, 3) - 0.5) * 20, l = len * (0.5 + hash(i * 11 + q, 4));
        line(g, x + ox, y + oy, x + ox + Math.cos(a) * l, y + oy + Math.sin(a) * l, 3, 'rgba(0,0,0,0.5)');
        line(g, x + ox + 1, y + oy + 1, x + ox + 1 + Math.cos(a) * l * 0.8, y + oy + 1 + Math.sin(a) * l * 0.8, 1, 'rgba(215,220,228,0.45)');
      }
    }

    // ---- 3D BattleBox Arena Scene & 3D Bot Poser ----------------------------------------------------
    function ensureArena3D() {
      const E = root.BBEngine, Mdl = root.BBModels;
      if (!E || !Mdl) return null;
      if (ui.scn3d) return ui.scn3d;
      const THREE = E.THREE;
      const scn = new THREE.Scene();
      scn.background = new THREE.Color('#07090d');
      if (E.scene && E.scene.environment) scn.environment = E.scene.environment;

      scn.add(new THREE.HemisphereLight('#dce8ff', '#14171f', 0.68));
      const key = new THREE.DirectionalLight('#fff8eb', 1.75);
      key.position.set(-7, 15, 8);
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      Object.assign(key.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 2, far: 38 });
      key.shadow.bias = -0.001;
      scn.add(key);

      const fill = new THREE.DirectionalLight('#6eb4ff', 0.72);
      fill.position.set(10, 9, 7);
      scn.add(fill);

      const rim = new THREE.DirectionalLight('#ff7438', 0.92);
      rim.position.set(4, 8, -11);
      scn.add(rim);

      const cam = new THREE.PerspectiveCamera(34, STAGE_W / STAGE_H, 0.2, 120);
      const S = Mdl.SCALE || 2; // 1 arena metre = 2 scene units; 10x10m arena = [-10, 10] in X and Z

      const setGrp = new THREE.Group();
      setGrp.userData.isSet = true;
      scn.add(setGrp);

      // 10m x 10m AR500 BattleBox Steel Deck (5x5 2m plates with bevel seams, bolt rows, and starting squares)
      const plateMatA = new THREE.MeshStandardMaterial({ color: '#242932', roughness: 0.30, metalness: 0.90 });
      const plateMatB = new THREE.MeshStandardMaterial({ color: '#1f242c', roughness: 0.34, metalness: 0.88 });
      const seamMat = new THREE.MeshStandardMaterial({ color: '#0c0e12', roughness: 0.55, metalness: 0.6 });
      const boltMat = new THREE.MeshStandardMaterial({ color: '#8f98a6', roughness: 0.22, metalness: 0.98 });
      for (let ix = 0; ix < 5; ix++) {
        for (let iz = 0; iz < 5; iz++) {
          const px = (-4 + ix * 2) * S, pz = (-4 + iz * 2) * S;
          const pm = new THREE.Mesh(new THREE.BoxGeometry(1.97 * S, 0.08, 1.97 * S), (ix + iz) % 2 ? plateMatA : plateMatB);
          pm.position.set(px, -0.04, pz);
          pm.receiveShadow = true;
          setGrp.add(pm);
          // Corner plate bolts
          for (const bx of [-0.88, 0.88]) for (const bz of [-0.88, 0.88]) {
            const bm = new THREE.Mesh(new THREE.BoxGeometry(0.035 * S, 0.015, 0.035 * S), boltMat);
            bm.position.set(px + bx * S, 0.004, pz + bz * S);
            setGrp.add(bm);
          }
        }
      }
      const underFloor = new THREE.Mesh(new THREE.BoxGeometry(10.6 * S, 0.1, 10.6 * S), seamMat);
      underFloor.position.set(0, -0.095, 0);
      setGrp.add(underFloor);

      // Starting squares (Orange Red Left at x=-3.3m, Electric Blue Right at x=+3.3m) & Center BattleBox Ring
      const mkBoxFrame = (cx, cz, half, w, colHex) => {
        const mat = new THREE.MeshBasicMaterial({ color: colHex });
        for (const s of [-1, 1]) {
          const h1 = new THREE.Mesh(new THREE.BoxGeometry(half * 2, 0.014, w), mat);
          h1.position.set(cx, 0.007, cz + s * half);
          const h2 = new THREE.Mesh(new THREE.BoxGeometry(w, 0.014, half * 2), mat);
          h2.position.set(cx + s * half, 0.007, cz);
          setGrp.add(h1, h2);
        }
      };
      mkBoxFrame(-3.3 * S, 0, 0.78 * S, 0.055 * S, '#ff5a1f');
      mkBoxFrame(3.3 * S, 0, 0.78 * S, 0.055 * S, '#3aa0ff');

      const ringGeo = new THREE.RingGeometry(1.08 * S, 1.16 * S, 48);
      ringGeo.rotateX(-Math.PI / 2);
      const ringMesh = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#ff5a1f', side: THREE.DoubleSide, transparent: true, opacity: 0.45 }));
      ringMesh.position.y = 0.007;
      setGrp.add(ringMesh);
      const innerRingGeo = new THREE.RingGeometry(0.32 * S, 0.36 * S, 36);
      innerRingGeo.rotateX(-Math.PI / 2);
      const innerRingMesh = new THREE.Mesh(innerRingGeo, new THREE.MeshBasicMaterial({ color: '#94a3b8', side: THREE.DoubleSide, transparent: true, opacity: 0.35 }));
      innerRingMesh.position.y = 0.007;
      setGrp.add(innerRingMesh);

      // Perimeter Steel Kick-Plates, Hazard Stripes, Steel Stanchion Posts, and Overhead Light Truss
      const kickMat = new THREE.MeshStandardMaterial({ color: '#1b1f26', roughness: 0.35, metalness: 0.92 });
      const stripeYel = new THREE.MeshStandardMaterial({ color: '#f59e0b', roughness: 0.32, metalness: 0.35 });
      const postMat = new THREE.MeshStandardMaterial({ color: '#38404d', roughness: 0.28, metalness: 0.94 });
      const lightStripMat = new THREE.MeshBasicMaterial({ color: '#fff8eb' });
      const glassMat = new THREE.MeshBasicMaterial({ color: '#7dd3fc', transparent: true, opacity: 0.06, depthWrite: false });
      const W_HALF = ARENA * S; // 10 units

      for (const side of [-1, 1]) {
        // North & South kick plates + top truss beams
        const kwZ = new THREE.Mesh(new THREE.BoxGeometry(W_HALF * 2 + 0.4, 0.56, 0.24), kickMat);
        kwZ.position.set(0, 0.28, side * (W_HALF + 0.12));
        const kwX = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.56, W_HALF * 2 + 0.4), kickMat);
        kwX.position.set(side * (W_HALF + 0.12), 0.28, 0);
        const stZ = new THREE.Mesh(new THREE.BoxGeometry(W_HALF * 2, 0.12, 0.26), stripeYel);
        stZ.position.set(0, 0.50, side * (W_HALF + 0.12));
        const stX = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.12, W_HALF * 2), stripeYel);
        stX.position.set(side * (W_HALF + 0.12), 0.50, 0);
        setGrp.add(kwZ, kwX, stZ, stX);
      }
      // Back & side Lexan shield panels + corner steel towers + glowing stadium light pods
      const backGlass = new THREE.Mesh(new THREE.PlaneGeometry(W_HALF * 2, 3.6), glassMat);
      backGlass.position.set(0, 2.3, -W_HALF - 0.08);
      setGrp.add(backGlass);
      const topBeam = new THREE.Mesh(new THREE.BoxGeometry(W_HALF * 2 + 0.5, 0.22, 0.22), postMat);
      topBeam.position.set(0, 3.9, -W_HALF - 0.12);
      setGrp.add(topBeam);
      for (let i = -5; i <= 5; i += 2) {
        if (Math.abs(i) <= 3) {
          const lPod = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.12, 0.18), lightStripMat);
          lPod.position.set(i * S, 3.75, -W_HALF - 0.02);
          setGrp.add(lPod);
        }
        for (const s of [-1, 1]) {
          const p1 = new THREE.Mesh(new THREE.BoxGeometry(0.18, 3.9, 0.18), postMat);
          p1.position.set(i * S, 1.95, -W_HALF - 0.12);
          const p2 = new THREE.Mesh(new THREE.BoxGeometry(0.18, 3.9, 0.18), postMat);
          p2.position.set(s * (W_HALF + 0.12), 1.95, i * S);
          setGrp.add(p1, p2);
        }
      }

      // Dynamic 3D Hazards Group (Kill Saws, Pulverizer Hammer, Wall Screws, Pit, Flame Jets)
      const hzGrp = new THREE.Group();
      scn.add(hzGrp);
      const sawMat = new THREE.MeshStandardMaterial({ color: '#e2e8f0', roughness: 0.12, metalness: 1.0 });
      const sawSlotMat = new THREE.MeshBasicMaterial({ color: '#050608' });
      const saws3d = [0, 1, 2, 3].map(() => {
        const g = new THREE.Group();
        const chev = new THREE.Mesh(new THREE.BoxGeometry(0.32 * S, 0.012, 1.24 * S), stripeYel);
        chev.position.y = 0.006;
        const slot = new THREE.Mesh(new THREE.BoxGeometry(0.14 * S, 0.018, 1.1 * S), sawSlotMat);
        slot.position.y = 0.009;
        const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.45 * S, 0.45 * S, 0.035, 24), sawMat);
        blade.rotation.z = Math.PI / 2;
        g.add(chev, slot, blade);
        hzGrp.add(g);
        return { g, blade };
      });

      const pitGrp = new THREE.Group();
      const pitRim = new THREE.Mesh(new THREE.BoxGeometry(1.65 * S, 0.02, 1.65 * S), stripeYel);
      pitRim.position.y = 0.005;
      const pitHole = new THREE.Mesh(new THREE.BoxGeometry(1.42 * S, 0.03, 1.42 * S), sawSlotMat);
      pitHole.position.y = 0.008;
      const pitLid = new THREE.Mesh(new THREE.BoxGeometry(1.4 * S, 0.04, 1.4 * S), plateMatA);
      pitLid.position.y = 0.02;
      pitGrp.add(pitRim, pitHole, pitLid);
      hzGrp.add(pitGrp);

      const pulvGrp = new THREE.Group();
      const pulvPivot = new THREE.Group();
      const pulvArm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 1.7 * S), postMat);
      pulvArm.position.set(0, 0, 0.85 * S);
      const pulvHead = new THREE.Mesh(new THREE.BoxGeometry(0.56 * S, 0.48 * S, 0.56 * S), new THREE.MeshStandardMaterial({ color: '#dc2626', roughness: 0.25, metalness: 0.78 }));
      pulvHead.position.set(0, -0.15, 1.65 * S);
      pulvPivot.add(pulvArm, pulvHead);
      pulvGrp.add(pulvPivot);
      hzGrp.add(pulvGrp);

      const screwGrp = new THREE.Group();
      const screwCyl = new THREE.Mesh(new THREE.CylinderGeometry(0.18 * S, 0.18 * S, 4.4 * S, 18), sawMat);
      screwCyl.rotation.z = Math.PI / 2;
      screwGrp.add(screwCyl);
      hzGrp.add(screwGrp);

      ui.scn3d = { scn, cam, key, S, saws3d, pitGrp, pitLid, pulvGrp, pulvPivot, screwGrp, screwCyl, bots3d: [null, null], botBuilds: [null, null] };
      return ui.scn3d;
    }

    function syncArenaBots3D(b0, b1) {
      const s3 = ensureArena3D();
      if (!s3) return;
      const Mdl = root.BBModels;
      [b0, b1].forEach((b, i) => {
        if (s3.botBuilds[i] === b && s3.bots3d[i]) return;
        if (s3.bots3d[i]) {
          s3.scn.remove(s3.bots3d[i].root);
          Mdl.disposeBot(s3.bots3d[i]);
        }
        s3.bots3d[i] = Mdl.buildBot(b);
        s3.botBuilds[i] = b;
        s3.scn.add(s3.bots3d[i].root);
      });
    }

    function poseArenaBot3D(model, build, spec, bs, t) {
      const a = model.anim, S = model.scale;
      // Map Arena (bs.x, bs.y, bs.th) -> 3D World (X = bs.x * S, Z = bs.y * S, rotY = Math.PI/2 - (bs.th + bs.body))
      const invF = bs.inv ? 1 : 0;
      const liftY = Math.max(0, bs.air) * 0.85 + (invF ? build.invertRest : 0);
      model.root.position.set(bs.x * S, liftY * S, bs.y * S);
      model.root.rotation.order = 'YXZ';
      model.root.rotation.y = Math.PI / 2 - (bs.th + bs.body);
      model.root.rotation.z = Math.PI * invF;
      model.root.rotation.x = 0;
      model.root.visible = !bs.out;

      const moving = clamp(bs.speed / Math.max(0.5, spec.topSpeed), 0, 1);
      const wheelAng = t * moving * 18;
      for (const w of a.wheelsL) w.rotation.x = wheelAng;
      for (const w of a.wheelsR) w.rotation.x = wheelAng;
      for (const c of a.driveCans) c.mesh.rotation.x = wheelAng * 3;
      if (a.legs) for (const l of a.legs) l.set(t * 2.2, moving);

      spec.weapons.forEach((w, k) => {
        const ws = bs.w[k] || { spin: 0, ang: 0, anim: 0, act: 0 };
        const h = a.slots[w.slot];
        if (!h) return;
        if (h.rotor) h.rotor(ws.ang || t * ws.spin * 28);
        if (h.cans) h.cans((ws.ang || 0) * 3);
        if (h.blur) h.blur(ws.spin > 0.35);
        if (h.pose) h.pose(clamp(ws.anim || 0, 0, 1));
        if (h.fx) h.fx(ws.act > 0 ? 1 : 0, t, ws.anim || 0);
      });
    }

    function projectArena3D(s3, wx, wy, wz) {
      const THREE = root.BBEngine.THREE;
      const v = new THREE.Vector3(wx * s3.S, wy * s3.S, wz * s3.S);
      v.project(s3.cam);
      return { x: (v.x * 0.5 + 0.5) * STAGE_W, y: (-v.y * 0.5 + 0.5) * STAGE_H, behind: v.z > 1 };
    }

    // ---- frame --------------------------------------------------------------------------------------
    function render(view, t) {
      const g = ui.ctx, m = ui.match, k = m.bots[0].spec.k;
      const E = root.BBEngine, s3 = ui.camMode !== '2d' ? ensureArena3D() : null;

      if (s3 && E && E.renderer) {
        syncArenaBots3D(m.bots[0].build || ui.opts.build, m.bots[1].build);
        for (let i = 0; i < 2; i++) {
          poseArenaBot3D(s3.bots3d[i], m.bots[i].build || ui.opts.build, m.bots[i].spec, view.bots[i], t);
        }
        // Pose 3D Hazards
        const S = s3.S, hz = m.hz, hs = view.hz;
        s3.saws3d.forEach((sw, idx) => {
          const def = hz.saws[idx];
          if (!def) { sw.g.visible = false; return; }
          sw.g.visible = true;
          const up = hs.saws[idx] || 0;
          sw.g.position.set(def.x * S, 0, def.y * S);
          sw.blade.position.y = (-0.42 + up * 0.65) * S;
          sw.blade.rotation.x = t * 32;
        });
        if (hz.pit) {
          s3.pitGrp.visible = true;
          s3.pitGrp.position.set(hz.pit.x * S, 0, hz.pit.y * S);
          s3.pitLid.position.y = (0.02 - (hs.pit || 0) * 0.65) * S;
        } else s3.pitGrp.visible = false;

        if (hz.pulv) {
          s3.pulvGrp.visible = true;
          s3.pulvGrp.position.set(-4.8 * S, 1.35 * S, -4.8 * S);
          s3.pulvGrp.rotation.y = Math.atan2(hz.pulv.x + 4.8, hz.pulv.y + 4.8);
          s3.pulvPivot.rotation.x = (hs.pulv || 0) * 0.62;
        } else s3.pulvGrp.visible = false;

        if (hz.screws) {
          s3.screwGrp.visible = true;
          s3.screwGrp.position.set(0, 0.22 * S, 4.85 * S);
          s3.screwCyl.rotation.x = t * 8;
        } else s3.screwGrp.visible = false;

        // Position 3D Camera based on ui.camMode ('broadcast', 'chase', 'top3d')
        const b0 = view.bots[0], b1 = view.bots[1];
        const sh = shakeAt(m.events, t);
        const midX = ((b0.x + b1.x) * 0.5) * S, midZ = ((b0.y + b1.y) * 0.5) * S;
        const distBots = Math.hypot(b0.x - b1.x, b0.y - b1.y) * S;
        if (ui.camMode === 'chase') {
          const c = Math.cos(b0.th), s = Math.sin(b0.th);
          s3.cam.position.set((b0.x - c * 2.9) * S + sh[0] * 0.02, 2.15 * S, (b0.y - s * 2.9) * S + sh[1] * 0.02);
          s3.cam.lookAt((b0.x + c * 1.8) * S, 0.25 * S, (b0.y + s * 1.8) * S);
        } else if (ui.camMode === 'top3d') {
          s3.cam.position.set(midX * 0.2 + sh[0] * 0.02, 23.5, midZ * 0.2 + 5.2 + sh[1] * 0.02);
          s3.cam.lookAt(midX * 0.2, 0, midZ * 0.2);
        } else {
          // 'broadcast' dynamic stadium camera keeping both bots framed cleanly inside the central arena viewport
          const zoomDist = clamp(14.5 + distBots * 0.72, 14.5, 24.5);
          s3.cam.position.set(midX * 0.42 + sh[0] * 0.025, zoomDist * 0.68, midZ * 0.42 + zoomDist * 0.92 + sh[1] * 0.025);
          s3.cam.lookAt(midX * 0.52, 0.15 * S, midZ * 0.52);
        }
        s3.cam.updateMatrixWorld(true);
        if (E.invalidate) E.invalidate();
        E.renderer.render(s3.scn, s3.cam);

        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, STAGE_W, STAGE_H);
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
        g.drawImage(E.canvas, 0, 0, STAGE_W, STAGE_H);

        // Draw 3D-projected sparks, flames, damage numbers, and YOU/CPU floating badges
        const ev = m.events;
        for (let i = eventIndex(ev, t) - 1; i >= 0 && t - ev[i].t < 1.3; i--) {
          const e = ev[i], age = t - e.t;
          const pt = projectArena3D(s3, e.x, 0.25, e.y);
          if (pt.behind) continue;
          if (e.type === 'hit' && age < 0.65) {
            const nSpark = Math.round(clamp(e.dmg / 400, 10, 52)), life = 0.65, fade = 1 - age / life;
            g.globalCompositeOperation = 'lighter'; g.lineCap = 'round';
            for (let q = 0; q < nSpark; q++) {
              const a = hash(i * 131 + q, 1) * TAU, sp = 90 + hash(i * 131 + q, 2) * 380, d = sp * age * (1 - age * 0.6);
              const sx0 = pt.x + Math.cos(a) * d, sy0 = pt.y + Math.sin(a) * d * 0.65 - 90 * age + 180 * age * age;
              line(g, sx0, sy0, sx0 + Math.cos(a) * (8 + sp * 0.04), sy0 + Math.sin(a) * (6 + sp * 0.03) + 12 * age, 2.2, `rgba(255,${Math.round(160 + 95 * fade)},${Math.round(60 + 160 * fade * hash(q, i))},${fade})`);
            }
            if (age < 0.12) {
              const r = 24 + Math.sqrt(e.dmg) * 0.6;
              const fg = g.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, r);
              fg.addColorStop(0, 'rgba(255,255,245,0.98)'); fg.addColorStop(0.5, 'rgba(255,160,50,0.55)'); fg.addColorStop(1, 'rgba(255,90,20,0)');
              disc(g, pt.x, pt.y, r, fg);
            }
            g.globalCompositeOperation = 'source-over';
            if (e.dmg >= 3500 && age < 1.1) {
              g.globalAlpha = clamp(2 - age * 2, 0, 1); g.font = '800 22px "JetBrains Mono", monospace'; g.textAlign = 'center';
              g.lineWidth = 5; g.strokeStyle = 'rgba(0,0,0,0.9)'; g.fillStyle = e.to === 0 ? '#ff9a73' : '#ffe9a8';
              const txt = scaled(`${(e.dmg / 1000).toFixed(1)} KJ`, k);
              g.strokeText(txt, pt.x, pt.y - 28 - age * 42); g.fillText(txt, pt.x, pt.y - 28 - age * 42); g.globalAlpha = 1;
            }
          } else if (e.type === 'breach' && age < 1.3) {
            g.globalAlpha = clamp(1.6 - age * 1.4, 0, 1); g.font = '900 24px Inter, sans-serif'; g.textAlign = 'center'; g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.9)'; g.fillStyle = '#ff4433';
            g.strokeText('ARMOUR BREACHED!', pt.x, pt.y - 48 - age * 24); g.fillText('ARMOUR BREACHED!', pt.x, pt.y - 48 - age * 24); g.globalAlpha = 1;
          }
        }
        // Flame jets in 3D view
        hz.flames.forEach((f, idx) => {
          if (!hs.flames[idx]) return;
          const fp = projectArena3D(s3, f.x, 0.1, f.y);
          if (fp.behind) return;
          g.globalCompositeOperation = 'lighter';
          for (let q = 0; q < 14; q++) {
            const u = frac(q / 14 + t * 2.5);
            disc(g, fp.x + (hash(q, idx) - 0.5) * 28 * u, fp.y - u * 95, 10 + u * 28, `rgba(255,${Math.round(220 - 150 * u)},${Math.round(80 * (1 - u))},${0.55 * (1 - u)})`);
          }
          g.globalCompositeOperation = 'source-over';
        });

        // Floating YOU / CPU indicators above the 3D robots
        view.bots.forEach((bs, i) => {
          if (bs.out) return;
          const p = projectArena3D(s3, bs.x, 0.52 + Math.max(0, bs.air) * 0.85, bs.y);
          if (p.behind) return;
          g.font = '800 14px "JetBrains Mono", monospace'; g.textAlign = 'center';
          g.fillStyle = SIDE_COLORS[i];
          g.beginPath(); g.moveTo(p.x - 7, p.y - 10); g.lineTo(p.x + 7, p.y - 10); g.lineTo(p.x, p.y); g.closePath(); g.fill();
          g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,0.88)';
          const tag = i ? `CPU · ${m.bots[i].spec.name}` : `YOU · ${m.bots[i].spec.name}`;
          g.strokeText(tag, p.x, p.y - 15); g.fillText(tag, p.x, p.y - 15);
          if (bs.count > 0.5 && !bs.ko) {
            g.font = '900 54px Inter, sans-serif'; g.lineWidth = 8; g.fillStyle = '#ff3b30';
            g.strokeText(String(Math.min(C.KO_COUNT, Math.ceil(bs.count))), p.x, p.y + 42); g.fillText(String(Math.min(C.KO_COUNT, Math.ceil(bs.count))), p.x, p.y + 42);
          }
        });
        return;
      }

      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
      g.drawImage(ui.floor, 0, 0);
      // floor marks: add what is new; when a replay scrubs backwards, start the layer again
      if (t < ui.decalT) { ui.decalCtx.clearRect(0, 0, AS, AS); ui.decalIdx = 0; }
      for (const end = eventIndex(m.events, t); ui.decalIdx < end; ui.decalIdx++) stampDecal(ui.decalCtx, m.events[ui.decalIdx], ui.decalIdx);
      ui.decalT = t;
      const sh = shakeAt(m.events, t);
      g.save();
      g.beginPath(); g.rect(AX, AY, AS, AS); g.clip();
      g.translate(sh[0], sh[1]);
      g.drawImage(ui.decals, AX, AY);
      drawHazards(g, m.hz, view.hz, t);
      // the mouse-drive target
      if (ui.screen === 'match' && ui.mouseDrive && ui.mouse.inside) {
        const x = sx(ui.mouse.x), y = sy(ui.mouse.y);
        g.strokeStyle = 'rgba(255,90,31,0.9)'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 14, 0, TAU); g.moveTo(x - 22, y); g.lineTo(x + 22, y); g.moveTo(x, y - 22); g.lineTo(x, y + 22); g.stroke();
      }
      view.bots.forEach((bs, i) => {   // drop shadows first so one bot never shadows over the other
        if (bs.out) return;
        const sp = m.bots[i].spec, lift = Math.min(bs.air, 0.9);
        g.save(); g.translate(sx(bs.x) + 6 + lift * 34, sy(bs.y) + 8 + lift * 46); g.rotate(bs.th + bs.body); g.scale(PX, PX);
        trace(g, sp.hull); g.fillStyle = `rgba(0,0,0,${0.42 - lift * 0.2})`; g.fill(); g.restore();
      });
      const order = view.bots[0].air > view.bots[1].air ? [1, 0] : [0, 1];
      for (const i of order) {
        const bs = view.bots[i], sp = m.bots[i].spec;
        if (bs.out) continue;
        drawBot(g, sp, bs, t, sx(bs.x), sy(bs.y), PX);
      }
      for (const p of view.proj) {
        const a = Math.atan2(p.vy, p.vx), x = sx(p.x), y = sy(p.y);
        if (p.kind === 'net') { g.strokeStyle = 'rgba(235,235,225,0.8)'; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, 12, 0, TAU); g.moveTo(x - 12, y); g.lineTo(x + 12, y); g.moveTo(x, y - 12); g.lineTo(x, y + 12); g.stroke(); } else {
          line(g, x - Math.cos(a) * 26, y - Math.sin(a) * 26, x, y, 2, 'rgba(255,230,170,0.5)'); line(g, x - Math.cos(a) * 9, y - Math.sin(a) * 9, x, y, 4, '#f4f1e6');
        }
      }
      drawPulverizer(g, m.hz, view.hz);
      view.bots.forEach((bs, i) => drawSmoke(g, bs, t, i));
      drawEffects(g, m, t, k);
      g.restore();
      g.drawImage(ui.light, AX, AY);
      // labels that must stay readable sit above the lighting
      view.bots.forEach((bs, i) => {
        if (bs.out) return;
        const x = sx(bs.x), y = sy(bs.y), r = m.bots[i].spec.radius * PX;
        g.font = '700 14px "JetBrains Mono", monospace'; g.textAlign = 'center';
        g.fillStyle = SIDE_COLORS[i]; g.beginPath(); g.moveTo(x - 7, y - r - 22); g.lineTo(x + 7, y - r - 22); g.lineTo(x, y - r - 12); g.closePath(); g.fill();
        g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,0.8)'; g.strokeText(i ? 'CPU' : 'YOU', x, y - r - 27); g.fillText(i ? 'CPU' : 'YOU', x, y - r - 27);
        if (bs.count > 0.5 && !bs.ko) {
          g.font = '800 54px Inter, sans-serif'; g.lineWidth = 8; g.fillStyle = '#ff3b30';
          g.strokeText(String(Math.min(C.KO_COUNT, Math.ceil(bs.count))), x, y + 20); g.fillText(String(Math.min(C.KO_COUNT, Math.ceil(bs.count))), x, y + 20);
        }
      });
      if (m.hz.pit && t > m.hz.pit.openAt - 5 && t < m.hz.pit.openAt + 2 && Math.floor(t * 3) % 2 === 0) {
        g.font = '800 26px Inter, sans-serif'; g.textAlign = 'center'; g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.fillStyle = '#f2b632';
        g.strokeText(t < m.hz.pit.openAt ? 'PIT OPENING' : 'PIT OPEN', sx(0), AY + 46); g.fillText(t < m.hz.pit.openAt ? 'PIT OPENING' : 'PIT OPEN', sx(0), AY + 46);
      }
    }

    // ---- replay frames ------------------------------------------------------------------------------
    const mix = (a, b, f) => a + (b - a) * f;
    function frameAt(m, t) {
      const fr = m.frames, dtF = STEP * C.REC_EVERY;
      const i = clamp(Math.floor(t / dtF), 0, fr.length - 2), a = fr[i], b = fr[i + 1];
      const f = clamp((t - a.t) / Math.max(1e-6, b.t - a.t), 0, 1);
      // poses and rotor phases are blended so slow motion stays smooth; everything else is taken from the earlier frame
      return Object.assign({}, a, {
        t,
        bots: a.bots.map((p, k) => { const q = b.bots[k]; return Object.assign({}, p, { x: mix(p.x, q.x, f), y: mix(p.y, q.y, f), th: p.th + C.wrap(q.th - p.th) * f, body: mix(p.body, q.body, f), air: mix(p.air, q.air, f), w: p.w.map((w, j) => Object.assign({}, w, { spin: mix(w.spin, q.w[j].spin, f), ang: mix(w.ang, q.w[j].ang, f), anim: mix(w.anim, q.w[j].anim, f) })) }); }),
        proj: a.proj.map((p) => Object.assign({}, p, { x: p.x + p.vx * (t - a.t), y: p.y + p.vy * (t - a.t) })),
      });
    }

    // ---- opponents ----------------------------------------------------------------------------------
    function opponentList() {
      const ph = PH(), list = [], presets = ui.opts.presets || ph.PRESETS || {};
      for (const key of Object.keys(presets)) list.push({ id: 'preset:' + key, tag: 'HOUSE BOT', cfg: presets[key] });
      let garage = {};
      try { garage = JSON.parse(localStorage.getItem('bbd_garage_v2') || '{}') || {}; } catch (e) { garage = {}; }
      for (const name of Object.keys(garage)) if (garage[name] && typeof garage[name] === 'object') list.push({ id: 'garage:' + name, tag: 'YOUR GARAGE', cfg: Object.assign({ name }, garage[name]) });
      const mine = ui.opts.build.cfg || {};
      const out = [];
      for (const o of list) {
        // opponents fight in the player's weight class, one bot per side; a saved build that no longer computes is skipped
        try { o.build = ph.compute(Object.assign({}, o.cfg, { cls: mine.cls, cluster: false })); o.spec = C.botSpec(o.build); out.push(o); } catch (e) { /* unusable saved build */ }
      }
      return out;
    }

    // ---- DOM ----------------------------------------------------------------------------------------
    const el = (cls, html) => { const d = document.createElement('div'); d.className = cls; if (html !== undefined) d.innerHTML = html; return d; };
    const seg = (name, items, cur) => `<div class="bba-seg">${items.map(([v, label]) => `<button class="bba-btn${v === cur ? ' on' : ''}" data-act="${name}" data-v="${v}">${label}</button>`).join('')}</div>`;

    function tapeRows(a, b) {
      const sa = a.spec, sb = b.spec, ph = PH(), k = sa.k;
      const weapon = (s) => (s.primary >= 0 ? s.weapons[s.primary] : null);
      const energy = (s) => { const w = weapon(s); return w ? (w.mode === 'hold' ? w.dps : w.energy) : 0; };
      const flipped = (s) => (s.invertible ? 'RUNS INVERTED' : s.selfRights ? 'SELF-RIGHTS' : 'STRANDED');
      const armour = (s) => `${s.armour.front.t} MM ${s.armour.front.mat}`;
      const hp = (s) => C.FACES.reduce((n, f) => n + s.armour[f].hp, 0);
      // [label, player text, opponent text, player number, opponent number] — the bigger number is highlighted
      return [
        ['WEIGHT', scaled(`${sa.massLb.toFixed(0)} LB`, k), scaled(`${sb.massLb.toFixed(0)} LB`, k), sa.massLb, sb.massLb],
        ['TOP SPEED', scaled(`${(sa.topSpeed * ph.MS_TO_MPH).toFixed(1)} MPH`, k), scaled(`${(sb.topSpeed * ph.MS_TO_MPH).toFixed(1)} MPH`, k), sa.topSpeed, sb.topSpeed],
        ['PUSH', scaled(`${(sa.push * ph.N_TO_LBF).toFixed(0)} LBF`, k), scaled(`${(sb.push * ph.N_TO_LBF).toFixed(0)} LBF`, k), sa.push, sb.push],
        ['ARMOUR', scaled(armour(sa), k), scaled(armour(sb), k), hp(sa), hp(sb)],
        ['WEAPON', weapon(sa) ? weapon(sa).name : 'NONE', weapon(sb) ? weapon(sb).name : 'NONE', 0, 0],
        ['WEAPON ENERGY', scaled(`${(energy(sa) / 1000).toFixed(1)} KJ`, k), scaled(`${(energy(sb) / 1000).toFixed(1)} KJ`, k), energy(sa), energy(sb)],
        ['IF FLIPPED', flipped(sa), flipped(sb), 0, 0],
        ['TECH CHECK', sa.legal ? 'PASSED' : 'FAILS CHECKS', sb.legal ? 'PASSED' : 'FAILS CHECKS', 0, 0],
      ].map(([label, ta, tb, na, nb]) => `<div class="bba-tape-row"><b class="${na > nb ? 'win' : ''}">${esc(ta)}</b><span>${label}</span><b class="${nb > na ? 'win' : ''}">${esc(tb)}</b></div>`).join('');
    }
    // Render a true 3D beauty portrait of each bot for the Tale of the Tape card (with 2D fallback)
    function portrait(canvas, spec, buildObj) {
      const g = canvas.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, canvas.width, canvas.height);
      const E = root.BBEngine, Mdl = root.BBModels;
      if (E && Mdl && buildObj) {
        try {
          const THREE = E.THREE;
          const pScn = new THREE.Scene();
          if (E.scene && E.scene.environment) pScn.environment = E.scene.environment;
          pScn.add(new THREE.HemisphereLight('#dce8ff', '#161820', 0.78));
          const kl = new THREE.DirectionalLight('#fff6e5', 1.85); kl.position.set(-4, 7, 5); pScn.add(kl);
          const fl = new THREE.DirectionalLight('#6eb4ff', 0.78); fl.position.set(5, 4, 4); pScn.add(fl);
          const rl = new THREE.DirectionalLight('#ff6a2b', 0.98); rl.position.set(2, 4, -6); pScn.add(rl);
          const botM = Mdl.buildBot(buildObj);
          pScn.add(botM.root);
          const reach = spec.weapons.reduce((r, w) => Math.max(r, Math.min(w.reach || 0, spec.radius + 0.55)), spec.radius);
          const rad = Math.max(0.62, reach) * (Mdl.SCALE || 2);
          const pCam = new THREE.PerspectiveCamera(26, STAGE_W / STAGE_H, 0.1, 50);
          pCam.position.set(-rad * 1.95, rad * 1.45, rad * 2.35);
          pCam.lookAt(0, rad * 0.12, rad * 0.12);
          pCam.updateMatrixWorld(true);
          if (E.invalidate) E.invalidate();
          E.renderer.render(pScn, pCam);
          const sw = E.canvas.width, sh = E.canvas.height, side = Math.min(sw, sh) * 0.88;
          g.drawImage(E.canvas, (sw - side) / 2, (sh - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
          Mdl.disposeBot(botM);
          return;
        } catch (err) { /* fallback to 2D below */ }
      }
      const reach = spec.weapons.reduce((r, w) => Math.max(r, Math.min(w.reach, spec.radius + 0.6)), spec.radius);
      const still = { th: -Math.PI / 2, body: 0, air: 0, inv: false, speed: 0, slow: 0, stun: 0, hp: [1, 1, 1, 1, 1], w: spec.weapons.map(() => ({ spin: 0, on: true, anim: 0, act: 0, ang: 0.6, cd: 1, dead: false })) };
      drawBot(g, spec, still, 0, canvas.width / 2, canvas.height / 2 + 6, (canvas.width * 0.46) / reach);
    }

    function showPre() {
      ui.screen = 'pre';
      const me = { spec: C.botSpec(ui.opts.build), build: ui.opts.build }, opp = ui.opps.find((o) => o.id === ui.oppId) || ui.opps[0];
      ui.oppId = opp ? opp.id : null;
      const k = me.spec.k;
      ui.layer.innerHTML = `
        <div class="bba-pre">
          <div class="bba-panel bba-opps"><div class="bba-h"><i></i>01 · CHOOSE OPPONENT</div>
            <div class="bba-list">${ui.opps.map((o) => `<button class="bba-opp${o.id === ui.oppId ? ' on' : ''}" data-act="opp" data-v="${esc(o.id)}"><b>${esc(o.spec.name)}</b><span>${o.tag} · ${esc(o.spec.primary >= 0 ? o.spec.weapons[o.spec.primary].name : 'NO ACTIVE WEAPON')}</span></button>`).join('') || '<div class="bba-note">NO OPPONENTS AVAILABLE</div>'}</div>
          </div>
          <div class="bba-panel bba-setup"><div class="bba-h"><i></i>02 · MATCH SETUP</div>
            <div class="bba-label">AI DRIVER</div>${seg('diff', Object.keys(C.LEVELS).map((v) => [v, C.LEVELS[v].name]), ui.diff)}
            <div class="bba-label">ARENA CAMERA VIEW</div>${seg('cammode', [['broadcast', '3D BROADCAST'], ['chase', '3D CHASE CAM'], ['top3d', '3D OVERHEAD'], ['2d', '2D TACTICAL']], ui.camMode)}
            <div class="bba-label">ARENA HAZARDS</div><div class="bba-seg wrap">${HAZARDS.map(([v, label]) => `<button class="bba-btn${ui.hazards[v] ? ' on' : ''}" data-act="hazard" data-v="${v}">${label}</button>`).join('')}</div>
            <div class="bba-label">DRIVING</div>${seg('drive', [['keys', 'KEYBOARD'], ['mouse', 'MOUSE: FOLLOW POINTER']], ui.mouseDrive ? 'mouse' : 'keys')}
            <div class="bba-seg"><button class="bba-btn${ui.autoFire ? ' on' : ''}" data-act="autofire">AUTO-FIRE WEAPONS</button><button class="bba-btn${ui.autopilot ? ' on' : ''}" data-act="autopilot">AUTOPILOT (WATCH)</button></div>
            <div class="bba-legend"><b>W A S D</b> · DRIVE${me.spec.strafe ? ' &nbsp; <b>Q E</b> · STRAFE' : ''}<br><b>SPACE</b> · FIRE${keyPlan(me.spec).multi ? ' THE ' + (keyPlan(me.spec).alone || 'main').toUpperCase() + ' WEAPON<br><b>SPACE + ARROW</b> · FIRE THAT SIDE: <b>↑</b> FRONT &nbsp; <b>↓</b> REAR &nbsp; <b>←</b> LEFT &nbsp; <b>→</b> RIGHT' : ' THE WEAPON'}<br><b>M</b> · MOUSE DRIVE &nbsp; <b>F</b> · AUTO-FIRE &nbsp; <b>P</b> · PAUSE</div>
            <div class="bba-rules">${clock(C.MATCH_S)} MATCH · ${C.KO_COUNT} S COUNT-OUT · 3 JUDGES: DAMAGE 5 · AGGRESSION 3 · CONTROL 3</div>
            <button class="bba-start" data-act="start"${opp ? '' : ' disabled'}>START MATCH</button>
          </div>
          <div class="bba-panel bba-tape"><div class="bba-h"><i></i>03 · TALE OF THE TAPE · ${esc(me.spec.className)}</div>
            <div class="bba-vs"><div><canvas width="230" height="230" data-pt="0"></canvas><b style="color:${SIDE_COLORS[0]}">${esc(me.spec.name)}</b><span>YOU</span></div><em>VS</em><div><canvas width="230" height="230" data-pt="1"></canvas><b style="color:${SIDE_COLORS[1]}">${esc(opp ? opp.spec.name : '—')}</b><span>${opp ? C.LEVELS[ui.diff].name + ' AI' : ''}</span></div></div>
            ${opp ? tapeRows(me, opp) : ''}
            <div class="bba-note">${scaled('ARENA 10 M SQUARE', k)} · 3D BATTLEBOX · OPPONENT BUILT TO YOUR WEIGHT CLASS</div>
          </div>
        </div>`;
      portrait(ui.layer.querySelector('[data-pt="0"]'), me.spec, me.build);
      if (opp) portrait(ui.layer.querySelector('[data-pt="1"]'), opp.spec, opp.build);
    }

    function botPanel(i, spec) {
      const k = spec.k;
      return `<div class="bba-panel bba-side s${i}">
        <div class="bba-name" style="border-color:${SIDE_COLORS[i]}"><span>${i ? 'OPPONENT · ' + C.LEVELS[ui.diff].name : 'YOU'}</span><b>${esc(spec.name)}</b><em id="bba-st${i}"></em></div>
        <div class="bba-label">ARMOUR</div>
        ${FACE_NAMES.map((f, j) => `<div class="bba-bar"><span>${f}</span><i><u id="bba-hp${i}${j}"></u></i><b id="bba-hv${i}${j}">100</b></div>`).join('')}
        <div class="bba-label">DRIVE + POWER</div>
        <div class="bba-chips"><span id="bba-dl${i}">LEFT</span><span id="bba-dr${i}">RIGHT</span><span id="bba-bt${i}">BATTERY</span></div>
        <div class="bba-label">WEAPONS</div>
        ${spec.weapons.map((w, j) => `<button class="bba-weapon" data-act="weapon" data-bot="${i}" data-v="${w.slot}"${i ? ' disabled' : ''}><span>${w.slot.toUpperCase()}${!i && keyPlan(spec).hint(w) ? ` · <kbd>${keyPlan(spec).hint(w)}</kbd>` : ''}</span><b>${esc(w.name)}</b><i><u id="bba-wb${i}${j}"></u></i><em id="bba-wv${i}${j}"></em></button>`).join('') || '<div class="bba-note">NO MODULES FITTED</div>'}
        ${i ? '<div class="bba-label">AI</div><div class="bba-ai" id="bba-ai">—</div><div class="bba-label">CAMERA VIEW</div><div class="bba-seg wrap">' + [['broadcast', '3D TV'], ['chase', 'CHASE'], ['top3d', 'TOP 3D'], ['2d', '2D MAP']].map(([v, l]) => `<button class="bba-btn${ui.camMode === v ? ' on' : ''}" data-act="cammode" data-v="${v}">${l}</button>`).join('') + '</div>' : `
        <div class="bba-label">DRIVE PAD</div>
        <div class="bba-pad">${[['fl', '&#8598;'], ['f', '&#9650;'], ['fr', '&#8599;'], ['l', '&#9664;'], ['fire', 'FIRE'], ['r', '&#9654;'], ['bl', '&#8601;'], ['b', '&#9660;'], ['br', '&#8600;']].map(([v, s]) => `<button class="bba-btn${v === 'fire' ? ' hot' : ''}" data-pad="${v}">${s}</button>`).join('')}</div>
        <div class="bba-seg"><button class="bba-btn" data-act="mousedrive" id="bba-md">MOUSE DRIVE</button><button class="bba-btn" data-act="autofire" id="bba-af">AUTO-FIRE</button></div>`}
        <div class="bba-note">${scaled(`${spec.massLb.toFixed(0)} LB`, k)} · ${esc(spec.className)}</div>
      </div>`;
    }

    function startMatch() {
      const opp = ui.opps.find((o) => o.id === ui.oppId);
      if (!opp) return;
      ui.seed = (ui.seed * 1103515245 + 12345) & 0x7fffffff;
      ui.match = C.createMatch(ui.opts.build, opp.build, { seed: ui.seed, difficulty: ui.diff, hazards: ui.hazards });
      ui.match.bots[0].build = ui.opts.build;
      ui.match.bots[1].build = opp.build;
      syncArenaBots3D(ui.opts.build, opp.build);
      ui.floor = buildFloor(ui.match.hz);
      ui.decalCtx.clearRect(0, 0, AS, AS); ui.decalIdx = 0; ui.decalT = 0;
      ui.screen = 'match'; ui.paused = false; ui.acc = 0; ui.endWait = 0; ui.ticker = 0; ui.keys.clear(); ui.pad = {}; ui.held = {};
      ui.layer.innerHTML = `
        <div class="bba-top"><div class="bba-tn" style="color:${SIDE_COLORS[0]}">${esc(ui.match.bots[0].spec.name)}</div><div class="bba-clock" id="bba-clock">3:00</div><div class="bba-tn r" style="color:${SIDE_COLORS[1]}">${esc(ui.match.bots[1].spec.name)}</div></div>
        ${botPanel(0, ui.match.bots[0].spec)}${botPanel(1, ui.match.bots[1].spec)}
        <div class="bba-ticker" id="bba-ticker"></div>
        <div class="bba-banner" id="bba-banner"></div>
        <div class="bba-float" id="bba-float"></div>`;
      syncToggles();
    }
    function syncToggles() {
      const md = document.getElementById('bba-md'), af = document.getElementById('bba-af');
      if (md) md.classList.toggle('on', ui.mouseDrive);
      if (af) af.classList.toggle('on', ui.autoFire);
    }

    // the HUD is driven by a snapshot, so it shows the right thing in live play and at any point of a replay
    function updateHud(view, t) {
      const m = ui.match, set = (id, text) => { const d = document.getElementById(id); if (d && d.textContent !== text) d.textContent = text; };
      set('bba-clock', clock(m.limit - t));
      const ck = document.getElementById('bba-clock');
      if (ck) ck.classList.toggle('late', m.limit - t <= 30);
      view.bots.forEach((bs, i) => {
        const sp = m.bots[i].spec;
        bs.hp.forEach((h, j) => {
          const bar = document.getElementById(`bba-hp${i}${j}`);
          if (!bar) return;
          bar.style.width = `${Math.max(0, h * 100).toFixed(1)}%`; bar.className = h <= 0 ? 'dead' : h < 0.35 ? 'low' : h < 0.7 ? 'mid' : '';
          set(`bba-hv${i}${j}`, h <= 0 ? 'OPEN' : `${Math.ceil(h * 100)}`);
        });
        [['dl', bs.sub[0] && bs.power], ['dr', bs.sub[1] && bs.power], ['bt', bs.sub[2] && bs.power]].forEach(([id, ok], j) => {
          const d = document.getElementById(`bba-${id}${i}`);
          if (d) { d.className = ok ? 'ok' : 'bad'; if (j === 2) set(`bba-bt${i}`, bs.fire > 0 ? 'BATTERY FIRE' : bs.power ? 'BATTERY' : 'NO POWER'); }
        });
        sp.weapons.forEach((w, j) => {
          const ws = bs.w[j], bar = document.getElementById(`bba-wb${i}${j}`);
          if (!bar) return;
          let pct = 1, text = 'FITTED';
          if (ws.dead) { pct = 0; text = 'DISABLED'; }
          else if (w.mode === 'spin') { pct = ws.spin; text = ws.on ? `${Math.round(ws.spin * 100)}% SPIN` : 'OFF'; }
          else if (w.mode === 'hold') { pct = w.fuel ? ws.fuel / w.fuel : 0; text = ws.fuel > 0 ? `${Math.ceil(ws.fuel)} S FUEL` : 'EMPTY'; }
          else if (w.mode !== 'passive') {
            pct = 1 - clamp(ws.cd / w.cycle, 0, 1);
            const ammo = Number.isFinite(w.shots) ? `${Math.max(0, ws.shots)} SHOTS` : '';
            text = Number.isFinite(w.shots) && ws.shots <= 0 ? 'EMPTY' : ws.cd > 0 ? (ammo || 'RECHARGING') : ammo ? `READY · ${ammo}` : 'READY';
          }
          bar.style.width = `${(pct * 100).toFixed(0)}%`; bar.className = ws.dead ? 'dead' : pct >= 0.8 ? 'ready' : '';
          set(`bba-wv${i}${j}`, text);
        });
        const status = bs.out ? 'IN THE PIT' : bs.ko ? 'KNOCKED OUT' : bs.count > 0.5 ? `COUNT ${Math.min(C.KO_COUNT, Math.ceil(bs.count))}` : bs.inv ? (sp.invertible ? 'INVERTED' : bs.righting > 0 ? 'SELF-RIGHTING' : 'FLIPPED') : bs.stun > 0 ? 'STUNNED' : bs.slow > 0 ? 'TANGLED' : bs.held > 0 ? 'HELD' : '';
        set(`bba-st${i}`, status);
      });
      set('bba-ai', AI_LABEL[view.ai] || String(view.ai || '').toUpperCase());
      // commentary: the latest thing worth saying, for a few seconds
      const ev = m.events;
      let msg = '';
      for (let i = eventIndex(ev, t) - 1; i >= 0 && t - ev[i].t < 3.5; i--) if (ev[i].text) { msg = ev[i].text; break; }
      set('bba-ticker', msg);
      const tk = document.getElementById('bba-ticker');
      if (tk) tk.style.opacity = msg ? '1' : '0';
    }

    function showResult() {
      const m = ui.match, r = m.result, k = m.bots[0].spec.k, won = r.winner === 0;
      ui.screen = 'result';
      const how = r.method === 'KO' ? `KNOCKOUT AT ${clock(m.limit - r.time)} ON THE CLOCK` : `${r.doubleKo ? 'DOUBLE KNOCKOUT · ' : ''}JUDGES' DECISION ${r.split}${r.split === '2-1' ? ' (SPLIT)' : ' (UNANIMOUS)'}`;
      const cats = [['damage', 'DAMAGE', 5], ['aggression', 'AGGRESSION', 3], ['control', 'CONTROL', 3]];
      const kj = (v) => scaled(`${(v / 1000).toFixed(1)} KJ`, k);
      const fl = document.getElementById('bba-float');
      if (!fl) return;
      fl.innerHTML = `<div class="bba-panel bba-result">
        <div class="bba-res-head ${won ? 'won' : 'lost'}"><span>${won ? 'YOU WIN' : 'YOU LOSE'}</span><b>${esc(m.bots[r.winner].spec.name)}</b><em>${how}</em></div>
        <div class="bba-judges"><div class="bba-jrow head"><span></span>${cats.map((c) => `<span>${c[1]} / ${c[2]}</span>`).join('')}<span>TOTAL / 11</span><span>VOTE</span></div>
          ${r.judges.map((j) => `<div class="bba-jrow"><span>${j.name}</span>${cats.map((c) => `<b>${j.scores[c[0]][0]} – ${j.scores[c[0]][1]}</b>`).join('')}<b>${j.total[0]} – ${j.total[1]}</b><b style="color:${SIDE_COLORS[j.vote]}">${j.vote ? 'CPU' : 'YOU'}</b></div>`).join('')}
        </div>
        ${r.method === 'KO' ? '<div class="bba-note">A KNOCKOUT ENDS THE FIGHT; THE CARDS SHOW HOW THE JUDGES HAD IT WHEN IT STOPPED</div>' : ''}
        <div class="bba-stats">${[['DAMAGE DEALT', kj(r.stats[0].damage), kj(r.stats[1].damage)], ['HITS LANDED', r.stats[0].hits, r.stats[1].hits], ['BIGGEST HIT', kj(r.stats[0].biggest), kj(r.stats[1].biggest)], ['PLATES BREACHED', r.stats[0].breaches, r.stats[1].breaches], ['SYSTEMS DISABLED', r.stats[0].disables, r.stats[1].disables], ['FLIPS', r.stats[0].flips, r.stats[1].flips]].map((s) => `<div class="bba-tape-row"><b>${esc(s[1])}</b><span>${s[0]}</span><b>${esc(s[2])}</b></div>`).join('')}</div>
        <div class="bba-seg"><button class="bba-btn hot" data-act="replay">INSTANT REPLAY</button><button class="bba-btn hot" data-act="bighit"${m.big ? '' : ' disabled'}>BIGGEST HIT</button><button class="bba-btn" data-act="rematch">REMATCH</button><button class="bba-btn" data-act="newopp">NEW OPPONENT</button></div>
      </div>`;
    }

    function showReplay(at) {
      const m = ui.match;
      ui.screen = 'replay';
      ui.rp = { t: clamp(at, 0, m.t), speed: ui.rp ? ui.rp.speed : 1, playing: true };
      const fl = document.getElementById('bba-float');
      if (!fl) return;
      fl.innerHTML = `<div class="bba-panel bba-replay">
        <div class="bba-rp-row"><b class="bba-rp-tag">REPLAY</b><button class="bba-btn" data-act="rp-play" id="bba-rp-play">PAUSE</button>
          <input type="range" id="bba-rp-seek" min="0" max="${m.t.toFixed(2)}" step="0.01" value="${ui.rp.t.toFixed(2)}"><b id="bba-rp-time">0:00</b></div>
        <div class="bba-rp-row">${seg('rp-speed', [[0.25, '0.25x'], [0.5, '0.5x'], [1, '1x'], [2, '2x']], ui.rp.speed)}
          <button class="bba-btn hot" data-act="bighit"${m.big ? '' : ' disabled'}>BIGGEST HIT</button><button class="bba-btn" data-act="rp-start">FROM THE START</button><button class="bba-btn" data-act="rp-exit">RESULT</button></div>
      </div>`;
    }
    const bigHitTime = (m) => Math.max(0, m.big.t - 1.5);

    // ---- input --------------------------------------------------------------------------------------
    const KEY_USED = /^(Key[WASDQEMFP]|Arrow(Up|Down|Left|Right)|Space|Digit[1-5]|Numpad[1-5]|Escape)$/;
    const ARROW_SLOT = { ArrowUp: 'front', ArrowDown: 'rear', ArrowLeft: 'left', ArrowRight: 'right' };
    const ARROW_GLYPH = { front: '↑', rear: '↓', left: '←', right: '→' };
    // which key combination fires which weapon of a bot
    function keyPlan(spec) {
      const act = spec.weapons.filter((w) => w.mode !== 'passive');
      const slots = new Set(act.map((w) => w.slot));
      const multi = act.length > 1;
      const alone = multi ? (slots.has('top') ? 'top' : spec.primary >= 0 ? spec.weapons[spec.primary].slot : null) : null;
      return { multi, slots, alone, hint: (w) => (w.mode === 'passive' ? '' : !multi || w.slot === alone ? 'SPACE' : ARROW_GLYPH[w.slot] ? `SPACE + ${ARROW_GLYPH[w.slot]}` : String(C.SLOTS.indexOf(w.slot) + 1)) };
    }
    function readInput() {
      const k = ui.keys, p = ui.pad, on = (...codes) => codes.some((c) => k.has(c));
      // W A S D drive; the arrow keys are kept for choosing a weapon
      const fwd = on('KeyW') || p.f || p.fl || p.fr, back = on('KeyS') || p.b || p.bl || p.br;
      const left = on('KeyA') || p.l || p.fl || p.bl, right = on('KeyD') || p.r || p.fr || p.br;
      const manual = fwd || back || left || right;
      const fire = {};
      C.SLOTS.forEach((s, i) => { fire[s] = on(`Digit${i + 1}`, `Numpad${i + 1}`) || !!ui.held[s]; });
      // SPACE fires. With one weapon it fires that weapon; with several, SPACE + an arrow fires the weapon on that
      // side (up = front, down = rear, left, right) and SPACE alone fires the top weapon (or the primary if the top is empty).
      let primary = !!p.fire || (ui.mouseDrive && ui.mouse.down);
      if (on('Space')) {
        const plan = keyPlan(ui.match.bots[0].spec);
        if (!plan.multi) primary = true;
        else {
          let picked = false;
          for (const code of Object.keys(ARROW_SLOT)) if (k.has(code)) { picked = true; if (plan.slots.has(ARROW_SLOT[code])) fire[ARROW_SLOT[code]] = true; }
          if (!picked) { if (plan.alone) fire[plan.alone] = true; else primary = true; }
        }
      }
      return {
        throttle: (fwd ? 1 : 0) - (back ? 1 : 0), turn: (right ? 1 : 0) - (left ? 1 : 0), strafe: (on('KeyE') ? 1 : 0) - (on('KeyQ') ? 1 : 0),
        primary, fire, autoFire: ui.autoFire,
        // keys and the pad override the pointer, so the two can be mixed
        target: ui.mouseDrive && ui.mouse.inside && !manual ? { x: ui.mouse.x, y: ui.mouse.y } : null,
      };
    }
    function onKey(e) {
      if (!ui || !KEY_USED.test(e.code) || /INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')) return;
      e.preventDefault(); e.stopPropagation();   // the designer underneath must not see arena keys
      const down = e.type === 'keydown';
      if (down) ui.keys.add(e.code); else ui.keys.delete(e.code);
      if (!down || e.repeat || ui.screen !== 'match') return;
      if (e.code === 'KeyM') { ui.mouseDrive = !ui.mouseDrive; syncToggles(); }
      if (e.code === 'KeyF') { ui.autoFire = !ui.autoFire; syncToggles(); }
      if (e.code === 'KeyP' || e.code === 'Escape') togglePause();
    }
    function togglePause() {
      if (ui.screen !== 'match' || ui.match.over) return;
      ui.paused = !ui.paused;
      const b = document.getElementById('bba-banner');
      if (b) { b.textContent = ui.paused ? 'PAUSED' : ''; b.style.opacity = ui.paused ? '1' : '0'; }
      const pb = ui.root.querySelector('[data-act="pause"]');
      if (pb) pb.textContent = ui.paused ? 'RESUME' : 'PAUSE';
    }
    function stagePoint(e) {
      const r = ui.stage.getBoundingClientRect(), s = r.width / STAGE_W || 1;
      return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
    }
    function onPointer(e) {
      if (!ui) return;
      const p = stagePoint(e);
      ui.mouse.x = (p.x - AX) / PX - ARENA; ui.mouse.y = (p.y - AY) / PX - ARENA;
      ui.mouse.inside = Math.abs(ui.mouse.x) <= ARENA && Math.abs(ui.mouse.y) <= ARENA;
      if (e.type === 'pointerdown') {
        const pad = e.target.closest && e.target.closest('[data-pad]'), wb = e.target.closest && e.target.closest('[data-act="weapon"]');
        if (pad) ui.pad[pad.dataset.pad] = true;
        else if (wb && wb.dataset.bot === '0') ui.held[wb.dataset.v] = true;
        else if (e.target === ui.canvas || e.target === ui.layer) ui.mouse.down = true;
      } else if (e.type === 'pointerup' || e.type === 'pointercancel') { ui.pad = {}; ui.held = {}; ui.mouse.down = false; }
    }
    function onClick(e) {
      const b = e.target.closest && e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      const act = b.dataset.act, v = b.dataset.v;
      if (act === 'exit') return api.close();
      if (act === 'pause') return togglePause();
      if (act === 'opp') { ui.oppId = v; return showPre(); }
      if (act === 'diff') { ui.diff = v; return showPre(); }
      if (act === 'cammode') {
        ui.camMode = v || 'broadcast';
        if (ui.screen === 'pre') return showPre();
        ui.root.querySelectorAll('[data-act="cammode"]').forEach((q) => q.classList.toggle('on', q.dataset.v === ui.camMode));
        return undefined;
      }
      if (act === 'hazard') { ui.hazards[v] = !ui.hazards[v]; return showPre(); }
      if (act === 'drive') { ui.mouseDrive = v === 'mouse'; return showPre(); }
      if (act === 'autopilot') { ui.autopilot = !ui.autopilot; return showPre(); }
      if (act === 'autofire') { ui.autoFire = !ui.autoFire; return ui.screen === 'pre' ? showPre() : syncToggles(); }
      if (act === 'mousedrive') { ui.mouseDrive = !ui.mouseDrive; return syncToggles(); }
      if (act === 'start' || act === 'rematch') return startMatch();
      if (act === 'newopp') return showPre();
      if (act === 'replay') return showReplay(0);
      if (act === 'bighit') return ui.match.big && showReplay(bigHitTime(ui.match));
      if (act === 'rp-exit') return showResult();
      if (act === 'rp-start') { ui.rp.t = 0; ui.rp.playing = true; return undefined; }
      if (act === 'rp-play') { if (!ui.rp.playing && ui.rp.t >= ui.match.t - 0.01) ui.rp.t = 0; ui.rp.playing = !ui.rp.playing; return undefined; }
      if (act === 'rp-speed') { ui.rp.speed = Number(v) || 1; b.parentNode.querySelectorAll('.bba-btn').forEach((q) => q.classList.toggle('on', q === b)); }
      return undefined;
    }
    function onSeek(e) {
      if (ui && ui.screen === 'replay' && e.target.id === 'bba-rp-seek') { ui.rp.t = Number(e.target.value) || 0; ui.rp.playing = false; }
    }
    function fit() {
      const s = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
      ui.stage.style.transform = `translate(${((window.innerWidth - STAGE_W * s) / 2).toFixed(1)}px, ${((window.innerHeight - STAGE_H * s) / 2).toFixed(1)}px) scale(${s.toFixed(4)})`;
    }

    // ---- main loop ----------------------------------------------------------------------------------
    function frame(ts) {
      if (!ui) return;
      ui.raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, Math.max(0, (ts - ui.lastTs) / 1000) || 0);
      ui.lastTs = ts; ui.frameNo++;
      const m = ui.match;
      if (ui.screen === 'pre' || !m) {
        // Render the 3D BattleBox behind the pre-match lobby card
        const E = root.BBEngine, s3 = ensureArena3D();
        if (s3 && E && E.renderer) {
          const ang = (ts * 0.00025) % TAU;
          s3.cam.position.set(Math.sin(ang) * 14.5, 9.8, Math.cos(ang) * 14.5);
          s3.cam.lookAt(0, 0.4, 0);
          s3.cam.updateMatrixWorld(true);
          if (E.invalidate) E.invalidate();
          E.renderer.render(s3.scn, s3.cam);
          ui.ctx.setTransform(1, 0, 0, 1, 0, 0);
          ui.ctx.drawImage(E.canvas, 0, 0, STAGE_W, STAGE_H);
        } else {
          ui.ctx.setTransform(1, 0, 0, 1, 0, 0); ui.ctx.drawImage(ui.floor, 0, 0); ui.ctx.drawImage(ui.light, AX, AY);
        }
        return;
      }
      let view, t;
      if (ui.screen === 'match') {
        if (!ui.paused && !m.over) {
          ui.acc += dt;
          // fixed steps keep the sim identical whatever the frame rate; a long stall is dropped rather than replayed fast
          for (let n = 0; ui.acc >= STEP && n < 6 && !m.over; n++) { C.stepMatch(m, STEP, ui.autopilot ? null : readInput()); ui.acc -= STEP; }
          if (ui.acc > STEP * 6) ui.acc = 0;
        }
        if (m.over) {
          if (!ui.endWait) { const b = document.getElementById('bba-banner'); if (b) { b.textContent = m.result.method === 'KO' ? 'KNOCKOUT' : 'TIME'; b.style.opacity = '1'; } }
          ui.endWait += dt;
          if (ui.endWait > 2.2) { const b = document.getElementById('bba-banner'); if (b) b.style.opacity = '0'; showResult(); }
        }
        view = C.snap(m); t = m.t + ui.endWait;
      } else if (ui.screen === 'result') { ui.endWait += dt; view = m.frames[m.frames.length - 1]; t = m.t + ui.endWait; } else {
        const rp = ui.rp;
        if (rp.playing) { rp.t += dt * rp.speed; if (rp.t >= m.t) { rp.t = m.t; rp.playing = false; } }
        view = frameAt(m, rp.t); t = rp.t;
        const seek = document.getElementById('bba-rp-seek'), play = document.getElementById('bba-rp-play'), time = document.getElementById('bba-rp-time');
        if (seek && document.activeElement !== seek) seek.value = rp.t.toFixed(2);
        if (play) play.textContent = rp.playing ? 'PAUSE' : 'PLAY';
        if (time) time.textContent = `${clock(m.limit - rp.t)} · ${rp.speed}x`;
      }
      render(view, t);
      if (ui.frameNo % 4 === 0 || ui.screen === 'replay') updateHud(view, Math.min(t, m.t));
    }

    // ---- public API ---------------------------------------------------------------------------------
    const api = {
      /** Show the arena for a BBPhysics build: BBArena.open({ build, presets, onClose }). */
      open(opts) {
        if (ui) api.close();
        if (!opts || !opts.build) throw new Error('BBArena.open needs { build }');
        const rootEl = el('bba-root'), stage = el('bba-stage'), canvas = makeCanvas(STAGE_W, STAGE_H), layer = el('bba-layer');
        canvas.className = 'bba-canvas';
        stage.appendChild(canvas); stage.appendChild(layer);
        stage.appendChild(el('bba-corner', '<button class="bba-btn" data-act="pause">PAUSE</button><button class="bba-btn hot" data-act="exit">EXIT ARENA</button>'));
        rootEl.appendChild(stage); document.body.appendChild(rootEl);
        const decals = makeCanvas(AS, AS);
        ui = {
          opts, root: rootEl, stage, canvas, layer, ctx: canvas.getContext('2d'), decals, decalCtx: decals.getContext('2d'), decalIdx: 0, decalT: 0,
          floor: null, light: buildLight(), screen: 'pre', match: null, opps: [], oppId: null, diff: 'veteran', camMode: 'broadcast', scn3d: null,
          hazards: { saws: true, pulverizer: true, screws: true, flames: true, pit: true },
          keys: new Set(), pad: {}, held: {}, mouse: { x: 0, y: 0, inside: false, down: false }, mouseDrive: false, autoFire: false, autopilot: false,
          paused: false, acc: 0, endWait: 0, lastTs: 0, frameNo: 0, raf: 0, rp: null, seed: (Date.now() & 0x7fffffff) || 1,
        };
        ui.floor = buildFloor({ saws: [], flames: [], pulv: null, screws: null, pit: null });
        ui.opps = opponentList();
        rootEl.addEventListener('click', onClick);
        rootEl.addEventListener('input', onSeek);
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) rootEl.addEventListener(type, onPointer);
        rootEl.addEventListener('contextmenu', (e) => e.preventDefault());
        window.addEventListener('keydown', onKey, true); window.addEventListener('keyup', onKey, true);
        window.addEventListener('resize', fit);
        fit(); showPre();
        ui.raf = requestAnimationFrame(frame);
      },
      close() {
        if (!ui) return;
        cancelAnimationFrame(ui.raf);
        if (ui.scn3d && root.BBModels) {
          ui.scn3d.bots3d.forEach((b) => { if (b) root.BBModels.disposeBot(b); });
        }
        if (root.BBEngine && root.BBEngine.invalidate) root.BBEngine.invalidate();
        window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onKey, true);
        window.removeEventListener('resize', fit);
        ui.root.remove();
        const done = ui.opts.onClose;
        ui = null;
        if (typeof done === 'function') done();
      },
      isOpen() { return !!ui; },
    };
    root.BBArena = api;
  }
})(typeof self !== 'undefined' ? self : this);
