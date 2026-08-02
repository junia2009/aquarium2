import * as THREE from 'three';
import { baseUniforms, WORLD } from '../env.js';
import { UW_FRAG_PRELUDE, UW_FRAG_OUTPUT } from '../glsl.js';
import { wander1 } from '../noise.js';
import { clampToTerrain } from '../collision.js';
import { sandHeight } from '../environment/seabed.js';

const _av = new THREE.Vector3();
const _vel = new THREE.Vector3();

// ============ マダラトビエイ ============
// 胸びれ(翼)を羽ばたかせて滑空する rajiform / mobuliform 遊泳。
// 翼端ほど大きく、位相が遅れて波打つ。背面は黒地に白斑、腹面は白。

function buildRayGeometry() {
  // 実物のマダラトビエイの平面形:
  // 菱形の体盤、前方へ突き出た丸い吻(頭部)、尖った翼端、中央後方から鞭状の尾
  const span = 3.1;   // 翼幅(半分)
  const segU = 30;    // 翼方向
  const segV = 18;    // 体軸方向

  // 前縁: 吻(中央の張り出し)から翼端へ後退
  const zLead = (u) => {
    const a = Math.abs(u);
    return -0.2 + 1.35 * Math.pow(1 - a, 1.2) + 0.5 * Math.exp(-Math.pow(u * 5.5, 2));
  };
  // 後縁: 翼端から中央後方へ
  const zTrail = (u) => {
    const a = Math.abs(u);
    return -0.2 - 1.6 * Math.pow(1 - a, 1.35);
  };
  // 厚み: 胴の中央が盛り上がり、頭部にも膨らみ
  const thick = (u, v) => {
    const a = Math.abs(u);
    let y = 0.30 * Math.pow(Math.max(1 - a * a, 0), 2.2)
          * Math.pow(Math.sin(Math.PI * THREE.MathUtils.clamp(v, 0, 1)), 1.2);
    y += 0.13 * Math.exp(-Math.pow(u * 5.5, 2)) * Math.exp(-(((v - 0.16) / 0.22) ** 2));
    return y;
  };

  const positions = [];
  const uvs = [];
  const aSide = []; // 1=背面シート 0=腹面シート
  const indices = [];

  // 上面・下面の2枚のシートで閉じた体盤を作る(縁で厚み0になり自然に閉じる)
  for (const side of [1, 0]) {
    const base = positions.length / 3;
    for (let i = 0; i <= segV; i++) {
      const v = i / segV; // 0=前縁, 1=後縁
      for (let j = 0; j <= segU; j++) {
        const u = (j / segU) * 2 - 1; // -1..1 翼方向
        const zl = zLead(u);
        const zt = zTrail(u);
        const th = thick(u, v);
        const y = side === 1 ? th : -0.5 * th - 0.015;
        positions.push(u * span, y, zl + (zt - zl) * v);
        uvs.push(u * 0.5 + 0.5, v);
        aSide.push(side);
      }
    }
    for (let i = 0; i < segV; i++) {
      for (let j = 0; j < segU; j++) {
        const a = base + i * (segU + 1) + j;
        const b = a + 1;
        const c = a + segU + 1;
        const d = c + 1;
        if (side === 1) indices.push(a, c, b, b, c, d);
        else indices.push(a, b, c, b, d, c); // 下面は巻き順を反転
      }
    }
  }

  // 尾(体盤後端から連続する細い鞭)
  const rear = zTrail(0);
  const tailStart = positions.length / 3;
  const tailSegs = 12;
  for (let i = 0; i <= tailSegs; i++) {
    const t = i / tailSegs;
    const w = 0.10 * (1 - t * 0.88);
    positions.push(-w, 0.02, rear - t * 2.5);
    positions.push(w, 0.02, rear - t * 2.5);
    uvs.push(0.48, 1 + t, 0.52, 1 + t);
    aSide.push(1, 1);
  }
  for (let i = 0; i < tailSegs; i++) {
    const a = tailStart + i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setIndex(indices);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('aSide', new THREE.Float32BufferAttribute(aSide, 1));
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
        attribute float aSide;
        varying vec2 vUv;
        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying float vSide;
        void main() {
          vUv = uv;
          vSide = aSide;
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
        varying float vSide;
        void main() {
          vec3 n = normalize(vNormal);
          bool top = vSide > 0.5; // 背面シートか腹面シートか
          if (!gl_FrontFacing) n = -n;
          vec3 albedo;
          if (top) {
            // 背面: 黒に近い濃紺。全面に細かい白斑が高密度で均一に散る
            // (マダラトビエイの斑紋は指紋のように個体固有)
            albedo = vec3(0.055, 0.065, 0.09);
            vec2 g = vUv * vec2(46.0, 26.0);
            vec2 cell = floor(g);
            float rnd = hash12(cell);
            vec2 jitter = (vec2(rnd, hash12(cell + 4.7)) - 0.5) * 0.55;
            float spot = step(0.42, rnd)
                       * smoothstep(0.20, 0.11, length(fract(g) - 0.5 - jitter));
            // 大きさに個体差、体盤の縁に向かって少しまばらに
            spot *= 0.7 + hash12(cell + 9.1) * 0.3;
            float edgeFade = smoothstep(1.0, 0.85, abs(vUv.x * 2.0 - 1.0));
            albedo = mix(albedo, vec3(0.88, 0.91, 0.94), spot * step(vUv.y, 1.0) * (0.5 + 0.5 * edgeFade));
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
    this.body = 1.5;   // 当たり判定(翼幅は広いが厚みは薄いので中間を取る)
    this.world = null;
  }

  setWorld(world) { this.world = world; }

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
    // 障害物の回避
    let avoidY = 0;
    if (this.world) {
      _vel.set(Math.sin(this.heading) * this.speed, 0, Math.cos(this.heading) * this.speed);
      this.world.avoidForce(this.pos, _vel, this.body, 2.6, _av, this);
      const lateral = _av.x * Math.cos(this.heading) - _av.z * Math.sin(this.heading);
      turn += THREE.MathUtils.clamp(lateral * 1.8, -0.9, 0.9);
      avoidY = _av.y;
    }

    turn = THREE.MathUtils.clamp(turn, -0.9, 0.9);
    this.heading += turn * dt;
    this.bank += (THREE.MathUtils.clamp(-turn * 0.9, -0.5, 0.5) - this.bank) * (1 - Math.exp(-2 * dt));

    // 速度のゆらぎ(羽ばたいては滑空する)
    const flapCycle = 0.55 + 0.45 * Math.sin(t * 0.28 + this.seed);
    this.speed = 1.6 + flapCycle * 1.6;
    this.mat.uniforms.uFlap.value = 0.45 + flapCycle * 0.6;

    // 高度もゆっくり変える。地形を先読みして海底の上を越える
    let targetY = 6.5 + wander1(t * 0.05 + 40, this.seed) * 3.5 + avoidY * 2.5;
    const ahead = this.world
      ? this.world.terrainAhead(this.pos, Math.sin(this.heading), Math.cos(this.heading), this.body + this.speed * 2.0)
      : -Infinity;
    targetY = Math.max(targetY, Math.max(sandHeight(this.pos.x, this.pos.z), ahead) + this.body + 0.5);
    this.pos.y += (targetY - this.pos.y) * (1 - Math.exp(-0.7 * dt));

    this.pos.x += Math.sin(this.heading) * this.speed * dt;
    this.pos.z += Math.cos(this.heading) * this.speed * dt;

    if (this.world) this.world.pushOut(this.pos, this.body, null, this);
    clampToTerrain(this.pos, this.body * 0.5 + 0.3);

    this.mesh.position.copy(this.pos);
    this.mesh.rotation.set(0, this.heading, this.bank, 'YXZ');
    // 上昇・下降でピッチ
    this.mesh.rotation.x = THREE.MathUtils.clamp((targetY - this.pos.y) * 0.15, -0.25, 0.25);
  }
}
