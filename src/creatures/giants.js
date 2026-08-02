import * as THREE from 'three';
import { baseUniforms, WORLD } from '../env.js';
import { buildFishGeometry } from './fishGeometry.js';
import { createFishMaterial } from './fishMaterial.js';
import { wander1 } from '../noise.js';
import { clampToTerrain } from '../collision.js';
import { sandHeight } from '../environment/seabed.js';

const _av = new THREE.Vector3();
const _vel = new THREE.Vector3();
const sandFloor = (p) => sandHeight(p.x, p.z);

// ============ 大型回遊生物 ============
// ジンベエザメ(魚類): 尾びれは縦、体を左右にゆっくりうねらせる
// ザトウクジラ(哺乳類): 尾びれ(フリューク)は水平、体を上下にうねらせ、
//   数十秒〜数分ごとに水面へ上がって呼吸し、泡を吹く

// ---- 汎用のゆったり回遊コントローラ ----
class GiantCruiser {
  constructor(mesh, { radius, yRange, speed, seed, bankScale = 0.4, body = 1.5, owner = null }) {
    this.mesh = mesh;
    this.radius = radius;
    this.yRange = yRange;
    this.baseSpeed = speed;
    this.speed = speed;
    this.seed = seed;
    this.bankScale = bankScale;
    this.body = body;       // 当たり判定の半径
    this.owner = owner;     // 衝突ワールド上の自分自身(除外用)
    this.world = null;
    this.time = Math.random() * 100;
    this.heading = Math.random() * Math.PI * 2;
    this.bank = 0;
    this.pos = new THREE.Vector3(
      Math.cos(this.heading + Math.PI / 2) * radius * 0.7,
      (yRange[0] + yRange[1]) / 2,
      Math.sin(this.heading + Math.PI / 2) * radius * 0.7
    );
    this.targetY = this.pos.y;
  }

  steer(dt, targetYOverride = null) {
    this.time += dt;
    const t = this.time;

    let turn = wander1(t * 0.05, this.seed) * 0.35;
    const r = Math.hypot(this.pos.x, this.pos.z);
    if (r > this.radius) {
      const toCenter = Math.atan2(-this.pos.x, -this.pos.z);
      let diff = toCenter - this.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      turn += diff * 0.55;
    }
    // ---- 障害物の回避: 横向き成分は旋回、上下成分は目標深度に反映 ----
    let avoidY = 0;
    if (this.world) {
      const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
      _vel.set(fx * this.speed, 0, fz * this.speed);
      this.world.avoidForce(this.pos, _vel, this.body, 3.0, _av, this.owner);
      // 右手方向 = (cos h, 0, -sin h)
      const lateral = _av.x * Math.cos(this.heading) - _av.z * Math.sin(this.heading);
      turn += THREE.MathUtils.clamp(lateral * 1.6, -0.8, 0.8);
      avoidY = _av.y;
    }

    turn = THREE.MathUtils.clamp(turn, -0.7, 0.7);
    this.heading += turn * dt;
    this.bank += (THREE.MathUtils.clamp(-turn * this.bankScale * 2.2, -0.35, 0.35) - this.bank)
               * (1 - Math.exp(-1.2 * dt));

    this.targetY = targetYOverride ??
      THREE.MathUtils.lerp(this.yRange[0], this.yRange[1], wander1(t * 0.03 + 33, this.seed) * 0.5 + 0.5);

    // 進行方向の地形を先読みして、迫る海底の上を越える
    const lookY = this.world
      ? this.world.terrainAhead(this.pos, Math.sin(this.heading), Math.cos(this.heading), this.body + this.speed * 2.2)
      : -Infinity;
    const floor = Math.max(sandFloor(this.pos), lookY) + this.body + 0.6;
    this.targetY = Math.max(this.targetY + avoidY * 2.5, floor);

    this.pos.y += (this.targetY - this.pos.y) * (1 - Math.exp(-(targetYOverride ? 0.55 : 0.35) * dt));
    this.pos.x += Math.sin(this.heading) * this.speed * dt;
    this.pos.z += Math.cos(this.heading) * this.speed * dt;

    // ---- めり込みの解消 ----
    if (this.world) this.world.pushOut(this.pos, this.body, null, this.owner);
    clampToTerrain(this.pos, this.body + 0.35);

    this.mesh.position.copy(this.pos);
    const pitch = THREE.MathUtils.clamp((this.targetY - this.pos.y) * -0.12, -0.3, 0.3);
    this.mesh.rotation.set(pitch, this.heading, this.bank, 'YXZ');
  }
}

// ============ ジンベエザメ ============
export class WhaleShark {
  constructor(scene) {
    const geo = buildFishGeometry({
      length: 10, height: 1.45, width: 1.25,
      // 幅広で平たい頭、がっしりした胴、細い尾柄
      hProfile: [0.42, 0.7, 0.92, 1.0, 0.95, 0.8, 0.5, 0.2],
      wProfile: [0.85, 0.95, 1.0, 0.98, 0.85, 0.62, 0.38, 0.16],
      yOffset: [-0.1, 0.0, 0.08, 0.1, 0.08, 0.02, -0.02, 0.0],
      rings: 26, radial: 18,
      // 上葉の長い大きな尾びれ
      tail: { len: 0.30, height: 0.85, fork: 0.55, lobe: 0.4 },
      dorsal: { from: 0.42, to: 0.62, height: 0.55 },
      pectoral: { at: 0.30, len: 0.22, width: 0.07 },
    });
    this.mat = createFishMaterial({
      pattern: 3,
      len: 10,
      // ゆったりした全身のうねり(大型魚は尾の振りが遅い)
      swim: { freq: 1.5, amp: 0.05, waveNum: 0.55, headAmp: 0.28, flapFreq: 1.2 },
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    this.cruiser = new GiantCruiser(this.mesh, {
      radius: 19,
      yRange: [5.5, 9.5],
      speed: 1.7,
      seed: 12.3,
      bankScale: 0.5,
      body: 1.5,
      owner: this,
    });
  }

  get pos() { return this.cruiser.pos; }

  setWorld(world) { this.cruiser.world = world; }

  update(dt) {
    this.cruiser.steer(dt);
  }
}

// ============ ザトウクジラ ============

// 噴気の泡(呼気)。GPUで循環させ、uActiveでフェード
function makeBlowBubbles() {
  const count = 90;
  const seeds = new Float32Array(count * 4);
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    seeds[i * 4 + 0] = (Math.random() - 0.5) * 0.7;
    seeds[i * 4 + 1] = (Math.random() - 0.5) * 0.7;
    seeds[i * 4 + 2] = 2.2 + Math.random() * 2.2;   // 速い上昇(呼気)
    seeds[i * 4 + 3] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...baseUniforms(),
      uEmitter: { value: new THREE.Vector3() },
      uHeight: { value: 3 },
      uActive: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uEmitter;
      uniform float uHeight;
      uniform float uActive;
      uniform float uPixelRatio;
      attribute vec4 aSeed;
      varying float vA;
      void main() {
        float life = fract(aSeed.w + uTime * aSeed.z / max(uHeight, 0.5));
        float y = life * uHeight;
        float wob = 0.10 + y * 0.16;
        vec3 p = uEmitter + vec3(
          aSeed.x * (0.4 + life) + sin(uTime * 3.0 + aSeed.w * 40.0) * wob * 0.4,
          y,
          aSeed.y * (0.4 + life) + cos(uTime * 2.6 + aSeed.w * 31.0) * wob * 0.4
        );
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float size = 0.6 + life * 1.6;
        gl_PointSize = size * 40.0 * uPixelRatio / max(-mv.z, 0.1);
        vA = uActive * smoothstep(0.0, 0.05, life) * (1.0 - smoothstep(0.85, 1.0, life));
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        if (d > 0.5) discard;
        float rim = smoothstep(0.26, 0.48, d);
        float body = smoothstep(0.5, 0.42, d);
        float a = (rim * 0.5 + 0.12) * body * vA;
        gl_FragColor = vec4(vec3(0.8, 0.92, 1.0) * a, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 60;
  return pts;
}

export class HumpbackWhale {
  constructor(scene) {
    const geo = buildFishGeometry({
      length: 12.5, height: 1.9, width: 1.35,
      // 丸く大きな頭部、後方へ滑らかに細くなる
      hProfile: [0.5, 0.85, 1.0, 0.98, 0.85, 0.62, 0.35, 0.14],
      wProfile: [0.6, 0.9, 1.0, 0.95, 0.8, 0.58, 0.32, 0.13],
      yOffset: [-0.05, 0.05, 0.1, 0.08, 0.02, -0.05, -0.08, 0.0],
      rings: 26, radial: 18,
      // 水平のフリューク(クジラ類の証)
      tail: { len: 0.24, height: 0.62, fork: 0.42, horizontal: true },
      // 背びれは小さな瘤状
      dorsal: { from: 0.62, to: 0.74, height: 0.16 },
      // ザトウクジラの象徴、体長1/3の長い胸びれ
      pectoral: { at: 0.30, len: 0.34, width: 0.10 },
    });
    this.mat = createFishMaterial({
      pattern: 4,
      len: 12.5,
      // 上下方向のストローク。ゆっくり力強く
      swim: { freq: 1.15, amp: 0.055, waveNum: 0.42, headAmp: 0.06, flapFreq: 0.7 },
      vertAxis: 1,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    this.cruiser = new GiantCruiser(this.mesh, {
      radius: 22,
      yRange: [8, 11],
      speed: 1.5,
      seed: 44.7,
      bankScale: 0.15, // クジラはあまりバンクしない
      body: 1.9,
      owner: this,
    });

    // 息継ぎサイクル
    this.state = 'cruise';                 // cruise | ascend | blow | descend
    this.stateTimer = 35 + Math.random() * 40;
    this.blow = makeBlowBubbles();
    scene.add(this.blow);
    this.onBlow = null;                    // 呼吸時のコールバック(鳴き声など)
  }

  get pos() { return this.cruiser.pos; }
  get breathing() { return this.state === 'blow'; }

  setWorld(world) { this.cruiser.world = world; }

  update(dt) {
    this.stateTimer -= dt;
    let targetY = null;

    switch (this.state) {
      case 'cruise':
        if (this.stateTimer <= 0) this.state = 'ascend';
        break;
      case 'ascend':
        targetY = WORLD.surfaceY - 1.9;
        this.cruiser.speed = this.cruiser.baseSpeed * 1.25;
        if (this.pos.y > WORLD.surfaceY - 2.6) {
          this.state = 'blow';
          this.stateTimer = 6 + Math.random() * 3;
          if (this.onBlow) this.onBlow();
        }
        break;
      case 'blow':
        targetY = WORLD.surfaceY - 1.8;
        this.cruiser.speed = this.cruiser.baseSpeed * 0.5;
        if (this.stateTimer <= 0) this.state = 'descend';
        break;
      case 'descend':
        targetY = 9;
        this.cruiser.speed = this.cruiser.baseSpeed;
        if (this.pos.y < 10.2) {
          this.state = 'cruise';
          this.stateTimer = 50 + Math.random() * 50;
        }
        break;
    }

    this.cruiser.steer(dt, targetY);

    // 噴気孔(頭頂、鼻先からやや後ろ)から泡
    const u = this.blow.material.uniforms;
    const fwd = new THREE.Vector3(Math.sin(this.cruiser.heading), 0, Math.cos(this.cruiser.heading));
    u.uEmitter.value.copy(this.pos).addScaledVector(fwd, 3.6).add(new THREE.Vector3(0, 1.6, 0));
    u.uHeight.value = Math.max(WORLD.surfaceY - u.uEmitter.value.y, 0.5);
    const targetActive = this.state === 'blow' ? 1 : 0;
    u.uActive.value += (targetActive - u.uActive.value) * (1 - Math.exp(-3 * dt));
  }
}
