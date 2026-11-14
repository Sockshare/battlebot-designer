/**
 * BattleBot Designer — hardpoint module builders.
 * One builder per module family. Each works in the module frame of its mount (x lateral, y absolute
 * height, z outward from the mount face — the same frame BBPhysics uses for geo), so any module
 * can be bolted to any hardpoint of any chassis.
 *
 * A builder returns an animation handle: { rotor(angle), cans(angle), blur(on), pose(u), fx(level, time, u) }.
 */
(function () {
  'use strict';
  const K = window.BBKit;
  const THREE = K.THREE;
  const { cylA, at, aim, merge, box, plateXZ, plateZY, plateXY, along, linspace } = K;
  const P = window.BBPhysics;
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => t * t * (3 - 2 * t);
  const TAU = Math.PI * 2;

  function build(ctx, slot) {
    const o = ctx.build.mods[slot], g = o.geo, m = o.mount, M = ctx.M, md = o.md;
    let G = ctx.g.slot[slot]; // re-pointed at a tilted sub-frame by the angled spinner
    const id = (n) => `${slot}:${n}`;
    const wm = P.WEAPON_MOTORS[md.motor];
    const put = (geo, mat, part, role, x, y, z, parent) => K.put(ctx, geo, mat, parent || G, id(part), role || 'weapon', x, y, z);
    const sub = (parent, x, y, z) => { const q = new THREE.Group(); q.position.set(x || 0, y || 0, z || 0); (parent || G).add(q); return q; };
    const bolts = (pts, axis, part, r, parent, mat) => K.bolts(ctx, parent || G, id(part), pts, axis, r, mat, 'weapon');
    const anchor = (n, obj) => { ctx.anchors[id(n)] = obj; };
    const fxMesh = (geo, mat, parent) => { const q = put(geo, mat, 'fx', 'fx', 0, 0, 0, parent); q.visible = false; q.userData.part = null; return q; };
    const cans = [];
    const A = { cans(a) { for (const c of cans) c.can.rotation[c.axis] = a * c.dir; } };
    const s = g.s;
    const edge = g.edge;
    const zr = -(m.inset + 0.02); // where an edge-mounted bracket meets the chassis

    // ---- shared sub-assemblies ------------------------------------------------------
    function motorAt(i, p, axis, parent) {
      const mo = K.motor(ctx, parent || G, id('motor' + i), wm, axis, p);
      cans.push({ can: mo.can, axis, dir: p.side || 1 });
      if (i === 0) anchor('motor0', mo.g);
      // clamp block under / behind the motor
      const r = wm.d / 2;
      if (axis === 'y') put(cylA(r * 1.12, 0.008, 16, 'y'), M.frameDark, 'motor' + i, 'elec', p.x, p.y - wm.l / 2 - 0.004, p.z, parent);
      else if (axis === 'x') put(box(0.01, wm.d * 1.15, wm.d * 1.15), M.frameDark, 'motor' + i, 'elec', p.x - (p.side || 1) * (wm.l / 2 + 0.005), p.y, p.z, parent);
      else put(box(wm.d * 1.15, wm.d * 1.15, 0.01), M.frameDark, 'motor' + i, 'elec', p.x, p.y, p.z - wm.l / 2 - 0.005, parent);
      return mo;
    }
    // belt between two pulleys. plane 'x': belt lies in the z-y plane at p.x; plane 'y': horizontal at p.y
    function belt(p1, p2, r1, r2, w, plane, parent, spinGroup, spinLocal) {
      const a = new THREE.Vector3(p1[0], p1[1], p1[2]), b = new THREE.Vector3(p2[0], p2[1], p2[2]);
      const d = b.clone().sub(a).normalize();
      const n = plane === 'x' ? new THREE.Vector3(0, d.z, -d.y) : new THREE.Vector3(d.z, 0, -d.x);
      const runs = [];
      for (const sg of [1, -1]) {
        const s1 = a.clone().addScaledVector(n, sg * r1), s2 = b.clone().addScaledVector(n, sg * r2);
        runs.push(aim(plane === 'x' ? box(w, 0.004, s1.distanceTo(s2)) : box(0.004, w, s1.distanceTo(s2)), s1.toArray(), s2.toArray()));
      }
      const tr = md.trans === 'chain';
      put(merge(runs), tr ? M.chain : M.belt, 'trans', 'weapon', 0, 0, 0, parent);
      put(at(cylA(r1, w + 0.006, 14, plane), p1[0], p1[1], p1[2]), M.pulley, 'trans', 'weapon', 0, 0, 0, parent);
      const q = spinGroup ? spinLocal : p2;
      put(at(cylA(r2, w + 0.006, 16, plane), q[0], q[1], q[2]), tr ? M.pulley : M.anoBlack, 'trans', 'weapon', 0, 0, 0, spinGroup || parent);
    }
    const blurDisc = (R, t, axis, parent, x, y, z) => { const q = fxMesh(cylA(R, t, 28, axis), M.sweepSteel, parent); q.position.set(x || 0, y || 0, z || 0); return q; };
    // two-part actuator (body + rod) re-aimed every pose: returns set(A, B)
    function ram(part, rBody, rRod, matBody, parent) {
      const body = put(cylA(rBody, 1, 12, 'z'), matBody, part, 'weapon', 0, 0, 0, parent);
      const rodM = put(cylA(rRod, 1, 8, 'z'), M.steel, part, 'weapon', 0, 0, 0, parent);
      body.userData.dynamic = rodM.userData.dynamic = true; // re-aimed every frame, so the teardown leaves them alone
      return (a, b, bodyLen) => {
        const d = b.clone().sub(a), len = d.length();
        const mid = a.clone().addScaledVector(d, Math.min(1, bodyLen / len));
        K.stretch(body, a, mid);
        K.stretch(rodM, a.clone().addScaledVector(d, 0.2), b);
      };
    }

    // ---- toothed rotor outlines ---------------------------------------------------------
    function snailPts(R, teeth, rMin) {
      const pts = [], N = 14;
      for (let t = 0; t < teeth; t++) for (let i = 0; i < N; i++) {
        const u = i / (N - 1), a = ((t + u * 0.985) / teeth) * TAU;
        const r = R * (rMin + (1 - rMin) * Math.pow(u, 1.7));
        pts.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
      return pts;
    }
    function sawPts(R, teeth) {
      const pts = [];
      for (let i = 0; i < teeth; i++) {
        const a0 = (i / teeth) * TAU, a1 = ((i + 0.72) / teeth) * TAU;
        pts.push([Math.cos(a0) * R * 0.93, Math.sin(a0) * R * 0.93], [Math.cos(a1) * R, Math.sin(a1) * R]);
      }
      return pts;
    }
    const ringHoles = (n, r, rad, off) => Array.from({ length: n }, (_, i) => ({ x: Math.cos((i / n) * TAU + (off || 0)) * rad, y: Math.sin((i / n) * TAU + (off || 0)) * rad, r }));
    const hubBolts = (n, rad, x) => Array.from({ length: n }, (_, i) => [x, Math.sin((i / n) * TAU) * rad, Math.cos((i / n) * TAU) * rad]);

    // saw blade assembly spinning about x, centred on `parent`
    function sawBlade(parent, R) {
      const rot = sub(parent);
      put(plateZY(sawPts(R, 24), 0.008, 0.0015, ringHoles(6, R * 0.09, R * 0.55)), [M.steel, M.edgeSteel], 'rotor', 'weapon', 0, 0, 0, rot);
      for (const sx of [-1, 1]) {
        const band = new THREE.RingGeometry(R * 0.64, R * 0.9, 28); band.rotateY(sx * Math.PI / 2);
        put(band, M.anoGold, 'rotor', 'weapon', sx * 0.0046, 0, 0, rot);
        put(cylA(R * 0.3, 0.012, 16, 'x'), M.anoRed, 'hub', 'weapon', sx * 0.01, 0, 0, rot);
      }
      bolts(hubBolts(6, R * 0.2, 0.016), 'x', 'hub', 0.005, rot);
      return rot;
    }

    const k = o.type;
    // =====================================================================================
    // SPINNERS ABOUT A HORIZONTAL AXLE: vertical disk, drum, eggbeater, fixed saw
    // =====================================================================================
    if (o.kind === 'spinner' && g.axis === 'z') {
      // AUGER DRILL: geared housing on the mount, auger turning about the outward axis
      const yA = g.yA, zA = g.zA, R = g.R, Lb = g.Lb, mp = o.motorPos[0];
      const hw = R + 0.03;
      put(box(2 * hw, 2 * hw, 0.06), M.gearbox, 'mount', 'weapon', 0, yA, zA - 0.03);
      put(box(2 * hw + 0.004, 0.02, 0.064), M.anoBlack, 'mount', 'weapon', 0, yA + hw - 0.016, zA - 0.03);
      if (edge) {
        put(box(2 * hw + 0.06, 2 * hw, 0.014 - zr), M.frameDark, 'mount', 'struct', 0, yA, (zr + 0.014) / 2);
        bolts([[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => [a * (hw + 0.016), yA + b * (hw - 0.02), 0.014]), 'z', 'mount', 0.006);
      } else {
        const th = Math.max(0.008, yA - hw - g.baseY);
        put(box(2 * hw + 0.05, th, 0.12), M.frameDark, 'mount', 'struct', 0, g.baseY + th / 2, zA - 0.03);
        bolts([[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => [a * (hw + 0.012), g.baseY + th, zA - 0.03 + b * 0.048]), 'y', 'mount', 0.006);
      }
      motorAt(0, mp, 'z');
      put(box(mp.x + 0.06, 0.07, 0.022), M.frameDark, 'trans', 'weapon', mp.x / 2, yA, mp.z + wm.l / 2 + 0.017);
      put(box(mp.x + 0.03, 0.012, 0.024), M.accent, 'trans', 'weapon', mp.x / 2, yA + 0.03, mp.z + wm.l / 2 + 0.017);
      const rot = sub(G, 0, yA, zA);
      anchor('rotor', rot);
      put(at(cylA(R * 0.42, Lb, 14, 'z', 0.006), 0, 0, Lb / 2), M.toolSteel, 'rotor', 'weapon', 0, 0, 0, rot);
      const fl = [], N = 16;
      for (let i = 0; i < N; i++) { const u = (i + 0.5) / N, r = R * (1 - 0.8 * u); fl.push(at(box(2 * r, 0.007, 0.02), 0, 0, Lb * u * 0.92, 0, 0, i * 0.8)); }
      put(merge(fl), M.hardened, 'rotor', 'weapon', 0, 0, 0, rot);
      put(at(cylA(R * 0.62, 0.022, 14, 'z'), 0, 0, 0.011), M.anoRed, 'hub', 'weapon', 0, 0, 0, rot);
      put(at(cylA(0.012, 0.05, 8, 'z', 0.001), 0, 0, Lb + 0.02), M.edgeSteel, 'rotor', 'weapon', 0, 0, 0, rot);
      const blur = fxMesh(at(cylA(R, Lb, 16, 'z', 0.012), 0, 0, Lb / 2), M.sweepSteel, G);
      blur.position.set(0, yA, zA);
      A.rotor = (a) => { rot.rotation.z = a; };
      A.blur = (on) => { blur.visible = on; };
    }
    else if (o.kind === 'spinner' && g.axis === 'x' && !g.center) {
      const yA = g.yA, zA = g.zA, xu = g.xu, R = g.R, tipR = g.tipR;
      const boss = 0.04;
      // angled spinner: the whole assembly is rolled about the outward axis through the axle
      if (g.tilt) { const tg = sub(G, 0, yA, zA); tg.rotation.z = g.tilt; G = sub(tg, 0, -yA, -zA); }
      // uprights
      let pts;
      if (edge) {
        const yLo = Math.max(0.014, m.cy - 0.065) + (g.tilt ? 0.03 : 0), yHi = m.cy + 0.065;
        const yb = Math.max(0.014, yA - boss);
        pts = [[zr, yLo], [zA - 0.02, yb], [zA + boss, yb + 0.012], [zA + boss + 0.012, yA], [zA + boss, yA + boss * 0.8], [zA - 0.03, yA + boss], [zr, yHi]];
      } else {
        pts = [[zA - 0.11, g.baseY], [zA + 0.11, g.baseY], [zA + boss + 0.004, yA + 0.01], [zA + boss * 0.6, yA + boss], [zA - boss * 0.6, yA + boss], [zA - boss - 0.004, yA + 0.01]];
      }
      const lh = edge ? [{ x: (zr + zA) / 2, y: (m.cy + yA) / 2, r: Math.min(0.03, Math.abs(zA - zr) * 0.14) }] : [{ x: zA, y: (g.baseY + yA) / 2 - 0.005, r: Math.min(0.035, (yA - g.baseY) * 0.22) }];
      for (const sx of [-1, 1]) {
        put(plateZY(pts, 0.016, 0.003, lh), [M.frame, M.steel], 'mount', 'struct', sx * xu);
        put(cylA(0.03, 0.012, 14, 'x'), M.anoBlack, 'hub', 'weapon', sx * (xu + 0.012), yA, zA);
        bolts([0, 1, 2, 3].map((i) => [sx * (xu + 0.018), yA + Math.sin(i * 1.57 + 0.78) * 0.022, zA + Math.cos(i * 1.57 + 0.78) * 0.022]), sx > 0 ? 'x' : '-x', 'hub', 0.004);
      }
      // cross ties between the uprights
      if (edge) {
        put(box(2 * xu + 0.016, 0.1, 0.03), M.frameDark, 'mount', 'struct', 0, m.cy, zr + 0.02);
        bolts(linspace(-xu * 0.7, xu * 0.7, 4).map((x) => [x, m.cy + 0.03, zr + 0.035]), 'z', 'mount', 0.006);
      } else {
        put(box(2 * xu + 0.05, 0.012, 0.24), M.frameDark, 'mount', 'struct', 0, g.baseY + 0.006, zA);
        bolts([[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => [a * (xu + 0.012), g.baseY + 0.012, zA + b * 0.1]), 'y', 'mount', 0.006);
      }
      put(cylA(0.014, 2 * xu + 0.07, 12, 'x'), M.steel, 'hub', 'weapon', 0, yA, zA);

      const rot = sub(G, 0, yA, zA);
      anchor('rotor', rot);
      let blur;
      if (k === 'vdisk' || k === 'angled') {
        const t = g.t;
        const disk = put(plateZY(snailPts(R, md.teeth, 0.56), t, 0.008, ringHoles(md.teeth === 1 ? 4 : 6, R * 0.1, R * 0.36, 0.9)), [M.weapon, M.steel], 'rotor', 'weapon', 0, 0, 0, rot);
        void disk;
        const tips = [], tb = [];
        for (let i = 0; i < md.teeth; i++) {
          const a = ((i + 0.985) / md.teeth) * TAU; // leading face of each lobe
          tips.push(at(box(t * 1.04, R * 0.36, 0.024), 0, Math.sin(a) * R * 0.83, Math.cos(a) * R * 0.83, -a + Math.PI / 2));
          for (const sx of [-1, 1]) tb.push([sx * t * 0.5, Math.sin(a - 0.07) * R * 0.86, Math.cos(a - 0.07) * R * 0.86]);
        }
        put(merge(tips), M.edgeSteel, 'rotor', 'weapon', 0, 0, 0, rot);
        put(cylA(R * 0.2, t + 0.024, 18, 'x'), M.anoBlack, 'hub', 'weapon', 0, 0, 0, rot);
        for (const sx of [-1, 1]) bolts(hubBolts(6, R * 0.14, sx * (t / 2 + 0.012)), sx > 0 ? 'x' : '-x', 'hub', 0.006, rot, M.boltZinc);
        blur = blurDisc(tipR, t * 0.8, 'x', G, 0, yA, zA);
      } else if (k === 'saw') {
        const r2 = sawBlade(rot, R);
        r2.userData.keep = true;
        // blade guard over the rear upper quadrant
        const guard = new THREE.CylinderGeometry(R + 0.02, R + 0.02, 0.05, 16, 1, true, 0, Math.PI * 0.6);
        guard.rotateZ(-Math.PI / 2); guard.rotateX(Math.PI * 0.72);
        put(guard, M.armorShell, 'mount', 'weapon', 0, yA, zA);
        blur = blurDisc(tipR, 0.006, 'x', G, 0, yA, zA);
      } else if (k === 'twin') {
        const t = g.t, gap = g.gap;
        for (const sx of [-1, 1]) {
          put(at(plateZY(snailPts(R, md.teeth, 0.56), t, 0.006, ringHoles(md.teeth === 1 ? 4 : 6, R * 0.1, R * 0.36, 0.9)), (sx * gap) / 2), [M.weapon, M.steel], 'rotor', 'weapon', 0, 0, 0, rot);
          const tips = [];
          for (let i = 0; i < md.teeth; i++) { const a = ((i + 0.985) / md.teeth) * TAU; tips.push(at(box(t * 1.04, R * 0.36, 0.022), (sx * gap) / 2, Math.sin(a) * R * 0.83, Math.cos(a) * R * 0.83, -a + Math.PI / 2)); }
          put(merge(tips), M.edgeSteel, 'rotor', 'weapon', 0, 0, 0, rot);
          bolts(hubBolts(6, R * 0.14, sx * (gap / 2 + t / 2 + 0.002)), sx > 0 ? 'x' : '-x', 'hub', 0.005, rot, M.boltZinc);
        }
        put(cylA(R * 0.22, gap + t + 0.004, 18, 'x'), M.anoBlack, 'hub', 'weapon', 0, 0, 0, rot);
        put(cylA(R * 0.3, gap * 0.5, 18, 'x'), M.accent, 'hub', 'weapon', 0, 0, 0, rot);
        blur = blurDisc(tipR, gap + t, 'x', G, 0, yA, zA);
      } else if (k === 'drum') {
        const Lw = g.Lw;
        put(cylA(R, Lw, 22, 'x'), M.toolSteel, 'rotor', 'weapon', 0, 0, 0, rot);
        put(merge([-1, 1].map((sx) => at(cylA(R + 0.002, Lw * 0.09, 22, 'x'), sx * Lw * 0.42))), M.accent, 'rotor', 'weapon', 0, 0, 0, rot);
        put(merge([-0.2, 0, 0.2].map((u) => at(cylA(R + 0.0012, 0.006, 22, 'x'), u * Lw))), M.gouge, 'rotor', 'weapon', 0, 0, 0, rot);
        const teeth = [], tb = [];
        for (let i = 0; i < md.teeth; i++) {
          const a = (i / md.teeth) * TAU;
          teeth.push(at(box(Lw * 0.74, 0.034, 0.05), 0, Math.sin(a) * (R + 0.003), Math.cos(a) * (R + 0.003), -a + 0.35));
          for (const u of [-0.28, 0, 0.28]) tb.push(at(cylA(0.007, 0.012, 6, 'y'), u * Lw, Math.sin(a - 0.3) * (R + 0.004), Math.cos(a - 0.3) * (R + 0.004), -a + 0.3 + Math.PI / 2));
        }
        put(merge(teeth), M.edgeSteel, 'rotor', 'weapon', 0, 0, 0, rot);
        put(merge(tb), M.bolt, 'rotor', 'weapon', 0, 0, 0, rot);
        blur = blurDisc(tipR, Lw * 0.74, 'x', G, 0, yA, zA);
      } else {
        const Lw = g.Lw;
        const ends = [-1, 1].map((sx) => at(plateZY(snailPts(R, 2, 0.8), 0.014, 0.003, ringHoles(4, R * 0.16, R * 0.5, 0.78)), sx * (Lw / 2)));
        for (const e of ends) put(e, [M.toolSteel, M.steel], 'rotor', 'weapon', 0, 0, 0, rot);
        const bars = [];
        for (let i = 0; i < 2; i++) { const a = i * Math.PI + 3.0; bars.push(at(box(Lw + 0.014, 0.05, 0.032), 0, Math.sin(a) * (R - 0.02), Math.cos(a) * (R - 0.02), -a)); }
        put(merge(bars), M.hardened, 'rotor', 'weapon', 0, 0, 0, rot);
        const lips = [];
        for (let i = 0; i < 2; i++) { const a = i * Math.PI + 3.0; lips.push(at(box(Lw * 0.96, 0.012, 0.036), 0, Math.sin(a) * (R - 0.001), Math.cos(a) * (R - 0.001), -a)); }
        put(merge(lips), M.edgeSteel, 'rotor', 'weapon', 0, 0, 0, rot);
        blur = blurDisc(tipR, Lw, 'x', G, 0, yA, zA);
      }
      o.motorPos.forEach((p, i) => {
        motorAt(i, p, 'x');
        const px = p.side * (xu + 0.02);
        belt([px, p.y, p.z], [px, yA, zA], Math.min(0.022, wm.d * 0.3), Math.min(0.03, 0.022 * md.ratio), 0.016, 'x', G, rot, [px, 0, 0]);
      });
      A.rotor = (a) => { rot.rotation.x = -a; };
      A.blur = (on) => { blur.visible = on; };
    }
    // =====================================================================================
    // SPINNERS ABOUT A VERTICAL SHAFT: horizontal bar, undercutter
    // =====================================================================================
    else if (o.kind === 'spinner' && g.axis === 'y' && !g.center) {
      const yA = g.yA, zA = g.zA, R = g.R, t = g.t, w = g.w;
      const rot = sub(G, 0, yA, zA);
      anchor('rotor', rot);
      if (k === 'flail') {
        // hub with a chain and a hardened weight per arm
        put(cylA(0.06, t + 0.02, 20, 'y'), M.anoBlack, 'hub', 'weapon', 0, 0, 0, rot);
        put(cylA(0.066, 0.012, 20, 'y'), M.accent, 'hub', 'weapon', 0, 0, 0, rot);
        const links = [], heads = [], lugs = [], caps = [];
        for (let i = 0; i < md.teeth; i++) {
          const a = (i / md.teeth) * TAU, cx = Math.cos(a), sz = Math.sin(a);
          lugs.push(at(box(0.04, 0.03, 0.03), cx * 0.07, 0, sz * 0.07, 0, -a, 0));
          const r0 = 0.092, r1 = R - 0.08, n = Math.max(3, Math.round((r1 - r0) / 0.034));
          for (let j = 0; j < n; j++) { const r = r0 + ((r1 - r0) * (j + 0.5)) / n; links.push(at(new THREE.TorusGeometry(0.0145, 0.0045, 5, 10), cx * r, 0, sz * r, j % 2 ? Math.PI / 2 : 0, -a, 0, 'YXZ')); }
          heads.push(at(box(0.075, 0.05, 0.06), cx * (R - 0.045), 0, sz * (R - 0.045), 0, -a, 0));
          caps.push(at(box(0.014, 0.054, 0.064), cx * (R - 0.007), 0, sz * (R - 0.007), 0, -a, 0));
        }
        put(merge(lugs), M.frameDark, 'hub', 'weapon', 0, 0, 0, rot);
        put(merge(links), M.chain, 'rotor', 'weapon', 0, 0, 0, rot);
        put(merge(heads), M.hardened, 'rotor', 'weapon', 0, 0, 0, rot);
        put(merge(caps), M.edgeSteel, 'rotor', 'weapon', 0, 0, 0, rot);
      } else {
      const c = 0.07;
      const barPts = [[-R, -w * 0.22], [-R + c, -w / 2], [R - c, -w / 2], [R, -w * 0.22], [R, w * 0.22], [R - c, w / 2], [-R + c, w / 2], [-R, w * 0.22]];
      const slots = [-1, 1].map((sg) => { const x0 = sg * R * 0.28, x1 = sg * R * 0.7; return [[Math.min(x0, x1), -w * 0.16], [Math.max(x0, x1), -w * 0.16], [Math.max(x0, x1), w * 0.16], [Math.min(x0, x1), w * 0.16]]; });
      put(plateXZ(barPts, t, 0.005, slots), [M.toolSteel, M.steel], 'rotor', 'weapon', 0, 0, 0, rot);
      const tips = [];
      for (const sg of [-1, 1]) tips.push(at(box(0.075, t * 1.04, 0.022), sg * (R - 0.05), 0, sg * (w / 2 - 0.02), 0, sg > 0 ? -0.32 : -0.32));
      put(merge(tips), M.edgeSteel, 'rotor', 'weapon', 0, 0, 0, rot);
      put(cylA(w * 0.62, t + 0.016, 20, 'y'), M.anoBlack, 'hub', 'weapon', 0, 0, 0, rot);
      K.bolts(ctx, rot, id('hub'), Array.from({ length: 6 }, (_, i) => [Math.cos(i * 1.047) * w * 0.42, t / 2 + 0.008, Math.sin(i * 1.047) * w * 0.42]), 'y', 0.007, M.boltZinc, 'weapon');
      }
      const blur = blurDisc(R, t * 0.6, 'y', G, 0, yA, zA);
      const n = o.motorPos.length;
      if (edge) {
        const outline = [[-0.15, zr], [0.15, zr], [0.15, 0.05], [0.075, zA + 0.07], [-0.075, zA + 0.07], [-0.15, 0.05]];
        const holes = [{ x: 0, y: -(zA * 0.5), r: 0.035 }];
        put(at(plateXZ(outline, 0.012, 0.003, holes), 0, g.plateY, 0), [M.frame, M.steel], 'mount', 'struct');
        const yLow = yA - t / 2 - 0.035;
        if (yLow > 0.02) {
          put(at(plateXZ(outline, 0.012, 0.003, holes), 0, yLow, 0), [M.frame, M.steel], 'mount', 'struct');
          put(merge([-1, 1].map((sx) => at(box(0.02, g.plateY - yLow, 0.05), sx * 0.13, (g.plateY + yLow) / 2, 0.02))), M.frameDark, 'mount', 'struct');
          put(cylA(0.02, g.plateY - yLow + 0.03, 12, 'y'), M.steel, 'hub', 'weapon', 0, (g.plateY + yLow) / 2, zA);
        } else {
          put(merge([-1, 1].map((sx) => at(box(0.02, g.plateY - 0.02, 0.06), sx * 0.13, g.plateY / 2 + 0.004, zr + 0.05))), M.frameDark, 'mount', 'struct');
          put(cylA(0.02, g.plateY - yA + 0.03, 12, 'y'), M.steel, 'hub', 'weapon', 0, (g.plateY + yA) / 2, zA);
        }
        put(cylA(0.04, 0.02, 14, 'y'), M.anoRed, 'hub', 'weapon', 0, g.plateY + 0.014, zA);
        bolts([[-0.13, zr + 0.03], [0.13, zr + 0.03], [-0.13, 0.03], [0.13, 0.03], [-0.05, zA + 0.04], [0.05, zA + 0.04]].map(([x, z]) => [x, g.plateY + 0.006, z]), 'y', 'mount', 0.006);
        o.motorPos.forEach((p, i) => {
          motorAt(i, p, 'y');
          put(cylA(0.008, p.y - g.beltY, 8, 'y'), M.steel, 'trans', 'weapon', p.x, (p.y + g.beltY) / 2 - wm.l * 0.25, p.z);
          belt([p.x, g.beltY, p.z], [0, g.beltY, zA], 0.022, Math.min(0.045, 0.022 * md.ratio), 0.018, 'y', G, null);
        });
      } else {
        put(cylA(0.05, g.beltY - g.baseY - 0.012, 16, 'y', 0.036), M.frame, 'mount', 'struct', 0, (g.beltY + g.baseY) / 2 - 0.006, zA);
        put(cylA(0.085, 0.012, 20, 'y'), M.frameDark, 'mount', 'struct', 0, g.baseY + 0.006, zA);
        bolts(Array.from({ length: 6 }, (_, i) => [Math.cos(i * 1.047) * 0.068, g.baseY + 0.012, zA + Math.sin(i * 1.047) * 0.068]), 'y', 'mount', 0.006);
        put(cylA(0.018, g.plateY - g.baseY, 12, 'y'), M.steel, 'hub', 'weapon', 0, (g.plateY + g.baseY) / 2, zA);
        put(cylA(0.04, 0.022, 14, 'y'), M.anoRed, 'hub', 'weapon', 0, g.plateY - 0.004, zA);
        o.motorPos.forEach((p, i) => {
          motorAt(i, p, 'y');
          belt([p.x, g.beltY, p.z], [0, g.beltY, zA], 0.022, Math.min(0.045, 0.022 * md.ratio), 0.018, 'y', G, null);
        });
      }
      A.rotor = (a) => { rot.rotation.y = a; };
      A.blur = (on) => { blur.visible = on; };
      void n;
    }
    // =====================================================================================
    // FULL-BODY SHELL (always centred on the chassis; G is the bot frame here)
    // =====================================================================================
    else if (g.ring) {
      // RING SPINNER: a toothed band on guide rollers around the hull (G is the bot frame here)
      const R = g.R, yA = g.yA, h = g.t, wall = g.wall;
      const rot = sub(G, 0, 0, 0);
      anchor('rotor', rot);
      const steel = M.shellSteel || (M.shellSteel = K.std('#7f8791', 0.32, 1, { side: THREE.DoubleSide }));
      put(merge([R, R - wall].map((r) => at(new THREE.CylinderGeometry(r, r, h, 48, 1, true), 0, yA, 0))), steel, 'rotor', 'weapon', 0, 0, 0, rot);
      const capT = new THREE.RingGeometry(R - wall, R, 48); capT.rotateX(-Math.PI / 2);
      const capB = new THREE.RingGeometry(R - wall, R, 48); capB.rotateX(Math.PI / 2);
      put(at(capT, 0, yA + h / 2, 0), M.armorShell, 'rotor', 'weapon', 0, 0, 0, rot);
      put(at(capB, 0, yA - h / 2, 0), steel, 'rotor', 'weapon', 0, 0, 0, rot);
      const teeth = [], tb = [], chev = [];
      for (let i = 0; i < md.teeth; i++) {
        const a = (i / md.teeth) * TAU;
        teeth.push(at(box(0.1, h * 0.92, 0.07), Math.sin(a) * (R + 0.016), yA, Math.cos(a) * (R + 0.016), 0, a + 0.42, 0));
        teeth.push(at(box(0.05, h * 0.96, 0.03), Math.sin(a - 0.1) * (R + 0.04), yA, Math.cos(a - 0.1) * (R + 0.04), 0, a + 0.9, 0));
        tb.push(at(cylA(0.008, 0.01, 6, 'z'), Math.sin(a + 0.08) * (R + 0.045), yA, Math.cos(a + 0.08) * (R + 0.045), 0, a + 0.42, 0));
      }
      for (let i = 0; i < 24; i++) { const a = (i / 24) * TAU; if (i % 6 < 3) chev.push(at(box(0.03, h * 0.6, 0.002), Math.sin(a) * (R + 0.001), yA, Math.cos(a) * (R + 0.001), 0, a, 0.5, 'YXZ')); }
      put(merge(teeth), M.edgeSteel, 'rotor', 'weapon', 0, 0, 0, rot);
      put(merge(tb), M.bolt, 'rotor', 'weapon', 0, 0, 0, rot);
      put(merge(chev), M.decal, 'rotor', 'decal', 0, 0, 0, rot);
      K.bolts(ctx, rot, id('rotor'), Array.from({ length: 18 }, (_, i) => [Math.cos(i * 0.349) * (R - wall / 2), yA + h / 2, Math.sin(i * 0.349) * (R - wall / 2)]), 'y', 0.0045, M.bolt, 'weapon');
      // guide rollers on outriggers from the hull
      const rr = R - wall - 0.024, arms = [], rollers = [], rc = [];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU + TAU / 12, sx = Math.sin(a), cz = Math.cos(a);
        arms.push(at(box(0.03, 0.02, R * 0.42), sx * (rr - R * 0.21), yA, cz * (rr - R * 0.21), 0, a, 0));
        rollers.push(at(cylA(0.022, h + 0.016, 12, 'y'), sx * rr, yA, cz * rr));
        rc.push(at(cylA(0.012, h + 0.03, 8, 'y'), sx * rr, yA, cz * rr));
      }
      put(merge(arms), M.frame, 'mount', 'struct');
      put(merge(rollers), M.uhmwBlack, 'mount', 'weapon');
      put(merge(rc), M.anoRed, 'mount', 'weapon');
      o.motorPos.forEach((p, i) => {
        motorAt(i, p, 'y');
        const am = Math.atan2(p.x, p.z), px = Math.sin(am) * (R - wall - 0.03), pz = Math.cos(am) * (R - wall - 0.03);
        K.rod(ctx, [p.x, p.y + wm.l / 2 + 0.01, p.z], [px, yA, pz], 0.01, M.steel, G, id('trans'), 'weapon', 8);
        put(cylA(0.03, h * 0.8, 14, 'y'), M.pulley, 'trans', 'weapon', px, yA, pz);
      });
      A.rotor = (a) => { rot.rotation.y = a; };
    }
    else if (o.kind === 'spinner') {
      const R = g.R, h = g.h, y0 = g.yBot, rTop = R * 0.88;
      const rot = sub(G, 0, 0, 0);
      anchor('rotor', rot);
      ctx.shellRot = rot; // modules that ride on the shell are parented to this
      // hardened lower ring carries the teeth; the painted cone above it is the armour
      const hr = h * 0.42;
      put(at(new THREE.CylinderGeometry(R, R, hr, 40, 1, true), 0, y0 + hr / 2, 0), M.shellSteel || (M.shellSteel = K.std('#7f8791', 0.32, 1, { side: THREE.DoubleSide })), 'rotor', 'armor', 0, 0, 0, rot);
      put(at(new THREE.CylinderGeometry(rTop, R * 0.985, h - hr, 40, 1, true), 0, y0 + hr + (h - hr) / 2, 0), M.armorShell, 'rotor', 'armor', 0, 0, 0, rot);
      const roofPts = Array.from({ length: 36 }, (_, i) => [Math.cos((i / 36) * TAU) * rTop, Math.sin((i / 36) * TAU) * rTop]);
      put(at(plateXZ(roofPts, 0.006, 0.002, ringHoles(6, rTop * 0.13, rTop * 0.6, 0.5)), 0, y0 + h, 0), [M.top, M.edge], 'rotor', 'armor', 0, 0, 0, rot);
      put(merge([y0 + 0.008, y0 + hr].map((y) => at(new THREE.CylinderGeometry(R + 0.005, R + 0.005, 0.014, 40, 1, true), 0, y, 0))), M.shellEdge || (M.shellEdge = K.std('#d3d7dc', 0.18, 1, { side: THREE.DoubleSide })), 'rotor', 'weapon', 0, 0, 0, rot);
      // ribs up the cone, chevrons on the ring, teeth
      const ribs = [], chev = [], teeth = [], tb = [];
      const tilt = -Math.atan2(R * 0.985 - rTop, h - hr), rm = (R * 0.985 + rTop) / 2 + 0.004;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * TAU;
        ribs.push(at(box(0.016, (h - hr) * 0.96, 0.012), Math.sin(a) * rm, y0 + hr + (h - hr) / 2, Math.cos(a) * rm, tilt, a, 0, 'YXZ'));
      }
      for (let i = 0; i < 28; i++) {
        const a = (i / 28) * TAU;
        if (i % 7 < 4) chev.push(at(box(0.028, hr * 0.62, 0.002), Math.sin(a) * (R + 0.001), y0 + hr * 0.52, Math.cos(a) * (R + 0.001), 0, a, 0.5, 'YXZ'));
      }
      for (let i = 0; i < md.teeth; i++) {
        const a = (i / md.teeth) * TAU;
        teeth.push(at(box(0.11, hr * 0.8, 0.075), Math.sin(a) * (R + 0.02), y0 + hr * 0.5, Math.cos(a) * (R + 0.02), 0, a + 0.42, 0));
        teeth.push(at(box(0.05, hr * 0.84, 0.03), Math.sin(a - 0.13) * (R + 0.05), y0 + hr * 0.5, Math.cos(a - 0.13) * (R + 0.05), 0, a + 0.9, 0));
        for (const yy of [0.3, 0.7]) tb.push(at(cylA(0.009, 0.01, 6, 'z'), Math.sin(a + 0.1) * (R + 0.05), y0 + hr * yy, Math.cos(a + 0.1) * (R + 0.05), 0, a + 0.42, 0));
      }
      put(merge(ribs), M.accent, 'rotor', 'weapon', 0, 0, 0, rot);
      put(merge(chev), M.decal, 'rotor', 'decal', 0, 0, 0, rot);
      put(merge(teeth), M.edgeSteel, 'rotor', 'weapon', 0, 0, 0, rot);
      put(merge(tb), M.bolt, 'rotor', 'weapon', 0, 0, 0, rot);
      // roof hub, bolts, mast and drive
      put(cylA(0.085, 0.02, 20, 'y'), M.anoBlack, 'hub', 'weapon', 0, y0 + h + 0.012, 0, rot);
      K.bolts(ctx, rot, id('hub'), Array.from({ length: 8 }, (_, i) => [Math.cos(i * 0.785) * 0.062, y0 + h + 0.022, Math.sin(i * 0.785) * 0.062]), 'y', 0.006, M.boltZinc, 'weapon');
      K.bolts(ctx, rot, id('rotor'), Array.from({ length: 20 }, (_, i) => [Math.cos(i * 0.314) * (rTop - 0.02), y0 + h + 0.003, Math.sin(i * 0.314) * (rTop - 0.02)]), 'y', 0.005, M.bolt, 'decal');
      const dk = ctx.lay.deckY;
      // stationary dead shaft; with a fixed top module it carries on through the hub to a platform above the roof
      const mastDeck = ctx.lay.shell ? ctx.lay.shell.mastDeck : null;
      const shaftTop = mastDeck ? mastDeck - 0.012 : y0 + h;
      put(cylA(0.028, shaftTop - dk, 12, 'y'), M.steel, 'hub', 'weapon', 0, (shaftTop + dk) / 2, 0);
      if (mastDeck) {
        put(cylA(0.17, 0.012, 28, 'y'), M.frame, 'mast', 'struct', 0, mastDeck - 0.006, 0);
        put(cylA(0.05, 0.03, 16, 'y', 0.034), M.frameDark, 'mast', 'struct', 0, mastDeck - 0.027, 0);
        bolts(Array.from({ length: 8 }, (_, i) => [Math.cos(i * 0.785) * 0.15, mastDeck, Math.sin(i * 0.785) * 0.15]), 'y', 'mast', 0.005);
        anchor('mast', G);
      }
      if (o.parts.some((p) => p.id === id('slip'))) {
        put(cylA(0.045, 0.05, 16, 'y'), M.anoGold, 'slip', 'elec', 0, dk + 0.055, 0);
        put(cylA(0.05, 0.012, 16, 'y'), M.frameDark, 'slip', 'elec', 0, dk + 0.086, 0, rot);
      }
      put(cylA(0.07, 0.03, 18, 'y', 0.05), M.frameDark, 'mount', 'struct', 0, dk + 0.015, 0);
      o.motorPos.forEach((p, i) => {
        motorAt(i, p, 'y');
        belt([p.x, g.beltY, p.z], [0, g.beltY, 0], 0.022, 0.05, 0.02, 'y', G, rot, [0, g.beltY, 0]);
      });
      A.rotor = (a) => { rot.rotation.y = a; };
    }
    // =====================================================================================
    // OVERHEAD ARMS: hammer, axe, hammer-saw
    // =====================================================================================
    else if (o.kind === 'hammer' || o.kind === 'armsaw') {
      const Pv = g.P, aL = g.aL, dy = g.A.y;
      const tower = [[Pv.z - 0.1, dy], [Pv.z + 0.1, dy], [Pv.z + 0.045, Pv.y + 0.045], [Pv.z - 0.045, Pv.y + 0.045]];
      for (const sx of [-1, 1]) put(plateZY(tower, 0.014, 0.003, [{ x: Pv.z, y: dy + (Pv.y - dy) * 0.45, r: 0.022 }]), [M.frame, M.steel], 'mount', 'struct', sx * 0.045);
      put(box(0.16, 0.012, 0.24), M.frameDark, 'mount', 'struct', 0, dy + 0.006, Pv.z);
      bolts([[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => [a * 0.066, dy + 0.012, Pv.z + b * 0.1]), 'y', 'mount', 0.006);
      put(cylA(0.016, 0.2, 12, 'x'), M.steel, 'mount', 'struct', 0, Pv.y, Pv.z);
      // shoulder gearbox
      const gbPart = o.kind === 'armsaw' ? 'armdrive' : 'mount';
      put(cylA(0.05, 0.06, 18, 'x'), M.gearbox, gbPart, 'weapon', -0.085, Pv.y, Pv.z);
      put(cylA(0.054, 0.012, 18, 'x'), M.anoBlack, gbPart, 'weapon', -0.06, Pv.y, Pv.z);
      const arm = sub(G, 0, Pv.y, Pv.z);
      anchor('arm', arm);
      const armPts = [[-0.06, -0.035], [aL - 0.04, -0.028], [aL, -0.02], [aL, 0.02], [aL - 0.04, 0.028], [-0.06, 0.035]];
      const armHoles = linspace(0.1, aL - 0.12, 4).map((z) => ({ x: z, y: 0, r: 0.014 }));
      for (const sx of [-1, 1]) put(plateZY(armPts, 0.008, 0.002, armHoles), [M.frame, M.steel], 'arm', 'weapon', sx * 0.019, 0, 0, arm);
      put(box(0.03, 0.012, aL - 0.02), M.frameDark, 'arm', 'weapon', 0, 0.03, aL / 2 - 0.02, arm);
      put(cylA(0.03, 0.06, 14, 'x'), M.anoRed, 'arm', 'weapon', 0, 0, 0, arm);
      let rest, down, sawRot = null, blur = null;
      if (o.kind === 'armsaw') {
        rest = 0.95; down = -0.24;
        const hub = sub(arm, 0, 0.02, aL);
        sawRot = sawBlade(hub, g.R);
        anchor('rotor', hub);
        blur = blurDisc(g.tipR, 0.006, 'x', hub);
        const mo = motorAt(0, { x: 0.03 + wm.l / 2 + 0.012, y: 0.0, z: 0.1, side: 1 }, 'x', arm);
        void mo;
        belt([0.034, 0, 0.1], [0.034, 0.02, aL], 0.02, 0.026, 0.014, 'x', arm, sawRot, [0.034, 0, 0]);
        const gd = new THREE.CylinderGeometry(g.R + 0.016, g.R + 0.016, 0.044, 14, 1, true, 0, Math.PI * 0.7);
        gd.rotateZ(-Math.PI / 2); gd.rotateX(Math.PI * 1.15);
        put(gd, M.armorShell, 'arm', 'weapon', 0, 0, 0, hub);
        A.rotor = (a) => { sawRot.rotation.x = a; };
        A.blur = (on) => { blur.visible = on; };
      } else {
        rest = 2.6; down = -0.14;
        if (k === 'hammer') {
          put(box(0.1, 0.1, 0.12), M.hardened, 'head', 'weapon', 0, -0.01, aL, arm);
          put(cylA(0.045, 0.09, 12, 'y', 0.004), M.edgeSteel, 'head', 'weapon', 0, -0.105, aL, arm);
          put(box(0.104, 0.03, 0.124), M.accent, 'head', 'weapon', 0, 0.02, aL, arm);
          K.bolts(ctx, arm, id('head'), [[0.05, -0.01, aL - 0.03], [0.05, -0.01, aL + 0.03]], 'x', 0.007, M.boltZinc, 'weapon');
        } else {
          const blade = [[aL - 0.12, 0.03], [aL + 0.03, 0.04], [aL + 0.075, -0.06], [aL + 0.05, -0.2], [aL - 0.03, -0.11], [aL - 0.09, -0.03]];
          put(plateZY(blade, 0.022, 0.006, [{ x: aL - 0.02, y: -0.03, r: 0.018 }]), [M.hardened, M.edgeSteel], 'head', 'weapon', 0, 0, 0, arm);
        }
        anchor('head', arm);
        motorAt(0, o.motorPos[0], 'x');
      }
      const setArm = (u) => { arm.rotation.x = -lerp(rest, down, u); };
      setArm(0);
      A.pose = setArm;
      A.poseMax = 1;
    }
    // =====================================================================================
    // PNEUMATIC FLIPPER
    // =====================================================================================
    else if (o.kind === 'punch') {
      const Pn = g.Pn, dy = g.A.y, az = g.A.z, rb = g.bore / 2 + 0.012, bl = g.bodyL;
      anchor('ram', put(cylA(rb, bl, 16, 'z'), M.anoBlue, 'ram', 'weapon', 0, Pn.y, Pn.z + bl / 2));
      put(merge([0.012, bl - 0.012].map((z) => at(box(2 * rb + 0.016, 2 * rb + 0.016, 0.024), 0, Pn.y, Pn.z + z))), M.anoBlack, 'ram', 'weapon');
      put(merge([[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => at(cylA(0.004, bl, 6, 'z'), a * (rb + 0.002), Pn.y + b * (rb + 0.002), Pn.z + bl / 2))), M.steel, 'ram', 'weapon');
      if (edge) {
        put(box(2 * rb + 0.07, 2 * rb + 0.05, 0.016 - zr), M.frameDark, 'ram', 'struct', 0, Pn.y, (zr + 0.016) / 2);
        bolts([[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => [a * (rb + 0.024), Pn.y + b * (rb + 0.012), 0.016]), 'z', 'ram', 0.006);
      } else {
        put(merge([0.03, bl - 0.03].map((z) => at(box(2 * rb + 0.05, Pn.y - dy, 0.03), 0, (Pn.y + dy) / 2, Pn.z + z))), M.frameDark, 'ram', 'struct');
      }
      const sp = sub(G, 0, Pn.y, Pn.z + bl);
      anchor('spike', sp);
      put(at(cylA(g.bore * 0.22, g.stroke + 0.07, 10, 'z'), 0, 0, 0.035 - (g.stroke + 0.07) / 2), M.steel, 'spike', 'weapon', 0, 0, 0, sp);
      put(at(cylA(0.034, 0.03, 12, 'z'), 0, 0, 0.045), M.anoRed, 'spike', 'weapon', 0, 0, 0, sp);
      put(at(cylA(0.03, g.spikeL - 0.03, 12, 'z', 0.003), 0, 0, 0.06 + (g.spikeL - 0.03) / 2), M.edgeSteel, 'spike', 'weapon', 0, 0, 0, sp);
      K.bottle(ctx, G, id('tank'), 0.045, 0.2, 'z', M.tank, 0.1, dy + 0.05, az);
      K.bottle(ctx, G, id('buffer'), 0.05, 0.14, 'z', M.tankBlue, -0.1, dy + 0.055, az);
      K.rod(ctx, [-0.1, dy + 0.055, az + 0.08], [0, Pn.y, Pn.z + 0.012], 0.008, M.hoseBlk, G, id('buffer'), 'weapon', 6);
      K.rod(ctx, [0.1, dy + 0.05, az + 0.11], [-0.08, dy + 0.06, az + 0.09], 0.006, M.hose, G, id('tank'), 'weapon', 6);
      A.pose = (u) => { sp.position.z = Pn.z + bl + u * g.stroke; };
      A.pose(0);
    }
    else if (o.kind === 'flipper') {
      const Hg = g.H, pw = g.plateW, pl = g.plateLen, dy = g.A.y;
      for (const sx of [-1, 1]) put(plateZY([[Hg.z - 0.05, dy], [Hg.z + 0.05, dy], [Hg.z + 0.022, Hg.y + 0.022], [Hg.z - 0.022, Hg.y + 0.022]], 0.012, 0.002), [M.frame, M.steel], 'arm', 'struct', sx * (pw / 2 + 0.012));
      put(cylA(0.011, pw + 0.05, 10, 'x'), M.steel, 'arm', 'weapon', 0, Hg.y, Hg.z);
      const arm = sub(G, 0, Hg.y, Hg.z);
      anchor('arm', arm);
      const plate = [[-pw / 2, -0.02], [pw / 2, -0.02], [pw / 2, pl], [-pw / 2, pl]];
      put(at(plateXZ(plate, 0.008, 0.002), 0, 0.008, 0), [M.armor, M.edge], 'arm', 'weapon', 0, 0, 0, arm);
      // ribs under the plate, lip at the front
      put(merge([-0.32, 0, 0.32].map((u) => at(box(0.012, 0.03, pl * 0.9), u * pw, -0.01, pl * 0.48))), M.frameDark, 'arm', 'weapon', 0, 0, 0, arm);
      const tipY = edge ? 0.018 - Hg.y : -0.03;
      const lipZ = edge ? pl + Math.min(0.14, -tipY * 0.7) : pl + 0.04;
      put(aim(box(pw, 0.008, Math.hypot(lipZ - pl, tipY - 0.008)), [0, 0.008, pl], [0, tipY, lipZ]), M.armor, 'arm', 'weapon', 0, 0, 0, arm);
      put(aim(box(pw, 0.004, 0.03), [0, tipY + 0.002, lipZ - 0.02], [0, tipY - 0.004, lipZ + 0.008]), M.edgeSteel, 'arm', 'weapon', 0, 0, 0, arm);
      for (const sx of [-1, 1]) put(plateZY([[pl - 0.1, 0.004], [pl, 0.004], [lipZ, tipY], [pl - 0.02, tipY * 0.5]], 0.006, 0.0015), [M.armor, M.edge], 'arm', 'weapon', sx * (pw / 2 - 0.004), 0, 0, arm);
      bolts(linspace(0.04, pl - 0.04, 5).flatMap((z) => [-0.32, 0, 0.32].map((u) => [u * pw, 0.012, z])), 'y', 'arm', 0.005, arm);
      put(merge(linspace(-pw * 0.4, pw * 0.4, 6).map((x) => at(box(pw * 0.08, 0.001, 0.03), x, 0.0128, pl - 0.03, 0, 0.6, 0))), M.decalDark, 'arm', 'decal', 0, 0, 0, arm);
      // ram
      const base = new THREE.Vector3(0, dy + 0.03, Hg.z + 0.07);
      const lug = new THREE.Vector3(0, -0.012, pl * 0.5);
      put(box(0.07, 0.03, 0.05), M.frameDark, 'cyl', 'weapon', base.x, dy + 0.015, base.z);
      const setRam = ram('cyl', g.bore / 2 + 0.008, g.bore * 0.22, M.anoBlue);
      anchor('cyl', put(cylA(0.014, 0.08, 8, 'x'), M.steel, 'cyl', 'weapon', base.x, base.y, base.z));
      // tank + buffer + plumbing
      const tx = pw / 2 + 0.075;
      K.bottle(ctx, G, id('tank'), 0.05, 0.3, 'z', M.tank, tx, dy + 0.058, Hg.z + 0.13);
      put(merge([-0.09, 0.09].map((u) => at(box(0.108, 0.012, 0.02), tx, dy + 0.058, Hg.z + 0.13 + u))), M.frameDark, 'tank', 'weapon');
      K.bottle(ctx, G, id('buffer'), 0.056, 0.17, 'z', M.tankBlue, -tx, dy + 0.062, Hg.z + 0.1);
      put(box(0.05, 0.05, 0.05), M.brass, 'buffer', 'weapon', -tx + 0.02, dy + 0.04, Hg.z + 0.23);
      K.rod(ctx, [-tx + 0.02, dy + 0.04, Hg.z + 0.23], [-0.03, dy + 0.03, Hg.z + 0.09], 0.009, M.hoseBlk, G, id('buffer'), 'weapon', 6);
      K.rod(ctx, [tx, dy + 0.058, Hg.z + 0.3], [-tx + 0.04, dy + 0.045, Hg.z + 0.25], 0.006, M.hose, G, id('tank'), 'weapon', 6);
      const maxA = 1.05;
      const v = new THREE.Vector3();
      A.pose = (u) => {
        arm.rotation.x = -u * maxA;
        v.copy(lug).applyAxisAngle(new THREE.Vector3(1, 0, 0), -u * maxA).add(arm.position);
        setRam(base, v, 0.12);
      };
      A.pose(0);
    }
    // =====================================================================================
    // ELECTRIC LIFTER
    // =====================================================================================
    else if (o.kind === 'lifter') {
      const Hg = g.H, aL = g.armL, dy = g.A.y;
      const drop = edge ? Hg.y - 0.014 : 0.03;
      put(merge([-1, 1].map((sx) => at(box(0.016, Hg.y - dy + 0.03, 0.07), sx * 0.19, (Hg.y + dy) / 2, Hg.z))), M.frame, 'mount', 'struct');
      put(box(0.1, 0.07, 0.09), M.gearbox, 'mount', 'weapon', 0, Hg.y - 0.005, Hg.z - 0.05);
      put(box(0.102, 0.02, 0.092), M.anoBlack, 'mount', 'weapon', 0, Hg.y + 0.02, Hg.z - 0.05);
      const arm = sub(G, 0, Hg.y, Hg.z);
      anchor('arm', arm);
      put(cylA(0.016, 0.4, 12, 'x'), M.steel, 'arm', 'weapon', 0, 0, 0, arm);
      const tine = edge
        ? [[-0.02, 0.022], [0.035, 0.022], [0.06, -drop + 0.05], [aL, -drop + 0.012], [aL + 0.02, -drop], [0.03, -drop], [0.012, -0.02], [-0.02, -0.02]]
        : [[-0.02, 0.022], [0.04, 0.022], [aL, -drop + 0.012], [aL + 0.02, -drop], [0.02, -drop], [-0.02, -0.02]];
      for (const x of [-0.15, -0.06, 0.06, 0.15]) put(plateZY(tine, 0.016, 0.003), [M.toolSteel, M.edgeSteel], 'arm', 'weapon', x, 0, 0, arm);
      put(box(0.33, 0.02, 0.02), M.frameDark, 'arm', 'weapon', 0, -drop * 0.45, edge ? 0.05 : aL * 0.45, arm);
      motorAt(0, o.motorPos[0], 'x');
      let jaw = null;
      if (g.clamp) {
        // upper jaw hinged at the fork pivot: closes on the load before the arm lifts
        const ty = -drop + 0.012 + 0.16 - 0.03;
        jaw = sub(arm, 0, 0.03, 0);
        const jp = [[-0.02, 0.02], [0.05, 0.035], [aL * 0.8, ty + 0.03], [aL * 0.92, ty - 0.05], [aL * 0.8, ty - 0.005], [0.04, -0.01], [-0.02, -0.02]];
        for (const x of [-0.105, 0.105]) put(plateZY(jp, 0.014, 0.003), [M.hardened, M.edgeSteel], 'clamp', 'weapon', x, 0, 0, jaw);
        put(box(0.224, 0.016, 0.03), M.frameDark, 'clamp', 'weapon', 0, ty + 0.01, aL * 0.8, jaw);
        put(cylA(0.02, 0.26, 12, 'x'), M.anoRed, 'clamp', 'weapon', 0, 0, 0, jaw);
        anchor('clamp', jaw);
      }
      A.pose = (u) => {
        const cu = g.clamp ? Math.min(1, u / 0.25) : 0, lu = g.clamp ? Math.max(0, (u - 0.25) / 0.75) : u;
        arm.rotation.x = -lu * g.sweep;
        if (jaw) jaw.rotation.x = cu * 0.32;
      };
    }
    // =====================================================================================
    // HYDRAULIC CRUSHER
    // =====================================================================================
    else if (o.kind === 'crusher') {
      const Pv = g.P, reach = g.reach, dy = g.A.y;
      const jawY = edge ? 0.04 : dy + 0.02;
      const tipY = jawY + 0.02 - Pv.y;
      for (const sx of [-1, 1]) put(plateZY([[Pv.z - 0.09, dy], [Pv.z + 0.09, dy], [Pv.z + 0.04, Pv.y + 0.04], [Pv.z - 0.04, Pv.y + 0.04]], 0.016, 0.003), [M.frame, M.steel], 'beak', 'struct', sx * 0.034);
      put(cylA(0.018, 0.11, 12, 'x'), M.steel, 'beak', 'weapon', 0, Pv.y, Pv.z);
      const beakG = sub(G, 0, Pv.y, Pv.z);
      anchor('beak', beakG);
      const bk = [[-0.11, 0.03], [-0.08, 0.1], [0.02, 0.13], [reach * 0.5, 0.2], [reach * 0.9, 0.15], [reach + 0.04, 0.02], [reach + 0.012, tipY], [reach - 0.03, tipY * 0.3 + 0.03], [reach * 0.7, 0.07], [0.05, 0.03], [0, -0.045], [-0.06, -0.03]];
      put(plateZY(bk, 0.032, 0.006, [{ x: reach * 0.45, y: 0.13, r: 0.022 }, { x: reach * 0.2, y: 0.085, r: 0.016 }]), [M.toolSteel, M.edgeSteel], 'beak', 'weapon', 0, 0, 0, beakG);
      put(aim(cylA(0.018, 0.07, 8, 'z', 0.002), [0, tipY + 0.05, reach + 0.006], [0, tipY - 0.012, reach + 0.004]), M.edgeSteel, 'beak', 'weapon', 0, 0, 0, beakG);
      // lower jaw
      const z0 = edge ? zr : Pv.z - 0.02;
      const jaw = [[z0, jawY - 0.03], [Pv.z + reach + 0.05, jawY - 0.03], [Pv.z + reach + 0.06, jawY - 0.012], [Pv.z + reach + 0.02, jawY + 0.012], [Pv.z + reach - 0.03, jawY - 0.008], [Pv.z + reach - 0.08, jawY + 0.01], [Pv.z + reach - 0.13, jawY - 0.008], [z0, jawY - 0.008]];
      for (const sx of [-1, 1]) put(plateZY(jaw, 0.02, 0.003), [M.toolSteel, M.edgeSteel], 'jaw', 'weapon', sx * 0.045);
      put(box(0.11, 0.012, 0.1), M.frameDark, 'jaw', 'weapon', 0, jawY - 0.024, Pv.z + reach - 0.1);
      anchor('jaw', put(box(0.11, 0.012, 0.03), M.frameDark, 'jaw', 'weapon', 0, jawY - 0.024, z0 + 0.03));
      // cylinder + pump + reservoir
      const base = new THREE.Vector3(0, dy + 0.045, Pv.z - 0.27);
      put(box(0.06, 0.05, 0.03), M.frameDark, 'cyl', 'weapon', 0, dy + 0.03, base.z - 0.01);
      const setRam = ram('cyl', g.bore / 2 + 0.01, g.bore * 0.3, M.anoBlack);
      anchor('cyl', put(cylA(0.012, 0.07, 8, 'x'), M.steel, 'cyl', 'weapon', 0, base.y, base.z));
      put(box(0.07, 0.07, 0.1), M.anoBlack, 'pump', 'weapon', -0.11, dy + 0.04, Pv.z - 0.2);
      put(cylA(0.034, 0.12, 14, 'y'), M.tank, 'pump', 'weapon', -0.11, dy + 0.13, Pv.z - 0.21);
      put(cylA(0.02, 0.01, 10, 'y'), M.anoRed, 'pump', 'weapon', -0.11, dy + 0.195, Pv.z - 0.21);
      K.rod(ctx, [-0.08, dy + 0.05, Pv.z - 0.16], [-0.02, dy + 0.05, base.z + 0.02], 0.008, M.hoseBlk, G, id('pump'), 'weapon', 6);
      K.rod(ctx, [-0.08, dy + 0.07, Pv.z - 0.24], [-0.02, dy + 0.06, base.z + 0.06], 0.008, M.hoseBlk, G, id('pump'), 'weapon', 6);
      motorAt(0, o.motorPos[0], 'z');
      const lug = new THREE.Vector3(0, 0.06, -0.09), v = new THREE.Vector3(), ax = new THREE.Vector3(1, 0, 0);
      const open = 0.62;
      A.pose = (u) => {
        const a = -open * (1 - u);
        beakG.rotation.x = a;
        v.copy(lug).applyAxisAngle(ax, a).add(beakG.position);
        setRam(base, v, 0.13);
      };
      A.pose(0);
    }
    // =====================================================================================
    // CLAMP ARMS
    // =====================================================================================
    else if (o.kind === 'grabber') {
      const aL = g.armL, hw = g.halfW, y = g.y, z = g.z;
      const claws = [];
      for (const sx of [-1, 1]) {
        if (edge) put(box(0.07, 0.07, 0.05), M.frameDark, 'drive', 'struct', sx * hw, y, z - 0.005);
        put(cylA(0.03, 0.1, 14, 'y'), M.gearbox, 'drive', 'weapon', sx * hw, y - 0.01, z + 0.03);
        put(cylA(0.024, 0.05, 12, 'y'), M.motorCan, 'drive', 'weapon', sx * hw, y - 0.085, z + 0.03);
        const c = sub(G, sx * hw, y + 0.05, z + 0.03);
        const o2 = [[0.022, -0.02], [0.034, aL * 0.5], [0.0, aL * 0.92], [-0.09, aL], [-0.04, aL * 0.8], [-0.014, aL * 0.45], [-0.022, -0.02]].map((p) => [p[0] * sx, p[1]]);
        put(plateXZ(o2, 0.024, 0.005, [{ x: 0.006 * sx, y: aL * 0.3, r: 0.01 }]), [M.toolSteel, M.edgeSteel], 'claws', 'weapon', 0, 0, 0, c);
        put(cylA(0.022, 0.03, 12, 'y'), M.anoRed, 'claws', 'weapon', 0, 0, 0, c);
        claws.push({ c, sx });
      }
      anchor('claws', claws[1].c);
      A.pose = (u) => { for (const cl of claws) cl.c.rotation.y = cl.sx * lerp(0.5, -0.55, u); };
      A.pose(0);
    }
    // =====================================================================================
    // TURRETS: flamethrower, arc emitter, spike / net launchers, coilgun, autocannon
    // =====================================================================================
    else if (g.T) {
      const T = g.T, bl = g.barrel, pay = g.payload;
      put(cylA(0.085, 0.018, 20, 'y'), M.anoBlack, 'turret', 'weapon', 0, T.y + 0.009, T.z);
      bolts(Array.from({ length: 8 }, (_, i) => [Math.cos(i * 0.785) * 0.07, T.y + 0.018, T.z + Math.sin(i * 0.785) * 0.07]), 'y', 'turret', 0.005);
      put(cylA(0.05, 0.03, 16, 'y'), M.gearbox, 'turret', 'weapon', 0, T.y + 0.033, T.z);
      const gy = T.y + 0.1;
      for (const sx of [-1, 1]) put(plateZY([[T.z - 0.045, T.y + 0.045], [T.z + 0.045, T.y + 0.045], [T.z + 0.025, gy + 0.03], [T.z - 0.025, gy + 0.03]], 0.008, 0.002), [M.frame, M.steel], 'turret', 'weapon', sx * 0.045);
      const gun = sub(G, 0, gy, T.z);
      anchor('turret', gun);
      put(cylA(0.012, 0.11, 10, 'x'), M.steel, 'turret', 'weapon', 0, 0, 0, gun);
      const tp = (geo, mat, x, y2, z2) => put(geo, mat, 'turret', 'weapon', x, y2, z2, gun);
      const glowAt = (r, mat, x, y2, z2) => { const q = fxMesh(new THREE.SphereGeometry(r, 10, 8), mat, gun); q.position.set(x, y2, z2); return q; };
      const dy = g.A.y, az = g.A.z;

      if (pay === 'flame') {
        tp(box(0.07, 0.07, 0.14), M.frameDark, 0, 0, 0.02);
        tp(cylA(0.02, bl, 12, 'z'), M.steel, 0, 0.005, 0.09 + bl / 2);
        tp(cylA(0.03, bl * 0.3, 12, 'z', 0.022), M.scorched, 0, 0.005, 0.09 + bl * 0.86);
        tp(merge(linspace(0.2, 0.62, 5).map((u) => at(cylA(0.027, 0.006, 12, 'z'), 0, 0.005, 0.09 + bl * u))), M.anoBlack, 0, 0, 0);
        tp(cylA(0.006, bl * 0.8, 6, 'z'), M.brass, 0, -0.03, 0.09 + bl * 0.5);
        tp(box(0.014, 0.03, 0.014), M.brass, 0, -0.018, 0.09 + bl * 0.9);
        anchor('fuel', K.bottle(ctx, G, id('fuel'), 0.045, 0.2, 'z', M.tankRed, 0.11, dy + 0.05, az - 0.05));
        put(box(0.05, 0.04, 0.05), M.brass, 'valve', 'weapon', -0.08, dy + 0.03, az);
        put(cylA(0.012, 0.03, 8, 'y'), M.anoBlue, 'valve', 'weapon', -0.08, dy + 0.065, az);
        K.rod(ctx, [0.11, dy + 0.05, az + 0.06], [-0.06, dy + 0.04, az + 0.02], 0.006, M.hose, G, id('valve'), 'weapon', 6);
        K.rod(ctx, [-0.08, dy + 0.05, az + 0.02], [0, gy - 0.03, T.z + 0.05], 0.006, M.hose, G, id('valve'), 'weapon', 6);
        // flame: nested additive cones along +z, tip at the nozzle
        const z0 = 0.09 + bl, len = o.flame.rangeM;
        const cone = (r, l, mat) => { const q = fxMesh(at(cylA(r, l, 10, 'z', 0.012, true), 0, 0, l / 2), mat, gun); q.position.set(0, 0.005, z0); return q; };
        const fl = [cone(0.2 * s, len, M.flameOuter), cone(0.13 * s, len * 0.8, M.flameMid), cone(0.06 * s, len * 0.5, M.flameCore)];
        const puffs = [0.6, 0.72, 0.85, 0.95, 1.05].map((u) => glowAt(0.07 * s, M.flamePuff, 0, 0.005, z0 + len * u));
        const pilot = cone(0.012, 0.05, M.flameBlue);
        pilot.position.set(0, -0.012, z0 - 0.01);
        A.fx = (lv, t) => {
          const on = lv > 0.02;
          pilot.visible = true;
          pilot.scale.setScalar(0.8 + 0.3 * Math.sin(t * 31));
          fl.forEach((q, i) => {
            q.visible = on;
            if (on) { const f = 0.86 + 0.14 * Math.sin(t * (23 + i * 9) + i); q.scale.set(lv * (0.9 + 0.2 * Math.sin(t * 17 + i * 2)), lv * f, lv * f); }
          });
          puffs.forEach((q, i) => {
            q.visible = on && lv > 0.5;
            if (q.visible) { const ph = (t * 1.7 + i * 0.21) % 1; q.position.z = z0 + len * (0.45 + 0.65 * ph); q.position.y = 0.005 + ph * ph * 0.22; q.position.x = Math.sin(i * 2.4 + t * 3) * 0.05 * ph; q.scale.setScalar((0.6 + ph * 1.5) * lv); }
          });
        };
        A.fx(0, 0);
      } else if (pay === 'arc') {
        // insulator stack + twin horn electrodes
        tp(merge([0, 1, 2, 3, 4].map((i) => at(cylA(i % 2 ? 0.024 : 0.04, 0.02, 14, 'y'), 0, 0.02 + i * 0.02, 0.02))), M.ceramic, 0, 0, 0);
        tp(box(0.09, 0.03, 0.07), M.frameDark, 0, 0, 0.02);
        const tipL = [-0.03 * s - 0.01, 0.13 + bl * 0.5, 0.06 + bl * 0.9], tipR = [0.03 * s + 0.01, 0.13 + bl * 0.5, 0.06 + bl * 0.9];
        for (const [sx, tip] of [[-1, tipL], [1, tipR]]) {
          K.rod(ctx, [sx * 0.012, 0.11, 0.03], [sx * 0.06, 0.12, 0.06 + bl * 0.3], 0.007, M.copper, gun, id('turret'), 'weapon', 6);
          K.rod(ctx, [sx * 0.06, 0.12, 0.06 + bl * 0.3], tip, 0.007, M.copper, gun, id('turret'), 'weapon', 6);
          tp(new THREE.SphereGeometry(0.014, 10, 8), M.steel, tip[0], tip[1], tip[2]);
        }
        put(merge([[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => at(cylA(0.032, 0.1, 14, 'y'), a * 0.036, dy + 0.062, az - 0.12 + b * 0.036))), M.capBig, 'caps', 'weapon');
        put(merge([-1, 1].map((b) => at(box(0.09, 0.006, 0.014), 0, dy + 0.115, az - 0.12 + b * 0.036))), M.copper, 'caps', 'weapon');
        anchor('caps', put(box(0.15, 0.012, 0.15), M.frameDark, 'caps', 'weapon', 0, dy + 0.006, az - 0.12));
        put(box(0.07, 0.06, 0.1), M.esc, 'hv', 'weapon', 0.105, dy + 0.03, az - 0.02);
        put(merge(linspace(-0.04, 0.04, 6).map((u) => at(box(0.066, 0.02, 0.006), 0.105, dy + 0.07, az - 0.02 + u))), M.escFin, 'hv', 'weapon');
        put(box(0.03, 0.001, 0.03), M.packLabel, 'hv', 'decal', 0.105, dy + 0.0606, az - 0.05);
        K.rod(ctx, [0.07, dy + 0.05, az - 0.02], [0.01, gy, T.z + 0.01], 0.006, M.wireRed, G, id('hv'), 'weapon', 6);
        // bolts of lightning: chains of short segments re-jittered every frame
        const mkBolt = (n, r, mat) => Array.from({ length: n }, () => fxMesh(cylA(r, 1, 4, 'z'), mat, gun));
        const gap = mkBolt(6, 0.003, M.arc), strike = mkBolt(9, 0.0035, M.arc), strike2 = mkBolt(7, 0.0025, M.arcGlow);
        const glows = [glowAt(0.03, M.arcGlow, tipL[0], tipL[1], tipL[2]), glowAt(0.03, M.arcGlow, tipR[0], tipR[1], tipR[2]), glowAt(0.035, M.arcGlow, 0, tipL[1], tipL[2] + 0.75)];
        const a3 = new THREE.Vector3(), b3 = new THREE.Vector3(), p0 = new THREE.Vector3(), p1 = new THREE.Vector3();
        const lay = (segs, from, to, amp, on) => {
          a3.set(from[0], from[1], from[2]); b3.set(to[0], to[1], to[2]);
          p0.copy(a3);
          segs.forEach((q, i) => {
            q.visible = on;
            if (!on) return;
            const u = (i + 1) / segs.length;
            p1.copy(a3).lerp(b3, u);
            if (i < segs.length - 1) p1.add(new THREE.Vector3((Math.random() - 0.5) * amp, (Math.random() - 0.5) * amp, (Math.random() - 0.5) * amp * 0.5));
            K.stretch(q, p0, p1);
            p0.copy(p1);
          });
        };
        A.fx = (lv) => {
          const on = lv > 0.02;
          const target = [(Math.random() - 0.5) * 0.3, tipL[1] - 0.05 + (Math.random() - 0.5) * 0.2, tipL[2] + 0.75];
          lay(gap, tipL, tipR, 0.03, on);
          lay(strike, Math.random() < 0.5 ? tipL : tipR, target, 0.12, on && lv > 0.3);
          lay(strike2, Math.random() < 0.5 ? tipL : tipR, [target[0] + 0.2, target[1] - 0.1, target[2] - 0.2], 0.1, on && lv > 0.6);
          glows.forEach((q, i) => { q.visible = on && (i < 2 || lv > 0.3); if (q.visible) q.scale.setScalar(0.7 + Math.random() * 0.8); });
        };
        A.fx(0);
      } else {
        // ---- projectile launchers ----
        const fdx = 0.08, fdy = dy + 0.06, fdz = az - 0.08;
        let muzzleZ = 0.06 + bl, shot;
        if (pay === 'spike') {
          tp(box(0.08, 0.08, 0.16), M.frameDark, 0, 0, 0.0);
          tp(cylA(0.03, bl, 14, 'z'), M.steel, 0, 0.01, 0.06 + bl / 2);
          tp(merge([0.25, 0.6].map((u) => at(cylA(0.036, 0.02, 14, 'z'), 0, 0.01, 0.06 + bl * u))), M.anoBlack, 0, 0, 0);
          tp(cylA(0.04, 0.03, 14, 'z'), M.anoRed, 0, 0.01, 0.06 + bl - 0.015);
          K.bottle(ctx, gun, id('turret'), 0.03, bl * 0.7, 'z', M.tankBlue, 0, -0.05, 0.06 + bl * 0.4);
          K.bottle(ctx, G, id('feed'), 0.04, 0.2, 'z', M.tank, fdx + 0.02, fdy - 0.01, fdz);
          const sp = sub(gun, 0, 0.01, muzzleZ - 0.1);
          put(cylA(0.012, 0.3, 8, 'z'), M.steel, 'turret', 'weapon', 0, 0, 0, sp);
          put(cylA(0.022, 0.1, 10, 'z', 0.001), M.edgeSteel, 'turret', 'weapon', 0, 0, 0.2, sp);
          const tether = fxMesh(cylA(0.003, 1, 4, 'z'), M.chain, gun);
          tether.material = M.chain; tether.userData.base = M.chain;
          const a3 = new THREE.Vector3(0, 0.01, muzzleZ - 0.2), b3 = new THREE.Vector3();
          shot = (u) => {
            const d = u <= 0 ? 0 : u < 0.12 ? (u / 0.12) * 1.3 : u < 0.35 ? 1.3 : 1.3 * (1 - (u - 0.35) / 0.65);
            sp.position.z = muzzleZ - 0.1 + d;
            tether.visible = d > 0.02;
            if (tether.visible) K.stretch(tether, a3, b3.set(0, 0.01, sp.position.z - 0.14));
          };
        } else if (pay === 'net') {
          tp(box(0.14, 0.1, 0.12), M.frameDark, 0, 0, 0.0);
          const bar = [];
          for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) bar.push(aim(cylA(0.03, bl, 12, 'z', 0.024), [a * 0.03, b * 0.025, 0.05], [a * 0.05, b * 0.04, 0.05 + bl]));
          tp(merge(bar), M.steel, 0, 0, 0);
          tp(box(0.15, 0.02, 0.03), M.anoRed, 0, 0, 0.06);
          put(merge([-1, 1].map((a) => at(cylA(0.022, 0.14, 12, 'z'), fdx + a * 0.026, fdy - 0.02, fdz))), M.tank, 'feed', 'weapon');
          muzzleZ = 0.05 + bl;
          const net = sub(gun, 0, 0, muzzleZ);
          const lines = [];
          for (const u of linspace(-0.5, 0.5, 6)) { lines.push(at(box(0.006, 1, 0.006), u, 0, 0)); lines.push(at(box(1, 0.006, 0.006), 0, u, 0)); }
          const nm = fxMesh(merge(lines), M.signal, net); nm.material = M.signal; nm.userData.base = M.signal;
          const wts = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => { const q = fxMesh(new THREE.SphereGeometry(0.024, 8, 6), M.steel, net); q.material = M.steel; q.userData.base = M.steel; q.position.set(a * 0.5, b * 0.5, 0); return q; });
          shot = (u) => {
            const on = u > 0 && u < 1;
            nm.visible = on; wts.forEach((q) => { q.visible = on; });
            if (!on) return;
            const d = 1 - Math.pow(1 - u, 2);
            net.position.set(0, 0.25 * Math.sin(u * 3.1) - u * u * 0.3, muzzleZ + d * 2.2);
            net.scale.set(0.1 + d * 1.4, 0.1 + d * 1.4, 1);
            net.rotation.z = u * 1.5;
          };
        } else if (pay === 'coil') {
          tp(box(0.09, 0.08, 0.14), M.frameDark, 0, 0, 0.0);
          tp(cylA(0.016, bl, 10, 'z'), M.ceramic, 0, 0.01, 0.06 + bl / 2);
          const coils = linspace(0.12, 0.86, 5);
          tp(merge(coils.map((u) => at(cylA(0.04, bl * 0.1, 16, 'z'), 0, 0.01, 0.06 + bl * u))), M.copper, 0, 0, 0);
          tp(merge(coils.flatMap((u) => [-1, 1].map((e) => at(cylA(0.043, 0.006, 16, 'z'), 0, 0.01, 0.06 + bl * u + e * bl * 0.055)))), M.anoBlack, 0, 0, 0);
          tp(merge([-1, 1].map((sx) => at(box(0.008, 0.016, bl), sx * 0.05, 0.01, 0.06 + bl / 2))), M.frame, 0, 0, 0);
          tp(merge(coils.map((u) => at(box(0.11, 0.008, 0.008), 0, 0.01, 0.06 + bl * u))), M.frame, 0, 0, 0);
          put(merge([[-1, -1], [1, -1], [-1, 1], [1, 1], [-1, 0], [1, 0]].map(([a, b]) => at(cylA(0.024, 0.09, 12, 'y'), fdx + a * 0.027, fdy, fdz + b * 0.052))), M.cap, 'feed', 'weapon');
          put(box(0.11, 0.008, 0.16), M.pcb, 'feed', 'weapon', fdx, fdy - 0.048, fdz);
          const rings = coils.map((u) => { const q = fxMesh(cylA(0.05, bl * 0.11, 14, 'z', null, true), M.arcGlow, gun); q.position.set(0, 0.01, 0.06 + bl * u); return q; });
          const slug = fxMesh(at(box(0.012, 0.012, 0.5), 0, 0, 0.25), M.arc, gun);
          shot = (u) => {
            rings.forEach((q, i) => { q.visible = u > 0 && Math.abs(u * 30 - i) < 1.2; });
            slug.visible = u > 0.16 && u < 0.5;
            if (slug.visible) slug.position.set(0, 0.01, muzzleZ + (u - 0.16) * 9);
          };
        } else if (pay === 'harpoon') {
          tp(box(0.09, 0.09, 0.18), M.frameDark, 0, 0, 0.0);
          tp(cylA(0.036, bl, 14, 'z'), M.steel, 0, 0.01, 0.06 + bl / 2);
          tp(merge([0.2, 0.55, 0.9].map((u) => at(cylA(0.042, 0.022, 14, 'z'), 0, 0.01, 0.06 + bl * u))), M.anoBlack, 0, 0, 0);
          tp(box(0.1, 0.02, 0.05), M.accent, 0, 0.055, 0.0);
          // winch drum, cable and gas bottle beside the turret
          put(cylA(0.05, 0.09, 18, 'x'), M.gearbox, 'feed', 'weapon', fdx + 0.03, fdy + 0.005, fdz + 0.02);
          put(merge([-1, 1].map((e) => at(cylA(0.062, 0.008, 18, 'x'), fdx + 0.03 + e * 0.045, fdy + 0.005, fdz + 0.02))), M.anoBlack, 'feed', 'weapon');
          put(cylA(0.054, 0.07, 14, 'x'), M.chain, 'feed', 'weapon', fdx + 0.03, fdy + 0.005, fdz + 0.02);
          K.bottle(ctx, G, id('feed'), 0.03, 0.15, 'z', M.tank, fdx + 0.03, fdy - 0.035, fdz - 0.08);
          const sp = sub(gun, 0, 0.01, muzzleZ - 0.12);
          put(cylA(0.014, 0.34, 8, 'z'), M.steel, 'turret', 'weapon', 0, 0, 0, sp);
          put(cylA(0.03, 0.12, 10, 'z', 0.001), M.edgeSteel, 'turret', 'weapon', 0, 0, 0.23, sp);
          put(merge([-1, 1].map((e) => at(box(0.07, 0.006, 0.05), e * 0.032, 0, 0.15, 0, e * 0.55, 0))), M.hardened, 'turret', 'weapon', 0, 0, 0, sp);
          const tether = fxMesh(cylA(0.004, 1, 4, 'z'), M.chain, gun);
          tether.material = M.chain; tether.userData.base = M.chain;
          const a3 = new THREE.Vector3(0, 0.01, muzzleZ - 0.2), b3 = new THREE.Vector3();
          shot = (u) => {
            const d = u <= 0 ? 0 : u < 0.1 ? (u / 0.1) * 1.6 : u < 0.4 ? 1.6 : 1.6 * (1 - (u - 0.4) / 0.6);
            sp.position.z = muzzleZ - 0.12 + d;
            tether.visible = d > 0.02;
            if (tether.visible) K.stretch(tether, a3, b3.set(0, 0.01, sp.position.z - 0.16));
          };
        } else {
          // autocannon: twin barrels, receiver, drum feed, optic
          tp(box(0.11, 0.09, 0.2), M.frameDark, 0, 0, 0.02);
          tp(box(0.114, 0.03, 0.12), M.accent, 0, 0.03, 0.0);
          const barrels = [-1, 1].map((sx) => {
            const b = sub(gun, sx * 0.028, 0.0, 0.12);
            put(cylA(0.013, bl, 10, 'z'), M.hardened, 'turret', 'weapon', 0, 0, bl / 2, b);
            put(cylA(0.02, bl * 0.34, 10, 'z'), M.frameDark, 'turret', 'weapon', 0, 0, bl * 0.2, b);
            put(cylA(0.021, 0.05, 10, 'z'), M.toolSteel, 'turret', 'weapon', 0, 0, bl - 0.025, b);
            put(merge([0, 1, 2].map((i) => at(box(0.046, 0.006, 0.006), 0, 0, bl - 0.04 + i * 0.014))), M.gouge, 'turret', 'weapon', 0, 0, 0, b);
            return b;
          });
          tp(cylA(0.018, 0.07, 10, 'z'), M.anoBlack, 0, 0.068, 0.0);
          tp(cylA(0.015, 0.004, 10, 'z'), M.lens, 0, 0.068, 0.036);
          tp(new THREE.SphereGeometry(0.006, 6, 5), M.ledRed, 0.04, 0.05, 0.1);
          put(cylA(0.06, 0.07, 18, 'x'), M.frameDark, 'feed', 'weapon', fdx + 0.03, fdy + 0.01, fdz + 0.03);
          put(cylA(0.062, 0.01, 18, 'x'), M.accent, 'feed', 'weapon', fdx + 0.03, fdy + 0.01, fdz + 0.03);
          K.strut(ctx, [fdx, fdy + 0.04, fdz + 0.05], [0.05, gy, T.z], 0.03, 0.012, M.boltZinc, G, id('feed'), 'weapon');
          muzzleZ = 0.12 + bl;
          const flashGeo = () => merge([at(cylA(0.05, 0.14, 8, 'z', 0.004, true), 0, 0, 0.07), at(box(0.2, 0.012, 0.012), 0, 0, 0.02), at(box(0.012, 0.2, 0.012), 0, 0, 0.02)]);
          const flashes = barrels.map((b) => { const q = fxMesh(flashGeo(), M.muzzle, b); q.position.z = bl; return q; });
          const tracers = Array.from({ length: 5 }, () => fxMesh(at(box(0.008, 0.008, 0.3), 0, 0, 0.15), M.tracer, gun));
          shot = (u, t) => {
            const on = u > 0 && u < 1;
            const beat = Math.floor(t * 10);
            barrels.forEach((b, i) => {
              const mine = on && beat % 2 === i;
              const ph = (t * 10) % 1;
              b.position.z = 0.12 - (mine ? 0.03 * (1 - ph) : 0);
              flashes[i].visible = mine && ph < 0.45;
              if (flashes[i].visible) { flashes[i].rotation.z = beat * 1.3; flashes[i].scale.setScalar(0.7 + 0.6 * (1 - ph)); }
            });
            tracers.forEach((q, i) => {
              q.visible = on;
              if (on) { const ph = (t * 3.3 + i * 0.2) % 1; q.position.set(i % 2 ? 0.028 : -0.028, 0, muzzleZ + ph * 3.2); }
            });
          };
        }
        anchor('feed', put(box(0.02, 0.01, 0.02), M.frameDark, 'feed', 'weapon', fdx, dy + 0.005, fdz));
        A.fx = (lv, t, u) => shot(u || 0, t || 0);
        A.fx(0, 0, 0);
      }
    }
    // =====================================================================================
    // SELF-RIGHTING ARM
    // =====================================================================================
    else if (o.kind === 'melty') {
      // only the controller is a part; the test stand spins the whole bot (A.whole)
      const C = g.C;
      put(box(0.11, 0.008, 0.09), M.frameDark, 'brain', 'elec', 0, C.y + 0.004, C.z);
      anchor('brain', put(box(0.09, 0.022, 0.07), M.anoBlack, 'brain', 'elec', 0, C.y + 0.019, C.z));
      put(box(0.05, 0.003, 0.04), M.pcb, 'brain', 'elec', 0, C.y + 0.0315, C.z - 0.005);
      put(cylA(0.008, 0.045, 8, 'y'), M.frame, 'beacon', 'elec', 0, C.y + 0.03, C.z + 0.05);
      put(box(0.07, 0.012, 0.012), M.ledRed, 'beacon', 'elec', 0, C.y + 0.058, C.z + 0.05);
      A.whole = true;
    }
    else if (o.kind === 'srimech') {
      const Hg = g.H, aL = g.armL, dy = g.A.y;
      put(merge([-1, 1].map((sx) => at(box(0.012, 0.05, 0.05), sx * 0.04, dy + 0.025, Hg.z))), M.frame, 'arm', 'struct');
      put(box(0.05, 0.05, 0.07), M.anoBlack, 'servo', 'weapon', 0.08, dy + 0.027, Hg.z);
      put(box(0.052, 0.006, 0.072), M.anoBlue, 'servo', 'weapon', 0.08, dy + 0.055, Hg.z);
      const arm = sub(G, 0, Hg.y, Hg.z);
      anchor('arm', arm);
      put(cylA(0.012, 0.1, 10, 'x'), M.steel, 'arm', 'weapon', 0, 0, 0, arm);
      const pts = [[-0.03, -0.018], [aL - 0.03, -0.014], [aL, 0], [aL - 0.03, 0.014], [-0.03, 0.018]];
      for (const sx of [-1, 1]) put(plateZY(pts, 0.008, 0.002, linspace(0.08, aL - 0.1, 3).map((z) => ({ x: z, y: 0, r: 0.008 }))), [M.frame, M.steel], 'arm', 'weapon', sx * 0.022, 0, 0, arm);
      put(cylA(0.016, 0.06, 10, 'x'), M.uhmwBlack, 'arm', 'weapon', 0, 0, aL - 0.01, arm);
      A.pose = (u) => { arm.rotation.x = -lerp(Math.PI - 0.06, 0.1, u); };
      A.pose(0);
    }
    // =====================================================================================
    // PASSIVE TOOLS
    // =====================================================================================
    else {
      const w = Math.min(g.w, 1.0) * 0.94, cy = m.cy, dy = g.A.y;
      const body = sub(G, 0, 0, 0);
      anchor('tool', body);
      if (k === 'forks') {
        const xs = linspace(-w * 0.42, w * 0.42, 4);
        const pts = edge ? [[zr, cy - 0.04], [0, cy - 0.04], [0.24 * s, 0.006], [0.25 * s, 0.014], [0.03, cy + 0.035], [zr, cy + 0.035]]
          : [[g.A.z - 0.03, dy], [g.A.z + 0.1, dy], [g.A.z + 0.28 * s, dy + 0.02], [g.A.z + 0.28 * s, dy + 0.03], [g.A.z - 0.03, dy + 0.05]];
        for (const x of xs) put(plateZY(pts, 0.022, 0.004), [M.toolSteel, M.edgeSteel], 'tool', 'weapon', x, 0, 0, body);
        if (edge) put(cylA(0.012, w * 0.9, 8, 'x'), M.steel, 'tool', 'weapon', 0, cy, zr + 0.012, body);
      } else if (k === 'plow' || k === 'ramp') {
        const reach = (k === 'plow' ? 0.17 : 0.3) * s;
        const yTop = edge ? (k === 'plow' ? Math.max(cy + 0.07, 0.15) : cy + 0.03) : dy + (k === 'plow' ? 0.14 : 0.08);
        const yBot = edge ? 0.008 : dy + 0.004;
        const z0 = edge ? 0.012 : g.A.z - 0.02;
        const a = [0, yTop, z0 + (k === 'plow' ? 0.03 : 0)], b = [0, yBot, z0 + reach];
        const len = Math.hypot(b[1] - a[1], b[2] - a[2]);
        const sheet = at(plateXZ(K.rectPts(w, len), 0.007, 0.002), 0, 0, 0);
        const pm = put(sheet, [M.armor, M.edge], 'tool', 'weapon', 0, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, body);
        pm.rotation.x = Math.atan2(a[1] - b[1], b[2] - a[2]);
        // lip, braces, bolts, chevrons
        put(aim(box(w, 0.004, 0.03), [0, b[1] + 0.004, b[2] - 0.02], [0, b[1] - 0.002, b[2] + 0.008]), M.edgeSteel, 'tool', 'weapon', 0, 0, 0, body);
        const gus = [[z0 - 0.01, yBot + 0.01], [b[2] - 0.03, yBot + 0.004], [a[2], yTop - 0.02]];
        for (const x of linspace(-w * 0.44, w * 0.44, k === 'ramp' ? 4 : 3)) put(plateZY(gus, 0.008, 0.002), [M.frame, M.steel], 'tool', 'struct', x, 0, 0, body);
        const dir = new THREE.Vector3(0, b[1] - a[1], b[2] - a[2]).normalize(), nrm = new THREE.Vector3(0, dir.z, -dir.y);
        const onSheet = (x, u, lift) => [x, a[1] + dir.y * len * u + nrm.y * lift, a[2] + dir.z * len * u + nrm.z * lift];
        const bl2 = linspace(-w * 0.44, w * 0.44, 5).flatMap((x) => [0.15, 0.8].map((u) => { const g2 = cylA(0.006, 0.006, 6, 'y'); const p = onSheet(x, u, 0.006); return at(g2, p[0], p[1], p[2], pm.rotation.x); }));
        put(merge(bl2), M.bolt, 'tool', 'weapon', 0, 0, 0, body);
        const chev = linspace(-w * 0.4, w * 0.4, 7).map((x) => { const p = onSheet(x, 0.5, 0.0042); return at(box(w * 0.07, 0.001, len * 0.34), p[0], p[1], p[2], pm.rotation.x, 0.5, 0); });
        const cm = put(merge(chev), M.decalDark, 'tool', 'decal', 0, 0, 0, body); void cm;
      } else if (k === 'tail') {
        const y = edge ? cy : dy + 0.05, z0 = edge ? zr : g.A.z - 0.04, zt = (edge ? 0 : g.A.z) + g.tailL;
        put(box(0.11, 0.075, 0.03), M.frameDark, 'tool', 'struct', 0, y, z0 + 0.03, body);
        if (!edge) put(box(0.09, 0.05, 0.07), M.frameDark, 'tool', 'struct', 0, dy + 0.025, g.A.z, body);
        const bp = [[z0, y - 0.024], [zt - 0.03, y - 0.012], [zt - 0.03, y + 0.012], [z0, y + 0.024]];
        put(plateZY(bp, 0.018, 0.003, linspace(z0 + 0.09, zt - 0.1, 3).map((z) => ({ x: z, y, r: 0.007 }))), [M.toolSteel, M.edgeSteel], 'tool', 'weapon', 0, 0, 0, body);
        put(at(box(0.085, 0.07, 0.085), 0, y, zt, 0, Math.PI / 4, 0), M.hardened, 'tool', 'weapon', 0, 0, 0, body);
        put(at(box(0.09, 0.02, 0.09), 0, y, zt, 0, Math.PI / 4, 0), M.accent, 'tool', 'weapon', 0, 0, 0, body);
        put(merge([[0.06, 0], [-0.06, 0], [0, 0.06], [0, -0.06]].map(([dx, dz]) => at(box(0.016, 0.074, 0.016), dx, y, zt + dz, 0, Math.PI / 4, 0))), M.edgeSteel, 'tool', 'weapon', 0, 0, 0, body);
      } else {
        const y = edge ? cy : dy + 0.05;
        const z0 = edge ? 0 : g.A.z;
        const n = 3;
        linspace(-0.12, 0.12, n).forEach((x) => {
          if (edge) {
            put(cylA(0.045, 0.016, 12, 'z'), M.frameDark, 'tool', 'weapon', x, y, z0 + 0.008, body);
            put(cylA(0.034, 0.16 * s, 12, 'z', 0.002), M.edgeSteel, 'tool', 'weapon', x, y, z0 + 0.016 + 0.08 * s, body);
            put(cylA(0.036, 0.02, 12, 'z'), M.hardened, 'tool', 'weapon', x, y, z0 + 0.026, body);
          } else {
            put(cylA(0.045, 0.012, 12, 'y'), M.frameDark, 'tool', 'weapon', x, dy + 0.006, z0, body);
            put(cylA(0.034, 0.14 * s, 12, 'y', 0.002), M.edgeSteel, 'tool', 'weapon', x, dy + 0.012 + 0.07 * s, z0, body);
          }
        });
      }
    }
    return A;
  }

  window.BBModules = { build };
})();
