import * as THREE from 'three';
import { WORLD } from '../env.js';
import { addCausticsToStandard, sandHeight } from '../environment/seabed.js';
import { wander1 } from '../noise.js';
import { clampToTerrain } from '../collision.js';

const _av = new THREE.Vector3();
const _vel = new THREE.Vector3();

// ============ アオウミガメ ============
// 前肢を翼のように使う「水中飛翔」。数分ごとに呼吸のため水面へ
// 上がる行動サイクル(cruise → ascend → breathe → descend)を再現。

const sstep = (x, e0, e1) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};
const hash1 = (i) => {
  const v = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return v - Math.floor(v);
};
const hash2 = (x, y) => {
  const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return v - Math.floor(v);
};
// 値ノイズ(甲羅の付着藻・風化のまだら用)。
// テクスチャの全画素から何度も呼ぶので、格子点のハッシュは
// Math.sin ではなく整数演算で引く(sin 版だと生成が数百ms遅くなる)。
function ihash(x, y) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return (ihash(xi, yi) * (1 - u) + ihash(xi + 1, yi) * u) * (1 - v)
       + (ihash(xi, yi + 1) * (1 - u) + ihash(xi + 1, yi + 1) * u) * v;
}
function fbm2(x, y) {
  return vnoise(x, y) * 0.64 + vnoise(x * 2.1 + 5, y * 2.1) * 0.36;
}

// ============ 甲羅の形状 ============
// 実物のアオウミガメの甲羅は「潰した卵」ではない。上から見ると
//   ・前縁の左右に前肢を出すための切れ込み(肩のくびれ)がある
//   ・最大幅は中央よりわずかに前
//   ・後方はゆるく細まり、縁甲板の継ぎ目ごとに波打つ(スカラップ)
// 横から見ると、縁が水平に張り出すのではなく下へ巻き込み、
// その下に腹甲までの「橋(ブリッジ)」があって体に厚みが出る。
const SHELL = {
  halfW: 1.10,     // 半幅
  halfL: 1.30,     // 半長(正規化z が +1.00〜-1.17 なので実長は約2.8)
  height: 0.46,    // 縁の高さから甲羅頂点まで(遊泳に適した扁平な流線形)
  rimCurl: 0.15,   // 縁甲板が下へ巻き込む量
  bridge: 0.26,    // 縁から腹甲までの落差
  dish: 0.05,      // 腹甲中央のわずかな持ち上がり
  keel: 0.026,     // 正中線の弱いキール
  tilt: 0.050,     // 前を高く後ろを低く
};
const RIM_V = 0.87;      // ここまでが背面。以降は縁甲板が下へ巻き込む区間
const MARGINALS = 12;    // 縁甲板(片側)

// テクスチャ平面の範囲。甲羅の正規化平面座標をそのまま UV にするので、
// 縁甲板のシードまで含む余裕をとる。z方向は前後非対称なので中心をずらす。
const HX = 1.15, HZ = 1.23, NZ0 = -0.08;

// 甲羅の輪郭(右半分、前→後)。写真の平面形をトレースした正規化座標。
const OUTLINE = [
  [0.000,  1.000],
  [0.130,  0.986],
  [0.255,  0.945],
  [0.350,  0.884],   // 肩の張り出し
  [0.395,  0.826],
  [0.404,  0.775],   // ← 前肢の付け根。ここが内へくびれる
  [0.470,  0.726],
  [0.600,  0.640],
  [0.735,  0.520],
  [0.860,  0.372],
  [0.952,  0.200],
  [0.996,  0.020],   // 最大幅(中央よりわずかに前)
  [1.000, -0.160],
  [0.972, -0.340],
  [0.918, -0.505],
  [0.836, -0.660],
  [0.726, -0.800],
  [0.592, -0.925],
  [0.436, -1.030],
  [0.268, -1.110],
  [0.100, -1.158],
  [0.000, -1.170],
];

// 輪郭は原点から見て星形(角度に対し半径が一意)なので、
// 角度→半径の表に落としておけば射線交差を解かずに引ける。
const RTAB_N = 160;
const RTAB = new Float32Array(RTAB_N + 1);
{
  const pts = OUTLINE.map(([x, z]) => ({ a: Math.atan2(x, z), r: Math.hypot(x, z) }));
  for (let i = 0; i <= RTAB_N; i++) {
    const a = (i / RTAB_N) * Math.PI;
    let k = 0;
    while (k < pts.length - 2 && pts[k + 1].a < a) k++;
    const span = Math.max(pts[k + 1].a - pts[k].a, 1e-6);
    const f = Math.min(Math.max((a - pts[k].a) / span, 0), 1);
    RTAB[i] = pts[k].r + (pts[k + 1].r - pts[k].r) * f;
  }
}

// a: 0=前(+z) → π=後(-z)。scallop=true で縁甲板の継ぎ目ごとに輪郭がくびれる
function outlineAt(a, scallop = true) {
  let t = a % (Math.PI * 2);
  if (t < 0) t += Math.PI * 2;
  const h = t > Math.PI ? Math.PI * 2 - t : t;   // 左右対称なので右半分に畳む
  const fi = (h / Math.PI) * RTAB_N;
  const i0 = Math.min(Math.floor(fi), RTAB_N - 1);
  let r = RTAB[i0] + (RTAB[i0 + 1] - RTAB[i0]) * (fi - i0);
  if (scallop) {
    // 継ぎ目(h = kπ/12)で内へ食い込む。後半身ほど目立つ
    const notch = 0.5 + 0.5 * Math.cos(2 * MARGINALS * h);
    r *= 1 - 0.016 * notch * sstep(h, 0.75, 1.6);
  }
  return { x: Math.sin(t) * r, z: Math.cos(t) * r };
}

// ============ 鱗板(スキュート)の配置 ============
// アオウミガメ: 椎甲板5枚(正中線)/ 肋甲板4対 / 項甲板1枚 / 縁甲板12対。
// この配置はテクスチャと甲羅ジオメトリの両方から参照する。
// 同じ配置から「模様」と「板の溝」を作るので、絵と凹凸が必ず一致する。
const SC_VERT = 0, SC_COST = 1, SC_NUCH = 2, SC_MARG = 3;
const SCUTES = [];
{
  for (const z of [0.72, 0.36, 0.00, -0.36, -0.74]) SCUTES.push({ x: 0, z, type: SC_VERT });
  for (const z of [0.60, 0.20, -0.20, -0.62]) {
    SCUTES.push({ x: -0.48, z, type: SC_COST });
    SCUTES.push({ x: 0.48, z, type: SC_COST });
  }
  SCUTES.push({ x: 0, z: 0.99, type: SC_NUCH });
  for (let i = 0; i < MARGINALS; i++) {
    const a = ((i + 0.5) / MARGINALS) * Math.PI;
    const o = outlineAt(a, false);
    SCUTES.push({ x: o.x * 1.18, z: o.z * 1.18, type: SC_MARG });
    SCUTES.push({ x: -o.x * 1.18, z: o.z * 1.18, type: SC_MARG });
  }
  // 成長中心。ここから角質が同心円状に足されていくので、模様はここから放射する。
  // 肋甲板は外後方、椎甲板は後縁寄りが成長中心になる。
  SCUTES.forEach((s, i) => {
    const j = hash1(i * 5.1) - 0.5;
    s.cv = hash1(i * 3.7);              // 板ごとの濃淡
    s.rayVar = 0.62 + 0.62 * hash1(i * 11.3);  // 条の出方のばらつき
    if (s.type === SC_COST) { s.gx = s.x + Math.sign(s.x) * 0.30; s.gz = s.z - 0.24 + j * 0.06; }
    else if (s.type === SC_VERT) { s.gx = j * 0.05; s.gz = s.z - 0.21; }
    else if (s.type === SC_NUCH) { s.gx = 0; s.gz = s.z + 0.09; }
    else { s.gx = s.x * 1.06; s.gz = s.z * 1.06; }
  });
}
const ZW = SHELL.halfL / SHELL.halfW;   // 正規化座標の距離を実寸比へ補正

// ---- 甲板検索用の空間グリッド ----
// scuteAt はテクスチャの全画素(数十万回)から呼ばれるので、
// 毎回56個のシードを総当たりすると生成に1秒近くかかる。
// 平面をセルに切り、セルごとに「最近傍・第2近傍になり得るシード」だけを
// 前もって絞っておく。セル中心から見た第2近傍までの距離に
// セルの対角ぶんの余裕を足した範囲を残せば、取りこぼしは起きない。
const GRID_X = 8, GRID_Z = 10;
const GMINX = -HX, GMINZ = (NZ0 - HZ) * ZW;
const CELL_W = (2 * HX) / GRID_X, CELL_H = (2 * HZ * ZW) / GRID_Z;
const BUCKETS = [];
{
  const slack = Math.hypot(CELL_W, CELL_H) + 0.05;   // 対角の半分 × 2 + 余裕
  for (let gz = 0; gz < GRID_Z; gz++) {
    for (let gx = 0; gx < GRID_X; gx++) {
      const cx = GMINX + (gx + 0.5) * CELL_W;
      const cz = GMINZ + (gz + 0.5) * CELL_H;
      const ds = SCUTES
        .map((s, i) => ({ i, d: Math.hypot(cx - s.x, cz - s.z * ZW) }))
        .sort((a, b) => a.d - b.d);
      const lim = ds[1].d + slack;
      BUCKETS.push(Int32Array.from(ds.filter((e) => e.d <= lim).map((e) => e.i)));
    }
  }
}

// 平面座標 (nx, nz) がどの甲板に属するかと、境界までの余裕を返す
const _sc = { best: 0, s1: 0, s2: 0 };
function scuteAt(nx, nz) {
  const mz = nz * ZW;
  const gx = Math.min(GRID_X - 1, Math.max(0, Math.floor((nx - GMINX) / CELL_W)));
  const gz = Math.min(GRID_Z - 1, Math.max(0, Math.floor((mz - GMINZ) / CELL_H)));
  const list = BUCKETS[gz * GRID_X + gx];
  let d1 = 1e9, d2 = 1e9, best = 0;
  for (let k = 0; k < list.length; k++) {
    const s = SCUTES[list[k]];
    const dx = nx - s.x, dz = mz - s.z * ZW;
    const d = dx * dx + dz * dz;
    if (d < d1) { d2 = d1; d1 = d; best = list[k]; }
    else if (d < d2) { d2 = d; }
  }
  _sc.best = best; _sc.s1 = Math.sqrt(d1); _sc.s2 = Math.sqrt(d2);
  return _sc;
}

// ============ 背甲のテクスチャ ============
// 参考写真の甲羅は「濃いチョコレート褐色の地に、成長中心から琥珀色の条が
// 放射する」。従来は一様なオリーブに薄い筋が乗るだけで、この特徴が出ていなかった。
function makeCarapaceTexture() {
  const S = 576;   // 甲板の溝はジオメトリ側で出すので、この解像度で足りる
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(S, S);
  const data = img.data;

  const RAY = [0.640, 0.430, 0.180];  // 琥珀色の条
  const ALG = [0.30, 0.33, 0.21];     // 付着藻の緑

  // 付着藻とまだらは低周波なので、半分の解像度で先に焼いておく。
  // 画素ごとに値ノイズを引くと、それだけで生成時間が倍近くになる。
  const NS = S >> 1;
  const algMap = new Float32Array(NS * NS);
  const motMap = new Float32Array(NS * NS);
  for (let j = 0; j < NS; j++) {
    const nz = NZ0 + (0.5 - (j + 0.5) / NS) * 2 * HZ;
    for (let i = 0; i < NS; i++) {
      const nx = ((i + 0.5) / NS - 0.5) * 2 * HX;
      algMap[j * NS + i] = sstep(fbm2(nx * 2.6 + 7, nz * 2.6), 0.66, 0.88) * 0.22;
      motMap[j * NS + i] = fbm2(nx * 11 + 3, nz * 11) - 0.5;
    }
  }

  let p = 0;
  for (let py = 0; py < S; py++) {
    const nz = NZ0 + (0.5 - (py + 0.5) / S) * 2 * HZ;
    for (let px = 0; px < S; px++) {
      const nx = ((px + 0.5) / S - 0.5) * 2 * HX;

      const sc = scuteAt(nx, nz);
      const seed = SCUTES[sc.best];
      const gapN = sc.s2 - sc.s1;             // 甲板境界までの距離
      const cv = seed.cv;

      // 下地: 濃いチョコレート褐色。板ごとに濃淡差があり、外周ほど明るい
      const lz = (nz - NZ0) * 0.80;
      const lat = sstep(Math.sqrt(nx * nx + lz * lz), 0.15, 0.95) * 0.030;
      let r = 0.058 + cv * 0.040 + lat;
      let g = 0.035 + cv * 0.027 + lat * 0.68;
      let b = 0.019 + cv * 0.015 + lat * 0.30;
      if (seed.type === SC_MARG) { r += 0.042; g += 0.029; b += 0.014; }

      // ---- 成長条(放射) ----
      // 角質は成長中心から同心円状に足されていくので、模様はそこから放射する。
      // ただし等間隔の扇にすると人工的なので、角度そのものを歪ませて
      // 条の太さを不揃いにする(実物の条は幅も濃さもばらばら)。
      const dx = nx - seed.gx, dz = (nz - seed.gz) * ZW;
      const gd = Math.sqrt(dx * dx + dz * dz);
      const ang0 = Math.atan2(dz, dx);
      const ang = ang0 + 0.22 * Math.sin(ang0 * 2.0 + sc.best * 1.9)
                       + 0.09 * Math.sin(ang0 * 5.0 + sc.best * 4.1);
      const n1 = 5 + Math.floor(cv * 4);
      const w1 = 0.5 + 0.5 * Math.cos(ang * n1 + sc.best * 2.7);
      const w2 = 0.5 + 0.5 * Math.cos(ang * (n1 * 2 + 1) + sc.best * 1.3);
      // 条は細い引っかき傷ではなく幅の広い楔なので、指数を寝かせる
      let ray = w1 * Math.sqrt(Math.sqrt(w1)) * 0.86 + w2 * w2 * w2 * 0.14;
      // うっすらとした成長輪(同心円)
      ray *= 0.92 + 0.08 * Math.cos(gd * 34 + sc.best);
      // 成長中心そのものは暗く、そこから外へ向かって条が開く
      ray *= sstep(gd, 0.045, 0.26);
      // 継ぎ目のすぐ内側では条が途切れる
      ray *= sstep(gapN, 0.004, 0.050);
      const amp = (seed.type === SC_MARG ? 0.66 : seed.type === SC_VERT ? 0.84 : 1.0) * seed.rayVar;
      const k = Math.min(ray * amp, 1) * 0.97;
      r += (RAY[0] - r) * k; g += (RAY[1] - g) * k; b += (RAY[2] - b) * k;

      // ---- 付着藻・風化のまだら ----
      const ni = (py >> 1) * NS + (px >> 1);
      const alg = algMap[ni], mot = motMap[ni];
      r += (ALG[0] - r) * alg; g += (ALG[1] - g) * alg; b += (ALG[2] - b) * alg;
      r += mot * 0.038; g += mot * 0.032; b += mot * 0.018;

      // ---- 甲板の継ぎ目 ----
      // 溝そのものはジオメトリで彫るので、ここは陰だけを置く
      const bevel = 1 - sstep(gapN, 0.006, 0.048);
      const seam = 1 - sstep(gapN, 0.0, 0.011);
      const dim = bevel * 0.30 + seam * 0.34;
      r *= 1 - dim; g *= 1 - dim; b *= 1 - dim * 0.92;

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

// ============ 背甲のジオメトリ ============
// v: 0(頂点) → RIM_V(最大幅の縁) → 1(縁甲板が下へ巻き込んだ先端)
function shellRadial(v) {
  if (v <= RIM_V) return v / RIM_V;
  // 縁を回り込む間、平面半径はわずかに戻る(縁が丸まる)
  return 1 - 0.085 * Math.pow((v - RIM_V) / (1 - RIM_V), 1.7);
}
function shellY(v, nx, nz) {
  const rr = Math.min(v / RIM_V, 1);
  const dome = Math.pow(Math.max(1 - rr * rr, 0), 0.72);
  let y = SHELL.height * dome
        + SHELL.tilt * nz * dome                                   // 前を高く
        + SHELL.keel * Math.exp(-(nx / 0.24) * (nx / 0.24)) * dome; // 弱いキール
  if (v > RIM_V) {
    y -= SHELL.rimCurl * Math.pow((v - RIM_V) / (1 - RIM_V), 1.45);
  }
  return y;
}

function buildCarapace() {
  const SEG = 128, RINGS = 46;
  const pos = [], uv = [], idx = [];
  const plan = [];    // 甲板の溝を彫るために平面座標を控えておく
  const carveW = [];  // 溝の効き具合。縁では 0 にして腹甲とぴったり合わせる

  const put = (nx, nz, y, w) => {
    pos.push(nx * SHELL.halfW, y, nz * SHELL.halfL);
    uv.push(0.5 + nx / (2 * HX), 0.5 - (nz - NZ0) / (2 * HZ));
    plan.push(nx, nz);
    carveW.push(w);
  };

  put(0, 0, shellY(0, 0, 0), 1);
  for (let i = 1; i <= RINGS; i++) {
    // 縁の巻き込み区間にリングを厚く配る(急に曲がるので)
    const u = i / RINGS;
    const v = u < 0.82 ? (u / 0.82) * RIM_V : RIM_V + ((u - 0.82) / 0.18) * (1 - RIM_V);
    const rad = shellRadial(v);
    for (let j = 0; j < SEG; j++) {
      const a = (j / SEG) * Math.PI * 2;
      const o = outlineAt(a);
      const nx = o.x * rad, nz = o.z * rad;
      put(nx, nz, shellY(v, nx, nz), 1 - sstep(v, 0.90, 1.0));
    }
  }

  const ringStart = (i) => 1 + (i - 1) * SEG;
  for (let j = 0; j < SEG; j++) idx.push(0, 1 + j, 1 + ((j + 1) % SEG));
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

  // ---- 甲板の継ぎ目を彫る ----
  // 実物の甲板はほぼ面一で、継ぎ目だけが浅い溝になっている。
  // 板ごとに膨らませると松かさのように見えてしまうので、溝だけを入れる。
  // 法線方向へ押し込んでから法線を取り直すので、陰影と絵が一致する。
  const P = geo.attributes.position, N = geo.attributes.normal;
  for (let i = 0; i < P.count; i++) {
    const s = scuteAt(plan[i * 2], plan[i * 2 + 1]);
    const d = -0.015 * (1 - sstep(s.s2 - s.s1, 0.0, 0.038)) * carveW[i];
    P.setXYZ(i, P.getX(i) + N.getX(i) * d, P.getY(i) + N.getY(i) * d, P.getZ(i) + N.getZ(i) * d);
  }
  geo.computeVertexNormals();
  return geo;
}

// ============ 腹甲とブリッジ ============
// 背甲の最終リングから内へ畳み込み、平らな腹甲で閉じる。
// 実物の腹甲は背甲より一回り小さく、縁甲板の下へ引っ込んでいる。
// ここを垂直な壁にすると、樽に入っているように見えてしまう。
function buildPlastron() {
  const SEG = 128, RINGS = 22;
  const pos = [], uv = [], idx = [];

  const yRim = shellY(1, 0, 0);           // 背甲の最終リングと完全に一致させる
  const rRim = shellRadial(1);
  // w: 0(縁の先端) → 1(腹甲の中心)
  // 縁からいったん斜め内下へ絞り(ブリッジ)、そこから平らな底になる
  const radAt = (w) => rRim * (1 - 0.46 * sstep(w, 0.0, 0.40) - 0.54 * sstep(w, 0.40, 1.0));
  const yAt = (w) => yRim - SHELL.bridge * sstep(w, 0.0, 0.40) + SHELL.dish * sstep(w, 0.45, 1.0);

  const put = (nx, nz, y) => {
    pos.push(nx * SHELL.halfW, y, nz * SHELL.halfL);
    uv.push(0.5 + nx / (2 * HX), 0.5 - (nz - NZ0) / (2 * HZ));
  };

  put(0, 0, yAt(1));
  for (let i = RINGS - 1; i >= 0; i--) {
    const w = i / RINGS;   // 中心から縁へ向かって並べる
    const rad = radAt(w), y = yAt(w);
    for (let j = 0; j < SEG; j++) {
      const a = (j / SEG) * Math.PI * 2;
      const o = outlineAt(a);
      put(o.x * rad, o.z * rad, y);
    }
  }
  const ringStart = (i) => 1 + i * SEG;
  // 下向きなので巻き順を反転
  for (let j = 0; j < SEG; j++) idx.push(0, 1 + ((j + 1) % SEG), 1 + j);
  for (let i = 0; i < RINGS - 1; i++) {
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

// 腹甲のテクスチャ: クリーム色の地に、腹甲板の継ぎ目と薄い汚れ
function makePlastronTexture() {
  const S = 192;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(S, S);
  const data = img.data;
  // 腹甲板: 正中線に沿って左右6対
  const seeds = [];
  for (const z of [0.62, 0.34, 0.10, -0.16, -0.44, -0.74]) {
    seeds.push([-0.30, z]); seeds.push([0.30, z]);
  }
  let p = 0;
  for (let py = 0; py < S; py++) {
    const nz = NZ0 + (0.5 - (py + 0.5) / S) * 2 * HZ;
    for (let px = 0; px < S; px++) {
      const nx = ((px + 0.5) / S - 0.5) * 2 * HX;
      let d1 = 1e9, d2 = 1e9, best = 0;
      for (let k = 0; k < seeds.length; k++) {
        const dx = nx - seeds[k][0], dz = (nz - seeds[k][1]) * ZW;
        const d = dx * dx + dz * dz;
        if (d < d1) { d2 = d1; d1 = d; best = k; } else if (d < d2) d2 = d;
      }
      const gap = Math.sqrt(d2) - Math.sqrt(d1);
      const cv = ihash(best, 7);
      let r = 0.60 + cv * 0.07, g = 0.555 + cv * 0.065, b = 0.435 + cv * 0.05;
      const mot = fbm2(nx * 5 + 21, nz * 5) - 0.5;
      r += mot * 0.07; g += mot * 0.07; b += mot * 0.06;
      // ブリッジ(甲羅の外周寄り)は日陰になるので少し暗い
      const rz = nz * 0.85;
      const rim = sstep(Math.sqrt(nx * nx + rz * rz), 0.55, 1.0);
      r *= 1 - rim * 0.24; g *= 1 - rim * 0.24; b *= 1 - rim * 0.22;
      const seam = 1 - sstep(gap, 0.0, 0.042);
      const dim = seam * 0.34;
      r *= 1 - dim; g *= 1 - dim; b *= 1 - dim;
      data[p++] = Math.min(r, 1) * 255;
      data[p++] = Math.min(g, 1) * 255;
      data[p++] = Math.min(b, 1) * 255;
      data[p++] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============ 皮膚のモザイク鱗 ============
// ウミガメの頭部・四肢は、多角形の鱗を淡いクリーム色の目地が縁取る
// 網目模様が最大の特徴。参考写真ではこの目地のコントラストがかなり強い。
// 色そのものは頂点カラー(背=暖かい褐色 / 腹=クリーム)で与え、
// このテクスチャは「鱗=暗い / 目地=明るい」の変調係数として使う。
function makeSkinTexture() {
  const S = 512;
  const GRID = 14;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(S, S);
  const data = img.data;

  const cells = [];
  const shade = new Float32Array(GRID * GRID);   // 鱗ごとの明度(画素ごとに引き直さない)
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const k = gy * GRID + gx;
      cells.push([
        (gx + 0.18 + hash2(gx, gy) * 0.64) / GRID,
        (gy + 0.18 + hash2(gx + 37, gy + 11) * 0.64) / GRID,
      ]);
      const cv = hash2(k * 1.7, k * 5.3);
      shade[k] = 0.34 + cv * 0.19 + (cv > 0.86 ? 0.15 : 0);   // まだらに明るい鱗が混じる
    }
  }
  const wrap = (d) => (d > 0.5 ? d - 1 : d < -0.5 ? d + 1 : d);

  let p = 0;
  for (let py = 0; py < S; py++) {
    const fy = (py + 0.5) / S;
    const gy = Math.floor(fy * GRID);
    for (let px = 0; px < S; px++) {
      const fx = (px + 0.5) / S;
      const gx = Math.floor(fx * GRID);

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

      // 鱗の地は暗く、目地は明るい。参考写真に合わせて差を大きくとる
      let base = shade[best];
      base *= 1 - sstep(gap, 0.034, 0.004) * 0.20;        // 鱗の中央が盛り上がって見えるよう周辺を落とす
      const seam = Math.pow(1 - sstep(gap, 0.0, 0.020), 0.8);
      const val = base + (1.0 - base) * seam;

      const c = Math.max(Math.min(val, 1), 0) * 255;
      data[p++] = c; data[p++] = c * 0.985; data[p++] = c * 0.94;
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

// 背側=暖かい褐色、腹側=クリーム(リニア空間で頂点カラーに書く)
const SKIN_DORSAL = new THREE.Color('#a67c42').convertSRGBToLinear();
const SKIN_VENTRAL = new THREE.Color('#ece2bf').convertSRGBToLinear();
const _mixCol = new THREE.Color();
function skinColor(up) {
  // up: 1=真上 0=真下
  return _mixCol.copy(SKIN_VENTRAL).lerp(SKIN_DORSAL, sstep(up, 0.28, 0.74));
}

// ============ 首〜頭(一体のロフト) ============
// 首と頭を1つの連続した形状として作るので継ぎ目が出ない。
// 参考写真の頭は「カプセル」ではなく、
//   ・頬(眼のすぐ後ろ)が最も張り、そこから前へくさび状に細まる
//   ・先端は尖らず丸く落ちる(嘴)
//   ・上嘴が下顎にかぶさるので、口の線に沿って段差がある
const HEAD_LEN = 1.30;
const HP_V  = [0.00, 0.12, 0.26, 0.40, 0.52, 0.64, 0.74, 0.84, 0.93];
const HP_HW = [0.360, 0.290, 0.235, 0.225, 0.245, 0.283, 0.292, 0.268, 0.222];
const HP_HH = [0.320, 0.260, 0.215, 0.208, 0.228, 0.268, 0.278, 0.258, 0.218];
const HP_CY = [0.000, 0.035, 0.070, 0.098, 0.112, 0.112, 0.100, 0.072, 0.034];
const V_BEAK = 0.93;      // ここから先は嘴のキャップ
const BEAK_LEN = 0.30;    // 嘴の突き出し(HEAD_LEN に対する加算)
const BEAK_DROP = 0.085;  // 先端が下へフックする量
const MOUTH_A = 2.02;     // 口の線(断面角。0=真上)

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
  let hw, hh, cy, z;
  if (v <= V_BEAK) {
    hw = sampleHP(HP_HW, v); hh = sampleHP(HP_HH, v); cy = sampleHP(HP_CY, v);
    z = v * HEAD_LEN;
  } else {
    // 嘴: 断面を丸く畳みながら前へ出す。cos の指数を 1 より小さくして
    // 半球より鈍い(先が丸く落ちる)キャップにする
    const th = ((v - V_BEAK) / (1 - V_BEAK)) * Math.PI * 0.5;
    const k = Math.pow(Math.cos(th), 0.72);
    hw = sampleHP(HP_HW, V_BEAK) * k;
    hh = sampleHP(HP_HH, V_BEAK) * k;
    cy = sampleHP(HP_CY, V_BEAK) - BEAK_DROP * Math.pow(Math.sin(th), 1.5);
    z = V_BEAK * HEAD_LEN + BEAK_LEN * Math.sin(th);
  }

  const ca = Math.cos(a), sa = Math.sin(a);
  // 上嘴が下顎にかぶさる段差。口の線より下だけを内側へ寄せる
  const aa = Math.abs(((a + Math.PI) % (Math.PI * 2)) - Math.PI);
  const jaw = 1 - 0.10 * sstep(v, 0.58, 0.92) * sstep(aa, MOUTH_A - 0.02, MOUTH_A + 0.16);
  return out.set(
    hw * sa * (ca > 0 ? 1.0 : 0.93) * jaw,
    cy + hh * ca * (ca > 0 ? 0.90 : 1.0) * (ca > 0 ? 1 : jaw),
    z
  );
}

function buildHeadNeck() {
  const SEG_A = 26;
  const pos = [], uvs = [], cols = [], idx = [];
  const pt = new THREE.Vector3();

  // 首と頭でモザイクの粒を変える。実物も、首は細かい鱗、頭頂は大きな板状の
  // 鱗になっている。UVの繰り返し数が違うので、境界のリングは頂点を重複させる
  // (位置は同一なので裂けない)。
  const bands = [
    { v0: 0.00, v1: 0.55, seg: 26, uRep: 3.0, vRep: 3.6, v0uv: 0.0 },
    { v0: 0.55, v1: 1.00, seg: 22, uRep: 1.5, vRep: 1.9, v0uv: 0.0 },
  ];

  for (const bd of bands) {
    const base = pos.length / 3;
    for (let i = 0; i <= bd.seg; i++) {
      const v = bd.v0 + (bd.v1 - bd.v0) * (i / bd.seg);
      for (let j = 0; j <= SEG_A; j++) {
        const a = (j / SEG_A) * Math.PI * 2;
        headSurface(v, a, pt);
        pos.push(pt.x, pt.y, pt.z);
        uvs.push((j / SEG_A) * bd.uRep, bd.v0uv + (v - bd.v0) * bd.vRep);
        const c = skinColor(Math.cos(a) * 0.5 + 0.5);
        cols.push(c.r, c.g, c.b);
      }
    }
    for (let i = 0; i < bd.seg; i++) {
      for (let j = 0; j < SEG_A; j++) {
        const a0 = base + i * (SEG_A + 1) + j;
        const b0 = base + (i + 1) * (SEG_A + 1) + j;
        idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1);
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

// 口(嘴の合わせ目): 上嘴の縁に沿う細い暗線。先端に向かって細くなる
function buildMouthLine() {
  const pos = [], idx = [];
  const W = 0.055;
  const V0 = 0.60, V1 = 0.995;
  const N = 26;
  const p = new THREE.Vector3();
  for (const side of [1, -1]) {
    const base = pos.length / 3;
    for (let i = 0; i <= N; i++) {
      const f = i / N;
      const v = V0 + (V1 - V0) * f;
      const w = W * (1 - 0.65 * Math.pow(f, 2.2));
      for (const d of [-w, w]) {
        headSurface(v, side * (MOUTH_A + d), p);
        pos.push(p.x * 1.008, p.y + (p.y > 0 ? 0.0015 : -0.0015), p.z);
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
// 前縁がふくらみ後縁が薄い水中翼の断面。先端は後方へ後退し、
// 翼のように上へたわむ(bend)。先端側にひねり(twist)を入れると
// 水を掻いている感じが出る。
function buildPaddle({ len, chord, sweep, thick, tipRound = 0.42, bend = 0.14, twist = 0 }, mirror = false) {
  const SEG_S = 30, SEG_T = 16;
  const pos = [], uvs = [], cols = [], idx = [];

  const chordAt = (s) => chord * Math.pow(Math.max(1 - Math.pow(s, 2.2), 0), tipRound);
  const leadAt = (s) => chord * 0.5 - sweep * Math.pow(s, 1.3);
  const thickAt = (s, t) =>
    thick * (1 - 0.62 * s) * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.62)), 0.80);

  for (const face of [1, -1]) { // 1=背側 -1=腹側
    const base = pos.length / 3;
    for (let i = 0; i <= SEG_S; i++) {
      const s = i / SEG_S;
      const c = chordAt(s), lead = leadAt(s);
      for (let j = 0; j <= SEG_T; j++) {
        const t = j / SEG_T;
        const x = s * len;
        const z = lead - c * t;
        const y = bend * s * s + twist * s * s * (t - 0.45) * chord
                + face * thickAt(s, t) * 0.5;
        pos.push(mirror ? -x : x, y, z);
        uvs.push(t * 1.1, s * 2.6);
        // 背側は縁ぎりぎりまで暗く、前縁・後縁のごく細い帯だけが淡い。
        // ここを広くとると、ひれの縁が白く光って厚紙のように見えてしまう。
        const edge = sstep(Math.min(t, 1 - t), 0.0, 0.10);
        const c2 = skinColor(face > 0 ? 0.5 + 0.5 * edge : 0.5 - 0.5 * edge);
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

// 肩・腿の肉。ひれが甲羅の縁から生えているように見えないよう、
// 付け根に皮膚の塊を置いて甲羅の内側へ差し込む。
// 球の極(UVが収束して星形の陰影が出る点)が下を向かないよう倒しておく。
function buildLimbRoot(rx, ry, rz) {
  const geo = new THREE.SphereGeometry(1, 20, 14);
  geo.rotateX(Math.PI / 2);
  geo.scale(rx, ry, rz);
  const P = geo.attributes.position;
  const cols = [];
  for (let i = 0; i < P.count; i++) {
    const c = skinColor(P.getY(i) / ry * 0.5 + 0.5);
    cols.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  return geo;
}

export class SeaTurtle {
  constructor(scene) {
    this.group = new THREE.Group();

    // 皮膚: モザイク鱗テクスチャ × 頂点カラー(背=褐色 / 腹=クリーム)
    const skin = new THREE.MeshStandardMaterial({
      map: makeSkinTexture(),
      vertexColors: true,
      roughness: 0.74,
    });
    addCausticsToStandard(skin, 0.7);
    const shellMat = new THREE.MeshStandardMaterial({
      map: makeCarapaceTexture(), roughness: 0.66,
    });
    addCausticsToStandard(shellMat, 0.7);
    const bellyMat = new THREE.MeshStandardMaterial({
      map: makePlastronTexture(), roughness: 0.80,
    });
    addCausticsToStandard(bellyMat, 0.4);

    // 背甲 + 側壁/腹甲(同じ輪郭で閉じるので縁に厚みが出る)
    this.group.add(new THREE.Mesh(buildCarapace(), shellMat));
    this.group.add(new THREE.Mesh(buildPlastron(), bellyMat));

    // ---- 首〜頭(一体のロフト。根本は甲羅の中に差し込む) ----
    this.head = new THREE.Group();
    this.head.add(new THREE.Mesh(buildHeadNeck(), skin));

    // 口(嘴の合わせ目)
    const mouthMat = new THREE.MeshStandardMaterial({ color: '#1e1810', roughness: 0.5 });
    this.head.add(new THREE.Mesh(buildMouthLine(), mouthMat));

    // 鼻孔: 嘴の上面に2つ
    const nostrilMat = new THREE.MeshStandardMaterial({ color: '#241d13', roughness: 0.7 });
    const nPos = new THREE.Vector3();
    for (const s of [-1, 1]) {
      headSurface(0.965, s * 0.42, nPos);
      const n = new THREE.Mesh(new THREE.SphereGeometry(0.021, 10, 8), nostrilMat);
      n.position.copy(nPos).multiplyScalar(0.985);
      n.position.z = nPos.z;
      n.scale.set(1, 0.7, 1.2);
      this.head.add(n);
    }

    // 目: 頭部表面にはめ込み、まぶたの縁で囲う
    const eyeMat = new THREE.MeshStandardMaterial({
      color: '#150e06', roughness: 0.30, metalness: 0.0,
    });
    const lidMat = new THREE.MeshStandardMaterial({ color: '#4a3a22', roughness: 0.80 });
    const eyeV = 0.735, eyeA = 1.26;
    const ePos = new THREE.Vector3();
    for (const s of [-1, 1]) {
      headSurface(eyeV, s * eyeA, ePos);
      // 外向き法線(断面楕円の法線で近似)
      const hw = sampleHP(HP_HW, eyeV), hh = sampleHP(HP_HH, eyeV), cy = sampleHP(HP_CY, eyeV);
      const nrm = new THREE.Vector3(ePos.x / (hw * hw), (ePos.y - cy) / (hh * hh), 0).normalize();

      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.050, 16, 12), eyeMat);
      eye.position.copy(ePos).addScaledVector(nrm, -0.010);
      this.head.add(eye);

      // まぶた: 上下でわずかに被さるので縦につぶす
      const lid = new THREE.Mesh(new THREE.TorusGeometry(0.050, 0.011, 8, 18), lidMat);
      lid.position.copy(ePos).addScaledVector(nrm, -0.004);
      lid.lookAt(lid.position.clone().add(nrm));
      lid.scale.set(1.08, 0.78, 1.0);
      this.head.add(lid);
    }
    this.head.position.set(0, -0.02, 0.52);
    this.group.add(this.head);

    // ---- 前肢(大きなパドル)・後肢(舵) ----
    this.flippers = [];
    const frontSpec = { len: 1.78, chord: 0.62, sweep: 0.52, thick: 0.092, tipRound: 0.40, bend: 0.16, twist: -0.34 };
    const rearSpec = { len: 0.82, chord: 0.58, sweep: 0.20, thick: 0.086, tipRound: 0.62, bend: 0.06, twist: -0.12 };
    const frontGeo = { 1: buildPaddle(frontSpec, false), '-1': buildPaddle(frontSpec, true) };
    const rearGeo = { 1: buildPaddle(rearSpec, false), '-1': buildPaddle(rearSpec, true) };
    const clawMat = new THREE.MeshStandardMaterial({ color: '#2a2519', roughness: 0.5 });
    const shoulderGeo = buildLimbRoot(0.32, 0.15, 0.30);
    const hipGeo = buildLimbRoot(0.27, 0.13, 0.26);

    for (const s of [-1, 1]) {
      const shoulder = new THREE.Mesh(shoulderGeo, skin);
      shoulder.position.set(s * 0.64, -0.115, 0.58);
      this.group.add(shoulder);

      const front = new THREE.Mesh(frontGeo[s], skin);
      front.position.set(s * 0.74, -0.15, 0.58);
      front.rotation.y = s * 0.26;
      front.rotation.z = s * -0.10;
      this.group.add(front);
      this.flippers.push({ mesh: front, side: s, front: true });

      // 前縁の爪(アオウミガメは前肢に1本)
      const claw = new THREE.Mesh(new THREE.ConeGeometry(0.017, 0.062, 6), clawMat);
      claw.position.set(s * 0.46, 0.035, 0.262);
      claw.rotation.set(-0.5, 0, s * -Math.PI * 0.46);
      front.add(claw);

      const hip = new THREE.Mesh(hipGeo, skin);
      hip.position.set(s * 0.46, -0.185, -1.04);
      this.group.add(hip);

      // 後肢は舵なので、甲羅の後ろへ斜め後方に張り出す
      // (前向きに付けると甲羅の下に隠れて見えなくなる)
      const rear = new THREE.Mesh(rearGeo[s], skin);
      rear.position.set(s * 0.50, -0.23, -1.12);
      rear.rotation.y = s * 0.92;
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
    this.body = 1.5;             // 当たり判定の半径(甲羅+ひれ)
    this.world = null;
  }

  setWorld(world) { this.world = world; }

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

    // ---- 障害物の回避 ----
    if (this.world) {
      _vel.set(Math.sin(this.heading) * this.speed, 0, Math.cos(this.heading) * this.speed);
      this.world.avoidForce(this.pos, _vel, this.body, 2.4, _av, this);
      const lateral = _av.x * Math.cos(this.heading) - _av.z * Math.sin(this.heading);
      turn += THREE.MathUtils.clamp(lateral * 1.8, -0.9, 0.9);
      targetY += _av.y * 2.2;
    }
    this.heading += THREE.MathUtils.clamp(turn, -0.9, 0.9) * dt;

    // 進行方向の地形を先読みして海底の上を越える
    const ahead = this.world
      ? this.world.terrainAhead(this.pos, Math.sin(this.heading), Math.cos(this.heading), this.body + this.speed * 2.0)
      : -Infinity;
    targetY = Math.max(targetY, Math.max(sandHeight(this.pos.x, this.pos.z), ahead) + this.body + 0.4);

    const speedTarget = this.state === 'breathe' ? 0.25 : 0.9 + this.flapPower * 0.7;
    this.speed += (speedTarget - this.speed) * (1 - Math.exp(-1.2 * dt));
    this.pos.y += (targetY - this.pos.y) * (1 - Math.exp(-(this.state === 'cruise' ? 0.5 : 0.8) * dt));
    this.pos.x += Math.sin(this.heading) * this.speed * dt;
    this.pos.z += Math.cos(this.heading) * this.speed * dt;

    // ---- めり込みの解消 ----
    if (this.world) this.world.pushOut(this.pos, this.body, null, this);
    clampToTerrain(this.pos, this.body * 0.6 + 0.3);

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
        f.mesh.rotation.z = f.side * (-0.10 + stroke * 0.55);
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
