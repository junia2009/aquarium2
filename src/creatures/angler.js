import * as THREE from 'three';
import { baseUniforms } from '../env.js';
import { UW_FRAG_PRELUDE, UW_FRAG_OUTPUT } from '../glsl.js';
import { wander1 } from '../noise.js';

// ============ ミツクリエナガチョウチンアンコウ ============
// Melanocetus johnsonii。いわゆる「ブラックシードビル」。
// ここに出すのはメスで、全長18cm前後(オスは3cmに満たない)。
//
// この魚のかたちは全部「待ち伏せ」のためにある。
//   ・泳がない。ほとんど動かずに浮いている(筋肉も骨も貧弱)
//   ・餌は滅多に来ないので、来たときに逃さないよう口と胃が極端に大きい
//   ・自分と同じ大きさの獲物も飲めるよう、下顎が大きく開いて腹が伸びる
//   ・獲物は自分から近寄ってくる。背びれの第一棘が変形した誘引突起(イリシウム)の
//     先端(エスカ)に発光バクテリアを飼い、その光で呼ぶ
//
// --- かたちの作り方 ---
// この魚でいちばん大事なのは口である。ここを「腹に開いた穴」にすると、
// 歯が腹の縁に沿って並び、まったく別の生き物になってしまう。
// 実物の口は頭の前端にある斜めの裂け目で、
//   ・口角(顎の蝶番)は頭のうしろ、体高のいちばん低いあたり
//   ・そこから前上がりに走り、吻端では体の中心より上に出る
// この「口線」を先に高さの関数として決め、断面のどこで上顎と下顎が
// 分かれるかを口線から逆算する。歯はその線に沿って並ぶ。

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

// 体長1.0(吻端→尾柄)を基準にした寸法プロファイル
// t = 0 が尾柄、t = 1 が吻端
const HP = [0.045, 0.068, 0.105, 0.165, 0.240, 0.278, 0.296, 0.305, 0.298, 0.262, 0.172];
const WP = [0.034, 0.050, 0.078, 0.120, 0.170, 0.198, 0.214, 0.222, 0.218, 0.192, 0.118];
// 体軸の上下オフセット。腹側がふくらんだ「胃袋」の形になる
const YP = [0.000, -0.002, -0.008, -0.018, -0.032, -0.040, -0.038, -0.030, -0.018, -0.006, 0.000];

const T_CORNER = 0.52;      // 口角(ここより前が開く)
const MOUTH_FRONT_Y = 0.055; // 吻端での口線の高さ(体の中心より上)

const tbl = (a, t) => {
  const s = THREE.MathUtils.clamp(t, 0, 1) * (a.length - 1);
  const i = Math.min(Math.floor(s), a.length - 2);
  const f = s - i;
  return a[i] * (1 - f) + a[i + 1] * f;
};
const hhAt = (t) => tbl(HP, t);
const wwAt = (t) => tbl(WP, t);
const yoAt = (t) => tbl(YP, t);

// 口線の高さ。口角では腹のいちばん下に接し、前へ行くほど持ち上がる。
// この一本の線が「上顎と下顎の境目」であり、歯の並ぶ線でもある。
const MOUTH_BASE = yoAt(T_CORNER) - hhAt(T_CORNER);
const MOUTH_RISE = MOUTH_FRONT_Y - MOUTH_BASE;
function mouthY(t) {
  if (t <= T_CORNER) return yoAt(t) - hhAt(t);
  const u = (t - T_CORNER) / (1 - T_CORNER);
  return MOUTH_BASE + MOUTH_RISE * Math.pow(u, 0.72);
}

// 断面のどの角度で上顎と下顎が分かれるか。口線の高さから逆算する。
// a = 0 が腹、a = π が背。y(a) = yo - cos(a) * hh なので、
// y = 口線 となる角は acos((yo - 口線) / hh)。
function aSplit(t) {
  if (t <= T_CORNER) return 0;
  const c = THREE.MathUtils.clamp((yoAt(t) - mouthY(t)) / hhAt(t), -1, 1);
  return Math.acos(c);
}

// 断面上の点。a = 0 が腹、a = π が背
function ringPoint(t, a, shrink = 1) {
  const hh = hhAt(t) * shrink, ww = wwAt(t) * shrink;
  return [Math.sin(a) * ww, yoAt(t) - Math.cos(a) * hh, t - 0.5];
}

// 吻端の丸み。ここで断面を一点に絞ることで、上顎と下顎が前で出会う。
// これがないと頭の前が開いたままの筒になり、正面から口の中が丸見えになる。
// (口はここから口角までの「合わせ目」であって、頭の前端の穴ではない)
const NOSE_LEN = 0.055;   // 吻端の張り出し
const NOSE_U = 0.10;      // 行パラメータ上での長さ

// 行パラメータ u(0=尾柄, 1=吻端, それ以降は吻先の丸み)から断面上の点を返す
function ringU(u, a, shrink = 1) {
  if (u <= 1) return ringPoint(u, a, shrink);
  const th = Math.min((u - 1) / NOSE_U, 1) * (Math.PI / 2);
  const k = Math.cos(th) * shrink;
  const hh = hhAt(1) * k, ww = wwAt(1) * k;
  return [Math.sin(a) * ww, yoAt(1) - Math.cos(a) * hh, 0.5 + NOSE_LEN * Math.sin(th)];
}
const U_END = 1 + NOSE_U;

// リング列から帯状のメッシュを張る共通処理
function loft(rings, seg, pointAt, origin = [0, 0, 0]) {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= rings; i++) {
    for (let j = 0; j <= seg; j++) {
      const p = pointAt(i / rings, j / seg);
      pos.push(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]);
      uv.push(j / seg, i / rings);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j, b = a + 1;
      const c = (i + 1) * (seg + 1) + j, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

// ---- 体(上顎を含む)----
// 口線より上だけを張る。口の開いた分だけ腹側が欠け、内側が口腔として見える。
function buildBody() {
  return loft(38, 30, (row, s) => {
    const u = row * U_END;
    const g = aSplit(Math.min(u, 1));
    return ringU(u, g + s * (Math.PI * 2 - g * 2));
  });
}

// ---- 下顎 ----
// 口角を軸に回る。回転0で体の欠けた部分をちょうど埋める。
const HINGE = ringPoint(T_CORNER, 0);

function buildLowerJaw() {
  return loft(22, 26, (row, s) => {
    const u = T_CORNER + row * (U_END - T_CORNER);
    const g = aSplit(Math.min(u, 1));
    // 顎は薄い。ごくわずかに内側へ寄せて、閉じたとき上顎の内に収まる
    return ringU(u, -g + s * g * 2, 0.99);
  }, HINGE);
}

// ---- 尾びれ ----
// 縦に開く扇。水平にすると鯨類のフリュークになってしまう
function buildCaudal(len, halfH) {
  return loft(5, 14, (t, s) => {
    const a = (s - 0.5) * Math.PI * 1.05;
    const r = Math.pow(t, 0.8) * len;
    return [Math.sin(a) * r * 0.10, Math.sin(a) * r * (halfH / len), -Math.cos(a) * r];
  });
}

// ---- 歯 ----
// 口線に沿って並び、上顎の歯は下へ、下顎の歯は上へ、
// どちらもわずかに喉の側へ倒れて生える。入った獲物は戻れない。
function buildTeeth(onJaw) {
  const SIDES = 6;
  const pos = [], uv = [], idx = [];
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();
  const base = new THREE.Vector3(), dir = new THREE.Vector3(), tmp = new THREE.Vector3();

  const addTooth = (b, d, len, rad) => {
    base.copy(b); dir.copy(d).normalize();
    q.setFromUnitVectors(up, dir);
    const start = pos.length / 3;
    for (let k = 0; k < SIDES; k++) {
      const a = (k / SIDES) * Math.PI * 2;
      tmp.set(Math.cos(a) * rad, 0, Math.sin(a) * rad).applyQuaternion(q).add(base);
      pos.push(tmp.x, tmp.y, tmp.z);
      uv.push(k / SIDES, 0);
    }
    // 途中で少し細くなってから尖る(円錐一本だと画鋲に見える)
    for (let k = 0; k < SIDES; k++) {
      const a = (k / SIDES) * Math.PI * 2;
      tmp.set(Math.cos(a) * rad * 0.45, len * 0.55, Math.sin(a) * rad * 0.45)
        .applyQuaternion(q).add(base);
      pos.push(tmp.x, tmp.y, tmp.z);
      uv.push(k / SIDES, 0.55);
    }
    tmp.copy(dir).multiplyScalar(len).add(base);
    pos.push(tmp.x, tmp.y, tmp.z);
    uv.push(0.5, 1);
    const tip = start + SIDES * 2;
    for (let k = 0; k < SIDES; k++) {
      const n = (k + 1) % SIDES;
      idx.push(start + k, start + n, start + SIDES + k);
      idx.push(start + n, start + SIDES + n, start + SIDES + k);
      idx.push(start + SIDES + k, start + SIDES + n, tip);
    }
  };

  const N = 11;
  const T0 = T_CORNER + 0.07, T1 = 0.975;
  const P = new THREE.Vector3(), C = new THREE.Vector3(), D = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const f = i / (N - 1);
    const t = T0 + f * (T1 - T0);
    const g = aSplit(t);
    // 前ほど長い牙。下顎のほうが大きい
    // 実物の牙は長さがそろっていない。等間隔・等長にすると櫛になる
    const jitter = 0.72 + 0.55 * Math.abs(Math.sin(i * 12.9898 + (onJaw ? 4.1 : 1.7)) * 43758.5453 % 1);
    const len = (0.026 + 0.070 * Math.pow(f, 0.85)) * jitter * (onJaw ? 1.0 : 0.84);
    const rad = len * 0.115;
    for (const sgn of [-1, 1]) {
      const p = ringPoint(t, sgn * g, onJaw ? 0.985 : 0.995);
      P.set(p[0], p[1], p[2]);
      // 断面の腹の中心。上顎の歯はここへ向かって垂れる
      const c0 = ringPoint(t, 0);
      C.set(c0[0], c0[1], c0[2]);
      D.subVectors(C, P).normalize();
      // 下顎の歯は同じだけ上向きに立てる
      if (onJaw) D.y = -D.y;
      D.z -= 0.34;                      // 喉の側へ倒す
      // 歯根が皮膚に埋まらないよう、生える位置をわずかに口の内側へ寄せる
      P.addScaledVector(D, 0.006);
      if (onJaw) P.sub(_v.set(HINGE[0], HINGE[1], HINGE[2]));
      addTooth(P, D, len, rad);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

// ---- ひれ ----
// 泳ぐためではなく姿勢を保つためのもの。小さくて丸い。
function buildFan(len, wide, spread) {
  return loft(5, 14, (t, s) => {
    const a = (s - 0.5) * Math.PI * spread;
    const r = Math.pow(t, 0.85) * len;
    return [Math.sin(a) * r * (wide / len), -Math.cos(a) * r, -Math.abs(Math.cos(a)) * r * 0.12];
  });
}

// 背びれ・臀びれ。体の後方に低く張り出す一枚の膜
function buildRidgeFin(t0, t1, height, sign) {
  return loft(12, 5, (u, v) => {
    const t = t0 + u * (t1 - t0);
    const base = yoAt(t) + sign * hhAt(t);
    const h = Math.sin(Math.PI * Math.pow(u, 0.8)) * height;
    return [0, base + sign * h * v, t - 0.5];
  });
}

// ---- 誘引突起(イリシウム)----
// 背びれの第一棘が変形したもの。吻の上から前へ伸び、
// 先端のエスカ(擬餌)が発光する。長さは体長の3分の1ほど。
const ILL_BASE = [0, 0, 0];
function buildIllicium() {
  const P0 = new THREE.Vector3(0, hhAt(0.94) + yoAt(0.94) - 0.02, 0.44);
  const P1 = new THREE.Vector3(0, 0.40, 0.50);
  const P2 = new THREE.Vector3(0, 0.34, 0.68);
  const at = (t) => {
    const m = 1 - t;
    return new THREE.Vector3(
      0,
      m * m * P0.y + 2 * m * t * P1.y + t * t * P2.y,
      m * m * P0.z + 2 * m * t * P1.z + t * t * P2.z
    );
  };
  const geo = loft(20, 8, (t, s) => {
    const c = at(t);
    const r = 0.022 * (1 - t * 0.40);
    const a = s * Math.PI * 2;
    return [Math.sin(a) * r, c.y + Math.cos(a) * r * 0.75, c.z + Math.cos(a) * r * 0.65];
  });
  geo.userData.tip = at(1);
  return geo;
}

// ============ シェーダ ============

const ANG_COMMON = /* glsl */ `
uniform float uSeed;
`;
const ANG_VTIME = /* glsl */ `uniform float uTime;
uniform float uSway;
`;

// 体は前後にゆっくりくねる。泳ぐというより、その場で漂って向きを直す動き
const BODY_SWAY = /* glsl */ `
vec3 swayed(vec3 p) {
  float f = (p.z + 0.5);
  p.x += sin(uTime * 0.8 + uSeed - f * 2.2) * 0.035 * f * f * uSway;
  p.y += sin(uTime * 0.6 + uSeed * 2.0 - f * 1.6) * 0.018 * f * uSway;
  return p;
}
`;

const BODY_VERT = ANG_VTIME + ANG_COMMON + BODY_SWAY + /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec4 wp = modelMatrix * vec4(swayed(position), 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SKIN_FRAG = UW_FRAG_PRELUDE + ANG_COMMON + /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  bool inside = !gl_FrontFacing;
  if (inside) n = -n;
  vec3 V = normalize(cameraPosition - vWorldPos);

  // 真っ黒に近い、光を吸う皮膚。ライトを当てても炭のようにしか返さない
  // (深海の黒い魚の皮膚は入射光の99.5%を吸収する)
  vec3 albedo = vec3(0.030, 0.026, 0.028);
  // 皮膚に散る小さな棘の粒
  float bump = fbm(vUv * vec2(26.0, 14.0) + uSeed);
  albedo *= 0.75 + 0.55 * bump;
  // 口の中だけは肉の色。開いたときにここが見える
  // 口の中は赤紫ではなく、くすんだ赤茶。奥(喉)へ行くほど暗い
  if (inside) albedo = vec3(0.032, 0.013, 0.011)
    * (0.6 + 0.5 * bump) * (0.45 + 0.55 * smoothstep(0.55, 0.95, vUv.y));

  vec3 col = underwaterLight(albedo, n, vWorldPos, V, 34.0, inside ? 0.02 : 0.06);
  if (inside) {
    // 口の中はライトに背を向けた面ばかりになる。素直に計算すると真っ黒で、
    // 「開いた口」ではなく「体に空いた穴」に見えてしまう。
    // 実際には粘膜が薄く、まわりの肉を透かしてぼんやり赤く照り返す
    col += lampArrive(vWorldPos) * vec3(0.018, 0.0050, 0.0055) * (0.55 + 0.45 * bump);
  }
  col = applyUnderwaterFog(col, vWorldPos);
  gl_FragColor = vec4(col, 1.0);
  ${UW_FRAG_OUTPUT}
}
`;

// 顎と歯は体と別のモデル行列(下顎グループ)で動くので、揺れは入れない
const RIGID_VERT = ANG_COMMON + /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const TOOTH_FRAG = UW_FRAG_PRELUDE + ANG_COMMON + /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 V = normalize(cameraPosition - vWorldPos);
  // 半透明のガラス質。根元は歯肉に埋もれて濁る
  vec3 albedo = mix(vec3(0.22, 0.16, 0.15), vec3(0.72, 0.70, 0.66), vUv.y);
  vec3 col = underwaterLight(albedo, n, vWorldPos, V, 60.0, 0.55);
  col = applyUnderwaterFog(col, vWorldPos);
  gl_FragColor = vec4(col, 1.0);
  ${UW_FRAG_OUTPUT}
}
`;

const FIN_FRAG = UW_FRAG_PRELUDE + ANG_COMMON + /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 albedo = vec3(0.030, 0.025, 0.027);
  vec3 col = underwaterLight(albedo, n, vWorldPos, V, 26.0, 0.02) * 0.55;
  col = applyUnderwaterFog(col, vWorldPos);
  // 鰭条(すじ)が透けて見える
  float ray = smoothstep(0.60, 0.98, abs(sin(vUv.x * 24.0)));
  col *= 1.0 + ray * 0.30 * vUv.y;
  gl_FragColor = vec4(col, 0.60 + 0.30 * (1.0 - vUv.y));
  ${UW_FRAG_OUTPUT}
}
`;

// イリシウムは根元で振られる。先端ほど遅れて大きく振れる
const ILL_VERT = ANG_VTIME + ANG_COMMON + /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec3 p = position;
  float t = uv.y;
  p.x += sin(uTime * 1.1 + uSeed * 3.0) * 0.10 * t * t;
  p.y += sin(uTime * 0.9 + uSeed * 5.0 + 1.0) * 0.05 * t * t;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const ILL_FRAG = UW_FRAG_PRELUDE + ANG_COMMON + /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 albedo = vec3(0.055, 0.048, 0.048);
  vec3 col = underwaterLight(albedo, n, vWorldPos, V, 22.0, 0.14);
  col = applyUnderwaterFog(col, vWorldPos);
  gl_FragColor = vec4(col, 1.0);
  ${UW_FRAG_OUTPUT}
}
`;

// エスカ(擬餌)。中で発光バクテリアが光る。
// これだけは周囲光もライトも要らない — 自分で光っている
const ESCA_FRAG = UW_FRAG_PRELUDE + /* glsl */ `
uniform float uGlow;   // uTime は UW_FRAG_PRELUDE 側で宣言済み
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);
  // 発光は一定ではなく、ゆっくり明滅する(バクテリアの光は脈打つ)
  float pulse = 0.72 + 0.28 * sin(uTime * 1.6) * sin(uTime * 0.7 + 1.3);
  float rim = pow(1.0 - abs(dot(n, V)), 1.6);
  vec3 emit = vec3(0.42, 0.90, 1.0) * (0.55 + 0.75 * rim) * pulse * uGlow;
  vec3 col = applyUnderwaterFog(emit * 1.35, vWorldPos);
  gl_FragColor = vec4(col, 1.0);
  ${UW_FRAG_OUTPUT}
}
`;

// エスカのまわりのにじみ。ビルボードの板に描く
const HALO_FRAG = /* glsl */ `
uniform float uTime;
uniform float uGlow;
varying vec2 vUv;
void main() {
  vec2 c = vUv - 0.5;
  float d = length(c) * 2.0;
  if (d > 1.0) discard;
  float pulse = 0.72 + 0.28 * sin(uTime * 1.6) * sin(uTime * 0.7 + 1.3);
  float a = pow(1.0 - d, 3.0) * 0.55 * pulse * uGlow;
  gl_FragColor = vec4(vec3(0.36, 0.86, 1.0) * a, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const HALO_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  // ビルボード: ビュー空間で常にカメラを向く
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy;
  gl_Position = projectionMatrix * mv;
}
`;

// ============ 個体 ============

export class Anglerfish {
  /**
   * @param scene
   * @param opts.home  待ち伏せの定位置
   * @param opts.length 全長(m)。実物のメスは18cm前後
   * @param opts.prey  誘い寄せる群れ(School)。null可
   */
  constructor(scene, { home = new THREE.Vector3(0, 8, 0), length = 0.19, prey = null } = {}) {
    this.home = home.clone();
    this.prey = prey;
    this.len = length;
    this.time = 0;
    this.seed = Math.random() * 10;

    this.group = new THREE.Group();
    this.group.position.copy(home);
    this.group.scale.setScalar(length);
    scene.add(this.group);

    const u = () => ({
      ...baseUniforms(),
      uSeed: { value: this.seed },
      uSway: { value: 1 },
    });
    this.us = [];
    const mat = (vert, frag, opts = {}) => {
      const uni = u();
      this.us.push(uni);
      return new THREE.ShaderMaterial({
        uniforms: uni, vertexShader: vert, fragmentShader: frag,
        side: THREE.DoubleSide, ...opts,
      });
    };

    // 体(上顎込み)。内側が口腔として見えるので両面
    this.group.add(new THREE.Mesh(buildBody(), mat(BODY_VERT, SKIN_FRAG)));
    this.group.add(new THREE.Mesh(buildTeeth(false), mat(BODY_VERT, TOOTH_FRAG)));

    // 下顎。口角を軸に回る
    this.jaw = new THREE.Group();
    this.jaw.position.set(HINGE[0], HINGE[1], HINGE[2]);
    this.jaw.add(new THREE.Mesh(buildLowerJaw(), mat(RIGID_VERT, SKIN_FRAG)));
    this.jaw.add(new THREE.Mesh(buildTeeth(true), mat(RIGID_VERT, TOOTH_FRAG)));
    this.group.add(this.jaw);

    // ひれ。泳ぐためではなく、姿勢を保つためだけのもの
    const finMat = () => mat(BODY_VERT, FIN_FRAG, { transparent: true, depthWrite: false });
    const pecGeo = buildFan(0.135, 0.125, 1.05);
    for (const s of [-1, 1]) {
      const f = new THREE.Mesh(pecGeo, finMat());
      const p = ringPoint(0.42, s * Math.PI * 0.42);
      f.position.set(p[0], p[1], p[2]);
      f.rotation.z = s * -1.55;
      f.rotation.y = s * 0.45;
      this.group.add(f);
    }
    // 尾びれは短い尾柄のうしろに縦に開く
    const caudal = new THREE.Mesh(buildCaudal(0.19, 0.155), finMat());
    caudal.position.set(0, yoAt(0), -0.50);
    this.group.add(caudal);
    // 背びれ・臀びれは体のうしろ寄りに低く張り出す
    this.group.add(new THREE.Mesh(buildRidgeFin(0.10, 0.30, 0.085, 1), finMat()));
    this.group.add(new THREE.Mesh(buildRidgeFin(0.09, 0.27, 0.070, -1), finMat()));

    // 眼。この仲間の眼は驚くほど小さい。獲物を光で呼ぶ側なので、
    // 遠くを見る必要がない。位置は上顎のうしろ、頭の上寄り
    const eyeGeo = new THREE.SphereGeometry(0.019, 10, 8);
    const eyeMat = new THREE.MeshBasicMaterial({ color: '#0a0c10' });
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(eyeGeo, eyeMat);
      const p = ringPoint(0.855, s * Math.PI * 0.62, 0.99);
      e.position.set(p[0], p[1], p[2]);
      this.group.add(e);
    }

    // イリシウムとエスカ
    const illGeo = buildIllicium();
    this.group.add(new THREE.Mesh(illGeo, mat(ILL_VERT, ILL_FRAG)));

    this.escaU = { ...baseUniforms(), uGlow: { value: 1 } };
    const escaGeo = new THREE.SphereGeometry(0.042, 14, 10);
    // エスカは丸い球ではなく、短い房が生えた瘤。輪郭でそれと分かる
    const ep = escaGeo.attributes.position;
    for (let i = 0; i < ep.count; i++) {
      const x = ep.getX(i), y = ep.getY(i), z = ep.getZ(i);
      const k = 1 + 0.22 * Math.sin(x * 90) * Math.sin(y * 74) * Math.sin(z * 61);
      ep.setXYZ(i, x * k, y * k, z * k);
    }
    escaGeo.computeVertexNormals();
    this.esca = new THREE.Mesh(escaGeo, new THREE.ShaderMaterial({
      uniforms: this.escaU, vertexShader: RIGID_VERT, fragmentShader: ESCA_FRAG,
    }));
    this.esca.position.copy(illGeo.userData.tip);
    this.group.add(this.esca);

    const halo = new THREE.Mesh(
      new THREE.PlaneGeometry(0.34, 0.34),
      new THREE.ShaderMaterial({
        uniforms: this.escaU, vertexShader: HALO_VERT, fragmentShader: HALO_FRAG,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      })
    );
    halo.renderOrder = 40;
    this.esca.add(halo);

    // 捕食の状態機械
    this.state = 'wait';   // wait → strike → swallow
    this.phase = 0;
    this.cool = 3;
    // 下顎の開き(0=閉じる 1=限界まで)。待っている間もこの魚は口を
    // 半分開けたままにしている。牙が噛み合ってしまうので閉じきれない
    this.gape = 0.22;
    this.heading = Math.random() * Math.PI * 2;
  }

  /** 図鑑の追跡点。エスカではなく体を見せたいので体の中心 */
  get pos() {
    return this.group.position;
  }

  /** エスカのワールド座標 */
  escaWorld(out = _w) {
    return out.copy(this.esca.position).multiplyScalar(this.len)
      .applyAxisAngle(_v.set(0, 1, 0), this.group.rotation.y)
      .add(this.group.position);
  }

  update(dt, camera) {
    this.time += dt;
    const t = this.time;
    for (const u of this.us) u.uSway.value = this.state === 'strike' ? 0.25 : 1;

    // ---- 定位置でのホバリング ----
    // ほとんど泳がない。浮力でわずかに漂い、ゆっくり向きを変えるだけ
    const p = this.group.position;
    p.x = this.home.x + wander1(t * 0.05, this.seed) * 0.9;
    p.y = this.home.y + wander1(t * 0.045 + 20, this.seed) * 0.55;
    p.z = this.home.z + wander1(t * 0.05 + 40, this.seed) * 0.9;
    this.heading += wander1(t * 0.03 + 70, this.seed) * 0.35 * dt;
    this.group.rotation.y = this.heading;
    this.group.rotation.z = Math.sin(t * 0.5 + this.seed) * 0.05;

    // ---- 誘引 ----
    // 光は毎フレーム置き直す。獲物は自分から寄ってくる
    const esca = this.escaWorld();
    if (this.prey && this.state === 'wait') this.prey.lure(esca, 5.0, 1.4);

    // ---- 捕食 ----
    this.cool -= dt;
    if (this.state === 'wait') {
      if (this.cool <= 0 && this.prey && this.nearestPrey(esca) < 0.26) {
        this.state = 'strike';
        this.phase = 0;
      }
      // 待っている間はわずかに口を開けている
      this.gape += (0.22 - this.gape) * (1 - Math.exp(-3 * dt));
    } else if (this.state === 'strike') {
      // 大口を開けて吸い込み、閉じる。実物では6ミリ秒で終わる動作なので、
      // 見えるぎりぎりまで速くする
      this.phase += dt;
      const open = 0.16, shut = 0.09;
      if (this.phase < open) {
        this.gape = THREE.MathUtils.lerp(0.22, 1.0, this.phase / open);
      } else if (this.phase < open + shut) {
        this.gape = THREE.MathUtils.lerp(1.0, 0.02, (this.phase - open) / shut);
      } else {
        // 逃げ遅れなかった魚は爆発的に散る
        if (this.prey) this.prey.scare(esca, 1.8, 20);
        this.state = 'wait';
        this.cool = 9 + Math.random() * 7;
      }
    }
    // 下顎の回転。0.06→ほぼ閉じ、1.0→限界まで開く
    // 限界まで開くと60度。これ以上落とすと下顎が頭から切り離されて見える
    this.jaw.rotation.x = this.gape * 1.05;
    // 開くほどエスカを暗くする(光っていては獲物が逃げる)
    this.escaU.uGlow.value = 1 - THREE.MathUtils.smoothstep(this.gape, 0.35, 0.85) * 0.75;
  }

  nearestPrey(point) {
    let best = Infinity;
    for (const q of this.prey.pos) {
      const d = q.distanceToSquared(point);
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  /** タップされたら襲いかかる(観客向けの近道) */
  provoke() {
    if (this.state === 'wait') {
      this.state = 'strike';
      this.phase = 0;
      this.cool = 9;
      return true;
    }
    return false;
  }
}
