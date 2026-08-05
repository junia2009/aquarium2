import * as THREE from 'three';
import { baseUniforms, WORLD, U } from '../env.js';
import { UW_FRAG_PRELUDE, UW_FRAG_OUTPUT } from '../glsl.js';
import { wander1 } from '../noise.js';

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

  get swarmCenter() {
    _v.set(0, 0, 0);
    for (const j of this.jellies) _v.add(j.group.position);
    return _v.multiplyScalar(1 / this.jellies.length).clone();
  }

  /** 指定点の近くの個体に警報発光を起こす */
  alarmNear(point, radius = 6) {
    let hit = 0;
    for (const j of this.jellies) {
      if (j.group.position.distanceTo(point) < radius) { j.alarm = 0; hit++; }
    }
    return hit;
  }

  /**
   * 視線が通った個体に警報発光を起こす。
   * 「その個体を狙って光を向けた」ことを直接判定するので、
   * 群れの重心のような代理点を経由するより素直に当たる。
   */
  alarmAlongRay(ray, maxPerp = 2.6) {
    let best = null, bestT = Infinity;
    for (const j of this.jellies) {
      _v.copy(j.group.position).sub(ray.origin);
      const t = _v.dot(ray.direction);
      if (t <= 0) continue;
      // 視線からの垂直距離。傘の半径ぶんは余裕を見る
      const perp = Math.sqrt(Math.max(_v.lengthSq() - t * t, 0));
      if (perp < maxPerp + j.scale && t < bestT) { best = j; bestT = t; }
    }
    if (best) { best.alarm = 0; return best.group.position; }
    return null;
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
