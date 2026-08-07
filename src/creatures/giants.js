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
// 実物の特徴で外形を決めるもの:
//   ・頭部が著しく上下に平たく、幅が広い。吻は尖らず角ばって断ち切られている
//   ・口は先端(終端位置)にあり、頭幅いっぱいに横へ広い
//   ・体側に3本の顕著な縦の隆起が走り、最下の1本は尾柄で強い隆起(キール)になる
//   ・胸びれは大きな鎌形で、先端が尖って後ろへ反る
//   ・第一背びれは体の後方6割あたり。第二背びれ・臀びれ・腹びれは小さい
//   ・尾びれは上葉が長い三日月形
//
// 断面: 頭部は超楕円(角ばった平たい箱)、後方へ向かうにつれ普通の楕円へ。
// そこへ3本の隆起をガウス分布で足す。
function whaleSharkSection(x, y, t) {
  // --- 平たい頭 ---
  // 指数nが大きいほど断面は矩形に近づく。ただし上げすぎると角が立って
  // 生き物に見えなくなる(箱に見える)。実物の頭は「平たい」だけで
  // 角は丸いので、超楕円はごく控えめにして、平たさは幅と高さの比で出す。
  const boxy = 1 - THREE.MathUtils.smoothstep(t, 0.04, 0.55);
  const n = 2 + boxy * 0.55;
  const k = Math.pow(Math.pow(Math.abs(x), n) + Math.pow(Math.abs(y), n), -1 / n);
  let sx = x * k, sy = y * k;

  // --- 体側の3本の隆起 ---
  // 頭のうしろから現れ、尾に近いほど際立つ。最下の隆起は尾柄のキールへ続く
  const grow = THREE.MathUtils.smoothstep(t, 0.14, 0.42);
  const rear = 0.55 + 0.45 * THREE.MathUtils.smoothstep(t, 0.45, 0.95);
  const bump = (y0, amp, w) => amp * Math.exp(-Math.pow((y - y0) / w, 2));
  let r = bump(0.78, 0.085, 0.13)    // 背寄りの隆起
        + bump(0.32, 0.095, 0.14)    // 体側中央の隆起
        + bump(-0.18, 0.080, 0.13);  // 下側の隆起(尾柄でキールになる)
  // 尾柄のキールは横へ強く張り出す
  r += bump(-0.18, 0.16, 0.20) * THREE.MathUtils.smoothstep(t, 0.70, 1.0);
  const s = 1 + r * grow * rear;
  return [sx * s, sy * s];
}

export class WhaleShark {
  constructor(scene) {
    const geo = buildFishGeometry({
      // 現生最大の魚類。水槽の主役として堂々とした大きさにする
      length: 14.4, height: 1.65, width: 1.88,
      // 吻は低く始まり、なだらかに胴の高さへ立ち上がる。
      // 先端をいきなり太くすると、前面が一枚の平板になって機械に見える。
      hProfile: [0.42, 0.53, 0.66, 0.79, 0.90, 0.96, 1.00, 1.00,
                 0.97, 0.92, 0.84, 0.73, 0.60, 0.46, 0.32, 0.19],
      // 上から見た吻は「広い弧」。角ではなく丸みで幅を出す
      wProfile: [0.82, 0.91, 0.97, 1.00, 1.00, 0.99, 0.96, 0.92,
                 0.86, 0.79, 0.69, 0.57, 0.44, 0.31, 0.20, 0.12],
      // 頭は体軸より上に乗る(頭の下面はほぼ平ら、腹だけが下へ膨らむ)
      yOffset: [0.28, 0.25, 0.20, 0.15, 0.10, 0.05, 0.02, 0.00,
                0.00, 0.00, 0.00, 0.01, 0.01, 0.02, 0.02, 0.02],
      rings: 40, radial: 30,
      sectionMod: whaleSharkSection,
      // 吻の先は長めのドーム状に閉じる。短いと断ち切った板になってしまう
      nose: { rings: 9, len: 0.058, flat: 2.2 },
      // 上葉の長い三日月形の尾びれ
      tail: { len: 0.18, height: 0.63, fork: 0.50, lobe: 0.42 },
      dorsal: [
        { from: 0.525, to: 0.715, height: 0.82 },        // 第一背びれ(大きい)
        { from: 0.845, to: 0.915, height: 0.26 },        // 第二背びれ(小さい)
      ],
      anal: { from: 0.855, to: 0.925, height: 0.17 },
      pectoral: { at: 0.235, len: 0.33, width: 0.145, shape: 'falcate', chord: 0.60, droop: 0.26 },
      pelvic: { at: 0.64, len: 0.10, width: 0.045, shape: 'falcate', chord: 0.62, droop: 0.30, low: 0.82 },
    });
    this.mat = createFishMaterial({
      pattern: 3,
      len: 14.4,
      // ゆったりした全身のうねり(大型魚ほど尾の振りは遅い)
      swim: { freq: 1.2, amp: 0.05, waveNum: 0.55, headAmp: 0.28, flapFreq: 1.0 },
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    this.cruiser = new GiantCruiser(this.mesh, {
      radius: 19,
      // 下層を回遊する。クジラ(中〜上層)と遊泳層を分けて、
      // 巨体同士がすれ違いざまにめり込むのを防ぐ
      yRange: [3.4, 5.2],
      speed: 1.8,
      seed: 12.3,
      bankScale: 0.5,
      body: 1.9,
      owner: this,
    });
  }

  get pos() { return this.cruiser.pos; }
  get heading() { return this.cruiser.heading; }

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

// ザトウクジラの頭部断面。
// この種の頭は「丸い棒」ではなく、上面が平たく左右に張った板(吻/ロストラム)で、
// その下に丸くふくらんだ下顎と喉がぶら下がる。楕円断面のままだと、
// どれだけ細く絞っても丸い筒の先を削っただけの形にしかならない。
const HEAD_END = 0.36;    // 頭部の範囲(t=0 が吻端)
function humpbackSection(x, y, t) {
  const head = 1 - THREE.MathUtils.smoothstep(t, 0.02, HEAD_END);
  if (head <= 0.001) return [x, y];
  if (y > 0) {
    // 背側だけ超楕円へ寄せて角を張らせる。指数を1より小さくすると
    // 単位円が角丸の矩形に近づき、平たい吻の上面になる
    const p = 1 - 0.40 * head;
    x = Math.sign(x) * Math.pow(Math.abs(x), p);
    y = Math.pow(y, p);
  } else {
    // 腹側(下顎と喉)は丸いまま、わずかに下へ張る
    y *= 1 + 0.12 * head;
  }
  return [x, y];
}

export class HumpbackWhale {
  constructor(scene) {
    const geo = buildFishGeometry({
      // 実測比に寄せた寸法。全長16.5mの成体で、最大体高3.2m・体幅2.5m。
      // 以前はここが5.2m×4.2mあり、頭も胴も飛行船のようになっていた
      length: 16.5, height: 1.68, width: 1.34,
      // 頭は体長の3分の1。吻端はほとんど厚みのない板で、
      // 背の線はそこからほぼ直線に上がる(制御点11個 + Catmull-Rom)
      //   背の線 = yOffset + hProfile / 腹の線 = yOffset - hProfile
      hProfile: [0.16, 0.50, 0.76, 0.92, 0.99, 1.00, 0.98, 0.90, 0.72, 0.45, 0.17],
      wProfile: [0.21, 0.58, 0.83, 0.96, 1.00, 1.00, 0.96, 0.85, 0.63, 0.37, 0.13],
      // 吻へ向かって腹側が背側より速く上がるので、体軸は前ほど高い
      yOffset: [0.15, 0.12, 0.07, 0.03, 0.01, 0.00, 0.01, 0.03, 0.05, 0.06, 0.03],
      smooth: true,
      rings: 40, radial: 24,
      sectionMod: humpbackSection,
      // 吻端は丸く閉じる。ここを既定の一点キャップに任せると、
      // 最前リングがそのまま円錐の底になって鼻先が四角く見える
      nose: { rings: 6, len: 0.022, flat: 3.2 },
      // 水平のフリューク(クジラ類の証)。左右の張りは体長の3分の1
      tail: { len: 0.22, height: 0.78, fork: 0.40, horizontal: true },
      // 背びれは体の3分の2あたりの小さな瘤
      dorsal: { from: 0.63, to: 0.75, height: 0.24 },
      // ザトウクジラの象徴、体長3分の1の長い胸びれ。
      // 既定の胸びれは付け根の弦長が0で、根元が一点に集まった刃になる。
      // この種のひれは板状で幅があるので櫂型を使い、
      // 「後ろへ伸びる」のではなく「横へ張り出す」ようにする
      pectoral: {
        shape: 'flipper', at: 0.31,
        width: 0.290,    // 外への張り出し = 体長の3割(約4.8m)
        len: 0.115,      // 後退量。ザトウは後ろへはあまり寝ない
        chord: 0.072,    // 付け根の弦長 約1.2m
        thick: 0.20,     // 弦長に対する厚み。腕の骨が入っているぶん厚い
        knobs: 10,       // 前縁に並ぶ瘤の数
        knobAmp: 0.095,
        droop: 0.23, low: 0.40,   // 先端が約1.1m下がる
      },
    });
    this.mat = createFishMaterial({
      pattern: 4,
      len: 16.5,
      // 上下方向のストローク。ゆっくり力強く
      swim: { freq: 0.92, amp: 0.055, waveNum: 0.42, headAmp: 0.06, flapFreq: 0.62 },
      vertAxis: 1,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    this.cruiser = new GiantCruiser(this.mesh, {
      radius: 22,
      // 中層から上層。息継ぎのたびにさらに水面近くまで上がる
      yRange: [9.9, 11.9],
      speed: 1.7,
      seed: 44.7,
      bankScale: 0.15, // クジラはあまりバンクしない
      body: 2.7,
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
  get heading() { return this.cruiser.heading; }
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
        // 背が水面を突き抜けないよう、体の厚みぶん余裕を持って浮上する
        targetY = WORLD.surfaceY - 3.1;
        this.cruiser.speed = this.cruiser.baseSpeed * 1.25;
        if (this.pos.y > WORLD.surfaceY - 3.8) {
          this.state = 'blow';
          this.stateTimer = 6 + Math.random() * 3;
          if (this.onBlow) this.onBlow();
        }
        break;
      case 'blow':
        targetY = WORLD.surfaceY - 3.0;
        this.cruiser.speed = this.cruiser.baseSpeed * 0.5;
        if (this.stateTimer <= 0) this.state = 'descend';
        break;
      case 'descend':
        targetY = 10.2;
        this.cruiser.speed = this.cruiser.baseSpeed;
        if (this.pos.y < 11.2) {
          this.state = 'cruise';
          this.stateTimer = 50 + Math.random() * 50;
        }
        break;
    }

    this.cruiser.steer(dt, targetY);

    // 噴気孔(頭頂、鼻先からやや後ろ)から泡
    const u = this.blow.material.uniforms;
    const fwd = new THREE.Vector3(Math.sin(this.cruiser.heading), 0, Math.cos(this.cruiser.heading));
    u.uEmitter.value.copy(this.pos).addScaledVector(fwd, 5.5).add(new THREE.Vector3(0, 2.2, 0));
    u.uHeight.value = Math.max(WORLD.surfaceY - u.uEmitter.value.y, 0.5);
    const targetActive = this.state === 'blow' ? 1 : 0;
    u.uActive.value += (targetActive - u.uActive.value) * (1 - Math.exp(-3 * dt));
  }
}
