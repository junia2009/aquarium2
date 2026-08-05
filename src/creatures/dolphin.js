import * as THREE from 'three';
import { baseUniforms, WORLD, U } from '../env.js';
import { buildFishGeometry } from './fishGeometry.js';
import { createFishMaterial } from './fishMaterial.js';
import { wander1 } from '../noise.js';
import { clampToTerrain } from '../collision.js';
import { sandHeight } from '../environment/seabed.js';
import { UW_NOISE } from '../glsl.js';

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
//
// 寸法の決め方に注意。`length` は「吻先から尾柄まで」で、尾びれはその後ろへ
// 伸びるので、鯨類の全長(吻先〜尾びれの切れ込み)は length の 1.078 倍になる。
// 下のコメントの m 表記はすべてこの全長のこと。
//
// 体高・体幅は全長に対する比で決める。ここを大きくすると、長さは同じでも
// 「ずんぐり短い」シルエットになってしまう(実際にそうなっていた)。
// 実物の胴の高さは全長の 0.17〜0.22 程度しかない。
const TAIL_TO_TOTAL = 1.078;   // length → 鯨類の全長
const len = (total) => total / TAIL_TO_TOTAL;

const sstep = (x, e0, e1) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};

// シロイルカの断面変形。楕円のままでは出せない3つの特徴を足す。
//   ・背びれの代わりの稜: 後半身の正中線に低い隆起が走り、こぶ状に波打つ
//   ・尾柄のキール: 尾の手前で断面が横へ張り出し、平たい板のようになる
//   ・メロン: 上半分が横へ張り出し、その下の吻は細い。楕円のままだと
//     真上から見たときに頭が尖って見える
// (x, y) は単位円上の点で y=+1 が背、t は 0=吻 1=尾柄
function belugaSection(x, y, t) {
  const mid = Math.exp(-(x / 0.34) * (x / 0.34));          // 正中線の近くだけ
  const band = sstep(t, 0.40, 0.54) * (1 - sstep(t, 0.90, 1.0));
  const knob = 0.80 + 0.20 * Math.cos(t * 46);             // こぶの波
  const ny = y + 0.13 * mid * Math.max(y, 0) * band * knob;
  const flat = Math.exp(-(y / 0.38) * (y / 0.38));         // 断面の横腹だけ
  let nx = x + 0.13 * flat * x * sstep(t, 0.68, 0.90);
  const head = 1 - sstep(t, 0.06, 0.26);
  const lobe = 0.5 + 0.5 * y;                              // 0=腹 1=背(滑らかに)
  nx *= 1 + head * (0.14 * lobe - 0.16 * (1 - lobe));
  return [nx, ny];
}

export const DOLPHIN_KINDS = {
  // バンドウイルカ: 全長3.7m。標準的な体型。短い吻と鎌形の背びれ
  bottlenose: {
    key: 'bottlenose',
    pattern: 5,
    length: len(3.70),
    shape: {
      // 胴高 = 全長の 0.185 / 胴幅 = 0.155
      hRatio: 0.100, wRatio: 0.084,
      hProfile: [0.07, 0.22, 0.42, 0.72, 0.90, 0.98, 1.00, 0.99, 0.95, 0.89, 0.81, 0.71, 0.60, 0.49, 0.40, 0.33],
      wProfile: [0.06, 0.19, 0.38, 0.68, 0.88, 0.97, 1.00, 0.98, 0.93, 0.85, 0.75, 0.63, 0.50, 0.38, 0.28, 0.21],
      yOffset: [-0.14, -0.13, -0.10, -0.03, 0.05, 0.10, 0.10, 0.09, 0.06, 0.03, 0.00, -0.02, -0.03, -0.02, 0.0, 0.0],
      tail: { len: 0.20, height: 0.52, fork: 0.46, horizontal: true },
      dorsal: { from: 0.38, to: 0.76, height: 1.40 },
      pectoral: { at: 0.27, len: 0.18, width: 0.070 },
    },
    swim: { freq: 2.6, amp: 0.05, waveNum: 0.55, headAmp: 0.05, flapFreq: 1.4 },
    behavior: { cruise: 3.0, charge: 11.0, launchUp: [8.0, 3.0], launchFwd: 6.5, interval: [24, 36] },
  },

  // シロイルカ: 全長5.0m で最大。全身白く、背びれがない(代わりに低い隆起)。
  // 実物は「太った水滴」ではなく、はっきり筋肉質で凹凸がある。
  //   ・丸く張り出したメロン(額)が独立した山になっていて、その後ろが少しくびれる
  //     (頸椎が癒合していないので、鯨類には珍しく本当に「首」がある)
  //   ・くびれの後ろで胸がぐっと太くなる
  //   ・背びれの代わりに、後半身の正中線を低い稜が走る。こぶ状に波打つ
  //   ・尾柄が深く、側面にキールがある
  beluga: {
    key: 'beluga',
    pattern: 6,
    length: len(5.00),
    shape: {
      // 3種のなかで最も太い。胴高は全長の 0.234 / 胴幅 0.203
      hRatio: 0.126, wRatio: 0.109,
      //          吻    メロン →   頂点  首    胸 →  最大 ...................  尾柄
      hProfile: [0.52, 0.86, 0.94, 0.91, 0.87, 0.96, 1.00, 1.00, 0.99, 0.97, 0.93, 0.87, 0.79, 0.70, 0.59, 0.48],
      wProfile: [0.46, 0.80, 0.88, 0.86, 0.81, 0.93, 1.00, 1.00, 0.99, 0.96, 0.91, 0.83, 0.73, 0.62, 0.50, 0.39],
      // メロンは上へ張り出し、口は下に残る。ここを寝かせると額の丸みが消える
      yOffset: [0.22, 0.26, 0.27, 0.24, 0.15, 0.07, 0.02, 0.00, -0.01, -0.02, -0.02, -0.02, -0.02, -0.01, 0.0, 0.0],
      sectionMod: belugaSection,
      smooth: true,   // メロンの折れを出さない
      // 吻先は「短く丸い蓋」。伸ばすと円錐になってメロンが台無しになるので、
      // キャップの長さは付け根の半径よりはっきり短くすること
      nose: { rings: 7, len: 0.022, flat: 3.4 },
      tail: { len: 0.21, height: 0.42, fork: 0.34, horizontal: true },
      dorsal: null,                                    // 背びれを持たない(稜は断面で作る)
      // 幅広く丸い櫂。成体は先端が上へ反る(droop を負にする)
      pectoral: { shape: 'paddle', at: 0.30, len: 0.050, width: 0.130,
                  chord: 0.075, droop: -0.55, low: 0.42 },
    },
    swim: { freq: 1.7, amp: 0.05, waveNum: 0.5, headAmp: 0.06, flapFreq: 1.0 },
    // 大きく穏やか。跳ぶことは稀で、跳んでも低い
    behavior: { cruise: 2.1, charge: 7.0, launchUp: [4.2, 1.4], launchFwd: 4.0, interval: [100, 90] },
  },

  // カマイルカ: 全長2.5m で最小。背は黒く腹は白、体側に淡灰色の帯。
  // 大きく反り返った鎌形の背びれ。小柄で俊敏、よく跳ぶ。
  whiteSided: {
    key: 'whiteSided',
    pattern: 7,
    length: len(2.50),
    shape: {
      // 3種のなかで最も細身。胴高は全長の 0.170
      hRatio: 0.092, wRatio: 0.075,
      hProfile: [0.10, 0.26, 0.52, 0.80, 0.94, 1.00, 1.00, 0.98, 0.94, 0.88, 0.80, 0.70, 0.59, 0.48, 0.39, 0.32],
      wProfile: [0.09, 0.23, 0.48, 0.76, 0.92, 0.99, 1.00, 0.97, 0.92, 0.84, 0.75, 0.64, 0.52, 0.40, 0.30, 0.22],
      yOffset: [-0.11, -0.10, -0.06, 0.01, 0.07, 0.10, 0.10, 0.09, 0.06, 0.03, 0.00, -0.02, -0.03, -0.02, 0.0, 0.0],
      tail: { len: 0.20, height: 0.62, fork: 0.48, horizontal: true },
      dorsal: { from: 0.38, to: 0.79, height: 1.90 },  // 高く反り返る
      pectoral: { at: 0.26, len: 0.17, width: 0.065 },
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
    rings: 40,
    radial: 22,
    sectionMod: s.sectionMod ?? null,
    nose: s.nose ?? null,
    smooth: !!s.smooth,
    tail: s.tail,
    dorsal: s.dorsal,
    pectoral: s.pectoral,
  });
}

// ============ しぶき ============
// 水面を出入りした瞬間の水柱・飛沫と、そのあと水面に残って広がる泡の輪。
// 位置・発生時刻・規模をGPUへ渡し、複数のしぶきを一度に扱う。
//
// 実際の跳躍では、離水より着水のほうがはるかに派手になる。
// 離水は体が水を持ち上げるだけだが、着水は落下のエネルギーが一気に
// 水面へ移るためで、burst() の strength でその差をつけている。
const SPLASH_SLOTS = 10;

// 水面のうねり。水面シェーダと同じ式で、泡の輪を波に乗せるために使う
const SWELL_GLSL = /* glsl */ `
float splashSwell(vec2 p, float t){
  return sin(p.x * 0.11 + t * 0.7) * 0.35
       + sin(dot(p, vec2(0.07, 0.09)) + t * 0.5) * 0.45
       + sin(dot(p, vec2(-0.13, 0.05)) + t * 0.9) * 0.2;
}
`;

class SplashField {
  constructor(parent) {
    this.origins = [];
    this.times = [];
    this.strength = [];
    for (let i = 0; i < SPLASH_SLOTS; i++) {
      this.origins.push(new THREE.Vector3(0, -999, 0));
      this.times.push(-99);
      this.strength.push(0);
    }
    const shared = {
      ...baseUniforms(),
      uOrigins: { value: this.origins },
      uTimes: { value: this.times },
      uStrength: { value: this.strength },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    };

    // ---------- 飛沫の粒 ----------
    const PER = 260;
    const count = SPLASH_SLOTS * PER;
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 4);
    const jit = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      // 中心ほど密に。水柱の芯と外へ散る飛沫を一度に表す
      const r = Math.pow(Math.random(), 0.75);
      seeds[i * 4 + 0] = Math.cos(a) * r;
      seeds[i * 4 + 1] = Math.sin(a) * r;
      seeds[i * 4 + 2] = 0.30 + Math.random();       // 初速の個体差
      seeds[i * 4 + 3] = Math.floor(i / PER);        // 所属するしぶき
      // 中心に近い粒ほど高く上がり(水柱)、外の粒は低く飛ぶ(飛沫)
      jit[i * 2 + 0] = (1.0 - r) * (0.5 + Math.random() * 0.8);
      jit[i * 2 + 1] = Math.random();                // 粒の大きさ
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    geo.setAttribute('aJit', new THREE.BufferAttribute(jit, 2));

    this.mat = new THREE.ShaderMaterial({
      uniforms: shared,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uSurfaceY;
        uniform vec3 uOrigins[${SPLASH_SLOTS}];
        uniform float uTimes[${SPLASH_SLOTS}];
        uniform float uStrength[${SPLASH_SLOTS}];
        uniform float uPixelRatio;
        attribute vec4 aSeed;
        attribute vec2 aJit;
        varying float vA;
        varying float vFoam;
        void main() {
          int slot = int(aSeed.w + 0.5);
          float age = uTime - uTimes[slot];
          float st = uStrength[slot];
          float life = 1.5 + 1.1 * aJit.y;
          if (age < 0.0 || age > life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; return; }

          float sp = aSeed.z;
          vec3 p = uOrigins[slot];
          // 横へは空気抵抗で減速しながら散る(∫v·e^(-kt)dt = v/k·(1-e^(-kt)))
          float horiz = sp * (2.7 + 3.4 * st);
          p.xz += aSeed.xy * horiz / 2.2 * (1.0 - exp(-2.2 * age));
          // 上へは弾道。芯の粒ほど高く上がって水柱になる
          float up = (1.4 + 4.2 * aJit.x) * (0.55 + 0.75 * st) * sp;
          p.y += up * age - 0.5 * ${GRAVITY.toFixed(1)} * age * age;

          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          // 水塊は大きく、細かい飛沫は小さく
          float rad = (0.10 + aJit.y * 0.22) * (0.7 + 0.6 * st);
          gl_PointSize = rad * 1200.0 * uPixelRatio / max(-mv.z, 0.5);

          vA = pow(1.0 - age / life, 1.3);
          // 落ちて水面より下へ入った粒は消える
          vA *= smoothstep(-0.9, 0.1, p.y - uSurfaceY);
          vA *= 0.55 + 0.75 * st;
          // 立ち上がりの一瞬は白く濃い水塊、あとは薄い霧
          vFoam = 1.0 - smoothstep(0.0, 0.45, age);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vA;
        varying float vFoam;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          if (d > 0.5) discard;
          // 芯が濃く縁がぼける粒。白い水塊のときはより締まった形に
          float core = smoothstep(0.5, mix(0.22, 0.05, vFoam), d);
          float a = core * vA * (0.24 + 0.44 * vFoam);
          vec3 col = mix(vec3(0.80, 0.90, 1.0), vec3(1.0, 1.0, 1.0), vFoam);
          gl_FragColor = vec4(col * a, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 62;
    parent.add(this.points);

    // ---------- 水面に残る泡の輪 ----------
    // 粒だけだと一瞬で終わってしまう。実際は着水のあと数秒、
    // 白い泡が輪になって広がりながら消えていく。上空から見ると特に目立つ。
    const base = new THREE.PlaneGeometry(1, 1);
    base.rotateX(-Math.PI / 2);
    const ring = new THREE.InstancedBufferGeometry();
    ring.index = base.index;
    ring.setAttribute('position', base.attributes.position);
    ring.setAttribute('uv', base.attributes.uv);
    ring.instanceCount = SPLASH_SLOTS;
    ring.setAttribute(
      'aSlot',
      new THREE.InstancedBufferAttribute(Float32Array.from({ length: SPLASH_SLOTS }, (_, i) => i), 1)
    );

    this.foamMat = new THREE.ShaderMaterial({
      uniforms: shared,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexShader: UW_NOISE + SWELL_GLSL + /* glsl */ `
        uniform float uTime;
        uniform float uSurfaceY;
        uniform vec3 uOrigins[${SPLASH_SLOTS}];
        uniform float uTimes[${SPLASH_SLOTS}];
        uniform float uStrength[${SPLASH_SLOTS}];
        attribute float aSlot;
        varying vec2 vUv;
        varying float vAge;
        varying float vSt;
        void main() {
          int s = int(aSlot + 0.5);
          float age = uTime - uTimes[s];
          vSt = uStrength[s];
          vAge = age;
          vUv = uv;
          if (age < 0.0 || age > 3.2) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          // 広がる速度は最初が速く、だんだん鈍る
          float R = (1.1 + 4.2 * vSt) * (0.45 + 1.9 * (1.0 - exp(-1.5 * age)));
          vec3 o = uOrigins[s];
          vec3 p = vec3(o.x + position.x * R * 2.0, 0.0, o.z + position.z * R * 2.0);
          // 泡は水面に浮くので、うねりに乗せる
          p.y = uSurfaceY + splashSwell(p.xz, uTime) + 0.05;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: UW_NOISE + /* glsl */ `
        varying vec2 vUv;
        varying float vAge;
        varying float vSt;
        void main() {
          vec2 c = (vUv - 0.5) * 2.0;
          float d = length(c);
          if (d > 1.0) discard;
          // 縁が濃く中が抜けた輪。時間とともに輪が細く外へ寄る
          float inner = 0.20 + vAge * 0.30;
          float band = smoothstep(1.0, 0.80, d) * smoothstep(inner, inner + 0.42, d);
          // ちぎれた泡らしく、まだらに抜く
          float n = fbm(c * 5.0 + vec2(vAge * 0.5, -vAge * 0.35));
          float a = band * smoothstep(0.30, 0.72, n) * (1.0 - smoothstep(0.7, 3.2, vAge));
          a *= 0.30 + 0.85 * vSt;
          gl_FragColor = vec4(vec3(0.97, 0.99, 1.0) * a, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this.foam = new THREE.Mesh(ring, this.foamMat);
    this.foam.frustumCulled = false;
    this.foam.renderOrder = 61;
    parent.add(this.foam);

    this.next = 0;
  }

  /**
   * strength: 0.4=離水 / 1.0=着水。体が大きいほど大きく。
   * time は必ずシェーダの uTime と同じ時計(U.uTime.value)を渡すこと。
   * ポッドの経過時間を渡すと、ゾーンを構築した時刻ぶんずれて
   * 常に寿命切れと判定され、しぶきが一切描かれなくなる。
   */
  burst(pos, time, strength = 1.0) {
    const i = this.next % SPLASH_SLOTS;
    this.next++;
    this.origins[i].copy(pos);
    this.times[i] = time;
    this.strength[i] = strength;
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
    // しぶきの規模は体の大きさに比例させる(バンドウイルカの3.4mを1.0とする)
    this.bodyScale = length / 3.4;
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
        aimIn: false,               // 助走中、内向きへ向き直している最中か
        launchJitter: 0,            // 跳ぶ向きの個体差(助走の開始時に決める)
        diveT: 0,                   // 助走で潜っている残り時間
        entryVel: new THREE.Vector3(),  // 着水した瞬間の速度
        recover: 0,                 // 着水の勢いが抜けるまでの残り時間
        chargeRamp: 0,              // 巡航→助走の加速の立ち上がり
        chargeSpeed0: 0,            // 助走に入った瞬間の速さ
        climb: false,               // 助走の上昇区間に入ったか
        climbRamp: 0,               // 離水時の速度ベクトルへ寄せる進み具合
        climbPitch0: 0,             // 上昇に入った瞬間の仰角
        climbSpeed0: 0,             // 上昇に入った瞬間の速さ
        launchVy: 0,                // 跳び上がる初速(助走の開始時に決める)
        launchFwd: 0,               // 跳ぶときの前進速度(助走中にプール内へ詰める)
        wasAbove: false,
        body: length * 0.17,
      });
    }
  }

  setWorld(world) { this.world = world; }

  /** 他のポッドも含めた全個体を渡すと、互いにぶつからなくなる */
  setNeighbors(list) { this.neighbors = list; }

  /**
   * 今の位置・向きのまま跳んだとき、着水がプールに収まる最大の前進速度。
   * |pos + s·dir| = R を s について解いて、許される水平移動距離を出す。
   */
  maxLaunchFwd(m) {
    const flight = 2 * m.launchVy / GRAVITY;
    const dx = Math.sin(m.heading), dz = Math.cos(m.heading);
    const R = POOL_LIMIT * 0.95;
    const pd = m.pos.x * dx + m.pos.z * dz;
    const disc = pd * pd - (m.pos.x * m.pos.x + m.pos.z * m.pos.z) + R * R;
    const s = disc > 0 ? Math.max(-pd + Math.sqrt(disc), 0) : 0;
    return s / Math.max(flight, 0.01);
  }

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
      if (m.state === 'charge' && m.climb && m.vel.y > 0 && m.pos.y > surf - 0.6) {
        m.state = 'air';
        // 速度は助走からそのまま引き継ぐ。ここで作り直してはいけない。
        // 上昇の終わりで既に離水と同じ向き・速さになっている。
        // 離水は体が水を押し上げるだけなので、着水よりは控えめ
        this.splash.burst(m.pos.clone().setY(surf), U.uTime.value, this.bodyScale * 0.55);
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
          m.climb = false;
          m.timer = bh.interval[0] + Math.random() * bh.interval[1];
          m.pos.y = surf;
          // 着水は落下のエネルギーが一気に水面へ移るので派手になる。
          // 落下速度が速いほど大きく上がる
          const impact = Math.min(Math.abs(m.vel.y) / 9.0, 1.4);
          this.splash.burst(m.pos, U.uTime.value, this.bodyScale * (0.75 + 0.55 * impact));
          m.vel.multiplyScalar(0.45);
          m.heading = Math.atan2(m.vel.x, m.vel.z);
          // 水に入った勢いはしばらく残る。次のフレームで巡航速度へ作り直すと
          // 姿勢が1フレームで水平に跳ねるので、0.5秒かけて戻す
          m.entryVel.copy(m.vel);
          m.recover = 0.5;
        }
      } else {
        // ---- 水中 ----
        let targetY;
        let speed;

        if (m.state === 'charge') {
          // 助走: いったん深く潜り、そこから水面へ斜めに駆け上がる。
          // 潜る区間を確保しておかないと、跳ぶ向きと角度へ整える余裕がない。
          //
          // 巡航から一気に全速へ切り替えると、速さも仰角もそこで飛ぶ
          // (巡航3m/s・水平 → 助走11m/s・下向き38度)。加速も潜り角も
          // 0.8秒かけて立ち上げる。
          m.chargeRamp = Math.min(m.chargeRamp + dt / 0.8, 1);
          speed = m.chargeSpeed0 + (bh.charge - m.chargeSpeed0)
                * (m.chargeRamp * m.chargeRamp * (3 - 2 * m.chargeRamp));
          targetY = this.center.y - 3.5;
          if (!m.climb) {
            m.diveT -= dt;
            // 十分潜ったら上昇へ。ここから離水時の速度ベクトルへ寄せていく
            if (m.pos.y < surf - 6.0 || m.diveT <= 0) {
              m.climb = true;
              m.climbRamp = 0;
              m.climbPitch0 = Math.atan2(m.vel.y, Math.hypot(m.vel.x, m.vel.z));
              m.climbSpeed0 = m.vel.length();
            }
          }
          // 助走が長引きすぎたら諦めて巡航に戻す(水面へ出られない状況の保険)
          if (m.timer <= 0) { m.state = 'cruise'; m.climb = false; m.timer = bh.interval[0]; }
        } else {
          // 巡航: ポッドでゆるくまとまって回遊する
          targetY = this.center.y + wander1(t * 0.06 + m.seed, m.seed) * 3.0;
          speed = bh.cruise * (1 + wander1(t * 0.1 + m.seed * 2, m.seed) * 0.3);
          if (m.timer <= 0) {
            m.state = 'charge';
            m.timer = 10;
            m.aimIn = false;
            m.climb = false;
            m.chargeRamp = 0;
            m.chargeSpeed0 = m.vel.length();
            m.launchJitter = (Math.random() - 0.5) * 0.9;
            m.diveT = 1.2;   // 潜っている時間。この間に跳ぶ向きへ向き直る
            // 跳ぶ勢いはここで決めてしまう。助走中に着水点を正しく読むため
            m.launchVy = bh.launchUp[0] + Math.random() * bh.launchUp[1];
            m.launchFwd = bh.launchFwd;
            targetY = this.center.y - 3.5;
          }
        }

        let turn;
        if (m.state === 'charge') {
          // --- 助走中の針路 ---
          // 跳ぶ向きは、水面を割る瞬間ではなく助走のあいだに決める。
          // このまま跳んだら着水がプールの外になるとわかった時点で
          // 内向きへ舵を切りはじめ、離水までに向き直っておく。
          // (離水時に heading を代入すると、水面で体が一瞬でねじれる)
          const reach = m.launchFwd * 2 * m.launchVy / GRAVITY;
          const lx = m.pos.x + Math.sin(m.heading) * reach;
          const lz = m.pos.z + Math.cos(m.heading) * reach;
          // いったん内向きに決めたら助走中は戻さない(境界でふらつかせない)
          if (Math.hypot(lx, lz) > POOL_LIMIT * 0.72) m.aimIn = true;
          if (m.aimIn) {
            const want = Math.atan2(this.center.x - m.pos.x, this.center.z - m.pos.z) + m.launchJitter;
            let diff = want - m.heading;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            turn = diff * 3.0;
          } else {
            turn = 0;   // まっすぐ助走する
          }
        } else {
          // --- 巡航の針路: 群れの中心へゆるく寄りつつ、外周で内向きに ---
          turn = wander1(t * 0.12 + m.seed * 3, m.seed) * 0.7;
          const dx = m.pos.x - this.center.x, dz = m.pos.z - this.center.z;
          const r = Math.hypot(dx, dz);
          if (r > this.radius) {
            const toIn = Math.atan2(-dx, -dz);
            let diff = toIn - m.heading;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            turn += diff * 1.2;
          }
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

        if (m.state === 'charge' && m.climb) {
          // ---- 助走の上昇: 離水時の速度ベクトルへ滑らかに寄せる ----
          // ここを targetY(= 水面)で駆動してはいけない。水面へ近づくほど
          // 残り距離が 0 に収束して上昇が緩み、水面直下ではほぼ水平になる。
          // その状態から離水時に打ち上げ速度を代入すると、1フレームで
          // 仰角が 0° → 55° へ跳ね、速さも落ちて不自然な飛び出しになる。
          // 実際のイルカは、水面を割る前からもう跳ぶ角度で上がってきている。
          m.climbRamp = Math.min(m.climbRamp + dt / 0.6, 1);
          const e = m.climbRamp * m.climbRamp * (3 - 2 * m.climbRamp);
          // 着水がプールに収まるよう前進の勢いだけ詰める(向き・角度は変えない)。
          // 助走中にじわじわ効かせるので、離水の瞬間に飛ぶことはない
          const fwdCap = this.maxLaunchFwd(m);
          m.launchFwd += THREE.MathUtils.clamp(fwdCap - m.launchFwd, -14 * dt, 14 * dt);
          m.launchFwd = Math.min(m.launchFwd, bh.launchFwd);
          const pitchL = Math.atan2(m.launchVy, m.launchFwd);
          const spdL = Math.hypot(m.launchVy, m.launchFwd);
          const pitch = m.climbPitch0 + (pitchL - m.climbPitch0) * e;
          const spd = m.climbSpeed0 + (spdL - m.climbSpeed0) * e;
          const ch = Math.cos(pitch) * spd;
          m.vel.set(Math.sin(m.heading) * ch, Math.sin(pitch) * spd, Math.cos(m.heading) * ch);
        } else {
          // 海底の上を保つ
          const floor = sandHeight(m.pos.x, m.pos.z) + m.body + 0.8;
          targetY = Math.max(targetY, floor);
          targetY = Math.min(targetY, surf - (m.state === 'charge' ? 0.0 : m.body + 0.4));

          const dy = targetY - m.pos.y;
          const rate = m.state === 'charge' ? 3.2 : 0.9;
          // 潜り角も加速と同じ立ち上がりにする。速さだけ滑らかにしても、
          // 下向きの制限が速さに比例したままだと仰角は一瞬で最大まで振れる
          const down = speed * 0.8 * (m.state === 'charge' ? m.chargeRamp : 1);
          const vy = THREE.MathUtils.clamp(dy * rate, -down, speed * 0.9);
          m.vel.set(Math.sin(m.heading) * speed, vy, Math.cos(m.heading) * speed);
          if (m.recover > 0) {
            m.recover -= dt;
            const k = 1 - Math.max(m.recover, 0) / 0.5;
            m.vel.lerpVectors(m.entryVel, m.vel, k * k * (3 - 2 * k));
          }
        }
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
          // ここも向きを代入してはいけない。壁に触れた瞬間に体が反転して見える。
          // 位置は止めたうえで、強めに舵を切って数十フレームで向き直る
          let diff = Math.atan2(-nx, -nz) - m.heading;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          m.heading += THREE.MathUtils.clamp(diff * 3.0, -2.5, 2.5) * dt;
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

      // 水面を横切った瞬間(息継ぎなど)にも小さくしぶきが上がる
      const above = m.pos.y > surf;
      if (above !== m.wasAbove && m.state !== 'air') {
        this.splash.burst(m.pos.clone().setY(surf), U.uTime.value, this.bodyScale * 0.28);
      }
      m.wasAbove = above;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
