import * as THREE from 'three';
import { baseUniforms, U } from '../env.js';
import { UW_FRAG_PRELUDE, UW_FRAG_OUTPUT } from '../glsl.js';
import { CollisionWorld } from '../collision.js';
import { buildExterior } from './hubExterior.js';

// ============ ポータルエリア(海中研究施設) ============
//
// 水槽が増えるほど、下のタブは横に伸びていく。5つで既に画面から
// はみ出していた。タブは「数が増えても壊れない」形をしていない。
//
// かわりに、行き先そのものを場所にする。海中の研究施設に降り立ち、
// 壁に並んだハッチをくぐって各エリアへ行く。増えるときは
// ハッチが1つ増えるだけで、UIは何も伸びない。
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
// マナ・ワンという場所が成立しているのは、巨大な窓の向こうに
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

// 天井の投光器。位置は照明にも光の筋にも塵の明るさにも使う
const LAMP_N = 8;
const LAMP_Y = DECK_Y + WALL_H + 0.55;
const LAMP_R = ROOM_R * 0.66;
const lampAngle = (k) => (k / LAMP_N) * Math.PI * 2 + Math.PI / LAMP_N;

/** 施設の床。甲板は継ぎ目のない一枚 */
export function hubFloor() {
  return DECK_Y;
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

const LIT_FRAG = PORTAL_LIGHT + SURFACE + LAMP_LIGHT + /* glsl */ `
  varying vec3 vCol;
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vec3 n = gl_FrontFacing ? normalize(vN) : -normalize(vN);
    vec3 viewDir = normalize(cameraPosition - vW);
    vec3 alb = grime(vW, n, vCol);
    // 塗装した鋼。つや消しだが、濡れているので弱いハイライトが乗る
    vec3 col = underwaterLight(alb, n, vW, viewDir, 22.0, 0.10);
    col += alb * lampLight(vW, n);
    col += alb * portalLight(vW, n) * 1.7;
    gl_FragColor = vec4(applyUnderwaterFog(col, vW), 1.0);
    ${UW_FRAG_OUTPUT}
  }
`;

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
function buildShell(openings = [], hatches = [], windows = []) {
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
  for (let k = 0; k < N; k++) M.tri(hub0, grid[0][k], grid[0][(k + 1) % N]);
  for (let i = 0; i < RINGS - 1; i++) {
    for (let k = 0; k < N; k++) {
      const k2 = (k + 1) % N;
      M.quad(grid[i][k], grid[i][k2], grid[i + 1][k2], grid[i + 1][k]);
    }
  }
  // 中心の標識。「ここが立ち位置」であることを床が言う。
  // 何もない床の真ん中に立たされると、部屋のどこにいるのか分からない
  for (const [r0, r1, col] of [[1.55, 1.75, HAZARD], [1.20, 1.30, PAINT2]]) {
    const a0 = [], a1 = [];
    for (let k = 0; k < N; k++) {
      const a = ang(k);
      a0.push(M.v(Math.cos(a) * r0, DECK_Y + 0.004, Math.sin(a) * r0, col));
      a1.push(M.v(Math.cos(a) * r1, DECK_Y + 0.004, Math.sin(a) * r1, col));
    }
    for (let k = 0; k < N; k++) {
      const k2 = (k + 1) % N;
      M.quad(a0[k], a0[k2], a1[k2], a1[k]);
    }
  }
  // 中心の輪から各ハッチへ伸びる通路帯。
  //
  // 有人施設の床には、必ず「どこを歩くか」が引いてある。
  // それが人の働く場所であることのいちばん安い証拠になるし、
  // ここでは行き先そのものを指す線としても働く——
  // 見回さなくても、足もとの線がハッチの方角を教える
  for (const a of hatches) {
    const c = Math.cos(a), s = Math.sin(a);
    const px = -s, pz = c;              // 帯の幅の向き
    const y = DECK_Y + 0.005;
    for (const [off, hw, col] of [[0, 0.62, PAINT2], [0.62, 0.09, HAZARD],
                                  [-0.71, 0.09, HAZARD]]) {
      const q = [];
      for (const [r, w] of [[1.80, off - hw], [ROOM_R - 0.9, off - hw],
                            [ROOM_R - 0.9, off + hw], [1.80, off + hw]]) {
        q.push(M.v(c * r + px * w, y, s * r + pz * w, col));
      }
      M.quad(q[0], q[1], q[2], q[3]);
    }
  }

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
  for (let i = 0; i < WROWS; i++) {
    const rowInHole = (i >= R0 && i < R1);
    for (let k = 0; k < N; k++) {
      if (rowInHole && inHole(ang(k) + Math.PI / N) !== null) continue;
      const k2 = (k + 1) % N;
      M.quad(wall[i][k2], wall[i][k], wall[i + 1][k], wall[i + 1][k2]);
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

  // ---- 天井 ----
  // 浅いドーム。放射状のリブが中心の要へ集まる
  const CROWS = 5;
  const domeH = 3.4;
  const dome = [];
  for (let i = 0; i <= CROWS; i++) {
    const t = i / CROWS;
    const r = ROOM_R * Math.cos(t * Math.PI * 0.5);
    const y = DECK_Y + WALL_H + domeH * Math.sin(t * Math.PI * 0.5);
    const row = [];
    for (let k = 0; k < N; k++) {
      const a = ang(k);
      // 天井のリブは8本。放射状なので、外周では広く、頂点では詰まる
      const rib = Math.abs(((a / (Math.PI * 2)) * 8) % 1 - 0.5) > 0.36;
      row.push(M.v(Math.cos(a) * r, y - (rib ? 0.16 : 0), Math.sin(a) * r,
                   rib ? PAINT : PAINT2));
    }
    dome.push(row);
  }
  for (let i = 0; i < CROWS - 1; i++) {
    for (let k = 0; k < N; k++) {
      const k2 = (k + 1) % N;
      M.quad(dome[i][k2], dome[i][k], dome[i + 1][k], dome[i + 1][k2]);
    }
  }
  const apex = M.v(0, DECK_Y + WALL_H + domeH, 0, PAINT);
  for (let k = 0; k < N; k++) {
    M.tri(dome[CROWS - 1][(k + 1) % N], dome[CROWS - 1][k], apex);
  }
  return M.geo();
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
  name: 'マナ・ワン',
  sub: 'MANA ONE STATION',
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
      world.addStatic(_b.set(Math.cos(a) * (ROOM_R + 2.2), DECK_Y + WALL_H * 0.5,
                             Math.sin(a) * (ROOM_R + 2.2)), 2.6, WALL_H, 2.6);
    }

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
        const wins = angles.map((a) => a + Math.PI / defs.length);
        const openings = [...angles.map((a) => [a, PORTAL_ARC]),
                          ...wins.map((a) => [a, WIN_ARC])];
        shell = new THREE.Mesh(buildShell(openings, angles, wins),
          metalMaterial(plu, LIT_VERT, LIT_FRAG, { side: THREE.DoubleSide }));
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
        outside = buildExterior(root, wins, ROOM_R, DECK_Y);
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
        outside?.update(U.uTime.value);
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
