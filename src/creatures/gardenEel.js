import * as THREE from 'three';
import { baseUniforms } from '../env.js';
import { UW_FRAG_PRELUDE, UW_FRAG_OUTPUT } from '../glsl.js';
import { sandHeight } from '../environment/seabed.js';

// ============ チンアナゴ ============
// 砂底の巣穴から体を出し、流れてくるプランクトンを待つ。
// 体は垂直に立ち上がり、上部が前へ湾曲して顔は流れの方を向く。
// 白地に細かい黒点、体側の大きな黒斑(同定ポイント)、丸い頭と大きな目。
// 捕食者(エイ・カメ・クジラ)やカメラが近づくと砂へ引っ込み、
// 危険が去るとおそるおそる顔を出す。

const EEL_H = 2.3;

// ---- 湾曲した体のジオメトリを手続き生成 ----
// 属性: aT=体軸方向0(砂際)→1(頭の先端), aCirc=周方向0..1(0.25が前), aPart=0体/2目
function buildEelGeometry() {
  const SEG = 44;      // 体軸方向
  const RAD = 12;      // 周方向
  const thetaMax = 1.2; // 上部の前傾(約69°)

  // 半径プロファイル: 胴はわずかに細くなり、頭でふくらんで丸く閉じる
  function radiusAt(s) {
    if (s < 0.80) return 0.075 - s * 0.014;
    if (s < 0.90) return 0.064 + ((s - 0.80) / 0.10) * 0.022;
    const k = (s - 0.90) / 0.10;
    return 0.086 * Math.cos((k * Math.PI) / 2); // 先端で閉じる
  }

  // 経路を積分(下から上へ、上部で+Z方向へ倒れる)
  const path = [];
  let cy = 0, cz = 0;
  for (let i = 0; i <= SEG; i++) {
    const s = i / SEG;
    const bend = THREE.MathUtils.smoothstep(s, 0.60, 1.0);
    const th = thetaMax * Math.pow(bend, 1.35);
    path.push({ y: cy, z: cz, th, s });
    cy += Math.cos(th) * (EEL_H / SEG);
    cz += Math.sin(th) * (EEL_H / SEG);
  }

  const positions = [], normals = [], aT = [], aCirc = [], aPart = [], indices = [];

  for (let i = 0; i <= SEG; i++) {
    const { y, z, th, s } = path[i];
    const r = Math.max(radiusAt(s), 0.001);
    const n2y = -Math.sin(th), n2z = Math.cos(th); // 断面内の前方向
    for (let j = 0; j < RAD; j++) {
      const a = (j / RAD) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      positions.push(ca * r, y + n2y * sa * r, z + n2z * sa * r);
      normals.push(ca, n2y * sa, n2z * sa);
      aT.push(s);
      aCirc.push(j / RAD);
      aPart.push(0);
    }
  }
  for (let i = 0; i < SEG; i++) {
    for (let j = 0; j < RAD; j++) {
      const a = i * RAD + j;
      const b = i * RAD + ((j + 1) % RAD);
      const c = (i + 1) * RAD + j;
      const d = (i + 1) * RAD + ((j + 1) % RAD);
      indices.push(a, c, b, b, c, d);
    }
  }

  // ---- 目: 頭の左右に小さな球体(黒目はシェーダで塗る) ----
  const eyeS = path[Math.round(SEG * 0.90)];
  const eyeR = 0.021;
  const bodyR = radiusAt(0.90);
  for (const side of [-1, 1]) {
    const cx = side * bodyR * 0.82;
    const cyE = eyeS.y + (-Math.sin(eyeS.th)) * bodyR * 0.30 + Math.cos(eyeS.th) * 0.012;
    const czE = eyeS.z + Math.cos(eyeS.th) * bodyR * 0.30 + Math.sin(eyeS.th) * 0.012;
    const base = positions.length / 3;
    const sph = new THREE.SphereGeometry(eyeR, 8, 6);
    const sp = sph.attributes.position, sn = sph.attributes.normal;
    for (let k = 0; k < sp.count; k++) {
      positions.push(cx + sp.getX(k), cyE + sp.getY(k), czE + sp.getZ(k));
      normals.push(sn.getX(k), sn.getY(k), sn.getZ(k));
      aT.push(0.90);
      aCirc.push(0.25);
      aPart.push(2);
    }
    const si = sph.index.array;
    for (let k = 0; k < si.length; k++) indices.push(base + si[k]);
    sph.dispose();
  }

  const geo = new THREE.BufferGeometry();
  geo.setIndex(indices);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('aT', new THREE.Float32BufferAttribute(aT, 1));
  geo.setAttribute('aCirc', new THREE.Float32BufferAttribute(aCirc, 1));
  geo.setAttribute('aPart', new THREE.Float32BufferAttribute(aPart, 1));
  return geo;
}

const EEL_VERT = /* glsl */ `
uniform float uTime;
uniform float uSeed;
uniform float uEmerge;   // 0=完全に隠れる 1=全身
uniform vec2 uLean;
attribute float aT;
attribute float aCirc;
attribute float aPart;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vT;
varying float vCirc;
varying float vPart;
void main() {
  vec3 p = position;
  float t = aT;
  vT = t;
  vCirc = aCirc;
  vPart = aPart;
  // 体のくねり: 流れに揺れる + 個体ごとの位相(頭部は一体で動く)
  float sway = t * t;
  p.x += (sin(uTime * 0.9 + uSeed + t * 2.6) * 0.16
        + sin(uTime * 0.47 + uSeed * 2.3) * 0.09) * sway * ${EEL_H.toFixed(1)} * 0.3;
  p.z += (cos(uTime * 0.71 + uSeed * 1.7 + t * 2.0) * 0.11) * sway * ${EEL_H.toFixed(1)} * 0.3;
  // 定常的な傾き(個体差)
  p.x += uLean.x * sway * ${EEL_H.toFixed(1)} * 0.3;
  p.z += uLean.y * sway * ${EEL_H.toFixed(1)} * 0.3;
  // 引っ込み: 体全体が砂の下へ沈む
  p.y -= (1.0 - uEmerge) * ${EEL_H.toFixed(1)} * 1.35;
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
varying float vCirc;
varying float vPart;

// 周方向の巻き付き距離
float circDist(float c, float target) {
  return abs(fract(c - target + 0.5) - 0.5);
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);

  // ---- 目: 黒目 + ハイライト ----
  if (vPart > 1.5) {
    float fr = pow(clamp(dot(n, V), 0.0, 1.0), 3.0);
    vec3 h = normalize(uSunDir + V);
    float spec = pow(clamp(dot(n, h), 0.0, 1.0), 60.0);
    vec3 eye = vec3(0.015, 0.015, 0.02) + vec3(0.6, 0.7, 0.8) * (spec * 0.9 + fr * 0.08);
    eye = applyUnderwaterFog(eye, vWorldPos);
    gl_FragColor = vec4(eye, 1.0);
    ${UW_FRAG_OUTPUT}
    return;
  }

  // ---- 白地(腹側はわずかに明るい) ----
  vec3 albedo = mix(vec3(0.90, 0.91, 0.87), vec3(0.95, 0.96, 0.93), circDist(vCirc, 0.25) * 2.0);

  // ---- 細かい黒点: 2スケールの小さな丸ドット(実物のごま塩模様) ----
  vec2 g1 = vec2(vCirc * 14.0, vT * 46.0);
  float d1 = step(0.72, hash12(floor(g1) + 3.1))
           * smoothstep(0.30, 0.12, length(fract(g1) - vec2(0.5 + (hash12(floor(g1)) - 0.5) * 0.4)));
  vec2 g2 = vec2(vCirc * 7.0, vT * 20.0);
  float d2 = step(0.62, hash12(floor(g2) + 9.7))
           * smoothstep(0.24, 0.10, length(fract(g2) - vec2(0.5 + (hash12(floor(g2) + 1.0) - 0.5) * 0.4)));
  albedo = mix(albedo, vec3(0.13, 0.13, 0.14), clamp(d1 * 0.8 + d2 * 0.55, 0.0, 0.85));

  // ---- 体側の大きな黒斑(えら付近・体側中央・下部の3つ) ----
  // 実物どおり側面中心。縁はノイズで不定形に
  float wob = (fbm(vec2(vCirc * 6.0, vT * 12.0)) - 0.5) * 0.05;
  float blotch = 0.0;
  // 左右の側面 (circ 0.0 / 0.5) を中心に楕円形
  for (int k = 0; k < 2; k++) {
    float side = float(k) * 0.5;
    float cd = circDist(vCirc, side);
    blotch = max(blotch, 1.0 - smoothstep(0.5, 1.0,
      length(vec2((vT - 0.86 + wob) / 0.050, cd / 0.26))));
    blotch = max(blotch, 1.0 - smoothstep(0.5, 1.0,
      length(vec2((vT - 0.58 + wob) / 0.045, cd / 0.24))));
    blotch = max(blotch, 1.0 - smoothstep(0.5, 1.0,
      length(vec2((vT - 0.30 + wob) / 0.035, cd / 0.20))));
  }
  albedo = mix(albedo, vec3(0.06, 0.06, 0.07), clamp(blotch, 0.0, 1.0) * 0.92);

  // ---- 頭部: 上面はわずかに黄緑がかる。口先は暗く ----
  albedo = mix(albedo, vec3(0.72, 0.74, 0.58),
    smoothstep(0.88, 0.96, vT) * smoothstep(0.35, 0.15, circDist(vCirc, 0.25)) * 0.45);
  albedo = mix(albedo, vec3(0.25, 0.22, 0.20), smoothstep(0.985, 1.0, vT) * 0.7);

  vec3 col = underwaterLight(albedo, n, vWorldPos, V, 34.0, 0.22);
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
    const geo = buildEelGeometry();

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
          uLean: { value: new THREE.Vector2(0.10 + Math.random() * 0.12, (Math.random() - 0.5) * 0.15) },
        },
        vertexShader: EEL_VERT,
        fragmentShader: EEL_FRAG,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, sandHeight(x, z) - 0.12, z);
      // 全員おおむね流れの方(+X)へ顔を向ける。個体差あり
      mesh.rotation.y = Math.PI / 2 + (Math.random() - 0.5) * 0.9;
      const s = 0.85 + Math.random() * 0.3;
      mesh.scale.set(s, s, s);
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
}
