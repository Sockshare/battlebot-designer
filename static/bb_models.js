/**
 * BattleBot Designer — procedural 3D assembly.
 * Turns a computed build (BBPhysics.compute) into a THREE.Group: frame, drivetrain (wheels or legs),
 * battery / ESC / switch / busbar bay with a routed wiring harness, every installed hardpoint module
 * (bb_modules.js) and the armour with its paint, fasteners, decals and wear.
 *
 * Authored in metres in the bot frame (+Z forward, +X right, Y up, floor at y=0); the root group is
 * scaled into scene units at the end. Every mesh sits under a group that carries a teardown vector
 * (userData.ex) and an assembly stage (userData.stage) used by the Factory Floor.
 */
(function () {
  'use strict';
  const K = window.BBKit;
  const THREE = K.THREE;
  const P = window.BBPhysics;
  const SCALE = K.SCALE;
  const { cylA, at, aim, merge, box, plateXZ, plateZY, plateXY, linspace, put, rod, strut, group, along, rotY } = K;
  const TAU = Math.PI * 2;

  const STAGE = { frame: 0, drive: 1, power: 2, control: 3, slot0: 4, armor: 9, finish: 10 };
  const STAGE_LABELS = { frame: 'FRAME', drive: 'DRIVETRAIN', power: 'POWER', control: 'CONTROL', armor: 'ARMOR', finish: 'PAINT' };

  // ---- body outline ---------------------------------------------------------------------
  function outlineOf(lay) {
    const bw = lay.bodyHalfW, hl = lay.L / 2, c = lay.cut || 0;
    const nf = lay.notch.f, nr = lay.notch.r, nh = lay.notch.half;
    if (lay.taper < 1) return [[-bw, -hl], [bw, -hl], [bw * lay.taper, hl], [-bw * lay.taper, hl]];
    if (nf || nr) {
      // U and H frames: open bays cut into the front (and rear) between two prongs
      const pts = nr ? [[-bw, -hl], [-nh, -hl], [-nh, -hl + nr], [nh, -hl + nr], [nh, -hl], [bw, -hl]] : [[-bw, -hl], [bw, -hl]];
      pts.push([bw, hl]);
      if (nf) pts.push([nh, hl], [nh, hl - nf], [-nh, hl - nf], [-nh, hl]);
      pts.push([-bw, hl]);
      return pts;
    }
    if (c) return [[-bw + c, -hl], [bw - c, -hl], [bw, -hl + c], [bw, hl - c], [bw - c, hl], [-bw + c, hl], [-bw, hl - c], [-bw, -hl + c]];
    return [[-bw, -hl], [bw, -hl], [bw, hl], [-bw, hl]];
  }
  const circlePts = (r, n) => Array.from({ length: n }, (_, i) => [Math.cos((i / n) * TAU) * r, Math.sin((i / n) * TAU) * r]);
  function edgesOf(pts) {
    // outward normals come from the winding, so they are right for notched (concave) outlines too
    let area = 0;
    pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length]; area += p[0] * q[1] - q[0] * p[1]; });
    const sgn = area >= 0 ? 1 : -1;
    return pts.map((p, i) => {
      const q = pts[(i + 1) % pts.length];
      const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      let n = [q[1] - p[1], -(q[0] - p[0])];
      const l = Math.hypot(n[0], n[1]);
      n = [(sgn * n[0]) / l, (sgn * n[1]) / l];
      return { mid, n, len: Math.hypot(q[0] - p[0], q[1] - p[1]) };
    });
  }
  // slots through a horizontal plate at height y for wheels that poke through it
  function wheelSlots(lay, wheel, y, pad) {
    const wR = lay.wR, d = y - wR;
    if (Math.abs(d) >= wR - 0.002 || lay.shape === 'bigwheel' || lay.shape === 'delta') return [];
    const half = Math.sqrt(wR * wR - d * d) + pad;
    return lay.wheels.map((w) => { const hx = wheel.w / 2 + 0.007; return [[w.x - hx, w.z - half], [w.x + hx, w.z - half], [w.x + hx, w.z + half], [w.x - hx, w.z + half]]; });
  }

  // ---- stencil digits (seven-segment style), in a local x-y plane -------------------------
  const SEG = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abfgcd' };
  function digitGeos(str, h, t) {
    const w = h * 0.56, k = h * 0.15, out = [];
    let x0 = -((str.length * (w + k * 1.4)) - k * 1.4) / 2;
    for (const chr of str) {
      const on = SEG[chr] || '';
      const seg = { a: [w / 2, h - k / 2, w, k], g: [w / 2, h / 2, w, k], d: [w / 2, k / 2, w, k], f: [k / 2, h * 0.75, k, h / 2], b: [w - k / 2, h * 0.75, k, h / 2], e: [k / 2, h * 0.25, k, h / 2], c: [w - k / 2, h * 0.25, k, h / 2] };
      for (const s of on) { const q = seg[s]; out.push(at(box(q[2] * 0.92, q[3] * 0.92, t), x0 + q[0], q[1] - h / 2, 0)); }
      x0 += w + k * 1.4;
    }
    return out;
  }
  const unitNumber = (name) => { const d = (name.match(/\d/g) || ['0', '1']).join(''); return d.length >= 2 ? d.slice(-2) : '0' + d; };

  // wear decals scattered over a rectangle in a local x-y plane (z = normal)
  function wear(ctx, parent, part, w, h, z, cx, cy, density) {
    const fin = ctx.cfg.finish;
    if (fin === 'factory') return;
    const R = ctx.rand, M = ctx.M;
    const n = Math.round((fin === 'battle' ? 110 : 36) * w * h * (density || 1)) + (fin === 'battle' ? 3 : 1);
    const sc = [], go = [];
    for (let i = 0; i < n; i++) {
      const len = 0.012 + R() * R() * Math.min(0.11, w * 0.5), wd = 0.001 + R() * 0.0022;
      const a = (R() - 0.5) * (R() < 0.7 ? 0.7 : 3);
      const x = cx + (R() - 0.5) * (w - len * 0.8), y = cy + (R() - 0.5) * (h - 0.02);
      sc.push(at(box(len, wd, 0.0005), x, y, z, 0, 0, a));
    }
    if (fin === 'battle') {
      for (let i = 0; i < Math.max(1, Math.round(n * 0.1)); i++) {
        const len = 0.018 + R() * 0.045, wd = 0.003 + R() * 0.005;
        go.push(at(box(len, wd, 0.0007), cx + (R() - 0.5) * (w - len), cy + (R() - 0.5) * (h - 0.03), z, 0, 0, (R() - 0.5) * 2));
      }
    }
    if (sc.length) put(ctx, merge(sc), M.scratch, parent, part, 'decal');
    if (go.length) put(ctx, merge(go), M.gouge, parent, part, 'decal');
  }

  // ---- wheels ---------------------------------------------------------------------------
  function buildWheel(ctx, parent, part, key, wheel) {
    const M = ctx.M, R = wheel.d / 2, w = wheel.w;
    const spin = new THREE.Group();
    parent.add(spin);
    const D = (geo, mat) => put(ctx, geo, mat, spin, part, 'drive');
    const lathe = (pts, seg) => { const g = new THREE.LatheGeometry(pts.map((p) => new THREE.Vector2(p[0], p[1])), seg); g.rotateZ(-Math.PI / 2); return g; };
    const ring = (n, rad, x, fn) => Array.from({ length: n }, (_, i) => fn((i / n) * TAU, Math.sin((i / n) * TAU) * rad, Math.cos((i / n) * TAU) * rad, x, i));
    const tyreMat = ctx.cfg.finish === 'factory' ? M.rubber : M.rubberWorn;
    if (key === 'mec6') {
      for (const sx of [-1, 1]) D(at(cylA(R * 0.78, 0.006, 16, 'x'), sx * w * 0.46), M.hub);
      D(cylA(R * 0.3, w, 12, 'x'), M.anoBlack);
      D(merge(ring(9, R * 0.82, 0, (a, y, z) => at(cylA(R * 0.17, w * 1.05, 8, 'x', R * 0.11), 0, y, z, -a, 0.75, 0, 'XYZ'))), M.rubber);
    } else if (key === 'omni6') {
      // two staggered rows of barrel rollers lying along the rim, so the wheel slides freely sideways
      for (const sx of [-1, 1]) D(at(cylA(R * 0.8, 0.006, 16, 'x'), sx * w * 0.46), M.hub);
      D(cylA(R * 0.3, w, 12, 'x'), M.anoBlack);
      for (const [sx, off] of [[-1, 0], [1, 0.5]]) D(merge(Array.from({ length: 8 }, (_, i) => { const a = ((i + off) / 8) * TAU; return at(cylA(R * 0.15, R * 0.5, 8, 'z'), sx * w * 0.22, Math.sin(a) * R * 0.85, Math.cos(a) * R * 0.85, -a + Math.PI / 2); })), M.rubber);
    } else if (key === 'w14') {
      D(lathe([[R * 0.88, -w * 0.42], [R * 0.985, -w * 0.4], [R, -w * 0.25], [R, w * 0.25], [R * 0.985, w * 0.4], [R * 0.88, w * 0.42]], 24), tyreMat);
      D(lathe([[R * 0.76, -w * 0.5], [R * 0.9, -w * 0.5], [R * 0.9, w * 0.5], [R * 0.76, w * 0.5], [R * 0.76, -w * 0.5]], 24), M.uhmw);
      D(merge(ring(6, R * 0.5, 0, (a, y, z) => at(box(w * 0.6, R * 0.16, R * 0.62), 0, y, z, -a))), M.uhmw);
      D(cylA(R * 0.24, w * 1.1, 14, 'x'), M.uhmw);
      D(merge(ring(28, R * 1.0, 0, (a, y, z) => at(box(w * 0.5, R * 0.05, 0.008), 0, y, z, -a))), M.rubber);
    } else {
      const knob = key === 'w10', smooth = key === 'w4';
      const mat = smooth ? (M.urethane || (M.urethane = K.std('#c2611c', 0.42, 0))) : tyreMat;
      D(lathe([[R * 0.6, -w * 0.44], [R * 0.9, -w * 0.5], [R * (smooth ? 1 : 0.965), -w * 0.37], [R * (smooth ? 1 : 0.965), w * 0.37], [R * 0.9, w * 0.5], [R * 0.6, w * 0.44]], 22), mat);
      if (!smooth) {
        const n = knob ? 16 : 26, lugH = R * (knob ? 0.09 : 0.045);
        D(merge(ring(n, R * 0.965 + lugH * 0.4, 0, (a, y, z, x, i) => at(box(w * (knob ? 0.4 : 0.34), R * (knob ? 0.17 : 0.11), lugH), (i % 2 ? 1 : -1) * w * (knob ? 0.2 : 0.18), y, z, -a, 0, (i % 2 ? 1 : -1) * (knob ? 0.25 : 0.4), 'XYZ'))), mat);
      }
      // rim: dished face with lightening holes, hub cap, lug bolts
      D(lathe([[R * 0.2, -w * 0.3], [R * 0.56, -w * 0.3], [R * 0.62, -w * 0.46], [R * 0.62, w * 0.46], [R * 0.56, w * 0.3], [R * 0.2, w * 0.3]], 18), M.hub);
      for (const sx of [-1, 1]) {
        D(merge(ring(5, R * 0.4, sx * w * 0.302, (a, y, z, x) => at(cylA(R * 0.085, 0.004, 8, 'x'), x, y, z))), M.frameDark);
        D(at(cylA(R * 0.2, w * 0.1, 12, 'x'), sx * w * 0.34), M.anoRed);
      }
      K.bolts(ctx, spin, part, ring(5, R * 0.27, w * 0.3, (a, y, z, x) => [x, y, z]), 'x', Math.max(0.004, R * 0.05), M.boltZinc, 'drive');
      K.bolts(ctx, spin, part, ring(5, R * 0.27, -w * 0.3, (a, y, z, x) => [x, y, z]), '-x', Math.max(0.004, R * 0.05), M.boltZinc, 'drive');
    }
    return spin;
  }

  // ---- drivetrain -----------------------------------------------------------------------
  function buildDrive(ctx) {
    const { lay, M, cfg, ch, build } = ctx;
    const dm = P.DRIVE_MOTORS[cfg.driveMotor];
    const wheel = P.WHEELS[cfg.wheel];
    const gIn = ctx.g.driveIn;
    const rq = lay.Rb ? lay.Rb / 0.34 : 1;

    lay.wheels.forEach((w, i) => {
      const side = w.x < 0 ? -1 : 1;
      const wg = new THREE.Group();
      wg.position.set(w.x, w.y, w.z);
      (side < 0 ? ctx.g.driveL : ctx.g.driveR).add(wg);
      const spin = buildWheel(ctx, wg, 'wheel_' + i, cfg.wheel, wheel);
      if (ch.tracks) spin.scale.setScalar(0.9); // road wheels sit inside the belt
      const railX = lay.shape === 'round' ? side * 0.19 * rq : side * lay.xi;
      if (cfg.susp) {
        const ax = railX - w.x + side * 0.014;
        put(ctx, box(0.014, 0.022, 0.11), M.frame, wg, 'susp', 'drive', ax, 0.004, -0.05);
        put(ctx, cylA(0.012, 0.06, 8, 'y'), M.anoGold, wg, 'susp', 'drive', ax, 0.045, -0.095);
        put(ctx, cylA(0.007, 0.075, 6, 'y'), M.steel, wg, 'susp', 'drive', ax, 0.045, -0.095);
      }
      const outboardW = lay.shape === 'bigwheel' || lay.shape === 'delta' || lay.shape === 'round';
      if (cfg.guards && outboardW) {
        // fender over an exposed wheel (enclosed chassis get solid side plates instead)
        const fr = lay.wR + 0.016, fd = new THREE.CylinderGeometry(fr, fr, wheel.w + 0.024, 16, 1, true, Math.PI, Math.PI);
        fd.rotateZ(-Math.PI / 2);
        put(ctx, fd, M.armorShell, wg, 'guards', 'armor');
        put(ctx, box(0.012, 0.02, 2 * fr), M.frameDark, wg, 'guards', 'armor', -side * (wheel.w / 2 + 0.008), 0, 0);
      }
      put(ctx, cylA(0.01, Math.abs(w.x - railX) + 0.03, 8, 'x'), M.steel, wg, 'wheel_' + i, 'drive', (railX - w.x) / 2, 0, 0);
      (side < 0 ? ctx.anim.wheelsL : ctx.anim.wheelsR).push(spin);
      ctx.anchors['wheel_' + i] = wg;
    });

    lay.driveMotors.forEach((m, i) => {
      const mo = K.motor(ctx, gIn, 'dmotor_' + i, dm, 'x', m);
      mo.g.rotation.y = m.side < 0 ? Math.PI : 0; // shaft points outboard
      ctx.anim.driveCans.push({ mesh: mo.can, side: m.side });
      ctx.anchors['dmotor_' + i] = mo.g;
      const gbX = m.x + m.side * (dm.l / 2 + 0.04);
      const gb = new THREE.Group();
      gb.position.set(gbX, m.y, m.z);
      gIn.add(gb);
      put(ctx, cylA(0.031, 0.07, 16, 'x'), M.gearbox, gb, 'gearbox_' + i, 'drive');
      put(ctx, merge([-0.028, 0.028].map((x) => at(cylA(0.034, 0.01, 16, 'x'), x))), M.anoBlack, gb, 'gearbox_' + i, 'drive');
      put(ctx, box(0.012, 0.085, 0.085), M.frameDark, gb, 'gearbox_' + i, 'drive', -m.side * 0.042, 0, 0);
      ctx.anchors['gearbox_' + i] = gb;
      if (build.isDog) return;
      const outX = lay.shape === 'round' ? m.side * 0.2 * rq : m.side * (lay.xi + 0.02);
      put(ctx, cylA(0.009, Math.abs(outX - gbX), 8, 'x'), M.steel, gIn, 'gearbox_' + i, 'drive', (outX + gbX) / 2, m.y, m.z);
      if (lay.nW >= 4 && !cfg.hub) {
        const cx = m.side * (lay.xi + 0.024);
        const sprocket = (y, z) => at(cylA(0.027, 0.007, 12, 'x'), cx, y, z);
        const sp = [sprocket(m.y, m.z)], runs = [];
        lay.wheels.filter((w) => (w.x < 0 ? -1 : 1) === m.side).forEach((w) => {
          sp.push(sprocket(w.y, w.z));
          if (Math.abs(w.z - m.z) < 0.02) return;
          for (const s of [-1, 1]) runs.push(aim(box(0.007, 0.006, Math.hypot(w.z - m.z, w.y - m.y)), [cx, m.y + s * 0.025, m.z], [cx, w.y + s * 0.025, w.z]));
        });
        put(ctx, merge(sp), M.steel, gIn, 'chains', 'drive');
        if (runs.length) put(ctx, merge(runs), M.chain, gIn, 'chains', 'drive');
      }
    });
    if (build.isDog) buildLegs(ctx);

    if (ch.tracks) {
      // rubber belt around the front and rear road wheels of each side
      const mat = M.track || (M.track = K.std('#0f1012', 0.92, 0, { side: THREE.DoubleSide }));
      const lug = M.trackLug || (M.trackLug = K.std('#1d1f23', 0.8, 0));
      const r = lay.wR, bwid = wheel.w + 0.016, tt = r * 0.1;
      for (const side of [-1, 1]) {
        const ws = lay.wheels.filter((w) => (w.x < 0 ? -1 : 1) === side), x = ws[0].x;
        const z1 = Math.max(...ws.map((w) => w.z)), z2 = Math.min(...ws.map((w) => w.z));
        const end = (start) => { const c = new THREE.CylinderGeometry(r, r, bwid, 14, 1, true, start, Math.PI); c.rotateZ(-Math.PI / 2); return c; };
        const band = [at(box(bwid, tt, z1 - z2), x, 2 * r - tt / 2, (z1 + z2) / 2), at(box(bwid, tt, z1 - z2), x, tt / 2, (z1 + z2) / 2), at(end(-Math.PI / 2), x, r, z1), at(end(Math.PI / 2), x, r, z2)];
        const lugs = [];
        for (const z of linspace(z2, z1, Math.max(4, Math.round((z1 - z2) / 0.035)))) { lugs.push(at(box(bwid * 0.96, 0.003, 0.014), x, 2 * r, z)); lugs.push(at(box(bwid * 0.96, 0.003, 0.014), x, 0.0015, z)); }
        for (let i = 1; i < 8; i++) { const a = (i / 8) * Math.PI; lugs.push(at(box(bwid * 0.96, 0.003, 0.014), x, r + Math.cos(a) * r, z1 + Math.sin(a) * r, a)); lugs.push(at(box(bwid * 0.96, 0.003, 0.014), x, r + Math.cos(a) * r, z2 - Math.sin(a) * r, -a)); }
        const g = side < 0 ? ctx.g.driveL : ctx.g.driveR;
        const bm = put(ctx, merge(band), mat, g, 'tracks', 'drive');
        put(ctx, merge(lugs), lug, g, 'tracks', 'drive');
        if (side > 0) ctx.anchors.tracks = bm;
      }
    }
    if (lay.caster) {
      const c = lay.caster;
      ctx.anchors.caster = put(ctx, new THREE.SphereGeometry(0.03, 14, 10), M.steel, gIn, 'caster', 'drive', c.x, c.y, c.z);
      const hgt = Math.max(0.012, lay.bottomY - c.y);
      put(ctx, cylA(0.036, hgt, 14, 'y'), M.frameDark, gIn, 'caster', 'drive', c.x, c.y + hgt / 2 + 0.006, c.z);
    }
    if (cfg.magnets > 0) {
      const hgt = Math.min(0.012, lay.bottomY - 0.003);
      if (hgt > 0.002) {
        const span = lay.Rb ? lay.Rb * 0.5 : lay.L * 0.28, mx = Math.min(0.12, lay.bayHalfW * 0.5), mg = [], cap = [];
        for (const z of linspace(-span, span, cfg.magnets)) for (const sx of [-1, 1]) { mg.push(at(cylA(0.028, hgt, 14, 'y'), sx * mx, lay.bottomY - hgt / 2, z)); cap.push(at(cylA(0.012, hgt + 0.002, 8, 'y'), sx * mx, lay.bottomY - hgt / 2, z)); }
        ctx.anchors.magnets = put(ctx, merge(mg), M.hardened, ctx.g.frame, 'magnets', 'drive');
        put(ctx, merge(cap), M.anoRed, ctx.g.frame, 'magnets', 'drive');
      }
    }
  }

  // two-link legs, knees bending rearward: four legs trot (diagonal pairs), six walk as alternating tripods
  function buildLegs(ctx) {
    const { lay, M } = ctx;
    const l1 = 0.2, l2 = 0.21, footR = 0.03;
    ctx.anim.legs = lay.legs.map((lg, i) => {
      const gSide = lg.side < 0 ? ctx.g.driveL : ctx.g.driveR;
      const hip = new THREE.Group();
      hip.position.set(lg.x, lg.y, lg.z);
      gSide.add(hip);
      ctx.anchors['legs' + i] = hip;
      if (i === 0) ctx.anchors.legs = hip;
      const D = (geo, mat, parent, x, y, z) => put(ctx, geo, mat, parent, 'legs', 'drive', x, y, z);
      // hip actuator housing (fixed) + abduction block into the body
      D(cylA(0.05, 0.07, 18, 'x'), M.anoBlack, hip);
      D(cylA(0.053, 0.014, 18, 'x'), M.accent, hip, lg.side * 0.03);
      D(box(0.06, 0.08, 0.09), M.frameDark, hip, -lg.side * 0.05);
      const thigh = new THREE.Group();
      hip.add(thigh);
      const tp = [[-0.03, 0.03], [0.03, 0.03], [0.026, -l1 + 0.01], [0.0, -l1 - 0.026], [-0.026, -l1 + 0.01]].map((p) => [p[0], p[1]]);
      D(plateZY(tp, 0.03, 0.006, [{ x: 0, y: -l1 * 0.5, r: 0.012 }]), [M.armor, M.edge], thigh, lg.side * 0.045);
      D(cylA(0.034, 0.012, 14, 'x'), M.steel, thigh, lg.side * 0.063);
      const shank = new THREE.Group();
      shank.position.set(lg.side * 0.045, -l1, 0);
      thigh.add(shank);
      D(cylA(0.036, 0.05, 16, 'x'), M.anoBlack, shank);
      D(cylA(0.038, 0.008, 16, 'x'), M.accent, shank, lg.side * 0.026);
      D(aim(cylA(0.016, l2 - footR, 10, 'z', 0.012), [0, 0, 0], [0, -(l2 - footR), 0]), M.frame, shank);
      D(aim(cylA(0.008, l2 * 0.5, 6, 'z'), [0, -0.03, -0.022], [0, -l2 * 0.55, -0.014]), M.steel, shank);
      D(new THREE.SphereGeometry(footR, 12, 8), M.rubber, shank, 0, -(l2 - footR * 0.4), 0);
      const hy = lg.y, phase0 = lay.legs.length > 4 ? ((lg.row + (lg.side > 0 ? 1 : 0)) % 2) * 0.5 : (lg.front ? 0 : 0.5) + (lg.side > 0 ? 0.5 : 0);
      const set = (ph, amp) => {
        const p = (ph + phase0) % 1;
        const stride = 0.14 * amp;
        let fz, fy;
        if (p < 0.6) { fz = stride * (0.5 - p / 0.6); fy = footR; }
        else { const u = (p - 0.6) / 0.4; fz = stride * (-0.5 + u); fy = footR + Math.sin(u * Math.PI) * 0.07 * amp; }
        fz -= 0.015;
        const dz = fz, dy = fy - hy + footR * 0.0;
        const d = Math.min(l1 + l2 - 0.005, Math.hypot(dz, dy));
        const phi = Math.atan2(-dz, -dy);
        const al = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))));
        const t1 = phi + al;
        const kz = -Math.sin(t1) * l1, ky = -Math.cos(t1) * l1;
        const ts = Math.atan2(-(dz - kz), -(dy - ky));
        thigh.rotation.x = t1;
        shank.rotation.x = ts - t1;
      };
      set(0, 0);
      return { set };
    });
  }

  // ---- wiring harness ----------------------------------------------------------------------
  function wire(ctx, parent, pts, mat, r, bus) {
    const curve = new THREE.CatmullRomCurve3(pts.map(K.V), false, 'catmullrom', 0.3);
    put(ctx, new THREE.TubeGeometry(curve, Math.max(8, pts.length * 4), r, 4, false), mat, parent, 'wiring', 'wire');
    ctx.wires.push({ curve, bus, r, parent });
  }
  function route(a, b, y, off) {
    const o = off || 0;
    return [a, [a[0] + o, y, a[2]], [b[0] + o, y, b[2]], b];
  }

  function buildElectrical(ctx) {
    const { lay, M, cfg, build } = ctx;
    const gP = ctx.g.power, gC = ctx.g.control;
    const pack = lay.pack;
    const dEsc = P.ESCS[cfg.driveEsc];
    const dm = P.DRIVE_MOTORS[cfg.driveMotor];
    const rMain = build.electrical.wireD / 2;
    const rPhase = Math.max(0.003, rMain * 0.75);
    const rSig = 0.0016;

    lay.packs.forEach((pk, i) => { ctx.anchors['pack_' + i] = K.batteryPack(ctx, gP, 'pack_' + i, pack, pk); });
    lay.driveEscs.forEach((e, i) => { ctx.anchors['desc_' + i] = K.esc(ctx, gC, 'desc_' + i, dEsc, e); });

    lay.switches.forEach((sw, i) => {
      const sg = new THREE.Group();
      sg.position.set(sw.x, sw.y, sw.z);
      gP.add(sg);
      put(ctx, box(0.05, 0.05, 0.05), M.switchBody, sg, 'switch_' + i, 'elec');
      put(ctx, cylA(0.013, 0.05, 10, 'y'), M.frameDark, sg, 'switch_' + i, 'elec', 0, 0.045, 0);
      put(ctx, cylA(0.02, 0.01, 12, 'y'), M.anoRed, sg, 'switch_' + i, 'elec', 0, 0.066, 0);
      put(ctx, cylA(0.008, 0.006, 8, 'y'), M.led, sg, 'switch_' + i, 'elec', 0.03, 0.062, 0);
      ctx.anchors['switch_' + i] = sg;
    });
    const fg = new THREE.Group();
    fg.position.set(lay.fuse.x, lay.fuse.y, lay.fuse.z);
    gP.add(fg);
    put(ctx, box(0.09, 0.012, 0.03), M.frameDark, fg, 'fuse', 'elec', 0, -0.012, 0);
    put(ctx, box(0.05, 0.022, 0.024), M.fuse, fg, 'fuse', 'elec');
    put(ctx, merge([-1, 1].map((s) => at(cylA(0.006, 0.02, 8, 'y'), s * 0.034, 0.004, 0))), M.copper, fg, 'fuse', 'elec');
    ctx.anchors.fuse = fg;

    lay.buses.forEach((bb, i) => {
      const bg = new THREE.Group();
      bg.position.set(bb.x, bb.y, bb.z);
      bg.rotation.y = bb.rotY || 0;
      gP.add(bg);
      put(ctx, box(0.15, 0.006, 0.05), M.frameDark, bg, 'bus_' + i, 'elec', 0, -0.006, 0);
      put(ctx, merge([-1, 1].map((s) => at(box(0.14, 0.007, 0.014), 0, 0, s * 0.014))), M.copper, bg, 'bus_' + i, 'elec');
      put(ctx, merge(linspace(-0.055, 0.055, 5).flatMap((x) => [-1, 1].map((s) => at(cylA(0.004, 0.006, 6, 'y'), x, 0.006, s * 0.014)))), M.boltZinc, bg, 'bus_' + i, 'elec');
      put(ctx, box(0.012, 0.012, 0.016), M.wireRed, bg, 'bus_' + i, 'elec', -0.07, 0.003, 0.014);
      put(ctx, box(0.012, 0.012, 0.016), M.wireBlk, bg, 'bus_' + i, 'elec', -0.07, 0.003, -0.014);
      ctx.anchors['bus_' + i] = bg;
    });

    const rg = new THREE.Group();
    rg.position.set(lay.receiver.x, lay.receiver.y, lay.receiver.z);
    gC.add(rg);
    put(ctx, box(0.05, 0.016, 0.034), M.rx, rg, 'rx', 'elec');
    put(ctx, box(0.03, 0.001, 0.02), M.decalLight, rg, 'rx', 'elec', 0, 0.0086, 0);
    put(ctx, cylA(0.0015, 0.09, 5, 'y'), M.signal, rg, 'rx', 'elec', 0.02, 0.05, 0.01);
    put(ctx, new THREE.SphereGeometry(0.005, 8, 6), M.led, rg, 'rx', 'elec', -0.015, 0.01, 0.01);
    ctx.anchors.rx = rg;

    // ---- terminals ----
    const packTerm = (pk, sign) => { const [dx, dz] = rotY(sign * pack.w * 0.22, pack.len / 2 + 0.006, pk.rotY || 0); return [pk.x + dx, pk.y + pack.h * 0.2, pk.z + dz]; };
    const busTerm = (bb, sign, t) => { const [dx, dz] = rotY((t - 0.5) * 0.11, sign * 0.014, bb.rotY || 0); return [bb.x + dx, bb.y + 0.006, bb.z + dz]; };
    const escIn = (e, spec, sign) => { const [dx, dz] = rotY(sign * spec.dims[2] * 0.25, -spec.dims[0] / 2 - 0.004, e.rotY || 0); return [e.x + dx, e.y, e.z + dz]; };
    const escOut = (e, spec, k) => { const [dx, dz] = rotY(k * spec.dims[2] * 0.28, spec.dims[0] / 2 + 0.002, e.rotY || 0); return [e.x + dx, e.y, e.z + dz]; };
    const routeY = Math.min(lay.topY - 0.012, Math.max(lay.stackTop + 0.014, lay.floorY + 0.085));
    let lane = 0;
    const nextY = () => routeY - (lane++ % 4) * 0.005;

    const isolated = lay.isolated;
    const nPacks = lay.packs.length;
    const weaponPacks = isolated ? lay.packs.slice(0, nPacks - 1) : lay.packs;
    const drivePack = isolated ? lay.packs[nPacks - 1] : null;
    const busW = lay.buses[0];
    const busD = isolated ? lay.buses[1] : lay.buses[0];
    const fuseIn = [lay.fuse.x - 0.034, lay.fuse.y + 0.014, lay.fuse.z];
    const fuseOut = [lay.fuse.x + 0.034, lay.fuse.y + 0.014, lay.fuse.z];
    const swTerm = (sw, s) => [sw.x + s * 0.02, sw.y - 0.026, sw.z];

    weaponPacks.forEach((pk) => {
      wire(ctx, gC, route(packTerm(pk, 1), fuseIn, nextY()), M.wireRed, rMain, 'main');
      wire(ctx, gC, route(packTerm(pk, -1), busTerm(busW, -1, 0.2), nextY(), 0.004), M.wireBlk, rMain, 'main');
    });
    wire(ctx, gC, [fuseOut, [fuseOut[0] + 0.02, fuseOut[1] + 0.03, fuseOut[2]], swTerm(lay.switches[0], -1)], M.wireRed, rMain, 'main');
    wire(ctx, gC, route(swTerm(lay.switches[0], 1), busTerm(busW, 1, 0.2), nextY()), M.wireRed, rMain, 'main');
    if (drivePack) {
      wire(ctx, gC, route(packTerm(drivePack, 1), swTerm(lay.switches[1], -1), nextY()), M.wireRed, rMain, 'drive');
      wire(ctx, gC, route(swTerm(lay.switches[1], 1), busTerm(busD, 1, 0.2), nextY()), M.wireRed, rMain, 'drive');
      wire(ctx, gC, route(packTerm(drivePack, -1), busTerm(busD, -1, 0.2), nextY(), 0.004), M.wireBlk, rMain, 'drive');
    }

    const phaseMats = [M.phaseA, M.phaseB, M.phaseC];
    // harness run from the bay to a module. Modules riding a spinning shell are fed through the slip ring at the
    // centre; a module on the stationary mast is wired up through the hollow shaft.
    const toModule = (mnt, a, b, y, off) => {
      if (mnt.onShell) return route(a, [off * 2, lay.deckY + 0.04, off], y, off);
      if (mnt.onMast) return [a, [a[0] + off, y, a[2]], [off, y, off], [off, mnt.deckY - 0.02, off], b];
      return route(a, b, y, off);
    };
    const rxOut = (dz) => [lay.receiver.x + 0.02, lay.receiver.y + 0.008, lay.receiver.z + dz];
    // every hardpoint module hangs off the weapon bus: ESC-driven motors get three phases, everything else a fused pair
    let nW = 0;
    for (const slot of build.active) {
      const o = build.mods[slot], gE = ctx.g.slotElec[slot];
      const spec = P.ESCS[o.md.esc];
      const inBot = (p) => (p.bot ? p : P.toBot(o.mount, p));
      for (let i = 0; i < o.escs; i++) {
        const e = o.escPos[i];
        ctx.anchors[`${slot}:esc${i}`] = K.esc(ctx, gE, `${slot}:esc${i}`, spec, e);
        const t = 0.4 + (nW % 4) * 0.15;
        wire(ctx, gE, route(busTerm(busW, 1, t), escIn(e, spec, 1), nextY()), M.wireRed, rMain, 'w:' + slot);
        wire(ctx, gE, route(busTerm(busW, -1, t), escIn(e, spec, -1), nextY(), 0.004), M.wireBlk, rMain, 'w:' + slot);
        const mp = inBot(o.motorPos[Math.min(i, o.motorPos.length - 1)]);
        const y = nextY();
        for (let k = -1; k <= 1; k++) wire(ctx, gE, toModule(o.mount, escOut(e, spec, k), [mp.x + k * 0.012, mp.y, mp.z], y, k * 0.006), phaseMats[k + 1], rPhase, 'w:' + slot);
        wire(ctx, gE, route(rxOut(0.01), escIn(e, spec, 0), routeY - 0.022, 0.002 * nW), M.signal, rSig, 'signal');
        nW++;
      }
      if (!o.escs && o.iPeak > 0) {
        const tgt = o.parts.find((p) => /:(valve|hv|servo|drive|buffer|feed|turret)$/.test(p.id)) || o.parts[0];
        const t = 0.4 + (nW % 4) * 0.15, y = nextY();
        wire(ctx, gE, toModule(o.mount, busTerm(busW, 1, t), [tgt.pos.x + 0.008, tgt.pos.y, tgt.pos.z], y, 0), M.wireRed, rPhase, 'w:' + slot);
        wire(ctx, gE, toModule(o.mount, busTerm(busW, -1, t), [tgt.pos.x - 0.008, tgt.pos.y, tgt.pos.z], y, 0.005), M.wireBlk, rPhase, 'w:' + slot);
        wire(ctx, gE, toModule(o.mount, rxOut(0.01), [tgt.pos.x, tgt.pos.y + 0.01, tgt.pos.z], routeY - 0.022, 0.002 * nW), M.signal, rSig, 'signal');
        nW++;
      }
    }
    lay.driveEscs.forEach((e, i) => {
      const t = 0.75 + (i - 0.5) * 0.3;
      wire(ctx, gC, route(busTerm(busD, 1, t), escIn(e, dEsc, 1), nextY()), M.wireRed, rMain * 0.85, 'drive');
      wire(ctx, gC, route(busTerm(busD, -1, t), escIn(e, dEsc, -1), nextY(), 0.004), M.wireBlk, rMain * 0.85, 'drive');
      // each drive ESC feeds every motor on its side (two per side on the walker)
      lay.driveMotors.filter((m) => m.side === (e.x < 0 ? -1 : 1)).forEach((mpos) => {
        const y = nextY();
        for (let k = -1; k <= 1; k++) wire(ctx, gC, route(escOut(e, dEsc, k), [mpos.x - mpos.side * dm.l * 0.45, mpos.y + k * 0.01, mpos.z - dm.d / 2 - 0.004], y, k * 0.006), phaseMats[k + 1], rPhase * 0.9, 'drive');
      });
      wire(ctx, gC, route(rxOut(-0.01), escIn(e, dEsc, 0), routeY - 0.026, 0.002 * i), M.signal, rSig, 'signal');
    });
    wire(ctx, gC, route(busTerm(busD, 1, 0.05), [lay.receiver.x - 0.02, lay.receiver.y + 0.008, lay.receiver.z], routeY - 0.03), M.wireRed, rSig * 1.4, 'signal');

    // optional components: one small assembly per ticked extra, at the spot the layout reserved for it
    for (const p of build.parts) {
      if (!p.id.startsWith('x_')) continue;
      const k = p.id.slice(2);
      const xg = new THREE.Group();
      xg.position.set(p.pos.x, p.pos.y, p.pos.z);
      (k === 'batbox' ? gP : gC).add(xg);
      ctx.anchors[p.id] = xg;
      const X = (geo, mat, x, y, z) => put(ctx, geo, mat, xg, p.id, 'elec', x, y, z);
      const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
      if (k === 'gyro') { X(box(0.032, 0.008, 0.032), M.pcb); X(box(0.014, 0.006, 0.014), M.anoBlue, 0, 0.007, 0); }
      else if (k === 'fans') { for (const sx of [-1, 1]) { X(box(0.042, 0.014, 0.042), M.frameDark, sx * 0.024, 0, 0); X(cylA(0.017, 0.016, 10, 'y'), M.steel, sx * 0.024, 0.001, 0); } }
      else if (k === 'shock') { X(merge(corners.map(([a, b]) => at(cylA(0.009, 0.014, 8, 'y'), a * 0.02, 0, b * 0.02))), M.rubber); X(merge(corners.map(([a, b]) => at(cylA(0.005, 0.02, 6, 'y'), a * 0.02, 0, b * 0.02))), M.anoRed); }
      else if (k === 'caps') { X(merge([-0.036, 0, 0.036].map((x) => at(cylA(0.016, 0.05, 10, 'y'), x, 0.015, 0))), M.cap); X(box(0.11, 0.004, 0.012), M.copper, 0, 0.042, 0); }
      else if (k === 'telemetry') { X(box(0.04, 0.01, 0.028), M.pcb); X(cylA(0.0015, 0.07, 5, 'y'), M.signal, 0.014, 0.04, 0); X(new THREE.SphereGeometry(0.004, 8, 6), M.ledBlue, -0.012, 0.008, 0); }
      else if (k === 'brake') { X(box(0.06, 0.02, 0.03), M.esc); X(merge(linspace(-0.024, 0.024, 6).map((x) => at(box(0.004, 0.016, 0.028), x, 0.016, 0))), M.escFin); }
      else if (k === 'rx2') { X(box(0.045, 0.014, 0.03), M.rx); X(cylA(0.0015, 0.08, 5, 'y'), M.signal, 0.016, 0.045, 0); X(new THREE.SphereGeometry(0.004, 8, 6), M.led, -0.014, 0.009, 0); }
      else if (k === 'fpv') { X(box(0.03, 0.03, 0.024), M.anoBlack); X(cylA(0.011, 0.012, 10, 'z'), M.lens, 0, 0, 0.016); }
      else if (k === 'batbox') {
        // open-topped titanium tub around the packs, authored in the bot frame
        xg.position.set(0, 0, 0);
        let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, y1 = 0;
        for (const pk of lay.packs) { const turned = Math.abs(Math.sin(pk.rotY || 0)) > 0.5, hx = (turned ? pack.len : pack.w) / 2, hz = (turned ? pack.w : pack.len) / 2; x0 = Math.min(x0, pk.x - hx); x1 = Math.max(x1, pk.x + hx); z0 = Math.min(z0, pk.z - hz); z1 = Math.max(z1, pk.z + hz); y1 = Math.max(y1, pk.y + pack.h / 2); }
        const tw = 0.004, pad = 0.007, hgt = Math.max(0.02, y1 - lay.floorY + 0.004), yc = lay.floorY + hgt / 2;
        const ti = M.tiBox || (M.tiBox = K.std('#a39d93', 0.36, 1));
        X(merge([at(box(x1 - x0 + 2 * pad, hgt, tw), (x0 + x1) / 2, yc, z0 - pad), at(box(x1 - x0 + 2 * pad, hgt, tw), (x0 + x1) / 2, yc, z1 + pad), at(box(tw, hgt, z1 - z0 + 2 * pad), x0 - pad, yc, (z0 + z1) / 2), at(box(tw, hgt, z1 - z0 + 2 * pad), x1 + pad, yc, (z0 + z1) / 2)]), ti);
      }
    }
    const bal = build.parts.find((p) => p.id === 'ballast');
    if (bal) {
      const depth = Math.max(0.012, bal.total / 19300 / (0.16 * 0.03));
      ctx.anchors.ballast = put(ctx, box(0.16, 0.03, depth), M.hardened, ctx.g.frame, 'ballast', 'struct', bal.pos.x, bal.pos.y, bal.pos.z);
      K.bolts(ctx, ctx.g.frame, 'ballast', [[bal.pos.x - 0.06, bal.pos.y + 0.015, bal.pos.z], [bal.pos.x + 0.06, bal.pos.y + 0.015, bal.pos.z]], 'y', 0.006, M.boltZinc, 'struct');
    }

    const pulseGeo = new THREE.SphereGeometry(1, 6, 4);
    ctx.wires.forEach((w, wi) => {
      w.pulses = [];
      const count = w.bus === 'signal' ? 1 : 2;
      for (let i = 0; i < count; i++) {
        const m = new THREE.Mesh(pulseGeo, M.pulse);
        m.scale.setScalar(Math.max(0.004, w.r * 1.7));
        m.visible = false;
        m.userData = { role: 'pulse' };
        w.parent.add(m);
        w.pulses.push({ mesh: m, offset: i / count + (wi % 5) * 0.07 });
      }
    });
  }

  // ---- armour panel on one edge of the body outline -------------------------------------
  // local frame: x along the edge, y up (absolute height), z outward; the inner face is z = 0
  function armorPanel(ctx, e, opts) {
    const { lay, M, cfg } = ctx;
    const face = e.n[1] > 0.7 ? 'front' : e.n[1] < -0.7 ? 'rear' : 'side';
    const t = lay.tFace[face], fm = M.faces[face];
    const g = group(ctx.root, [e.n[0] * 0.34, 0, e.n[1] * 0.34], STAGE.armor);
    g.userData.home.set(e.mid[0], 0, e.mid[1]);
    g.position.copy(g.userData.home);
    g.rotation.y = Math.atan2(e.n[0], e.n[1]);
    ctx.explode.push(g);
    const d = [e.n[1], -e.n[0]];
    const half = e.len / 2 + (opts.extend || 0);
    const yb = opts.yb, yt = opts.yt;
    // wheel arches
    const arches = [];
    if (opts.arches) {
      for (const w of lay.wheels) {
        if (Math.sign(w.x) !== Math.sign(e.n[0])) continue;
        const u = (w.x - e.mid[0]) * d[0] + (w.z - e.mid[1]) * d[1];
        const r = lay.wR + 0.014;
        if (Math.abs(u) + r < half - 0.01) arches.push({ u, r });
      }
      arches.sort((a, b) => a.u - b.u);
    }
    const ycap = yt - 0.034;
    const pts = [[-half, yb]];
    for (const a of arches) {
      const a0 = Math.asin(Math.min(0.95, (lay.wR - yb) / a.r));
      for (let i = 0; i <= 12; i++) {
        const ang = Math.PI + a0 - (i / 12) * (Math.PI + 2 * a0);
        pts.push([a.u + Math.cos(ang) * a.r, Math.max(yb, Math.min(ycap, lay.wR + Math.sin(ang) * a.r))]);
      }
    }
    pts.push([half, yb], [half, yt], [-half, yt]);
    const plate = plateXY(pts, t, Math.min(0.003, t * 0.3));
    plate.translate(0, 0, t / 2);
    put(ctx, plate, [fm.armor, fm.edge], g, opts.part, 'armor');
    ctx.anchors[opts.part] = ctx.anchors[opts.part] || g;

    const zf = t + 0.0004;
    const bandTop = yt - 0.012, bandBot = arches.length ? ycap + 0.004 : yb + 0.012;
    // fasteners: top row + ends (+ bottom row where there are no arches)
    const bp = linspace(-half + 0.025, half - 0.025, Math.max(2, Math.round(e.len / 0.11))).map((x) => [x, yt - 0.014, t]);
    if (!arches.length) bp.push(...linspace(-half + 0.025, half - 0.025, Math.max(2, Math.round(e.len / 0.16))).map((x) => [x, yb + 0.016, t]));
    else for (const sx of [-1, 1]) bp.push([sx * (half - 0.025), (yb + yt) / 2, t], [sx * (half - 0.025), yb + 0.016, t]);
    K.bolts(ctx, g, opts.part, bp, 'z', 0.0058, M.bolt, 'armor');
    if (!M.lv.bare || cfg.finish !== 'factory') {
      // livery: accent stripe + unit number + hazard hatch at one end
      const h = bandTop - bandBot;
      const dec = [], dark = [];
      if (h > 0.016) {
        const sh = arches.length ? Math.min(0.012, h * 0.4) : Math.min(0.022, h * 0.18);
        dec.push(at(box(e.len * 0.62, sh, 0.0005), -e.len * 0.1, arches.length ? bandBot + sh / 2 + 0.002 : yb + (yt - yb) * 0.3, zf));
        const nh = arches.length ? Math.min(0.05, h * 0.9) : Math.min(0.085, (yt - yb) * 0.42);
        if (opts.number && e.len > 0.3) {
          const digs = digitGeos(unitNumber(cfg.name), nh, 0.0005);
          const nx = half - 0.05 - nh * 0.7, ny = arches.length ? bandTop - nh / 2 - 0.004 : yb + (yt - yb) * 0.62;
          for (const q of digs) dec.push(at(q, nx, ny, zf));
        }
        if (cfg.text) {
          // team / sponsor lettering between the hazard hatch and the unit number
          const th = arches.length ? Math.min(0.036, h * 0.8) : Math.min(0.05, (yt - yb) * 0.3);
          if (e.len > K.textWidth(cfg.text, th) + (opts.number ? 0.36 : 0.22)) for (const q of K.textGeos(cfg.text, th, 0.0005)) dec.push(at(q, -e.len * 0.03, arches.length ? bandTop - th / 2 - 0.003 : yb + (yt - yb) * 0.62, zf));
        }
        if (e.len > 0.42) {
          const hh = arches.length ? Math.min(0.03, h * 0.7) : 0.04;
          for (let i = 0; i < 4; i++) dark.push(at(box(0.012, hh * 1.25, 0.0005), -half + 0.06 + i * 0.026, arches.length ? bandTop - hh / 2 - 0.006 : yb + (yt - yb) * 0.66, zf, 0, 0, -0.5));
        }
      }
      if (dec.length) put(ctx, merge(dec), M.decal, g, opts.part, 'decal');
      if (dark.length) put(ctx, merge(dark), M.decal, g, opts.part, 'decal');
    }
    wear(ctx, g, opts.part, e.len * 0.94, (yt - yb) * (arches.length ? 0.3 : 0.86), zf + 0.0002, 0, arches.length ? yt - (yt - yb) * 0.17 : (yb + yt) / 2);
    return g;
  }

  // ---- frame + armour ----------------------------------------------------------------------
  function buildBody(ctx) {
    const { lay, M, ch, cfg, build } = ctx;
    const { L, H, bottomY, topY, xi } = lay;
    const g = ctx.g.frame;
    const wheel = P.WHEELS[cfg.wheel];
    const baseT = ch.baseT;
    const tT = lay.tTop, tS = lay.tSide;
    const round = lay.shape === 'round';
    const outline = round ? circlePts(lay.Rb, 28) : outlineOf(lay);
    const edges = round ? [] : edgesOf(outline);
    const outboard = lay.shape === 'bigwheel' || lay.shape === 'delta';
    const wheeled = lay.wheels.length > 0 && !outboard;
    // an outer flank (as opposed to the inner wall of a U / H bay)
    const isSide = (e) => Math.abs(e.n[0]) > 0.9 && Math.abs(e.mid[0]) > lay.bodyHalfW * 0.6;
    const halfAt = (z) => lay.bodyHalfW * (1 - ((1 - lay.taper) * (z + L / 2)) / L);
    const F = (geo, mat, x, y, z, role) => put(ctx, geo, mat, g, 'frame', role || 'struct', x, y, z);
    const wallH = H - baseT - 0.002, wallY = bottomY + baseT + wallH / 2;
    const wallT = ch.wallT || 0.012;

    // base plate with wheel slots
    const inset = (pts, k) => pts.map((p) => [p[0] * k, p[1] * k]);
    F(at(plateXZ(inset(outline, 0.995), baseT, 0.0015, wheelSlots(lay, wheel, bottomY + baseT / 2, 0.01)), 0, bottomY + baseT / 2, 0), [M.frame, M.steel]);

    if (round) {
      const posts = [], pb = [];
      for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU + 0.39; posts.push(at(cylA(0.014, H - baseT, 8, 'y'), Math.cos(a) * (lay.Rb - 0.03), bottomY + baseT + (H - baseT) / 2, Math.sin(a) * (lay.Rb - 0.03))); pb.push([Math.cos(a) * (lay.Rb - 0.03), topY + tT, Math.sin(a) * (lay.Rb - 0.03)]); }
      F(merge(posts), M.frame);
      const rq = lay.Rb / 0.34;
      for (const s of [-1, 1]) F(box(0.012, H * 0.7, 0.3 * rq), M.frame, s * 0.19 * rq, bottomY + baseT + H * 0.35, 0);
      // skirt + top disc
      const gs = group(ctx.root, [0, 0, 0.36], STAGE.armor);
      ctx.explode.push(gs);
      const skirt = new THREE.CylinderGeometry(lay.Rb + tS, lay.Rb + tS, H + 0.012, 36, 1, true);
      put(ctx, at(skirt, 0, bottomY + H / 2 + 0.004, 0), M.armorShell, gs, 'armor_side', 'armor');
      ctx.anchors.armor_side = gs;
      const gt = ctx.g.top;
      put(ctx, at(plateXZ(circlePts(lay.Rb + tS, 32), tT, 0.0015), 0, topY + tT / 2, 0), [M.faces.top.armor, M.faces.top.edge], gt, 'armor_top', 'armor');
      K.bolts(ctx, gt, 'armor_top', pb, 'y', 0.006, M.bolt, 'armor');
      if (cfg.text) { const th = Math.min(0.05, (lay.Rb * 1.3 * 7) / (6 * cfg.text.length)); put(ctx, merge(K.textGeos(cfg.text, th, 0.0005).map((q) => at(q, 0, topY + tT + 0.0004, -lay.Rb * 0.5, -Math.PI / 2))), M.decalTop, gt, 'armor_top', 'decal'); }
      ctx.anchors.armor_top = gt;
      return;
    }

    if (lay.shape === 'tube') {
      const r = 0.016, xo = lay.bodyHalfW - r, rods = [];
      const R2 = (a, b, rr) => rods.push(aim(cylA(rr || r, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), 8, 'z'), a, b));
      const yl = bottomY + r, yh = topY - r, hl = L / 2 - r;
      for (const y of [yl, yh]) for (const s of [-1, 1]) { R2([s * xo, y, -hl], [s * xo, y, hl]); R2([-xo, y, s * hl], [xo, y, s * hl]); R2([s * xi, y, -hl], [s * xi, y, hl], r * 0.8); }
      for (const sx of [-1, 1]) {
        for (const z of [-hl, 0, hl]) { R2([sx * xo, yl, z], [sx * xo, yh, z]); R2([sx * xi, yl, z], [sx * xi, yh, z], r * 0.8); }
        R2([sx * xo, yl, -hl], [sx * xo, yh, 0], r * 0.75); R2([sx * xo, yh, 0], [sx * xo, yl, hl], r * 0.75);
      }
      R2([-xo, yh, -hl], [xo, yh, 0], r * 0.7); R2([xo, yh, -hl], [-xo, yh, 0], r * 0.7);
      F(merge(rods), M.chromoly);
      const nodes = [];
      for (const y of [yl, yh]) for (const sx of [-1, 1]) for (const z of [-hl, 0, hl]) nodes.push(at(new THREE.SphereGeometry(r * 1.25, 8, 6), sx * xo, y, z));
      F(merge(nodes), M.weld);
    } else {
      // billet tub: outer walls where there are no wheel wells, inner rails beside the wheels
      const walls = [], wb = [];
      for (const e of edges) {
        if (isSide(e) && wheeled) continue;
        if (lay.nose && e.n[1] > 0.9) { /* wedge keeps a front bulkhead behind the nose */ }
        const w = at(box(e.len - 0.004, wallH, wallT), e.mid[0] - e.n[0] * wallT / 2, wallY, e.mid[1] - e.n[1] * wallT / 2, 0, Math.atan2(e.n[0], e.n[1]), 0);
        walls.push(w);
      }
      if (walls.length) F(merge(walls), M.frame);
      if (wheeled) {
        const railHalf = Math.min(L / 2, lay.cut ? lay.bodyHalfW + L / 2 - lay.cut - xi : L / 2) - wallT;
        const rp = [[-railHalf, bottomY + baseT], [railHalf, bottomY + baseT], [railHalf, topY - 0.002], [-railHalf, topY - 0.002]];
        const holes = [];
        for (const z of linspace(-railHalf + 0.07, railHalf - 0.07, Math.max(2, Math.round(railHalf / 0.07)))) {
          if (lay.wheels.some((w) => Math.abs(w.z - z) < 0.045) || lay.driveMotors.some((m) => Math.abs(m.z - z) < 0.05)) continue;
          holes.push({ x: z, y: wallY, r: Math.min(0.026, wallH * 0.24) });
        }
        for (const s of [-1, 1]) F(plateZY(rp, wallT, 0.002, holes), [M.frame, M.steel], s * xi, 0, 0);
        // armour stand-offs across the wheel wells
        const so = [];
        for (const s of [-1, 1]) for (const z of [-railHalf + 0.012, railHalf - 0.012]) for (const y of [bottomY + baseT + 0.02, topY - 0.02]) so.push(at(cylA(0.008, lay.bodyHalfW - xi, 6, 'x'), s * (xi + lay.bodyHalfW) / 2, y, z));
        F(merge(so), M.steel);
      }
      // bulkhead between the battery bay and the front bay
      const bz = Math.min(L / 2 - lay.notch.f - 0.1, lay.buses[0].z + 0.045);
      F(box(2 * Math.min(xi, halfAt(bz)) - wallT, wallH * 0.34, wallT * 0.7), M.frame, 0, bottomY + baseT + wallH * 0.17, bz);
      // top-rail fasteners
      const rb = [];
      for (const e of edges) { if (isSide(e) && wheeled) continue; for (const u of linspace(-e.len / 2 + 0.03, e.len / 2 - 0.03, Math.max(2, Math.round(e.len / 0.12)))) rb.push([e.mid[0] - e.n[0] * wallT / 2 + e.n[1] * u, topY + tT, e.mid[1] - e.n[1] * wallT / 2 - e.n[0] * u]); }
      ctx.topBolts = rb;
    }

    // ---- perimeter armour ----
    const yb = Math.max(0.004, bottomY - 0.008), yt = lay.deckY;
    edges.forEach((e) => {
      const side = isSide(e), front = e.n[1] > 0.9, rear = e.n[1] < -0.9;
      if (front && lay.nose) return;
      if (lay.shape === 'tube' && side) {
        const gp = armorPanel(ctx, e, { part: 'armor_side', yb: lay.cy - 0.03, yt: lay.cy + 0.03, arches: false, number: false, extend: tS });
        void gp;
        return;
      }
      // a tracked hull wears a short skirt so the belts stay in view (unless wheel guards close it in)
      const skirt = ch.tracks && side && !cfg.guards;
      const gp = armorPanel(ctx, e, { part: 'armor_side', yb: skirt ? Math.min(yt - 0.03, 2 * lay.wR - 0.012) : yb, yt, arches: side && wheeled && !cfg.guards && !skirt, number: side || (rear && !lay.cut), extend: lay.cut ? 0 : tS });
      if (build.isDog && front) {
        // sensor bar: the walker's "eyes"
        put(ctx, box(0.2, 0.034, 0.01), M.lens, gp, 'armor_side', 'armor', 0, lay.cy + 0.03, tS + 0.005);
        put(ctx, merge([-0.06, 0.06].map((x) => at(cylA(0.011, 0.006, 10, 'z'), x, lay.cy + 0.03, tS + 0.011))), M.ledBlue, gp, 'armor_side', 'armor');
      }
      if (build.isDog && rear) {
        // whip antenna + status beacon: the tail
        put(ctx, aim(cylA(0.004, 0.3, 6, 'z', 0.0015), [0.1, yt, tS + 0.012], [0.1, yt + 0.28, tS + 0.1]), M.frameDark, gp, 'armor_side', 'armor');
        put(ctx, cylA(0.012, 0.03, 8, 'y'), M.anoBlack, gp, 'armor_side', 'armor', 0.1, yt + 0.004, tS + 0.012);
        put(ctx, cylA(0.014, 0.018, 10, 'y'), M.ledRed, gp, 'armor_side', 'armor', -0.1, yt + 0.012, tS + 0.012);
      }
    });
    if (lay.nose) {
      // wedge: sloped glacis + cheeks
      const bw = lay.bodyHalfW, zf = L / 2, zn = L / 2 + lay.nose;
      const gn = group(ctx.root, [0, 0.1, 0.36], STAGE.armor);
      ctx.explode.push(gn);
      const a = [0, yt, zf - 0.012], b = [0, 0.014, zn + tS];
      const len = Math.hypot(b[1] - a[1], b[2] - a[2]);
      const sheet = plateXZ(K.rectPts(2 * bw + 2 * tS, len), tS, Math.min(0.003, tS * 0.3));
      const rx = Math.atan2(a[1] - b[1], b[2] - a[2]);
      put(ctx, at(sheet, 0, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, rx), [M.faces.front.armor, M.faces.front.edge], gn, 'armor_side', 'armor');
      const cheek = [[zf - 0.01, yb], [zn, yb], [zn, 0.02], [zf - 0.01, yt - 0.004]];
      for (const s of [-1, 1]) put(ctx, plateZY(cheek, tS, Math.min(0.003, tS * 0.3)), [M.armor, M.edge], gn, 'armor_side', 'armor', s * (bw + tS / 2), 0, 0);
      const dir = [0, (b[1] - a[1]) / len, (b[2] - a[2]) / len], nr = [0, dir[2], -dir[1]];
      const on = (x, u, lift) => [x, a[1] + dir[1] * len * u + nr[1] * lift, a[2] + dir[2] * len * u + nr[2] * lift];
      const nb = [];
      for (const x of linspace(-bw + 0.03, bw - 0.03, 6)) for (const u of [0.1, 0.9]) { const p = on(x, u, tS / 2); nb.push(at(cylA(0.006, 0.006, 6, 'y'), p[0], p[1], p[2], rx)); }
      put(ctx, merge(nb), M.bolt, gn, 'armor_side', 'armor');
      const cv = linspace(-bw * 0.8, bw * 0.8, 9).map((x) => { const p = on(x, 0.52, tS / 2 + 0.0004); return at(box(bw * 0.09, 0.0005, len * 0.3), p[0], p[1], p[2], rx, 0.55, 0); });
      put(ctx, merge(cv), M.decal, gn, 'armor_side', 'decal');
    }

    // ---- top plate ----
    const gt = ctx.g.top;
    const topOutline = lay.shape === 'tube' ? inset(outline, 0.97) : outline.map((p) => [p[0] + Math.sign(p[0]) * tS * 0.5, p[1] + Math.sign(p[1]) * tS * 0.5]);
    put(ctx, at(plateXZ(topOutline, tT, Math.min(0.002, tT * 0.3), wheelSlots(lay, wheel, topY + tT / 2, 0.012)), 0, topY + tT / 2, 0), [M.faces.top.armor, M.faces.top.edge], gt, 'armor_top', 'armor');
    ctx.anchors.armor_top = gt;
    const yT = topY + tT;
    const tb = (ctx.topBolts || []).slice();
    if (wheeled) for (const s of [-1, 1]) for (const z of linspace(-L / 2 + 0.05, L / 2 - 0.05, Math.max(3, Math.round(L / 0.13)))) { if (!lay.cut || Math.abs(z) < L / 2 - lay.cut - 0.02) tb.push([s * xi, yT, z]); }
    if (tb.length) K.bolts(ctx, gt, 'armor_top', tb, 'y', 0.0056, M.bolt, 'armor');
    // battery hatch outline, vents, stripes, number
    const pk = lay.packs, pz = pk[0].z, pw = Math.min(lay.bodyHalfW * 1.5, pk.length * (lay.pack.w + 0.012) + 0.05), pl = Math.min(lay.pack.len + 0.05, L * 0.42);
    const dark = [], dec = [], hb = [];
    const lw = 0.004, ye = yT + 0.0004;
    dark.push(at(box(pw, 0.0005, lw), 0, ye, pz - pl / 2), at(box(pw, 0.0005, lw), 0, ye, pz + pl / 2), at(box(lw, 0.0005, pl), -pw / 2, ye, pz), at(box(lw, 0.0005, pl), pw / 2, ye, pz));
    for (const sx of [-1, 1]) for (const z of [-0.42, 0, 0.42]) hb.push([sx * (pw / 2 - 0.014), yT, pz + z * pl]);
    const zTopMax = L / 2 - lay.notch.f, delta = lay.taper < 1;
    const vz = Math.min(zTopMax - 0.12, pz + pl / 2 + 0.07);
    for (const x of linspace(-0.07, 0.07, 6)) dark.push(at(box(0.012, 0.0005, 0.06), x, ye, vz));
    const lit = /^#[d-f]/i.test(M.lv.top) && !M.lv.bare;
    put(ctx, merge(dark), lit ? M.decalDark : M.gouge, gt, 'armor_top', 'decal');
    K.bolts(ctx, gt, 'armor_top', hb, 'y', 0.0045, M.boltZinc, 'armor');
    if (!M.lv.bare || cfg.finish !== 'factory') {
      const sw = Math.min(0.05, lay.bodyHalfW * 0.16);
      let sx0 = Math.min(lay.bodyHalfW - 0.08, pw / 2 + 0.05);
      // stripes stay on the prongs of a U / H frame and on the wide end of a delta
      if (lay.notch.f || lay.notch.r) sx0 = Math.max(sx0, lay.notch.half + sw / 2 + 0.012);
      if (delta) sx0 = Math.min(sx0, lay.bodyHalfW * 0.5);
      const sl = delta ? L * 0.42 : (lay.cut ? L - 2 * lay.cut : L) * 0.9;
      for (const s of [-1, 1]) dec.push(at(box(sw, 0.0005, sl), s * sx0, ye, delta ? -L * 0.24 : 0));
      const nh = Math.min(0.11, lay.bodyHalfW * 0.36);
      for (const q of digitGeos(unitNumber(cfg.name), nh, 0.0005)) dec.push(at(q, 0, ye, Math.min(Math.max(vz + 0.09 + nh / 2, L * 0.2), zTopMax - nh / 2 - 0.03), -Math.PI / 2));
      if (cfg.text) { const th = Math.min(0.045, ((pw - 0.04) * 7) / (6 * cfg.text.length)); for (const q of K.textGeos(cfg.text, th, 0.0005)) dec.push(at(q, 0, ye, pz, -Math.PI / 2)); }
      put(ctx, merge(dec), M.decalTop, gt, 'armor_top', 'decal');
    }
    // wear on the deck (authored in x-y then laid flat)
    const wg = new THREE.Group();
    wg.rotation.x = -Math.PI / 2;
    wg.position.y = yT;
    gt.add(wg);
    const wz = (lay.notch.r - lay.notch.f) / 2 - (delta ? L * 0.2 : 0); // centre of the usable deck
    wear(ctx, wg, 'armor_top', lay.bodyHalfW * (delta ? 0.9 : 1.8), (delta ? L * 0.5 : lay.cut ? L - lay.cut : L - lay.notch.f - lay.notch.r) * 0.9, 0.0006, 0, -wz, 0.7);

    // ---- ground attachments ----
    if (cfg.ground !== 'none') {
      const gg = group(ctx.root, [0, 0, 0.42], STAGE.armor);
      ctx.explode.push(gg);
      const z0 = lay.footprint.zFront + lay.nose + tS, bw = lay.bodyHalfW - (lay.cut || 0);
      const yTop = Math.min(bottomY + 0.07, lay.cy), yLow = Math.max(0.005, bottomY - 0.05);
      if (cfg.ground === 'forks') {
        const tine = [[z0 - 0.03, yTop - 0.04], [z0 + 0.02, yTop - 0.04], [z0 + 0.2, yLow], [z0 + 0.21, yLow + 0.008], [z0 + 0.03, yTop + 0.012], [z0 - 0.03, yTop + 0.012]];
        for (const x of linspace(-bw * 0.8, bw * 0.8, 4)) put(ctx, plateZY(tine, 0.02, 0.004), [M.toolSteel, M.edgeSteel], gg, 'ground', 'weapon', x, 0, 0);
        put(ctx, cylA(0.01, bw * 1.7, 8, 'x'), M.steel, gg, 'ground', 'weapon', 0, yTop - 0.014, z0 - 0.012);
      } else {
        const wl = [[z0 - 0.02, yLow], [z0 + 0.15, yLow], [z0 + 0.15, yLow + 0.006], [z0 - 0.02, yTop + 0.03]];
        for (const x of [-bw * 0.6, 0, bw * 0.6]) put(ctx, plateZY(wl, Math.min(0.2, bw * 0.4), 0.004), [M.armor, M.edgeSteel], gg, 'ground', 'weapon', x, 0, 0);
      }
      ctx.anchors.ground = gg;
    }
  }

  // ---- piece-level teardown -----------------------------------------------------------------
  // The slider first separates the assemblies (userData.ex on each group), then pulls every assembly apart:
  // each part moves away from the centre of its assembly, each differently-made piece of a part (a motor's bell,
  // stator and end cap; an ESC's board, heat sink and capacitors) moves away from the centre of that part, and
  // fasteners lift clear of the plate they hold down. Vectors are stored in the bot frame at rest.
  function preparePieces(ctx) {
    const groups = new Set(ctx.explode);
    const groupOf = (o) => { while (o && !groups.has(o)) o = o.parent; return o; };
    const acc = new Map();
    const add = (key, c, w) => { let a = acc.get(key); if (!a) { a = { c: new THREE.Vector3(), w: 0 }; acc.set(key, a); } a.c.addScaledVector(c, w); a.w += w; };
    const list = [];
    for (const mesh of ctx.meshes) {
      const ud = mesh.userData;
      if (ud.role === 'fx' || ud.role === 'pulse' || ud.role === 'wire' || ud.dynamic || !mesh.geometry) continue;
      const eg = groupOf(mesh);
      if (!eg) continue;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const c = mesh.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
      const w = mesh.geometry.attributes.position.count;
      const loose = ud.role === 'decal' || ud.fastener; // these stay with (or lift off) the part they belong to
      const kG = 'g' + eg.id, kP = kG + '|' + ud.part;
      const base = Array.isArray(ud.base) ? ud.base[0] : ud.base;
      const kS = kP + '|' + (base ? base.uuid : '');
      if (!loose) { add(kG, c, w); add(kP, c, w); add(kS, c, w); }
      list.push({ mesh, eg, kG, kP, kS, loose });
    }
    const centre = (k) => { const a = acc.get(k); return a ? a.c.clone().multiplyScalar(1 / a.w) : null; };
    const cache = new Map();
    const cOf = (k) => { if (!cache.has(k)) cache.set(k, centre(k)); return cache.get(k); };
    const up = new THREE.Vector3(0, 1, 0), _bb = new THREE.Box3();
    const pieces = [];
    for (const it of list) {
      const cG = cOf(it.kG), cP = cOf(it.kP) || cG;
      if (!cG) continue;
      const off = cP.clone().sub(cG).multiplyScalar(1.4);
      if (!it.loose) { const cS = cOf(it.kS); if (cS) off.addScaledVector(cS.clone().sub(cP), 1.7); }
      if (it.mesh.userData.fastener) {
        const ex = it.eg.userData.ex;
        off.addScaledVector(ex.lengthSq() > 1e-6 ? ex.clone().normalize() : up, 0.075);
      }
      if (off.length() > 0.7) off.setLength(0.7);
      // nothing sinks into the floor: keep the lowest point of the piece above it once its assembly has moved too
      const low = _bb.setFromObject(it.mesh).min.y + it.eg.userData.ex.y;
      if (low + off.y < 0.012) off.y = 0.012 - low;
      if (off.lengthSq() < 1e-8) continue;
      it.mesh.userData.home = it.mesh.position.clone();
      it.mesh.userData.off = off;
      pieces.push(it.mesh);
    }
    return pieces;
  }

  const _v = new THREE.Vector3();
  // amount 0..1. Call after this frame's poses are set: a piece that sits inside a turning parent (wheel, rotor,
  // motor bell, swinging arm) has its bot-frame offset converted with the parent's CURRENT rotation, taken from
  // the live local quaternions rather than last frame's world matrices, so it holds its place while it spins.
  function explodePieces(model, amount) {
    if (amount <= 0 && !model.piecesOut) return;
    const root = model.root, inv = new Map();
    for (const mesh of model.pieces) {
      const ud = mesh.userData, par = mesh.parent;
      if (amount <= 0) { mesh.position.copy(ud.home); continue; }
      let qi = inv.get(par);
      if (!qi) {
        qi = new THREE.Quaternion();
        for (let o = par; o && o !== root; o = o.parent) qi.premultiply(o.quaternion);
        qi.invert();
        inv.set(par, qi);
      }
      mesh.position.copy(ud.home).add(_v.copy(ud.off).multiplyScalar(amount).applyQuaternion(qi));
    }
    model.piecesOut = amount > 0;
  }

  // ---- assembly ------------------------------------------------------------------------------
  function buildBot(build) {
    const cfg = build.cfg, lay = build.layout, ch = build.chassis;
    const M = K.makeMaterials(cfg, P.BATTERIES[cfg.battery]);
    const root = new THREE.Group();
    const ctx = {
      build, cfg, lay, ch, M, root, meshes: [], wires: [], anchors: {}, explode: [], rand: K.rng(cfg.name + cfg.chassis + cfg.livery),
      anim: { wheelsL: [], wheelsR: [], driveCans: [], legs: null, slots: {} },
      g: { slot: {}, slotElec: {} },
    };
    const G = (ex, stage) => { const q = group(root, ex, stage); ctx.explode.push(q); return q; };
    ctx.g.frame = G([0, 0, 0], STAGE.frame);
    ctx.g.driveL = G([-0.26, 0, 0], STAGE.drive);
    ctx.g.driveR = G([0.26, 0, 0], STAGE.drive);
    ctx.g.driveIn = G([0, 0.14, 0], STAGE.drive);
    ctx.g.power = G([0, 0.26, 0], STAGE.power);
    ctx.g.control = G([0, 0.38, 0], STAGE.control);
    ctx.g.top = G([0, 0.66, 0], STAGE.armor);

    const stages = [{ n: 0, id: 'frame', label: STAGE_LABELS.frame }, { n: 1, id: 'drive', label: STAGE_LABELS.drive }, { n: 2, id: 'power', label: STAGE_LABELS.power }, { n: 3, id: 'control', label: STAGE_LABELS.control }];
    P.SLOTS.forEach((slot, i) => {
      const o = build.mods[slot];
      if (!o) return;
      const m = o.mount, center = !!o.geo.center;
      const out = [Math.sin(m.rot), Math.cos(m.rot)];
      const deck = center || m.kind === 'deck' || !!(o.geo.T || o.geo.P || o.geo.H);
      const sg = G(center ? [0, 0.8, 0] : deck ? [out[0] * 0.1, 0.56 + i * 0.05, out[1] * 0.1] : [out[0] * 0.5, 0.04, out[1] * 0.5], STAGE.slot0 + i);
      if (!center) { sg.userData.home.set(m.x, 0, m.z); sg.position.copy(sg.userData.home); sg.rotation.y = m.rot; }
      ctx.g.slot[slot] = sg;
      ctx.g.slotElec[slot] = G([0, 0.38, 0], STAGE.slot0 + i);
      stages.push({ n: STAGE.slot0 + i, id: slot, label: P.SLOT_NAMES[slot] + ' · ' + o.def.name });
    });
    stages.push({ n: STAGE.armor, id: 'armor', label: STAGE_LABELS.armor }, { n: STAGE.finish, id: 'finish', label: STAGE_LABELS.finish });

    buildBody(ctx);
    buildDrive(ctx);
    // the shell first, so anything that rides on it can be parented to its rotor and spin with it
    const sh = lay.shell;
    const order = sh ? [sh.slot].concat(build.active.filter((s) => s !== sh.slot)) : build.active;
    for (const slot of order) {
      ctx.anim.slots[slot] = window.BBModules.build(ctx, slot);
      if (sh && build.mods[slot].mount.onShell && ctx.shellRot) {
        const sg = ctx.g.slot[slot];
        ctx.shellRot.add(sg);
        sg.userData.stage = Math.max(sg.userData.stage, ctx.g.slot[sh.slot].userData.stage);
      }
    }
    buildElectrical(ctx);
    ctx.anchors.frame = ctx.g.frame;

    // CG marker
    const cg = new THREE.Group();
    cg.position.set(build.cg.x, build.cg.y, build.cg.z);
    root.add(cg);
    const mk = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x || 0, y || 0, z || 0); m.userData = { role: 'marker' }; cg.add(m); return m; };
    mk(new THREE.SphereGeometry(0.026, 14, 10), M.cg);
    mk(cylA(0.003, build.cg.y, 6, 'y'), M.cgDark, 0, -build.cg.y / 2, 0);
    const ring = mk(new THREE.RingGeometry(0.03, 0.042, 24), M.cg, 0, -build.cg.y + 0.003, 0);
    ring.rotation.x = -Math.PI / 2;
    for (const a of [0, Math.PI / 2]) { const b = mk(box(0.12, 0.003, 0.006), M.cgDark, 0, -build.cg.y + 0.004, 0); b.rotation.y = a; }
    cg.visible = false;

    root.updateMatrixWorld(true);
    const bb = new THREE.Box3();
    for (const m of ctx.meshes) if (m.userData.role !== 'fx' && m.visible) bb.expandByObject(m);
    const bounds = { min: bb.min.clone(), max: bb.max.clone() };
    const pieces = preparePieces(ctx);
    root.scale.setScalar(SCALE);

    return { root, M, pieces, meshes: ctx.meshes, wires: ctx.wires, anchors: ctx.anchors, explode: ctx.explode, anim: ctx.anim, cgMarker: cg, bounds, scale: SCALE, stages };
  }

  function disposeBot(model) {
    if (!model) return;
    model.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    Object.values(model.M).forEach((m) => { if (m && m.dispose) m.dispose(); });
    Object.values(model.M.faces || {}).forEach((f) => { f.armor.dispose(); f.edge.dispose(); });
    if (model.heatMats) model.heatMats.forEach((m) => m.dispose());
  }

  // load fraction (0..1+) -> blue / yellow / red
  function heatColor(f) {
    const t = Math.max(0, Math.min(1.25, f));
    const c0 = new THREE.Color('#2a6fdb'), c1 = new THREE.Color('#f2c230'), c2 = new THREE.Color('#e5381f'), c3 = new THREE.Color('#ff5fd2');
    if (t < 0.5) return c0.lerp(c1, t / 0.5);
    if (t < 1) return c1.lerp(c2, (t - 0.5) / 0.5);
    return c2.lerp(c3, (t - 1) / 0.25);
  }

  function partLoad(build, part) {
    if (!part) return null;
    const v = build.electrical.loadById[part];
    return v === undefined ? null : v;
  }

  // view = { xray, overlay: 'none' | 'electrical' | 'thermal', primer }
  function applyView(model, build, view) {
    if (model.heatMats) model.heatMats.forEach((m) => m.dispose());
    model.heatMats = [];
    const heatCache = {};
    const M = model.M;
    for (const mesh of model.meshes) {
      const { role, base, part } = mesh.userData;
      if (role === 'fx') continue;
      let mat = base;
      if (role === 'decal') { mesh.visible = !view.xray && view.overlay === 'none' && !view.primer; continue; }
      if (view.overlay === 'electrical') {
        if (role !== 'elec' && role !== 'wire') mat = M.dim;
      } else if (view.overlay === 'thermal') {
        const load = partLoad(build, part);
        if (load !== null) {
          const key = load.toFixed(2);
          if (!heatCache[key]) {
            const col = heatColor(load);
            heatCache[key] = K.std(col, 0.5, 0.05, { emissive: col.clone().multiplyScalar(0.3) });
            model.heatMats.push(heatCache[key]);
          }
          mat = heatCache[key];
        } else mat = role === 'armor' ? M.ghost : M.cool;
      } else if (view.xray && role === 'armor') mat = M.ghost;
      else if (view.primer && role === 'armor') mat = Array.isArray(base) ? [M.primer, M.primerDark] : M.primer;
      mesh.material = mat;
    }
  }

  window.BBModels = { LIVERIES: K.LIVERIES, SCALE, STAGE, buildBot, disposeBot, explodePieces, applyView, heatColor, partLoad };
})();
