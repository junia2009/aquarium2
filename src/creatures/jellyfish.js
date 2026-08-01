import * as THREE from 'three';
import { baseUniforms, WORLD } from '../env.js';
import { UW_UNIFORMS, UW_NOISE, UW_FOG, UW_FRAG_OUTPUT } from '../glsl.js';

// ============ ミズクラゲ ============
// 傘の収縮による拍動遊泳(jet propulsion)。収縮は速く、弛緩は遅い
// 非対称な波形で、収縮の瞬間に推進力を得る——実物の遊泳サイクルを再現。
// 傘の縁ほど大きく動き、口腕は慣性で遅れてなびく。
// 傘の中に透ける四つ葉模様は生殖腺(ミズクラゲの見分けポイント)。

function buildBellGeometry() {
  // 傘の断面プロファイル(r, y)
  const pts = [
    [0.00, 1.00], [0.22, 0.985], [0.42, 0.94], [0.60, 0.86],
    [0.74, 0.75], [0.85, 0.62], [0.93, 0.47], [0.98, 0.30],
    [1.00, 0.14], [0.985, 0.02],
    // 内側へ折り返し
    [0.92, 0.06], [0.78, 0.16], [0.58, 0.26], [0.36, 0.32], [0.12, 0.35], [0.0, 0.355],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const geo = new THREE.LatheGeometry(pts, 40);
  geo.computeVertexNormals();
  return geo;
}

function buildArmGeometry() {
  // 口腕: フリルのある帯
  const geo = new THREE.PlaneGeometry(0.22, 1.5, 3, 20);
  geo.translate(0, -0.75, 0); // 上端を原点に(傘の下から吊る)
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
  float edge = smoothstep(0.25, 1.0, rf);   // 縁ほど動く
  // 収縮: 縁がすぼまり、わずかに持ち上がる
  float squeeze = 1.0 - uPulse * 0.34 * edge;
  p.xz *= squeeze;
  p.y += uPulse * 0.16 * edge;
  // 縁のひらひら(8方向の緩やかな波)
  float a = atan(p.z, p.x);
  p.y += sin(a * 8.0 + uTime * 1.5 + uSeed) * 0.035 * edge;
  float rWob = 1.0 + sin(a * 6.0 - uTime * 1.1 + uSeed * 3.0) * 0.03 * edge;
  p.xz *= rWob;
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
  float fres = pow(1.0 - ndv, 2.2);

  // ほぼ透明な傘。縁と接線方向で白く浮かび上がる
  vec3 col = vec3(0.62, 0.78, 0.92) * 0.10;
  col += vec3(0.75, 0.88, 1.0) * fres * 0.85;

  // 生殖腺(四つ葉): 傘頂近くの4つの円環
  float rf = length(vLocal.xz);
  float a = atan(vLocal.z, vLocal.x);
  float gon = 0.0;
  for (int i = 0; i < 4; i++) {
    float ga = float(i) * 1.5707963 + 0.785;
    vec2 gc = vec2(cos(ga), sin(ga)) * 0.30;
    float d = length(vLocal.xz - gc);
    gon += smoothstep(0.16, 0.10, d) * smoothstep(0.04, 0.09, d);
  }
  gon *= smoothstep(0.55, 0.9, vLocal.y); // 傘の上部のみ
  col += vec3(0.85, 0.7, 0.75) * gon * 0.3;

  // 太陽の透過光(逆光で傘が輝く)
  float trans = clamp(dot(-n, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
  col += vec3(0.5, 0.7, 0.85) * trans * 0.18 * uSunI;

  float alpha = 0.16 + fres * 0.55 + gon * 0.25;
  col = applyUnderwaterFog(col, vWorldPos);
  gl_FragColor = vec4(col, alpha);
  ${UW_FRAG_OUTPUT}
}
`;

const ARM_VERT = /* glsl */ `
uniform float uTime;
uniform float uSeed;
uniform vec2 uDrift;   // 移動速度(xz) — 口腕が慣性で遅れる
varying vec2 vUv;
varying vec3 vWorldPos;
varying vec3 vNormal;
void main() {
  vUv = uv;
  vec3 p = position;
  float hang = clamp(-p.y / 1.5, 0.0, 1.0); // 0=付け根 1=先端
  float lag = hang * hang;
  // 遊泳の反対方向へなびく
  p.x -= uDrift.x * lag * 0.55;
  p.z -= uDrift.y * lag * 0.55;
  // ゆらゆらした揺れ
  p.x += sin(uTime * 1.3 + uSeed + hang * 3.5) * 0.16 * lag;
  p.z += cos(uTime * 1.1 + uSeed * 2.0 + hang * 2.8) * 0.16 * lag;
  // フリル
  p.x += sin(hang * 14.0 + uTime * 2.0 + uSeed) * 0.03;
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
  // 縁のフリル状の透け
  float frill = fbm(vUv * vec2(3.0, 9.0));
  float alpha = (0.12 + fres * 0.3) * smoothstep(0.15, 0.45, frill) * smoothstep(1.0, 0.75, vUv.y);
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

      const armMat = new THREE.ShaderMaterial({
        uniforms: { ...baseUniforms(), uSeed: { value: seed }, uDrift: { value: new THREE.Vector2() } },
        vertexShader: ARM_VERT,
        fragmentShader: ARM_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      // 口腕4本
      for (let k = 0; k < 4; k++) {
        const arm = new THREE.Mesh(armGeo, armMat);
        const aa = (k / 4) * Math.PI * 2;
        arm.position.set(Math.cos(aa) * 0.1, 0.25, Math.sin(aa) * 0.1);
        arm.rotation.y = aa;
        group.add(arm);
      }

      group.scale.setScalar(scale);
      group.renderOrder = 40;

      const jelly = {
        group, bellMat, armMat, seed, scale,
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
  }

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
      j.armMat.uniforms.uDrift.value.set(j.vel.x, j.vel.z);
    }
  }

  get center() {
    return this.jellies[0].pos;
  }
}
