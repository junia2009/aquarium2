import * as THREE from 'three';
import { baseUniforms } from '../env.js';
import { UW_FRAG_PRELUDE, UW_FRAG_OUTPUT } from '../glsl.js';
import { FISH_SHAPES } from '../creatures/fishGeometry.js';
import { createFishMaterial } from '../creatures/fishMaterial.js';
import { School, makeSchoolInstanceAttr } from '../creatures/school.js';

// ============ プロテウスの外 ============
//
// 舷窓の中身は、はじめ板に貼ったシェーダで描いていました。視線の向きで
// 色を決めていたので視差はつきますが、そこにあるのは結局「水の色の関数」
// です。海底も、施設が自分で照らしている光も、足もとに沈んでいるものも
// 無い。窓の外が適当に見えるのは当たり前でした。
//
// ここでは**実体を置きます**。壁に本当の穴を開けて、外に海底・投光器・
// 光の筋・マリンスノー・隣の区画を建てる。そうすれば、
//   ・頭を動かせば正しく視差がつく(近い岩は速く、遠い区画は遅く動く)
//   ・投光器の光が、海底の実際の起伏に沿って落ちる
//   ・窓の枠に隠れて見切れる。覗きこめば見える
// という、絵では作れないものが全部ただで手に入ります。
//
// 光の当て方は水槽と同じ道具立て(applyUnderwaterFog / 距離減衰)を
// 使い回します。外だけ別の理屈で描くと、窓のところで世界が切り替わる。

export const FLOOR_Y = 1.15;         // 海底の基準面
// 海底は施設の真下まで敷く。殻の外から始めると、脚のあいだから
// 覗いたときに床が無く、背景ドームが見えてしまう
const FLOOR_R0 = 1.2;
// 海底は視程よりずっと遠くまで敷く。途中で切れると、そこに
// 「地面の終わり」の線が出て、空と地平線のある陸の風景になる
const FLOOR_R1 = 240.0;

// --- 外の投光器 ---
// 器具の位置は舷窓の数で変わるので、シェーダの文字列を組み立てる。
// ユニフォーム配列にしてもよいが、殻を作り直すのは行き先が変わった
// ときの一度きりなので、焼き込むほうが速いし読みやすい
function floodGLSL(lights) {
  const v3 = (a) => `vec3(${a.map((x) => x.toFixed(3)).join(',')})`;
  const body = lights
    .map((L) => `s += flood1(wp, n, ${v3(L.p)}, ${v3(L.d)}, ${v3(L.c)}, ${L.k.toFixed(3)});`)
    .join('\n      ');
  return /* glsl */ `
    vec3 flood1(vec3 wp, vec3 n, vec3 lp, vec3 ld, vec3 lc, float spread) {
      vec3 d = lp - wp;
      float dist = length(d);
      vec3 L = d / max(dist, 0.001);
      // 器具から見て、その点は照射方向の何度ずれているか。
      // spread が小さいほど絞った配光になる
      float cs = dot(-L, ld);
      float cone = smoothstep(1.0 - spread, 1.0 - spread * 0.22, cs);
      // 距離による減衰は2つ掛かる。
      //
      //  1) 広がりによる 1/r^2 —— どんな光にもある
      //  2) 水そのものの吸収 —— 器具から面まで進むあいだに吸われる
      //
      // 2は**波長ごと**に効く。往路で赤が抜け、復路(extFog)でもう一度
      // 抜けるので、遠くの面ほど強く青緑へ寄る。灰色の減衰にして
      // いたときは、明るさだけが落ちて夜の陸に見えていた
      float att = 1.0 / (1.0 + 0.030 * dist + 0.0060 * dist * dist);
      vec3 absorb = exp(-${EXT_ABSORB} * dist);
      // 器具ごとに色を持たせる。白い投光器と、栽培区画の桃色の育成灯が
      // 同じ海底に別々の溜まりを作る
      return lc * ((max(dot(n, L), 0.0) * 0.88 + 0.12) * att * cone) * absorb;
    }
    vec3 floodLight(vec3 wp, vec3 n) {
      vec3 s = vec3(0.0);
      ${body}
      return s;
    }
  `;
}

// 外の水の霧。
//
// 室内と同じ applyUnderwaterFog を使うと、外は完全に黒く沈む。
// 施設の霧の色(#0b151e)は「13mの部屋を澄んで見せる」ために選んだ色で、
// 50m 先の斜面を描くための色ではない。実際それで、窓の正面が
// また真っ暗な四角に戻っていた。
//
// 外は外の水として持つ。投光器に照らされた水は、遠くほど白く濁って
// 見える——潜水艇の映像でいちばん目につくのがこれで、
// 遠くの地形が「影」として読めるのはこの濁りのおかげ。
// ただし明るくしすぎると窓が乳白色の板になるので、
// 室内の壁(表示 0.45)よりはっきり暗いところに置く
//
// 水は距離に応じて**色を変える**。ここがいちばん大事なところ。
//
// 「海底基地なのに陸の上に見える」と言われた原因はこれだった。
// 元の式は距離が伸びるほど暗い青へ寄せるだけで、明るさしか動いて
// いない。明るさだけが落ちる景色は、夜の地面を投光器で照らしたのと
// 区別がつかない——実際そう見えていた。
//
// 水中で起きているのは吸収と散乱の2つで、しかも**波長ごとに速さが
// 違う**。赤は緑の3倍、青の4倍以上の速さで吸われる。だから
//   ・近くの面は本来の色
//   ・10m 先はもう赤が抜けて青緑
//   ・30m 先は色が無くなり、水そのものの色に沈む
// という並びができる。この色の勾配だけが「あいだに水がある」ことを
// 語れる。霧の濃さをいくら調整しても代わりにはならない。
// m^-1。赤から先に吸われる。
//
// 最初 (0.085, 0.030, 0.019) にしたら、往路と復路で二重に掛かるので
// 20m 先で赤が 1/30 になり、画面ぜんたいが一色の青緑に潰れた。
// 「水の中」には見えるが、投光器が白いことが伝わらず、明暗しか
// 情報が無い絵になる。器具のそばに色が残る強さまで緩める
const EXT_ABSORB = 'vec3(0.055, 0.022, 0.014)';

const EXT_FOG = /* glsl */ `
  // 遠方の水そのものの色。上を見るほどわずかに明るい
  vec3 extWater(float y) {
    return mix(vec3(0.0035, 0.0080, 0.0125),
               vec3(0.0075, 0.0185, 0.0270),
               clamp((y - ${FLOOR_Y.toFixed(2)}) * 0.055, 0.0, 1.0));
  }
  vec3 extFog(vec3 col, vec3 wp) {
    float d = distance(cameraPosition, wp);
    // 面から目までのあいだに吸われるぶん(波長ごと)
    vec3 absorb = exp(-${EXT_ABSORB} * d);
    // そのあいだの水自身が散らして届けるぶん
    float scat = 1.0 - exp(-d * 0.021);
    return col * absorb + extWater(wp.y) * scat;
  }
`;

const LIT_VERT = /* glsl */ `
  attribute vec3 aCol;
  varying vec3 vCol;
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    vCol = aCol;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

// --- 海底 ---
//
// 深海の底は砂ではなく、降り積もった細かい泥です。硬い面ではないので
// ハイライトを出さないこと。反射があると濡れた岩に見えてしまい、
// 「何千年ぶんの堆積物」に見えません。
const FLOOR_FRAG = /* glsl */ `
  varying vec3 vW;
  varying vec3 vN;
  void main() {
    vec3 n = normalize(vN);
    // 細かい模様と大きなうねりを重ねる。片方だけだと、
    // 近くで平坦か、遠くで縞に見えるかのどちらかになる
    float g = fbm(vW.xz * 0.85) * 0.55 + fbm(vW.xz * 0.13) * 0.45;
    vec3 alb = mix(vec3(0.070, 0.068, 0.061), vec3(0.128, 0.123, 0.108), g);
    // 生き物が這った跡。深海底には必ずある。
    // 曲がった細い溝で、これがあるだけで「泥」に見える
    float tr = fbm(vec2(vW.x * 0.30 + fbm(vW.xz * 0.11) * 3.0, vW.z * 0.30));
    alb *= 1.0 - 0.30 * smoothstep(0.62, 0.72, tr) * smoothstep(0.80, 0.70, tr);
    vec3 col = alb * (vec3(0.030, 0.046, 0.062) + floodLight(vW, n));
    gl_FragColor = vec4(extFog(col, vW), 1.0);
    ${UW_FRAG_OUTPUT}
  }
`;

// --- 外の構造物(脚・隣の区画・岩) ---
const HULL_FRAG = /* glsl */ `
  varying vec3 vCol;
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vec3 n = gl_FrontFacing ? normalize(vN) : -normalize(vN);
    // 外に出ている鋼は、必ず海洋生物に覆われる。上向きの面ほど厚い
    float foul = smoothstep(0.1, 0.9, n.y) * (0.35 + 0.65 * fbm(vW.xz * 1.7));
    vec3 alb = mix(vCol, vec3(0.085, 0.098, 0.072), foul * 0.55);
    // 錆の縦垂れ
    float st = fbm(vec2(atan(vW.z, vW.x) * 26.0, vW.y * 0.24));
    alb = mix(alb, alb * vec3(0.72, 0.46, 0.28),
              smoothstep(0.50, 0.85, st) * (1.0 - abs(n.y)) * 0.6);
    vec3 col = alb * (vec3(0.030, 0.046, 0.062) + floodLight(vW, n));
    gl_FragColor = vec4(extFog(col, vW), 1.0);
    ${UW_FRAG_OUTPUT}
  }
`;

// --- 投光器から伸びる光の筋 ---
//
// 室内の筋と同じ理屈。厚みは |n・v| で取る——輪郭で 1 にすると
// 円錐の線画になる。外は水が濁っているぶん、室内より濃く出してよい
const BEAM_FRAG = /* glsl */ `
  varying vec3 vW;
  varying vec3 vN;
  varying float vT;
  void main() {
    vec3 v = normalize(cameraPosition - vW);
    float thick = pow(abs(dot(normalize(vN), v)), 0.8);
    float fall = pow(1.0 - vT, 1.15);
    float d = fbm(vec2(vW.x * 0.9 + vW.z * 0.6, vW.y * 1.3 - mod(uTime, 900.0) * 0.07));
    float a = thick * fall * (0.55 + 0.60 * d) * 0.30;
    // 遠い筋まで同じ濃さで出すと、霧の奥行きが壊れる
    a *= exp(-distance(cameraPosition, vW) * 0.012);
    // 筋そのものが「水が光を散らしている姿」なので、ここも波長で
    // 吸わせる。白い錐のままだと、埃っぽい空気の中の投光器に見える
    vec3 tint = vec3(0.62, 0.78, 0.92) * exp(-vec3(0.055, 0.020, 0.012) * vT * 11.0);
    gl_FragColor = vec4(tint * a, a);
    ${UW_FRAG_OUTPUT}
  }
`;

const BEAM_VERT = /* glsl */ `
  attribute float aT;
  varying vec3 vW;
  varying vec3 vN;
  varying float vT;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz; vN = normalize(mat3(modelMatrix) * normal); vT = aT;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

// 観測帯のガラス。天蓋と同じで、素通しに映り込みだけを足す。
// すれすれの角度でだけ立ち上げないと、部屋ぜんたいが曇って見える
const ANNEX_GLASS_FRAG = /* glsl */ `
  varying vec3 vCol;
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vec3 n = gl_FrontFacing ? normalize(vN) : -normalize(vN);
    vec3 v = normalize(cameraPosition - vW);
    float fres = pow(1.0 - abs(dot(n, v)), 4.5);
    float dirt = smoothstep(0.5, 0.9, fbm(vec2(vW.x * 0.5, vW.y * 0.7)));
    float a = 0.004 + 0.075 * fres * (0.8 + 0.5 * dirt);
    gl_FragColor = vec4(vec3(0.34, 0.46, 0.55) * a, a);
    ${UW_FRAG_OUTPUT}
  }
`;

// 形を組む小道具(hub.js の Buf と同じ作り。あちらは非公開なので持つ)
class Buf {
  constructor() { this.p = []; this.c = []; this.i = []; }
  v(x, y, z, col) {
    const k = this.p.length / 3;
    this.p.push(x, y, z); this.c.push(col[0], col[1], col[2]);
    return k;
  }
  tri(a, b, c) { this.i.push(a, b, c); }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  geo() {
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
    g.setIndex(this.i);
    return g;
  }
}

// 施設は窪地の底にいる。遠くへ行くほど底が持ち上がる。
//
// 平らな底にすると、部屋の中心に立って窓を見たとき、水平の視線には
// 何も映らない——敷居に遮られて海底は見えず、真っ暗な四角になる。
// 実際そうなっていた。海底は「下にある」だけでなく「遠くで立ち上がって
// 目の高さまで来る」ものにして初めて、窓の正面に海が見える
// ============ 観測棟 ============
//
// 隣に建っているもう1棟。中に入れる。
//
// 位置は固定値で持つ。舷窓の角度から導くと、行き先(水槽)が1つ増えた
// だけで建物が動いてしまう。建物は動かないから建物であって、
// 「同じ場所に帰ってきた」という感じもそこから来る。
export const ANNEX = {
  a: -Math.PI * 0.5 + Math.PI / 5 + 0.30,   // 施設から見た方角(固定)
  dist: 48,                                  // 中心までの距離
  radius: 5.2,                               // 外半径
  wall: 7.0,                                 // 円筒の高さ
  // ガラスの下端。目の高さ(床+1.5m)より下に来ないと、立ったときに
  // 鋼の壁しか見えない——外を見るための建物なのに外が見えなかった
  sill: 1.15,
  door: 2.30,                                // 出入口の高さ
  doorArc: 0.30,                             // 出入口の半角(ラジアン)
  // 出入口の向き。連絡通路の真正面に開けると、通路そのものが
  // 戸口を塞いでしまう。通路の脇へずらす
  doorOff: 0.85,
};
ANNEX.x = Math.cos(ANNEX.a) * ANNEX.dist;
ANNEX.z = Math.sin(ANNEX.a) * ANNEX.dist;

export function riseAt(r) {
  const t = Math.min(Math.max((r - 22) / 56, 0), 1);
  return t * t * (3 - 2 * t) * 8.5;
}

// 観測棟の据わっている高さと、中の床。riseAt に依るのでここで確定する
ANNEX.base = FLOOR_Y + riseAt(ANNEX.dist) + 0.4;
ANNEX.floor = ANNEX.base + 0.55;
ANNEX.inner = ANNEX.radius - 0.35;

// 決まった種から作る乱数。作り直しても同じ景色になる——
// ハッチが増えるたびに外の岩が別の場所へ移ると、
// 「同じ場所に帰ってきた」感じが壊れる
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const STEEL = [0.138, 0.146, 0.154];
const STEEL2 = [0.120, 0.128, 0.138];
const ROCK = [0.088, 0.086, 0.080];
const DECKC = [0.112, 0.118, 0.126];   // 観測棟の床
// 海藻。褐藻はよく光を返すので、岩よりはっきり明るく取る。
// 暗く置くと、育成灯の下以外では「あるのに見えない」ことになる
const KELP = [0.105, 0.195, 0.115];

// --- 海藻 ---
//
// 一枚の葉を、根もとを軸にして撓ませる。上へ行くほど大きく揺れ、
// 隣の葉と位相をずらす。全部が同じ動きをすると、水ではなく
// 一枚の布が揺れているように見える。
const KELP_VERT = /* glsl */ `
  // 共通の前置き(UW_FRAG_PRELUDE)はフラグメント側にしか入らない。
  // 頂点シェーダで使うユニフォームは、ここで自分で宣言する
  uniform float uTime;
  attribute vec3 aCol;
  attribute vec3 aRoot;    // 根もとの位置
  attribute vec3 aParam;   // x:高さ y:向き z:位相
  varying vec3 vCol;
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    float t = position.y / max(aParam.x, 0.001);   // 0=根 1=先
    // 撓みは高さの2乗で効く。線形にすると根もとから折れて見える
    float amp = t * t * (0.20 + 0.55 * aParam.x);
    float ph = uTime * 0.55 + aParam.z;
    vec3 p = position;
    p.x += sin(ph) * amp + sin(ph * 2.3 + t * 3.0) * amp * 0.30;
    p.z += cos(ph * 0.8) * amp * 0.55;
    // 向き
    float c = cos(aParam.y), s = sin(aParam.y);
    vec3 r = vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c);
    vec4 wp = modelMatrix * vec4(r + aRoot, 1.0);
    vW = wp.xyz;
    // 葉は薄いので、法線は撓みに合わせて振るだけでよい
    vN = normalize(mat3(modelMatrix) * vec3(sin(ph) * 0.6 * c - s, 0.25, sin(ph) * 0.6 * s + c));
    vCol = aCol;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

// 海藻の照らし方。金属ではないので、錆の縦垂れや生物付着の項が
// 要らないぶん HULL_FRAG より軽い
const LIFE_FRAG = /* glsl */ `
  varying vec3 vCol;
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vec3 n = gl_FrontFacing ? normalize(vN) : -normalize(vN);
    vec3 col = vCol * (vec3(0.030, 0.046, 0.062) + floodLight(vW, n));
    gl_FragColor = vec4(extFog(col, vW), 1.0);
    ${UW_FRAG_OUTPUT}
  }
`;

// ============ 標識灯 ============
//
// 「海底調査用研究所」を一目で言うのは、建物の形よりも**灯り**です。
// 暗い水の中で、色のついた小さな光が規則正しく並んでいる——
// それだけで「人が運用している設備」に見える。自然界に等間隔の
// 点滅光は無いので、これは形よりも強い合図になります。
//
// 灯りは2枚で1組。器具そのもの(小さな発光面)と、まわりの水が
// 散らす暈(かさ)。暈が無いと、暗闇に貼った色つきのシールにしか
// 見えません——水中では光源のまわりが必ず滲みます。
class Neon {
  constructor() { this.q = []; }
  /**
   * @param {number[]} p   位置
   * @param {number[]} c   色(線形)
   * @param {number} size  器具の大きさ(m)
   * @param {number} hz    点滅の速さ。0 なら常時点灯
   * @param {number} phase 点滅の位相
   */
  add(p, c, size = 0.10, hz = 0, phase = 0) {
    this.q.push({ p, c, size, hz, phase });
  }
  build(group) {
    if (!this.q.length) return;
    // --- 器具の発光面。小さな8面体にして、どの向きからも見える ---
    const pos = [], col = [], bl = [], idx = [];
    const V = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const F = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4],
               [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]];
    for (const L of this.q) {
      const base = pos.length / 3;
      for (const v of V) {
        pos.push(L.p[0] + v[0] * L.size, L.p[1] + v[1] * L.size, L.p[2] + v[2] * L.size);
        col.push(L.c[0], L.c[1], L.c[2]);
        bl.push(L.hz, L.phase);
      }
      for (const f of F) idx.push(base + f[0], base + f[1], base + f[2]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('aCol', new THREE.BufferAttribute(new Float32Array(col), 3));
    g.setAttribute('aBlink', new THREE.BufferAttribute(new Float32Array(bl), 2));
    g.setIndex(idx);
    group.add(new THREE.Mesh(g, new THREE.ShaderMaterial({
      uniforms: baseUniforms(),
      vertexShader: NEON_VERT,
      fragmentShader: NEON_FRAG,
      // トーンマッピングは通さない。ACES は明るい色ほど白へ寄せるので、
      // 通すとネオンから色が抜けて、ただの白い点になる
      side: THREE.DoubleSide,
    })));

    // --- 暈。Points なら常に画面を向くので、板を回す手間が要らない ---
    const hp = new Float32Array(this.q.length * 3);
    const hc = new Float32Array(this.q.length * 3);
    const hb = new Float32Array(this.q.length * 3);   // x:速さ y:位相 z:大きさ
    this.q.forEach((L, i) => {
      hp[i * 3] = L.p[0]; hp[i * 3 + 1] = L.p[1]; hp[i * 3 + 2] = L.p[2];
      hc[i * 3] = L.c[0]; hc[i * 3 + 1] = L.c[1]; hc[i * 3 + 2] = L.c[2];
      hb[i * 3] = L.hz; hb[i * 3 + 1] = L.phase; hb[i * 3 + 2] = L.size;
    });
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.BufferAttribute(hp, 3));
    hg.setAttribute('aCol', new THREE.BufferAttribute(hc, 3));
    hg.setAttribute('aBlink', new THREE.BufferAttribute(hb, 3));
    group.add(new THREE.Points(hg, new THREE.ShaderMaterial({
      uniforms: baseUniforms(),
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    })));
  }
}

// 点滅の形。ゆっくり明滅ではなく、短く光って長く消えるほうが
// 「機械が知らせている」に見える
const BLINK_GLSL = /* glsl */ `
  float blink(float hz, float phase) {
    if (hz < 0.001) return 1.0;
    float s = sin(uTime * hz + phase) * 0.5 + 0.5;
    return 0.18 + 0.82 * pow(s, 5.0);
  }
`;

const NEON_VERT = /* glsl */ `
  uniform float uTime;
  attribute vec3 aCol;
  attribute vec2 aBlink;
  varying vec3 vC;
  ${BLINK_GLSL}
  void main() {
    vC = aCol * blink(aBlink.x, aBlink.y);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const NEON_FRAG = /* glsl */ `
  varying vec3 vC;
  void main() {
    gl_FragColor = vec4(vC, 1.0);
    #include <colorspace_fragment>
  }
`;

const HALO_VERT = /* glsl */ `
  uniform float uTime;
  attribute vec3 aCol;
  attribute vec3 aBlink;
  varying vec3 vC;
  varying float vD;
  ${BLINK_GLSL}
  void main() {
    vC = aCol * blink(aBlink.x, aBlink.y);
    vec4 mv = viewMatrix * modelMatrix * vec4(position, 1.0);
    vD = -mv.z;
    // 暈は器具の10倍ほどに広がる。遠くても最低限の大きさは残す
    gl_PointSize = max(aBlink.z * 130.0 / max(-mv.z, 1.0), 2.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const HALO_FRAG = /* glsl */ `
  varying vec3 vC;
  varying float vD;
  void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(q, q);
    if (r2 > 1.0) discard;
    // 中心が濃く、外へ急に薄れる。線形に落とすと綿のような玉になる
    float a = pow(1.0 - r2, 3.0) * 0.55;
    // 水が散らす光なので、遠いほど滲みは弱く
    a *= exp(-vD * 0.020);
    gl_FragColor = vec4(vC * a, a);
    #include <colorspace_fragment>
  }
`;

/**
 * 施設の外を建てる。
 *
 * @param {THREE.Group} root  ゾーンの根
 * @param {number[]} winAngles 舷窓の角度。投光器はここに取り付ける
 * @param {number} hullR      殻の外半径
 * @param {number} deckY      甲板の高さ
 * @returns {{update:Function}}
 */
export function buildExterior(root, winAngles, hullR, deckY, domeTop, world) {
  const group = new THREE.Group();
  group.userData.portal = true;      // 作り直しのときに一緒に消える
  root.add(group);

  // ---- 投光器の配置 ----
  // 舷窓1枚につき2基。窓の真上に1基だと、窓の正面がいちばん暗くなる。
  // 左右に振って、見ている先が両側から照らされるようにする
  const FL_Y = deckY + 5.6;
  const lights = [];
  const fixtures = [];
  const WHITE = [9.6, 9.2, 9.0];
  for (const wa of winAngles) {
    for (const off of [-0.155, 0.155]) {
      const a = wa + off;
      const p = [Math.cos(a) * (hullR + 0.55), FL_Y, Math.sin(a) * (hullR + 0.55)];
      // 外向き・下向き。海底の見える範囲を照らす角度に振る
      const d = new THREE.Vector3(Math.cos(a) * 0.62, -0.78, Math.sin(a) * 0.62).normalize();
      lights.push({ p, d: [d.x, d.y, d.z], c: WHITE, k: 0.45 });
      fixtures.push({ p, d, a });
    }
  }

  // ---- 海藻の栽培区画 ----
  //
  // 太陽の届かない深さに海藻が生えているのは嘘になる。だが
  // **育成灯の下でなら本当**で、しかもそれは海底調査用研究所が
  // やっていて当然のことでもある。「海藻が欲しい」と「研究所らしく
  // したい」と「ネオンを増やしたい」が、この一つで全部片づく。
  //
  // 育成灯が桃色なのは飾りではない。植物が使うのは主に赤と青で、
  // 緑はほとんど反射してしまう——だから実物の植物育成 LED は
  // 赤+青、つまり混ざって桃色に見える
  // 舷窓の正面に、少し遠めに置く。
  //
  // 近すぎると敷居に隠れる。目の高さ 5.9m から敷居(半径13m・高さ4.8m)
  // 越しに見下ろせる俯角はたかだか十数度で、部屋の中心から海底が
  // 見えはじめるのは半径 28m あたり。19.5m に置いたら区画の下半分が
  // 切れていた。窓に寄れば見えるが、真ん中に立っても目に入るほうがいい
  const PLOT_A = winAngles.length ? winAngles[1] : 1.9;
  const PLOT_R = 26.0;
  const plot = {
    a: PLOT_A, r: PLOT_R,
    x: Math.cos(PLOT_A) * PLOT_R, z: Math.sin(PLOT_A) * PLOT_R,
    w: 5.2, d: 3.6, h: 3.0,
  };
  plot.y = FLOOR_Y + riseAt(PLOT_R);
  const GROW = [7.4, 1.5, 8.8];
  for (let i = -1; i <= 1; i++) {
    const px = plot.x + Math.cos(PLOT_A + Math.PI / 2) * i * (plot.w * 0.33);
    const pz = plot.z + Math.sin(PLOT_A + Math.PI / 2) * i * (plot.w * 0.33);
    lights.push({ p: [px, plot.y + plot.h, pz], d: [0, -1, 0], c: GROW, k: 0.85 });
  }
  // 観測棟の室内灯。
  //
  // 天井に発光する点を置くだけでは、部屋は真っ暗なままになる——
  // 発光面は「光って見える板」であって、光源ではない。中に入れる
  // 部屋にした以上、その部屋を照らす光を光源の一覧に足す必要がある。
  // 実際いちど真っ暗な箱になっていた
  const ROOM = [1.25, 1.30, 1.35];
  for (let i = 0; i < 2; i++) {
    const a = ANNEX.a + Math.PI * 0.5 + i * Math.PI;
    lights.push({
      p: [ANNEX.x + Math.cos(a) * 2.3, ANNEX.base + ANNEX.wall - 0.5,
          ANNEX.z + Math.sin(a) * 2.3],
      d: [0, -1, 0], c: ROOM, k: 1.0,
    });
  }
  const FLOOD = floodGLSL(lights);
  const neon = new Neon();

  const mat = (frag, extra = {}) => new THREE.ShaderMaterial({
    uniforms: baseUniforms(),
    vertexShader: LIT_VERT,
    fragmentShader: UW_FRAG_PRELUDE + EXT_FOG + FLOOD + frag,
    ...extra,
  });

  // ---- 海底 ----
  // 環は等間隔にしない。近くは細かく、遠くは粗く——
  // 等間隔にすると、近くが粗くて起伏が階段に見えるか、
  // 遠くまで細かくして頂点を無駄に使うかのどちらかになる
  const RINGS = 46, SEG = 84;
  const fl = new Buf();
  const noise = rng(20260820);
  // 起伏は決まった関数から。頂点ごとに乱数を引くと、
  // 作り直すたびに地形が変わる
  const rise = riseAt;
  const relief = (x, z) => (
    Math.sin(x * 0.055 + Math.cos(z * 0.041) * 2.1) * 0.62
    + Math.sin(z * 0.083 - 1.3) * 0.34
    + Math.sin((x + z) * 0.17) * 0.11
    + rise(Math.hypot(x, z))
  );
  const rows = [];
  for (let i = 0; i <= RINGS; i++) {
    const t = i / RINGS;
    const r = FLOOR_R0 * Math.pow(FLOOR_R1 / FLOOR_R0, t);
    const row = [];
    for (let k = 0; k < SEG; k++) {
      const a = (k / SEG) * Math.PI * 2;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      row.push(fl.v(x, FLOOR_Y + relief(x, z), z, [1, 1, 1]));
    }
    rows.push(row);
  }
  for (let i = 0; i < RINGS; i++) {
    for (let k = 0; k < SEG; k++) {
      const k2 = (k + 1) % SEG;
      fl.quad(rows[i][k], rows[i][k2], rows[i + 1][k2], rows[i + 1][k]);
    }
  }
  group.add(new THREE.Mesh(fl.geo(), mat(FLOOR_FRAG)));

  // ---- 遠景の水 ----
  //
  // 共通の遠景ドームは「水面の下から見上げた海」を描いていて、上半分が
  // 夜空のような紺色になる。海底がそこで途切れると、境目がそのまま
  // **水平線**として立ち上がり、地面と空のある陸の風景になる。
  // 施設の外から撮った絵でまさにそう見えていた。
  //
  // ここでは共通ドームの内側に、自分の水の色で塗った球を置いて隠す。
  // 色は extWater() そのものなので、霧に溶けきった海底とぴったり
  // 同じ色になり、境目が生まれない
  {
    const back = new THREE.Mesh(
      new THREE.SphereGeometry(200, 32, 20),
      new THREE.ShaderMaterial({
        uniforms: baseUniforms(),
        side: THREE.BackSide,
        depthWrite: false,
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: UW_FRAG_PRELUDE + EXT_FOG + /* glsl */ `
          varying vec3 vDir;
          void main() {
            // 水平方向は「霧に溶けた海底」と同じ色に合わせる。
            // 斜面の頂は y≈9.6 まで持ち上がっているので、そこで評価する
            vec3 c = mix(extWater(9.6), extWater(40.0),
                         smoothstep(0.0, 0.65, vDir.y));
            gl_FragColor = vec4(c, 1.0);
            ${UW_FRAG_OUTPUT}
          }
        `,
      }));
    back.renderOrder = -9;      // 共通ドーム(-10)より手前
    group.add(back);
  }

  // ---- 殻の底 ----
  //
  // 甲板から下には何も無かった。外から低い角度で見ると施設の下を
  // 素通しで見通せて、背景ドームが青いスカートのように写っていた
  // (画面を撃って初めて分かった——目では「そういう部品がある」と
  // 思い込んでいた)。与圧殻は球か円筒の組み合わせなので、
  // 下も丸く閉じているのが正しい。
  const S = new Buf();
  {
    const SIDES = 64;
    const skirtY = deckY - 1.15;      // 円筒で下りるところ
    const bowlY = deckY - 2.05;       // 底の中心
    const top = [], mid = [];
    for (let k = 0; k < SIDES; k++) {
      const a = (k / SIDES) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      top.push(S.v(c * hullR, deckY, s * hullR, STEEL2));
      mid.push(S.v(c * hullR, skirtY, s * hullR, STEEL2));
    }
    for (let k = 0; k < SIDES; k++) {
      const k2 = (k + 1) % SIDES;
      S.quad(top[k], top[k2], mid[k2], mid[k]);
    }
    // 浅い椀。中心へ向かって丸く閉じる
    const BOWL = 4;
    let prev = mid;
    for (let i = 1; i <= BOWL; i++) {
      const t = i / BOWL;
      const r = hullR * Math.cos(t * Math.PI * 0.5);
      const y = skirtY - (skirtY - bowlY) * Math.sin(t * Math.PI * 0.5);
      const row = [];
      for (let k = 0; k < SIDES; k++) {
        const a = (k / SIDES) * Math.PI * 2;
        row.push(S.v(Math.cos(a) * r, y, Math.sin(a) * r, STEEL2));
      }
      for (let k = 0; k < SIDES; k++) {
        const k2 = (k + 1) % SIDES;
        S.quad(prev[k], prev[k2], row[k2], row[k]);
      }
      prev = row;
    }
  }

  // 脚。殻を海底から浮かせて支えている。これがあると、
  // 施設が「沈んでいる」のではなく「据えられている」ように見える
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.26;
    const c = Math.cos(a), s = Math.sin(a);
    const top = [c * (hullR - 0.35), deckY - 1.35, s * (hullR - 0.35)];
    const foot = [c * (hullR + 3.4), FLOOR_Y + 0.15, s * (hullR + 3.4)];
    strut(S, top, foot, 0.26, STEEL2);
    // 接地部。板を1枚置くと、投光器を正面から受けて白い紙のように光る。
    // 泥に沈みかけた短い裾にして、上を向いた平らな面を作らない
    strut(S, [foot[0], FLOOR_Y + 0.55, foot[2]],
          [foot[0], FLOOR_Y - 0.25, foot[2]], 0.78, STEEL2);
  }
  // 岩。海底に何も無いと、距離感が出ない。
  //
  // 34個をまんべんなく撒いていたが、「岩も何も無い」と言われた。
  // 数の問題だけではなく、**均等にばらまくと風景にならない**——
  // 実際の海底では岩は転がって寄り集まるので、群れで置く。
  // 大きさの幅も広げる(近くの小石から、施設ほどの露頭まで)
  const rocks = [];
  for (let cl = 0; cl < 16; cl++) {
    const ca = noise() * Math.PI * 2;
    const cr = 16 + Math.pow(noise(), 0.75) * 54;
    const n = 2 + Math.floor(noise() * 6);
    // 群れの中でいちばん大きい石。遠い群れほど大きくてよい
    const big = 0.6 + Math.pow(noise(), 2.0) * (1.4 + cr * 0.075);
    for (let i = 0; i < n; i++) {
      const sa = ca + (noise() - 0.5) * 0.30;
      const sr = cr + (noise() - 0.5) * 7.0;
      const x = Math.cos(sa) * sr, z = Math.sin(sa) * sr;
      const rad = big * (0.30 + noise() * 0.70);
      rocks.push([x, z, rad]);
      blob(S, x, FLOOR_Y + relief(x, z) + rad * 0.30, z, rad, noise, ROCK);
    }
  }
  // 露頭。遠くに数個、大きな塊を置くと窪地の底らしくなる
  for (let i = 0; i < 5; i++) {
    const a = noise() * Math.PI * 2;
    const r = 44 + noise() * 34;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const rad = 4.0 + noise() * 4.5;
    blob(S, x, FLOOR_Y + relief(x, z) + rad * 0.18, z, rad, noise, ROCK);
  }

  // 隣の区画。円筒＋短い連絡通路。
  // 建物が1つだけだと施設ではなく「箱」で、大きさも分からない
  // 34m だと窓の半分を塞ぐ「壁」になり、遠くの建物に見えなかった。
  // 48m まで下げると、霧の向こうの影として読める
  const ma = ANNEX.a;
  const MD = ANNEX.dist;
  const mBase = ANNEX.base;
  const mx = ANNEX.x, mz = ANNEX.z;
  buildAnnex(S, neon, world, group, mat);

  // ---- 連絡通路 ----
  //
  // ここは一度ひどいものを置いていた。区画を 34m から 48m へ動かした
  // ときに見直さなかったので、**34m を無支持で渡る裸の管**が水中を
  // 斜めに突っ切っていた。何なのか分からない棒として画面を横切る。
  //
  // 直すべき点は3つあった。
  //   ・水中を通していた。実物の海底トンネルは水圧のかかる橋を架けず、
  //     海底に載せて短い脚で支える。地形に沿わせれば視界も切らない
  //   ・支えが無かった。長い横棒は、支えが見えて初めて構造物になる
  //   ・細すぎた。人が通る通路なら、直径は2m以上ないと嘘になる
  const link = [];
  {
    const N = 18;
    const R0 = hullR + 0.2, R1 = MD - 5.4;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const r = R0 + (R1 - R0) * t;
      // ふだんは海底に沿う。区画の手前でだけ、取り付き高さへ登る
      const onFloor = FLOOR_Y + rise(r) + 1.75;
      const atDoor = mBase + 1.2;
      const k = THREE.MathUtils.smoothstep(t, 0.70, 1.0);
      link.push([Math.cos(ma) * r, onFloor * (1 - k) + atDoor * k, Math.sin(ma) * r, r]);
    }
    const SIDES = 8;
    let prev = null;
    link.forEach(([px, py, pz, r], i) => {
      // 継ぎ目のリング。1つおきに少し太らせると、環の並んだ管に見える
      const rad = (i % 2 === 0) ? 1.30 : 1.14;
      const ring = [];
      for (let k = 0; k < SIDES; k++) {
        const th = (k / SIDES) * Math.PI * 2;
        // 断面は「進行方向に垂直な面」。ここは径方向へ延びる管なので、
        // 円周方向と上下で張ればよい
        const ox = -Math.sin(ma) * Math.cos(th) * rad;
        const oz = Math.cos(ma) * Math.cos(th) * rad;
        ring.push(S.v(px + ox, py + Math.sin(th) * rad, pz + oz, STEEL));
      }
      if (prev) {
        for (let k = 0; k < SIDES; k++) {
          const k2 = (k + 1) % SIDES;
          S.quad(prev[k], prev[k2], ring[k2], ring[k]);
        }
      }
      prev = ring;
      // 支柱。3つおきに海底まで下ろす
      if (i % 3 === 1 && i < N - 1) {
        const gy = FLOOR_Y + rise(r);
        strut(S, [px, py - rad * 0.7, pz], [px, gy - 0.15, pz], 0.16, STEEL2);
        strut(S, [px, gy + 0.35, pz], [px, gy - 0.1, pz], 0.55, STEEL2);
      }
      // 天面の航路灯。通路そのものが道しるべになる
      if (i % 2 === 0) {
        neon.add([px, py + rad + 0.12, pz], [3.4, 1.5, 0.28], 0.065, 0);
      }
    });
  }

  // 観測やぐら。舷窓1枚につき1本、目の高さに立つ目印を置く。
  //
  // 施設が1棟きりだと、窓の正面はいつまでも「暗い水」のままになる。
  // 遠くに人工物が見えることが、そこが海の底の「現場」であることの
  // いちばん短い説明になる
  const masts = [];
  winAngles.forEach((wa, i) => {
    const a = wa + (i % 2 ? 0.16 : -0.16);
    const r = 23 + (i % 3) * 5.5;
    const bx = Math.cos(a) * r, bz = Math.sin(a) * r;
    const by = FLOOR_Y + rise(r);
    const h = 6.5 + (i % 2) * 1.6;
    strut(S, [bx, by, bz], [bx, by + h, bz], 0.20, STEEL2);
    // 三脚。1本足だと棒が浮いているように見える
    for (let k = 0; k < 3; k++) {
      const t = (k / 3) * Math.PI * 2 + 0.4;
      strut(S, [bx, by + h * 0.42, bz],
            [bx + Math.cos(t) * 1.9, by, bz + Math.sin(t) * 1.9], 0.10, STEEL2);
    }
    // 横に張り出した計測機器
    strut(S, [bx, by + h * 0.86, bz],
          [bx + Math.cos(a + 1.4) * 1.5, by + h * 0.86, bz + Math.sin(a + 1.4) * 1.5],
          0.13, STEEL2);
    masts.push([bx, by + h + 0.28, bz]);
  });

  // ---- 海藻の栽培区画 ----
  // 四隅の柱と、上に渡した育成灯の桁。中に海藻が生える
  {
    const ux = Math.cos(plot.a + Math.PI / 2), uz = Math.sin(plot.a + Math.PI / 2);
    const vx = Math.cos(plot.a), vz = Math.sin(plot.a);
    const corner = (su, sv) => [plot.x + ux * su * plot.w / 2 + vx * sv * plot.d / 2,
                                plot.y,
                                plot.z + uz * su * plot.w / 2 + vz * sv * plot.d / 2];
    const posts = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    for (const c of posts) {
      strut(S, c, [c[0], c[1] + plot.h, c[2]], 0.09, STEEL2);
    }
    // 上の桁。育成灯はここに並ぶ
    for (let j = 0; j < 4; j++) {
      const a0 = posts[j], a1 = posts[(j + 1) % 4];
      strut(S, [a0[0], a0[1] + plot.h, a0[2]], [a1[0], a1[1] + plot.h, a1[2]], 0.07, STEEL2);
    }
    // 育成灯の帯。3本の桃色の管
    for (let i = -1; i <= 1; i++) {
      const cx = plot.x + ux * i * (plot.w * 0.33), cz = plot.z + uz * i * (plot.w * 0.33);
      for (let t = -2; t <= 2; t++) {
        neon.add([cx + vx * t * (plot.d * 0.21), plot.y + plot.h - 0.10,
                  cz + vz * t * (plot.d * 0.21)], [3.4, 0.55, 4.2], 0.115, 0);
      }
    }
    // 区画の識別灯。四隅に琥珀色
    for (const c of posts) neon.add([c[0], c[1] + plot.h + 0.20, c[2]], [4.2, 2.0, 0.35], 0.09, 0);
  }

  // ---- 海底の生き物(動かないもの) ----
  //
  // 深海底は不毛ではない。柄のついたウミエラが泥から立ち、
  // 岩には管を伸ばした環形動物が付く。動かないので静的な形でよく、
  // 「何も無い」を埋めるのにいちばん効く
  const pens = [];
  for (let i = 0; i < 46; i++) {
    const a = noise() * Math.PI * 2;
    const r = 15 + Math.pow(noise(), 0.6) * 40;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const y = FLOOR_Y + relief(x, z);
    const h = 0.7 + noise() * 1.5;
    // 柄。潮に少し傾いている
    const lean = 0.18 + noise() * 0.22, la = noise() * Math.PI * 2;
    const tip = [x + Math.cos(la) * lean * h, y + h, z + Math.sin(la) * lean * h];
    strut(S, [x, y - 0.1, z], tip, 0.035 + noise() * 0.02, [0.10, 0.09, 0.11]);
    // 羽枝。左右に短い枝を出すと一気にウミエラらしくなる
    const bn = 5;
    for (let k = 1; k <= bn; k++) {
      const t = k / (bn + 1);
      const bx = x + (tip[0] - x) * t, by = y + h * t, bz = z + (tip[2] - z) * t;
      const bl = 0.16 + 0.20 * Math.sin(t * Math.PI);
      for (const sgn of [-1, 1]) {
        strut(S, [bx, by, bz],
              [bx + Math.cos(la + Math.PI / 2) * bl * sgn, by + bl * 0.5,
               bz + Math.sin(la + Math.PI / 2) * bl * sgn], 0.022, [0.13, 0.10, 0.12]);
      }
    }
    // 5本に1本だけ、先が生物発光する。全部光ると電飾になる
    if (i % 5 === 0) pens.push(tip);
  }
  // 明滅の位相も決まった乱数から。Math.random() を使うと、
  // 作り直すたびに光りかたが変わってしまう
  for (const t of pens) {
    neon.add(t, [0.55, 1.55, 1.30], 0.055, 0.5 + noise() * 0.35, noise() * 6.28);
  }

  group.add(new THREE.Mesh(S.geo(), mat(HULL_FRAG, { side: THREE.DoubleSide })));

  // ---- 海藻 ----
  // 育成灯の下の区画に密生させ、外にもまばらに逃がす
  // (栽培したものが種を飛ばして周りに広がった、という体)
  {
    const blades = [];
    const ux = Math.cos(plot.a + Math.PI / 2), uz = Math.sin(plot.a + Math.PI / 2);
    const vx = Math.cos(plot.a), vz = Math.sin(plot.a);
    for (let i = 0; i < 150; i++) {
      const su = (noise() * 2 - 1) * plot.w * 0.46, sv = (noise() * 2 - 1) * plot.d * 0.46;
      blades.push([plot.x + ux * su + vx * sv, plot.y - 0.05, plot.z + uz * su + vz * sv,
                   0.9 + noise() * 1.5]);
    }
    // 区画の外にも逃がす(栽培したものが広がった、という体)。
    //
    // ただし撒く先は投光器の照らす範囲に限る。窓ごとに1株は見えて
    // ほしいので、舷窓の正面——つまり投光器の錐が海底に当たるあたり
    // ——に群れを置く。暗がりに植えても、あるのに見えない
    for (const wa of winAngles) {
      for (let cl = 0; cl < 3; cl++) {
        const ca = wa + (noise() * 2 - 1) * 0.30;
        const cr = 16 + noise() * 6;
        for (let i = 0; i < 16; i++) {
          const a = ca + (noise() * 2 - 1) * 0.075;
          const r = cr + (noise() * 2 - 1) * 2.2;
          const x = Math.cos(a) * r, z = Math.sin(a) * r;
          blades.push([x, FLOOR_Y + relief(x, z) - 0.05, z, 0.85 + noise() * 1.5]);
        }
      }
    }
    const N = blades.length, SEGY = 6;
    const vpb = (SEGY + 1) * 2;
    const pos = new Float32Array(N * vpb * 3);
    const col = new Float32Array(N * vpb * 3);
    const rootA = new Float32Array(N * vpb * 3);
    const parA = new Float32Array(N * vpb * 3);
    const idx = [];
    blades.forEach(([bx, by, bz, h], bi) => {
      const yaw = noise() * Math.PI * 2, phase = noise() * 6.28;
      const wide = 0.055 + noise() * 0.05;
      const tint = 0.75 + noise() * 0.5;
      for (let j = 0; j <= SEGY; j++) {
        const t = j / SEGY;
        // 葉は根もとが細く、中ほどが広く、先が尖る
        const w = wide * Math.sin(Math.min(t * 1.15, 1) * Math.PI) * 1.6 + wide * 0.25;
        for (let s = 0; s < 2; s++) {
          const k = (bi * vpb + j * 2 + s);
          pos[k * 3] = (s ? w : -w); pos[k * 3 + 1] = t * h; pos[k * 3 + 2] = 0;
          col[k * 3] = KELP[0] * tint; col[k * 3 + 1] = KELP[1] * tint;
          col[k * 3 + 2] = KELP[2] * tint;
          rootA[k * 3] = bx; rootA[k * 3 + 1] = by; rootA[k * 3 + 2] = bz;
          parA[k * 3] = h; parA[k * 3 + 1] = yaw; parA[k * 3 + 2] = phase;
        }
      }
      for (let j = 0; j < SEGY; j++) {
        const p0 = bi * vpb + j * 2;
        idx.push(p0, p0 + 1, p0 + 3, p0, p0 + 3, p0 + 2);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aRoot', new THREE.BufferAttribute(rootA, 3));
    g.setAttribute('aParam', new THREE.BufferAttribute(parA, 3));
    g.setIndex(idx);
    // 葉は薄いので裏も見える。法線はシェーダで作るので computeVertexNormals は不要
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(N * vpb * 3), 3));
    group.add(new THREE.Mesh(g, mat(LIFE_FRAG,
      { vertexShader: KELP_VERT, side: THREE.DoubleSide })));
  }

  // ---- 魚 ----
  //
  // 投光器の光の中を横切るものが要る。動くものが1つも無いと、
  // どれだけ物を置いても「模型」から出られない。
  //
  // ここで自前の魚を作りかけたが、それは間違いだった。大水槽の
  // マイワシが既にある——紡錘形の体、銀鱗、体側の黒斑列、尾の振り、
  // ボイドの群泳まで揃っている。違うのは光と霧だけなので、
  // そこだけ差し替えて同じモデルを持ってくる(FISH_ENV は下で作る)。
  //
  // 深海の魚は群れないが、ここは投光器に照らされた餌場なので、
  // 集まってくる理由のほうはある。
  const FISH_ENV = EXT_FOG + FLOOD + /* glsl */ `
    vec3 fishLight(vec3 a, vec3 n, vec3 wp, vec3 V, float sp, float si) {
      // 受ける光を絞る。
      //
      // マイワシの体側は模様シェーダのなかで反射率 0.8 前後の「銀」に
      // なっている。水槽の柔らかい光ならそれでいいが、投光器の錐は
      // 桁違いに強いので、そのまま掛けると真っ白に飛ぶ——実際、
      // 窓の外で光る紙片のようになっていた。海底(反射率 0.1)と
      // 釣り合う明るさまで落とす
      vec3 col = a * (vec3(0.030, 0.046, 0.062) + floodLight(wp, n) * 0.22);
      // 銀鱗のぎらつき。錐の中を横切った個体だけが一瞬強く光る
      col += floodLight(wp, normalize(n + V * 0.6)) * si * 0.10;
      return col;
    }
    // 太陽が届かない深さなので、水面の集光は無い
    vec3 fishCaustics(vec3 wp, vec3 n) { return vec3(0.0); }
    vec3 fishFog(vec3 c, vec3 wp) { return extFog(c, wp); }
    vec3 fishRim() { return vec3(0.055, 0.100, 0.130); }
  `;
  const schools = [];
  {
    const geo = FISH_SHAPES.sardine();
    geo.scale(0.5, 0.5, 0.5);
    const N = 20;
    makeSchoolInstanceAttr(geo, N, [0.8, 1.15]);
    const fishMat = createFishMaterial({
      pattern: 0, len: 0.5,
      swim: { freq: 11, amp: 0.09, waveNum: 1.1, headAmp: 0.12, flapFreq: 6 },
      env: FISH_ENV,
    });
    // 大きな群れ1つより、小さな群れを舷窓ごとに散らすほうがいい。
    // どの窓からも1群は見えるし、群れどうしが別々に動くので
    // 「そこに海がある」感じが強くなる。
    //
    // 1か所に3群だけ置いたときは、窓によっては何も泳いでおらず、
    // 見える窓では固まって「白い塊」になっていた
    const spots = winAngles.length ? winAngles : [0, 2.1, 4.2];
    spots.forEach((a, k) => {
      const r = 19 + (k % 3) * 2.0;
      const mesh = new THREE.InstancedMesh(geo, fishMat, N);
      mesh.frustumCulled = false;
      group.add(mesh);
      schools.push(new School({
        mesh, count: N, seed: 11 + k * 7,
        center: new THREE.Vector3(Math.cos(a) * r, FLOOR_Y + 6.0, Math.sin(a) * r),
        // 広めに散らす。狭いと1個の塊になって、魚の群れではなく
        // 光る物体が1つ浮いているように見える
        homeRadius: 8.5,
        params: {
          maxSpeed: 3.2, minSpeed: 1.1, perception: 3.0, sepDist: 1.5,
          wSep: 2.0, wCoh: 0.45,
          bodyRadius: 0.18, avoidRange: 1.0,
          // 施設の甲板の高さより下は、共通の地形クランプが持ち上げる。
          // 争わせても意味がないので、初めからその上を泳がせる
          yMin: deckY + 1.0, yMax: domeTop + 1.5,
        },
      }));
    });
  }
  // 群れが殻へ寄りすぎたら押し戻す半径。
  // ボイドには施設の形が見えていないので、最後に効かせる安全弁
  const FISH_KEEP = hullR + 1.3;

  // ---- 投光器の器具と発光面 ----
  const F = new Buf();
  const glow = new Buf();
  for (const f of fixtures) {
    const c = Math.cos(f.a), s = Math.sin(f.a);
    const px = -s, pz = c;                    // 壁に沿った横方向
    const [ox, oy, oz] = f.p;
    const put = (u, w, h, buf, col) =>
      buf.v(ox + px * u + c * w, oy + h, oz + pz * u + s * w, col);
    const t0 = [put(-0.30, -0.16, 0.20, F, STEEL2), put(0.30, -0.16, 0.20, F, STEEL2),
                put(0.30, 0.16, 0.20, F, STEEL2), put(-0.30, 0.16, 0.20, F, STEEL2)];
    const b0 = [put(-0.30, -0.16, -0.20, F, STEEL2), put(0.30, -0.16, -0.20, F, STEEL2),
                put(0.30, 0.16, -0.20, F, STEEL2), put(-0.30, 0.16, -0.20, F, STEEL2)];
    F.quad(t0[3], t0[2], t0[1], t0[0]);
    for (let j = 0; j < 4; j++) {
      const j2 = (j + 1) % 4;
      F.quad(t0[j], t0[j2], b0[j2], b0[j]);
    }
    // 発光面は照射方向を向ける。器具の中心から少しだけ前に出す
    const gc = (u, w) => {
      const bx = ox + px * u + c * w, bz = oz + pz * u + s * w;
      return glow.v(bx + f.d.x * 0.22, oy - 0.20 + f.d.y * 0.22, bz + f.d.z * 0.22, [1, 1, 1]);
    };
    const g0 = gc(-0.24, -0.12), g1 = gc(0.24, -0.12), g2 = gc(0.24, 0.12), g3 = gc(-0.24, 0.12);
    glow.quad(g0, g1, g2, g3);
  }
  group.add(new THREE.Mesh(F.geo(), mat(HULL_FRAG, { side: THREE.DoubleSide })));
  group.add(new THREE.Mesh(glow.geo(), new THREE.MeshBasicMaterial({
    color: 0xcfe6ff, toneMapped: false, side: THREE.DoubleSide })));

  // ---- 光の筋 ----
  const beams = new THREE.BufferGeometry();
  {
    // 筋の長さは海底に届くところで止める。突き抜けさせると、
    // 加算合成なので泥の中にも光の錐が描かれる
    const SEGB = 16, LEN = 11.0, R0 = 0.34, R1 = 3.2;
    const pos = [], nrm = [], tt = [], idx = [];
    const up = new THREE.Vector3(0, 1, 0);
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    for (const f of fixtures) {
      e1.copy(up).cross(f.d).normalize();
      e2.copy(f.d).cross(e1).normalize();
      const base = pos.length / 3;
      const slope = (R1 - R0) / LEN;
      const nl = 1 / Math.hypot(1, slope);
      for (let j = 0; j <= SEGB; j++) {
        const t = (j / SEGB) * Math.PI * 2;
        const ct = Math.cos(t), st = Math.sin(t);
        const dx = e1.x * ct + e2.x * st, dy = e1.y * ct + e2.y * st, dz = e1.z * ct + e2.z * st;
        for (const [r, l, u] of [[R0, 0.25, 0], [R1, LEN, 1]]) {
          pos.push(f.p[0] + f.d.x * l + dx * r,
                   f.p[1] + f.d.y * l + dy * r,
                   f.p[2] + f.d.z * l + dz * r);
          nrm.push(dx * nl + f.d.x * slope * nl,
                   dy * nl + f.d.y * slope * nl,
                   dz * nl + f.d.z * slope * nl);
          tt.push(u);
        }
      }
      for (let j = 0; j < SEGB; j++) {
        const q = base + j * 2;
        idx.push(q, q + 1, q + 3, q, q + 3, q + 2);
      }
    }
    beams.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    beams.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
    beams.setAttribute('aT', new THREE.BufferAttribute(new Float32Array(tt), 1));
    beams.setIndex(idx);
  }
  group.add(new THREE.Mesh(beams, new THREE.ShaderMaterial({
    uniforms: baseUniforms(),
    vertexShader: BEAM_VERT,
    fragmentShader: UW_FRAG_PRELUDE + BEAM_FRAG,
    transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  })));

  // ---- マリンスノー ----
  // 外の粒は室内より多く、ゆっくり落ちる。投光器の筋の中に入った
  // 粒だけが光る——だから筋が「粒で見えている」ことになる
  //
  // 2群に分ける。施設のまわりを取り巻くぶんと、天蓋の上を降りるぶん。
  // 天井がガラスになった以上、真上にも粒がいなければならない——
  // 見上げたときに何も落ちてこない水は、水に見えない
  const snow = (count, seedNum, floorY, range, place) => {
    const pos = new Float32Array(count * 3), seed = new Float32Array(count * 2);
    const rnd = rng(seedNum);
    for (let i = 0; i < count; i++) {
      const [x, y, z] = place(rnd);
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      // いちばん近い投光器の軸までの距離。粒は縦にしか動かないので
      // 一度きり測ればよい
      let near = Infinity;
      for (const f of fixtures) {
        const dx = x - f.p[0], dz = z - f.p[2];
        // 軸に落とした距離ではなく、器具からの水平距離で十分。
        // 照射が下向きなので、真下ほど近い
        near = Math.min(near, Math.hypot(dx, dz) - 2.0);
      }
      seed[i * 2] = 0.035 + rnd() * 0.055;
      seed[i * 2 + 1] = 0.10 + 0.90 * Math.max(0, 1 - Math.max(near, 0) / 7.0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 2));
    group.add(new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: { ...baseUniforms(), uRange: { value: range }, uFloor: { value: floorY } },
      vertexShader: /* glsl */ `
        attribute vec2 aSeed;
        uniform float uTime; uniform float uRange; uniform float uFloor;
        varying float vB; varying float vD;
        void main() {
          vec3 p = position;
          p.y = uFloor + mod(uTime * aSeed.x + (p.y - uFloor), uRange);
          p.x += sin(uTime * 0.13 + p.z * 0.9) * 0.22;
          p.z += cos(uTime * 0.11 + p.x * 1.1) * 0.22;
          vB = aSeed.y;
          vec4 mv = viewMatrix * modelMatrix * vec4(p, 1.0);
          vD = -mv.z;
          gl_PointSize = 2.4 * (22.0 / max(-mv.z, 1.0));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vB; varying float vD;
        void main() {
          vec2 q = gl_PointCoord * 2.0 - 1.0;
          float d = 1.0 - dot(q, q);
          if (d <= 0.0) discard;
          // 遠い粒は霧に沈む。ここを一定にすると、
          // 奥行き何十mの粒が手前と同じ濃さで光って、雪嵐になる
          float a = d * d * vB * 0.60 * exp(-vD * 0.030);
          gl_FragColor = vec4(vec3(0.70, 0.80, 0.90) * a, a);
        }
      `,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    })));
  };
  // 施設のまわり。近くに厚く——遠くにばらまいても霧に埋もれて効かない
  snow(3200, 776611, FLOOR_Y, 22.0, (rnd) => {
    const a = rnd() * Math.PI * 2;
    const r = hullR + 0.4 + Math.pow(rnd(), 1.5) * 26;
    return [Math.cos(a) * r, FLOOR_Y + rnd() * 22, Math.sin(a) * r];
  });
  // 天蓋の上。降りきったら天蓋のすぐ上へ戻すので、殻の中には入らない
  snow(1100, 314159, domeTop + 0.35, 20.0, (rnd) => {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * (hullR + 12);
    return [Math.cos(a) * r, domeTop + 0.35 + rnd() * 20, Math.sin(a) * r];
  });

  // ---- 隣の区画の標識灯 ----
  // 点滅する赤。人工物であることを一点だけで言う
  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.30, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xff4426, toneMapped: false }));
  // 円筒(高さ7.0)＋笠(5.2*0.42)の上。中に埋めると外から見えない
  beacon.position.set(mx, mBase + 7.0 + 5.2 * 0.42 + 0.45, mz);
  group.add(beacon);

  // やぐらの頭の灯。色を変えて、区画の標識と区別する
  masts.forEach((p, i) => neon.add(p, [0.55, 3.2, 1.5], 0.16, 1.05, i * 1.9));

  // ---- 殻の標識灯 ----
  //
  // 船や航空機と同じで、有人の構造物には縁を示す灯りが必ず付く。
  // 暗い水の中で「どこまでが建物か」を教えるのが役目で、
  // 等間隔に並んだ色つきの点というのは自然界には無い——
  // だから形よりも強く「人の設備」を語る
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    // 甲板の高さに琥珀、天蓋の付け根に青。上下2段で殻の丈が分かる
    neon.add([c * (hullR + 0.14), deckY + 0.35, s * (hullR + 0.14)],
             [3.6, 1.55, 0.22], 0.075, 0);
    if (k % 2 === 0) {
      neon.add([c * (hullR + 0.14), domeTop - 3.55, s * (hullR + 0.14)],
               [0.40, 1.9, 3.4], 0.070, 0);
    }
  }
  // 出入口の上に、ゆっくり回る赤。1点だけ動きの違うものがあると、
  // 全体が「動いている設備」に見える
  const dockA = winAngles.length ? winAngles[2] + 0.42 : 2.6;
  neon.add([Math.cos(dockA) * (hullR + 0.30), deckY + 3.4, Math.sin(dockA) * (hullR + 0.30)],
           [4.6, 0.55, 0.30], 0.16, 0.9, 0);

  // ---- 海底の誘導灯 ----
  // 施設から隣の区画へ、点々と続く。人がここを行き来している証拠。
  //
  // 杭は S ではなく別の Buf に積む。S はもう geo() を取って
  // メッシュにしてしまっているので、あとから足しても画面に出ない
  {
    const G = new Buf();
    const n = 16;
    // 連絡通路と同じ線の上に並べると、杭が通路の中に埋まる。
    // 横へ 3.4m ずらして、通路に沿う縁石灯にする
    const sx = -Math.sin(ma) * 3.4, sz = Math.cos(ma) * 3.4;
    for (let i = 1; i <= n; i++) {
      const t = i / (n + 1);
      const r = hullR + 3.0 + (MD - hullR - 5.0) * t;
      const px = Math.cos(ma) * r + sx, pz = Math.sin(ma) * r + sz;
      const py = FLOOR_Y + riseAt(Math.hypot(px, pz));
      // 短い杭の上に載せる。泥に直に置くと埋まって見えない
      strut(G, [px, py - 0.1, pz], [px, py + 0.42, pz], 0.045, STEEL2);
      // 順に流れる位相。滑走路の誘導灯と同じで、進む向きが分かる
      neon.add([px, py + 0.50, pz], [0.35, 1.5, 3.6], 0.070, 1.9, -i * 0.55);
    }
    group.add(new THREE.Mesh(G.geo(), mat(HULL_FRAG, { side: THREE.DoubleSide })));
  }
  neon.build(group);

  return {
    update(dt, t) {
      // 2.6秒周期でひと呼吸。ずっと点いていると人工物に見えない
      const ph = (t % 2.6) / 2.6;
      const on = Math.exp(-Math.pow((ph - 0.12) * 9.0, 2));
      beacon.material.color.setRGB(1.0 * (0.10 + on), 0.16 * (0.10 + on), 0.10 * (0.10 + on));
      beacon.scale.setScalar(0.6 + on * 0.7);

      for (const sc of schools) {
        sc.update(dt);
        // ボイドには施設の形が見えていない。回遊の目標を殻の外に
        // 置いてあるので滅多に入ってこないが、稀に壁を抜ける。
        // 抜けた個体だけ半径方向へ押し戻し、内向きの速度も殺す
        for (let i = 0; i < sc.count; i++) {
          const q = sc.pos[i];
          const r = Math.hypot(q.x, q.z);
          if (r >= FISH_KEEP || r < 1e-3) continue;
          const nx = q.x / r, nz = q.z / r;
          q.x = nx * FISH_KEEP; q.z = nz * FISH_KEEP;
          const v = sc.vel[i];
          const vn = v.x * nx + v.z * nz;
          if (vn < 0) { v.x -= vn * nx * 2; v.z -= vn * nz * 2; }
        }
      }
    },
  };
}

// --- 形の道具 ---

/** 2点を結ぶ角柱 */
function strut(M, a, b, rad, col) {
  const ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2];
  const L = Math.hypot(ax, ay, az) || 1;
  const dx = ax / L, dy = ay / L, dz = az / L;
  // 軸に直交する2本。軸が真上に近いときは基準を変える
  let ux = 0, uy = 1, uz = 0;
  if (Math.abs(dy) > 0.9) { ux = 1; uy = 0; }
  let e1x = uy * dz - uz * dy, e1y = uz * dx - ux * dz, e1z = ux * dy - uy * dx;
  const e1L = Math.hypot(e1x, e1y, e1z) || 1;
  e1x /= e1L; e1y /= e1L; e1z /= e1L;
  const e2x = dy * e1z - dz * e1y, e2y = dz * e1x - dx * e1z, e2z = dx * e1y - dy * e1x;
  const SIDES = 6;
  const ring = (p) => {
    const o = [];
    for (let j = 0; j < SIDES; j++) {
      const t = (j / SIDES) * Math.PI * 2;
      const c = Math.cos(t) * rad, s = Math.sin(t) * rad;
      o.push(M.v(p[0] + e1x * c + e2x * s, p[1] + e1y * c + e2y * s,
                 p[2] + e1z * c + e2z * s, col));
    }
    return o;
  };
  const r0 = ring(a), r1 = ring(b);
  for (let j = 0; j < SIDES; j++) {
    const j2 = (j + 1) % SIDES;
    M.quad(r0[j], r0[j2], r1[j2], r1[j]);
  }
}

/**
 * 観測棟。中に入れる建物。
 *
 * ただの円筒だったものを、床のある部屋にする。作りは3段:
 *   下  鋼の壁。プロテウス側に出入口が開いている
 *   中  ぐるり一周のガラス帯。ここが観測棟の存在理由——
 *       入ってプロテウスを振り返ると、灯りのついた本体が見える
 *   上  浅い円錐の屋根。梁が中心へ集まる
 *
 * 出入口は「開けた穴」ではなく、板厚の見える開口にする。舷窓のときと
 * 同じで、これが無いと壁が厚さ0の紙に見える。
 */
function buildAnnex(S, neon, world, group, mat) {
  const { x: cx, z: cz, a: ca, radius: R, wall: H, sill, door, doorArc } = ANNEX;
  const base = ANNEX.base, floorY = ANNEX.floor;
  const N = 40;
  const th = 0.30;                       // 壁の厚み
  // 出入口はプロテウスのほう(=原点向き)に開ける
  const dA = ca + Math.PI + ANNEX.doorOff;
  const inDoor = (a) => {
    const d = Math.abs(((a - dA + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    return d < doorArc;
  };
  const ang = (k) => (k / N) * Math.PI * 2;
  const P = (a, r, y) => S.v(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r, STEEL);

  // ---- 台座 ----
  for (let k = 0; k < N; k++) {
    const a0 = ang(k), a1 = ang(k + 1);
    S.quad(P(a0, R + 0.5, base - 0.9), P(a1, R + 0.5, base - 0.9),
           P(a1, R + 0.35, base), P(a0, R + 0.35, base));
    S.quad(P(a0, R + 0.35, base), P(a1, R + 0.35, base),
           P(a1, R, base), P(a0, R, base));
  }
  // ---- 床 ----
  const hub0 = S.v(cx, floorY, cz, DECKC);
  const rim = [];
  for (let k = 0; k < N; k++) rim.push(S.v(cx + Math.cos(ang(k)) * (R - th), floorY,
                                           cz + Math.sin(ang(k)) * (R - th), DECKC));
  for (let k = 0; k < N; k++) S.tri(hub0, rim[(k + 1) % N], rim[k]);

  // ---- 壁 ----
  //
  // 段は3つ。腰までの鋼、その上のガラス帯、そして戸口の欄間。
  // 戸口のところだけはガラスを通さず、床から鴨居まで開けて、
  // その上を鋼で塞ぐ
  const ySill = floorY + sill;
  const yDoor = floorY + door;
  const yGlass = base + H;
  const wallSeg = (a0, a1, y0, y1) => {
    S.quad(P(a0, R, y0), P(a1, R, y0), P(a1, R, y1), P(a0, R, y1));
    S.quad(P(a1, R - th, y0), P(a0, R - th, y0), P(a0, R - th, y1), P(a1, R - th, y1));
  };
  for (let k = 0; k < N; k++) {
    const a0 = ang(k), a1 = ang(k + 1);
    if (inDoor(ang(k + 0.5))) {
      wallSeg(a0, a1, yDoor, yGlass);        // 欄間(戸口の上は鋼で塞ぐ)
    } else {
      wallSeg(a0, a1, base, ySill);          // 腰壁
    }
  }
  // 戸口の見付。板厚を見せないと、壁が厚さ0の紙に見える
  for (const sgn of [-1, 1]) {
    const a = dA + doorArc * sgn;
    S.quad(P(a, R, floorY), P(a, R - th, floorY), P(a, R - th, yDoor), P(a, R, yDoor));
  }
  for (let k = 0; k < N; k++) {
    const a0 = ang(k), a1 = ang(k + 1);
    if (!inDoor(ang(k + 0.5))) continue;
    S.quad(P(a0, R, yDoor), P(a0, R - th, yDoor), P(a1, R - th, yDoor), P(a1, R, yDoor));
    S.quad(P(a1, R, floorY), P(a1, R - th, floorY), P(a0, R - th, floorY), P(a0, R, floorY));
  }
  // 戸口の縁の標識灯。暗い海で入口が分かるのは灯りだけ
  for (const sgn of [-1, 1]) {
    const a = dA + (doorArc + 0.06) * sgn;
    for (const y of [floorY + 0.35, yDoor - 0.2]) {
      neon.add([cx + Math.cos(a) * (R + 0.12), y, cz + Math.sin(a) * (R + 0.12)],
               [3.8, 1.7, 0.25], 0.075, 0);
    }
  }

  // ---- 方立と、上下の桁 ----
  for (const y of [ySill, yGlass]) {
    for (let k = 0; k < N; k++) {
      const a0 = ang(k), a1 = ang(k + 1);
      if (y === ySill && inDoor(ang(k + 0.5))) continue;
      S.quad(P(a0, R + 0.06, y - 0.13), P(a1, R + 0.06, y - 0.13),
             P(a1, R + 0.06, y + 0.13), P(a0, R + 0.06, y + 0.13));
      S.quad(P(a1, R - th, y - 0.13), P(a0, R - th, y - 0.13),
             P(a0, R - th, y + 0.13), P(a1, R - th, y + 0.13));
    }
  }
  for (let m = 0; m < 10; m++) {
    const a = (m / 10) * Math.PI * 2 + 0.31;
    if (inDoor(a)) continue;
    const w = 0.055;
    S.quad(P(a - w, R, ySill), P(a + w, R, ySill), P(a + w, R, yGlass), P(a - w, R, yGlass));
    S.quad(P(a + w, R - th, ySill), P(a - w, R - th, ySill),
           P(a - w, R - th, yGlass), P(a + w, R - th, yGlass));
  }

  // ---- 観測帯のガラス ----
  // 加算で映り込みだけを足す板。天蓋と同じ理屈で、半透明合成にすると
  // 外のマリンスノーや遠景と描画順を争う
  {
    const SEG = 48;
    const pos = [], nrm = [], idx = [];
    for (let j = 0; j <= 1; j++) {
      const y = j ? yGlass - 0.13 : ySill + 0.13;
      for (let k = 0; k <= SEG; k++) {
        const a = (k / SEG) * Math.PI * 2;
        pos.push(cx + Math.cos(a) * R, y, cz + Math.sin(a) * R);
        nrm.push(Math.cos(a), 0, Math.sin(a));
      }
    }
    for (let k = 0; k < SEG; k++) {
      // 戸口の上は鋼の欄間なので、ガラスを張らない
      if (inDoor(((k + 0.5) / SEG) * Math.PI * 2)) continue;
      const p0 = k, p1 = k + 1, p2 = k + SEG + 1, p3 = p2 + 1;
      idx.push(p0, p2, p3, p0, p3, p1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
    g.setIndex(idx);
    const gl = new THREE.Mesh(g, mat(ANNEX_GLASS_FRAG, {
      transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    gl.renderOrder = 4;
    group.add(gl);
  }

  // ---- 屋根 ----
  const apexY = yGlass + R * 0.42;
  const top = S.v(cx, apexY, cz, STEEL);
  for (let k = 0; k < N; k++) {
    const a0 = ang(k), a1 = ang(k + 1);
    S.tri(P(a0, R, yGlass), P(a1, R, yGlass), top);
  }
  // 梁。屋根が一枚の傘に見えないよう、放射状に通す
  for (let m = 0; m < 10; m++) {
    const a = (m / 10) * Math.PI * 2 + 0.31;
    strut(S, [cx + Math.cos(a) * (R - 0.1), yGlass + 0.05, cz + Math.sin(a) * (R - 0.1)],
          [cx, apexY - 0.05, cz], 0.075, STEEL2);
  }

  // ---- 中の設え ----
  // 何も無い円筒は部屋ではない。作業台と器械があって初めて
  // 「人が使っている観測室」になる
  for (let m = 0; m < 5; m++) {
    const a = (m / 5) * Math.PI * 2 + 0.6;
    if (inDoor(a)) continue;
    const bx = cx + Math.cos(a) * (R - 1.05), bz = cz + Math.sin(a) * (R - 1.05);
    const px = -Math.sin(a), pz = Math.cos(a);
    // 作業台
    const q = [];
    for (const [u, v] of [[-1.1, -0.42], [1.1, -0.42], [1.1, 0.42], [-1.1, 0.42]]) {
      q.push(S.v(bx + px * u + Math.cos(a) * v, floorY + 0.95,
                 bz + pz * u + Math.sin(a) * v, STEEL2));
    }
    S.quad(q[0], q[1], q[2], q[3]);
    for (const u of [-0.95, 0.95]) {
      strut(S, [bx + px * u, floorY, bz + pz * u],
            [bx + px * u, floorY + 0.95, bz + pz * u], 0.055, STEEL2);
    }
    // 台の上の計器。小さな画面が並んでいる
    neon.add([bx + px * 0.45 + Math.cos(a) * 0.1, floorY + 1.20, bz + pz * 0.45 + Math.sin(a) * 0.1],
             [0.35, 1.9, 1.5], 0.085, 0);
    neon.add([bx - px * 0.45 + Math.cos(a) * 0.1, floorY + 1.20, bz - pz * 0.45 + Math.sin(a) * 0.1],
             [1.9, 1.2, 0.30], 0.070, 0.7, m * 1.3);
  }
  // 天井の灯り
  for (let m = 0; m < 4; m++) {
    const a = (m / 4) * Math.PI * 2 + 0.8;
    neon.add([cx + Math.cos(a) * 2.4, yGlass - 0.35, cz + Math.sin(a) * 2.4],
             [3.0, 3.3, 3.6], 0.16, 0);
  }
  // 床の中心にも一点。入ったときに部屋の広さが分かる
  neon.add([cx, floorY + 0.06, cz], [1.6, 1.7, 1.9], 0.11, 0);

  // ---- 当たり判定 ----
  // 壁をすり抜けられては部屋にならない。出入口のところだけ空ける
  if (world) {
    // 箱は軸に沿った直方体なので、円い壁は細かく並べて近似する。
    // 大きな箱を疎に置くと、内側へ食い込んだぶんが部屋の中に張り出して、
    // 立っている人を壁の外へ押し出してしまう
    const _b = new THREE.Vector3();
    for (let k = 0; k < 26; k++) {
      const a = (k / 26) * Math.PI * 2;
      if (inDoor(a)) continue;
      world.addStatic(_b.set(cx + Math.cos(a) * (R + 0.55), base + H * 0.5,
                             cz + Math.sin(a) * (R + 0.55)),
                      0.82, H * 0.6, 0.82);
    }
    // 屋根の蓋。壁だけ塞いでも、上から降りて屋根を抜けられてしまう
    // (実際そうなっていて、出入口を使わずに天井から入れた)。
    //
    // 当たり判定は楕円体なので、平らな蓋は作れない。中心をうんと上に
    // 置いて、下側の面だけが屋根の高さに来るようにする——こうすると
    // 部屋の中の頭上は空いたまま、上からの侵入だけが止まる
    world.addStatic(_b.set(cx, base + H + 4.2, cz), 6.0, 4.4, 6.0);
  }
}

/** 縦の円筒(隣の区画) */
function cylinder(M, x, y, z, rad, h, col) {
  const SIDES = 14;
  const lo = [], hi = [];
  for (let j = 0; j < SIDES; j++) {
    const t = (j / SIDES) * Math.PI * 2;
    const c = Math.cos(t) * rad, s = Math.sin(t) * rad;
    lo.push(M.v(x + c, y, z + s, col));
    hi.push(M.v(x + c, y + h, z + s, col));
  }
  for (let j = 0; j < SIDES; j++) {
    const j2 = (j + 1) % SIDES;
    M.quad(lo[j], lo[j2], hi[j2], hi[j]);
  }
  // 上蓋。平らな円板ではなく、浅い笠にする
  const top = M.v(x, y + h + rad * 0.42, z, col);
  for (let j = 0; j < SIDES; j++) M.tri(hi[j], hi[(j + 1) % SIDES], top);
}

/** ごつごつした塊(岩) */
function blob(M, x, y, z, rad, rnd, col) {
  const LAT = 5, LON = 8;
  const grid = [];
  for (let i = 1; i < LAT; i++) {
    const th = (i / LAT) * Math.PI;
    const row = [];
    for (let j = 0; j < LON; j++) {
      const ph = (j / LON) * Math.PI * 2;
      const r = rad * (0.68 + rnd() * 0.55);
      row.push(M.v(x + Math.sin(th) * Math.cos(ph) * r,
                   y + Math.cos(th) * r * 0.72,
                   z + Math.sin(th) * Math.sin(ph) * r, col));
    }
    grid.push(row);
  }
  const top = M.v(x, y + rad * 0.72, z, col);
  const bot = M.v(x, y - rad * 0.72, z, col);
  for (let j = 0; j < LON; j++) {
    const j2 = (j + 1) % LON;
    M.tri(top, grid[0][j2], grid[0][j]);
    M.tri(bot, grid[LAT - 2][j], grid[LAT - 2][j2]);
  }
  for (let i = 0; i < LAT - 2; i++) {
    for (let j = 0; j < LON; j++) {
      const j2 = (j + 1) % LON;
      M.quad(grid[i][j], grid[i][j2], grid[i + 1][j2], grid[i + 1][j]);
    }
  }
}
