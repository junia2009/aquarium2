import * as THREE from 'three';
import { baseUniforms, WORLD } from '../env.js';
import { buildFishGeometry } from './fishGeometry.js';
import { createFishMaterial } from './fishMaterial.js';
import { wander1 } from '../noise.js';
import { clampToTerrain } from '../collision.js';
import { sandHeight } from '../environment/seabed.js';

// ============ バンドウイルカ ============
// 哺乳類なので尾びれは水平で、体を上下にうねらせて泳ぐ。
// 群れ(ポッド)でゆるくまとまり、時おり水面から跳び出す(ブリーチング)。
//
// 水中からの視点では、水面より上に出た体は水面に遮られて見えなくなる。
// これは実際に水中から見上げたときと同じ挙動なので、
// 「水面を突き破って消え、しぶきとともに戻ってくる」という見え方になる。

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _sep = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

const GRAVITY = 9.8;
// プールの実質的な広さ。この外は底がせり上がっていて泳げない
const POOL_LIMIT = 26;

// ============ 種ごとの体型・体色・行動 ============
// 16点のプロファイルで、吻 → メロン → 胴 → 尾柄 の太さの変化を表現する。
export const DOLPHIN_KINDS = {
  // バンドウイルカ: 標準的な体型。短い吻と鎌形の背びれ
  bottlenose: {
    key: 'bottlenose',
    pattern: 5,
    length: 3.4,
    shape: {
      hRatio: 0.148, wRatio: 0.125,
      hProfile: [0.11, 0.15, 0.21, 0.52, 0.80, 0.94, 1.00, 0.99, 0.95, 0.87, 0.75, 0.61, 0.46, 0.32, 0.21, 0.13],
      wProfile: [0.10, 0.14, 0.19, 0.46, 0.74, 0.91, 1.00, 0.99, 0.94, 0.84, 0.70, 0.55, 0.40, 0.27, 0.17, 0.10],
      yOffset: [-0.09, -0.09, -0.07, -0.02, 0.04, 0.07, 0.07, 0.06, 0.04, 0.02, 0.00, -0.01, -0.02, -0.01, 0.0, 0.0],
      tail: { len: 0.20, height: 0.52, fork: 0.46, horizontal: true },
      dorsal: { from: 0.40, to: 0.60, height: 0.62 },
      pectoral: { at: 0.27, len: 0.20, width: 0.075 },
    },
    swim: { freq: 2.6, amp: 0.05, waveNum: 0.55, headAmp: 0.05, flapFreq: 1.4 },
    behavior: { cruise: 3.0, charge: 11.0, launchUp: [8.0, 3.0], launchFwd: 6.5, interval: [24, 36] },
  },

  // シロイルカ: 全身白く、背びれがない(代わりに低い隆起)。
  // 丸く膨らんだメロンとずんぐりした体が特徴で、泳ぎはゆったり。
  beluga: {
    key: 'beluga',
    pattern: 6,
    length: 4.9,
    shape: {
      hRatio: 0.176, wRatio: 0.152,
      hProfile: [0.34, 0.62, 0.85, 0.97, 1.00, 1.00, 0.98, 0.95, 0.90, 0.83, 0.73, 0.61, 0.47, 0.34, 0.22, 0.12],
      wProfile: [0.30, 0.58, 0.82, 0.95, 1.00, 1.00, 0.98, 0.94, 0.88, 0.80, 0.69, 0.56, 0.42, 0.29, 0.18, 0.10],
      yOffset: [0.02, 0.06, 0.09, 0.10, 0.09, 0.07, 0.05, 0.03, 0.01, 0.00, -0.01, -0.02, -0.02, -0.01, 0.0, 0.0],
      tail: { len: 0.21, height: 0.50, fork: 0.42, horizontal: true },
      dorsal: null,                                    // 背びれを持たない
      pectoral: { at: 0.28, len: 0.17, width: 0.085 }, // 丸く小さい胸びれ
    },
    swim: { freq: 1.7, amp: 0.05, waveNum: 0.5, headAmp: 0.06, flapFreq: 1.0 },
    // 大きく穏やか。跳ぶことは稀で、跳んでも低い
    behavior: { cruise: 2.1, charge: 7.0, launchUp: [4.2, 1.4], launchFwd: 4.0, interval: [100, 90] },
  },

  // カマイルカ: 背は黒く腹は白、体側に淡灰色の帯(サスペンダー模様)。
  // 大きく反り返った鎌形の背びれ。小柄で俊敏、よく跳ぶ。
  whiteSided: {
    key: 'whiteSided',
    pattern: 7,
    length: 2.4,
    shape: {
      hRatio: 0.150, wRatio: 0.118,
      hProfile: [0.14, 0.22, 0.50, 0.80, 0.94, 1.00, 1.00, 0.98, 0.94, 0.86, 0.74, 0.60, 0.45, 0.31, 0.20, 0.12],
      wProfile: [0.12, 0.19, 0.45, 0.75, 0.91, 1.00, 1.00, 0.97, 0.92, 0.83, 0.70, 0.55, 0.40, 0.27, 0.17, 0.10],
      yOffset: [-0.07, -0.07, -0.04, 0.01, 0.05, 0.07, 0.07, 0.06, 0.04, 0.02, 0.00, -0.01, -0.02, -0.01, 0.0, 0.0],
      tail: { len: 0.20, height: 0.54, fork: 0.48, horizontal: true },
      dorsal: { from: 0.40, to: 0.62, height: 0.95 },  // 高く反り返る
      pectoral: { at: 0.26, len: 0.19, width: 0.07 },
    },
    swim: { freq: 3.4, amp: 0.055, waveNum: 0.6, headAmp: 0.05, flapFreq: 1.8 },
    // 小柄で俊敏。頻繁に跳ぶ
    behavior: { cruise: 4.6, charge: 13.0, launchUp: [9.0, 3.2], launchFwd: 8.0, interval: [22, 26] },
  },
};

function buildDolphinGeometry(kind) {
  const s = kind.shape;
  return buildFishGeometry({
    length: kind.length,
    height: kind.length * s.hRatio,
    width: kind.length * s.wRatio,
    hProfile: s.hProfile,
    wProfile: s.wProfile,
    yOffset: s.yOffset,
    rings: 34,
    radial: 20,
    tail: s.tail,
    dorsal: s.dorsal,
    pectoral: s.pectoral,
  });
}

// ============ しぶき ============
// 水面を出入りした瞬間に、その場から白い飛沫と泡が広がる。
// 位置と発生時刻をGPUへ渡し、複数のしぶきを一度に扱う。
const SPLASH_SLOTS = 6;

class SplashField {
  constructor(parent) {
    const PER = 90;
    const count = SPLASH_SLOTS * PER;
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const slot = Math.floor(i / PER);
      const a = Math.random() * Math.PI * 2;
      const r = Math.pow(Math.random(), 0.6);
      seeds[i * 4 + 0] = Math.cos(a) * r;      // 横方向
      seeds[i * 4 + 1] = Math.sin(a) * r;
      seeds[i * 4 + 2] = 0.35 + Math.random(); // 初速の個体差
      seeds[i * 4 + 3] = slot;                 // どのしぶきに属するか
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));

    this.origins = [];
    this.times = [];
    for (let i = 0; i < SPLASH_SLOTS; i++) {
      this.origins.push(new THREE.Vector3(0, -999, 0));
      this.times.push(-99);
    }

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        ...baseUniforms(),
        uOrigins: { value: this.origins },
        uTimes: { value: this.times },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uOrigins[${SPLASH_SLOTS}];
        uniform float uTimes[${SPLASH_SLOTS}];
        uniform float uPixelRatio;
        attribute vec4 aSeed;
        varying float vA;
        void main() {
          int slot = int(aSeed.w + 0.5);
          vec3 o = uOrigins[slot];
          float age = uTime - uTimes[slot];
          if (age < 0.0 || age > 1.8) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; return; }
          // 放物線を描いて飛び散り、水中では急速に減速する
          float sp = aSeed.z;
          vec3 p = o;
          p.xz += aSeed.xy * sp * 2.6 * age;
          p.y += sp * 3.2 * age - 0.5 * ${GRAVITY.toFixed(1)} * age * age;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (0.5 + sp * 0.7) * 34.0 * uPixelRatio / max(-mv.z, 0.1);
          vA = (1.0 - age / 1.8) * (1.0 - smoothstep(0.0, 0.25, age) * 0.35);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.12, d) * vA * 0.6;
          gl_FragColor = vec4(vec3(0.85, 0.94, 1.0) * a, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });

    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 62;
    parent.add(this.points);
    this.next = 0;
  }

  burst(pos, time) {
    const i = this.next % SPLASH_SLOTS;
    this.next++;
    this.origins[i].copy(pos);
    this.times[i] = time;
    this.mat.uniforms.uOrigins.value = this.origins;
    this.mat.uniforms.uTimes.value = this.times;
  }
}

// ============ ポッド(群れ) ============
export class DolphinPod {
  constructor(parent, {
    kind = DOLPHIN_KINDS.bottlenose,
    count = 5,
    center = new THREE.Vector3(0, 9, 0),
    radius = 20,
  } = {}) {
    const length = kind.length;
    this.kind = kind;
    this.center = center.clone();
    this.radius = radius;
    this.length = length;
    this.time = 0;
    this.world = null;
    this.onBreach = null;   // ジャンプ時のコールバック(鳴き声など)
    this.neighbors = null;  // 他のポッドを含む全個体(ぶつからないように)

    const geo = buildDolphinGeometry(kind);
    this.mat = createFishMaterial({
      pattern: kind.pattern,
      len: length,
      swim: kind.swim,
      vertAxis: 1,   // 哺乳類なので上下にうねる
    });
    this.mesh = new THREE.InstancedMesh(geo, this.mat, count);
    this.mesh.frustumCulled = false;

    // 個体差(位相・速度・体格)
    const info = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      info[i * 4 + 0] = Math.random() * Math.PI * 2;
      info[i * 4 + 1] = 0.9 + Math.random() * 0.2;
      info[i * 4 + 2] = 0.88 + Math.random() * 0.24;
      info[i * 4 + 3] = Math.random();
    }
    geo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(info, 4));
    parent.add(this.mesh);

    this.splash = new SplashField(parent);

    const iv = kind.behavior.interval;
    this.members = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      this.members.push({
        pos: new THREE.Vector3(
          center.x + Math.cos(a) * radius * 0.5,
          center.y + (Math.random() - 0.5) * 2,
          center.z + Math.sin(a) * radius * 0.5
        ),
        vel: new THREE.Vector3(Math.sin(a + 1.6), 0, Math.cos(a + 1.6)).multiplyScalar(3),
        heading: a + 1.6,
        pitch: 0,
        bank: 0,
        seed: Math.random() * 40,
        state: 'cruise',            // cruise | charge | air
        timer: iv[0] * 0.5 + Math.random() * iv[1],
        wasAbove: false,
        body: length * 0.17,
      });
    }
  }

  setWorld(world) { this.world = world; }

  /** 他のポッドも含めた全個体を渡すと、互いにぶつからなくなる */
  setNeighbors(list) { this.neighbors = list; }

  get podCenter() {
    _v.set(0, 0, 0);
    for (const m of this.members) _v.add(m.pos);
    return _v.multiplyScalar(1 / this.members.length).clone();
  }

  update(dt) {
    this.time += dt;
    const t = this.time;
    const surf = WORLD.surfaceY;
    const bh = this.kind.behavior;
    const others = this.neighbors || this.members;

    for (let i = 0; i < this.members.length; i++) {
      const m = this.members[i];
      m.timer -= dt;

      // ---- 離水判定は水中の移動計算より前に行う ----
      // (後にすると、せっかく与えた打ち上げ速度が遊泳速度で上書きされてしまう)
      if (m.state === 'charge' && m.pos.y > surf - 0.6) {
        m.state = 'air';
        // 外周寄りにいるときは内向きに跳ぶ。そうしないと着水がプールの外になる
        const rr = Math.hypot(m.pos.x - this.center.x, m.pos.z - this.center.z);
        if (rr > this.radius * 0.55) {
          m.heading = Math.atan2(this.center.x - m.pos.x, this.center.z - m.pos.z)
                    + (Math.random() - 0.5) * 1.1;
        }
        m.vel.set(Math.sin(m.heading), 0, Math.cos(m.heading)).multiplyScalar(bh.launchFwd);
        m.vel.y = bh.launchUp[0] + Math.random() * bh.launchUp[1];
        this.splash.burst(m.pos.clone().setY(surf), t);
        if (this.onBreach) this.onBreach();
      }

      if (m.state === 'air') {
        // ---- 空中: 弾道運動。姿勢は速度方向に沿う ----
        m.vel.y -= GRAVITY * dt;
        m.pos.addScaledVector(m.vel, dt);
        // 空中でもプールの外へは出さない(縁で内向きに折り返す)
        const ar = Math.hypot(m.pos.x, m.pos.z);
        if (ar > POOL_LIMIT) {
          const nx = m.pos.x / ar, nz = m.pos.z / ar;
          m.pos.x = nx * POOL_LIMIT;
          m.pos.z = nz * POOL_LIMIT;
          const into = m.vel.x * nx + m.vel.z * nz;
          if (into > 0) { m.vel.x -= 2 * into * nx; m.vel.z -= 2 * into * nz; }
          m.heading = Math.atan2(m.vel.x, m.vel.z);
        }
        if (m.pos.y <= surf && m.vel.y < 0) {
          // 着水
          m.state = 'cruise';
          m.timer = bh.interval[0] + Math.random() * bh.interval[1];
          m.pos.y = surf;
          this.splash.burst(m.pos, t);
          m.vel.multiplyScalar(0.45);
          m.heading = Math.atan2(m.vel.x, m.vel.z);
        }
      } else {
        // ---- 水中 ----
        let targetY;
        let speed;

        if (m.state === 'charge') {
          // 助走: 深く潜ってから水面へ全速力で駆け上がる
          targetY = surf;
          speed = bh.charge;
        } else {
          // 巡航: ポッドでゆるくまとまって回遊する
          targetY = this.center.y + wander1(t * 0.06 + m.seed, m.seed) * 3.0;
          speed = bh.cruise * (1 + wander1(t * 0.1 + m.seed * 2, m.seed) * 0.3);
          if (m.timer <= 0) {
            m.state = 'charge';
            m.timer = 6;
            // 助走のためいったん潜る
            targetY = this.center.y - 3.5;
          }
        }

        // --- 針路: 群れの中心へゆるく寄りつつ、外周で内向きに ---
        let turn = wander1(t * 0.12 + m.seed * 3, m.seed) * 0.7;
        const dx = m.pos.x - this.center.x, dz = m.pos.z - this.center.z;
        const r = Math.hypot(dx, dz);
        if (r > this.radius) {
          const toIn = Math.atan2(-dx, -dz);
          let diff = toIn - m.heading;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          turn += diff * 1.2;
        }
        // 仲間・他種との近接回避(neighbors には全ポッドの個体が入る)
        for (const o of others) {
          if (o === m) continue;
          const ox = m.pos.x - o.pos.x, oz = m.pos.z - o.pos.z;
          const oy = m.pos.y - o.pos.y;
          const near = (m.body + o.body) * 1.9;
          const d2 = ox * ox + oz * oz;
          if (d2 < near * near && Math.abs(oy) < near && d2 > 1e-4) {
            const away = Math.atan2(ox, oz);
            let diff = away - m.heading;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            turn += diff * (1 - Math.sqrt(d2) / near) * 1.6;
          }
        }
        m.heading += THREE.MathUtils.clamp(turn, -1.8, 1.8) * dt;
        m.bank += (THREE.MathUtils.clamp(-turn * 0.5, -0.55, 0.55) - m.bank) * (1 - Math.exp(-3 * dt));

        // 海底の上を保つ
        const floor = sandHeight(m.pos.x, m.pos.z) + m.body + 0.8;
        targetY = Math.max(targetY, floor);
        targetY = Math.min(targetY, surf - (m.state === 'charge' ? 0.0 : m.body + 0.4));

        const dy = targetY - m.pos.y;
        const rate = m.state === 'charge' ? 3.2 : 0.9;
        const vy = THREE.MathUtils.clamp(dy * rate, -speed * 0.8, speed * 0.9);
        m.vel.set(Math.sin(m.heading) * speed, vy, Math.cos(m.heading) * speed);
        m.pos.addScaledVector(m.vel, dt);

        if (this.world) this.world.pushOut(m.pos, m.body, m.vel);
        clampToTerrain(m.pos, m.body + 0.4, m.vel);

        // 針路の回避だけでは至近距離で間に合わないので、最後に位置を押し離す
        for (const o of others) {
          if (o === m || o.state === 'air') continue;
          _sep.copy(m.pos).sub(o.pos);
          const d = _sep.length();
          const min = (m.body + o.body) * 1.05;
          if (d < min && d > 1e-4) m.pos.addScaledVector(_sep.divideScalar(d), (min - d) * 0.5);
        }

        // プールの縁は水中でも越えさせない
        const wr = Math.hypot(m.pos.x, m.pos.z);
        if (wr > POOL_LIMIT) {
          const nx = m.pos.x / wr, nz = m.pos.z / wr;
          m.pos.x = nx * POOL_LIMIT;
          m.pos.z = nz * POOL_LIMIT;
          m.heading = Math.atan2(-nx, -nz) + (Math.random() - 0.5) * 0.6;
        }
      }

      // ---- 姿勢 ----
      _fwd.copy(m.vel);
      if (_fwd.lengthSq() < 1e-6) _fwd.set(Math.sin(m.heading), 0, Math.cos(m.heading));
      _fwd.normalize();
      _up.set(0, 1, 0);
      _right.crossVectors(_up, _fwd);
      if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
      _right.normalize();
      _up.crossVectors(_fwd, _right);
      _m.makeBasis(_right, _up, _fwd);
      // 旋回に応じて体を傾ける
      _q.setFromAxisAngle(_fwd, m.bank);
      _m.premultiply(new THREE.Matrix4().makeRotationFromQuaternion(_q));
      _m.setPosition(m.pos);
      this.mesh.setMatrixAt(i, _m);

      // 水面を横切った瞬間にもしぶき
      const above = m.pos.y > surf;
      if (above !== m.wasAbove && m.state !== 'air') this.splash.burst(m.pos.clone().setY(surf), t);
      m.wasAbove = above;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
