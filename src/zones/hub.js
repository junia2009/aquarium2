import * as THREE from 'three';
import { baseUniforms, U } from '../env.js';
import { UW_FRAG_PRELUDE, UW_FRAG_OUTPUT } from '../glsl.js';
import { CollisionWorld } from '../collision.js';
import { buildExterior, ANNEX, FLOOR_Y, riseAt } from './hubExterior.js';

// ============ ポータルエリア(海中研究施設) ============
//
// 水槽が増えるほど、下のタブは横に伸びていく。5つで既に画面から
// はみ出していた。タブは「数が増えても壊れない」形をしていない。
//
// かわりに、行き先そのものを場所にする。海中の研究施設に降り立ち、
// 壁に並んだハッチをくぐって各エリアへ行く。増えるときは
// ハッチが1つ増えるだけで、UIは何も伸びない。
//
// 名前はプロテウス。海神ポセイドンのアザラシを世話する、姿を自在に
// 変える予言者の神から。ここは五つの海に化ける唯一の部屋なので、
// 名前が施設の機能そのものを言っていることになる。
//
// 見た目は『MEG ザ・モンスター』のマナ・ワンを下敷きにしている。
// あの施設が水中の建物として説得力を持っているのは、
//   ・円筒と球を組み合わせた与圧殻の形をしていること
//   ・構造リブ・手すり・注意帯といった「人が働く場所」の設えがあること
//   ・床にムーンプール(submersible の出入口)が開いていて、
//     そこだけ外の暗い海が見えていること
// の3つで、飾りではなく機能の形をしている。ここでも同じ順で作る。

const DECK_Y = 4.0;         // 甲板の高さ
// 部屋の中心に立って見回す場所。半径はハッチの見かけの大きさで決まる。
//
// 一度10.5mまで詰めたが、これは横並びの画面で、しかもカメラが壁ぎわに
// あった頃の判断だった。中心に立つと全ハッチが同じ距離に来るうえ、
// 縦長の携帯では横の画角が狭い。10.5mだとハッチが画面の6割を占めて、
// 何を見ているのか分からなくなる。13mで4割弱に収まる
const ROOM_R = 13.0;        // 与圧殻の内半径
const WALL_H = 6.4;         // 甲板から天井の付け根まで
const PORTAL_R = 1.75;      // ハッチの半径
const PORTAL_Y = DECK_Y + 2.35;
// ハッチ一式を壁からどれだけ奥へ引っ込めるか。
//
// 平らな円板を曲がった壁の内側に置くと、円板の縁は中心より外側の
// 半径に来る(半径10.5mの壁で幅1.75mなら、縁は10.43m)。
// 引っ込み量が足りないと、内側へ20cm出ている縦リブが円板を
// 縦にすっぱり切る。実際そうなっていて、ハッチの片側だけが
// 直線で塞がって見えた。
//   縁の半径 = sqrt(奥行き^2 + 2.06^2) < リブの半径 10.30
// を満たすには、奥行きは 10.15m より小さければよい
const PORTAL_INSET = 0.55;
// ハッチが占める角度の半分(＋余裕)。ここにはリブを立てない
const PORTAL_ARC = 0.26;
// 舷窓。ハッチとハッチのあいだに開ける。
//
// 「海底にある感じがしない」のいちばんの理由は、外の海が見えないこと。
// この手の施設が水中の建物として成立するのは、巨大な窓の向こうに
// 暗い水がずっと続いているからで、鋼の内装のほうではない。
// 舷窓は「壁の穴」に見えないといけない。小さいと計器盤の窓になる。
// 枠の外縁が壁のリブ(半径 12.80)に当たらないよう、
//   sqrt(奥行き^2 + (幅/2 + 枠厚)^2) < 12.80
// を満たす奥行きに引っ込める
const WIN_W = 4.6, WIN_H = 3.4;
// 窓の高さ。目の高さ(甲板+1.85m)に近いところへ下げてある。
//
// はじめ 甲板+2.9m に付けていたが、それだと敷居が目線より下がらず、
// 窓に寄っても海底が見えなかった。外に本物の海底を建てても、
// 敷居の陰に入っていたら意味がない
const WIN_Y = DECK_Y + 2.35;
const WIN_INSET = 0.55;
const WIN_ARC = 0.28;
// 壁に開ける穴の上下。窓枠の内周(±1.70)より少し小さく取って、
// 差のぶんが板厚の見えるところ(開口の内側)になる
const HOLE_BOT = WIN_Y - 1.55, HOLE_TOP = WIN_Y + 1.55;

// 潜水士用の出入口(エアロック)。
//
// 天蓋はガラスなので、そこを通り抜けて外へ出るのは嘘になる。
// 外に観測棟を建てて「行ける場所」にした以上、まともな出口が要る。
//
// 角度は固定値で持つ。舷窓の位置は行き先の数で変わるが、扉が動く
// 建物は無い。近くに来てしまった舷窓のほうを1枚やめる。
const LOCK_A = -Math.PI * 0.5 + Math.PI / 5;
const LOCK_ARC = 0.155;                 // 開口の半角
const LOCK_TOP = DECK_Y + 2.35;         // 鴨居。WY の段に乗る高さ
const LOCK_OUT = 18.5;                  // 外の踏み台の先端
const LOCK_HALF = 2.4;                  // 踏み台の半幅

// 天井の投光器。位置は照明にも光の筋にも塵の明るさにも使う
const LAMP_N = 8;
const LAMP_Y = DECK_Y + WALL_H + 0.55;
const LAMP_R = ROOM_R * 0.66;
const lampAngle = (k) => (k / LAMP_N) * Math.PI * 2 + Math.PI / LAMP_N;

/**
 * この場所の「床」。カメラも生き物もこれを見て、下限の高さを決める。
 *
 * ずっと甲板の高さ(4.0m)を返す定数だった。殻の中しか歩けない前提なら
 * それでよかったが、外に海底も観測棟も建った以上、外へ出た人が
 * 甲板の高さで宙に浮いたままになる——海底まで降りられないし、
 * 観測棟に入っても床から沈む。
 *
 * 場所ごとに正しい床を返す。
 */
export function hubFloor(x, z) {
  const r = Math.hypot(x, z);
  if (r < ROOM_R - 0.6) return DECK_Y;                 // 与圧殻の中は甲板
  const dx = x - ANNEX.x, dz = z - ANNEX.z;
  if (dx * dx + dz * dz < ANNEX.inner * ANNEX.inner) return ANNEX.floor;  // 観測棟の中
  // 出口の外の踏み台。ここが海底の高さだと、扉を出た瞬間に落ちる
  const along = x * Math.cos(LOCK_A) + z * Math.sin(LOCK_A);
  const across = -x * Math.sin(LOCK_A) + z * Math.cos(LOCK_A);
  if (along > ROOM_R - 1.2 && along < LOCK_OUT && Math.abs(across) < LOCK_HALF) return DECK_Y;
  return FLOOR_Y + riseAt(r);                          // それ以外は海底
}

// 施設の金属。岩や生き物と同じ光で照らして、浮かないようにする
function metalMaterial(extra, vert, frag, opts = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { ...baseUniforms(), ...extra },
    side: opts.side ?? THREE.FrontSide,
    transparent: !!opts.transparent,
    depthWrite: opts.depthWrite ?? true,
    vertexShader: vert,
    fragmentShader: UW_FRAG_PRELUDE + frag,
  });
}

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

// 部屋の壁と床は、ポータルからの光でも照らされる。
//
// これが無いと、ハッチは壁に貼った丸いステッカーにしかならない。
// 光っているものは、まわりを自分の色に染める。染めていないものは、
// 光っているように見えない——絵として明るいかどうかとは別の話。
//
// そして、この染まりがそのまま「どっちに何があるか」を教える。
// 部屋の中心に立って見回すとき、左の床が緑なら磯はそちら側にある。
// 選択肢が視野の外にあっても、光だけは回りこんでくる
const NP = 8;                       // ポータルの最大数
const PORTAL_LIGHT = /* glsl */ `
  uniform int uPortalN;
  uniform vec3 uPortalPos[${NP}];
  uniform vec3 uPortalCol[${NP}];
  uniform float uPortalGlow[${NP}];

  vec3 portalLight(vec3 wp, vec3 n) {
    vec3 sum = vec3(0.0);
    for (int i = 0; i < ${NP}; i++) {
      if (i >= uPortalN) break;
      vec3 d = uPortalPos[i] - wp;
      float dist = length(d);
      vec3 L = d / max(dist, 0.001);
      // 面光源なので点光源ほど急ではないが、十分に落とすこと。
      // 緩くしすぎると部屋ぜんたいが一色に染まり、
      // 「どっちに何があるか」を伝えるどころか、方向を消してしまう
      float atten = 1.0 / (1.0 + 0.22 * dist + 0.13 * dist * dist);
      // 板の裏へは回りこまない
      float ndl = max(dot(n, L), 0.0);
      sum += uPortalCol[i] * (ndl * 0.92 + 0.08) * atten * uPortalGlow[i];
    }
    return sum;
  }
`;

// 塗装の汚れ。
//
// 「無機質」の正体は、塗りたてで一様な面そのもの。均質な色は
// 工業製品のレンダリングには見えても、何年も海の底に沈んでいる
// 建物には見えない。実際の海中構造物で起きているのは4つ:
//   ・板ごとに退色の進み方がちがう(同じ塗料でも一枚ごとに違う)
//   ・継ぎ目や器具の下から、錆と沈殿物が縦に垂れる
//   ・上を向いた面には泥が積もる(海中の埃は落ちて留まる)
//   ・低いところほど黒ずむ
// どれも「汚す」ためではなく、面に履歴を持たせるために要る
const SURFACE = /* glsl */ `
  vec3 grime(vec3 wp, vec3 n, vec3 base) {
    float ang = atan(wp.z, wp.x);
    float s = ang * 9.0;                     // 円周をおよそ1.4m刻みに
    // 板ごとのムラ。升目は大きくとる——1m角だと市松模様に見えて、
    // 塗装のムラではなく粗いテクスチャの継ぎ目になる
    vec2 cell = vec2(s * 0.45, wp.y * 0.32);
    float panel = vnoise(floor(cell) * 3.7);
    base *= 0.86 + 0.26 * panel;
    // 板の継ぎ目。升目の境に細い暗線を入れる。
    // ムラだけだと「汚れた面」で、線が入って初めて「張った板」になる
    // e は升目の中心で0、境で0.5。境のほうを1にすること——
    // 逆に書くと「升目の内側だけを暗くする」ことになり、
    // 継ぎ目が明るい線になって、画面ぜんたいに白い格子が乗る
    vec2 e = abs(fract(cell) - 0.5);
    float seam = smoothstep(0.470, 0.5, max(e.x, e.y));
    base *= 1.0 - 0.26 * seam;
    // 縦に垂れる汚れ。円周方向には細かく、高さ方向にはゆっくり——
    // これで初めて「垂れた跡」になる。等方な斑点はただの汚れ模様
    float st = fbm(vec2(s * 4.0, wp.y * 0.20));
    float run = smoothstep(0.46, 0.82, st) * (1.0 - abs(n.y));
    base = mix(base, base * vec3(0.70, 0.44, 0.26), run * 0.72);
    // 上を向いた面に積もる沈殿物
    float up = smoothstep(0.30, 0.92, n.y);
    float silt = up * (0.40 + 0.60 * fbm(vec2(wp.x, wp.z) * 0.55));
    base = mix(base, vec3(0.128, 0.126, 0.112), silt * 0.44);
    // 足もとほど黒ずむ
    base *= mix(0.72, 1.0, smoothstep(0.0, 2.6, wp.y - ${DECK_Y.toFixed(1)}));
    return base;
  }
`;

// 投光器の光。
//
// これまで部屋は「上からの一様な光」だけで照らしていた。だから
// どこも同じ明るさで、面の向きしか手がかりが無く、まさに無機質な
// 灰色の筒になっていた。海の底の建物に一様な光は来ない——
// 天井の器具の真下だけが明るく、そのあいだは沈む。その落差が
// 「照明で保っている場所」の見た目そのものになる。
//
// 器具の位置は定数なので、ユニフォームを配るのをやめて
// シェーダに直に焼く。WebGL の GLSL ES 1.00 には const 配列が
// 無いので、ループではなく展開して書く
const lampPoints = [];
for (let k = 0; k < LAMP_N; k++) {
  const a = lampAngle(k);
  lampPoints.push(`vec3(${(Math.cos(a) * LAMP_R).toFixed(3)}, ${LAMP_Y.toFixed(3)}, `
                  + `${(Math.sin(a) * LAMP_R).toFixed(3)})`);
}
const LAMP_LIGHT = /* glsl */ `
  float lampAt(vec3 wp, vec3 n, vec3 lp) {
    vec3 d = lp - wp;
    float dist = length(d);
    vec3 L = d / max(dist, 0.001);
    // 下向きの配光。器具から見て真下ほど強い。
    //
    // 減衰は強くする。緩いと8基ぶんが重なって部屋が一様に明るくなり、
    // 「投光器で保っている場所」ではなく「白い部屋」になる。
    // 一度そうなって、壁も床も 0.41〜0.47 の平坦な灰色に潰れた
    float cone = pow(max(L.y, 0.0), 2.6);
    float att = 1.0 / (1.0 + 0.05 * dist + 0.085 * dist * dist);
    return (max(dot(n, L), 0.0) * 0.86 + 0.14) * att * cone;
  }
  vec3 lampLight(vec3 wp, vec3 n) {
    float s = 0.0;
    ${lampPoints.map((p) => `s += lampAt(wp, n, ${p});`).join('\n    ')}
    return vec3(5.4, 6.0, 6.6) * s;
  }
`;

// 甲板の標示(中心の輪と、ハッチへの通路帯)。
//
// もとは床の 4mm 上に板を浮かせて重ねていた。これが携帯でチカチカした。
// 理由は2つあって、どちらも「重ねた」ことそのものが原因:
//
//  1. 深度の精度。後処理(散乱ぼかし)に描き込むレンダーターゲットの
//     深度バッファは16bitで、13m 先での分解能は約1.5cm。4mm の浮かせでは
//     どちらが手前か決まらず、フレームごとに入れ替わる。
//  2. もっと単純な取りこぼし——通路帯の右の黄線は幅 [0.53, 0.71]、
//     灰色の帯は [-0.62, 0.62] で、9cm ぶん**完全に同一平面で重なって**
//     いた。これはどんな端末でも必ず争う。
//
// 浮かせる量を増やすのは対症療法で、遠くではまた負ける(しかも近くで
// 段差に見える)。重ねるのをやめて、床そのものの色として塗る。
// 同一平面のポリゴンが1枚も無くなるので、原理的にチカチカしない。
const NO_DECK_MARK = /* glsl */ `
  vec3 deckMark(vec3 wp, vec3 n, vec3 base) { return base; }
`;

const LIT_MAIN = /* glsl */ `
  varying vec3 vCol;
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vec3 n = gl_FrontFacing ? normalize(vN) : -normalize(vN);
    vec3 viewDir = normalize(cameraPosition - vW);
    // 標示を塗ってから汚す。順を逆にすると、線の上だけ新品になる
    vec3 alb = grime(vW, n, deckMark(vW, n, vCol));
    // 塗装した鋼。つや消しだが、濡れているので弱いハイライトが乗る
    vec3 col = underwaterLight(alb, n, vW, viewDir, 22.0, 0.10);
    col += alb * lampLight(vW, n);
    col += alb * portalLight(vW, n) * 1.7;
    // 甲板の照り返し。
    //
    // 投光器は下向きなので、その上にあるもの——天蓋の骨組み、配管や
    // 枠の下面——には直接光がまったく当たらない。それ自体は正しいが、
    // 跳ね返りが無いと真っ黒な線になり、ガラスの天井が「黒い骨が
    // 浮いた空」に見えてしまう。明るい床からの一次反射だけ足す
    float fromBelow = max(-n.y, 0.0);
    float hAbove = clamp((vW.y - ${DECK_Y.toFixed(1)}) / 9.0, 0.0, 1.0);
    col += alb * vec3(0.30, 0.34, 0.38) * fromBelow * (1.0 - hAbove * 0.50);
    gl_FragColor = vec4(applyUnderwaterFog(col, vW), 1.0);
    ${UW_FRAG_OUTPUT}
  }
`;

const litFrag = (marks = NO_DECK_MARK) =>
  PORTAL_LIGHT + SURFACE + LAMP_LIGHT + marks + LIT_MAIN;

const LIT_FRAG = litFrag();

const glslV3 = (c) => `vec3(${c.map((v) => v.toFixed(4)).join(',')})`;

/** ハッチの向きを焼き込んだ甲板標示。行き先が決まってから作る */
function deckMarkGLSL(hatchAngles) {
  const lanes = hatchAngles
    .map((a) => `    lane(wp, ${a.toFixed(5)}, w, col);`).join('\n');
  const FAR = (ROOM_R - 0.9).toFixed(2);
  return /* glsl */ `
  // 帯の内側で1、外へ出ると0。
  //
  // smoothstep(hi, lo, x) と逆向きに書く手は使わない。GLSL の仕様では
  // edge0 >= edge1 のとき**結果は未定義**で、多くの実装でたまたま
  // 期待どおり動くだけ。端末を選ぶバグの温床になる
  float inside(float x, float lo, float hi, float w) {
    return smoothstep(lo - w, lo + w, x) * (1.0 - smoothstep(hi - w, hi + w, x));
  }
  void lane(vec3 wp, float ha, float w, inout vec3 col) {
    float along = wp.x * cos(ha) + wp.z * sin(ha);
    float across = abs(-wp.x * sin(ha) + wp.z * cos(ha));
    float run = inside(along, 1.80, ${FAR}, w);
    // 歩く帯
    float band = run * (1.0 - smoothstep(0.62 - w, 0.62 + w, across));
    // 縁の黄線。帯の**外側だけ**に置く。もとは片側だけ内側へ
    // 食い込んでいて、そこが同一平面の重なりになっていた
    float edge = run * inside(across, 0.62, 0.71, w);
    col = mix(col, ${glslV3(PAINT2)}, band);
    col = mix(col, ${glslV3(HAZARD)}, edge);
  }
  vec3 deckMark(vec3 wp, vec3 n, vec3 base) {
    // 甲板の上面だけ。壁や天井、床ぎわの配管には塗らない
    if (n.y < 0.85 || abs(wp.y - ${DECK_Y.toFixed(2)}) > 0.06) return base;
    // 縁の甘さは距離で決める。fwidth は ESSL1 では拡張が要るので使わない
    float w = 0.006 + distance(cameraPosition, wp) * 0.0016;
    float r = length(wp.xz);
    vec3 col = base;
    // 中心の輪。「ここが立ち位置」であることを床が言う
    col = mix(col, ${glslV3(HAZARD)}, inside(r, 1.55, 1.75, w));
    col = mix(col, ${glslV3(PAINT2)}, inside(r, 1.20, 1.30, w));
${lanes}
    return col;
  }
`;
}

/** ポータルの光をシェーダへ渡すためのユニフォーム一式 */
function portalLightUniforms() {
  const pos = [], col = [], glow = [];
  for (let i = 0; i < NP; i++) {
    pos.push(new THREE.Vector3()); col.push(new THREE.Color(0, 0, 0)); glow.push(0);
  }
  return {
    uPortalN: { value: 0 },
    uPortalPos: { value: pos },
    uPortalCol: { value: col },
    uPortalGlow: { value: glow },
  };
}

// ---------------------------------------------------------------- 形を作る道具
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

// 塗装の色。実際の有人施設は白か明るい灰に塗る——暗い海の中で
// 何がどこにあるかを、限られた投光器で分からせないといけないから
const PAINT = [0.208, 0.220, 0.232];
const PAINT2 = [0.142, 0.152, 0.166];   // リブや影になる面
const DECK = [0.112, 0.118, 0.126];     // 甲板は滑り止めで暗い
const HAZARD = [0.290, 0.215, 0.055];   // 注意帯の黄
const RAIL = [0.215, 0.225, 0.235];
const DARK = [0.020, 0.024, 0.030];     // ムーンプールの奥

/**
 * 施設の殻。甲板・壁・天井をひとまとめに作る。
 *
 * ハッチの角度を受け取るのは、そこにリブを立てないため。
 * 構造材を出入口の真ん中に通す設計はないし、通してしまうと
 * リブがハッチの手前を横切って、円板を縦にすっぱり切る
 */
function buildShell(openings = [], windows = []) {
  // openings: [角度, 半角] の並び。ハッチも舷窓も、開口の前には
  // 構造材を通さない
  const clearOfOpening = (a) => {
    for (const [oa, arc] of openings) {
      const d = Math.abs(((a - oa + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (d < arc) return false;
    }
    return true;
  };
  const M = new Buf();
  // 円周の分割。細部の周期に対して十分に細かくないと、模様は出ない。
  // 64分割で24本のリブを立てようとしていたら、1本あたり1.3標本しか
  // なくて、リブは「出ていない」のではなく「標本にかからなかった」。
  // イソギンチャクの疣とまったく同じ穴で、今度は数を減らして
  // 1本あたり4標本を確保する
  const N = 160;
  const ang = (k) => (k / N) * Math.PI * 2;

  // ---- 甲板 ----
  // 中心から壁まで、継ぎ目のない一枚。もとは中央にムーンプールを
  // 開けていたが、立ち位置を部屋の中心に置くなら、そこは床でなければ
  // ならない。立つ場所に穴が開いているのは、間取りとして矛盾している
  const RINGS = 7;
  const grid = [];
  const hub0 = M.v(0, DECK_Y, 0, DECK);
  for (let i = 1; i <= RINGS; i++) {
    const r = ROOM_R * (i / RINGS);
    const row = [];
    for (let k = 0; k < N; k++) {
      const a = ang(k);
      // 板の継ぎ目。8枚の扇形に分かれている
      // 継ぎ目は1本あたり2.8標本。0.47(=0.5標本)では出なかった
      const seam = Math.abs(((a / (Math.PI * 2)) * 8) % 1 - 0.5) > 0.43;
      row.push(M.v(Math.cos(a) * r, DECK_Y, Math.sin(a) * r, seam ? PAINT2 : DECK));
    }
    grid.push(row);
  }
  // 中心の扇。巻き方は外側の輪と揃えること。
  //
  // ここだけ逆に巻いていた。頂点法線は面法線を面積で重みづけて平均して
  // いるので、いちばん内側の輪では「下向きの扇」と「上向きの輪」が
  // 打ち消し合う。扇の内側から外側へ向かって法線が上→下へ裏返り、
  // 途中で 0 を通る。裏返ったところは投光器が当たらず環境光の下側だけに
  // なるので、半径 0.95〜1.86m が真っ黒な輪になっていた
  // (真上から半径ごとに色を測って、ようやく正体が分かった)。
  // 中心の標示が見えなかったのは、その黒い輪の上に塗っていたから
  for (let k = 0; k < N; k++) M.tri(hub0, grid[0][(k + 1) % N], grid[0][k]);
  for (let i = 0; i < RINGS - 1; i++) {
    for (let k = 0; k < N; k++) {
      const k2 = (k + 1) % N;
      M.quad(grid[i][k], grid[i][k2], grid[i + 1][k2], grid[i + 1][k]);
    }
  }
  // 中心の輪と、各ハッチへ伸びる通路帯は、ここでは作らない。
  //
  // 有人施設の床には必ず「どこを歩くか」が引いてあって、ここでは
  // 行き先を指す線としても働く(見回さなくても足もとがハッチの方角を
  // 教える)。だが板を床の上に浮かせて重ねると必ず深度で争う。
  // 描くのは甲板そのもののシェーダ(deckMarkGLSL)に任せる

  // ---- 壁 ----
  // 円筒。縦のリブが等間隔に立つ。リブは飾りではなく、
  // 水圧を受ける殻の補強材で、実物にも必ずある。
  //
  // 段の高さは等分ではなく、舷窓の上下に境目が来るように取る。
  // 窓のところは本当に穴を開けるので、穴の縁が段に乗っていないと
  // 開けられない
  const WY = [DECK_Y, DECK_Y + 0.42, HOLE_BOT, DECK_Y + 1.55, DECK_Y + 2.35,
              DECK_Y + 3.15, HOLE_TOP, DECK_Y + 5.05, DECK_Y + WALL_H];
  const WROWS = WY.length - 1;
  const R0 = WY.indexOf(HOLE_BOT), R1 = WY.indexOf(HOLE_TOP);
  // 穴の角度の半分。枠の外縁(角度 0.208rad)より内側に収めること——
  // 大きいと、枠から穴がはみ出して壁に切れ目が見える
  const HOLE_ARC = 0.165;
  const inHole = (a) => {
    for (const wa of windows) {
      const d = Math.abs(((a - wa + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (d < HOLE_ARC) return wa;
    }
    return null;
  };
  // 潜水士用の出口。床から鴨居まで、まるごと開ける
  const LR0 = 0, LR1 = WY.indexOf(LOCK_TOP);
  const inLock = (a) =>
    Math.abs(((a - LOCK_A + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < LOCK_ARC;
  const wall = [];
  for (let i = 0; i <= WROWS; i++) {
    const y = WY[i];
    const row = [];
    for (let k = 0; k < N; k++) {
      const a = ang(k);
      // リブ。12本。160分割なら1本13.3標本ぶんの周期があり、
      // 幅3割で4標本——ようやく「立っている」ように見える。
      // ただしハッチと舷窓の前は素通し
      const rib = Math.abs(((a / (Math.PI * 2)) * 12) % 1 - 0.5) > 0.35
                  && clearOfOpening(a);
      const r = ROOM_R - (rib ? 0.20 : 0);
      row.push(M.v(Math.cos(a) * r, y, Math.sin(a) * r, rib ? PAINT : PAINT2));
    }
    wall.push(row);
  }
  // 穴に当たる升目だけ張らない。「窓の絵」ではなく本当の開口にする
  const holeCols = new Map();      // 舷窓の角度 → その穴が使う列の並び
  for (let k = 0; k < N; k++) {
    const wa = inHole(ang(k) + Math.PI / N);   // 升目の中央で判定する
    if (wa === null) continue;
    if (!holeCols.has(wa)) holeCols.set(wa, []);
    holeCols.get(wa).push(k);
  }
  const lockCols = [];
  for (let k = 0; k < N; k++) if (inLock(ang(k) + Math.PI / N)) lockCols.push(k);
  for (let i = 0; i < WROWS; i++) {
    const rowInHole = (i >= R0 && i < R1);
    const rowInLock = (i >= LR0 && i < LR1);
    for (let k = 0; k < N; k++) {
      const mid = ang(k) + Math.PI / N;
      if (rowInHole && inHole(mid) !== null) continue;
      if (rowInLock && inLock(mid)) continue;
      const k2 = (k + 1) % N;
      M.quad(wall[i][k2], wall[i][k], wall[i + 1][k], wall[i + 1][k2]);
    }
  }
  // 出口の見込み。壁の厚みを見せる——ここが無いと、殻に紙を切った
  // ような穴が開いているだけになる
  if (lockCols.length) {
    const IN = ROOM_R - 0.34;
    const vc = [...lockCols, (lockCols[lockCols.length - 1] + 1) % N];
    const inner = (k, i) => M.v(Math.cos(ang(k)) * IN, WY[i], Math.sin(ang(k)) * IN, PAINT2);
    // 上と下の見込み
    for (const i of [LR0, LR1]) {
      for (let j = 0; j < vc.length - 1; j++) {
        const a0 = wall[i][vc[j]], a1 = wall[i][vc[j + 1]];
        const b0 = inner(vc[j], i), b1 = inner(vc[j + 1], i);
        if (i === LR1) M.quad(a0, a1, b1, b0); else M.quad(b0, b1, a1, a0);
      }
    }
    // 左右の見込み
    for (const [ci, sgn] of [[0, -1], [vc.length - 1, 1]]) {
      for (let i = LR0; i < LR1; i++) {
        const a0 = wall[i][vc[ci]], a1 = wall[i + 1][vc[ci]];
        const b0 = inner(vc[ci], i), b1 = inner(vc[ci], i + 1);
        if (sgn > 0) M.quad(a0, a1, b1, b0); else M.quad(b0, b1, a1, a0);
      }
    }
  }
  // 開口の内側(板厚の見えるところ)。
  //
  // ここが無いと、殻が「厚さ0の紙」に見える。穴の縁を、窓枠の内周へ
  // 繋いで塞ぐ。繋ぐ相手は枠の実物なので、隙間が出ない
  const Rw = ROOM_R - WIN_INSET;
  const hw = WIN_W / 2, hh = WIN_H / 2;
  for (const [wa, cols] of holeCols) {
    // 列を「窓の中心からの角度」で並べ直す。角度0をまたぐ窓でも
    // 順序が崩れない(素直に添字で並べると 159 の次が 0 になる)
    const key = (k) => {
      let d = ang(k) - wa;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      return d;
    };
    const run = cols.slice().sort((p, q) => key(p) - key(q));
    const vc = [...run, (run[run.length - 1] + 1) % N];   // 升目の数+1 の頂点列
    const xmax = Math.max(...vc.map((k) => Math.abs(ROOM_R * Math.sin(key(k)))));
    const ymax = HOLE_TOP - WIN_Y;
    // 窓の平面での軸。+X は壁に沿う向き
    const ex = [-Math.sin(wa), 0, Math.cos(wa)];
    const org = [Math.cos(wa) * Rw, WIN_Y, Math.sin(wa) * Rw];
    // 奥(穴の縁)と手前(枠の内周)の対を返す
    const pair = (ci, ri, edge) => {
      const k = vc[ci];
      const xb = ROOM_R * Math.sin(key(k));
      const yb = WY[ri] - WIN_Y;
      const xf = (edge === 'x') ? Math.sign(xb) * hw : xb * (hw / xmax);
      const yf = (edge === 'x') ? yb * (hh / ymax) : Math.sign(yb) * hh;
      return {
        back: wall[ri][k],
        front: M.v(org[0] + ex[0] * xf, org[1] + yf, org[2] + ex[2] * xf, PAINT2),
      };
    };
    // 縁をぐるりと一周。下 → 右 → 上 → 左
    const loop = [];
    for (let j = 0; j < vc.length; j++) loop.push(pair(j, R0, 'y'));
    for (let i = R0 + 1; i <= R1; i++) loop.push(pair(vc.length - 1, i, 'x'));
    for (let j = vc.length - 2; j >= 0; j--) loop.push(pair(j, R1, 'y'));
    for (let i = R1 - 1; i > R0; i--) loop.push(pair(0, i, 'x'));
    for (let j = 0; j < loop.length; j++) {
      const a0 = loop[j], a1 = loop[(j + 1) % loop.length];
      M.quad(a0.back, a1.back, a1.front, a0.front);
    }
  }
  // 甲板と壁のあいだの幅木
  for (let k = 0; k < N; k++) {
    const k2 = (k + 1) % N;
    M.quad(grid[RINGS - 1][k2], grid[RINGS - 1][k], wall[0][k], wall[0][k2]);
  }

  // 天井はここでは作らない。透明な耐圧ガラスなので、鋼の殻とは
  // 別の材質になる(buildDome)。壁の上端に載る受けの環だけ置く
  for (let k = 0; k < N; k++) {
    const a = ang(k), a2 = ang(k + 1);
    const p = (aa, r, y) => M.v(Math.cos(aa) * r, y, Math.sin(aa) * r, PAINT);
    const y0 = DECK_Y + WALL_H - 0.10, y1 = DECK_Y + WALL_H + 0.26;
    const q0 = p(a, ROOM_R - 0.26, y0), q1 = p(a2, ROOM_R - 0.26, y0);
    const q2 = p(a2, ROOM_R - 0.26, y1), q3 = p(a, ROOM_R - 0.26, y1);
    M.quad(q0, q1, q2, q3);
    const w0 = p(a, ROOM_R, y1), w1 = p(a2, ROOM_R, y1);
    M.quad(q3, q2, w1, w0);
  }
  return M.geo();
}

/**
 * 出口の外。踏み台・手すり・海底へ降りる梯子。
 *
 * 扉だけ開けても、外は 3m 下が海底で、出た先に何も無い。
 * 潜水士が装備を置いて出入りする踏み台と、底へ降りる梯子があって
 * 初めて「ここから出る」と分かる。
 */
function buildLock(root, plu) {
  const M = new Buf();
  const c = Math.cos(LOCK_A), s = Math.sin(LOCK_A);
  const px = -s, pz = c;
  const P = (along, across, y, col) =>
    M.v(c * along + px * across, y, s * along + pz * across, col);
  const R0 = ROOM_R - 0.4, R1 = LOCK_OUT, HW = LOCK_HALF;

  // 踏み台。滑り止めの甲板と同じ色
  const q = [P(R0, -HW, DECK_Y, DECK), P(R1, -HW, DECK_Y, DECK),
             P(R1, HW, DECK_Y, DECK), P(R0, HW, DECK_Y, DECK)];
  M.quad(q[0], q[1], q[2], q[3]);
  // 裏側。下から見ると床が消えていては困る
  const u = [P(R0, -HW, DECK_Y - 0.22, PAINT2), P(R1, -HW, DECK_Y - 0.22, PAINT2),
             P(R1, HW, DECK_Y - 0.22, PAINT2), P(R0, HW, DECK_Y - 0.22, PAINT2)];
  M.quad(u[3], u[2], u[1], u[0]);
  for (let j = 0; j < 4; j++) {
    const j2 = (j + 1) % 4;
    M.quad(q[j], q[j2], u[j2], u[j]);
  }
  // 踏み台を支える斜材。宙に浮いた板は構造物に見えない
  for (const sgn of [-1, 1]) {
    strutHub(M, [c * R1 + px * HW * sgn, DECK_Y - 0.22, s * R1 + pz * HW * sgn],
             [c * (ROOM_R + 0.4) + px * HW * sgn, DECK_Y - 3.0,
              s * (ROOM_R + 0.4) + pz * HW * sgn], 0.13, PAINT2);
  }
  // 手すり。両脇と先端
  const post = (along, across) => {
    strutHub(M, [c * along + px * across, DECK_Y, s * along + pz * across],
             [c * along + px * across, DECK_Y + 1.05, s * along + pz * across], 0.05, RAIL);
  };
  for (const sgn of [-1, 1]) {
    for (let i = 0; i <= 3; i++) post(R0 + (R1 - R0) * (i / 3), HW * sgn);
    // 笠木
    strutHub(M, [c * R0 + px * HW * sgn, DECK_Y + 1.05, s * R0 + pz * HW * sgn],
             [c * R1 + px * HW * sgn, DECK_Y + 1.05, s * R1 + pz * HW * sgn], 0.045, RAIL);
  }

  // 梯子。踏み台の先から海底へ
  const footY = FLOOR_Y + riseAt(LOCK_OUT);
  for (const sgn of [-1, 1]) {
    strutHub(M, [c * (R1 - 0.3) + px * 0.45 * sgn, DECK_Y + 0.6, s * (R1 - 0.3) + pz * 0.45 * sgn],
             [c * (R1 + 0.5) + px * 0.45 * sgn, footY - 0.1, s * (R1 + 0.5) + pz * 0.45 * sgn],
             0.055, RAIL);
  }
  const rungs = 7;
  for (let i = 1; i < rungs; i++) {
    const t = i / rungs;
    const al = (R1 - 0.3) + 0.8 * t, y = DECK_Y + 0.6 + (footY - 0.7 - DECK_Y) * t;
    strutHub(M, [c * al - px * 0.45, y, s * al - pz * 0.45],
             [c * al + px * 0.45, y, s * al + pz * 0.45], 0.035, RAIL);
  }

  // 注意帯。出口のまわりは黄色で囲うのが決まり
  for (const sgn of [-1, 1]) {
    const w0 = HW - 0.28, w1 = HW - 0.10;
    M.quad(P(R0, w0 * sgn, DECK_Y + 0.01, HAZARD), P(R1, w0 * sgn, DECK_Y + 0.01, HAZARD),
           P(R1, w1 * sgn, DECK_Y + 0.01, HAZARD), P(R0, w1 * sgn, DECK_Y + 0.01, HAZARD));
  }
  const mesh = new THREE.Mesh(M.geo(), metalMaterial(plu, LIT_VERT, LIT_FRAG,
    { side: THREE.DoubleSide }));
  root.add(mesh);
  return mesh;
}

/** 2点を結ぶ角柱。hubExterior の strut と同じ働き */
function strutHub(M, a, b, rad, col) {
  const ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2];
  const L = Math.hypot(ax, ay, az) || 1;
  const dx = ax / L, dy = ay / L, dz = az / L;
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
      const cc = Math.cos(t) * rad, ss = Math.sin(t) * rad;
      o.push(M.v(p[0] + e1x * cc + e2x * ss, p[1] + e1y * cc + e2y * ss,
                 p[2] + e1z * cc + e2z * ss, col));
    }
    return o;
  };
  const r0 = ring(a), r1 = ring(b);
  for (let j = 0; j < SIDES; j++) {
    const j2 = (j + 1) % SIDES;
    M.quad(r0[j], r0[j2], r1[j2], r1[j]);
  }
}

// ---------------------------------------------------------------- 天井のガラス
//
// 海底の与圧殻に透明な天蓋を載せる。
//
// ここは「窓を大きくした」のとは意味が違う。頭の上ぜんぶが水になると、
// 部屋が海の底に**沈んでいる**ことが、見回さなくても常に視界の端に
// 入り続ける。舷窓は覗きにいくものだが、天井は覗かなくても見えている。
//
// ガラスだけを置いてはいけない。実物の耐圧窓はどれも、板より遥かに
// 太い骨組みで押さえてある——水圧を受けるのは骨で、ガラスは間を
// 塞いでいるだけ。骨が無いと、透明な膜が浮いているようにしか見えず、
// 「耐圧」がどこにも表現されない。
const DOME_H = 3.4;
const DOME_BASE = DECK_Y + WALL_H;
const DOME_TOP = DOME_BASE + DOME_H;

/** ドームの母線。[半径, 高さ, (r,y)平面での外向き法線] */
function domeProfile(steps) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const u = (i / steps) * Math.PI * 0.5;
    const r = ROOM_R * Math.cos(u);
    const y = DOME_BASE + DOME_H * Math.sin(u);
    // 楕円 (r/R)^2 + ((y-y0)/H)^2 = 1 の外向き法線
    let nr = DOME_H * Math.cos(u), ny = ROOM_R * Math.sin(u);
    const L = Math.hypot(nr, ny) || 1;
    out.push([r, y, nr / L, ny / L]);
  }
  return out;
}

// ガラスは「向こうが見える」だけでは板に見えない。
// 見えているのは、
//   ・すれすれの角度ほど強くなる映り込み(フレネル)
//   ・室内の照明が面に落とすハイライト
//   ・外側に付いた汚れと生物膜
// の3つで、これが無いと天井が「開いている」ことになってしまう。
const GLASS_DOME_FRAG = PORTAL_LIGHT + LAMP_LIGHT + /* glsl */ `
  varying vec3 vW;
  varying vec3 vN;
  void main() {
    // 室内から見るとドームの裏面。法線を室内向きに揃える
    vec3 n = gl_FrontFacing ? normalize(vN) : -normalize(vN);
    vec3 v = normalize(cameraPosition - vW);
    // すれすれの角度でだけ立ち上がるように、指数はきつく取る。
    // 3.0 だと天蓋の広い範囲に映り込みが乗り、全体が白く霞む
    float fres = pow(1.0 - abs(dot(n, v)), 4.5);

    // 天井の投光器と、ハッチの色が映る。ガラスは鏡ではないので弱く。
    //
    // ハッチの寄与はとくに絞る。5枚ぶんの面光源が天蓋いっぱいに
    // ぼんやり乗るので、少しでも強いとそれだけで曇りになる
    vec3 sheen = lampLight(vW, n) * 0.055 + portalLight(vW, n) * 0.035;

    // 外側に付いた汚れ。
    //
    // これは**光が当たったところにしか見えない**。一律に足すと、
    // 暗い部分の黒が持ち上がってガラス全体が均一に曇る。実際そうなって、
    // 中から見ると曇りガラス、外から見ると澄んで見えるという妙な
    // 非対称が出ていた(ガラスだけで平均 +0.048、コントラストは
    // 標準偏差 0.023 → 0.016 まで潰れていた)。映り込みを濃くする形で
    // 効かせれば、暗いところは暗いまま残る
    float dirt = smoothstep(0.46, 0.86, fbm(vec2(vW.x * 0.42, vW.z * 0.42)));
    float run = smoothstep(0.58, 0.90, fbm(vec2(atan(vW.z, vW.x) * 11.0,
                                                length(vW.xz) * 0.30)));
    dirt = max(dirt * 0.7, run * 0.55);

    // 素通しの板に、縁の映り込みだけが乗る
    float a = 0.0020 + 0.085 * fres * (0.75 + 0.50 * dirt);
    vec3 col = vec3(0.34, 0.46, 0.55) * a + sheen * (1.0 + 0.9 * dirt);
    gl_FragColor = vec4(col, 1.0);
    ${UW_FRAG_OUTPUT}
  }
`;

/**
 * 透明な天蓋と、それを押さえる骨組み。
 *
 * ガラスは加算合成で「映り込みだけ」を足す板として描く。
 * 不透明度を持たせて普通に半透明合成すると、外のマリンスノーや
 * 遠景と描画順を争って、粒がガラスの手前に出たり消えたりする。
 * 映り込みは光を足す現象なので、加算のほうが理屈にも合っている。
 */
function buildDome(root, plu) {
  const PROF = 16, SEG = 96;
  const prof = domeProfile(PROF);

  // --- ガラス面 ---
  const pos = [], nrm = [], idx = [];
  for (let i = 0; i <= PROF; i++) {
    const [r, y, nr, ny] = prof[i];
    for (let k = 0; k <= SEG; k++) {
      const a = (k / SEG) * Math.PI * 2;
      pos.push(Math.cos(a) * r, y, Math.sin(a) * r);
      nrm.push(Math.cos(a) * nr, ny, Math.sin(a) * nr);
    }
  }
  for (let i = 0; i < PROF; i++) {
    for (let k = 0; k < SEG; k++) {
      const p0 = i * (SEG + 1) + k, p1 = p0 + 1;
      const p2 = p0 + (SEG + 1), p3 = p2 + 1;
      idx.push(p0, p2, p3, p0, p3, p1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
  g.setIndex(idx);
  const glass = new THREE.Mesh(g, new THREE.ShaderMaterial({
    uniforms: { ...baseUniforms(), ...plu },
    vertexShader: /* glsl */ `
      varying vec3 vW;
      varying vec3 vN;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: UW_FRAG_PRELUDE + GLASS_DOME_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  }));
  glass.renderOrder = 4;      // 外の景色を描いたあとに乗せる
  root.add(glass);

  // --- 骨組み ---
  const M = new Buf();
  // 母線に沿った梁。断面は矩形で、室内側へ張り出す
  const RIBS = 12;
  for (let b = 0; b < RIBS; b++) {
    const a = (b / RIBS) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const px = -sa, pz = ca;                 // 円周に沿う向き(梁の幅)
    let prev = null;
    for (let i = 0; i <= PROF; i++) {
      const [r, y, nr, ny] = prof[i];
      // 頂点へ寄るほど梁を細くする。同じ幅のまま集めると要が潰れる
      const w = 0.115 * (0.45 + 0.55 * (r / ROOM_R));
      const d = 0.20;
      // 面上の点から、内向き法線ぶん下げたところが梁の内側
      const sx = ca * r, sz = sa * r;
      const ix = ca * (r - nr * d), iy = y - ny * d, iz = sa * (r - nr * d);
      const corner = (bx, by, bz, s) =>
        M.v(bx + px * w * s, by, bz + pz * w * s, PAINT);
      const ring = [corner(sx, y, sz, -1), corner(sx, y, sz, 1),
                    corner(ix, iy, iz, 1), corner(ix, iy, iz, -1)];
      if (prev) {
        for (let j = 0; j < 4; j++) {
          const j2 = (j + 1) % 4;
          M.quad(prev[j], prev[j2], ring[j2], ring[j]);
        }
      }
      prev = ring;
    }
  }
  // 緯度方向の環。これが無いと梁がばらばらの骨に見える。
  //
  // 断面は輪の一周ぶんを一度だけ作って繋ぐこと。区間ごとに頂点を
  // 作り直すと、継ぎ目で法線が平均されず、輪が数珠つなぎの玉に見える
  for (const t of [0.30, 0.62]) {
    const i = Math.round(t * PROF);
    const [r, y, nr, ny] = prof[i];
    const d = 0.155, w = 0.085;
    // 断面の4隅を (半径方向, 高さ) のずれで持つ
    const sect = [[0, w], [0, -w], [-d, -w], [-d, w]];
    const rings = sect.map(([od, oy]) => {
      const arr = [];
      for (let k = 0; k < SEG; k++) {
        const a = (k / SEG) * Math.PI * 2;
        const rr = r + nr * od;
        arr.push(M.v(Math.cos(a) * rr, y + ny * od + oy, Math.sin(a) * rr, PAINT));
      }
      return arr;
    });
    for (let k = 0; k < SEG; k++) {
      const k2 = (k + 1) % SEG;
      for (let j = 0; j < 4; j++) {
        const j2 = (j + 1) % 4;
        M.quad(rings[j][k], rings[j2][k], rings[j2][k2], rings[j][k2]);
      }
    }
  }
  // 要。梁が集まる頂点の金物
  {
    const SIDES = 16, hubR = 0.62;
    const lo = [], hi = [];
    for (let k = 0; k < SIDES; k++) {
      const a = (k / SIDES) * Math.PI * 2;
      lo.push(M.v(Math.cos(a) * hubR, DOME_TOP - 0.30, Math.sin(a) * hubR, PAINT2));
      hi.push(M.v(Math.cos(a) * hubR, DOME_TOP + 0.02, Math.sin(a) * hubR, PAINT));
    }
    for (let k = 0; k < SIDES; k++) {
      const k2 = (k + 1) % SIDES;
      M.quad(lo[k], lo[k2], hi[k2], hi[k]);
    }
    const cap = M.v(0, DOME_TOP + 0.02, 0, PAINT);
    for (let k = 0; k < SIDES; k++) M.tri(hi[k], hi[(k + 1) % SIDES], cap);
  }
  root.add(new THREE.Mesh(M.geo(), metalMaterial(plu, LIT_VERT, LIT_FRAG,
    { side: THREE.DoubleSide })));
}

/**
 * 天井の投光器。
 *
 * 海中の建物は、外から光が来ない。だから照明器具そのものが
 * 「ここは人の作った場所だ」といちばん強く言う設えになる。
 * 器具の箱と、下を向いた発光面の2つで作る——発光面だけだと
 * 光が宙に浮き、箱だけだと消えた照明になる
 */
function buildLamps(root, plu) {
  const M = new Buf();
  const glow = new Buf();
  const LR = LAMP_R;
  for (let k = 0; k < LAMP_N; k++) {
    const a = lampAngle(k);
    const cx = Math.cos(a) * LR, cz = Math.sin(a) * LR;
    // 器具の箱
    const w = 0.62, d = 0.30, h = 0.22;
    const c = Math.cos(a), s2 = Math.sin(a);
    const corner = (u, v, y) => M.v(cx + (-s2 * u + c * v), y, cz + (c * u + s2 * v), PAINT2);
    const top = [corner(-w, -d, LAMP_Y + h), corner(w, -d, LAMP_Y + h),
                 corner(w, d, LAMP_Y + h), corner(-w, d, LAMP_Y + h)];
    const bot = [corner(-w, -d, LAMP_Y), corner(w, -d, LAMP_Y),
                 corner(w, d, LAMP_Y), corner(-w, d, LAMP_Y)];
    for (let j = 0; j < 4; j++) {
      const j2 = (j + 1) % 4;
      M.quad(top[j], top[j2], bot[j2], bot[j]);
    }
    // 吊り棒。天井がガラスになったので、器具は骨組みから吊り下がる。
    // これが無いと、透明な天蓋の下に箱が浮いているだけに見える
    {
      // 器具の真上でドームの面はどの高さか。楕円を半径から逆に解く
      const u = Math.acos(Math.min(LR / ROOM_R, 1));
      const domeY = DOME_BASE + DOME_H * Math.sin(u);
      const rod = 0.055;
      for (const off of [-w * 0.62, w * 0.62]) {
        const rx = cx + -s2 * off, rz = cz + c * off;
        const lo = [], hi = [];
        for (let j = 0; j < 4; j++) {
          const t = (j / 4) * Math.PI * 2;
          const ox = Math.cos(t) * rod, oz = Math.sin(t) * rod;
          lo.push(M.v(rx + ox, LAMP_Y + h, rz + oz, PAINT2));
          hi.push(M.v(rx + ox, domeY - 0.16, rz + oz, PAINT2));
        }
        for (let j = 0; j < 4; j++) {
          const j2 = (j + 1) % 4;
          M.quad(lo[j], lo[j2], hi[j2], hi[j]);
        }
      }
    }
    // 発光面。下向き
    const gc = (u, v) => glow.v(cx + (-s2 * u + c * v), LAMP_Y - 0.005,
                                cz + (c * u + s2 * v), [1, 1, 1]);
    const g0 = gc(-w * 0.82, -d * 0.7), g1 = gc(w * 0.82, -d * 0.7);
    const g2 = gc(w * 0.82, d * 0.7), g3 = gc(-w * 0.82, d * 0.7);
    glow.quad(g3, g2, g1, g0);
  }
  root.add(new THREE.Mesh(M.geo(), metalMaterial(plu, LIT_VERT, LIT_FRAG)));
  root.add(new THREE.Mesh(glow.geo(), new THREE.MeshBasicMaterial({
    color: 0xdaeeff, toneMapped: false, side: THREE.DoubleSide })));
}

/**
 * 投光器から降りる光の筋。
 *
 * ずっと「投光器が光っているだけで、光っていることになっていない」
 * と言われ続けてきたのがここ。器具の発光面を明るく描いても、
 * 光そのものは見えていない。水中では違う——水に濁りがあるから、
 * 光の通り道が横から見える。あの筋が無いと、照明はただの
 * 明るいシールになる。
 *
 * 円錐の側面を加算で描く。真ん中ほど水を長く貫くので、
 * 「法線が視線に垂直なところがいちばん厚い」= 1-|n・v| で出る。
 * 面を明るくするのではなく、体積の厚みを描いていることになる
 */
const SHAFT_FRAG = /* glsl */ `
  varying vec3 vW;
  varying vec3 vN;
  varying float vT;      // 0=器具 1=甲板
  void main() {
    vec3 v = normalize(cameraPosition - vW);
    // 円錐の「中を通る視線の長さ」を面から近似する。
    //
    // 錐の輪郭では面の法線が視線と直交する(n·v=0)が、そこは
    // 体積としてはいちばん薄い。逆に錐の真ん中では法線が
    // こちらを向き(n·v=1)、水をいちばん長く貫く。
    // 1-|n·v| と書くと輪郭だけが光り、三角形の枠に見える——
    // 実際そうなっていて、光の筋ではなく線画になっていた
    float thick = pow(abs(dot(normalize(vN), v)), 0.85);
    // 下へ行くほど広がって薄れる
    float fall = pow(1.0 - vT, 1.25);
    // 中の塵。筋は一様ではなく、粒の濃淡でゆらぐ
    float d = fbm(vec2(atan(vW.z, vW.x) * 7.0,
                       vW.y * 1.6 - mod(uTime, 900.0) * 0.05));
    float a = thick * fall * (0.62 + 0.55 * d) * 0.30;
    gl_FragColor = vec4(vec3(0.62, 0.76, 0.90) * a, a);
    ${UW_FRAG_OUTPUT}
  }
`;

const SHAFT_VERT = /* glsl */ `
  attribute float aT;
  varying vec3 vW;
  varying vec3 vN;
  varying float vT;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    vT = aT;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

function buildShafts(root) {
  const SEG = 18;
  const BASE_R = 2.45, TOP_R = 0.42;
  const pos = [], nrm = [], tt = [], idx = [];
  const bottom = DECK_Y + 0.02;
  const H = LAMP_Y - bottom;
  for (let k = 0; k < LAMP_N; k++) {
    const a = lampAngle(k);
    const cx = Math.cos(a) * LAMP_R, cz = Math.sin(a) * LAMP_R;
    const base = pos.length / 3;
    for (let j = 0; j <= SEG; j++) {
      const t = (j / SEG) * Math.PI * 2;
      const ct = Math.cos(t), st = Math.sin(t);
      // 側面の法線。円錐なので、半径方向に立てつつ母線ぶん傾ける
      const slope = (BASE_R - TOP_R) / H;
      const nl = 1 / Math.hypot(1, slope);
      for (const [r, y, u] of [[TOP_R, LAMP_Y - 0.06, 0], [BASE_R, bottom, 1]]) {
        pos.push(cx + ct * r, y, cz + st * r);
        nrm.push(ct * nl, slope * nl, st * nl);
        tt.push(u);
      }
    }
    for (let j = 0; j < SEG; j++) {
      const p = base + j * 2;
      idx.push(p, p + 1, p + 3, p, p + 3, p + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('aT', new THREE.BufferAttribute(new Float32Array(tt), 1));
  g.setIndex(idx);
  root.add(new THREE.Mesh(g, new THREE.ShaderMaterial({
    uniforms: baseUniforms(),
    vertexShader: SHAFT_VERT,
    fragmentShader: UW_FRAG_PRELUDE + SHAFT_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  })));
}

/**
 * 室内を漂う塵。
 *
 * 与圧殻の中も水で満たされている以上、外と同じように粒が漂う。
 * これが無いと、部屋の空間が「空気」に見えてしまう——
 * 水中にいるという前提そのものが伝わらない。
 * 投光器の真下にいる粒だけを明るくして、光の筋と噛み合わせる
 */
function buildMotes(root) {
  const N = 900;
  const pos = new Float32Array(N * 3);
  const seed = new Float32Array(N * 2);   // x:落ちる速さ y:明るさ
  for (let i = 0; i < N; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * (ROOM_R - 1.0);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    pos[i * 3] = x;
    pos[i * 3 + 1] = DECK_Y + 0.15 + Math.random() * (WALL_H + 1.2);
    pos[i * 3 + 2] = z;
    // いちばん近い投光器の軸までの距離で明るさを決める。
    // 毎フレーム測る必要はない——粒は縦にしか動かないので、
    // 軸までの水平距離は最初から変わらない
    let near = Infinity;
    for (let k = 0; k < LAMP_N; k++) {
      const la = lampAngle(k);
      near = Math.min(near, Math.hypot(x - Math.cos(la) * LAMP_R,
                                       z - Math.sin(la) * LAMP_R));
    }
    seed[i * 2] = 0.055 + Math.random() * 0.075;
    seed[i * 2 + 1] = 0.22 + 0.78 * Math.max(0, 1 - near / 2.6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 2));
  root.add(new THREE.Points(g, new THREE.ShaderMaterial({
    uniforms: { ...baseUniforms(), uRange: { value: WALL_H + 1.2 },
                uFloor: { value: DECK_Y + 0.15 } },
    vertexShader: /* glsl */ `
      attribute vec2 aSeed;
      uniform float uTime;
      uniform float uRange;
      uniform float uFloor;
      varying float vB;
      void main() {
        vec3 p = position;
        // 甲板に着いたら天井へ戻す。時間は必ず折り返す
        float fall = mod(uTime * aSeed.x + (p.y - uFloor), uRange);
        p.y = uFloor + fall;
        // 横のゆらぎ。まっすぐ落ちる粒は雨に見える
        p.x += sin(uTime * 0.21 + p.z * 1.7) * 0.06;
        p.z += cos(uTime * 0.17 + p.x * 1.9) * 0.06;
        vB = aSeed.y;
        vec4 mv = viewMatrix * modelMatrix * vec4(p, 1.0);
        gl_PointSize = 2.6 * (18.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vB;
      void main() {
        vec2 q = gl_PointCoord * 2.0 - 1.0;
        float d = 1.0 - dot(q, q);
        if (d <= 0.0) discard;
        float a = d * d * vB * 0.55;
        gl_FragColor = vec4(vec3(0.72, 0.82, 0.92) * a, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })));
}

/**
 * 配管とケーブルラック。
 *
 * 人が働いている場所には、必ず「後から通したもの」がある。
 * 設計図どおりの壁だけだと、模型の内装にしか見えない。
 * ハッチと舷窓の前は避けて、開口と開口のあいだを渡す
 */
function buildConduits(root, plu) {
  const M = new Buf();
  // 高さで開口を避ける。
  //
  // 最初は「開口の前だけ管を切る」ようにしたが、ハッチ5枚と舷窓5枚で
  // 塞いだ角度の合計が 6.4rad ——円周 6.28rad を超えていて、
  // 管は1本も残らなかった。実物の配管も、開口を縫って左右に
  // よけたりはしない。開口帯より上か下を、ぐるりと通す。
  //   ハッチの銘板の上端 9.28 / 舷窓の枠の上端 8.94 → 9.4 より上は素通し
  //   ハッチの枠の下端 4.29                        → 4.25 より下は素通し
  const SIDES = 6;
  const pipe = (y, rad, tube, col) => {
    const N = 200;
    let prev = null;
    for (let k = 0; k <= N; k++) {
      const a = (k / N) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const ring = [];
      for (let j = 0; j < SIDES; j++) {
        const t = (j / SIDES) * Math.PI * 2;
        // 断面は「壁の法線方向 (c,0,s)」と「上 (0,1,0)」で張る
        const rr = Math.cos(t) * tube, uu = Math.sin(t) * tube;
        ring.push(M.v(c * (rad + rr), y + uu, s * (rad + rr), col));
      }
      if (prev) {
        for (let j = 0; j < SIDES; j++) {
          const j2 = (j + 1) % SIDES;
          M.quad(prev[j], prev[j2], ring[j2], ring[j]);
        }
      }
      prev = ring;
    }
  };
  // 上の束。太い水管・細い配線・注意色の細管
  pipe(DECK_Y + 5.85, ROOM_R - 0.36, 0.145, RAIL);
  pipe(DECK_Y + 5.52, ROOM_R - 0.30, 0.090, PAINT2);
  pipe(DECK_Y + 5.34, ROOM_R - 0.34, 0.060, HAZARD);
  pipe(DECK_Y + 5.86, ROOM_R - 0.62, 0.075, PAINT2);
  // 甲板ぎわの一本
  pipe(DECK_Y + 0.15, ROOM_R - 0.30, 0.085, PAINT2);

  // 支持金具。一定間隔で壁へ留める
  for (let k = 0; k < 40; k++) {
    const a = (k / 40) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    const w = 0.085;
    const q = [];
    for (const [r, y] of [[ROOM_R - 0.72, DECK_Y + 5.24], [ROOM_R - 0.02, DECK_Y + 5.24],
                          [ROOM_R - 0.02, DECK_Y + 6.02], [ROOM_R - 0.72, DECK_Y + 6.02]]) {
      q.push([M.v(c * r - s * w, y, s * r + c * w, PAINT2),
              M.v(c * r + s * w, y, s * r - c * w, PAINT2)]);
    }
    for (let j = 0; j < 4; j++) {
      const j2 = (j + 1) % 4;
      M.quad(q[j][0], q[j2][0], q[j2][1], q[j][1]);
    }
  }
  const mesh = new THREE.Mesh(M.geo(), metalMaterial(plu, LIT_VERT, LIT_FRAG,
    { side: THREE.DoubleSide }));
  root.add(mesh);
  return mesh;
}

// ---------------------------------------------------------------- 舷窓
//
// 窓の外は、はじめ板に貼ったシェーダで描いていた。視線の向きで色を
// 決めていたので視差はついたが、そこにあるのは「水の色の関数」で、
// 海底も、施設が自分で照らしている光も、沈んでいるものも無かった。
// 「窓の外が適当」と言われて当然だった。
//
// いまは壁に本当の穴が開いていて(buildShell)、外には本物の海底と
// 投光器と光の筋が建っている(hubExterior.js)。ここに残るのは
// ガラスの映り込みだけ。素通しにすると「窓」ではなく「開いた穴」に
// 見えるので、室内の照明がうっすら乗るぶんだけを加算する。
const GLASS_FRAG = /* glsl */ `
  varying vec3 vW;
  varying vec2 vUv;
  void main() {
    // 角を丸めた四角に切る
    vec2 q = abs(vUv * 2.0 - 1.0);
    vec2 c = max(q - vec2(0.72, 0.66), 0.0);
    if (length(c / vec2(0.28, 0.34)) > 1.0) discard;

    vec3 rd = normalize(vW - cameraPosition);
    // 斜めから見るほど映り込みが強い(フレネル)。
    // 正面から覗いたときにいちばん透けるのが、ガラスらしさ
    float fres = pow(1.0 - abs(dot(rd, vec3(0.0, 0.0, 1.0))), 2.0);
    // 上のほうに天井の投光器が映る。板の上端ほど明るく
    float lamps = smoothstep(0.35, 1.0, vUv.y) * 0.55 + 0.12;
    // ガラスの歪み。分厚い耐圧窓は完全に平らではない
    float w = fbm(vec2(vUv.x * 5.0, vUv.y * 3.0)) * 0.5 + 0.5;
    float a = (0.030 + 0.075 * fres) * lamps * (0.65 + 0.7 * w);
    gl_FragColor = vec4(vec3(0.58, 0.70, 0.82) * a, a);
    ${UW_FRAG_OUTPUT}
  }
`;

/** 舷窓を1枚。ガラス面と、四方の枠 */
function buildWindow(root, angle, plu) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const grp = new THREE.Group();
  grp.position.set(c * (ROOM_R - WIN_INSET), WIN_Y, s * (ROOM_R - WIN_INSET));
  grp.rotation.y = -angle - Math.PI * 0.5;
  root.add(grp);

  // ガラス。外は本物の景色なので、ここは映り込みだけを乗せる薄い板。
  // 完全な素通しにすると「窓」ではなく「開いた穴」に見えてしまう
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(WIN_W, WIN_H),
    new THREE.ShaderMaterial({
      uniforms: baseUniforms(),
      vertexShader: PORTAL_VERT,
      fragmentShader: UW_FRAG_PRELUDE + GLASS_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
  glass.position.z = 0.01;
  grp.add(glass);

  // 枠。上下左右の4本と、中央の縦桟。
  // 深海の窓は一枚板ではなく、必ず分厚い枠と桟で押さえてある
  const M = new Buf();
  const bar = (x0, y0, x1, y1, d) => {
    const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    const f = pts.map(([x, y]) => M.v(x, y, d, PAINT));
    const b2 = pts.map(([x, y]) => M.v(x, y, -0.16, PAINT2));
    M.quad(f[0], f[1], f[2], f[3]);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      M.quad(b2[i], b2[j], f[j], f[i]);
    }
  };
  const hw = WIN_W / 2, hh = WIN_H / 2, th = 0.34;
  bar(-hw - th, hh, hw + th, hh + th, 0.22);         // 上
  bar(-hw - th, -hh - th, hw + th, -hh, 0.22);       // 下
  bar(-hw - th, -hh, -hw, hh, 0.22);                 // 左
  bar(hw, -hh, hw + th, hh, 0.22);                   // 右
  bar(-0.08, -hh, 0.08, hh, 0.07);                   // 中央の桟
  // 締結ボルト。耐圧窓は必ずボルトで押さえてある。
  // これが並んでいるだけで「圧力が掛かっている壁」に見える
  const nb = 9;
  for (let i = 0; i < nb; i++) {
    const x = -hw - th * 0.5 + (i / (nb - 1)) * (WIN_W + th);
    for (const y of [hh + th * 0.5, -hh - th * 0.5]) {
      bar(x - 0.055, y - 0.055, x + 0.055, y + 0.055, 0.28);
    }
  }
  for (let i = 1; i < 5; i++) {
    const y = -hh + (i / 5) * WIN_H;
    for (const x of [-hw - th * 0.5, hw + th * 0.5]) {
      bar(x - 0.055, y - 0.055, x + 0.055, y + 0.055, 0.28);
    }
  }
  grp.add(new THREE.Mesh(M.geo(), metalMaterial(plu, LIT_VERT, LIT_FRAG,
    { side: THREE.DoubleSide })));
  grp.userData.portal = true;   // 作り直しのときに一緒に消す
  return grp;
}

// ---------------------------------------------------------------- ポータル
//
// ハッチの中は「向こう側の水」。行き先ごとの水の色をそのまま出し、
// 波紋と集光模様を動かす。止まった絵にすると窓ではなく壁の模様になる。
const PORTAL_FRAG = /* glsl */ `
  uniform vec3 uTint;
  uniform float uGlow;
  // x:動きの速さ y:集光の強さ z:漂う粒 w:寄せ引き
  uniform vec4 uMood;
  varying vec2 vUv;
  varying vec3 vW;
  void main() {
    vec2 q = vUv * 2.0 - 1.0;
    float r = length(q);
    if (r > 1.0) discard;
    float t = uTime * uMood.x;

    // 寄せ引き。磯だけが数秒周期で明滅する。
    // 波打ち際は「一定の明るさで光っている場所」ではない
    float surge = 1.0 + uMood.w * 0.32 * sin(uTime * 0.55);

    // 奥へ吸い込まれていく同心の波紋。行き先の速さで進む
    float rip = sin(r * 16.0 - t * 1.9) * 0.5 + 0.5;

    // 向こう側の水面から差す集光。深海ではゼロ——
    // 光の届かない層に集光模様があってはいけない
    float ca = fbm(vec2(q.x * 2.2 + t * 0.16, q.y * 2.2 - t * 0.11)) * uMood.y;

    // 漂う粒。深海のマリンスノーはこれが主役になる。
    // 下へ向かってゆっくり流れる
    float mo = 0.0;
    if (uMood.z > 0.01) {
      // 時間は必ず折り返す。uTime をそのまま足すと、数分後には
      // 引数が大きくなりすぎて sin ハッシュの精度が飛び、
      // 粒がある領域と無い領域の境目に直線の継ぎ目が出る。
      // 接地影で踏んだのと同じ穴
      vec2 pq = vec2(q.x * 7.0, q.y * 7.0 + mod(uTime * 0.35, 48.0));
      float g = fbm(pq * 1.7);
      mo = smoothstep(0.72, 0.94, g) * uMood.z;
    }

    float core = pow(1.0 - r, 1.5);
    vec3 col = uTint * (0.35 + 1.15 * core + 0.30 * rip * (1.0 - r)
                        + 0.55 * ca * (1.0 - r * 0.7)) * surge;
    col += vec3(0.55, 0.62, 0.70) * mo * (1.0 - r * 0.5);
    // 縁は暗く落として、奥行きのある穴に見せる
    col *= mix(0.25, 1.0, smoothstep(1.0, 0.72, r));
    gl_FragColor = vec4(col * uGlow, 1.0);
    ${UW_FRAG_OUTPUT}
  }
`;

const PORTAL_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vW;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

/** 行き先の名前を書いた銘板。文字はキャンバスから焼く */
function plaqueTexture(name, sub) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#161b20';
  g.fillRect(0, 0, 512, 128);
  g.fillStyle = '#2a323a';
  g.fillRect(0, 0, 512, 6);
  g.fillRect(0, 122, 512, 6);
  g.fillStyle = '#dfe8ef';
  g.font = 'bold 54px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText(name, 256, 62);
  g.fillStyle = '#7d97ab';
  g.font = '22px system-ui, sans-serif';
  g.letterSpacing = '6px';
  g.fillText(sub, 256, 100);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * ハッチを1枚立てる。
 * 枠(金属)・中身(向こう側の水)・銘板 の3つでできている。
 */
function buildPortal(parent, def, angle, portals, plu) {
  const grp = new THREE.Group();
  const c = Math.cos(angle), s = Math.sin(angle);
  // 壁の内側にわずかに埋め込む
  grp.position.set(c * (ROOM_R - PORTAL_INSET), PORTAL_Y, s * (ROOM_R - PORTAL_INSET));
  // 部屋の中心を向かせる。+Z を向いた面を y 軸まわりに θ 回すと
  // 法線は (sinθ, 0, cosθ)。内向き (-cos a, 0, -sin a) にしたいので
  // θ = -a - π/2。ここを +π/2 にしていたら法線が外向きになり、
  // 円板も銘板も裏面カリングで消えて、枠のリングだけが残っていた
  grp.rotation.y = -angle - Math.PI * 0.5;
  parent.add(grp);

  // 中身。行き先の水の色で光る円板。
  //
  // 霧の色をそのまま使ってはいけない。5つの霧はどれも青系で、
  // 明るさを揃えた時点で見分けがつかなくなる(とくに深海は
  // #01070d で、正規化すると232倍しないと光らない)。
  // 行き先ごとに「その水を思い出せる色」を明示してもらう
  const tint = (def.env.portalTint || def.env.fogColor).clone();
  const md = def.env.portalMood || { speed: 1, caustic: 1, motes: 0, surge: 0 };
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...baseUniforms(),
      uTint: { value: tint },
      uGlow: { value: 1.0 },
      uMood: { value: new THREE.Vector4(md.speed, md.caustic, md.motes, md.surge) },
    },
    vertexShader: PORTAL_VERT,
    fragmentShader: UW_FRAG_PRELUDE + PORTAL_FRAG,
  });
  const disc = new THREE.Mesh(new THREE.PlaneGeometry(PORTAL_R * 2, PORTAL_R * 2), mat);
  disc.position.z = 0.02;
  grp.add(disc);
  // 当たり判定はこの円板で取る。見えているものを押させる
  disc.userData.zone = def.key;
  portals.push({ mesh: disc, mat, key: def.key, def, tint,
                 world: new THREE.Vector3(c * (ROOM_R - 0.6), PORTAL_Y, s * (ROOM_R - 0.6)),
                 // くぐる演出に要る。円板そのものの位置と、部屋の内側を向いた法線
                 center: new THREE.Vector3(c * (ROOM_R - PORTAL_INSET - 0.02), PORTAL_Y,
                                           s * (ROOM_R - PORTAL_INSET - 0.02)),
                 normal: new THREE.Vector3(-c, 0, -s) });

  // 枠。厚みのあるリング
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(PORTAL_R + 0.14, 0.17, 8, 40),
    metalMaterial(plu, LIT_VERT, LIT_FRAG));
  // TorusGeometry は頂点色を持たないので、色を1本ぶん足す
  const cnt = ring.geometry.attributes.position.count;
  const cols = new Float32Array(cnt * 3);
  for (let i = 0; i < cnt; i++) { cols[i * 3] = PAINT[0]; cols[i * 3 + 1] = PAINT[1]; cols[i * 3 + 2] = PAINT[2]; }
  ring.geometry.setAttribute('aCol', new THREE.BufferAttribute(cols, 3));
  grp.add(ring);

  // 銘板
  const pl = new THREE.Mesh(
    new THREE.PlaneGeometry(2.6, 0.65),
    new THREE.MeshBasicMaterial({ map: plaqueTexture(def.name, def.sub), toneMapped: false }));
  pl.position.set(0, PORTAL_R + 0.85, 0.06);
  grp.add(pl);
  return grp;
}

// タップ判定用。毎回作ると GC が走る
const _ray = new THREE.Raycaster();

// ================================================================ ゾーン定義
export const HUB = {
  key: 'hub',
  name: 'プロテウス',
  sub: 'PROTEUS STATION',
  icon: '🛰',
  terrain: hubFloor,
  env: {
    // 与圧殻の中。濁りはほとんどないが、水は水なので light は水中の式のまま
    fogColor: new THREE.Color('#0b151e'),
    fogDensity: 0.016,
    // 環境光は「投光器が届かないところの底上げ」でしかない。
    // ここを明るくすると部屋じゅうが同じ明るさになり、
    // 灰色の筒に戻る。落差は投光器に作らせる
    ambTop: new THREE.Color('#2a3a48'),
    ambBottom: new THREE.Color('#0c1219'),
    // 天井の投光器を「上からの光」として使う。太陽ではない
    sunColor: new THREE.Color('#7d95a8'),
    sunDir: new THREE.Vector3(0.12, 0.97, 0.20).normalize(),
    exposure: 1.05,
    swell: 0.0,
  },
  // 甲板の上に立つ。ムーンプールを正面に見て、ハッチが視界に入る位置
  // 部屋のまんなかに立つ。ハッチは円周に等間隔で並んでいるので、
  // 見回して選ぶ。どっちに何があるかは、各ハッチが床と壁に落とす
  // 色の光が教える——選択肢が視野の外にあっても、光は回りこむ
  camera: {
    pos: new THREE.Vector3(0, DECK_Y + 1.85, 0),
    look: new THREE.Vector3(0, PORTAL_Y - 0.55, -ROOM_R),
  },
  clearance: 1.5,
  // 48m 先の観測棟まで行ける広さ。既定の 42 だと 6m 手前で止まる
  range: 60,
  // ここに生き物はいないので、餌やりのボタンは出さない。
  // 押せるのに何も起きないボタンは、壊れているのと区別がつかない
  feed: false,
  tap: 'ハッチをタップすると、その水槽へ行けます',
  species: [],

  build(root) {
    // ポータルの光は部屋じゅうの金属を照らす。ユニフォームは
    // value のオブジェクトごと共有する——材質ごとに持つと、
    // 更新のたびに全部へ書き写すことになる
    const plu = portalLightUniforms();
    // 殻はハッチの位置が決まってから作る(リブを避けるため)
    let shell = null;
    let outside = null;
    buildDome(root, plu);
    buildLock(root, plu);
    buildLamps(root, plu);
    buildShafts(root);
    buildMotes(root);

    const portals = [];
    const world = new CollisionWorld();
    // 壁。押し出し用の当たり判定を殻の外側に並べる。
    // 床のクランプだけで囲うと、壁に近づいたカメラが持ち上げられて
    // 殻を乗り越えてしまう
    const _b = new THREE.Vector3();
    for (let k = 0; k < 20; k++) {
      const a = (k / 20) * Math.PI * 2;
      // 潜水士用の出口の前だけは空ける。ここを塞ぐと、扉を開けた意味が
      // 無くなるどころか、外に出る手段がひとつも無くなる
      const d = Math.abs(((a - LOCK_A + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (d < 0.30) continue;
      world.addStatic(_b.set(Math.cos(a) * (ROOM_R + 2.2), DECK_Y + WALL_H * 0.5,
                             Math.sin(a) * (ROOM_R + 2.2)), 2.6, WALL_H, 2.6);
    }
    // 天蓋に蓋をする。
    //
    // これまでガラスの天井には当たり判定が無く、上へ泳げばそのまま
    // 突き抜けて外へ出られた。耐圧ガラスを素通りするのは嘘なので塞ぐ
    // ——ただし塞ぐ前に、扉から出られることを実際に泳いで確かめてある。
    //
    // ドーム自体が楕円体(半径13、高さ3.4)なので、そのまま1個の当たり
    // 判定にすると下半分が部屋の中へ張り出す。曲面に沿って小さな球を
    // 並べて、面だけを塞ぐ
    for (const [t, n] of [[0.12, 30], [0.40, 26], [0.68, 18], [0.90, 8]]) {
      const u = t * Math.PI * 0.5;
      const rr = ROOM_R * Math.cos(u);
      const yy = DECK_Y + WALL_H + DOME_H * Math.sin(u);
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + t;
        world.addStatic(_b.set(Math.cos(a) * rr, yy + 1.15, Math.sin(a) * rr), 1.7, 1.5, 1.7);
      }
    }
    world.addStatic(_b.set(0, DOME_TOP + 1.1, 0), 2.0, 1.5, 2.0);

    return {
      world,
      portals,
      // 行き先をあとから差してもらう。zones の一覧は main が持っている
      setDestinations(defs) {
        for (const g of [...root.children]) if (g.userData.portal) root.remove(g);
        if (shell) { root.remove(shell); shell.geometry.dispose(); }
        portals.length = 0;
        // 円周に等間隔。部屋の中心に立つなら、扉は壁一面に並べるより
        // ぐるりと囲うほうが素直で、増えても円が埋まるだけで済む
        const angles = defs.map((_, i) =>
          -Math.PI * 0.5 + (i / defs.length) * Math.PI * 2);
        // 舷窓はハッチとハッチのちょうど真ん中。ハッチが増えれば
        // 窓も一緒に増えて、間隔は勝手に保たれる
        // 舷窓。ただし潜水士用の出口と重なるものは開けられないので外す。
        // 扉は動かない建物の一部で、窓のほうが譲る
        const wins = angles.map((a) => a + Math.PI / defs.length).filter((a) => {
          const d = Math.abs(((a - LOCK_A + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
          return d > LOCK_ARC + WIN_ARC;
        });
        const openings = [...angles.map((a) => [a, PORTAL_ARC]),
                          ...wins.map((a) => [a, WIN_ARC])];
        // 甲板の標示だけは、この殻のシェーダに焼き込む。
        // ほかの金物(配管・枠・器具)は標示を持たない
        shell = new THREE.Mesh(buildShell(openings, wins),
          metalMaterial(plu, LIT_VERT, litFrag(deckMarkGLSL(angles)),
                        { side: THREE.DoubleSide }));
        root.add(shell);
        defs.forEach((def, i) => {
          const g = buildPortal(root, def, angles[i], portals, plu);
          g.userData.portal = true;
        });
        for (const wa of wins) buildWindow(root, wa, plu);
        const cd = buildConduits(root, plu);
        cd.userData.portal = true;
        // 外の海。舷窓の位置が決まってから建てる——
        // 投光器は窓のそばに付いていないと、見ている先が暗いままになる
        outside = buildExterior(root, wins, ROOM_R, DECK_Y, DOME_TOP, world);
      },
      followTargets: {},
      species: [],
      onTap(ray) {
        // 見えている円板をそのまま撃つ。当たったらその行き先を返す——
        // main 側がゾーン切替として解釈する。
        // 「押せるもの」と「見えているもの」を別々に持たないこと
        _ray.ray.copy(ray);
        let best = null, bd = Infinity;
        for (const p of portals) {
          const r = _ray.intersectObject(p.mesh, false);
          if (r.length && r[0].distance < bd) { bd = r[0].distance; best = p.key; }
        }
        return best;
      },
      update(dt, camera) {
        outside?.update(dt, U.uTime.value);
        // 近づいたハッチが明るくなる。どれが「いま入れるもの」かを
        // 光の強さで示す。文字より先に光のほうが目に入る
        plu.uPortalN.value = portals.length;
        for (let i = 0; i < portals.length; i++) {
          const p = portals[i];
          const d = camera.position.distanceTo(p.world);
          const want = 1.0 + 0.85 * Math.max(0, 1 - d / 6.0);
          const g = p.mat.uniforms.uGlow;
          g.value += (want - g.value) * Math.min(dt * 3.0, 1);
          // 部屋を染める光。ハッチの少し手前に置く——壁と同じ面に
          // 置くと、その壁自身がまったく照らされない
          plu.uPortalPos.value[i].copy(p.world);
          plu.uPortalCol.value[i].copy(p.tint);
          plu.uPortalGlow.value[i] = g.value;
        }
      },
    };
  },
};
