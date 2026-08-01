import * as THREE from 'three';
import { baseUniforms } from '../env.js';
import { UW_FRAG_PRELUDE, UW_FRAG_OUTPUT } from '../glsl.js';
import { sandHeight } from '../environment/seabed.js';

// ============ チンアナゴ ============
// 砂底の巣穴から体を出し、流れてくるプランクトンを待つ。
// 捕食者(エイ・カメ)やカメラが近づくと砂へ引っ込み、
// 危険が去るとおそるおそる顔を出す——実物の行動を状態遷移で再現。

const EEL_H = 2.5;

const EEL_VERT = /* glsl */ `
uniform float uTime;
uniform float uSeed;
uniform float uEmerge;   // 0=完全に隠れる 1=全身
uniform vec2 uLean;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vT;        // 0=砂際 1=頭
varying vec3 vLocal;
void main() {
  vec3 p = position;
  float t = clamp(p.y / ${EEL_H.toFixed(1)}, 0.0, 1.0);
  vT = t;
  // 体のくねり: 流れに揺れる + 個体ごとの位相
  float sway = t * t;
  p.x += (sin(uTime * 0.9 + uSeed + t * 2.6) * 0.22
        + sin(uTime * 0.47 + uSeed * 2.3) * 0.12) * sway * ${EEL_H.toFixed(1)} * 0.3;
  p.z += (cos(uTime * 0.71 + uSeed * 1.7 + t * 2.0) * 0.16) * sway * ${EEL_H.toFixed(1)} * 0.3;
  // 定常的な傾き(みんな流れの方を向く)
  p.x += uLean.x * sway * ${EEL_H.toFixed(1)} * 0.35;
  p.z += uLean.y * sway * ${EEL_H.toFixed(1)} * 0.35;
  // 引っ込み: 体全体が砂の下へ沈む
  p.y -= (1.0 - uEmerge) * ${EEL_H.toFixed(1)} * 1.15;
  vLocal = position;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const EEL_FRAG = UW_FRAG_PRELUDE + /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vT;
varying vec3 vLocal;
void main() {
  vec3 n = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);

  // 白地
  vec3 albedo = vec3(0.88, 0.90, 0.86);
  // 細かい黒点(全身にまばら)
  vec2 grid = vec2(atan(vLocal.z, vLocal.x) * 1.2, vLocal.y * 14.0);
  float dots = step(0.80, hash12(floor(grid * 2.2))) * smoothstep(0.42, 0.2, length(fract(grid * 2.2) - 0.5));
  albedo = mix(albedo, vec3(0.12), dots * 0.65);
  // 大きな黒斑2つ(えら付近と体側中央 — チンアナゴの同定ポイント)
  float blotch = smoothstep(0.045, 0.02, abs(vT - 0.88)) + smoothstep(0.04, 0.015, abs(vT - 0.62));
  albedo = mix(albedo, vec3(0.05), clamp(blotch, 0.0, 1.0) * 0.9);
  // 顔: 先端は少し暗く、目
  albedo = mix(albedo, vec3(0.35, 0.36, 0.33), smoothstep(0.94, 1.0, vT) * 0.5);
  float faceAngle = atan(vLocal.x, vLocal.z); // 正面=0
  float eye = smoothstep(0.06, 0.02, abs(vT - 0.965)) *
              (smoothstep(0.30, 0.12, abs(faceAngle - 0.55)) + smoothstep(0.30, 0.12, abs(faceAngle + 0.55)));
  albedo = mix(albedo, vec3(0.02), clamp(eye, 0.0, 1.0));

  vec3 col = underwaterLight(albedo, n, vWorldPos, V, 30.0, 0.2);
  col += causticsLight(vWorldPos, n, 0.7) * albedo * 1.8;
  col = applyUnderwaterFog(col, vWorldPos);
  gl_FragColor = vec4(col, 1.0);
  ${UW_FRAG_OUTPUT}
}
`;

export class GardenEelColony {
  constructor(scene, { center = new THREE.Vector3(6, 0, 12), radius = 6, count = 14 } = {}) {
    this.eels = [];
    this.center = center;
    const geo = new THREE.CylinderGeometry(0.055, 0.075, EEL_H, 10, 28);
    geo.translate(0, EEL_H / 2, 0);

    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      const x = center.x + Math.cos(a) * r;
      const z = center.z + Math.sin(a) * r;
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          ...baseUniforms(),
          uSeed: { value: Math.random() * 20 },
          uEmerge: { value: 1 },
          uLean: { value: new THREE.Vector2(0.25 + Math.random() * 0.15, (Math.random() - 0.5) * 0.2) },
        },
        vertexShader: EEL_VERT,
        fragmentShader: EEL_FRAG,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, sandHeight(x, z) - 0.15, z);
      mesh.rotation.y = Math.random() * Math.PI * 2;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.eels.push({
        mesh, mat,
        emerge: 1,
        target: 1,
        shy: 0.7 + Math.random() * 0.6, // 臆病さの個体差
        peekTimer: 0,
      });
    }
  }

  // threats: [{pos, radius}]
  update(dt, threats = []) {
    for (const e of this.eels) {
      const p = e.mesh.position;
      // 最も近い脅威
      let danger = 0;
      for (const th of threats) {
        const dx = p.x - th.pos.x, dz = p.z - th.pos.z;
        const dy = Math.max(0, th.pos.y - p.y - 2); // 頭上の高さも考慮
        const d = Math.hypot(dx, dz) + dy * 0.5;
        const R = th.radius * e.shy;
        if (d < R) danger = Math.max(danger, 1 - d / R);
      }

      if (danger > 0.15) {
        e.target = Math.max(0, 1 - danger * 1.6); // 深く隠れる
        e.peekTimer = 1.5 + Math.random() * 2.5;  // 危険が去っても暫く警戒
      } else if (e.peekTimer > 0) {
        e.peekTimer -= dt;
        e.target = 0.25; // 顔だけ出して様子見
      } else {
        e.target = 1;
      }

      // 引っ込みは素早く、出てくるのはゆっくり(実物の挙動)
      const rate = e.target < e.emerge ? 6.0 : 0.8;
      e.emerge += (e.target - e.emerge) * (1 - Math.exp(-rate * dt));
      e.mat.uniforms.uEmerge.value = e.emerge;
    }
  }

  scare(point, radius = 8) {
    for (const e of this.eels) {
      const d = e.mesh.position.distanceTo(point);
      if (d < radius) {
        e.target = 0;
        e.emerge = Math.min(e.emerge, 0.4);
        e.peekTimer = 2 + Math.random() * 2;
      }
    }
  }
}
