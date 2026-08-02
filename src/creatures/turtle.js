import * as THREE from 'three';
import { WORLD } from '../env.js';
import { addCausticsToStandard } from '../environment/seabed.js';
import { wander1 } from '../noise.js';

// ============ アオウミガメ ============
// 前肢を翼のように使う「水中飛翔」。数分ごとに呼吸のため水面へ
// 上がる行動サイクル(cruise → ascend → breathe → descend)を再現。

// ============ 甲羅の形状定数 ============
// 実物のアオウミガメは「潰した球」ではなく、しっかり盛り上がった甲高のドームで、
// 縁(縁甲板)が張り出して厚みを見せる。
const SHELL = {
  halfW: 1.05,    // 半幅
  halfL: 1.38,    // 半長
  height: 0.46,   // 甲羅頂点の高さ(遊泳に適した扁平な流線形)
  rimDrop: 0.14,  // 縁が下がる量(厚みの見え)
  belly: 0.26,    // 腹甲の深さ
};
// テクスチャ空間の半extent(甲羅ローカル正規化座標)
const HX = 1.08, HZ = 1.20;

// 上から見た甲羅の輪郭(正規化: 幅±1、前 +0.96 / 後 -1.10)
// 前方は丸く、後方はやや細く伸びる
function outlineAt(a) {
  const s = Math.sin(a), c = Math.cos(a);
  const rear = Math.max(-c, 0);
  const w = 1.0 - 0.30 * Math.pow(rear, 1.7);
  const l = 1.0 + 0.10 * rear * rear - 0.04 * Math.max(c, 0);
  return { x: s * w, z: c * l };
}

// ============ 鱗板(スキュート)模様 ============
// アオウミガメの甲板配列を実物どおりに配置し、ボロノイ分割で境界を作る。
//   椎甲板 5枚(正中線) / 肋甲板 4対 / 項甲板 1枚 / 縁甲板 12対
// 甲羅は平面UV(真上から見た座標)なので、テクスチャは甲羅の平面図そのもの。
function makeCarapaceTexture() {
  const S = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(S, S);
  const data = img.data;

  // seeds: [nx, nz, type] type 0=椎 1=肋 2=項 3=縁
  const seeds = [];
  for (const z of [0.60, 0.28, -0.05, -0.38, -0.71]) seeds.push([0, z, 0]);
  for (const z of [0.50, 0.17, -0.17, -0.50]) {
    seeds.push([-0.56, z, 1]);
    seeds.push([0.56, z, 1]);
  }
  seeds.push([0, 0.90, 2]);
  // 縁甲板: 輪郭に沿って並ぶ小さな板の帯
  const M = 14;
  for (let i = 0; i < M; i++) {
    const a = ((i + 0.5) / M) * Math.PI; // 前→後(右半周)
    const o = outlineAt(a);
    seeds.push([o.x * 1.02, o.z * 1.02, 3]);
    seeds.push([-o.x * 1.02, o.z * 1.02, 3]);
  }

  const ZW = SHELL.halfL / SHELL.halfW; // 距離を実寸比に補正
  const hashF = (i) => {
    const v = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
    return v - Math.floor(v);
  };
  const sstep = (x, e0, e1) => {
    const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
    return t * t * (3 - 2 * t);
  };
  // 甲羅表面の風化・付着物によるまだら
  const vnoise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const h = (a, b) => hashF(a * 57.3 + b * 131.7);
    return (h(xi, yi) * (1 - u) + h(xi + 1, yi) * u) * (1 - v)
         + (h(xi, yi + 1) * (1 - u) + h(xi + 1, yi + 1) * u) * v;
  };

  let p = 0;
  for (let py = 0; py < S; py++) {
    const nz = (0.5 - (py + 0.5) / S) * 2 * HZ;
    for (let px = 0; px < S; px++) {
      const nx = ((px + 0.5) / S - 0.5) * 2 * HX;

      let d1 = 1e9, d2 = 1e9, best = 0;
      for (let k = 0; k < seeds.length; k++) {
        const dx = nx - seeds[k][0];
        const dz = (nz - seeds[k][1]) * ZW;
        const d = dx * dx + dz * dz;
        if (d < d1) { d2 = d1; d1 = d; best = k; }
        else if (d < d2) { d2 = d; }
      }
      const s1 = Math.sqrt(d1), s2 = Math.sqrt(d2);
      const seed = seeds[best];
      const type = seed[2];

      // 甲板ごとの下地色: オリーブ褐色。板ごとに濃淡差がある
      const cv = hashF(best * 3.7);
      let r = 0.215 + cv * 0.075;
      let g = 0.180 + cv * 0.065;
      let b = 0.098 + cv * 0.032;
      if (type === 3) { r += 0.025; g += 0.020; b += 0.012; } // 縁甲板はやや明るい

      // 甲板内の成長線: 成長中心(後方寄り)から放射する細い縞。
      // 実物では高コントラストの扇ではなく、控えめな筋として見える
      const ox = seed[0] + (hashF(best * 5.1) - 0.5) * 0.08;
      const oz = seed[1] - (type === 3 ? 0.02 : 0.12);
      const ang = Math.atan2((nz - oz) * ZW, nx - ox);
      const coarse = 0.5 + 0.5 * Math.sin(ang * (4 + Math.floor(cv * 4)) + best * 2.7);
      const fine = 0.5 + 0.5 * Math.sin(ang * (15 + Math.floor(cv * 9)) + best * 1.3);
      const grow = Math.min(s1 / (type === 3 ? 0.30 : 0.34), 1);
      // 縁甲板は小さく、成長線もほとんど目立たない
      const amp = type === 3 ? 0.42 : 1.0;
      const streak = (coarse * 0.65 + fine * 0.35) * Math.pow(grow, 0.9) * amp;
      r += streak * 0.115; g += streak * 0.092; b += streak * 0.040;

      // 風化のまだら
      const mot = vnoise(nx * 9 + 11, nz * 9) - 0.5;
      r += mot * 0.045; g += mot * 0.040; b += mot * 0.022;

      // 甲板の縁は薄く暗い(角質板の段差)
      const edge = 1 - sstep(s2 - s1, 0.0, 0.040);
      r *= 1 - edge * 0.26; g *= 1 - edge * 0.26; b *= 1 - edge * 0.24;
      // 継ぎ目そのものは細い暗線
      const seam = 1 - sstep(s2 - s1, 0.0, 0.010);
      r *= 1 - seam * 0.34; g *= 1 - seam * 0.34; b *= 1 - seam * 0.30;

      data[p++] = Math.max(Math.min(r, 1), 0) * 255;
      data[p++] = Math.max(Math.min(g, 1), 0) * 255;
      data[p++] = Math.max(Math.min(b, 1), 0) * 255;
      data[p++] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// ============ 甲羅(背甲)のジオメトリ ============
// 中心から縁へ同心リングを張る。UVは真上から見た平面座標なので
// テクスチャの甲板配置がそのまま甲羅の形に一致する。
function buildCarapace() {
  const SEG = 64, RINGS = 26;
  const pos = [], uv = [], idx = [];

  // 上面は平たく、側面で急に落ちる(リクガメの半球ではなく扁平な流線形)
  const yAt = (v) =>
    SHELL.height * Math.pow(Math.max(1 - Math.pow(v, 2.5), 0), 0.55)
    - SHELL.rimDrop * THREE.MathUtils.smoothstep(v, 0.76, 1.0);

  pos.push(0, SHELL.height, 0);
  uv.push(0.5, 0.5);
  for (let i = 1; i <= RINGS; i++) {
    const v = i / RINGS;
    const y = yAt(v);
    for (let j = 0; j < SEG; j++) {
      const a = (j / SEG) * Math.PI * 2;
      const o = outlineAt(a);
      const nx = o.x * v, nz = o.z * v;
      pos.push(nx * SHELL.halfW, y, nz * SHELL.halfL);
      uv.push(0.5 + nx / (2 * HX), 0.5 - nz / (2 * HZ));
    }
  }
  const ringStart = (i) => 1 + (i - 1) * SEG;
  for (let j = 0; j < SEG; j++) {
    idx.push(0, 1 + j, 1 + ((j + 1) % SEG));
  }
  for (let i = 1; i < RINGS; i++) {
    const a0 = ringStart(i), b0 = ringStart(i + 1);
    for (let j = 0; j < SEG; j++) {
      const jn = (j + 1) % SEG;
      idx.push(a0 + j, b0 + j, b0 + jn);
      idx.push(a0 + j, b0 + jn, a0 + jn);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

// ============ 腹甲のジオメトリ ============
// 背甲と同じ輪郭で下側を閉じるので、縁で隙間なく繋がり体に厚みが出る
function buildPlastron() {
  const SEG = 64, RINGS = 16;
  const pos = [], uv = [], idx = [];

  const yAt = (v) => -SHELL.rimDrop - SHELL.belly * Math.pow(Math.max(1 - v * v, 0), 0.85);

  pos.push(0, yAt(0), 0);
  uv.push(0.5, 0.5);
  for (let i = 1; i <= RINGS; i++) {
    const v = i / RINGS;
    const y = yAt(v);
    for (let j = 0; j < SEG; j++) {
      const a = (j / SEG) * Math.PI * 2;
      const o = outlineAt(a);
      const nx = o.x * v, nz = o.z * v;
      pos.push(nx * SHELL.halfW, y, nz * SHELL.halfL);
      uv.push(0.5 + nx / (2 * HX), 0.5 - nz / (2 * HZ));
    }
  }
  const ringStart = (i) => 1 + (i - 1) * SEG;
  // 下向きなので巻き順を反転
  for (let j = 0; j < SEG; j++) {
    idx.push(0, 1 + ((j + 1) % SEG), 1 + j);
  }
  for (let i = 1; i < RINGS; i++) {
    const a0 = ringStart(i), b0 = ringStart(i + 1);
    for (let j = 0; j < SEG; j++) {
      const jn = (j + 1) % SEG;
      idx.push(a0 + j, b0 + jn, b0 + j);
      idx.push(a0 + j, a0 + jn, b0 + jn);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

// ============ 皮膚のモザイク鱗 ============
// ウミガメの頭部・四肢は、多角形の鱗を淡いクリーム色の目地が縁取る
// 網目模様が最大の特徴。タイル可能なボロノイで生成し、色味は
// 頂点カラー(背側=暗いオリーブ / 腹側=クリーム)で与える。
function makeSkinTexture() {
  const S = 512;
  const GRID = 14;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(S, S);
  const data = img.data;

  const h2 = (x, y) => {
    const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return v - Math.floor(v);
  };
  // ジッター付きグリッド(トーラス距離でタイル化)
  const cells = [];
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      cells.push([
        (gx + 0.18 + h2(gx, gy) * 0.64) / GRID,
        (gy + 0.18 + h2(gx + 37, gy + 11) * 0.64) / GRID,
      ]);
    }
  }
  const wrap = (d) => (d > 0.5 ? d - 1 : d < -0.5 ? d + 1 : d);
  const sstep = (x, e0, e1) => {
    const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
    return t * t * (3 - 2 * t);
  };

  let p = 0;
  for (let py = 0; py < S; py++) {
    const fy = (py + 0.5) / S;
    const gy = Math.floor(fy * GRID);
    for (let px = 0; px < S; px++) {
      const fx = (px + 0.5) / S;
      const gx = Math.floor(fx * GRID);

      // 近傍9セルだけ調べる
      let d1 = 1e9, d2 = 1e9, best = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const cx = (gx + ox + GRID) % GRID;
          const cy = (gy + oy + GRID) % GRID;
          const k = cy * GRID + cx;
          const dx = wrap(fx - cells[k][0]);
          const dy = wrap(fy - cells[k][1]);
          const d = dx * dx + dy * dy;
          if (d < d1) { d2 = d1; d1 = d; best = k; }
          else if (d < d2) { d2 = d; }
        }
      }
      const gap = Math.sqrt(d2) - Math.sqrt(d1);

      // 鱗ごとの明度差(まだらに明るい鱗が混じる)。
      // この画像は「鱗=暗い / 目地=明るい」の変調係数として使い、
      // 色そのものは頂点カラーで与える(掛け算で暗くなりすぎないよう高めの範囲)
      const cv = h2(best * 1.7, best * 5.3);
      let base = 0.60 + cv * 0.16;
      if (cv > 0.82) base += 0.12;
      // 鱗の中央がわずかに盛り上がって見えるよう、周辺を落とす
      base *= 1 - sstep(gap, 0.030, 0.004) * 0.14;
      // 目地は淡い
      const seam = 1 - sstep(gap, 0.0, 0.014);
      const val = base + (1.0 - base) * seam;

      const c = Math.max(Math.min(val, 1), 0) * 255;
      data[p++] = c; data[p++] = c * 0.985; data[p++] = c * 0.95;
      data[p++] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

// 背側=暗いオリーブ、腹側=クリーム(リニア空間で頂点カラーに書く)
const SKIN_DORSAL = new THREE.Color('#8a8468').convertSRGBToLinear();
const SKIN_VENTRAL = new THREE.Color('#e8e2c4').convertSRGBToLinear();
const _mixCol = new THREE.Color();
function skinColor(up) {
  // up: 1=真上 0=真下
  return _mixCol.copy(SKIN_VENTRAL).lerp(SKIN_DORSAL, THREE.MathUtils.smoothstep(up, 0.30, 0.72));
}

// ============ 首〜頭(一体のロフト) ============
// 首と頭を1つの連続した形状として作るので継ぎ目が出ない。
// 断面は上面が平たく下顎側が狭い、実物に近いプロファイル。
const HEAD_LEN = 1.38;
const HP_V  = [0.00, 0.10, 0.22, 0.34, 0.44, 0.54, 0.64, 0.74, 0.84, 0.92, 1.00];
const HP_HW = [0.33, 0.27, 0.220, 0.198, 0.196, 0.226, 0.250, 0.248, 0.218, 0.152, 0.036];
const HP_HH = [0.31, 0.26, 0.214, 0.194, 0.192, 0.222, 0.250, 0.252, 0.226, 0.168, 0.052];
const HP_CY = [0.00, 0.03, 0.060, 0.085, 0.098, 0.102, 0.096, 0.080, 0.050, 0.014, -0.026];

function sampleHP(arr, v) {
  const t = THREE.MathUtils.clamp(v, 0, 1);
  for (let i = 0; i < HP_V.length - 1; i++) {
    if (t <= HP_V[i + 1]) {
      const f = (t - HP_V[i]) / (HP_V[i + 1] - HP_V[i]);
      return arr[i] + (arr[i + 1] - arr[i]) * f;
    }
  }
  return arr[arr.length - 1];
}

// 断面上の点(a: 0=真上, π=真下)
function headSurface(v, a, out = new THREE.Vector3()) {
  const hw = sampleHP(HP_HW, v), hh = sampleHP(HP_HH, v), cy = sampleHP(HP_CY, v);
  const ca = Math.cos(a), sa = Math.sin(a);
  return out.set(
    hw * sa * (ca > 0 ? 1.0 : 0.92),
    cy + hh * ca * (ca > 0 ? 0.88 : 1.0),
    v * HEAD_LEN
  );
}

function buildHeadNeck() {
  const SEG_V = 40, SEG_A = 20;
  const pos = [], uvs = [], cols = [], idx = [];
  const pt = new THREE.Vector3();

  for (let i = 0; i <= SEG_V; i++) {
    const v = i / SEG_V;
    for (let j = 0; j <= SEG_A; j++) {
      const a = (j / SEG_A) * Math.PI * 2;
      headSurface(v, a, pt);
      pos.push(pt.x, pt.y, pt.z);
      uvs.push((j / SEG_A) * 2.0, v * 2.6);
      const c = skinColor(Math.cos(a) * 0.5 + 0.5);
      cols.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < SEG_V; i++) {
    for (let j = 0; j < SEG_A; j++) {
      const a0 = i * (SEG_A + 1) + j;
      const b0 = (i + 1) * (SEG_A + 1) + j;
      idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  geo.computeVertexNormals();
  return geo;
}

// 口(嘴)の線: 顎の合わせ目を細いリボンで表現する
function buildMouthLine() {
  const pos = [], idx = [];
  const A = 2.02;      // 断面角(水平よりやや下)
  const W = 0.075;     // リボンの角度幅
  const V0 = 0.66, V1 = 1.0;
  const N = 18;
  const p = new THREE.Vector3();
  for (const side of [1, -1]) {
    const base = pos.length / 3;
    for (let i = 0; i <= N; i++) {
      const v = V0 + (V1 - V0) * (i / N);
      // 先端に向かってリボンを細く
      const w = W * (1 - 0.7 * Math.pow(i / N, 2.5));
      for (const d of [-w, w]) {
        headSurface(v, side * (A + d), p);
        // わずかに外へ押し出して面と重ならないように
        pos.push(p.x * 1.012, p.y * 1.0 + (p.y > 0 ? 0.002 : -0.002), p.z);
      }
    }
    for (let i = 0; i < N; i++) {
      const a = base + i * 2;
      if (side > 0) idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      else idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

// ============ ひれ(パドル) ============
// x: 付け根→先端 / z: 前縁→後縁 / y: 厚み
// 前縁がふくらみ後縁が薄い水中翼の断面。先端は後方へ後退する。
function buildPaddle({ len, chord, sweep, thick, tipZ = 0.55 }, mirror = false) {
  const SEG_S = 26, SEG_T = 14;
  const pos = [], uvs = [], cols = [], idx = [];

  const chordAt = (s) => chord * Math.pow(Math.max(1 - Math.pow(s, 2.7), 0), 0.5);
  const leadAt = (s) => chord * 0.5 - sweep * Math.pow(s, 1.5);
  const thickAt = (s, t) =>
    thick * (1 - 0.55 * s) * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.72)), 0.85);

  for (const face of [1, -1]) { // 1=背側 -1=腹側
    const base = pos.length / 3;
    for (let i = 0; i <= SEG_S; i++) {
      const s = i / SEG_S;
      const c = chordAt(s), lead = leadAt(s);
      for (let j = 0; j <= SEG_T; j++) {
        const t = j / SEG_T;
        const x = s * len;
        const z = lead - c * t;
        const y = face * thickAt(s, t) * 0.5;
        pos.push(mirror ? -x : x, y, z);
        uvs.push(t * 0.9, s * 2.4);
        // 縁では背腹の色がなじむように
        const edge = Math.min(t, 1 - t) * 2;
        const c2 = skinColor(face > 0 ? 0.5 + 0.5 * Math.min(edge, 1) : 0.5 - 0.5 * Math.min(edge, 1));
        cols.push(c2.r, c2.g, c2.b);
      }
    }
    for (let i = 0; i < SEG_S; i++) {
      for (let j = 0; j < SEG_T; j++) {
        const a0 = base + i * (SEG_T + 1) + j;
        const b0 = base + (i + 1) * (SEG_T + 1) + j;
        const flip = (face > 0) !== mirror;
        if (flip) idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1);
        else idx.push(a0, a0 + 1, b0, a0 + 1, b0 + 1, b0);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  geo.computeVertexNormals();
  return geo;
}

export class SeaTurtle {
  constructor(scene) {
    this.group = new THREE.Group();

    // 皮膚: モザイク鱗テクスチャ × 頂点カラー(背=暗いオリーブ / 腹=クリーム)
    const skin = new THREE.MeshStandardMaterial({
      map: makeSkinTexture(),
      vertexColors: true,
      roughness: 0.78,
    });
    addCausticsToStandard(skin, 0.7);
    const shellMat = new THREE.MeshStandardMaterial({ map: makeCarapaceTexture(), roughness: 0.62 });
    addCausticsToStandard(shellMat, 0.7);
    const bellyMat = new THREE.MeshStandardMaterial({ color: '#e0d7b4', roughness: 0.85 });
    addCausticsToStandard(bellyMat, 0.4);

    // 背甲 + 腹甲(同じ輪郭で閉じるので縁に厚みが出る)
    this.group.add(new THREE.Mesh(buildCarapace(), shellMat));
    this.group.add(new THREE.Mesh(buildPlastron(), bellyMat));

    // ---- 首〜頭(一体のロフト。根本は甲羅の中に差し込む) ----
    this.head = new THREE.Group();
    this.head.add(new THREE.Mesh(buildHeadNeck(), skin));

    // 口(嘴の合わせ目)
    const mouthMat = new THREE.MeshStandardMaterial({ color: '#241f16', roughness: 0.55 });
    this.head.add(new THREE.Mesh(buildMouthLine(), mouthMat));

    // 目: 頭部表面にはめ込み、まぶたの縁で囲う
    const eyeMat = new THREE.MeshStandardMaterial({
      color: '#0d0b08', roughness: 0.18, metalness: 0.0,
    });
    const lidMat = new THREE.MeshStandardMaterial({ color: '#3c3a2a', roughness: 0.8 });
    const eyeV = 0.705, eyeA = 1.30;
    const ePos = new THREE.Vector3();
    for (const s of [-1, 1]) {
      headSurface(eyeV, s * eyeA, ePos);
      // 外向き法線(断面楕円の法線で近似)
      const hw = sampleHP(HP_HW, eyeV), hh = sampleHP(HP_HH, eyeV), cy = sampleHP(HP_CY, eyeV);
      const nrm = new THREE.Vector3(ePos.x / (hw * hw), (ePos.y - cy) / (hh * hh), 0).normalize();

      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.056, 14, 10), eyeMat);
      eye.position.copy(ePos).addScaledVector(nrm, -0.012);
      this.head.add(eye);

      const lid = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.017, 8, 16), lidMat);
      lid.position.copy(ePos).addScaledVector(nrm, -0.004);
      lid.lookAt(lid.position.clone().add(nrm));
      lid.scale.set(1.0, 0.82, 1.0);
      this.head.add(lid);
    }
    this.head.position.set(0, -0.01, 0.66);
    this.group.add(this.head);

    // ---- 前肢(大きなパドル)・後肢(舵) ----
    this.flippers = [];
    const frontSpec = { len: 1.62, chord: 0.60, sweep: 0.42, thick: 0.10 };
    const rearSpec = { len: 0.78, chord: 0.50, sweep: 0.26, thick: 0.10 };
    const frontGeo = { 1: buildPaddle(frontSpec, false), '-1': buildPaddle(frontSpec, true) };
    const rearGeo = { 1: buildPaddle(rearSpec, false), '-1': buildPaddle(rearSpec, true) };
    const clawMat = new THREE.MeshStandardMaterial({ color: '#2a2519', roughness: 0.5 });

    for (const s of [-1, 1]) {
      const front = new THREE.Mesh(frontGeo[s], skin);
      front.position.set(s * 0.70, -0.15, 0.50);
      front.rotation.y = s * 0.30;
      this.group.add(front);
      this.flippers.push({ mesh: front, side: s, front: true });

      // 前縁の爪(アオウミガメは前肢に1本)
      const claw = new THREE.Mesh(new THREE.ConeGeometry(0.020, 0.075, 6), clawMat);
      claw.position.set(s * 0.42, 0.0, 0.255);
      claw.rotation.set(-0.5, 0, s * -Math.PI * 0.46);
      front.add(claw);

      const rear = new THREE.Mesh(rearGeo[s], skin);
      rear.position.set(s * 0.46, -0.18, -1.06);
      rear.rotation.y = s * -0.42;
      this.group.add(rear);
      this.flippers.push({ mesh: rear, side: s, front: false });
    }

    this.group.scale.setScalar(1.15);
    scene.add(this.group);

    // ---- 行動状態 ----
    this.pos = new THREE.Vector3(-6, 7, 8);
    this.heading = 1.2;
    this.speed = 1.1;
    this.seed = 3.3;
    this.time = Math.random() * 50;
    this.state = 'cruise';       // cruise | ascend | breathe | descend
    this.stateTimer = 40 + Math.random() * 40; // 次の呼吸まで
    this.flapPower = 1;
  }

  update(dt) {
    this.time += dt;
    this.stateTimer -= dt;
    const t = this.time;

    // ---- 呼吸サイクル ----
    let targetY;
    switch (this.state) {
      case 'cruise':
        targetY = 5.5 + wander1(t * 0.04, this.seed) * 3;
        this.flapPower = 0.55 + 0.45 * Math.max(0, Math.sin(t * 0.35)); // 漕いでは滑空
        if (this.stateTimer <= 0) { this.state = 'ascend'; }
        break;
      case 'ascend':
        targetY = WORLD.surfaceY - 0.6;
        this.flapPower = 1.2;
        if (this.pos.y > WORLD.surfaceY - 1.2) { this.state = 'breathe'; this.stateTimer = 5 + Math.random() * 3; }
        break;
      case 'breathe':
        targetY = WORLD.surfaceY - 0.45;
        this.flapPower = 0.25; // 水面でほぼ静止
        if (this.stateTimer <= 0) { this.state = 'descend'; }
        break;
      case 'descend':
        targetY = 6;
        this.flapPower = 0.8;
        if (this.pos.y < 7.5) { this.state = 'cruise'; this.stateTimer = 60 + Math.random() * 60; }
        break;
    }

    // ---- 針路 ----
    let turn = wander1(t * 0.06 + 10, this.seed) * 0.4;
    const r = Math.hypot(this.pos.x, this.pos.z);
    if (r > WORLD.half * 0.75) {
      const toCenter = Math.atan2(-this.pos.x, -this.pos.z);
      let diff = toCenter - this.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      turn += diff * 0.7;
    }
    this.heading += THREE.MathUtils.clamp(turn, -0.5, 0.5) * dt;

    const speedTarget = this.state === 'breathe' ? 0.25 : 0.9 + this.flapPower * 0.7;
    this.speed += (speedTarget - this.speed) * (1 - Math.exp(-1.2 * dt));
    this.pos.y += (targetY - this.pos.y) * (1 - Math.exp(-(this.state === 'cruise' ? 0.35 : 0.8) * dt));
    this.pos.x += Math.sin(this.heading) * this.speed * dt;
    this.pos.z += Math.cos(this.heading) * this.speed * dt;

    // ---- 姿勢・前肢のストローク ----
    this.group.position.copy(this.pos);
    const pitch = THREE.MathUtils.clamp((this.pos.y - targetY) * 0.25, -0.35, 0.35);
    this.group.rotation.set(pitch, this.heading, 0, 'YXZ');

    const stroke = Math.sin(t * 1.9) * this.flapPower;
    const strokeLag = Math.sin(t * 1.9 - 0.7) * this.flapPower;
    for (const f of this.flippers) {
      if (f.front) {
        // 前肢: 大きく上下 + ひねり(揚力ベースの水中飛翔)
        // 左右で鏡像のジオメトリを使うので、回転は符号だけ反転させる
        f.mesh.rotation.z = f.side * stroke * 0.55;
        f.mesh.rotation.x = f.side * strokeLag * 0.30;
      } else {
        // 後肢: 舵として小さく揺れる
        f.mesh.rotation.x = f.side * Math.sin(t * 0.9 + (f.side > 0 ? 0 : 1.2)) * 0.15;
      }
    }
    // 首をわずかに揺らす(首ごと緩やかに曲がる)
    this.head.rotation.y = Math.sin(t * 0.5) * 0.11;
    this.head.rotation.x = this.state === 'ascend' ? -0.22 : Math.sin(t * 0.7) * 0.06;
  }
}
