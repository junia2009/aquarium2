import * as THREE from 'three';
import { baseUniforms, WORLD, U } from '../env.js';
import { UW_FRAG_PRELUDE, UW_FRAG_OUTPUT } from '../glsl.js';
import { wander1 } from '../noise.js';
import { addCausticsToStandard } from '../environment/seabed.js';

// ============ 深海の生物 ============

const _v = new THREE.Vector3();

// ---- Atollaクラゲ(オオベニクラゲモドキ) ----
// 深紅の傘。この赤は周囲光では真っ黒に沈むので、闇に溶けて見えない。
//
// 襲われると傘の縁に沿って青い光が回転する。これは逃げるための光ではない。
// 自分では逃げきれないので「ここに捕食者がいる」と広く知らせ、
// より上位の捕食者を呼んでその隙に逃げる、という戦術で、
// burglar alarm(泥棒警報)と呼ばれる。
// タップするとこれが起きる。

const BELL_SEG = 48, BELL_RINGS = 10;
const LOBES = 20;   // 傘の縁の切れ込み(Atollaは縁が花びら状に分かれる)

function buildAtollaBell() {
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= BELL_RINGS; i++) {
    const t = i / BELL_RINGS;
    for (let j = 0; j <= BELL_SEG; j++) {
      const a = (j / BELL_SEG) * Math.PI * 2;
      // 縁が花びら状に分かれる。外周ほど切れ込みが深い
      const lobe = 1 + 0.10 * Math.cos(a * LOBES) * Math.pow(t, 2.2);
      const r = t * lobe;
      // 中央が盛り上がり、縁は水平に近い平たい傘
      // 平たい皿ではなく、中央が盛り上がった傘。縁は少し垂れる
      const y = 0.46 * Math.pow(Math.max(1 - t * t, 0), 0.70) - 0.10 * Math.pow(t, 3.0);
      pos.push(Math.sin(a) * r, y, Math.cos(a) * r);
      uv.push(j / BELL_SEG, t);
    }
  }
  for (let i = 0; i < BELL_RINGS; i++) {
    for (let j = 0; j < BELL_SEG; j++) {
      const a = i * (BELL_SEG + 1) + j, b = a + 1;
      const c = (i + 1) * (BELL_SEG + 1) + j, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

// 縁から下がる触手(帯)。1本だけ極端に長い
function buildTentacle(len, wide) {
  const SEG = 14;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const w = wide * (1 - t * 0.85);
    pos.push(-w, -t * len, 0, w, -t * len, 0);
    uv.push(0, t, 1, t);
  }
  for (let i = 0; i < SEG; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

const ATOLLA_COMMON = /* glsl */ `
uniform float uPulse;      // 拍動(0..1)
uniform float uSeed;
uniform float uAlarmAge;   // 警報発光が始まってからの秒数(負なら未発火)
`;

const BELL_VERT = ATOLLA_COMMON + /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec3 p = position;
  // 拍動: 縁を絞って傘を窄める。中心は動かない
  float r = length(p.xz);
  float squeeze = uPulse * 0.22 * smoothstep(0.15, 1.0, r);
  p.xz *= 1.0 - squeeze;
  p.y += squeeze * 0.55 * r;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const BELL_FRAG = UW_FRAG_PRELUDE + ATOLLA_COMMON + /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 V = normalize(cameraPosition - vWorldPos);

  // 深紅の傘。中央の胃腔がいちばん濃い
  vec3 deepRed = vec3(0.52, 0.045, 0.035);
  vec3 albedo = mix(deepRed * 0.55, deepRed, smoothstep(0.9, 0.2, vUv.y));
  // 放射管(傘の中心から縁へ走る筋)
  float canal = smoothstep(0.72, 0.98, abs(sin(vUv.x * 3.14159 * float(${LOBES}))));
  albedo *= 1.0 - canal * 0.35 * smoothstep(0.15, 0.9, vUv.y);

  vec3 col = underwaterLight(albedo, n, vWorldPos, V, 26.0, 0.10);

  // ---- 警報発光 ----
  // 縁に沿って青い光が回る。一定の速さで何周もし、数秒かけて消えていく。
  if (uAlarmAge >= 0.0) {
    float fade = 1.0 - smoothstep(0.0, 5.5, uAlarmAge);
    // 縁に沿って回る細い光の帯。太くすると「傘全体が青く光る」だけになり、
    // 回転が読み取れなくなるので、幅は縁の1割以下に絞る
    float phase = fract(vUv.x - uAlarmAge * 1.6);
    float d = min(phase, 1.0 - phase);
    float ring = smoothstep(0.045, 0.0, d);
    // 走ったあとに尾を引く(発光は一瞬では消えない)
    float tail = smoothstep(0.26, 0.0, phase) * 0.35;
    // 光るのは縁のごく外側だけ
    float edge = smoothstep(0.74, 1.0, vUv.y);
    col += vec3(0.22, 0.78, 1.0) * (ring + tail) * edge * fade * 5.0;
    // 縁のすぐ内側にだけ、にじみが乗る
    col += vec3(0.05, 0.22, 0.36) * smoothstep(0.55, 0.95, vUv.y) * fade * 0.35;
  }

  col = applyUnderwaterFog(col, vWorldPos);
  float alpha = 0.80 - 0.25 * smoothstep(0.2, 1.0, vUv.y);
  gl_FragColor = vec4(col, alpha);
  ${UW_FRAG_OUTPUT}
}
`;

const TENT_VERT = ATOLLA_COMMON + /* glsl */ `
uniform float uTime;
uniform float uLen;
varying vec2 vUv;
varying vec3 vWorldPos;
void main() {
  vec3 p = position;
  // 触手は慣性で遅れてなびく。先ほど大きく揺れる
  float t = vUv.y;
  float lag = t * t;
  p.x += sin(uTime * 0.9 + uSeed * 12.0 - t * 3.0) * 0.10 * lag * uLen;
  p.z += cos(uTime * 0.7 + uSeed * 9.0 - t * 2.4) * 0.10 * lag * uLen;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const TENT_FRAG = UW_FRAG_PRELUDE + ATOLLA_COMMON + /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;
void main() {
  vec3 n = normalize(cameraPosition - vWorldPos);
  vec3 albedo = vec3(0.42, 0.05, 0.04);
  vec3 col = underwaterLight(albedo, n, vWorldPos, n, 20.0, 0.05);
  if (uAlarmAge >= 0.0) {
    float fade = 1.0 - smoothstep(0.0, 5.5, uAlarmAge);
    // 触手も付け根だけがにじむ
    col += vec3(0.10, 0.38, 0.58) * fade * smoothstep(0.5, 0.0, vUv.y) * 0.8;
  }
  col = applyUnderwaterFog(col, vWorldPos);
  float a = (0.72 - 0.55 * vUv.y) * (1.0 - smoothstep(0.35, 0.5, abs(vUv.x - 0.5)));
  gl_FragColor = vec4(col, a);
  ${UW_FRAG_OUTPUT}
}
`;

export class AtollaSwarm {
  constructor(scene, { count = 5, center = new THREE.Vector3(0, 9, 0), radius = 14 } = {}) {
    this.jellies = [];
    this.center = center.clone();
    this.radius = radius;
    this.time = 0;
    const bellGeo = buildAtollaBell();
    const margGeo = buildTentacle(1.0, 0.020);
    const trailGeo = buildTentacle(5.5, 0.016);   // 1本だけ極端に長い

    for (let i = 0; i < count; i++) {
      const seed = Math.random() * 100;
      const scale = 0.55 + Math.random() * 0.55;
      const group = new THREE.Group();
      const shared = () => ({
        ...baseUniforms(),
        uPulse: { value: 0 },
        uSeed: { value: seed },
        uAlarmAge: { value: -1 },
      });

      const bellU = shared();
      const bellMat = new THREE.ShaderMaterial({
        uniforms: bellU, vertexShader: BELL_VERT, fragmentShader: BELL_FRAG,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
      });
      group.add(new THREE.Mesh(bellGeo, bellMat));

      // 縁の触手。Atollaは縁が花びら状に分かれ、その谷ごとに1本ずつ出る
      const tentU = { ...shared(), uLen: { value: 1.0 } };
      const tentMat = new THREE.ShaderMaterial({
        uniforms: tentU, vertexShader: TENT_VERT, fragmentShader: TENT_FRAG,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
      });
      for (let k = 0; k < LOBES; k++) {
        const a = (k / LOBES) * Math.PI * 2;
        const t = new THREE.Mesh(margGeo, tentMat);
        t.position.set(Math.sin(a) * 0.97, -0.02, Math.cos(a) * 0.97);
        t.rotation.y = a;
        group.add(t);
      }
      // 引きずる長い触手
      const trailU = { ...shared(), uLen: { value: 5.5 } };
      const trailMat = new THREE.ShaderMaterial({
        uniforms: trailU, vertexShader: TENT_VERT, fragmentShader: TENT_FRAG,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
      });
      const trail = new THREE.Mesh(trailGeo, trailMat);
      trail.position.set(0.97, -0.02, 0);
      group.add(trail);

      group.scale.setScalar(scale);
      group.position.set(
        center.x + (Math.random() - 0.5) * radius * 1.6,
        center.y + (Math.random() - 0.5) * 5,
        center.z + (Math.random() - 0.5) * radius * 1.6
      );
      scene.add(group);

      this.jellies.push({
        group, seed, scale,
        uniforms: [bellU, tentU, trailU],
        phase: Math.random() * Math.PI * 2,
        alarm: -1,                  // 警報発光の経過秒。負なら未発火
        vel: new THREE.Vector3(),
      });
    }
  }

  /**
   * 図鑑から寄るときの注視点。
   * 全個体の平均を取ると、5匹が半径13mに散っているので誰もいない
   * 中間地点を向いてしまう。そこを向いたままではタップする相手もいない。
   * 1匹に張り付いて追う。
   */
  get swarmCenter() {
    const p = this.jellies[0].group.position;
    return _v.set(p.x, p.y + 0.18 * this.jellies[0].scale, p.z).clone();
  }

  /**
   * 視線の通った1匹に警報発光を起こす。
   *
   * 傘は「半径1.0、高さ -0.10〜+0.46」の平たいドーム(個体の scale 倍)。
   * 縦だけ引き伸ばして球にそろえてから、素直にレイと球の交差を解く。
   * 円柱状の大ざっぱな判定にすると、
   *   ・当たり判定が傘の3倍以上に膨らみ、狙っていない個体を掴む
   *   ・視線からの距離ではなく「手前かどうか」で選ぶので、
   *     画面の中心にいる個体を素通りして奥の別個体が光る
   * の両方が起きる。
   *
   * 発光するのは襲われた本人だけ。まわりの個体は光らない
   * (警報は「自分が襲われている」という合図で、伝染するものではない)。
   *
   * @param slack 指で狙う余裕。傘の半径に対する倍率
   * @returns 光らせた個体の位置(当たらなければ null)
   */
  alarmAlongRay(ray, slack = 1.4) {
    const BELL_MID = 0.18;   // 傘の中心の高さ(ドームの上端と縁の中ほど)
    const FLAT = 0.28;       // 傘の高さの半分 / 傘の半径
    const o = ray.origin, d = ray.direction;
    let best = null, bestT = Infinity;
    for (const j of this.jellies) {
      const R = j.scale * slack;
      const ox = o.x - j.group.position.x;
      const oy = (o.y - (j.group.position.y + BELL_MID * j.scale)) / FLAT;
      const oz = o.z - j.group.position.z;
      const dy = d.y / FLAT;
      const a = d.x * d.x + dy * dy + d.z * d.z;
      const b = 2 * (ox * d.x + oy * dy + oz * d.z);
      const c = ox * ox + oy * oy + oz * oz - R * R;
      const disc = b * b - 4 * a * c;
      if (disc < 0) continue;
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t > 0 && t < bestT) { bestT = t; best = j; }
    }
    if (!best) return null;
    best.alarm = 0;
    return best.group.position.clone();
  }

  update(dt) {
    this.time += dt;
    const t = this.time;
    for (const j of this.jellies) {
      // 拍動。収縮は速く、弛緩は遅い(推進はこの非対称から生まれる)
      const cyc = (t * 0.42 + j.phase) % 1;
      const pulse = cyc < 0.26
        ? Math.sin((cyc / 0.26) * Math.PI * 0.5)
        : Math.pow(1 - (cyc - 0.26) / 0.74, 1.6);

      // 収縮の瞬間だけ上へ進み、あとは沈む
      const thrust = cyc < 0.26 ? 0.85 : -0.10;
      j.vel.y += (thrust * 0.55 - j.vel.y) * (1 - Math.exp(-3 * dt));
      j.vel.x = wander1(t * 0.05 + j.seed, j.seed) * 0.30;
      j.vel.z = wander1(t * 0.05 + j.seed + 20, j.seed) * 0.30;
      j.group.position.addScaledVector(j.vel, dt);

      // 遊泳域に留める
      const p = j.group.position;
      p.y = THREE.MathUtils.clamp(p.y, 4.5, WORLD.surfaceY - 1.5);
      const dx = p.x - this.center.x, dz = p.z - this.center.z;
      const r = Math.hypot(dx, dz);
      if (r > this.radius) {
        p.x = this.center.x + (dx / r) * this.radius;
        p.z = this.center.z + (dz / r) * this.radius;
      }
      j.group.rotation.y += dt * 0.12;

      if (j.alarm >= 0) {
        j.alarm += dt;
        if (j.alarm > 6.0) j.alarm = -1;
      }
      for (const u of j.uniforms) {
        u.uPulse.value = pulse;
        u.uAlarmAge.value = j.alarm;
      }
    }
  }
}

// ---- ユメナマコ ----
// 海底を這わずに泳ぐナマコ。体は半透明のピンクで、飲み込んだ泥が
// 消化管に透けて見える。前方の大きな「ヴェール」(変形した管足)を
// 波打たせて泳ぎ、降りては泥を食べ、また舞い上がる。
// 刺激を受けると体表が青く光る。

// 体の紡錘。後端は尖り、前端は口の開いた丸い縁で終わる(ここにヴェールが付く)。
// 太いのは前寄り。全長1.0を基準にして、使う側で実寸へ縮める。
const CUKE_R = (t) => Math.pow(Math.sin(Math.PI * Math.min(Math.pow(t, 1.4) * 0.90, 0.86)), 0.72);
const CUKE_HH = 0.30, CUKE_WW = 0.24;

function buildCucumberBody() {
  const RINGS = 24, SEG = 20;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= RINGS; i++) {
    const t = i / RINGS;
    const r = CUKE_R(t);
    const hh = r * CUKE_HH, ww = r * CUKE_WW;
    for (let j = 0; j <= SEG; j++) {
      const a = (j / SEG) * Math.PI * 2;
      // 背は丸く、腹は平ら(泥の上をなでる面)
      const cy = Math.cos(a);
      pos.push(Math.sin(a) * ww, cy * hh * (cy > 0 ? 1.0 : 0.62) + 0.05 * r, t - 0.5);
      uv.push(j / SEG, t);
    }
  }
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEG; j++) {
      const a = i * (SEG + 1) + j, b = a + 1;
      const c = (i + 1) * (SEG + 1) + j, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

// 飲み込んだ泥の詰まった消化管。半透明の体を透かして、これがいちばん濃く見える。
// 体の内側に別メッシュとして置く(体色に混ぜるだけでは、半透明どうしの
// 描画順で消えてしまう)
function buildGut() {
  const LONG = 20, SEG = 10;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= LONG; i++) {
    const s = i / LONG;
    const z = -0.34 + s * 0.70;
    const t = z + 0.5;
    const body = CUKE_R(t);
    // 腸は腹側を通り、途中で少しうねる
    const cy = -body * CUKE_HH * 0.34 + 0.05 * body;
    const cx = Math.sin(s * 6.0) * body * CUKE_WW * 0.14;
    // 食べたばかりの前半が太い
    const rr = (0.030 + 0.045 * Math.sin(Math.PI * Math.pow(s, 0.8))) * Math.min(1, body * 1.6);
    for (let j = 0; j <= SEG; j++) {
      const a = (j / SEG) * Math.PI * 2;
      pos.push(cx + Math.sin(a) * rr, cy + Math.cos(a) * rr, z);
      uv.push(j / SEG, s);
    }
  }
  for (let i = 0; i < LONG; i++) {
    for (let j = 0; j < SEG; j++) {
      const a = i * (SEG + 1) + j, b = a + 1;
      const c = (i + 1) * (SEG + 1) + j, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

// 前縁のヴェール。癒合した口触手が作る縁飾りで、口のまわりを一周する笠。
// 背側がいちばん大きく張り出す。
function buildVeil() {
  const RAD = 8, SEG = 30;
  const pos = [], uv = [], idx = [];
  const r0 = CUKE_R(1.0);
  for (let i = 0; i <= RAD; i++) {
    const t = i / RAD;
    const flare = Math.pow(t, 0.85);
    for (let j = 0; j <= SEG; j++) {
      const s = j / SEG;
      const a = s * Math.PI * 2;
      const cy = Math.cos(a);
      // 背側(cy>0)ほど大きく開く
      const grow = flare * (0.075 + 0.050 * Math.max(cy, 0.0));
      const ww = r0 * CUKE_WW + grow;
      const hh = r0 * CUKE_HH + grow;
      pos.push(Math.sin(a) * ww, cy * hh + 0.05 * r0, flare * 0.15);
      uv.push(s, t);
    }
  }
  for (let i = 0; i < RAD; i++) {
    for (let j = 0; j < SEG; j++) {
      const a = i * (SEG + 1) + j, b = a + 1;
      const c = (i + 1) * (SEG + 1) + j, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

// 背中の遊泳膜。左右の疣足が癒合してできた低い帆。
// 高く立てるとイカのヒレに見えてしまうので、体高の半分より低く抑える。
function buildDorsalWeb() {
  const LONG = 20, UP = 5;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= LONG; i++) {
    const s = i / LONG;
    const z = -0.30 + s * 0.62;
    const t = z + 0.5;
    const base = CUKE_R(t) * (CUKE_HH + 0.05);
    // 帆の高さ: 中ほどから前寄りが最も高い
    const h = Math.sin(Math.PI * Math.pow(s, 0.7)) * 0.115;
    for (let j = 0; j <= UP; j++) {
      const u = j / UP;
      pos.push(0, base + h * u, z);
      uv.push(s, u);
    }
  }
  for (let i = 0; i < LONG; i++) {
    for (let j = 0; j < UP; j++) {
      const a = i * (UP + 1) + j, b = a + 1;
      const c = (i + 1) * (UP + 1) + j, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

// uTime は UW_FRAG_PRELUDE 側で宣言済み。フラグメントで重複させないよう、
// 頂点シェーダにだけ足す
const CUKE_COMMON = /* glsl */ `
uniform float uSeed;
uniform float uGlow;    // 刺激を受けたときの発光(0..1)
`;
const CUKE_VTIME = /* glsl */ `uniform float uTime;
`;

const CUKE_BODY_VERT = CUKE_VTIME + CUKE_COMMON + /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec3 p = position;
  // 体もゆるく波打つ。後ろほど遅れる
  float w = sin(uTime * 1.6 + uSeed * 7.0 - (p.z + 0.5) * 4.0);
  p.y += w * 0.045 * (p.z + 0.5);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const CUKE_BODY_FRAG = UW_FRAG_PRELUDE + CUKE_COMMON + /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 V = normalize(cameraPosition - vWorldPos);

  // 半透明の赤紫。周囲光では黒く沈み、ライトを当てた瞬間だけ色が出る
  vec3 albedo = vec3(0.60, 0.15, 0.19);
  // 体表に並ぶ細かい疣足の粒
  albedo *= 0.92 + 0.08 * sin(vUv.x * 62.0) * sin(vUv.y * 46.0);

  vec3 col = underwaterLight(albedo, n, vWorldPos, V, 22.0, 0.14);
  // 刺激を受けたときの発光。体表全体がぼんやり青く光る
  col += vec3(0.16, 0.55, 0.72) * uGlow * (0.5 + 0.5 * sin(uTime * 5.0 + uSeed));
  col = applyUnderwaterFog(col, vWorldPos);
  // 縁ほど厚みがあって濁る(半透明の体の見え方)
  float fr = pow(1.0 - abs(dot(n, V)), 2.0);
  gl_FragColor = vec4(col, 0.40 + 0.42 * fr);
  ${UW_FRAG_OUTPUT}
}
`;

const VEIL_VERT = CUKE_VTIME + CUKE_COMMON + /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec3 p = position;
  // ヴェールを波打たせる。これが推進力になる
  float r = length(p.xy);
  p.z += sin(uTime * 2.4 + uSeed * 5.0 + (p.x + p.y) * 5.0) * 0.10 * r;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const VEIL_FRAG = UW_FRAG_PRELUDE + CUKE_COMMON + /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 albedo = vec3(0.66, 0.20, 0.24);
  vec3 col = underwaterLight(albedo, n, vWorldPos, V, 18.0, 0.10);
  col += vec3(0.16, 0.55, 0.72) * uGlow * 0.8;
  col = applyUnderwaterFog(col, vWorldPos);
  // 膜は縁ほど薄い
  gl_FragColor = vec4(col, 0.80 - 0.34 * vUv.y);
  ${UW_FRAG_OUTPUT}
}
`;

// 消化管。体と同じ波にのせて動かさないと、中身だけ取り残されて見える
const GUT_VERT = CUKE_VTIME + CUKE_COMMON + /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec3 p = position;
  float w = sin(uTime * 1.6 + uSeed * 7.0 - (p.z + 0.5) * 4.0);
  p.y += w * 0.045 * (p.z + 0.5);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const GUT_FRAG = UW_FRAG_PRELUDE + CUKE_COMMON + /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 V = normalize(cameraPosition - vWorldPos);
  // 飲んだ泥そのものの色。粒の詰まり具合で濃淡が出る
  float lump = 0.75 + 0.25 * sin(vUv.y * 34.0 + uSeed);
  vec3 albedo = mix(vec3(0.085, 0.070, 0.055), vec3(0.15, 0.125, 0.10), lump);
  // 泥は体の中身。外皮ごしに見えるぶん、直接ライトを浴びるより暗い
  vec3 col = underwaterLight(albedo, n, vWorldPos, V, 8.0, 0.0) * 0.55;
  col = applyUnderwaterFog(col, vWorldPos);
  gl_FragColor = vec4(col, 0.95);
  ${UW_FRAG_OUTPUT}
}
`;

// 背の帆。ヴェールと同じ膜だが、こちらは進行方向へ緩やかにあおられる
const WEB_VERT = CUKE_VTIME + CUKE_COMMON + /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec3 p = position;
  // 一枚の薄い膜が、前から後ろへ波を送る。高いところほど大きく振れる
  p.x += sin(uTime * 1.9 + uSeed * 3.0 - p.z * 6.0) * 0.11 * uv.y;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const WEB_FRAG = UW_FRAG_PRELUDE + CUKE_COMMON + /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 albedo = vec3(0.63, 0.18, 0.22);
  vec3 col = underwaterLight(albedo, n, vWorldPos, V, 18.0, 0.10);
  col += vec3(0.16, 0.55, 0.72) * uGlow * 0.8;
  col = applyUnderwaterFog(col, vWorldPos);
  // 根元は厚く、縁は消え入るように薄い
  gl_FragColor = vec4(col, 0.78 - 0.46 * vUv.y);
  ${UW_FRAG_OUTPUT}
}
`;

export class DreamCucumbers {
  constructor(scene, { count = 4, center = new THREE.Vector3(0, 4, 0), radius = 14, floorFn } = {}) {
    this.items = [];
    this.center = center.clone();
    this.radius = radius;
    this.floorFn = floorFn || (() => 0);
    this.time = 0;
    const bodyGeo = buildCucumberBody();
    const veilGeo = buildVeil();
    const webGeo = buildDorsalWeb();
    const gutGeo = buildGut();

    for (let i = 0; i < count; i++) {
      const seed = Math.random() * 100;
      // 実物は体長20〜25cm、ヴェールまで入れて30cm強。小さい生き物なので
      // ここを盛ると一気に嘘になる
      const scale = 0.26 + Math.random() * 0.14;
      const group = new THREE.Group();
      const u = () => ({ ...baseUniforms(), uSeed: { value: seed }, uGlow: { value: 0 } });
      const bu = u(), vu = u(), wu = u(), gu = u();
      // 描画順を明示する。半透明どうしは距離で並べ替えても、入れ子になった
      // 中身(腸)と外皮(体)の前後は決まらない
      const gut = new THREE.Mesh(gutGeo, new THREE.ShaderMaterial({
        uniforms: gu, vertexShader: GUT_VERT, fragmentShader: GUT_FRAG,
        transparent: true, depthWrite: false,
      }));
      gut.renderOrder = 0;
      group.add(gut);

      const web = new THREE.Mesh(webGeo, new THREE.ShaderMaterial({
        uniforms: wu, vertexShader: WEB_VERT, fragmentShader: WEB_FRAG,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
      }));
      web.renderOrder = 1;
      group.add(web);

      const body = new THREE.Mesh(bodyGeo, new THREE.ShaderMaterial({
        uniforms: bu, vertexShader: CUKE_BODY_VERT, fragmentShader: CUKE_BODY_FRAG,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
      }));
      body.renderOrder = 2;
      group.add(body);

      const veil = new THREE.Mesh(veilGeo, new THREE.ShaderMaterial({
        uniforms: vu, vertexShader: VEIL_VERT, fragmentShader: VEIL_FRAG,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
      }));
      veil.position.z = 0.48;
      veil.renderOrder = 3;
      group.add(veil);

      group.scale.setScalar(scale);
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      group.position.set(center.x + Math.cos(a) * r, 0, center.z + Math.sin(a) * r);
      scene.add(group);

      this.items.push({
        group, seed, scale, uniforms: [bu, vu, wu, gu],
        heading: Math.random() * Math.PI * 2,
        // 降りて泥を食べ、また舞い上がる。その周期
        phase: Math.random() * Math.PI * 2,
        glow: 0,
      });
    }
  }

  /**
   * 図鑑から寄るときの注視点。ばらけて漂う小さな生き物なので、平均を取ると
   * 誰もいない場所を向く。1個体に張り付いて追う。
   */
  get center3() {
    return _v.copy(this.items[0].group.position).clone();
  }

  /**
   * 視線の通った1匹だけを光らせる。
   *
   * 「タップ地点から半径N mの個体を全部光らせる」ようにすると、
   * 群れているぶん一度に何匹も光ってしまい、
   * しかも海底のどこを触っても光る。触れた本人だけが光るのが正しい。
   *
   * 体は細長い紡錘なので、進行方向へ寝かせた楕円体として交差を取る。
   * @param slack 指で狙う余裕(1.0 で体の輪郭ぴったり)
   * @returns 光らせた個体の位置(当たらなければ null)
   */
  glowAlongRay(ray, slack = 1.35) {
    const o = ray.origin, d = ray.direction;
    let best = null, bestT = Infinity;
    for (const it of this.items) {
      const p = it.group.position;
      const c = Math.cos(-it.heading), sn = Math.sin(-it.heading);
      // ローカル座標へ(位置を引いて、進行方向まわりに戻す)
      const rx = o.x - p.x, ry = o.y - p.y, rz = o.z - p.z;
      // 体軸(+Z)まわりの向きを打ち消す回転。rotation.y = heading
      const ox = rx * c + rz * sn, oz = -rx * sn + rz * c;
      const dx = d.x * c + d.z * sn, dz = -d.x * sn + d.z * c;
      // 楕円体を単位球にそろえる
      const L = 0.52 * it.scale, Hh = 0.34 * it.scale, Ww = 0.28 * it.scale;
      const ax = ox / Ww, ay = ry / Hh, az = oz / L;
      const bx = dx / Ww, by = d.y / Hh, bz = dz / L;
      const A = bx * bx + by * by + bz * bz;
      const B = 2 * (ax * bx + ay * by + az * bz);
      const C = ax * ax + ay * ay + az * az - slack * slack;
      const disc = B * B - 4 * A * C;
      if (disc < 0) continue;
      const t = (-B - Math.sqrt(disc)) / (2 * A);
      if (t > 0 && t < bestT) { bestT = t; best = it; }
    }
    if (!best) return null;
    best.glow = 1;
    return best.group.position.clone();
  }

  update(dt) {
    this.time += dt;
    const t = this.time;
    for (const it of this.items) {
      // 降下 → 着底して摂餌 → 舞い上がる、をゆっくり繰り返す
      const cyc = Math.sin(t * 0.10 + it.phase);
      const floor = this.floorFn(it.group.position.x, it.group.position.z);
      const targetY = floor + 0.12 + Math.max(cyc, -0.2) * 2.4;
      const p = it.group.position;
      p.y += (targetY - p.y) * (1 - Math.exp(-0.9 * dt));

      it.heading += wander1(t * 0.07 + it.seed, it.seed) * 0.5 * dt;
      const spd = 0.18 + 0.14 * Math.max(cyc, 0);
      p.x += Math.sin(it.heading) * spd * dt;
      p.z += Math.cos(it.heading) * spd * dt;

      const dx = p.x - this.center.x, dz = p.z - this.center.z;
      const r = Math.hypot(dx, dz);
      if (r > this.radius) {
        it.heading = Math.atan2(-dx, -dz);
        p.x = this.center.x + (dx / r) * this.radius;
        p.z = this.center.z + (dz / r) * this.radius;
      }
      it.group.rotation.y = it.heading;
      // 上がるときは頭を上げ、降りるときは下げる
      it.group.rotation.x = THREE.MathUtils.clamp(-cyc * 0.35, -0.4, 0.4);

      if (it.glow > 0) it.glow = Math.max(0, it.glow - dt / 3.5);
      for (const u of it.uniforms) u.uGlow.value = it.glow;
    }
  }
}

// ---- オオグチボヤ ----
// 海底に柄で立ち、大きな入水口を袋のように開いて流れに向ける。
// 通りかかった小さな生き物が入ると、口をすぼめて閉じ込める。
// ホヤのなかまでありながら濾過ではなく捕食をする、珍しい種。

function buildFunnel() {
  const RINGS = 14, SEG = 22;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= RINGS; i++) {
    const t = i / RINGS;
    for (let j = 0; j <= SEG; j++) {
      const a = (j / SEG) * Math.PI * 2;
      pos.push(Math.sin(a), t, Math.cos(a));   // 半径は頂点シェーダで決める
      uv.push(j / SEG, t);
    }
  }
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEG; j++) {
      const a = i * (SEG + 1) + j, b = a + 1;
      const c = (i + 1) * (SEG + 1) + j, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

const FUNNEL_VERT = /* glsl */ `
uniform float uOpen;    // 0=閉じている 1=大きく開く
uniform float uTime;
uniform float uSeed;
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  float t = uv.y;
  // 開いたときは漏斗、閉じたときは細い袋。口だけが大きく変わる
  float rOpen   = 0.16 + 0.95 * pow(t, 1.7);
  float rClosed = 0.16 + 0.14 * pow(t, 0.7);
  float r = mix(rClosed, rOpen, uOpen);
  // 流れに揺れる
  float sway = sin(uTime * 0.7 + uSeed * 6.0) * 0.05 * t * t;
  vec3 p = vec3(position.x * r + sway, t * (0.55 + 0.35 * uOpen), position.z * r);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  // 半径が t で変わるので、法線は面から取り直す
  vec3 tang = vec3(position.z, 0.0, -position.x);
  float dr = mix(0.14 * 0.7 * pow(max(t, 1e-3), -0.3), 0.95 * 1.7 * pow(t, 0.7), uOpen);
  vec3 bit = vec3(position.x * dr, 0.55 + 0.35 * uOpen, position.z * dr);
  vNormal = normalize(mat3(modelMatrix) * normalize(cross(bit, tang)));
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FUNNEL_FRAG = UW_FRAG_PRELUDE + /* glsl */ `
uniform float uOpen;
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 V = normalize(cameraPosition - vWorldPos);
  // 半透明の白。口の内側は影になって暗い
  vec3 albedo = mix(vec3(0.62, 0.63, 0.60), vec3(0.30, 0.31, 0.30), float(!gl_FrontFacing));
  vec3 col = underwaterLight(albedo, n, vWorldPos, V, 16.0, 0.08);
  col = applyUnderwaterFog(col, vWorldPos);
  gl_FragColor = vec4(col, 0.78);
  ${UW_FRAG_OUTPUT}
}
`;

export class TunicateBed {
  constructor(scene, { spots = [], floorFn } = {}) {
    this.items = [];
    const funnelGeo = buildFunnel();
    const stalkGeo = new THREE.CylinderGeometry(0.035, 0.07, 1, 8, 1, true);
    const stalkMat = new THREE.MeshStandardMaterial({ color: '#8f8f86', roughness: 0.9 });
    addCausticsToStandard(stalkMat, 0.0);

    for (const s of spots) {
      const y = floorFn(s.x, s.z);
      const seed = Math.random() * 100;
      const group = new THREE.Group();
      // 実物は柄まで入れて10〜15cm。漏斗の口が大きいだけで、体は小さい
      const stalkLen = 0.5 + Math.random() * 0.6;   // 群落の scale(≒0.13)倍される
      const stalk = new THREE.Mesh(stalkGeo, stalkMat);
      stalk.scale.y = stalkLen;
      stalk.position.y = stalkLen * 0.5;
      group.add(stalk);

      const u = { ...baseUniforms(), uOpen: { value: 1 }, uSeed: { value: seed } };
      const funnel = new THREE.Mesh(funnelGeo, new THREE.ShaderMaterial({
        uniforms: u, vertexShader: FUNNEL_VERT, fragmentShader: FUNNEL_FRAG,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
      }));
      funnel.position.y = stalkLen;
      group.add(funnel);

      group.position.set(s.x, y, s.z);
      group.scale.setScalar(s.scale ?? 1);
      // 口は流れの方へ向く。群落でそろって同じ方を向くのが実物の見どころ
      group.rotation.y = (s.face ?? 0.6) + (Math.random() - 0.5) * 0.4;
      group.rotation.z = 0.28 + (Math.random() - 0.5) * 0.2;
      scene.add(group);
      this.items.push({ group, u, open: 1, target: 1 });
    }
  }

  /**
   * 図鑑から寄るときの注視点。群落は離れて何カ所もあるので、全個体の
   * 平均を取ると誰もいない中間地点を向いてしまう。最初の株を見る。
   */
  get center3() {
    const p = this.items[0].group.position;
    return _v.set(p.x, p.y + 0.10, p.z).clone();
  }

  /** 近づかれると口を閉じる。離れるとゆっくり開き直す */
  update(dt, camera) {
    for (const it of this.items) {
      const d = it.group.position.distanceTo(camera.position);
      it.target = d < 1.3 ? 0.06 : 1.0;
      // 閉じるのは速く、開くのは恐る恐る
      const rate = it.target < it.open ? 7.0 : 0.6;
      it.open += (it.target - it.open) * (1 - Math.exp(-rate * dt));
      it.u.uOpen.value = it.open;
    }
  }
}
