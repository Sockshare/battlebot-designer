/**
 * BattleBot Designer — 3D engine.
 * Viewport scaling, WebGL renderer with a CPU z-buffer fallback (for browsers with WebGL disabled,
 * e.g. Chrome Remote Desktop), the arena / factory sets, lights, orbit camera and stage projection.
 *
 * The CPU rasterizer shades per vertex (Gouraud) with a metal / roughness model: three coloured lights,
 * a procedural environment for reflections, Fresnel, ground occlusion, vertex colours, multi-material
 * groups, additive blending for effects, perspective-correct depth and a projected ground shadow.
 */
(function () {
  'use strict';

  const W = 1600;
  const H = 900;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, t) => a + (b - a) * t;

  const appEl = document.getElementById('app');
  const canvas = document.getElementById('gl');
  let stageScale = 1;
  let renderer = null;

  function fitViewport() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    stageScale = Math.min(vw / W, vh / H);
    const tx = (vw - W * stageScale) * 0.5;
    const ty = (vh - H * stageScale) * 0.5;
    appEl.style.transform = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${stageScale.toFixed(5)})`;
    if (renderer && !renderer.isSoftwareRenderer) {
      renderer.setPixelRatio(clamp((window.devicePixelRatio || 1) * stageScale, 1, 2));
      renderer.setSize(W, H, false);
    }
  }
  window.addEventListener('resize', fitViewport);

  // Light rig shared by both renderers (directions point from the surface toward the light).
  const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
  const L_KEY = norm3([-0.42, 0.78, 0.46]);
  const L_FILL = norm3([0.74, 0.36, 0.5]);
  const L_RIM = norm3([0.3, 0.42, -0.86]);
  const C_KEY = [1.0, 0.96, 0.9];
  const C_FILL = [0.62, 0.76, 1.0];
  const C_RIM = [1.0, 0.56, 0.3];

  // ---------------------------------------------------------------------------
  // CPU Z-BUFFER RASTERIZER
  // ---------------------------------------------------------------------------
  function createSoftwareRenderer(canvasEl) {
    const ctx = canvasEl.getContext('2d', { alpha: true });
    const SW_SCALE = 0.85;
    const curW = Math.round(W * SW_SCALE);
    const curH = Math.round(H * SW_SCALE);
    canvasEl.width = curW;
    canvasEl.height = curH;

    const imgData = ctx.createImageData(curW, curH);
    const pix32 = new Uint32Array(imgData.data.buffer);
    const zBuf = new Float32Array(curW * curH); // stores 1/w: larger is nearer, 0 is empty
    const mask = new Uint8Array(curW * curH);

    // the set (floor + walls) only changes when the camera moves, so its colour and depth are cached
    const setPix = new Uint32Array(curW * curH);
    const setZ = new Float32Array(curW * curH);
    const lastVp = new Float32Array(16);
    let setValid = false;
    let mMinX = curW, mMaxX = 0, mMinY = curH, mMaxY = 0;

    const MAX_TRANS = 24000;
    const trV = new Float32Array(MAX_TRANS * 9);
    const trColor = new Uint32Array(MAX_TRANS);
    const trAdd = new Uint8Array(MAX_TRANS);
    let transCount = 0;

    const _mvpMat = new THREE.Matrix4();
    const _vpMat = new THREE.Matrix4();
    const _shMat = new THREE.Matrix4();
    const _tmpMat = new THREE.Matrix4();
    let camX = 0, camY = 0, camZ = 0;
    const stats = { tris: 0, meshes: 0 };

    function getGeoCache(geo) {
      if (geo.__swCache) return geo.__swCache;
      const posAttr = geo.attributes.position;
      if (!posAttr) return null;
      if (!geo.attributes.normal) geo.computeVertexNormals();
      let indices;
      if (geo.index) indices = geo.index.array;
      else {
        indices = new Uint32Array(posAttr.count);
        for (let i = 0; i < posAttr.count; i++) indices[i] = i;
      }
      const n = posAttr.count;
      geo.__swCache = {
        posArr: posAttr.array, normArr: geo.attributes.normal.array, colArr: geo.attributes.color ? geo.attributes.color.array : null,
        vCount: n, indices, nTris: Math.floor(indices.length / 3), groups: geo.groups && geo.groups.length ? geo.groups : null,
        vScreen: new Float32Array(n * 3), vCol: new Float32Array(n * 3),
      };
      return geo.__swCache;
    }

    // Opaque triangle with per-vertex colour.
    function rasterG(x0, y0, z0, r0, g0, b0, x1, y1, z1, r1, g1, b1, x2, y2, z2, r2, g2, b2) {
      let area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
      if (area < 0) {
        let t = x1; x1 = x2; x2 = t; t = y1; y1 = y2; y2 = t; t = z1; z1 = z2; z2 = t;
        t = r1; r1 = r2; r2 = t; t = g1; g1 = g2; g2 = t; t = b1; b1 = b2; b2 = t;
        area = -area;
      }
      if (area < 0.12) return;
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
      const maxX = Math.min(curW - 1, Math.ceil(Math.max(x0, x1, x2)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
      const maxY = Math.min(curH - 1, Math.ceil(Math.max(y0, y1, y2)));
      if (minX > maxX || minY > maxY) return;

      const inv = 1.0 / area;
      const ex1 = x1 - x0, ey1 = y1 - y0, ex2 = x2 - x0, ey2 = y2 - y0;
      const dzdx = ((z1 - z0) * ey2 - (z2 - z0) * ey1) * inv;
      const dzdy = ((z2 - z0) * ex1 - (z1 - z0) * ex2) * inv;
      const A12 = y1 - y2, B12 = x2 - x1;
      const A20 = y2 - y0, B20 = x0 - x2;
      const A01 = y0 - y1, B01 = x1 - x0;
      const i12 = A12 !== 0 ? 1 / A12 : 0, i20 = A20 !== 0 ? 1 / A20 : 0, i01 = A01 !== 0 ? 1 / A01 : 0;
      const sx = minX + 0.5, sy = minY + 0.5;
      let w0r = A12 * (sx - x1) + B12 * (sy - y1);
      let w1r = A20 * (sx - x2) + B20 * (sy - y2);
      let w2r = A01 * (sx - x0) + B01 * (sy - y0);
      let zr = z0 + (sx - x0) * dzdx + (sy - y0) * dzdy;

      const flat = Math.abs(r1 - r0) + Math.abs(r2 - r0) + Math.abs(g1 - g0) + Math.abs(g2 - g0) + Math.abs(b1 - b0) + Math.abs(b2 - b0) < 7;
      if (flat) {
        const abgr = (0xff000000 | (((b0 + b1 + b2) * 0.3333) << 16) | (((g0 + g1 + g2) * 0.3333) << 8) | ((r0 + r1 + r2) * 0.3333)) >>> 0;
        for (let y = minY; y <= maxY; y++) {
          let xs = minX, xe = maxX;
          if (A12 > 0) { const q = minX + Math.ceil((-0.05 - w0r) * i12); if (q > xs) xs = q; } else if (A12 < 0) { const q = minX + Math.floor((-0.05 - w0r) * i12); if (q < xe) xe = q; } else if (w0r < -0.05) xs = xe + 1;
          if (A20 > 0) { const q = minX + Math.ceil((-0.05 - w1r) * i20); if (q > xs) xs = q; } else if (A20 < 0) { const q = minX + Math.floor((-0.05 - w1r) * i20); if (q < xe) xe = q; } else if (w1r < -0.05) xs = xe + 1;
          if (A01 > 0) { const q = minX + Math.ceil((-0.05 - w2r) * i01); if (q > xs) xs = q; } else if (A01 < 0) { const q = minX + Math.floor((-0.05 - w2r) * i01); if (q < xe) xe = q; } else if (w2r < -0.05) xs = xe + 1;
          if (xs <= xe) {
            let z = zr + (xs - minX) * dzdx;
            let idx = y * curW + xs;
            for (let x = xs; x <= xe; x++, idx++) {
              if (z > zBuf[idx]) { zBuf[idx] = z; pix32[idx] = abgr; }
              z += dzdx;
            }
          }
          w0r += B12; w1r += B20; w2r += B01; zr += dzdy;
        }
        return;
      }
      const drdx = ((r1 - r0) * ey2 - (r2 - r0) * ey1) * inv, drdy = ((r2 - r0) * ex1 - (r1 - r0) * ex2) * inv;
      const dgdx = ((g1 - g0) * ey2 - (g2 - g0) * ey1) * inv, dgdy = ((g2 - g0) * ex1 - (g1 - g0) * ex2) * inv;
      const dbdx = ((b1 - b0) * ey2 - (b2 - b0) * ey1) * inv, dbdy = ((b2 - b0) * ex1 - (b1 - b0) * ex2) * inv;
      let rr = r0 + (sx - x0) * drdx + (sy - y0) * drdy;
      let gr = g0 + (sx - x0) * dgdx + (sy - y0) * dgdy;
      let br = b0 + (sx - x0) * dbdx + (sy - y0) * dbdy;
      for (let y = minY; y <= maxY; y++) {
          let xs = minX, xe = maxX;
          if (A12 > 0) { const q = minX + Math.ceil((-0.05 - w0r) * i12); if (q > xs) xs = q; } else if (A12 < 0) { const q = minX + Math.floor((-0.05 - w0r) * i12); if (q < xe) xe = q; } else if (w0r < -0.05) xs = xe + 1;
          if (A20 > 0) { const q = minX + Math.ceil((-0.05 - w1r) * i20); if (q > xs) xs = q; } else if (A20 < 0) { const q = minX + Math.floor((-0.05 - w1r) * i20); if (q < xe) xe = q; } else if (w1r < -0.05) xs = xe + 1;
          if (A01 > 0) { const q = minX + Math.ceil((-0.05 - w2r) * i01); if (q > xs) xs = q; } else if (A01 < 0) { const q = minX + Math.floor((-0.05 - w2r) * i01); if (q < xe) xe = q; } else if (w2r < -0.05) xs = xe + 1;
        if (xs <= xe) {
          const o = xs - minX;
          let z = zr + o * dzdx, r = rr + o * drdx, g = gr + o * dgdx, b = br + o * dbdx;
          let idx = y * curW + xs;
          for (let x = xs; x <= xe; x++, idx++) {
            if (z > zBuf[idx]) {
              zBuf[idx] = z;
              const ri = r < 0 ? 0 : r > 255 ? 255 : r | 0, gi = g < 0 ? 0 : g > 255 ? 255 : g | 0, bi = b < 0 ? 0 : b > 255 ? 255 : b | 0;
              pix32[idx] = (0xff000000 | (bi << 16) | (gi << 8) | ri) >>> 0;
            }
            z += dzdx; r += drdx; g += dgdx; b += dbdx;
          }
        }
        w0r += B12; w1r += B20; w2r += B01; zr += dzdy; rr += drdy; gr += dgdy; br += dbdy;
      }
    }

    // Transparent (alpha or additive) flat triangle; depth-tested but does not write depth.
    function rasterT(x0, y0, z0, x1, y1, z1, x2, y2, z2, abgr, additive) {
      let area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
      if (area < 0) { let t = x1; x1 = x2; x2 = t; t = y1; y1 = y2; y2 = t; t = z1; z1 = z2; z2 = t; area = -area; }
      if (area < 0.12) return;
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
      const maxX = Math.min(curW - 1, Math.ceil(Math.max(x0, x1, x2)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
      const maxY = Math.min(curH - 1, Math.ceil(Math.max(y0, y1, y2)));
      if (minX > maxX || minY > maxY) return;
      const inv = 1.0 / area;
      const dzdx = ((z1 - z0) * (y2 - y0) - (z2 - z0) * (y1 - y0)) * inv;
      const dzdy = ((z2 - z0) * (x1 - x0) - (z1 - z0) * (x2 - x0)) * inv;
      const A12 = y1 - y2, B12 = x2 - x1, A20 = y2 - y0, B20 = x0 - x2, A01 = y0 - y1, B01 = x1 - x0;
      const i12 = A12 !== 0 ? 1 / A12 : 0, i20 = A20 !== 0 ? 1 / A20 : 0, i01 = A01 !== 0 ? 1 / A01 : 0;
      const sx = minX + 0.5, sy = minY + 0.5;
      let w0r = A12 * (sx - x1) + B12 * (sy - y1);
      let w1r = A20 * (sx - x2) + B20 * (sy - y2);
      let w2r = A01 * (sx - x0) + B01 * (sy - y0);
      let zr = z0 + (sx - x0) * dzdx + (sy - y0) * dzdy;
      const sa = (abgr >>> 24) & 0xff;
      const sr = abgr & 0xff, sg = (abgr >> 8) & 0xff, sb = (abgr >> 16) & 0xff;
      const pr = (sr * sa) >> 8, pg = (sg * sa) >> 8, pb = (sb * sa) >> 8;
      const invA = 255 - sa;
      for (let y = minY; y <= maxY; y++) {
          let xs = minX, xe = maxX;
          if (A12 > 0) { const q = minX + Math.ceil((0 - w0r) * i12); if (q > xs) xs = q; } else if (A12 < 0) { const q = minX + Math.floor((0 - w0r) * i12); if (q < xe) xe = q; } else if (w0r < 0) xs = xe + 1;
          if (A20 > 0) { const q = minX + Math.ceil((0 - w1r) * i20); if (q > xs) xs = q; } else if (A20 < 0) { const q = minX + Math.floor((0 - w1r) * i20); if (q < xe) xe = q; } else if (w1r < 0) xs = xe + 1;
          if (A01 > 0) { const q = minX + Math.ceil((0 - w2r) * i01); if (q > xs) xs = q; } else if (A01 < 0) { const q = minX + Math.floor((0 - w2r) * i01); if (q < xe) xe = q; } else if (w2r < 0) xs = xe + 1;
        let z = zr + (xs - minX) * dzdx;
        let idx = y * curW + xs;
        for (let x = xs; x <= xe; x++, idx++) {
          if (z > zBuf[idx]) {
            const dst = pix32[idx];
            const da = dst >>> 24;
            let nr, ng, nb;
            if (additive) {
              nr = (dst & 0xff) + pr; ng = ((dst >> 8) & 0xff) + pg; nb = ((dst >> 16) & 0xff) + pb;
              if (nr > 255) nr = 255; if (ng > 255) ng = 255; if (nb > 255) nb = 255;
              // over an empty pixel the page background shows through, so carry alpha from brightness
              const na = da === 255 ? 255 : Math.min(255, da + Math.max(pr, pg, pb));
              pix32[idx] = ((na << 24) | (nb << 16) | (ng << 8) | nr) >>> 0;
            } else if (da === 0) pix32[idx] = abgr;
            else {
              nr = (sr * sa + (dst & 0xff) * invA) >> 8;
              ng = (sg * sa + ((dst >> 8) & 0xff) * invA) >> 8;
              nb = (sb * sa + ((dst >> 16) & 0xff) * invA) >> 8;
              const na = Math.min(255, sa + ((da * invA) >> 8));
              pix32[idx] = ((na << 24) | (nb << 16) | (ng << 8) | nr) >>> 0;
            }
          }
          z += dzdx;
        }
        w0r += B12; w1r += B20; w2r += B01; zr += dzdy;
      }
    }

    // Shadow coverage: no depth, one bit per pixel.
    function rasterMask(x0, y0, x1, y1, x2, y2) {
      let area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
      if (area < 0) { let t = x1; x1 = x2; x2 = t; t = y1; y1 = y2; y2 = t; area = -area; }
      if (area < 0.3) return;
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
      const maxX = Math.min(curW - 1, Math.ceil(Math.max(x0, x1, x2)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
      const maxY = Math.min(curH - 1, Math.ceil(Math.max(y0, y1, y2)));
      if (minX > maxX || minY > maxY) return;
      if (minX < mMinX) mMinX = minX;
      if (maxX > mMaxX) mMaxX = maxX;
      if (minY < mMinY) mMinY = minY;
      if (maxY > mMaxY) mMaxY = maxY;
      const A12 = y1 - y2, B12 = x2 - x1, A20 = y2 - y0, B20 = x0 - x2, A01 = y0 - y1, B01 = x1 - x0;
      const i12 = A12 !== 0 ? 1 / A12 : 0, i20 = A20 !== 0 ? 1 / A20 : 0, i01 = A01 !== 0 ? 1 / A01 : 0;
      const sx = minX + 0.5, sy = minY + 0.5;
      let w0r = A12 * (sx - x1) + B12 * (sy - y1);
      let w1r = A20 * (sx - x2) + B20 * (sy - y2);
      let w2r = A01 * (sx - x0) + B01 * (sy - y0);
      for (let y = minY; y <= maxY; y++) {
          let xs = minX, xe = maxX;
          if (A12 > 0) { const q = minX + Math.ceil((0 - w0r) * i12); if (q > xs) xs = q; } else if (A12 < 0) { const q = minX + Math.floor((0 - w0r) * i12); if (q < xe) xe = q; } else if (w0r < 0) xs = xe + 1;
          if (A20 > 0) { const q = minX + Math.ceil((0 - w1r) * i20); if (q > xs) xs = q; } else if (A20 < 0) { const q = minX + Math.floor((0 - w1r) * i20); if (q < xe) xe = q; } else if (w1r < 0) xs = xe + 1;
          if (A01 > 0) { const q = minX + Math.ceil((0 - w2r) * i01); if (q > xs) xs = q; } else if (A01 < 0) { const q = minX + Math.floor((0 - w2r) * i01); if (q < xe) xe = q; } else if (w2r < 0) xs = xe + 1;
        if (xs <= xe) mask.fill(1, y * curW + xs, y * curW + xe + 1);
        w0r += B12; w1r += B20; w2r += B01;
      }
    }

    function project(cache, m) {
      const posArr = cache.posArr, vScreen = cache.vScreen, n = cache.vCount;
      for (let v = 0, i = 0; v < n; v++, i += 3) {
        const x = posArr[i], y = posArr[i + 1], z = posArr[i + 2];
        const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
        if (cw <= 0.05) vScreen[i + 2] = -1;
        else {
          const iw = 1.0 / cw;
          vScreen[i] = ((m[0] * x + m[4] * y + m[8] * z + m[12]) * iw * 0.5 + 0.5) * curW;
          vScreen[i + 1] = (-(m[1] * x + m[5] * y + m[9] * z + m[13]) * iw * 0.5 + 0.5) * curH;
          vScreen[i + 2] = iw;
        }
      }
    }

    // Per-vertex lighting for one material over a vertex range [v0, v1).
    function shade(cache, mw, mat, lit, ground, v0, v1) {
      const posArr = cache.posArr, normArr = cache.normArr, colArr = mat.vertexColors ? cache.colArr : null, vCol = cache.vCol;
      const col = mat.color || { r: 0.9, g: 0.9, b: 0.9 };
      const em = mat.emissive;
      const emI = em ? (mat.emissiveIntensity === undefined ? 1 : mat.emissiveIntensity) * 255 : 0;
      if (!lit) {
        for (let v = v0, i = v0 * 3; v < v1; v++, i += 3) {
          let r = col.r * 255, g = col.g * 255, b = col.b * 255;
          if (colArr) { r *= colArr[i]; g *= colArr[i + 1]; b *= colArr[i + 2]; }
          vCol[i] = r > 255 ? 255 : r; vCol[i + 1] = g > 255 ? 255 : g; vCol[i + 2] = b > 255 ? 255 : b;
        }
        return;
      }
      const rough = mat.roughness === undefined ? 0.5 : mat.roughness;
      const metal = mat.metalness === undefined ? 0 : mat.metalness;
      const gloss = 1 - rough;
      const shin = 6 + gloss * gloss * 220;
      const specK = (0.25 + 2.2 * gloss * gloss) * (0.35 + 0.65 * metal);
      const diffK = 1 - 0.78 * metal;
      const blur = rough * rough; // rough surfaces see an averaged environment
      const iScale = 1.0 / (Math.sqrt(mw[0] * mw[0] + mw[1] * mw[1] + mw[2] * mw[2]) || 1);
      for (let v = v0, i = v0 * 3; v < v1; v++, i += 3) {
        const x = posArr[i], y = posArr[i + 1], z = posArr[i + 2];
        const px = mw[0] * x + mw[4] * y + mw[8] * z + mw[12];
        const py = mw[1] * x + mw[5] * y + mw[9] * z + mw[13];
        const pz = mw[2] * x + mw[6] * y + mw[10] * z + mw[14];
        const ax = normArr[i], ay = normArr[i + 1], az = normArr[i + 2];
        let nx = (mw[0] * ax + mw[4] * ay + mw[8] * az) * iScale;
        let ny = (mw[1] * ax + mw[5] * ay + mw[9] * az) * iScale;
        let nz = (mw[2] * ax + mw[6] * ay + mw[10] * az) * iScale;
        let vx = camX - px, vy = camY - py, vz = camZ - pz;
        const vl = 1.0 / Math.sqrt(vx * vx + vy * vy + vz * vz);
        vx *= vl; vy *= vl; vz *= vl;
        let ndv = nx * vx + ny * vy + nz * vz;
        if (ndv < 0) { nx = -nx; ny = -ny; nz = -nz; ndv = -ndv; }

        let ar = col.r, ag = col.g, ab = col.b;
        if (colArr) { ar *= colArr[i]; ag *= colArr[i + 1]; ab *= colArr[i + 2]; }

        // diffuse: hemisphere ambient + key + fill + rim
        const kd = nx * L_KEY[0] + ny * L_KEY[1] + nz * L_KEY[2];
        const fd = nx * L_FILL[0] + ny * L_FILL[1] + nz * L_FILL[2];
        const rd = nx * L_RIM[0] + ny * L_RIM[1] + nz * L_RIM[2];
        const amb = 0.2 + 0.1 * ny;
        const k = kd > 0 ? kd * 0.74 : 0, fl = fd > 0 ? fd * 0.36 : 0, rm = rd > 0 ? rd * 0.34 : 0;
        let dr = amb + k * C_KEY[0] + fl * C_FILL[0] + rm * C_RIM[0];
        let dg = amb + k * C_KEY[1] + fl * C_FILL[1] + rm * C_RIM[1];
        let db = amb * 1.06 + k * C_KEY[2] + fl * C_FILL[2] + rm * C_RIM[2];

        // environment along the reflection vector
        const rx = 2 * ndv * nx - vx, ry = 2 * ndv * ny - vy, rz = 2 * ndv * nz - vz;
        let er, eg, eb;
        if (ry < 0) {
          const g0 = 0.13 + 0.2 * (1 + ry);
          er = g0; eg = g0; eb = g0 * 1.08;
        } else {
          const h = 1 - ry, h2 = h * h;
          const base = 0.1 + 0.26 * h2 * h2 + 0.22 * ry;
          const side = rx * 0.5 + 0.5;
          er = base * (0.75 + 0.6 * (1 - side)); eg = base * 0.9; eb = base * (0.75 + 0.7 * side);
          if (ry > 0.62) { let s = (ry - 0.62) / 0.2; if (s > 1) s = 1; s = s * s * (3 - 2 * s) * 1.45; er += s; eg += s; eb += s; }
          const dk = rx * L_KEY[0] + ry * L_KEY[1] + rz * L_KEY[2];
          if (dk > 0.9) { const s = (dk - 0.9) * 10, s2 = s * s * 2.2; er += s2 * C_KEY[0]; eg += s2 * C_KEY[1]; eb += s2 * C_KEY[2]; }
          const df = rx * L_FILL[0] + ry * L_FILL[1] + rz * L_FILL[2];
          if (df > 0.86) { const s = (df - 0.86) * 7.1, s2 = s * s * 0.85; er += s2 * C_FILL[0]; eg += s2 * C_FILL[1]; eb += s2 * C_FILL[2]; }
          const dm = rx * L_RIM[0] + ry * L_RIM[1] + rz * L_RIM[2];
          if (dm > 0.88) { const s = (dm - 0.88) * 8.3, s2 = s * s * 1.1; er += s2 * C_RIM[0]; eg += s2 * C_RIM[1]; eb += s2 * C_RIM[2]; }
        }
        er = er + (0.3 - er) * blur; eg = eg + (0.3 - eg) * blur; eb = eb + (0.32 - eb) * blur;

        // Fresnel + key-light highlight
        const f1 = 1 - ndv, f5 = f1 * f1 * f1 * f1 * f1;
        const hx = L_KEY[0] + vx, hy = L_KEY[1] + vy, hz = L_KEY[2] + vz;
        const ndh = (nx * hx + ny * hy + nz * hz) / Math.sqrt(hx * hx + hy * hy + hz * hz);
        const sp = ndh > 0 && kd > 0 ? Math.pow(ndh, shin) * specK : 0;
        const fMetal = metal * (0.82 + 0.18 * f5) * (1 - 0.35 * rough);
        const fDiel = (1 - metal) * (0.04 + 0.96 * f5) * gloss;
        let r = ar * dr * diffK + er * (ar * fMetal + fDiel) + sp * (metal * ar + 1 - metal);
        let g = ag * dg * diffK + eg * (ag * fMetal + fDiel) + sp * (metal * ag + 1 - metal);
        let b = ab * db * diffK + eb * (ab * fMetal + fDiel) + sp * (metal * ab + 1 - metal);

        // ground occlusion: things close to the floor sit in the bot's own shade
        if (ground) { const occ = py < 0.42 ? 0.58 + py : 1; r *= occ; g *= occ; b *= occ; }
        r *= 255; g *= 255; b *= 255;
        if (em) { r += em.r * emI; g += em.g * emI; b += em.b * emI; }
        vCol[i] = r > 255 ? 255 : r; vCol[i + 1] = g > 255 ? 255 : g; vCol[i + 2] = b > 255 ? 255 : b;
      }
    }

    function drawRange(cache, mat, start, count) {
      const indices = cache.indices, vS = cache.vScreen, vC = cache.vCol;
      const isTrans = !!mat.transparent && (mat.opacity === undefined ? 1 : mat.opacity) < 0.97;
      const additive = mat.blending === THREE.AdditiveBlending;
      const isDouble = mat.side === THREE.DoubleSide || isTrans || additive;
      const isBack = mat.side === THREE.BackSide && !isDouble;
      const a8 = isTrans || additive ? Math.round(clamp(mat.opacity === undefined ? 1 : mat.opacity, 0, 1) * 255) : 255;
      const end = start + count;
      for (let t = start; t < end; t += 3) {
        const i0 = indices[t] * 3, i1 = indices[t + 1] * 3, i2 = indices[t + 2] * 3;
        const z0 = vS[i0 + 2], z1 = vS[i1 + 2], z2 = vS[i2 + 2];
        if (z0 < 0 || z1 < 0 || z2 < 0) continue;
        const x0 = vS[i0], y0 = vS[i0 + 1], x1 = vS[i1], y1 = vS[i1 + 1], x2 = vS[i2], y2 = vS[i2 + 1];
        const cross = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
        if (!isDouble && (isBack ? cross <= 0 : cross >= 0)) continue;
        if (!isTrans && !additive) {
          rasterG(x0, y0, z0, vC[i0], vC[i0 + 1], vC[i0 + 2], x1, y1, z1, vC[i1], vC[i1 + 1], vC[i1 + 2], x2, y2, z2, vC[i2], vC[i2 + 1], vC[i2 + 2]);
        } else if (transCount < MAX_TRANS && a8 > 2) {
          const o = transCount * 9;
          trV[o] = x0; trV[o + 1] = y0; trV[o + 2] = z0; trV[o + 3] = x1; trV[o + 4] = y1; trV[o + 5] = z1; trV[o + 6] = x2; trV[o + 7] = y2; trV[o + 8] = z2;
          const r = ((vC[i0] + vC[i1] + vC[i2]) * 0.3333) | 0, g = ((vC[i0 + 1] + vC[i1 + 1] + vC[i2 + 1]) * 0.3333) | 0, b = ((vC[i0 + 2] + vC[i1 + 2] + vC[i2 + 2]) * 0.3333) | 0;
          trColor[transCount] = ((a8 << 24) | (b << 16) | (g << 8) | r) >>> 0;
          trAdd[transCount++] = additive ? 1 : 0;
        }
      }
      stats.tris += count / 3;
    }

    function drawMesh(node, ground) {
      const cache = getGeoCache(node.geometry);
      if (!cache) return;
      _mvpMat.multiplyMatrices(_vpMat, node.matrixWorld);
      project(cache, _mvpMat.elements);
      const mw = node.matrixWorld.elements;
      const mats = node.material;
      stats.meshes++;
      if (Array.isArray(mats) && cache.groups) {
        // every vertex is shaded with the material of the group that uses it (extrude caps / sides do not share vertices)
        for (const gr of cache.groups) {
          const mat = mats[gr.materialIndex] || mats[0];
          let lo = 1e9, hi = -1;
          const idx = cache.indices;
          for (let t = gr.start, e = gr.start + gr.count; t < e; t++) { const q = idx[t]; if (q < lo) lo = q; if (q > hi) hi = q; }
          if (hi < 0) continue;
          shade(cache, mw, mat, !(mat.isMeshBasicMaterial), ground, lo, hi + 1);
          drawRange(cache, mat, gr.start, gr.count);
        }
      } else {
        const mat = Array.isArray(mats) ? mats[0] : mats;
        shade(cache, mw, mat, !(mat.isMeshBasicMaterial), ground, 0, cache.vCount);
        drawRange(cache, mat, 0, cache.nTris * 3);
      }
    }

    function shadowMesh(node) {
      const cache = getGeoCache(node.geometry);
      if (!cache) return;
      _tmpMat.multiplyMatrices(_shMat, node.matrixWorld);
      _mvpMat.multiplyMatrices(_vpMat, _tmpMat);
      project(cache, _mvpMat.elements);
      const indices = cache.indices, vS = cache.vScreen;
      for (let t = 0, e = cache.nTris * 3; t < e; t += 3) {
        const i0 = indices[t] * 3, i1 = indices[t + 1] * 3, i2 = indices[t + 2] * 3;
        if (vS[i0 + 2] < 0 || vS[i1 + 2] < 0 || vS[i2 + 2] < 0) continue;
        rasterMask(vS[i0], vS[i0 + 1], vS[i1], vS[i1 + 1], vS[i2], vS[i2 + 1]);
      }
    }

    // pass: 0 = set (floor, walls), 1 = shadow coverage, 2 = everything else
    function visit(node, pass, inSet) {
      if (!node.visible) return;
      const set = inSet || !!node.userData.isSet;
      if (node.isMesh && node.geometry && node.material && !node.userData.glOnly) {
        if (pass === 0 && set) drawMesh(node, false);
        else if (pass === 1 && !set && node.castShadow) shadowMesh(node);
        else if (pass === 2 && !set) drawMesh(node, true);
      }
      const ch = node.children;
      for (let c = 0; c < ch.length; c++) visit(ch[c], pass, set);
    }

    function flushTransparent() {
      for (let i = 0; i < transCount; i++) {
        const o = i * 9;
        rasterT(trV[o], trV[o + 1], trV[o + 2], trV[o + 3], trV[o + 4], trV[o + 5], trV[o + 6], trV[o + 7], trV[o + 8], trColor[i], trAdd[i] === 1);
      }
      transCount = 0;
    }

    return {
      isSoftwareRenderer: true,
      domElement: canvasEl,
      stats,
      shadows: true,
      invalidate() { setValid = false; },
      render(scn, cam) {
        scn.updateMatrixWorld(true);
        cam.updateMatrixWorld(true);
        cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
        _vpMat.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
        camX = cam.position.x; camY = cam.position.y; camZ = cam.position.z;
        transCount = 0; stats.tris = 0; stats.meshes = 0;
        const vp = _vpMat.elements;
        let same = setValid;
        for (let i = 0; i < 16 && same; i++) if (Math.abs(vp[i] - lastVp[i]) > 1e-7) same = false;
        if (same) { pix32.set(setPix); zBuf.set(setZ); }
        else {
          pix32.fill(0); zBuf.fill(0);
          visit(scn, 0, false);
          flushTransparent();
          setPix.set(pix32); setZ.set(zBuf); lastVp.set(vp);
          setValid = true;
        }

        if (this.shadows) {
          // planar projection of the bot onto the floor along the key light
          const lx = L_KEY[0] / L_KEY[1], lz = L_KEY[2] / L_KEY[1];
          _shMat.set(1, -lx, 0, 0, 0, 0, 0, 0.004, 0, -lz, 1, 0, 0, 0, 0, 1);
          mMinX = curW; mMaxX = 0; mMinY = curH; mMaxY = 0;
          visit(scn, 1, false);
          for (let y = mMinY; y <= mMaxY; y++) {
            let idx = y * curW + mMinX;
            for (let x = mMinX; x <= mMaxX; x++, idx++) {
              if (!mask[idx]) continue;
              mask[idx] = 0;
              const p = pix32[idx];
              if (p >>> 24 === 0) continue;
              pix32[idx] = ((p & 0xff000000) | ((((p >> 16) & 0xff) * 112) >> 8 << 16) | ((((p >> 8) & 0xff) * 104) >> 8 << 8) | (((p & 0xff) * 100) >> 8)) >>> 0;
            }
          }
        }

        visit(scn, 2, false);
        flushTransparent();
        ctx.putImageData(imgData, 0, 0);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // RENDERER SELECTION
  // ---------------------------------------------------------------------------
  const query = new URLSearchParams(window.location.search);
  const forceSw = query.get('sw') === '1';
  if (!forceSw) {
    try {
      const probe = document.createElement('canvas');
      const gl = probe.getContext('webgl2') || probe.getContext('webgl') || probe.getContext('experimental-webgl');
      if (gl) {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'default' });
        renderer.setClearColor(0x000000, 0);
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      }
    } catch (e) {
      renderer = null;
    }
  }
  if (!renderer) renderer = createSoftwareRenderer(canvas);
  const isSoftware = !!renderer.isSoftwareRenderer;

  // ---------------------------------------------------------------------------
  // SCENE + LIGHTS (lights only affect WebGL; the CPU path has the same rig built in)
  // ---------------------------------------------------------------------------
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, W / H, 0.1, 120);
  const toHex = (c) => new THREE.Color(c[0], c[1], c[2]);

  scene.add(new THREE.HemisphereLight('#c9d2e6', '#1a1c20', 0.42));
  const keyLight = new THREE.DirectionalLight(toHex(C_KEY), 1.25);
  keyLight.position.set(L_KEY[0] * 9, L_KEY[1] * 9, L_KEY[2] * 9);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(2048, 2048);
  Object.assign(keyLight.shadow.camera, { left: -3.2, right: 3.2, top: 3.2, bottom: -3.2, near: 1, far: 20 });
  keyLight.shadow.bias = -0.0015;
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(toHex(C_FILL), 0.4);
  fillLight.position.set(L_FILL[0] * 8, L_FILL[1] * 8, L_FILL[2] * 8);
  scene.add(fillLight);
  const rimLight = new THREE.DirectionalLight(toHex(C_RIM), 0.6);
  rimLight.position.set(L_RIM[0] * 8, L_RIM[1] * 8, L_RIM[2] * 8);
  scene.add(rimLight);

  if (!isSoftware) {
    // small emissive "studio" for reflections on the WebGL path
    try {
      const envScene = new THREE.Scene();
      const box = (w, h, d, x, y, z, color) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })); m.position.set(x, y, z); envScene.add(m); };
      box(40, 40, 40, 0, 0, 0, '#0b0c0f');
      box(12, 0.2, 12, 0, 9, 0, '#ffffff');
      box(0.2, 5, 9, -10, 5, 4, '#fff1dc');
      box(0.2, 4, 8, 10, 4, 3, '#7ea6ff');
      box(8, 3, 0.2, 3, 4, -10, '#ff8a4a');
      box(40, 0.2, 40, 0, -3, 0, '#16181c');
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(envScene, 0.03).texture;
      pmrem.dispose();
    } catch (e) { /* environment is optional */ }
  }

  // ---------------------------------------------------------------------------
  // SETS: combat arena and factory floor (unlit, vertex-coloured, identical in both renderers)
  // ---------------------------------------------------------------------------
  function quadBatch() {
    const pos = [], col = [], idx = [];
    const api = {
      // corners in order (a, b, c, d) wound counter-clockwise seen from the visible side
      quad(a, b, c, d, ca, cb, cc, cd) {
        const n = pos.length / 3;
        for (const p of [a, b, c, d]) pos.push(p[0], p[1], p[2]);
        for (const c2 of [ca, cb || ca, cc || ca, cd || ca]) col.push(c2[0], c2[1], c2[2]);
        idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
      },
      // axis-aligned floor rectangle at height y
      rect(x0, z0, x1, z1, y, shadeAt, base) {
        const pts = [[x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0]];
        const cs = pts.map((p) => { const s = shadeAt ? shadeAt(p[0], p[2]) : 1; return [base[0] * s, base[1] * s, base[2] * s]; });
        api.quad(pts[0], pts[1], pts[2], pts[3], cs[0], cs[1], cs[2], cs[3]);
      },
      mesh() {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        g.setIndex(idx);
        g.computeVertexNormals();
        return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true }));
      },
    };
    return api;
  }

  // deterministic pseudo-random so the set looks the same every load
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

  function buildSet(kind) {
    const g = new THREE.Group();
    g.userData.isSet = true;
    const arena = kind === 'arena';
    const HALF = 4.2;
    const pool = arena ? (x, z) => 0.2 + 1.0 * Math.exp(-(x * x + z * z) / 6.2) : (x, z) => 0.5 + 0.62 * Math.exp(-(x * x + z * z) / 11);
    const floor = quadBatch();
    const cell = arena ? 0.84 : 1.05;
    const n = Math.round((HALF * 2) / cell);
    seed = arena ? 7 : 19;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const x0 = -HALF + i * cell, z0 = -HALF + j * cell;
      const t = 0.9 + rnd() * 0.2;
      const base = arena ? [0.3 * t, 0.32 * t, 0.36 * t] : [0.5 * t, 0.5 * t, 0.49 * t];
      floor.rect(x0, z0, x0 + cell, z0 + cell, 0, pool, base);
    }
    g.add(floor.mesh());

    const deco = quadBatch();
    const seam = arena ? [0.05, 0.055, 0.06] : [0.2, 0.2, 0.2];
    for (let i = 0; i <= n; i++) {
      const p = -HALF + i * cell, w = arena ? 0.008 : 0.006;
      deco.rect(p - w, -HALF, p + w, HALF, 0.0015, pool, seam);
      deco.rect(-HALF, p - w, HALF, p + w, 0.0015, pool, seam);
    }
    if (arena) {
      // plate bolts
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
        const x = -HALF + i * cell, z = -HALF + j * cell;
        for (const [dx, dz] of [[0.07, 0.07], [-0.07, 0.07], [0.07, -0.07], [-0.07, -0.07]]) deco.rect(x + dx - 0.012, z + dz - 0.012, x + dx + 0.012, z + dz + 0.012, 0.002, pool, [0.4, 0.42, 0.46]);
      }
      // hazard border, start squares, kill-saw slots
      const stripe = (x0, z0, x1, z1, along) => {
        const len = along === 'x' ? x1 - x0 : z1 - z0, m = Math.round(len / 0.16);
        for (let k = 0; k < m; k++) {
          const c = k % 2 ? [0.07, 0.07, 0.07] : [0.95, 0.7, 0.08];
          if (along === 'x') deco.rect(x0 + (k * len) / m, z0, x0 + ((k + 1) * len) / m, z1, 0.002, pool, c);
          else deco.rect(x0, z0 + (k * len) / m, x1, z0 + ((k + 1) * len) / m, 0.002, pool, c);
        }
      };
      const B = 3.55;
      stripe(-B, B, B, B + 0.1, 'x'); stripe(-B, -B - 0.1, B, -B, 'x'); stripe(B, -B, B + 0.1, B, 'z'); stripe(-B - 0.1, -B, -B, B, 'z');
      const box = (cx, cz, s, c) => {
        deco.rect(cx - s, cz - s, cx + s, cz - s + 0.035, 0.002, pool, c); deco.rect(cx - s, cz + s - 0.035, cx + s, cz + s, 0.002, pool, c);
        deco.rect(cx - s, cz - s, cx - s + 0.035, cz + s, 0.002, pool, c); deco.rect(cx + s - 0.035, cz - s, cx + s, cz + s, 0.002, pool, c);
      };
      box(-2.55, -2.55, 0.62, [0.9, 0.12, 0.1]); box(2.55, 2.55, 0.62, [0.12, 0.35, 0.95]);
      for (const sx of [-1, 1]) {
        const cx = sx * 2.3, cz = -sx * 1.7;
        deco.rect(cx - 0.42, cz - 0.03, cx + 0.42, cz + 0.03, 0.0025, null, [0.01, 0.01, 0.012]);
        stripe(cx - 0.5, cz - 0.11, cx + 0.5, cz - 0.07, 'x'); stripe(cx - 0.5, cz + 0.07, cx + 0.5, cz + 0.11, 'x');
      }
      // tyre scuffs
      for (let k = 0; k < 9; k++) {
        const a = rnd() * 6.283, r = 1.5 + rnd() * 1.8, len = 0.25 + rnd() * 0.5, w = 0.008 + rnd() * 0.012;
        const cx = Math.cos(a) * r, cz = Math.sin(a) * r, dx = -Math.sin(a + rnd() - 0.5), dz = Math.cos(a + rnd() - 0.5);
        const c = [0.24, 0.255, 0.285].map((q) => q * pool(cx, cz));
        deco.quad([cx - dx * len - dz * w, 0.0018, cz - dz * len + dx * w], [cx + dx * len - dz * w, 0.0018, cz + dz * len + dx * w], [cx + dx * len + dz * w, 0.0018, cz + dz * len - dx * w], [cx - dx * len + dz * w, 0.0018, cz - dz * len - dx * w], c);
      }
    } else {
      // fixture plate with a hole grid, safety lines
      deco.rect(-1.5, -1.25, 1.5, 1.25, 0.002, pool, [0.2, 0.215, 0.235]);
      deco.rect(-1.5, -1.25, 1.5, -1.22, 0.003, pool, [0.36, 0.38, 0.4]); deco.rect(-1.5, 1.22, 1.5, 1.25, 0.003, pool, [0.36, 0.38, 0.4]);
      for (let i = -6; i <= 6; i++) for (let j = -5; j <= 5; j++) deco.rect(i * 0.22 - 0.014, j * 0.22 - 0.014, i * 0.22 + 0.014, j * 0.22 + 0.014, 0.003, null, [0.05, 0.05, 0.055]);
      const Y = [0.95, 0.72, 0.08];
      deco.rect(-2.1, -1.85, 2.1, -1.79, 0.002, pool, Y); deco.rect(-2.1, 1.79, 2.1, 1.85, 0.002, pool, Y);
      deco.rect(-2.1, -1.85, -2.04, 1.85, 0.002, pool, Y); deco.rect(2.04, -1.85, 2.1, 1.85, 0.002, pool, Y);
    }
    g.add(deco.mesh());

    // walls: single-sided, facing inward, so the near walls never block the camera
    const walls = quadBatch();
    const wall = (ax, az, bx, bz) => {
      const seg = (y0, y1, c0, c1, u0, u1) => {
        const x0 = lerp(ax, bx, u0), z0 = lerp(az, bz, u0), x1 = lerp(ax, bx, u1), z1 = lerp(az, bz, u1);
        walls.quad([x1, y0, z1], [x0, y0, z0], [x0, y1, z0], [x1, y1, z1], c0, c0, c1, c1);
      };
      if (arena) {
        seg(0, 0.34, [0.1, 0.105, 0.115], [0.2, 0.21, 0.23], 0, 1);
        const m = 40;
        for (let k = 0; k < m; k++) seg(0.34, 0.46, k % 2 ? [0.06, 0.06, 0.06] : [0.8, 0.58, 0.06], k % 2 ? [0.06, 0.06, 0.06] : [0.8, 0.58, 0.06], k / m, (k + 1) / m);
        seg(0.46, 2.5, [0.035, 0.042, 0.055], [0.012, 0.014, 0.02], 0, 1);
        for (let k = 0; k <= 6; k++) { const u = clamp(k / 6, 0.004, 0.996); seg(0.46, 2.5, [0.13, 0.14, 0.155], [0.05, 0.055, 0.065], u - 0.004, u + 0.004); }
        seg(2.5, 2.62, [0.11, 0.115, 0.125], [0.11, 0.115, 0.125], 0, 1);
        for (let k = 0; k < 6; k++) seg(2.66, 2.76, [1, 0.97, 0.9], [1, 0.97, 0.9], (k + 0.2) / 6, (k + 0.8) / 6);
      } else {
        seg(0, 0.9, [0.17, 0.19, 0.22], [0.2, 0.22, 0.26], 0, 1);
        seg(0.9, 0.98, [0.85, 0.4, 0.1], [0.85, 0.4, 0.1], 0, 1);
        seg(0.98, 2.9, [0.3, 0.31, 0.32], [0.14, 0.145, 0.15], 0, 1);
        for (let k = 0; k <= 5; k++) { const u = clamp(k / 5, 0.006, 0.994); seg(0, 2.9, [0.1, 0.105, 0.11], [0.06, 0.06, 0.065], u - 0.006, u + 0.006); }
        for (let k = 0; k < 5; k++) seg(2.5, 2.58, [0.95, 0.97, 1], [0.95, 0.97, 1], (k + 0.15) / 5, (k + 0.85) / 5);
      }
    };
    wall(HALF, -HALF, -HALF, -HALF); wall(-HALF, HALF, HALF, HALF); wall(-HALF, -HALF, -HALF, HALF); wall(HALF, HALF, HALF, -HALF);
    g.add(walls.mesh());
    return g;
  }

  const floorGroup = new THREE.Group();
  floorGroup.userData.isSet = true;
  scene.add(floorGroup);
  const sets = { arena: buildSet('arena'), factory: buildSet('factory') };
  floorGroup.add(sets.arena, sets.factory);
  sets.factory.visible = false;

  // soft contact shadow under the bot (both renderers) + real shadow catcher (WebGL only)
  const contactShadow = new THREE.Mesh(new THREE.CircleGeometry(1, 28), new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.16, depthWrite: false }));
  contactShadow.rotation.x = -Math.PI / 2;
  contactShadow.position.y = 0.004;
  floorGroup.add(contactShadow);
  const catcher = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), new THREE.ShadowMaterial({ opacity: 0.5 }));
  catcher.rotation.x = -Math.PI / 2;
  catcher.position.y = 0.005;
  catcher.receiveShadow = true;
  catcher.userData.glOnly = true;
  floorGroup.add(catcher);

  // factory hoist: chain + hook block that the app parks above whatever is being lowered in
  const hoist = new THREE.Group();
  {
    const steel = new THREE.MeshStandardMaterial({ color: '#8d939b', roughness: 0.4, metalness: 1 });
    const yellow = new THREE.MeshStandardMaterial({ color: '#e8b21a', roughness: 0.5, metalness: 0.2 });
    const chain = new THREE.Mesh(new THREE.BoxGeometry(0.018, 5, 0.018), steel); chain.position.y = 2.72;
    const block = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.2, 0.1), yellow); block.position.y = 0.12;
    const hook = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.014, 6, 12, Math.PI * 1.5), steel); hook.position.y = -0.03; hook.rotation.z = Math.PI * 0.75;
    hoist.add(chain, block, hook);
    hoist.visible = false;
  }
  scene.add(hoist);

  // anything that changes the set (stage swap, contact shadow size) must invalidate the CPU renderer's cached layer
  const invalidate = () => { if (renderer.invalidate) renderer.invalidate(); };
  function setStage(kind) {
    sets.arena.visible = kind !== 'factory';
    sets.factory.visible = kind === 'factory';
    invalidate();
  }
  function setContact(sx, sz) { contactShadow.scale.set(sx, sz, 1); invalidate(); }

  // ---------------------------------------------------------------------------
  // ORBIT CAMERA
  // ---------------------------------------------------------------------------
  const cam = {
    az: 0.62, el: 0.36, dist: 6.6,
    tAz: 0.62, tEl: 0.36, tDist: 6.6,
    target: new THREE.Vector3(0, 0.25, 0),
    tTarget: new THREE.Vector3(0, 0.25, 0),
  };

  function updateCamera(dt) {
    const k = 1 - Math.exp(-dt * 6.5);
    cam.az = lerp(cam.az, cam.tAz, k);
    cam.el = lerp(cam.el, cam.tEl, k);
    cam.dist = lerp(cam.dist, cam.tDist, k);
    cam.target.lerp(cam.tTarget, k);
    camera.position.set(
      cam.target.x + cam.dist * Math.cos(cam.el) * Math.sin(cam.az),
      cam.target.y + cam.dist * Math.sin(cam.el),
      cam.target.z + cam.dist * Math.cos(cam.el) * Math.cos(cam.az)
    );
    camera.lookAt(cam.target);
    camera.updateMatrixWorld(true);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  }

  const _proj = new THREE.Vector3();
  function projectToStage(v) {
    _proj.copy(v).project(camera);
    return { x: (_proj.x * 0.5 + 0.5) * W, y: (-_proj.y * 0.5 + 0.5) * H, behind: _proj.z > 1 };
  }

  window.BBEngine = {
    W, H, THREE, canvas, appEl, renderer, scene, camera, cam, floorGroup, contactShadow, hoist, isSoftware,
    fitViewport, updateCamera, projectToStage, setStage, setContact, invalidate,
    getStageScale: () => stageScale,
    render: () => renderer.render(scene, camera),
    clamp, lerp,
  };
})();
