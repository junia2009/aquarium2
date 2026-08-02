import * as THREE from 'three';
import { baseUniforms } from '../env.js';
import { UW_FRAG_PRELUDE, UW_FRAG_OUTPUT } from '../glsl.js';
import { sandHeight } from './seabed.js';

// 岩礁のまわりの群生地。当たり判定(やわらかい障害物)にも使う
export const KELP_CLUSTERS = [
  { x: -14, z: -7, r: 5, n: 22 },
  { x: 13, z: -12, r: 4, n: 14 },
  { x: 3, z: -18, r: 3, n: 10 },
];

// ============ 海藻(ケルプ) ============
// インスタンス化した帯状ポリゴン。頂点シェーダで根本を固定し
// 先端ほど大きく、水流に位相差をつけてなびかせる。
export function createKelp(scene) {
  const H = 9;
  const geo = new THREE.PlaneGeometry(0.55, H, 1, 16);
  geo.translate(0, H / 2, 0); // 根本を原点に

  const count = 46;
  const mesh = new THREE.InstancedMesh(
    geo,
    new THREE.ShaderMaterial({
      uniforms: baseUniforms(),
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        uniform float uTime;
        attribute float aPhase;
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying float vPhase;
        void main() {
          vUv = uv;
          vPhase = aPhase;
          vec3 p = position;
          float hf = p.y / ${H.toFixed(1)};
          float sway = pow(hf, 1.6);
          // 大きなうねり + 細かい揺れ。葉ごとに位相差
          p.x += (sin(uTime * 0.65 + aPhase + hf * 2.2) * 0.9
                + sin(uTime * 1.7 + aPhase * 2.7 + hf * 5.0) * 0.18) * sway;
          p.z += (cos(uTime * 0.5 + aPhase * 1.3 + hf * 1.8) * 0.55) * sway;
          // 帯のねじれ
          p.x += sin(hf * 9.0 + aPhase) * 0.06;

          vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
          vWorldPos = wp.xyz;
          vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: UW_FRAG_PRELUDE + /* glsl */ `
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying float vPhase;
        void main() {
          // 中肋が濃く、縁が明るい半透明の葉
          float rib = smoothstep(0.5, 0.0, abs(vUv.x - 0.5));
          vec3 albedo = mix(vec3(0.10, 0.30, 0.13), vec3(0.05, 0.18, 0.08), rib);
          albedo *= 0.8 + 0.4 * fract(vPhase * 7.31);
          vec3 n = normalize(vNormal);
          if (!gl_FrontFacing) n = -n;
          vec3 V = normalize(cameraPosition - vWorldPos);
          vec3 col = underwaterLight(albedo, n, vWorldPos, V, 24.0, 0.15);
          // 透過光(逆光で葉が透ける)
          float trans = clamp(dot(-n, uSunDir), 0.0, 1.0);
          col += vec3(0.15, 0.4, 0.15) * trans * 0.5 * uSunI * sunReach(vWorldPos);
          col += causticsLight(vWorldPos, n, 0.5) * albedo * 2.0;
          col = applyUnderwaterFog(col, vWorldPos);
          gl_FragColor = vec4(col, 1.0);
          ${UW_FRAG_OUTPUT}
        }
      `,
    }),
    count
  );

  const phases = new Float32Array(count);
  const dummy = new THREE.Object3D();
  const clusters = KELP_CLUSTERS;
  let i = 0;
  for (const c of clusters) {
    for (let k = 0; k < c.n && i < count; k++, i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * c.r;
      const x = c.x + Math.cos(a) * r;
      const z = c.z + Math.sin(a) * r;
      dummy.position.set(x, sandHeight(x, z) - 0.2, z);
      dummy.rotation.y = Math.random() * Math.PI * 2;
      const s = 0.5 + Math.random() * 0.7;
      dummy.scale.set(s, s * (0.7 + Math.random() * 0.5), s);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      phases[i] = Math.random() * Math.PI * 2;
    }
  }
  mesh.count = i;
  geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}

// ============ イソギンチャク(クマノミの家) ============
export function createAnemone(scene, position) {
  const group = new THREE.Group();
  const baseY = sandHeight(position.x, position.z);
  group.position.set(position.x, baseY, position.z);

  // 触手: インスタンス化した細長いカプセル
  const tGeo = new THREE.CylinderGeometry(0.055, 0.10, 1.6, 6, 8);
  tGeo.translate(0, 0.8, 0);
  const count = 72;
  const mesh = new THREE.InstancedMesh(
    tGeo,
    new THREE.ShaderMaterial({
      uniforms: baseUniforms(),
      vertexShader: /* glsl */ `
        uniform float uTime;
        attribute float aPhase;
        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying float vH;
        void main() {
          vec3 p = position;
          float hf = clamp(p.y / 1.6, 0.0, 1.0);
          vH = hf;
          float sway = hf * hf;
          p.x += sin(uTime * 1.1 + aPhase * 3.1) * 0.35 * sway;
          p.z += cos(uTime * 0.9 + aPhase * 5.7) * 0.35 * sway;
          // 先端が膨らむ(イソギンチャクの触手先端)
          float bulge = smoothstep(0.75, 1.0, hf) * 0.6;
          p.xz *= 1.0 + bulge;
          vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
          vWorldPos = wp.xyz;
          vNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: UW_FRAG_PRELUDE + /* glsl */ `
        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying float vH;
        void main() {
          // 根本は褐色、先端は紫がかったピンク(センジュイソギンチャク風)
          vec3 albedo = mix(vec3(0.35, 0.22, 0.14), vec3(0.72, 0.45, 0.62), smoothstep(0.4, 1.0, vH));
          vec3 n = normalize(vNormal);
          vec3 V = normalize(cameraPosition - vWorldPos);
          vec3 col = underwaterLight(albedo, n, vWorldPos, V, 20.0, 0.2);
          // 先端の半透明感
          float fr = pow(1.0 - abs(dot(n, V)), 2.0);
          col += vec3(0.5, 0.3, 0.5) * fr * vH * 0.4;
          col += causticsLight(vWorldPos, n, 0.5) * albedo * 1.5;
          col = applyUnderwaterFog(col, vWorldPos);
          gl_FragColor = vec4(col, 1.0);
          ${UW_FRAG_OUTPUT}
        }
      `,
    }),
    count
  );

  const phases = new Float32Array(count);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    // 半球状に触手を配置
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * 1.5;
    dummy.position.set(Math.cos(a) * r, 0.25 - r * 0.12, Math.sin(a) * r);
    dummy.rotation.set((Math.random() - 0.5) * 0.9 + r * 0.25 * Math.cos(a), 0, (Math.random() - 0.5) * 0.9 - r * 0.25 * Math.sin(a));
    const s = 0.7 + Math.random() * 0.6;
    dummy.scale.setScalar(s);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    phases[i] = Math.random() * Math.PI * 2;
  }
  tGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
  mesh.frustumCulled = false;
  group.add(mesh);

  // 土台
  const base = new THREE.Mesh(
    new THREE.SphereGeometry(1.6, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.5),
    new THREE.MeshStandardMaterial({ color: '#6a4a38', roughness: 0.9 })
  );
  base.scale.y = 0.35;
  group.add(base);

  scene.add(group);
  return group;
}
