import * as THREE from 'three';
import { baseUniforms, U } from '../env.js';
import { UW_FRAG_PRELUDE, UW_FRAG_OUTPUT } from '../glsl.js';
// 高さは meshHeightAt() から取る。shoreTerrain() ではない。
// shoreTerrain() は連続関数で、幅4cmの節理の溝にもきちんと落ちる。
// けれども実際に描かれている岩は7cm刻みの格子で、その溝を持っていない。
// 関数の高さに置くと、生き物は「描かれていない窪み」に沈む——実測で
// 最大22cm。甲幅4cmのカニが自分の体の5倍も埋まっていた。
// 「常にめり込んでる」「薄っぺらく見える」はこれが原因だった。
import { meshHeightAt, poolAt, localWater } from '../environment/shore.js';
import { ContactShadows } from '../environment/contactShadow.js';

// ============ 磯の生き物 ============
//
// ここまでの4ゾーンの生き物は、全員が泳いでいた。姿勢は進行方向から
// 決まり、地面に触れることもなかった(ペンギンが氷に上がるときだけが例外)。
//
// 磯はまるごと逆で、住んでいるのはほとんどが泳がない生き物。
// 岩に張り付き、脚で歩き、潮が引けば体を縮めて水の戻りを待つ。
//
// 共通して要るのは2つ。
//   ・岩の面に「乗る」こと。位置だけでなく、傾きも岩に合わせる。
//     水平に置くと、傾いた岩から浮いたり刺さったりする
//   ・潮を見ていること。いま自分が水の中にいるのか外にいるのかで、
//     できることが変わる
//
// 岩の面の向き。高さ場を数値微分して法線を出す
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3();
const _side = new THREE.Vector3();
const _n = new THREE.Vector3();
const _sv = new THREE.Vector3();
const _bait = new THREE.Vector3();

// 傾きも「描かれている面」から測る。関数から測ると、画面には無い溝の
// 壁に沿って体が傾き、平らな岩の上で急に横倒しになる
export function rockNormalAt(x, z, e = 0.18, out = _n) {
  const dx = meshHeightAt(x + e, z) - meshHeightAt(x - e, z);
  const dz = meshHeightAt(x, z + e) - meshHeightAt(x, z - e);
  return out.set(-dx, 2 * e, -dz).normalize();
}

/** 岩の面に乗せる行列。heading は面に沿った向き */
function placeOnRock(m, x, y, z, heading, scale, nrm) {
  // 面の法線を上にして、heading の方を向かせる
  _fwd.set(Math.sin(heading), 0, Math.cos(heading));
  _side.crossVectors(_fwd, nrm).normalize();
  _fwd.crossVectors(nrm, _side).normalize();
  m.makeBasis(_side, nrm, _fwd);
  m.scale(_sv.set(scale, scale, scale));
  m.setPosition(x, y, z);
  return m;
}

// 磯の生き物が共有する描き方。岩と同じ光で照らす
function shoreCreatureMaterial(extraUniforms, vert, frag, opts = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { ...baseUniforms(), ...extraUniforms },
    side: opts.side ?? THREE.FrontSide,
    transparent: !!opts.transparent,
    vertexShader: vert,
    fragmentShader: UW_FRAG_PRELUDE + frag,
  });
}

const LIT_FRAG = /* glsl */ `
  varying vec3 vCol;
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vec3 n = gl_FrontFacing ? normalize(vN) : -normalize(vN);
    vec3 viewDir = normalize(cameraPosition - vW);
    vec3 col = underwaterLight(vCol, n, vW, viewDir, 30.0, 0.22);
    gl_FragColor = vec4(applyUnderwaterFog(col, vW), 1.0);
    ${UW_FRAG_OUTPUT}
  }
`;

// ---------------------------------------------------------------- 形を作る道具
class Buf {
  constructor() { this.p = []; this.c = []; this.i = []; this.extra = {}; }
  v(x, y, z, col, extra) {
    const k = this.p.length / 3;
    this.p.push(x, y, z); this.c.push(col[0], col[1], col[2]);
    if (extra) for (const key in extra) {
      (this.extra[key] ||= []).push(...(Array.isArray(extra[key]) ? extra[key] : [extra[key]]));
    }
    return k;
  }
  tri(a, b, c) { this.i.push(a, b, c); }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  geo(extraSizes = {}) {
    const pos = new Float32Array(this.p);
    const nrm = new Float32Array(this.p.length);
    for (let f = 0; f < this.i.length; f += 3) {
      const a = this.i[f] * 3, b = this.i[f + 1] * 3, c = this.i[f + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const k of [a, b, c]) { nrm[k] += nx; nrm[k + 1] += ny; nrm[k + 2] += nz; }
    }
    for (let k = 0; k < nrm.length; k += 3) {
      const L = Math.hypot(nrm[k], nrm[k + 1], nrm[k + 2]) || 1;
      nrm[k] /= L; nrm[k + 1] /= L; nrm[k + 2] /= L;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('aCol', new THREE.BufferAttribute(new Float32Array(this.c), 3));
    for (const key in this.extra) {
      g.setAttribute(key, new THREE.BufferAttribute(
        new Float32Array(this.extra[key]), extraSizes[key] || 1));
    }
    g.setIndex(this.i);
    return g;
  }
}

/** 楕円体。甲羅にも殻にも使う */
function dome(M, cx, cy, cz, rx, ry, rz, col, seg = 6, extra = null) {
  const rows = [];
  for (let i = 0; i <= seg; i++) {
    const th = (i / seg) * Math.PI;
    const row = [];
    for (let k = 0; k < seg * 2; k++) {
      const a = (k / (seg * 2)) * Math.PI * 2;
      row.push(M.v(cx + Math.sin(th) * Math.cos(a) * rx,
                   cy + Math.cos(th) * ry,
                   cz + Math.sin(th) * Math.sin(a) * rz, col, extra));
    }
    rows.push(row);
  }
  for (let i = 0; i < seg; i++) {
    for (let k = 0; k < seg * 2; k++) {
      const k2 = (k + 1) % (seg * 2);
      M.quad(rows[i][k], rows[i][k2], rows[i + 1][k2], rows[i + 1][k]);
    }
  }
}

// ================================================================ カニ
//
// イソガニ。甲幅3〜4cm。磯でひっくり返した石の下から出てくる、あれ。
//
// カニが横に歩くのは、脚の関節が「体の横方向にしか曲がらない」から。
// 前へ出そうとすると隣の脚とぶつかる。だから先に行く側の脚が伸びて
// 岩をつかみ、体を引き寄せ、反対側の脚が押す——漕ぐような歩き方になる。
//
// この寸法(4cm)を1m先から見るとき、脚先の数mmのずれは見えない。
// ペンギンのときは接地足の滑りを歩幅の3%まで詰めたが、ここは
// 正弦波の伸縮で足りる。作りこむ場所を間違えないこと。
const CRAB_LEGS = 4;      // 片側の歩脚の数

function crabGeometry() {
  const M = new Buf();
  const SHELL = [0.20, 0.115, 0.075];   // 甲羅。緑がかった暗褐色
  const SHELL2 = [0.28, 0.175, 0.110];
  const LEG = [0.24, 0.135, 0.085];
  const CLAW = [0.34, 0.20, 0.13];
  const TIP = [0.10, 0.075, 0.055];
  const EYE = [0.02, 0.018, 0.02];
  // aLeg: 脚の位相オフセット(0で本体=動かない) / aSeg: 付け根0 先1
  const body = { aLeg: 0, aSeg: 0 };

  // ---- 甲羅 ----
  // 横に広く、前後に短く、上下に平たい。前縁のほうがわずかに広い
  const rows = [];
  const SEG = 9;
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;                       // 0=後 1=前
    const w = 0.5 * (0.62 + 0.44 * Math.sin(t * Math.PI * 0.92 + 0.28));
    const row = [];
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2;
      // 断面。上に膨らみ、下は平ら
      const cy = Math.sin(a);
      const y = (cy > 0 ? cy * 0.16 : cy * 0.055);
      row.push(M.v(Math.cos(a) * w, y * (0.55 + 0.45 * Math.sin(t * Math.PI)),
                   -0.30 + t * 0.60,
                   cy > 0.2 ? SHELL : SHELL2, body));
    }
    rows.push(row);
  }
  for (let i = 0; i < SEG; i++) {
    for (let k = 0; k < 14; k++) {
      const k2 = (k + 1) % 14;
      M.quad(rows[i][k], rows[i][k2], rows[i + 1][k2], rows[i + 1][k]);
    }
  }

  // ---- 歩脚 ----
  // 付け根から外へ、いったん上がってから下りて、先が尖る。
  // まっすぐ外へ伸ばすと櫛の歯になる
  for (const side of [-1, 1]) {
    for (let i = 0; i < CRAB_LEGS; i++) {
      const t = i / (CRAB_LEGS - 1);
      const rz = 0.16 - t * 0.42;                    // 前から後ろへ並ぶ
      const rx = side * 0.5 * (0.72 + 0.18 * Math.sin(t * 3));
      // 脚は外へ長く伸ばす。下へ伸ばすと蜘蛛になる。
      // カニは「平たくて幅の広いもの」で、脚もほとんど横へ張っている
      const len = 0.92 * (0.82 + 0.34 * Math.sin(t * 2.4 + 0.5));
      // 位相。隣どうしは半周ずらす(交互に持ち上げる)
      const phase = (i % 2 === 0 ? 0 : Math.PI) + (side > 0 ? 0 : Math.PI);
      // 3節。外へ→上へ、外へ→下へ、先端
      const pts = [
        [rx, 0.01, rz],
        [rx + side * len * 0.38, 0.10, rz - 0.04],
        [rx + side * len * 0.80, -0.02, rz - 0.09],
        [rx + side * len * 1.0, -0.16, rz - 0.12],
      ];
      let prev = null;
      for (let s = 0; s < pts.length; s++) {
        const seg = s / (pts.length - 1);
        const r = 0.055 * (1 - seg * 0.72);
        const ring = [];
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2;
          // 断面は平たい楕円。丸い棒にすると蜘蛛の脚になる
          ring.push(M.v(pts[s][0], pts[s][1] + Math.sin(a) * r * 0.62,
                        pts[s][2] + Math.cos(a) * r * 1.35,
                        s === pts.length - 1 ? TIP : LEG, { aLeg: phase, aSeg: seg }));
        }
        if (prev) for (let k = 0; k < 5; k++) {
          const k2 = (k + 1) % 5;
          M.quad(prev[k], prev[k2], ring[k2], ring[k]);
        }
        prev = ring;
      }
    }
  }

  // ---- はさみ(鉗脚) ----
  // 前方の左右に、脚より太いものが1対。カニに見えるかどうかはこれ次第
  for (const side of [-1, 1]) {
    const rx = side * 0.34, rz = 0.24;
    const ph = side > 0 ? 0.6 : 0.6 + Math.PI;
    // 体の前に構える。下へ垂らすと牙に見える
    const pts = [[rx, 0.02, rz], [rx + side * 0.14, 0.07, rz + 0.16], [rx + side * 0.10, 0.05, rz + 0.34]];
    let prev = null;
    for (let s = 0; s < pts.length; s++) {
      const seg = s / (pts.length - 1);
      const r = 0.075 * (1 - seg * 0.25);
      const ring = [];
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        ring.push(M.v(pts[s][0] + Math.cos(a) * r * 0.7, pts[s][1] + Math.sin(a) * r,
                      pts[s][2], CLAW, { aLeg: ph, aSeg: seg * 0.45 }));
      }
      if (prev) for (let k = 0; k < 6; k++) {
        const k2 = (k + 1) % 6;
        M.quad(prev[k], prev[k2], ring[k2], ring[k]);
      }
      prev = ring;
    }
    // 指。上下2本に割れている
    const tipE = { aLeg: ph, aSeg: 0.45 };
    for (const dy of [0.05, -0.05]) {
      const a = M.v(rx + side * 0.05, 0.05 + dy * 0.5, rz + 0.34, CLAW, tipE);
      const b = M.v(rx + side * 0.15, 0.05 + dy, rz + 0.34, CLAW, tipE);
      const c = M.v(rx + side * 0.11, 0.05 + dy * 0.3, rz + 0.50, TIP, tipE);
      M.tri(a, b, c);
    }
  }

  // ---- 眼 ----
  // 短い柄の先に黒い球。ここがあると急に生き物になる
  for (const side of [-1, 1]) {
    dome(M, side * 0.15, 0.11, 0.27, 0.032, 0.038, 0.032, EYE, 3, body);
  }
  return M.geo({ aCol: 3 });
}

const CRAB_VERT = /* glsl */ `
  uniform float uTime;
  attribute vec3 aCol;
  attribute float aLeg;
  attribute float aSeg;
  attribute vec4 aInfo;   // x:歩調の位相 y:歩く速さ(0で静止) z:大きさ w:色ゆらぎ
  varying vec3 vCol;
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vec3 p = position;
    vec3 nn = normal;
    // 脚を漕ぐ。カニは横歩きなので、脚は体の横方向(x)に伸び縮みする。
    // 先へ行くほど大きく動かす(aSeg が付け根0・先1)
    float ph = uTime * 7.0 * (0.6 + aInfo.y) + aInfo.x + aLeg;
    float amp = aSeg * aInfo.y;
    p.x += sin(ph) * 0.20 * amp;
    // 遊脚のときだけ持ち上げる。ずっと浮かせると宙を掻いて見える
    p.y += max(sin(ph + 1.5708), 0.0) * 0.15 * amp;
    // 甲羅もわずかに上下する。脚だけ動くと体が板に見える
    p.y += sin(ph * 2.0) * 0.012 * aInfo.y * (1.0 - aSeg);

    vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
    vW = wp.xyz;
    vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * nn);
    // 個体ごとの色みの差。同じ甲羅の色が並ぶと工業製品に見える
    vCol = aCol * (0.72 + 0.56 * aInfo.w);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

/**
 * イソガニの群れ。
 *
 * 潮が引くと岩の上へ出てきて餌を漁り、満ちると水に入る。
 * 人影(ダイバー)が近づくと、いちばん近い岩陰へ走って動きを止める——
 * 磯でカニを見つけたときに必ず起きることなので、これが無いと
 * 「歩いている置物」にしかならない。
 */
export class CrabColony {
  constructor(parent, { count = 26 } = {}) {
    this.geo = crabGeometry();
    // 脚先が岩に触れる高さ。ここは手で決めた数字を使ってはいけない。
    // 甲羅の厚みから当て推量で 0.16 と置いていたが、いちばん低いのは
    // 甲羅ではなく歩脚の先(-0.17)で、脚が岩に刺さったまま歩いていた。
    // 幾何を測って、そのぶんだけ持ち上げる
    this.geo.computeBoundingBox();
    this.foot = -this.geo.boundingBox.min.y;
    this.info = new Float32Array(count * 4);
    this.geo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(this.info, 4));
    this.mat = shoreCreatureMaterial({}, CRAB_VERT, LIT_FRAG);
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, count);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    parent.add(this.mesh);

    this.feed = null;
    this.feedT = 0;
    // 検証用。餌に口が届いた個体数と、食べた累計。
    // 「寄ってきているのに食べていない」のか「そもそも届いていない」のかは、
    // 外から見ても区別できない。この2つを出しておかないと切り分けられない
    this.ate = 0;
    this.reached = 0;
    // 接地影。歩くので毎フレーム置き直す。
    // 板の直径は甲幅の2.4倍——カニの footprint は甲羅ではなく脚の張りで
    // 決まり、脚は左右へ甲幅ぶんずつ伸びている
    this.shadow = new ContactShadows(parent, count, U.uSunDir.value);
    this.members = [];
    for (let i = 0; i < count; i++) {
      // 潮間帯の棚のあたりに散らす
      const x = (Math.random() - 0.5) * 46;
      const z = -6 + Math.random() * 20;
      // イソガニは甲幅3〜4cm、大きめのショウジンガニで7cm。
      // 幾何は甲幅1.0で作ってあるので、そのまま実寸を入れる
      const body = 0.032 + Math.random() * Math.random() * 0.042;
      this.members.push({
        x, z, y: meshHeightAt(x, z),
        homeX: x, homeZ: z,
        heading: Math.random() * Math.PI * 2,
        // 横歩きなので、進む向きは体の向きの真横
        dir: Math.random() < 0.5 ? 1 : -1,
        speed: 0, body,
        rest: Math.random() * 2.0,
        scare: 0,
        detour: 0,
      });
      this.info[i * 4 + 0] = Math.random() * Math.PI * 2;
      this.info[i * 4 + 1] = 0;
      this.info[i * 4 + 2] = body;
      this.info[i * 4 + 3] = Math.random();
    }
    this.infoAttr = this.geo.getAttribute('aInfo');
  }

  /**
   * 餌が撒かれた。カニは匂いに気づいて集まってくる。
   * 磯でエサを置くと、どこにいたのか分からないカニが次々に出てくる
   */
  noticeFeed(cloud) { this.feed = cloud; this.feedT = 26; }

  /** ダイバーが近づいた。近くの個体は岩陰へ走る */
  scareAt(p, radius = 6) {
    for (const m of this.members) {
      const d = Math.hypot(m.x - p.x, m.z - p.z);
      if (d < radius) {
        m.scare = 2.2 + Math.random() * 2.0;
        // 相手と反対の方へ、横歩きで逃げる。
        // 向きの決め方は餌を追うときと同じ規約にそろえる
        m.heading = Math.atan2(m.x - p.x, m.z - p.z) - Math.PI * 0.5;
        m.dir = 1;
      }
    }
  }

  update(dt, sea) {
    // 餌が撒かれているあいだは、そこへ向かうのが最優先
    if (this.feedT > 0) this.feedT -= dt;
    const bait = this.feedT > 0 && this.feed && this.feed.active
      ? this.feed.focus(_bait) : null;
    this.reached = 0;
    for (let i = 0; i < this.members.length; i++) {
      const m = this.members[i];
      const water = localWater(m.x, m.z, sea);
      const submerged = m.y < water - 0.02;

      if (m.detour > 0) m.detour -= dt;

      if (m.scare > 0) {
        // 逃走。カニは驚くと本気で速い。甲幅の10倍/秒くらい出す
        m.scare -= dt;
        m.speed = m.body * 11;
      } else if (bait && m.detour <= 0) {
        // 餌へ向かう。届いたら食べる。
        //
        // 迂回中(detour)は上書きしないこと。段差に阻まれて向きを変えても、
        // 次のフレームでここが餌の方向へ戻してしまうと、
        // 「曲がる→戻す→また阻まれる」を延々くり返してその場で固まる。
        // 実際そうなって、カニが餌の48cm手前でぴたりと止まった
        const d = Math.hypot(bait.x - m.x, bait.z - m.z);
        // 届く距離。カニは体の前へはさみを伸ばして拾うので、
        // 甲羅が触れるまで詰める必要はない。ここを甲幅の3.5倍(4cmの個体で
        // 11cm)にしていたら、段差に阻まれて13cm手前で足踏みし、
        // いつまでも食べられなかった
        if (d > m.body * 6.0) {
          // 横歩きなので、体の向きは進みたい方向の直角にとる。
          // 引くほうへ回すこと——+π/2 にすると進む向きが真逆になり、
          // 餌から遠ざかっていく(実際そうなった)。
          // 移動は (cos(heading), -sin(heading)) なので、
          // 進みたい角 θ に対して heading = θ - π/2
          m.heading = Math.atan2(bait.x - m.x, bait.z - m.z) - Math.PI * 0.5;
          m.dir = 1;
          m.speed = m.body * 5.5;
          m.rest = 0.4;
        } else {
          // 届いた。はさみは体より前に出るので、口の届く範囲は甲幅より広い
          m.speed = 0;
          this.reached++;
          this.ate += this.feed.eatNear(_v.set(m.x, m.y + m.body * 0.2, m.z), m.body * 8.0);
        }
      } else {
        m.rest -= dt;
        if (m.rest <= 0) {
          // 潮に浸かっているときのほうがよく動く。干上がると物陰で待つ
          // 水に浸かっているときのほうがよく動く。干上がると物陰で待つ。
          // ただし陸でもまったく動かないわけではない——磯のカニは
          // 潮が引いた岩の上をせわしなく歩きまわっている
          const active = submerged ? 0.80 : 0.55;
          if (Math.random() < active) {
            m.speed = m.body * (2.2 + Math.random() * 2.4);
            m.rest = 1.2 + Math.random() * 3.0;
            m.dir = Math.random() < 0.5 ? 1 : -1;
            m.heading += (Math.random() - 0.5) * 1.6;
          } else {
            m.speed = 0;
            m.rest = 1.5 + Math.random() * 4.0;
          }
        }
      }

      if (m.speed > 0) {
        // 横歩き。進むのは体の向きの真横
        const vx = Math.cos(m.heading) * m.dir;
        const vz = -Math.sin(m.heading) * m.dir;
        let nx = m.x + vx * m.speed * dt;
        let nz = m.z + vz * m.speed * dt;
        // 縄張りから離れすぎない。磯のカニは自分の隙間を持っている
        if (Math.hypot(nx - m.homeX, nz - m.homeZ) > 5.5 && m.scare <= 0) {
          m.heading = Math.atan2(m.homeX - m.x, m.homeZ - m.z) + Math.PI * 0.5;
          nx = m.x; nz = m.z;
        }
        // 急な崖は登らない。ただし判定は「1歩ぶんの高低差」で
        // やってはいけない。岩には節理の溝が数cm刻みで走っているので、
        // 1歩(数mm)で数cmの段を跨ぐことがいくらでもある。
        // それを崖とみなしていたら、26匹中25匹がその場で回り続けた。
        //
        // カニは4cmの体で数cmの段を平気で越える。見るべきは
        // 「これから進む先30cmの傾き」で、閾値もそれに合わせる
        const ny = meshHeightAt(nx, nz);
        // イソガニは垂直な岩壁でも平気で登る。ここで止めたいのは
        // 「壁を突き抜けて歩く」ことだけなので、閾値はうんと甘くてよい。
        // 0.34mにしていたときは、節理の段のたびに引っかかって
        // 迂回をくり返し、餌の40cm手前まで来たきり届かなかった
        const ahead = meshHeightAt(m.x + vx * 0.3, m.z + vz * 0.3);
        if (Math.abs(ahead - m.y) < 0.85) {
          m.x = nx; m.z = nz; m.y = ny;
        } else {
          // 阻まれた。しばらくこの向きで迂回する
          m.heading += 1.1;
          m.detour = 0.8;
        }
      }

      const n = rockNormalAt(m.x, m.z);
      // 脚先が岩に乗る高さに置く
      placeOnRock(_m, m.x, m.y + m.body * this.foot, m.z, m.heading, m.body, n);
      this.mesh.setMatrixAt(i, _m);
      // 甲羅の中心は甲幅の 0.20 ぶん浮いている。そのぶん影がずれる
      this.shadow.place(i, m.x, m.y, m.z, m.body * 2.4, m.body * 0.20, n);
      // 歩いていないときは脚を止める。ずっと漕いでいると水車になる
      this.info[i * 4 + 1] = m.speed > 0 ? Math.min(m.speed / (m.body * 4), 1.6) : 0;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.shadow.commit(this.members.length);
    this.infoAttr.needsUpdate = true;
  }
}

// ================================================================ イソギンチャク
//
// ミドリイソギンチャク。潮だまりの壁にびっしり付いている、あれ。
//
// このゾーンで潮汐といちばん強く結びついている生き物。
// 水に浸かっているあいだは触手をいっぱいに開いて漂うものを捕らえ、
// 潮が引いて空気にさらされると、触手を全部たたんで丸い塊になる。
// 干からびないためで、磯を歩くと「濡れた赤い団子」がそこらじゅうに付いている。
//
// 開閉は水位ひとつで決まるので、地形の高さと潮位を比べるだけでよい。
function anemoneGeometry() {
  const M = new Buf();
  const COL = [0.30, 0.075, 0.065];    // 柱部。暗い赤褐色
  const DISC = [0.20, 0.145, 0.055];   // 口盤
  const TENT = [0.34, 0.30, 0.115];    // 触手。緑がかった褐色
  // aOpen: 0=閉じても動かない部分 1=開くと伸びる部分
  // 柱部
  const rows = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    const r = 0.5 * (0.92 - 0.18 * t * t);
    const row = [];
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      row.push(M.v(Math.cos(a) * r, t * 0.52, Math.sin(a) * r,
                   i === 4 ? DISC : COL, { aOpen: t * 0.35, aRad: 0 }));
    }
    rows.push(row);
  }
  for (let i = 0; i < 4; i++) {
    for (let k = 0; k < 12; k++) {
      const k2 = (k + 1) % 12;
      M.quad(rows[i][k], rows[i][k2], rows[i + 1][k2], rows[i + 1][k]);
    }
  }
  // 口盤のふた
  const mid = M.v(0, 0.52, 0, DISC, { aOpen: 0.35, aRad: 0 });
  for (let k = 0; k < 12; k++) M.tri(rows[4][k], rows[4][(k + 1) % 12], mid);

  // 触手。3列に並べる。閉じるときは口盤の内側へ引き込まれる。
  //
  // 平らな三角形で済ませたら、花びらを貼りつけた造花になった。
  // イソギンチャクの触手は先の丸い細い指で、断面がある。
  // 三角柱にするだけで一気に触手に見える
  for (let ring = 0; ring < 3; ring++) {
    const rr = 0.30 - ring * 0.082;
    const n = 18 - ring * 4;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + ring * 0.42;
      const ca = Math.cos(a), sa = Math.sin(a);
      // 付け根から外へ倒れながら伸びる。3点の折れ線に肉をつける
      const pts = [
        [ca * rr, 0.50, sa * rr, 0.15, 0.038],
        [ca * (rr + 0.16), 0.66, sa * (rr + 0.16), 0.55, 0.030],
        [ca * (rr + 0.30), 0.68, sa * (rr + 0.30), 0.85, 0.019],
        [ca * (rr + 0.40), 0.62, sa * (rr + 0.40), 1.00, 0.006],
      ];
      let prev = null;
      for (const [px, py, pz, rad, w] of pts) {
        const ring3 = [];
        for (let j = 0; j < 3; j++) {
          const th = (j / 3) * Math.PI * 2;
          ring3.push(M.v(px - sa * Math.cos(th) * w, py + Math.sin(th) * w, pz + ca * Math.cos(th) * w,
                         TENT, { aOpen: 0.2 + 0.8 * rad, aRad: rad }));
        }
        if (prev) for (let j = 0; j < 3; j++) {
          const j2 = (j + 1) % 3;
          M.quad(prev[j], prev[j2], ring3[j2], ring3[j]);
        }
        prev = ring3;
      }
    }
  }
  return M.geo({ aCol: 3 });
}

const ANEM_VERT = /* glsl */ `
  uniform float uTime;
  attribute vec3 aCol;
  attribute float aOpen;
  attribute float aRad;
  attribute vec4 aInfo;   // x:位相 y:開き具合(0閉 1開) z:大きさ w:色ゆらぎ
  varying vec3 vCol;
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vec3 p = position;
    float open = aInfo.y;
    // 閉じるときは触手を口盤の中央へ畳み、体全体を平たく潰す。
    // 単に縮小すると「小さいイソギンチャク」になってしまう——
    // 実物は縦に潰れて横に広がった団子になる
    float t = aOpen;
    p.xz = mix(p.xz * (1.0 - 0.86 * t) * (1.0 + 0.20 * (1.0 - open)), p.xz, open + (1.0 - t));
    p.y *= mix(0.42, 1.0, open);
    // 開いているときは触手がゆっくり揺れる
    float sway = sin(uTime * 1.3 + aInfo.x + aRad * 3.0) * 0.055 * aRad * open;
    p.x += sway; p.z += sway * 0.7;
    vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
    vW = wp.xyz;
    vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
    vCol = aCol * (0.75 + 0.5 * aInfo.w);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export class AnemoneBed {
  constructor(parent, { count = 120 } = {}) {
    this.geo = anemoneGeometry();
    this.info = new Float32Array(count * 4);
    this.geo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(this.info, 4));
    this.mat = shoreCreatureMaterial({}, ANEM_VERT, LIT_FRAG, { side: THREE.DoubleSide });
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, count);
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);
    // イソギンチャクは動かないので、影は置いたら置いたまま
    const shadow = new ContactShadows(parent, count, U.uSunDir.value);

    this.items = [];
    let placed = 0;
    for (let i = 0; i < count * 60 && placed < count; i++) {
      const x = (Math.random() - 0.5) * 40;
      const z = -10 + Math.random() * 22;
      const y = meshHeightAt(x, z);
      // 潮間帯の下半分にしか付かない。乾く時間が長すぎると生きられない
      if (y > 16.5 || y < 14.0) continue;
      // 潮だまりの中と縁には特に多い
      const inPool = poolAt(x, z);
      if (!inPool && Math.random() < 0.45) continue;
      const size = 0.035 + Math.random() * 0.035;   // 直径3.5〜7cm
      const n = rockNormalAt(x, z);
      placeOnRock(_m, x, y, z, Math.random() * 6.283, size, n);
      this.mesh.setMatrixAt(placed, _m);
      // 触手を広げたぶんまで含めて、影は体の 1.9 倍。
      // 丸い体は自分の影を隠すので、物の輪郭より広く取ること
      shadow.place(placed, x, y, z, size * 1.9, size * 0.45, n);
      this.info[placed * 4 + 0] = Math.random() * 6.283;
      this.info[placed * 4 + 1] = 1;
      this.info[placed * 4 + 2] = size;
      this.info[placed * 4 + 3] = Math.random();
      this.items.push({ x, z, y, open: 1 });
      placed++;
    }
    shadow.commit(placed);
    this.mesh.count = placed;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.infoAttr = this.geo.getAttribute('aInfo');
  }

  update(dt, sea) {
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      const water = localWater(it.x, it.z, sea);
      // 水没していれば開く。空気に出たら閉じる。
      // 閉じるのは速く、開くのはゆっくり——警戒を解くのは高くつく判断
      const want = it.y < water - 0.03 ? 1 : 0;
      const rate = want > it.open ? 0.35 : 1.6;
      it.open += (want - it.open) * Math.min(rate * dt, 1);
      this.info[i * 4 + 1] = it.open;
    }
    this.infoAttr.needsUpdate = true;
  }
}

// ================================================================ ヒトデ
//
// イトマキヒトデ。直径5〜8cm。潮だまりの壁や石の裏に張り付いている。
//
// 動かないように見えるが動いている。管足という無数の小さな足で
// 岩を掴んで進み、その速さは毎分数cm。見ている数十秒では
// 位置が変わったことに気づかない——それが正しい。
// だから「止まっている」のではなく「遅い」を実装する。
function starGeometry() {
  const M = new Buf();
  const TOP = [0.30, 0.115, 0.075];    // 背面。橙褐色
  const TOP2 = [0.17, 0.150, 0.140];   // 青灰の斑
  const UNDER = [0.42, 0.31, 0.17];    // 腹面は淡い
  const ARMS = 5;

  // 腕を1本ずつ作る。円盤を花びら状に凹ませる作り方だと、
  // 腕が幅広で先が丸い「花」になってしまった。
  // ヒトデの腕は付け根が太く、先へまっすぐ細って尖る。
  // 中央の盤が少し盛り上がり、腕はそこから下がっていく
  const RIB = 7;                       // 腕を輪切りにする数
  const HALF = 6;                      // 断面の点数(片側)
  const centre = [];
  for (let k = 0; k < ARMS * 2; k++) {
    const a = (k / (ARMS * 2)) * Math.PI * 2;
    centre.push(null);                 // あとで埋める
  }

  const hub = M.v(0, 0.105, 0, TOP, { aArm: 0 });
  const hubB = M.v(0, 0, 0, UNDER, { aArm: 0 });
  const armRings = [];
  for (let n = 0; n < ARMS; n++) {
    const ang = (n / ARMS) * Math.PI * 2;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const rings = [];
    for (let i = 0; i <= RIB; i++) {
      const t = i / RIB;                             // 0=付け根 1=先端
      const rad = 0.18 + t * 0.82;
      // 幅。付け根で広く、先で尖る
      const w = (0.30 - 0.28 * Math.pow(t, 1.35)) * (1 - 0.15 * t);
      // 高さ。中央が厚く、先は薄い
      const h = 0.085 * Math.pow(1 - t, 1.4) + 0.012;
      const ring = { top: [], bot: [] };
      for (let k = -HALF; k <= HALF; k++) {
        const u = k / HALF;                          // -1..1 腕の幅方向
        const lx = rad, lz = u * w;
        const px = ca * lx - sa * lz, pz = sa * lx + ca * lz;
        // 断面はかまぼこ。縁は薄い
        const dome = h * Math.sqrt(Math.max(1 - u * u, 0));
        const mottle = Math.sin(px * 22 + pz * 17);
        ring.top.push(M.v(px, dome + 0.008, pz, mottle > 0.35 ? TOP2 : TOP, { aArm: t }));
        ring.bot.push(M.v(px, 0, pz, UNDER, { aArm: t }));
      }
      rings.push(ring);
    }
    armRings.push(rings);
    // 腕の面を張る
    for (let i = 0; i < RIB; i++) {
      for (let k = 0; k < HALF * 2; k++) {
        M.quad(rings[i].top[k], rings[i].top[k + 1], rings[i + 1].top[k + 1], rings[i + 1].top[k]);
        M.quad(rings[i].bot[k + 1], rings[i].bot[k], rings[i + 1].bot[k], rings[i + 1].bot[k + 1]);
      }
      // 側面(縁)
      M.quad(rings[i].top[0], rings[i].bot[0], rings[i + 1].bot[0], rings[i + 1].top[0]);
      const e = HALF * 2;
      M.quad(rings[i].bot[e], rings[i].top[e], rings[i + 1].top[e], rings[i + 1].bot[e]);
    }
    // 先端を閉じる
    const last = rings[RIB];
    for (let k = 0; k < HALF * 2; k++) M.quad(last.top[k], last.bot[k], last.bot[k + 1], last.top[k + 1]);
    // 付け根を中央の盤へつなぐ
    const first = rings[0];
    for (let k = 0; k < HALF * 2; k++) {
      M.tri(hub, first.top[k], first.top[k + 1]);
      M.tri(hubB, first.bot[k + 1], first.bot[k]);
    }
  }
  // 隣りあう腕のあいだの谷を埋める
  for (let n = 0; n < ARMS; n++) {
    const a = armRings[n][0], b = armRings[(n + 1) % ARMS][0];
    const e = HALF * 2;
    M.tri(hub, a.top[e], b.top[0]);
    M.tri(hubB, b.bot[0], a.bot[e]);
  }
  return M.geo({ aCol: 3 });
}

// ================================================================ ウニ
//
// ムラサキウニ。殻の直径4〜5cm、棘を入れると10cm近い。
// 岩の窪みに嵌まって動かない。棘は生きていて、影が差すと一斉に動く。
function urchinGeometry() {
  const M = new Buf();
  const TEST = [0.055, 0.048, 0.075];    // 殻。ほとんど黒に近い紫
  const SPINE = [0.105, 0.075, 0.135];
  const body = { aSpine: 0 };
  dome(M, 0, 0.30, 0, 0.5, 0.34, 0.5, TEST, 6, body);
  // 棘。殻の上半分から放射状に生やす。三角柱1本で足りる
  let s = 12345;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  for (let i = 0; i < 84; i++) {
    // 球面上に一様に散らす(下半分は岩に接するので生やさない)
    const u = rnd() * 1.55 - 0.42;
    const th = Math.acos(Math.max(Math.min(u, 1), -1));
    const ph = rnd() * Math.PI * 2;
    const nx = Math.sin(th) * Math.cos(ph), ny = Math.cos(th), nz = Math.sin(th) * Math.sin(ph);
    const bx = nx * 0.5, by = 0.30 + ny * 0.34, bz = nz * 0.5;
    const len = 0.34 + rnd() * 0.30;
    const w = 0.026;
    // 棘の根元の3点と先端1点
    const t1 = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 0, 1];
    const ax = [ny * t1[2] - nz * t1[1], nz * t1[0] - nx * t1[2], nx * t1[1] - ny * t1[0]];
    const al = Math.hypot(...ax) || 1;
    const bx2 = [ny * ax[2] / al - nz * ax[1] / al, nz * ax[0] / al - nx * ax[2] / al,
                 nx * ax[1] / al - ny * ax[0] / al];
    const ring = [];
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      const ox = (ax[0] / al * Math.cos(a) + bx2[0] * Math.sin(a)) * w;
      const oy = (ax[1] / al * Math.cos(a) + bx2[1] * Math.sin(a)) * w;
      const oz = (ax[2] / al * Math.cos(a) + bx2[2] * Math.sin(a)) * w;
      ring.push(M.v(bx + ox, by + oy, bz + oz, SPINE, { aSpine: 0 }));
    }
    const tip = M.v(bx + nx * len, by + ny * len, bz + nz * len, SPINE, { aSpine: 1 });
    for (let k = 0; k < 3; k++) M.tri(ring[k], ring[(k + 1) % 3], tip);
  }
  return M.geo({ aCol: 3 });
}

// 張り付いて動かない(ように見える)ものの共通シェーダ。
// aInfo.y をゆらぎの強さに使う
const CLING_VERT = /* glsl */ `
  uniform float uTime;
  attribute vec3 aCol;
  attribute vec4 aInfo;   // x:位相 y:ゆらぎ z:大きさ w:色ゆらぎ
  varying vec3 vCol;
  varying vec3 vN;
  varying vec3 vW;
  #ifdef SPINES
  attribute float aSpine;
  #endif
  #ifdef ARMS
  attribute float aArm;
  #endif
  void main() {
    vec3 p = position;
    #ifdef SPINES
      // 棘はゆっくり揺れる。ウニの棘は生きていて、常にわずかに動いている
      float w = sin(uTime * 0.9 + aInfo.x + p.x * 5.0) * 0.045 * aSpine * aInfo.y;
      p.x += w; p.z += w * 0.8;
    #endif
    #ifdef ARMS
      // 腕の先だけがわずかに反る。管足で岩を探っている
      float c = sin(uTime * 0.35 + aInfo.x + aArm * 4.0) * 0.05 * aArm * aArm * aInfo.y;
      p.y += c;
    #endif
    vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
    vW = wp.xyz;
    vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
    vCol = aCol * (0.74 + 0.52 * aInfo.w);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

/** 岩に張り付いて動かないもの(ヒトデ・ウニ)をまとめて置く */
class ClingBed {
  constructor(parent, geo, count, define, place) {
    this.info = new Float32Array(count * 4);
    geo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(this.info, 4));
    this.mat = shoreCreatureMaterial({}, CLING_VERT, LIT_FRAG, { side: THREE.DoubleSide });
    this.mat.defines = { [define]: '' };
    this.mesh = new THREE.InstancedMesh(geo, this.mat, count);
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);
    // 張り付いて動かないので、影も置いたまま。
    // 板の直径と浮き上がりは種ごとに違う(ヒトデは平たく、ウニは丸い)ので
    // place() が返してくる
    const shadow = new ContactShadows(parent, count, U.uSunDir.value);
    this.items = [];
    let placed = 0;
    for (let i = 0; i < count * 60 && placed < count; i++) {
      const s = place();
      if (!s) continue;
      const n = rockNormalAt(s.x, s.z);
      placeOnRock(_m, s.x, s.y + (s.lift || 0), s.z, Math.random() * 6.283, s.size, n);
      this.mesh.setMatrixAt(placed, _m);
      shadow.place(placed, s.x, s.y, s.z, s.size * s.shadow, s.size * s.hover, n);
      this.info[placed * 4 + 0] = Math.random() * 6.283;
      this.info[placed * 4 + 1] = 1;
      this.info[placed * 4 + 2] = s.size;
      this.info[placed * 4 + 3] = Math.random();
      this.items.push(s);
      placed++;
    }
    shadow.commit(placed);
    this.mesh.count = placed;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.infoAttr = geo.getAttribute('aInfo');
  }

  update(dt, sea) {
    // 水から出ていると動きを止める。棘も管足も、水がないと働かない
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      const wet = it.y < localWater(it.x, it.z, sea) - 0.02 ? 1 : 0.12;
      this.info[i * 4 + 1] += (wet - this.info[i * 4 + 1]) * Math.min(dt * 0.8, 1);
    }
    this.infoAttr.needsUpdate = true;
  }
}

export function createSeaStars(parent, count = 34) {
  return new ClingBed(parent, starGeometry(), count, 'ARMS', () => {
    const x = (Math.random() - 0.5) * 40;
    const z = -12 + Math.random() * 22;
    const y = meshHeightAt(x, z);
    // 潮下帯から潮間帯の下部。乾く場所には出てこない
    if (y > 16.2 || y < 13.2) return null;
    // ヒトデは腕まで岩に密着している。影は体と同じ広さで、ほぼ浮かない
    return { x, z, y, size: 0.055 + Math.random() * 0.035, lift: 0.004,
             shadow: 1.15, hover: 0.03 };
  });
}

export function createUrchins(parent, count = 40) {
  return new ClingBed(parent, urchinGeometry(), count, 'SPINES', () => {
    const x = (Math.random() - 0.5) * 44;
    const z = -18 + Math.random() * 22;
    const y = meshHeightAt(x, z);
    // ウニはさらに下。いつも水につかっているところにしかいない
    if (y > 15.7 || y < 12.5) return null;
    // 殻の底はすでに幾何のほうで少し下(-0.04)にある。さらに埋めると
    // 直径6cmのウニが穴に落ちたように見える。乗せるだけでよい
    // ウニは殻が丸いので中心が浮く。棘は光を通すので、影は棘の広がりより
    // ずっと狭く、殻の接地面のまわりだけ濃い
    return { x, z, y, size: 0.048 + Math.random() * 0.026, lift: 0,
             shadow: 1.9, hover: 0.45 };
  });
}

// 形だけを単体で確かめるための口(検証用のビューアから読む)
export const __shapes = {
  crab: crabGeometry, anemone: anemoneGeometry, star: starGeometry, urchin: urchinGeometry,
};
