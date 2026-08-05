import * as THREE from 'three';
import { baseUniforms } from '../env.js';
import { UW_FRAG_PRELUDE, UW_FRAG_OUTPUT } from '../glsl.js';
import { wander1 } from '../noise.js';

// ============ チョウチンアンコウ ============
// Himantolophus groenlandicus。ここに出すのはメスで、全長は50cm前後。
// (オスは10分の1以下の大きさで、メスに噛みついて融合してしまう)
//
// この魚のかたちは全部「待ち伏せ」のためにある。
//   ・泳がない。ほとんど動かずに浮いている(筋肉も骨も貧弱)
//   ・餌は滅多に来ないので、来たときに逃さないよう口と胃が極端に大きい
//   ・自分より大きい獲物も飲めるよう、下顎が大きく開き、歯は内向きに生える
//   ・獲物は自分から近寄ってくる。背びれの第一棘が変形した誘引突起(イリシウム)の
//     先端(エスカ)に発光バクテリアを飼い、その光で呼ぶ
// 実装でもこの順に作る。

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

// 体長1.0(吻端→尾柄)を基準にした寸法
const HH = 0.33;          // 体高の半分
const WW = 0.29;          // 体幅の半分
const T_GAPE = 0.60;      // 口角の位置(ここより前が開く)
const GAPE_MAX = 0.42;    // 吻端での開口の半角(π単位)

// 体の太さプロファイル。丸く膨れた頭 → 急に細くなる尾
const R_TABLE = [0.17, 0.22, 0.32, 0.47, 0.65, 0.82, 0.95, 1.00, 0.98, 0.90, 0.60];
const rAt = (t) => {
  const s = THREE.MathUtils.clamp(t, 0, 1) * (R_TABLE.length - 1);
  const i = Math.min(Math.floor(s), R_TABLE.length - 2);
  const f = s - i;
  return R_TABLE[i] * (1 - f) + R_TABLE[i + 1] * f;
};

// 口の開き。口角(T_GAPE)からゼロで始まり、吻端で最大になる
function gapeHalf(t) {
  const s = THREE.MathUtils.smoothstep(t, T_GAPE, 1.0);
  return s * GAPE_MAX * Math.PI;
}

// 断面上の点。a=0 が腹、a=π が背
function ringPoint(t, a, shrink = 1) {
  const r = rAt(t) * shrink;
  return [Math.sin(a) * r * WW, -Math.cos(a) * r * HH, t - 0.5];
}

// ---- 体(上顎を含む殻)----
// 口の開いた分だけ腹側を欠いた、開いた殻。内側は口腔として見える。
function buildBody() {
  const RINGS = 26, SEG = 28;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= RINGS; i++) {
    const t = i / RINGS;
    const g = gapeHalf(t);
    for (let j = 0; j <= SEG; j++) {
      const s = j / SEG;
      const a = g + s * (Math.PI * 2 - g * 2);
      const p = ringPoint(t, a);
      pos.push(p[0], p[1], p[2]);
      uv.push(s, t);
    }
  }
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEG; j++) {
      const a = i * (SEG + 1) + j, b = a + 1;
      const c = (i + 1) * (SEG + 1) + j, d = c + 1;
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

// ---- 下顎 ----
// 口角を軸に回る。閉じた状態(回転0)で体の欠けた部分をちょうど埋める。
const HINGE = ringPoint(T_GAPE, 0);   // 口角の位置(体のローカル座標)

function buildLowerJaw() {
  const RINGS = 14, SEG = 20;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= RINGS; i++) {
    const t = T_GAPE + (i / RINGS) * (1 - T_GAPE);
    const g = gapeHalf(t);
    for (let j = 0; j <= SEG; j++) {
      const s = j / SEG;
      // 腹側の弧。中心(a=0)から左右へ口角まで
      const a = -g + s * g * 2;
      // 顎そのものは薄い。奥ほど内側へ寄せて、閉じたとき上顎の内に収まる
      const p = ringPoint(t, a, 0.985);
      pos.push(p[0] - HINGE[0], p[1] - HINGE[1], p[2] - HINGE[2]);
      uv.push(s, i / RINGS);
    }
  }
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEG; j++) {
      const a = i * (SEG + 1) + j, b = a + 1;
      const c = (i + 1) * (SEG + 1) + j, d = c + 1;
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

// ---- 歯 ----
// 顎の縁に沿って並ぶ、内へ倒れた針。獲物は入れても出られない。
// 円錐を1つのジオメトリにまとめて焼き込む(本数が多いので個別メッシュにしない)
function buildTeeth(onJaw) {
  const SIDES = 5;
  const pos = [], uv = [], idx = [];
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();
  const base = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  const addTooth = (bx, by, bz, dx, dy, dz, len, rad) => {
    base.set(bx, by, bz);
    dir.set(dx, dy, dz).normalize();
    q.setFromUnitVectors(up, dir);
    const start = pos.length / 3;
    for (let k = 0; k < SIDES; k++) {
      const a = (k / SIDES) * Math.PI * 2;
      tmp.set(Math.cos(a) * rad, 0, Math.sin(a) * rad).applyQuaternion(q).add(base);
      pos.push(tmp.x, tmp.y, tmp.z);
      uv.push(k / SIDES, 0);
    }
    // 先端。少し湾曲させる(まっすぐだと画鋲に見える)
    tmp.copy(dir).multiplyScalar(len).add(base);
    pos.push(tmp.x, tmp.y, tmp.z);
    uv.push(0.5, 1);
    const tip = start + SIDES;
    for (let k = 0; k < SIDES; k++) {
      idx.push(start + k, start + ((k + 1) % SIDES), tip);
    }
  };

  const N = 11;
  for (let i = 0; i < N; i++) {
    // 吻端寄りほど長い歯が並ぶ
    const f = i / (N - 1);
    const t = T_GAPE + 0.06 + f * (0.955 - T_GAPE - 0.06);
    const g = gapeHalf(t);
    const len = (0.055 + 0.075 * Math.pow(f, 1.2)) * (onJaw ? 0.85 : 1.0);
    const rad = len * 0.13;
    for (const sgn of [-1, 1]) {
      const a = sgn * g * (onJaw ? 0.86 : 0.90);
      const p = ringPoint(t, a, onJaw ? 0.93 : 0.96);
      // 歯は口の内側=軸へ向き、わずかに後方(喉の側)へ倒れる
      const inward = _v.set(-p[0], onJaw ? 1 : -1, 0).normalize();
      const bx = onJaw ? p[0] - HINGE[0] : p[0];
      const by = onJaw ? p[1] - HINGE[1] : p[1];
      const bz = onJaw ? p[2] - HINGE[2] : p[2];
      addTooth(bx, by, bz, inward.x * 0.85, inward.y, -0.30, len, rad);
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
// 泳ぐためではなく、姿勢を保つためのもの。小さくて丸い。
function buildFin(len, wide, droop) {
  const SEG = 12, RAD = 5;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= RAD; i++) {
    const t = i / RAD;
    for (let j = 0; j <= SEG; j++) {
      const s = j / SEG;
      const a = (s - 0.5) * Math.PI * 1.1;
      const r = t * len;
      pos.push(Math.sin(a) * r * (wide / len), -Math.cos(a) * r * droop, -Math.abs(Math.cos(a)) * r * 0.15);
      uv.push(s, t);
    }
  }
  for (let i = 0; i < RAD; i++) {
    for (let j = 0; j < SEG; j++) {
      const a = i * (SEG + 1) + j, b = a + 1;
      const c = (i + 1) * (SEG + 1) + j, d = c + 1;
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

// ---- 誘引突起(イリシウム)----
// 背びれの第一棘が変形したもの。頭の上から前へ長く伸び、
// 先端のエスカ(擬餌)が発光する。
function buildIllicium() {
  const SEG = 24, SIDE = 6;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    // 頭の上から立ち上がり、前方へ弓なりに垂れる
    const cy = 0.26 + Math.sin(t * 1.15) * 0.26;
    const cz = 0.40 + t * 0.34 - Math.pow(t, 2.4) * 0.10;
    const r = 0.030 * (1 - t * 0.45);
    for (let j = 0; j <= SIDE; j++) {
      const a = (j / SIDE) * Math.PI * 2;
      pos.push(Math.sin(a) * r, cy + Math.cos(a) * r * 0.6, cz + Math.cos(a) * r * 0.8);
      uv.push(j / SIDE, t);
    }
  }
  for (let i = 0; i < SEG; i++) {
    for (let j = 0; j < SIDE; j++) {
      const a = i * (SIDE + 1) + j, b = a + 1;
      const c = (i + 1) * (SIDE + 1) + j, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  // エスカの付く位置(先端)を持ち回る
  geo.userData.tip = new THREE.Vector3(
    0, 0.26 + Math.sin(1.15) * 0.26, 0.40 + 0.34 - 0.10
  );
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
  if (inside) albedo = vec3(0.070, 0.026, 0.026) * (0.6 + 0.5 * bump);

  vec3 col = underwaterLight(albedo, n, vWorldPos, V, 34.0, inside ? 0.02 : 0.06);
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
  vec3 albedo = vec3(0.032, 0.027, 0.029);
  vec3 col = underwaterLight(albedo, n, vWorldPos, V, 26.0, 0.05);
  col = applyUnderwaterFog(col, vWorldPos);
  // 鰭条(すじ)が透けて見える
  float ray = smoothstep(0.60, 0.98, abs(sin(vUv.x * 24.0)));
  col *= 1.0 + ray * 0.30 * vUv.y;
  gl_FragColor = vec4(col, 0.62 + 0.34 * (1.0 - vUv.y));
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
   * @param opts.length 全長(m)。実物のメスは50cm前後
   * @param opts.prey  誘い寄せる群れ(School)。null可
   */
  constructor(scene, { home = new THREE.Vector3(0, 8, 0), length = 0.52, prey = null } = {}) {
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

    // ひれ。胸びれは体側、尾びれは尾柄の後ろ
    const pecGeo = buildFin(0.26, 0.22, 0.5);
    for (const s of [-1, 1]) {
      const f = new THREE.Mesh(pecGeo, mat(BODY_VERT, FIN_FRAG, { transparent: true, depthWrite: false }));
      f.position.set(s * WW * 0.86, -0.04, 0.02);
      f.rotation.z = s * -1.35;
      f.rotation.y = s * 0.5;
      this.group.add(f);
    }
    const caudal = new THREE.Mesh(buildFin(0.30, 0.34, 1.0), mat(BODY_VERT, FIN_FRAG, { transparent: true, depthWrite: false }));
    caudal.position.set(0, 0, -0.50);
    caudal.rotation.x = Math.PI / 2;
    this.group.add(caudal);

    // 眼。深海のこの仲間の眼は驚くほど小さい。獲物を光で呼ぶ側なので、
    // 遠くを見る必要がない
    const eyeGeo = new THREE.SphereGeometry(0.030, 10, 8);
    const eyeMat = new THREE.MeshBasicMaterial({ color: '#0a0c10' });
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(eyeGeo, eyeMat);
      const p = ringPoint(0.86, s * Math.PI * 0.42, 1.02);
      e.position.set(p[0], p[1] + 0.05, p[2]);
      this.group.add(e);
    }

    // イリシウムとエスカ
    const illGeo = buildIllicium();
    this.group.add(new THREE.Mesh(illGeo, mat(ILL_VERT, ILL_FRAG)));

    this.escaU = { ...baseUniforms(), uGlow: { value: 1 } };
    const escaGeo = new THREE.SphereGeometry(0.055, 14, 10);
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
      new THREE.PlaneGeometry(0.44, 0.44),
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
    this.gape = 0.06;      // 下顎の開き(rad は update で掛ける)
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
      if (this.cool <= 0 && this.prey && this.nearestPrey(esca) < 0.55) {
        this.state = 'strike';
        this.phase = 0;
      }
      // 待っている間はわずかに口を開けている
      this.gape += (0.06 - this.gape) * (1 - Math.exp(-3 * dt));
    } else if (this.state === 'strike') {
      // 大口を開けて吸い込み、閉じる。実物では6ミリ秒で終わる動作なので、
      // 見えるぎりぎりまで速くする
      this.phase += dt;
      const open = 0.16, shut = 0.09;
      if (this.phase < open) {
        this.gape = THREE.MathUtils.lerp(0.06, 1.0, this.phase / open);
      } else if (this.phase < open + shut) {
        this.gape = THREE.MathUtils.lerp(1.0, 0.02, (this.phase - open) / shut);
      } else {
        // 逃げ遅れなかった魚は爆発的に散る
        if (this.prey) this.prey.scare(esca, 2.6, 22);
        this.state = 'wait';
        this.cool = 9 + Math.random() * 7;
      }
    }
    // 下顎の回転。0.06→ほぼ閉じ、1.0→限界まで開く
    this.jaw.rotation.x = this.gape * 0.95;
    // 開くほどエスカを暗くする(光っていては獲物が逃げる)
    this.escaU.uGlow.value = 1 - THREE.MathUtils.smoothstep(this.gape, 0.2, 0.8) * 0.75;
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
