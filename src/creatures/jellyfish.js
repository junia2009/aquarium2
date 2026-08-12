import * as THREE from 'three';
import { baseUniforms, WORLD } from '../env.js';
import { UW_UNIFORMS, UW_NOISE, UW_FOG, UW_FRAG_OUTPUT } from '../glsl.js';
import { clampToTerrain } from '../collision.js';

// ============ ミズクラゲ ============
// 傘の収縮による拍動遊泳(jet propulsion)。収縮は速く、弛緩は遅い
// 非対称な波形で、収縮の瞬間に推進力を得る——実物の遊泳サイクルを再現。
// 傘の縁ほど大きく動き、口腕は慣性で遅れてなびく。
// 傘の中に透ける四つ葉模様は生殖腺(ミズクラゲの見分けポイント)。

// ============ 傘のジオメトリ ============
// ミズクラゲの傘は深いお椀ではなく「浅い皿」。
// 球冠(spherical cap)を基本形にすると縁の傾きが緩やかになり、
// 角ばった印象が出ない。プロファイルは細かく刻んで輪郭のカクつきを消す。
const BELL_H = 0.42;   // 傘の高さ(半径1に対して)

function buildBellGeometry() {
  const R = (1 + BELL_H * BELL_H) / (2 * BELL_H);  // 球冠の半径
  const cy = BELL_H - R;
  const capY = (u) => cy + Math.sqrt(Math.max(R * R - u * u, 0));
  // 縁はわずかに垂れ下がる
  const topY = (u) => capY(u) - 0.06 * THREE.MathUtils.smoothstep(u, 0.70, 1.0);
  // 寒天質は中央が厚く縁が薄い
  const thick = (u) => 0.012 + 0.125 * Math.pow(Math.max(1 - u, 0), 1.3);

  const pts = [];
  const NT = 40, NB = 28;
  for (let i = 0; i <= NT; i++) {
    const u = i / NT;
    pts.push(new THREE.Vector2(u, topY(u)));
  }
  for (let i = NB - 1; i >= 0; i--) {
    const u = i / NB;
    pts.push(new THREE.Vector2(u, topY(u) - thick(u)));
  }
  const geo = new THREE.LatheGeometry(pts, 72);
  geo.computeVertexNormals();
  return geo;
}

// ============ 口腕 ============
// 平らな短冊に見えないよう、付け根が広く先へ細るリボンにし、
// 縁に沿ってフリルを作り、断面をゆるくカールさせる。
function buildArmGeometry() {
  const SEG_L = 30, SEG_W = 9;
  const L = 1.6;
  const pos = [], uvs = [], idx = [];
  for (let i = 0; i <= SEG_L; i++) {
    const t = i / SEG_L;                       // 0=付け根 1=先端
    // 付け根はすぼまり、すぐ広がってから先へ細る(角張った板に見せない)
    const w = 0.22 * Math.pow(1 - t, 0.55) * Math.pow(Math.min(t * 6.0, 1.0), 0.6)
            * (0.74 + 0.26 * Math.sin(t * 11.0));
    for (let j = 0; j <= SEG_W; j++) {
      const s = j / SEG_W - 0.5;               // -0.5..0.5
      // 断面をU字にゆるく巻く
      const curl = Math.pow(Math.abs(s) * 2, 2) * 0.09 * (1 - t * 0.45);
      pos.push(s * w * 2, -t * L, curl);
      uvs.push(j / SEG_W, t);
    }
  }
  for (let i = 0; i < SEG_L; i++) {
    for (let j = 0; j < SEG_W; j++) {
      const a = i * (SEG_W + 1) + j;
      const b = a + SEG_W + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  geo.userData.hang = L;
  return geo;
}

// ============ 縁の触手 ============
// ミズクラゲの傘の縁には細かい触手がびっしり並ぶ。
// これがあるだけで「輪郭がつるりとした物体」に見えなくなる。
function buildFringeGeometry() {
  const COUNT = 112, SEGS = 5;
  const pos = [], uvs = [], idx = [];
  const hash = (i) => {
    const v = Math.sin(i * 78.233) * 43758.5453;
    return v - Math.floor(v);
  };
  let maxLen = 0;
  for (let k = 0; k < COUNT; k++) {
    const a = (k / COUNT) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const len = 0.22 + hash(k) * 0.30;
    maxLen = Math.max(maxLen, len);
    const base = pos.length / 3;
    for (let i = 0; i <= SEGS; i++) {
      const t = i / SEGS;
      const w = 0.0065 * (1 - t * 0.85);
      const r = 0.985 + t * 0.06;            // わずかに外へ開く
      const y = -0.02 - t * len;
      // 幅は接線方向に取る
      pos.push(ca * r - sa * w, y, sa * r + ca * w);
      pos.push(ca * r + sa * w, y, sa * r - ca * w);
      uvs.push(0, t, 1, t);
    }
    for (let i = 0; i < SEGS; i++) {
      const p0 = base + i * 2;
      idx.push(p0, p0 + 2, p0 + 1, p0 + 1, p0 + 2, p0 + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  geo.userData.hang = maxLen;
  return geo;
}

const BELL_VERT = /* glsl */ `
uniform float uTime;
uniform float uPulse;     // 0=弛緩 1=収縮
uniform float uSeed;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vLocal;
void main() {
  vec3 p = position;
  float rf = length(p.xz);                  // 傘の半径方向
  float edge = smoothstep(0.20, 1.0, rf);   // 縁ほど動く
  float a = atan(p.z, p.x);

  // 縁弁(ミズクラゲの縁は8つに分かれる)。
  // 半径を変調すると真上から見たとき多角形に見えてしまうので、
  // 主に上下方向のうねりで「ひらひら」を表現する
  float lobe = 0.5 + 0.5 * cos(a * 8.0);
  p.xz *= 1.0 + lobe * 0.010 * edge;
  p.y -= (1.0 - lobe) * 0.032 * edge * edge;
  // ゆっくりしたうねり
  p.y += sin(a * 3.0 + uTime * 1.1 + uSeed) * 0.020 * edge;

  // 収縮: 傘がすぼまって縦に伸びる(実物は縮むと弾丸型になる)
  p.xz *= 1.0 - uPulse * 0.30 * edge;
  p.y *= 1.0 + uPulse * 0.30;
  p.y += uPulse * 0.08 * edge;
  vLocal = p;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const BELL_FRAG = UW_UNIFORMS + UW_NOISE + UW_FOG + /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vLocal;
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 V = normalize(cameraPosition - vWorldPos);
  float ndv = abs(dot(n, V));
  // 指数を下げると、縁の一点に集まらず内側へ広がった淡い明るみになる。
  // 高いままだと「白い縁取り線」に見えて、水中の寒天質に見えない
  float fres = pow(1.0 - ndv, 1.55);

  float rf = length(vLocal.xz);
  float a = atan(vLocal.z, vLocal.x);

  // 傘の縁は寒天質が薄く尖って消えていく。ここで色とアルファを
  // 断ち切ると、輪郭がくっきりした白い線になる。最外周で溶かす
  float margin = smoothstep(1.00, 0.90, rf);

  // ほぼ透明な傘。縁と接線方向で白く浮かび上がる
  vec3 col = vec3(0.62, 0.78, 0.92) * 0.10;
  col += vec3(0.75, 0.88, 1.0) * fres * 0.52;

  // 生殖腺: ミズクラゲの象徴である4つの馬蹄形。中心側が開いている
  float gon = 0.0;
  for (int i = 0; i < 4; i++) {
    float ga = float(i) * 1.5707963 + 0.785;
    vec2 gc = vec2(cos(ga), sin(ga)) * 0.31;
    vec2 rel = vLocal.xz - gc;
    float d = length(rel);
    float ring = smoothstep(0.155, 0.105, d) * smoothstep(0.045, 0.085, d);
    // 中心を向く側を欠けさせて馬蹄形にする
    float outward = dot(normalize(rel + vec2(1e-5)), vec2(cos(ga), sin(ga)));
    gon += ring * smoothstep(-0.65, -0.15, outward);
  }
  col += vec3(0.86, 0.71, 0.74) * gon * 0.32;

  // 放射管: 中心から縁へ伸びる細い管
  float canal = pow(abs(sin(a * 8.0)), 46.0)
              * smoothstep(0.22, 0.55, rf) * smoothstep(1.02, 0.92, rf);
  col += vec3(0.72, 0.84, 0.92) * canal * 0.14;

  // 太陽の透過光(逆光で傘が輝く)
  float trans = clamp(dot(-n, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
  col += vec3(0.5, 0.7, 0.85) * trans * 0.18 * uSunI;

  float alpha = (0.13 + fres * 0.42 + gon * 0.26 + canal * 0.10) * margin;
  col = applyUnderwaterFog(col, vWorldPos);
  gl_FragColor = vec4(col, alpha);
  ${UW_FRAG_OUTPUT}
}
`;

const ARM_VERT = /* glsl */ `
uniform float uTime;
uniform float uSeed;
uniform vec2 uDrift;   // 移動速度(xz) — 口腕が慣性で遅れる
uniform float uHang;   // この房の長さ(口腕と縁の触手で違う)
uniform float uPulse;  // 傘の収縮に合わせて付け根が動く
uniform float uSway;   // 揺れ幅
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vUv = uv;
  vec3 p = position;
  float hang = clamp(-p.y / uHang, 0.0, 1.0); // 0=付け根 1=先端
  float lag = hang * hang;
  // 傘がすぼまると付け根も内側へ引き込まれる
  p.xz *= 1.0 - uPulse * 0.30 * (1.0 - hang * 0.5);
  // 遊泳の反対方向へなびく
  p.x -= uDrift.x * lag * 0.55;
  p.z -= uDrift.y * lag * 0.55;
  // ゆらゆらした揺れ
  p.x += sin(uTime * 1.3 + uSeed + hang * 3.5) * uSway * lag;
  p.z += cos(uTime * 1.1 + uSeed * 2.0 + hang * 2.8) * uSway * lag;
  // フリル
  p.x += sin(hang * 14.0 + uTime * 2.0 + uSeed) * uSway * 0.19;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const ARM_FRAG = UW_UNIFORMS + UW_NOISE + UW_FOG + /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 V = normalize(cameraPosition - vWorldPos);
  float fres = pow(1.0 - abs(dot(n, V)), 1.5);
  vec3 col = vec3(0.8, 0.85, 0.95) * (0.25 + fres * 0.5);
  // 縁のフリル状の透け。付け根と先端は溶けるように消す
  float frill = fbm(vUv * vec2(3.0, 9.0));
  float alpha = (0.09 + fres * 0.26) * smoothstep(0.12, 0.50, frill)
              * smoothstep(1.0, 0.70, vUv.y) * smoothstep(0.0, 0.12, vUv.y);
  col = applyUnderwaterFog(col, vWorldPos);
  gl_FragColor = vec4(col, alpha);
  ${UW_FRAG_OUTPUT}
}
`;

export class JellyfishSwarm {
  constructor(scene, count = 6) {
    this.jellies = [];
    const bellGeo = buildBellGeometry();
    const armGeo = buildArmGeometry();
    const fringeGeo = buildFringeGeometry();

    for (let i = 0; i < count; i++) {
      const seed = Math.random() * 100;
      const scale = 0.8 + Math.random() * 0.9;
      const group = new THREE.Group();

      const bellMat = new THREE.ShaderMaterial({
        uniforms: { ...baseUniforms(), uPulse: { value: 0 }, uSeed: { value: seed } },
        vertexShader: BELL_VERT,
        fragmentShader: BELL_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const bell = new THREE.Mesh(bellGeo, bellMat);
      group.add(bell);

      const drift = new THREE.Vector2();
      const softMat = (hang, sway) => new THREE.ShaderMaterial({
        uniforms: {
          ...baseUniforms(),
          uSeed: { value: seed },
          uDrift: { value: drift },
          uHang: { value: hang },
          uPulse: { value: 0 },
          uSway: { value: sway },
        },
        vertexShader: ARM_VERT,
        fragmentShader: ARM_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });

      // 口腕4本
      const armMat = softMat(armGeo.userData.hang, 0.16);
      for (let k = 0; k < 4; k++) {
        const arm = new THREE.Mesh(armGeo, armMat);
        const aa = (k / 4) * Math.PI * 2;
        arm.position.set(Math.cos(aa) * 0.14, 0.19, Math.sin(aa) * 0.14);
        arm.rotation.y = aa;
        group.add(arm);
      }

      // 縁の触手(短く細かい房)
      const fringeMat = softMat(fringeGeo.userData.hang, 0.05);
      group.add(new THREE.Mesh(fringeGeo, fringeMat));

      group.scale.setScalar(scale);
      group.renderOrder = 40;

      const jelly = {
        group, bellMat, armMat, fringeMat, drift, seed, scale,
        pos: new THREE.Vector3(
          (Math.random() - 0.5) * 30,
          4 + Math.random() * (WORLD.surfaceY - 8),
          (Math.random() - 0.5) * 30
        ),
        vel: new THREE.Vector3(),
        dir: new THREE.Vector3(0, 1, 0),
        pulseT: Math.random() * 10,
        pulseFreq: 0.45 + Math.random() * 0.25, // 個体差のある拍動周期
        tiltSeed: Math.random() * 10,
      };
      group.position.copy(jelly.pos);
      scene.add(group);
      this.jellies.push(jelly);
    }
    this.time = 0;
    this.world = null;
  }

  setWorld(world) { this.world = world; }

  update(dt) {
    this.time += dt;
    for (const j of this.jellies) {
      j.pulseT += dt * j.pulseFreq;
      const cyc = j.pulseT - Math.floor(j.pulseT); // 0..1

      // 非対称波形: 収縮(0→0.25)は急峻、弛緩(0.25→1)は緩やか
      let pulse;
      if (cyc < 0.25) pulse = Math.sin((cyc / 0.25) * Math.PI * 0.5);
      else pulse = Math.cos(((cyc - 0.25) / 0.75) * Math.PI * 0.5);
      j.bellMat.uniforms.uPulse.value = pulse;
      // 口腕と触手の付け根も傘の収縮に追従させる
      j.armMat.uniforms.uPulse.value = pulse;
      j.fringeMat.uniforms.uPulse.value = pulse;

      // 収縮の立ち上がりで推進力(ジェット)
      const thrust = cyc < 0.25 ? Math.sin((cyc / 0.25) * Math.PI) * 1.6 : 0;

      // 進行方向はゆっくり傾く(ほぼ上向き + ドリフト)
      const t = this.time * 0.15 + j.tiltSeed;
      j.dir.set(
        Math.sin(t) * 0.45 + Math.sin(t * 0.37) * 0.2,
        1.0,
        Math.cos(t * 0.8) * 0.45
      ).normalize();

      j.vel.addScaledVector(j.dir, thrust * dt * j.scale);
      // 沈降(拍動しないと沈む) + 水の抵抗
      j.vel.y -= 0.25 * dt;
      j.vel.multiplyScalar(Math.exp(-1.1 * dt));
      j.pos.addScaledVector(j.vel, dt);

      // 障害物・海底との衝突
      const rBody = 0.85 * j.scale;
      if (this.world) this.world.pushOut(j.pos, rBody, j.vel);
      clampToTerrain(j.pos, rBody + 1.2, j.vel);

      // 領域制限(上下・水平)
      if (j.pos.y > WORLD.surfaceY - 1.5) j.pos.y = WORLD.surfaceY - 1.5;
      if (j.pos.y < 2.5) { j.pos.y = 2.5; j.vel.y = Math.abs(j.vel.y) * 0.3; }
      const r = Math.hypot(j.pos.x, j.pos.z);
      if (r > WORLD.half) {
        j.pos.x *= 0.999; j.pos.z *= 0.999;
        j.vel.x -= j.pos.x / r * 0.2 * dt; j.vel.z -= j.pos.z / r * 0.2 * dt;
      }

      j.group.position.copy(j.pos);
      // 傘の軸を進行方向へゆっくり傾ける
      const targetQuat = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        j.dir.clone().normalize()
      );
      j.group.quaternion.slerp(targetQuat, 1 - Math.exp(-0.8 * dt));

      // 口腕の慣性なびき
      // uDrift は口腕と触手で同じ Vector2 を共有している
      j.drift.set(j.vel.x, j.vel.z);
    }
  }

  get center() {
    return this.jellies[0].pos;
  }
}
