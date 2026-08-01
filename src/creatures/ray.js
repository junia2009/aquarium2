import * as THREE from 'three';
import { baseUniforms, WORLD } from '../env.js';
import { UW_FRAG_PRELUDE, UW_FRAG_OUTPUT } from '../glsl.js';
import { wander1 } from '../noise.js';

// ============ マダラトビエイ ============
// 胸びれ(翼)を羽ばたかせて滑空する rajiform / mobuliform 遊泳。
// 翼端ほど大きく、位相が遅れて波打つ。背面は黒地に白斑、腹面は白。

function buildRayGeometry() {
  const span = 3.2;   // 翼幅(半分)
  const len = 2.6;    // 体長
  const segU = 24;    // 翼方向
  const segV = 16;    // 体軸方向
  const positions = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i <= segV; i++) {
    const v = i / segV;          // 0=鼻先, 1=後端
    for (let j = 0; j <= segU; j++) {
      const u = (j / segU) * 2 - 1; // -1..1 翼方向
      // 翼の平面形: 中央が長く、翼端に向かって後退しつつ細くなる
      const chord = Math.sin(Math.PI * Math.min(Math.max(1.0 - Math.abs(u), 0.001), 1.0) ** 0.7);
      const zFront = len * 0.5 * chord - Math.abs(u) * 0.9;
      const zBack = -len * 0.5 * chord * 0.8 - Math.abs(u) * 1.1;
      const z = zFront + (zBack - zFront) * v;
      const x = u * span;
      // 体の厚み: 中央が盛り上がる
      const y = Math.max(0, chord - 0.25) * 0.28 * Math.sin(Math.PI * (1 - v) * 0.85);
      positions.push(x, y, z);
      uvs.push(u * 0.5 + 0.5, v);
    }
  }
  for (let i = 0; i < segV; i++) {
    for (let j = 0; j < segU; j++) {
      const a = i * (segU + 1) + j;
      const b = a + 1;
      const c = a + segU + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  // 尾(細長い鞭)
  const tailStart = positions.length / 3;
  const tailSegs = 10;
  for (let i = 0; i <= tailSegs; i++) {
    const t = i / tailSegs;
    const w = 0.09 * (1 - t * 0.85);
    positions.push(-w, 0.02, -len * 0.55 - t * 2.4);
    positions.push(w, 0.02, -len * 0.55 - t * 2.4);
    uvs.push(0.48, 1 + t, 0.52, 1 + t);
  }
  for (let i = 0; i < tailSegs; i++) {
    const a = tailStart + i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setIndex(indices);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

export class EagleRay {
  constructor(scene) {
    const geo = buildRayGeometry();
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        ...baseUniforms(),
        uFlap: { value: 0 },
      },
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uFlap; // 羽ばたきの強さ(遊泳速度と連動)
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying vec3 vNormal;
        void main() {
          vUv = uv;
          vec3 p = position;
          float u = uv.x * 2.0 - 1.0;         // -1..1 翼方向
          float wingFrac = pow(abs(u), 1.35);  // 翼端ほど可動
          // 羽ばたき: 翼端が遅れる進行波
          float flap = sin(uTime * 2.1 - wingFrac * 1.8);
          p.y += flap * wingFrac * 1.15 * uFlap;
          // 翼のねじれ(打ち下ろしで前縁が下がる)
          p.z += cos(uTime * 2.1 - wingFrac * 1.8) * wingFrac * 0.22 * uFlap;
          // 体軸方向の緩い波(前進の推進波)+ 尾のなびき
          float tailFrac = max(uv.y - 1.0, 0.0);
          p.x += sin(uTime * 1.4 - uv.y * 2.0) * 0.05 * (uv.y);
          p.x += sin(uTime * 1.8 - tailFrac * 3.5) * 0.28 * tailFrac;
          p.y += sin(uTime * 1.1 - tailFrac * 2.2) * 0.10 * tailFrac;

          vec4 wp = modelMatrix * vec4(p, 1.0);
          vWorldPos = wp.xyz;
          // 法線は近似(羽ばたきの傾きをy軸まわりに反映)
          vec3 n = normal;
          float slope = cos(uTime * 2.1 - wingFrac * 1.8) * 1.35 * pow(abs(u), 0.35) * sign(u) * uFlap;
          n = normalize(vec3(n.x - slope * n.y * 0.6, n.y, n.z));
          vNormal = normalize(mat3(modelMatrix) * n);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: UW_FRAG_PRELUDE + /* glsl */ `
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying vec3 vNormal;
        void main() {
          vec3 n = normalize(vNormal);
          bool top = !gl_FrontFacing; // ジオメトリの巻き順の都合で反転
          if (!top) n = -n;
          vec3 albedo;
          if (top) {
            // 背面: 濃紺に白い斑点(マダラトビエイの特徴)
            albedo = vec3(0.17, 0.20, 0.27);
            vec2 cell = floor(vUv * vec2(26.0, 15.0));
            vec2 f = fract(vUv * vec2(26.0, 15.0)) - 0.5;
            float rnd = hash12(cell);
            float spot = step(0.72, rnd) * smoothstep(0.30, 0.18, length(f + (vec2(rnd, fract(rnd * 7.3)) - 0.5) * 0.4));
            albedo = mix(albedo, vec3(0.9, 0.92, 0.95), spot * step(vUv.y, 1.0));
          } else {
            // 腹面: 白
            albedo = vec3(0.60, 0.64, 0.66);
          }
          vec3 V = normalize(cameraPosition - vWorldPos);
          vec3 col = underwaterLight(albedo, n, vWorldPos, V, 40.0, 0.25);
          col += causticsLight(vWorldPos, n, 0.5) * albedo * 2.0;
          col = applyUnderwaterFog(col, vWorldPos);
          gl_FragColor = vec4(col, 1.0);
          ${UW_FRAG_OUTPUT}
        }
      `,
    });

    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    this.pos = new THREE.Vector3(8, 9, 5);
    this.heading = 0;
    this.speed = 2.4;
    this.seed = 7.7;
    this.time = Math.random() * 100;
    this.bank = 0;
  }

  update(dt) {
    this.time += dt;
    const t = this.time;

    // なめらかな回遊: ノイズで針路を変える
    let turn = wander1(t * 0.07, this.seed) * 0.55;
    // 領域の外に出そうなら中心へ向ける
    const r = Math.hypot(this.pos.x, this.pos.z);
    if (r > WORLD.half * 0.8) {
      const toCenter = Math.atan2(-this.pos.x, -this.pos.z);
      let diff = toCenter - this.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      turn += diff * 0.9;
    }
    turn = THREE.MathUtils.clamp(turn, -0.8, 0.8);
    this.heading += turn * dt;
    this.bank += (THREE.MathUtils.clamp(-turn * 0.9, -0.5, 0.5) - this.bank) * (1 - Math.exp(-2 * dt));

    // 速度のゆらぎ(羽ばたいては滑空する)
    const flapCycle = 0.55 + 0.45 * Math.sin(t * 0.28 + this.seed);
    this.speed = 1.6 + flapCycle * 1.6;
    this.mat.uniforms.uFlap.value = 0.45 + flapCycle * 0.6;

    // 高度もゆっくり変える
    const targetY = 6.5 + wander1(t * 0.05 + 40, this.seed) * 3.5;
    this.pos.y += (targetY - this.pos.y) * (1 - Math.exp(-0.5 * dt));

    this.pos.x += Math.sin(this.heading) * this.speed * dt;
    this.pos.z += Math.cos(this.heading) * this.speed * dt;

    this.mesh.position.copy(this.pos);
    this.mesh.rotation.set(0, this.heading, this.bank, 'YXZ');
    // 上昇・下降でピッチ
    this.mesh.rotation.x = THREE.MathUtils.clamp((targetY - this.pos.y) * 0.15, -0.25, 0.25);
  }
}
