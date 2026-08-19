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
// 追跡カメラが 63cm まで寄れるようになったので、甲幅5cmのカニが
// 画面の8%(90px)を占める。1m以上離れる前提で作った「先へ行くほど
// 細くなる棒」の脚では、この距離に耐えない。節と関節を作り直した。
// 接地足の滑りはペンギンのように詰めていない——横歩きの脚は
// 正弦波の伸縮で足りる。作りこむ場所は距離が決める。
const CRAB_LEGS = 4;      // 片側の歩脚の数


// 実寸の目安(甲幅 W = 1.0 とする)。イソガニ・ヒライソガニなどの
// イワガニ科は、ワタリガニのような丸い甲羅ではなく「四角い」甲羅を持つ。
// 前縁がまっすぐで、左右の縁もほぼ平行、そこに2〜3個の歯が出る。
// 楕円の饅頭にすると、カニではなく甲虫に見える。
const CARA_W = 0.50;      // 甲羅の半幅
const CARA_F = 0.40;      // 前縁の z
const CARA_B = -0.46;     // 後縁の z
const CARA_H = 0.145;     // 甲羅の高さ(上面のいちばん高いところ)
const CARA_D = 0.055;     // 腹側の深さ

/**
 * 甲羅の輪郭。a は 0〜1 で一周する。
 * 角の丸い四角(スーパー楕円)を土台に、前側の縁へ歯を出す。
 */
function caraOutline(a, out) {
  const th = a * Math.PI * 2;
  const c = Math.cos(th), s = Math.sin(th);
  // 指数を上げるほど四角くなる。2 で楕円、4 で角の丸い四角
  const n = 2 / 4.2;
  let x = Math.sign(c) * Math.pow(Math.abs(c), n) * CARA_W;
  let z = Math.sign(s) * Math.pow(Math.abs(s), n);
  z = z > 0 ? z * CARA_F : z * -CARA_B;
  // 前側方の歯。イワガニ科は眼窩の外角のうしろに2つ切れこみがある
  if (z > 0.02) {
    const tooth = Math.sin((z / CARA_F) * Math.PI * 2.6) * 0.016;
    x += Math.sign(x) * tooth;
  }
  return out ? out.set(x, 0, z) : [x, z];
}

/** 甲羅の上面/腹側の高さ。s は中心0・縁1 */
const caraTop = (s) => CARA_H * Math.pow(Math.max(1 - s * s, 0), 0.55);
const caraBot = (s) => -CARA_D * Math.pow(Math.max(1 - s * s, 0), 0.28);

/**
 * 節のある肢を1本作る。
 *
 * これがカニらしさのほとんどを決める。歩脚は「先へ行くほど細くなる棒」
 * ではない。付根から順に 座節・長節(merus)・腕節・前節・指節(dactylus)で、
 * いちばん太いのは長節、いちばん細いのは針のような指節。
 * 太さを一様に減らすだけだと蜘蛛の脚になる。
 *
 * 節と節のあいだも真っ直ぐではなく、関節のところが瘤のように張る。
 * ここでは各区間の途中に細い点を挟むことで、関節側が相対的に
 * 膨らんで見えるようにしている。
 *
 * @param pts   [x,y,z] の並び。関節の位置
 * @param rad   各点の [横半径, 縦半径]。断面は平たい楕円
 * @param waist 区間の中央をどれだけ絞るか(1で絞らない)
 */
function limb(M, pts, rad, col, tipCol, extra, sides = 7, waist = 0.86) {
  // 区間の中央に点を足して、関節に瘤を作る
  const P = [], R = [];
  for (let i = 0; i < pts.length; i++) {
    P.push(pts[i]); R.push(rad[i]);
    if (i < pts.length - 1) {
      const q = pts[i + 1];
      P.push([(pts[i][0] + q[0]) / 2, (pts[i][1] + q[1]) / 2, (pts[i][2] + q[2]) / 2]);
      R.push([(rad[i][0] + rad[i + 1][0]) / 2 * waist,
              (rad[i][1] + rad[i + 1][1]) / 2 * waist]);
    }
  }
  const n = P.length;
  const t = new THREE.Vector3(), sd = new THREE.Vector3(), up = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  let prev = null;
  for (let i = 0; i < n; i++) {
    // 断面は進行方向に直交させる。指節は急に下を向くので、
    // yz 平面の輪で決め打ちすると断面が軸を含んでしまい形が壊れる
    const a = P[Math.max(i - 1, 0)], b = P[Math.min(i + 1, n - 1)];
    t.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (t.lengthSq() < 1e-12) t.set(1, 0, 0);
    t.normalize();
    sd.crossVectors(t, UP);
    if (sd.lengthSq() < 1e-8) sd.set(0, 0, 1);
    sd.normalize();
    up.crossVectors(sd, t).normalize();
    const seg = i / (n - 1);
    const c = seg > 0.86 ? tipCol : col;
    const ring = [];
    for (let k = 0; k < sides; k++) {
      const ang = (k / sides) * Math.PI * 2;
      const cw = Math.cos(ang) * R[i][0], ch = Math.sin(ang) * R[i][1];
      ring.push(M.v(P[i][0] + sd.x * cw + up.x * ch,
                    P[i][1] + sd.y * cw + up.y * ch,
                    P[i][2] + sd.z * cw + up.z * ch,
                    c, { ...extra, aSeg: seg }));
    }
    if (prev) for (let k = 0; k < sides; k++) {
      const k2 = (k + 1) % sides;
      M.quad(prev[k], prev[k2], ring[k2], ring[k]);
    }
    prev = ring;
  }
  // 先端を閉じる
  const last = P[n - 1];
  const tip = M.v(last[0], last[1], last[2], tipCol, { ...extra, aSeg: 1 });
  for (let k = 0; k < sides; k++) M.tri(prev[k], prev[(k + 1) % sides], tip);
}

function crabGeometry() {
  const M = new Buf();
  const SHELL = [0.20, 0.115, 0.075];   // 甲羅。緑がかった暗褐色
  const SHELL2 = [0.28, 0.175, 0.110];
  const BELLY = [0.30, 0.24, 0.19];     // 腹側は淡い
  const LEG = [0.24, 0.135, 0.085];
  const CLAW = [0.34, 0.20, 0.13];
  const TIP = [0.10, 0.075, 0.055];
  const EYE = [0.015, 0.013, 0.016];
  const body = { aLeg: 0, aSeg: 0 };

  // ---- 甲羅 ----
  // 角の丸い四角を、中心から縁へ何枚かの輪で埋める。
  // 上面と腹側を別々に張って、縁で綴じる
  const AROUND = 22, SHELLS = 4;
  const _o = new THREE.Vector3();
  const ringsTop = [], ringsBot = [];
  for (let r = 0; r <= SHELLS; r++) {
    const s = r / SHELLS;
    const rt = [], rb = [];
    for (let k = 0; k < AROUND; k++) {
      caraOutline(k / AROUND, _o);
      // 縁のほうがわずかに広い(前側方が張り出す)甲羅の形
      const x = _o.x * s, z = _o.z * s;
      rt.push(M.v(x, caraTop(s), z, s > 0.82 ? SHELL2 : SHELL, body));
      rb.push(M.v(x, caraBot(s), z, BELLY, body));
    }
    ringsTop.push(rt); ringsBot.push(rb);
  }
  for (let r = 0; r < SHELLS; r++) {
    for (let k = 0; k < AROUND; k++) {
      const k2 = (k + 1) % AROUND;
      M.quad(ringsTop[r][k], ringsTop[r][k2], ringsTop[r + 1][k2], ringsTop[r + 1][k]);
      M.quad(ringsBot[r + 1][k], ringsBot[r + 1][k2], ringsBot[r][k2], ringsBot[r][k]);
    }
  }
  // 縁を綴じる。甲羅の厚みが出る
  for (let k = 0; k < AROUND; k++) {
    const k2 = (k + 1) % AROUND;
    M.quad(ringsTop[SHELLS][k], ringsTop[SHELLS][k2],
           ringsBot[SHELLS][k2], ringsBot[SHELLS][k]);
  }

  // ---- 歩脚 ----
  // 4対。長さは前から2番目・3番目が長い。実物もそうで、
  // いちばん後ろの脚がいちばん短い
  // 長さは脚の張り出しから決める。イソガニは甲幅3.5cmで脚を広げた
  // 差し渡しが9〜10cm——甲幅の2.7倍ほど。つまり中心から片側1.35W。
  // 先端は rx + 0.96L に来るので、いちばん長い脚で L≒0.95。
  // ここを1.50にしていたら差し渡しが甲幅の3.8倍になり、
  // 節を作り直しても蜘蛛のままだった
  const LEG_LEN = [0.80, 0.95, 0.88, 0.68];
  const LEG_Z = [0.16, 0.02, -0.14, -0.30];
  for (const side of [-1, 1]) {
    for (let i = 0; i < CRAB_LEGS; i++) {
      const L = LEG_LEN[i], rz = LEG_Z[i];
      // 付根は甲羅の縁。輪郭から取るとぴたりと生える
      const rx = side * (CARA_W * 0.92);
      const y0 = -0.02;
      const s = side;
      // 隣どうしは半周ずらす(交互に持ち上げる)
      const phase = (i % 2 === 0 ? 0 : Math.PI) + (side > 0 ? 0 : Math.PI);
      const ex = { aLeg: phase };
      // 外へ出て、いったん上がり(長節)、そこから下りて接地する。
      // 上がりきったところが膝で、カニを横から見たときの山になる
      limb(M, [
        [rx,                 y0,             rz],                 // 座節
        [rx + s * 0.24 * L,  y0 + 0.13 * L,  rz - 0.03 * L],      // 長節の腹
        [rx + s * 0.44 * L,  y0 + 0.17 * L,  rz - 0.06 * L],      // 長節/腕節の関節
        [rx + s * 0.63 * L,  y0 + 0.10 * L,  rz - 0.10 * L],      // 腕節/前節の関節
        [rx + s * 0.83 * L,  y0 - 0.06 * L,  rz - 0.13 * L],      // 前節/指節の関節
        [rx + s * 0.96 * L,  y0 - 0.22 * L,  rz - 0.16 * L],      // 指節の先(接地)
      ], [
        [0.082, 0.058],   // 座節。太い
        [0.094, 0.062],   // 長節がいちばん太い
        [0.074, 0.050],
        [0.058, 0.040],
        [0.034, 0.026],
        [0.005, 0.005],   // 指節の先は針
      ], LEG, TIP, ex, 7);
    }
  }

  // ---- 鉗脚(はさみ) ----
  // カニに見えるかどうかはここで決まる。歩脚より太く、
  // 掌節(palm)が大きく膨らみ、そこから不動指が伸び、
  // 可動指が上から噛み合う。指のあいだに隙間が見えること
  for (const side of [-1, 1]) {
    const s = side;
    // 前側方の角から出す。前へ出しすぎると体から浮いて、
    // 低く置きすぎると牙のようにぶら下がって見える
    const bx = s * 0.30, bz = 0.20;
    const ph = side > 0 ? 0.6 : 0.6 + Math.PI;
    const ex = { aLeg: ph };
    // 長節と腕節。体の前へ短く出す
    limb(M, [
      [bx, 0.010, bz],
      [bx + s * 0.055, 0.045, bz + 0.10],
      [bx + s * 0.045, 0.050, bz + 0.19],
    ], [[0.080, 0.066], [0.074, 0.062], [0.066, 0.058]], CLAW, CLAW, ex, 7, 0.94);

    // 掌。左右に平たく、縦に高い板。ここを球にすると鉗脚が
    // 「前にぶら下がった玉」になり、牙のように見える。
    // 実物の掌節は横から見ると三角形に近い、薄くて背の高い形
    // 掌は体の高さのまま、やや内へ寄せて構える。実物のカニは
    // 左右の鋏を胸の前で内向きに合わせている
    const px = bx + s * 0.035, py = 0.050, pz = bz + 0.28;
    dome(M, px, py, pz, 0.052, 0.092, 0.125, CLAW, 6, { ...ex, aSeg: 0.4 });

    // 不動指(掌から前へ)と可動指(上から噛み合う)。
    // 2本のあいだに隙間を残すこと。閉じきると鋏に見えない
    // 不動指は掌の下縁からほぼ水平に前へ。可動指は上から下りてきて、
    // 先で噛み合う。あいだの隙間が見えることが「鋏」の条件
    limb(M, [
      [px, py - 0.048, pz + 0.085],
      [px - s * 0.016, py - 0.054, pz + 0.165],
      [px - s * 0.038, py - 0.046, pz + 0.235],
    ], [[0.036, 0.030], [0.024, 0.020], [0.004, 0.004]], CLAW, TIP, { ...ex }, 6, 0.95);
    limb(M, [
      [px, py + 0.054, pz + 0.080],
      [px - s * 0.016, py + 0.006, pz + 0.158],
      [px - s * 0.038, py - 0.036, pz + 0.228],
    ], [[0.032, 0.028], [0.022, 0.018], [0.004, 0.004]], CLAW, TIP, { ...ex }, 6, 0.95);
  }

  // ---- 眼 ----
  // 短い柄の先に黒い球。柄は甲羅の前側方の角(眼窩)から出る。
  // ここがあると急に生き物になる
  for (const side of [-1, 1]) {
    const ex = { aLeg: 0 };
    // 眼球は甲幅の5%ほど(0.025)。0.031にしていたらピンポン玉に見えた
    limb(M, [
      [side * 0.21, 0.060, 0.325],
      [side * 0.240, 0.082, 0.352],
    ], [[0.017, 0.017], [0.015, 0.015]], SHELL2, SHELL2, ex, 5, 1.0);
    dome(M, side * 0.248, 0.090, 0.363, 0.025, 0.025, 0.025, EYE, 4, body);
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
  const COL = [0.26, 0.085, 0.070];    // 柱部。暗い赤褐色
  const WART = [0.30, 0.20, 0.16];     // 疣。貝殻の欠片をくっつけて白っぽい
  const DISC = [0.20, 0.145, 0.055];   // 口盤
  const TENT = [0.34, 0.30, 0.115];    // 触手。緑がかった褐色

  // ---- 柱部 ----
  // ただの円錐にしていたら、素焼きの植木鉢に見えた。
  // 磯のイソギンチャク(ヨロイイソギンチャク等)の体側には疣(いぼ)が
  // 縦の列に並んでいて、そこに貝殻や砂粒をくっつけている。
  // 一つ一つは数mmだが、これがあるかないかで
  // 「生きもの」か「陶器」かが決まる
  const ROWS = 7, AROUND = 20;
  const rows = [];
  for (let i = 0; i <= ROWS; i++) {
    const t = i / ROWS;
    // 樽形。付け根がいちばん太く、口盤の手前でいったん締まる
    const r = 0.5 * (0.96 - 0.10 * t - 0.14 * t * t);
    const row = [];
    for (let k = 0; k < AROUND; k++) {
      const a = (k / AROUND) * Math.PI * 2;
      // 疣。縦の列に並べ、上下方向にも粒を並べる。
      // 周方向の周期を頂点数と揃えてはいけない——AROUND/2 にしていたら
      // 全頂点でちょうど sin が 0 になり、疣が1つも出ていなかった
      const wart = Math.max(Math.sin(a * 5) * Math.sin(t * Math.PI * 5.5), 0);
      const rr = r * (1 + wart * 0.10);
      row.push(M.v(Math.cos(a) * rr, t * 0.50, Math.sin(a) * rr,
                   i === ROWS ? DISC : (wart > 0.55 ? WART : COL),
                   { aOpen: t * 0.35, aRad: 0 }));
    }
    rows.push(row);
  }
  for (let i = 0; i < ROWS; i++) {
    for (let k = 0; k < AROUND; k++) {
      const k2 = (k + 1) % AROUND;
      M.quad(rows[i][k], rows[i][k2], rows[i + 1][k2], rows[i + 1][k]);
    }
  }
  // ---- 口盤 ----
  // 平らな蓋ではなく、中央がわずかに窪んで口がある
  const discIn = [];
  for (let k = 0; k < AROUND; k++) {
    const a = (k / AROUND) * Math.PI * 2;
    discIn.push(M.v(Math.cos(a) * 0.13, 0.492, Math.sin(a) * 0.13,
                    DISC, { aOpen: 0.35, aRad: 0 }));
  }
  for (let k = 0; k < AROUND; k++) {
    const k2 = (k + 1) % AROUND;
    M.quad(rows[ROWS][k], rows[ROWS][k2], discIn[k2], discIn[k]);
  }
  const mouth = M.v(0, 0.478, 0, DISC, { aOpen: 0.35, aRad: 0 });
  for (let k = 0; k < AROUND; k++) M.tri(discIn[k], discIn[(k + 1) % AROUND], mouth);

  // ---- 触手 ----
  // 4重の輪。外側ほど長く、内側は短い。実物は数十本あって、
  // 1列だけだと茨の冠になる。先は尖らせないこと——
  // イソギンチャクの触手の先は丸い
  const WHORL = [
    { r: 0.34, n: 16, len: 0.42, w: 0.036 },
    { r: 0.28, n: 13, len: 0.36, w: 0.032 },
    { r: 0.22, n: 10, len: 0.29, w: 0.028 },
    { r: 0.16, n: 7,  len: 0.22, w: 0.024 },
  ];
  const SIDES = 5;
  for (let wi = 0; wi < WHORL.length; wi++) {
    const { r: rr, n, len, w } = WHORL[wi];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + wi * 0.37;
      const ca = Math.cos(a), sa = Math.sin(a);
      // 付け根から外へ倒れながら伸び、先で少し持ち上がる
      const pts = [
        [ca * rr, 0.50, sa * rr, 0.10, w],
        [ca * (rr + len * 0.40), 0.50 + len * 0.34, sa * (rr + len * 0.40), 0.45, w * 0.82],
        [ca * (rr + len * 0.78), 0.50 + len * 0.44, sa * (rr + len * 0.78), 0.80, w * 0.58],
        [ca * (rr + len * 1.00), 0.50 + len * 0.36, sa * (rr + len * 1.00), 1.00, w * 0.30],
      ];
      let prev = null;
      for (const [px, py, pz, rad, ww] of pts) {
        const ring = [];
        for (let j = 0; j < SIDES; j++) {
          const th = (j / SIDES) * Math.PI * 2;
          ring.push(M.v(px - sa * Math.cos(th) * ww,
                        py + Math.sin(th) * ww,
                        pz + ca * Math.cos(th) * ww,
                        TENT, { aOpen: 0.2 + 0.8 * rad, aRad: rad }));
        }
        if (prev) for (let j = 0; j < SIDES; j++) {
          const j2 = (j + 1) % SIDES;
          M.quad(prev[j], prev[j2], ring[j2], ring[j]);
        }
        prev = ring;
      }
      // 先端は丸く閉じる
      const last = pts[pts.length - 1];
      const tip = M.v(last[0] + ca * 0.012, last[1] + 0.004, last[2] + sa * 0.012,
                      TENT, { aOpen: 1.0, aRad: 1.0 });
      for (let j = 0; j < SIDES; j++) M.tri(prev[j], prev[(j + 1) % SIDES], tip);
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
  const TOP = [0.115, 0.135, 0.165];   // 背面。青灰
  const TOP2 = [0.36, 0.155, 0.070];   // 橙の斑
  const UNDER = [0.42, 0.33, 0.20];    // 腹面は淡い
  const ARMS = 5;

  // 磯でいちばん見るのはイトマキヒトデ。細い5本腕の星ではなく、
  // 腕と腕のあいだに膜が張った「ふくらんだ五角形」をしている。
  // 腕の先までの長さと、腕のあいだの谷の長さの比が 1.8 ほどしかない。
  //
  // 尖った星形にすると、しかも縁をナイフのように薄くすると、
  // 折り紙を岩に貼ったように見える。実際そうなっていた。
  // ヒトデは薄い紙ではなく、厚みのある座布団
  const R_ARM = 0.50;        // 腕の先まで
  const R_WEB = 0.285;       // 腕と腕のあいだ
  const H0 = 0.125;          // 中央の厚み。直径の 1/8
  const AROUND = 45, RINGS = 6;
  const edgeR = (a) => R_WEB + (R_ARM - R_WEB) * (0.5 + 0.5 * Math.cos(a * ARMS));
  // 上面。中央が高く、縁で落ちる。腕の上にはわずかな稜線がある
  // 腕の稜線は中心では効かせない。t を掛け忘れていたら、
  // 中央のハブ1点と最初の輪の高さが腕ごとに4cmずれて、
  // 甲の真ん中に星形の窪みが開いた
  const topY = (t, a) => H0 * Math.pow(Math.max(1 - t * t, 0), 0.55)
                            * (1 + 0.16 * t * Math.cos(a * ARMS)) + 0.010;

  const hubT = M.v(0, topY(0, 0), 0, TOP, { aArm: 0 });
  const hubB = M.v(0, 0, 0, UNDER, { aArm: 0 });
  const top = [], bot = [];
  for (let i = 1; i <= RINGS; i++) {
    const t = i / RINGS;
    const rt = [], rb = [];
    for (let k = 0; k < AROUND; k++) {
      const a = (k / AROUND) * Math.PI * 2;
      const r = edgeR(a) * t;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      // 斑。イトマキヒトデは青灰の地に橙がまだらに乗る
      const mot = Math.sin(x * 19 + z * 13) + Math.sin(x * 7 - z * 23) * 0.7;
      rt.push(M.v(x, topY(t, a), z, mot > 0.45 ? TOP2 : TOP, { aArm: t }));
      rb.push(M.v(x, 0, z, UNDER, { aArm: t }));
    }
    top.push(rt); bot.push(rb);
  }
  for (let k = 0; k < AROUND; k++) {
    const k2 = (k + 1) % AROUND;
    M.tri(hubT, top[0][k], top[0][k2]);
    M.tri(hubB, bot[0][k2], bot[0][k]);
  }
  for (let i = 0; i < RINGS - 1; i++) {
    for (let k = 0; k < AROUND; k++) {
      const k2 = (k + 1) % AROUND;
      M.quad(top[i][k], top[i][k2], top[i + 1][k2], top[i + 1][k]);
      M.quad(bot[i][k2], bot[i][k], bot[i + 1][k], bot[i + 1][k2]);
    }
  }
  // 縁。厚みを閉じる
  const e = RINGS - 1;
  for (let k = 0; k < AROUND; k++) {
    const k2 = (k + 1) % AROUND;
    M.quad(top[e][k], top[e][k2], bot[e][k2], bot[e][k]);
  }
  return M.geo({ aCol: 3 });
}
// ================================================================ ウニ
//
// バフンウニ。潮だまりでいちばん多い。殻の直径3〜4cm。
// 岩の窪みに嵌まって動かない。棘は生きていて、影が差すと一斉に動く。
function urchinGeometry() {
  const M = new Buf();
  const TEST = [0.055, 0.048, 0.075];    // 殻。ほとんど黒に近い紫
  const SPINE = [0.105, 0.075, 0.135];
  const body = { aSpine: 0 };

  // バフンウニ。磯の潮だまりでいちばん多い。ムラサキウニのような
  // 長い棘ではなく、短い棘がびっしり生えた「毬」で、
  // 殻も球ではなく上下に潰れている(高さは直径の半分ほど)。
  //
  // 長い棘をまばらに生やすと、ウニではなくウイルスの模式図になる。
  // 見た目を決めているのは棘の長さではなく密度のほう
  const TR = 0.42, TH = 0.24;            // 殻。直径0.84 高さ0.48
  const N = 165, LEN = 0.20;             // 棘は直径の1/4しかない
  dome(M, 0, TH, 0, TR, TH, TR, TEST, 7, body);

  let s = 12345;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  for (let i = 0; i < N; i++) {
    // 黄金角でまく。乱数だと固まったり空いたりして、density が読めない
    const u = 1 - (i / (N - 1)) * 1.45;   // 上から下四分の三まで
    const rr = Math.sqrt(Math.max(1 - u * u, 0));
    const th = i * 2.39996;
    const nx = Math.cos(th) * rr, ny = u, nz = Math.sin(th) * rr;
    // 殻の上の点と、そこでの外向き。回転楕円体なので位置ベクトルとは違う
    const bx = nx * TR, by = TH + ny * TH, bz = nz * TR;
    let ox = nx / TR, oy = ny / TH, oz = nz / TR;
    const ol = Math.hypot(ox, oy, oz) || 1;
    ox /= ol; oy /= ol; oz /= ol;
    const len = LEN * (0.80 + 0.42 * rnd());
    // 断面をつくる2軸
    const t1 = Math.abs(oy) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let ax = [oy * t1[2] - oz * t1[1], oz * t1[0] - ox * t1[2], ox * t1[1] - oy * t1[0]];
    const al = Math.hypot(...ax) || 1;
    ax = [ax[0] / al, ax[1] / al, ax[2] / al];
    const bx2 = [oy * ax[2] - oz * ax[1], oz * ax[0] - ox * ax[2], ox * ax[1] - oy * ax[0]];
    // 付け根に疣(いぼ)、中ほどで細り、先は丸い。4角でも小さいので丸く見える
    const SIDES = 4;
    const steps = [[0.00, 0.021], [0.45, 0.012]];
    let prev = null;
    for (const [f, w] of steps) {
      const px = bx + ox * len * f, py = by + oy * len * f, pz = bz + oz * len * f;
      const ring = [];
      for (let k = 0; k < SIDES; k++) {
        const a = (k / SIDES) * Math.PI * 2;
        const c = Math.cos(a) * w, d = Math.sin(a) * w;
        ring.push(M.v(px + ax[0] * c + bx2[0] * d,
                      py + ax[1] * c + bx2[1] * d,
                      pz + ax[2] * c + bx2[2] * d, SPINE, { aSpine: f }));
      }
      if (prev) for (let k = 0; k < SIDES; k++) {
        const k2 = (k + 1) % SIDES;
        M.quad(prev[k], prev[k2], ring[k2], ring[k]);
      }
      prev = ring;
    }
    const tip = M.v(bx + ox * len, by + oy * len, bz + oz * len, SPINE, { aSpine: 1 });
    for (let k = 0; k < SIDES; k++) M.tri(prev[k], prev[(k + 1) % SIDES], tip);
  }
  return M.geo({ aCol: 3 });
}
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
    // 棘を短くしたぶん、体そのものが小さくなった。影も合わせる——
    // 影は殻の接地面のまわりだけで、棘の広がりまで覆わない
    // (棘のあいだは光が抜ける)。浮きは殻の中心の高さ 0.24
    return { x, z, y, size: 0.048 + Math.random() * 0.026, lift: 0,
             shadow: 1.35, hover: 0.24 };
  });
}

// 形だけを単体で確かめるための口(検証用のビューアから読む)
export const __shapes = {
  crab: crabGeometry, anemone: anemoneGeometry, star: starGeometry, urchin: urchinGeometry,
};
