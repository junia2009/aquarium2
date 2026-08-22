import * as THREE from 'three';
import { baseUniforms, U } from '../env.js';
import { UW_FRAG_PRELUDE, UW_FRAG_OUTPUT } from '../glsl.js';
import { FISH_SHAPES } from '../creatures/fishGeometry.js';
import { createFishMaterial } from '../creatures/fishMaterial.js';
import { School, makeSchoolInstanceAttr } from '../creatures/school.js';
import { buildNautilus } from './nautilus.js';
import { Megalodon } from '../creatures/megalodon.js';

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
    ${downGLSL()}
    vec3 floodLight(vec3 wp, vec3 n) {
      vec3 s = downField(wp, n);
      ${body}
      // 施設の灯りはまとめて絞れる。ここ1か所に掛けておけば、
      // 殻も海底も観測所もノーチラスも魚も、同じ倍率で暗くなる
      s *= uStationI;
      // ソナーの波面。半径 uPing.w の球殻が通り過ぎた面だけが光る。
      //
      // つまみと別系統にしたいので、uStationI を掛けたあとに足す——
      // 区域照明を落として真っ暗にしたときこそ、ソナーがいちばん
      // 分かりやすい。「見えないから音で探る」がそのまま絵になる
      if (uPingI > 0.001) {
        vec3 pd = wp - uPing.xyz;
        float dist = length(pd);
        // 殻の厚み 4.2m。薄くすると波面が線になって、
        // 起伏の急なところで途切れる
        float shell = exp(-pow((dist - uPing.w) / 4.2, 2.0));
        // 波面のほうを向いている面ほど強く返る——のだが、下限を
        // 低く取ってはいけない。海底はほぼ真上を向いていて、発信点も
        // 海底の近くにあるので、内積はどこでもほぼ 0 になる。
        // 0.30 を下限にしていたら**海底が光らず**、輪が見えなかった
        // (実測 1.15 倍。目では気づけない)
        float face = 0.55 + 0.45 * max(dot(n, -pd / max(dist, 1e-4)), 0.0);
        // 距離の減衰はごく浅く。灯りの届かない外縁まで届くのが
        // ソナーの見せ場なので、そこで消えてしまっては意味がない
        s += vec3(0.42, 1.30, 1.55) * (shell * face * uPingI * exp(-dist * 0.006));
      }
      return s;
    }
  `;
}

// ============ 区域照明(ダウンライト) ============
//
// 施設の周りだけでなく、水域そのものを照らす。
//
// ここは光源を1基ずつ並べてはいけないところ。floodGLSL は光源を
// すべてシェーダに展開するので、40基足せば断片あたりの計算が
// 倍以上になる。海底・殻・観測所・ノーチラス、全部の材質に乗る。
//
// なので**格子に並べて、近傍9セルだけ評価する**。灯具の位置は
// 格子の式から出るので、シェーダは自分の足もとのセル番号を計算して
// 周り 3x3 を見ればいい。何十基置いても定数コストになる。
// 桁 21m に対して灯具は 9m の高さなので、隣の隣のセル(42m 先)は
// 配光の外——3x3 で足りることは幾何で決まっている。
//
// 灯具の位置と「そのセルに立てるか」の判定は、JS 側の柱の生成と
// **同じ式**を使う。別々に書くと、光っているのに柱が無い場所や、
// 柱があるのに暗い場所ができる
export const DOWNLIGHT = {
  pitch: 21.0,      // 桁の間隔
  head: 9.2,        // 海底から灯具まで
  inner: 22.0,      // これより内側は本体の投光器の受け持ち
  outer: 98.0,      // ここまで並べる
  fade: 60.0,       // ここから外は落としていく。端で切ると壁になる
  spread: 0.60,     // 配光の広がり
  col: [3.15, 3.35, 3.55],   // わずかに冷たい白。作業灯の色
};

/** そのセルに灯具を立てるか。柱の生成とシェーダで同じ判定を使う */
export function downCellOk(x, z) {
  const r = Math.hypot(x, z);
  if (r < DOWNLIGHT.inner || r > DOWNLIGHT.outer) return false;
  // 建物の中に柱が生えないよう、2か所だけ避ける
  if (Math.hypot(x - ANNEX.x, z - ANNEX.z) < 13.0) return false;
  if (Math.hypot(x - NAUTILUS.x, z - NAUTILUS.z) < 21.0) return false;
  return true;
}

/** 灯具の高さ。うねりは入れない——9m 上の灯りに ±1m の差は出ない */
export function downLampY(x, z) {
  return FLOOR_Y + riseAt(Math.hypot(x, z)) + DOWNLIGHT.head;
}

function downGLSL() {
  const D = DOWNLIGHT;
  const f = (v) => v.toFixed(3);
  const v3 = (a) => `vec3(${a.map((x) => x.toFixed(3)).join(',')})`;
  return /* glsl */ `
    // 灯具の高さ。JS の downLampY と同じ式
    float downLampY(vec2 c) {
      float t = clamp((length(c) - 22.0) / 56.0, 0.0, 1.0);
      return ${f(FLOOR_Y)} + t * t * (3.0 - 2.0 * t) * 8.5 + ${f(D.head)};
    }
    // そのセルに灯具があるか。JS の downCellOk と同じ判定
    float downCellOk(vec2 c) {
      float r = length(c);
      if (r < ${f(D.inner)} || r > ${f(D.outer)}) return 0.0;
      if (distance(c, vec2(${f(ANNEX.x)}, ${f(ANNEX.z)})) < 13.0) return 0.0;
      if (distance(c, vec2(${f(NAUTILUS.x)}, ${f(NAUTILUS.z)})) < 21.0) return 0.0;
      // 外へ向かって細る。端でぷつりと切ると、そこに明るさの壁が立つ
      return 1.0 - smoothstep(${f(D.fade)}, ${f(D.outer)}, r);
    }
    vec3 downField(vec3 wp, vec3 n) {
      vec2 g = floor(wp.xz / ${f(D.pitch)} + 0.5);
      vec3 s = vec3(0.0);
      for (int i = -1; i <= 1; i++) {
        for (int j = -1; j <= 1; j++) {
          vec2 c = (g + vec2(float(i), float(j))) * ${f(D.pitch)};
          float k = downCellOk(c);
          if (k <= 0.0) continue;
          s += flood1(wp, n, vec3(c.x, downLampY(c), c.y),
                      vec3(0.0, -1.0, 0.0), ${v3(D.col)} * k, ${f(D.spread)});
        }
      }
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
    float a = thick * fall * (0.55 + 0.60 * d) * 0.30 * uStationI;
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
// ============ 観測所 ============
//
// 3層の吹き抜けを持つガラスの塔。直径 17m、軒まで 10.5m。
//
// 大きくするときに気をつけたのは1点だけ。**「大きい建物」と
// 「小屋を拡大したもの」は別物**だということ。ひとつ前は
// 高さ 6.5m の部屋が1つあるだけで、中に寸法の手がかりが無かった。
// あれをそのまま引き伸ばしても、大きくは見えず縮尺が壊れるだけ。
//
// 大きく見せているのは、階を積んだこと自体ではなく、
// **各階が人の高さで揃っていること**:
//   ・階高 3.5m を3つ。床の帯が外から3本の水平線として見える
//   ・回廊の手すりは腰の高さ(1.05m)
//   ・戸口 2.30m、弧長 2.2m
// この3つが目に入るから、17m が 17m として読める。
export const ANNEX = {
  a: -Math.PI * 0.5 + Math.PI / 5 + 0.30,   // 施設から見た方角(固定)
  dist: 48,                                  // 中心までの距離
  radius: 8.5,                               // 外半径
  storey: 3.5,                               // 階高。人が立つ寸法から
  levels: 3,                                 // 階数
  wallTh: 0.35,                              // 壁・スラブの厚み
  gallery: 2.1,                              // 2階以上の回廊の幅
  // ガラスの下端(1階だけ)。目の高さ(床+1.5m)より下に来ないと、
  // 立ったときに鋼の壁しか見えない
  sill: 1.15,
  door: 2.30,                                // 出入口の高さ
  // 出入口の半角(ラジアン)。弧長 2.2m を保つ——
  // 潜水具を着けた人がすれ違える幅。半径が変わっても弧長は変えない
  doorArc: 2.2 / (2 * 8.5),
  // 出入口の向き。連絡通路の取付点から何ラジアンずらすか。
  //
  // 下限は通路の太さで決まる。半径 1.3m の管は半径 8.5m の壁の上で
  // asin(1.3/8.5)=0.154rad を占めるので、戸口の手前の縁
  // (doorOff - doorArc)がそれを超えていないと管が戸口を塞ぐ
  doorOff: 0.40,
};
ANNEX.x = Math.cos(ANNEX.a) * ANNEX.dist;
ANNEX.z = Math.sin(ANNEX.a) * ANNEX.dist;
// 軒までの高さ。外の投光器や標識灯もここから引く
ANNEX.wall = ANNEX.storey * ANNEX.levels + 0.55;

export function riseAt(r) {
  const t = Math.min(Math.max((r - 22) / 56, 0), 1);
  return t * t * (3 - 2 * t) * 8.5;
}

// 海底の起伏。海底そのものを作るのと、その上に物を据えるのとで
// 同じ式を使わないと、置いたものが地面に埋まるか浮くかする。
// 頂点ごとに乱数を引かず決まった関数から出すのも同じ理由で、
// そうしないと作り直すたびに地形だけが動く
export function reliefAt(x, z) {
  return Math.sin(x * 0.055 + Math.cos(z * 0.041) * 2.1) * 0.62
    + Math.sin(z * 0.083 - 1.3) * 0.34
    + Math.sin((x + z) * 0.17) * 0.11
    + riseAt(Math.hypot(x, z));
}

// 観測棟の据わっている高さと、中の床。riseAt に依るのでここで確定する
ANNEX.base = FLOOR_Y + riseAt(ANNEX.dist) + 0.4;
ANNEX.floor = ANNEX.base + 0.55;
ANNEX.inner = ANNEX.radius - ANNEX.wallTh;
// 吹き抜けの半径。2階以上は回廊だけを回し、真ん中は3層ぶん抜く。
// 抜けているから、入って見上げたときに階数が数えられる
ANNEX.voidR = ANNEX.inner - ANNEX.gallery;

// ============ ノーチラス号の停泊位置 ============
//
// 観測棟と同じで、固定値で持つ。舷窓の角度から導くと、行き先が
// 1つ増えただけで船が動いてしまう。
//
// 置き方に条件が3つある。
//   ・全長 30m の船を横から見せたい。真正面や真後ろから見ると
//     ただの円になって、ノーチラスの輪郭が何も伝わらない
//   ・かといって完全な真横だと図面のようになるので、
//     舳先をわずかにこちらへ振る(+0.18rad)
//   ・海底の起伏に据える。riseAt だけで高さを決めると、
//     うねりの谷では浮き、山では埋まる
export const NAUTILUS = {
  a: -1.95,          // 施設から見た方角
  dist: 34,          // 中心までの距離。近すぎると窓を塞ぎ、遠いと霧に溶ける
  pitch: 0.022,      // 泥に沈んだぶんの傾き
  roll: 0.045,
  clear: 3.64,       // 船の中心から橇の下端まで
};
NAUTILUS.x = Math.cos(NAUTILUS.a) * NAUTILUS.dist;
NAUTILUS.z = Math.sin(NAUTILUS.a) * NAUTILUS.dist;
// 船体ローカルの +Z(舳先)が向く方位。接線方向 = -a で、そこから少し振る
NAUTILUS.heading = -NAUTILUS.a + 0.18;
// 据わる高さ。橇の前後の端でも海底を割らないよう、
// 船に沿って3点を見て、いちばん高い地面に合わせる
{
  const sh = Math.sin(NAUTILUS.heading), ch = Math.cos(NAUTILUS.heading);
  let g = -1e9;
  for (const t of [-7.6, 0, 7.6]) {
    g = Math.max(g, reliefAt(NAUTILUS.x + sh * t, NAUTILUS.z + ch * t));
  }
  NAUTILUS.y = FLOOR_Y + g + NAUTILUS.clear;
}

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
  uniform float uStationI;   // 頂点シェーダには共通の前置きが付かない。自分で宣言する
  attribute vec3 aCol;
  attribute vec2 aBlink;
  varying vec3 vC;
  ${BLINK_GLSL}
  void main() {
    vC = aCol * blink(aBlink.x, aBlink.y) * uStationI;
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
  uniform float uStationI;
  attribute vec3 aCol;
  attribute vec3 aBlink;
  varying vec3 vC;
  varying float vD;
  ${BLINK_GLSL}
  void main() {
    vC = aCol * blink(aBlink.x, aBlink.y) * uStationI;
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
  // 3層の吹き抜けになったので、階ごとに要る。天井に1組だけだと
  // 1階まで届かず、入ったところが真っ暗になる
  const ROOM = [0.44, 0.46, 0.49];
  for (let L = 0; L < ANNEX.levels; L++) {
    const yc = ANNEX.floor + ANNEX.storey * (L + 1) - 0.5;
    const rr = L === 0 ? 3.2 : (ANNEX.voidR + ANNEX.inner) * 0.5;
    for (let i = 0; i < 3; i++) {
      const a = ANNEX.a + (i / 3) * Math.PI * 2 + L * 0.6;
      lights.push({
        p: [ANNEX.x + Math.cos(a) * rr, yc, ANNEX.z + Math.sin(a) * rr],
        d: [0, -1, 0], c: ROOM, k: 1.0,
      });
    }
  }
  // 観測棟の外灯。
  //
  // 本体の投光器は舷窓の下を照らす向きに絞ってあるので、48m 先の
  // 観測棟には届かない。棟のまわりだけ真っ暗で、玄関も踏み段も
  // 形が読めていなかった。軒下に3基まわし、うち1基は戸口の真上に置く
  const ANX_FIX = [];
  {
    const dA = ANNEX.a + Math.PI + ANNEX.doorOff;
    for (let i = 0; i < 5; i++) {
      const a = dA + (i - 2) * 1.26;
      const px = ANNEX.x + Math.cos(a) * (ANNEX.radius + 0.30);
      const pz = ANNEX.z + Math.sin(a) * (ANNEX.radius + 0.30);
      const py = ANNEX.base + ANNEX.wall - 0.28;
      const d = new THREE.Vector3(Math.cos(a) * 0.64, -0.77, Math.sin(a) * 0.64).normalize();
      ANX_FIX.push({ px, py, pz, d });
      lights.push({ p: [px, py, pz], d: [d.x, d.y, d.z], c: [3.9, 3.7, 3.4], k: 0.56 });
    }
  }

  // 停泊中のノーチラス号を照らす投光器。
  //
  // 施設本体の投光器は舷窓の真下を照らす向きに絞ってあるので、
  // 34m 先までは届かない。届かせようと本体側の配光を広げると、
  // 今度は手前の海底が白く飛ぶ。停泊地には停泊地の灯りを立てるのが
  // 実際の作りでもあり、絵としても正しい——照らす対象が決まっている
  // 光は、その対象を「見せるために置かれたもの」に見せる。
  //
  // 船の脇に2基。片側からだけ当てると、反対の舷が真っ黒に落ちて
  // 船体の丸みが消える
  const DOCK = [];
  {
    const sh = Math.sin(NAUTILUS.heading), ch = Math.cos(NAUTILUS.heading);
    // 施設の側へ寄せる向き(船の中心から原点へ向かう単位ベクトル)
    const ix = -NAUTILUS.x / NAUTILUS.dist, iz = -NAUTILUS.z / NAUTILUS.dist;
    //
    // 支柱の立てる位置は、明るさと同じくらい効く。はじめ船の真横
    // (前後 ±8.5m)に立てたら、部屋の窓から船を見たとき**支柱が船体を
    // 縦に横切って**いた。前景の細い棒は、後ろにある大きなものより
    // 目を引く。舳先と艫の外へ逃がすと、視線を遮らないまま端まで届く
    for (const t of [-14.0, 14.0]) {
      // 船に沿って前後にずらし、そこから施設側へ 7m 離す
      const bx = NAUTILUS.x + sh * t + ix * 7.0;
      const bz = NAUTILUS.z + ch * t + iz * 7.0;
      const by = FLOOR_Y + reliefAt(bx, bz);
      const hy = by + 7.2;                            // 灯具の高さ
      // 狙いは自分の側の船体。両端から挟むように当てると、
      // 舳先も艫も暗く落ちない——円錐に見えていたのは、
      // 舳先に光がまったく届いていなかったせいでもある
      const tx = NAUTILUS.x + sh * t * 0.35, tz = NAUTILUS.z + ch * t * 0.35;
      const d = new THREE.Vector3(tx - bx, NAUTILUS.y - 0.4 - hy, tz - bz).normalize();
      DOCK.push({ bx, by, bz, hy, d });
      // 明るさは控えめに。はじめ本体の投光器と同じ 8 台強で当てたら、
      // 船体が真っ白に飛んで**紙で作った模型**になった。
      // 暗い海に浮かぶ塊として読めるのは、面の大半が沈んでいて、
      // 光が当たった一部だけが鈍く返しているとき
      lights.push({ p: [bx, hy, bz], d: [d.x, d.y, d.z], c: [3.4, 2.70, 2.00], k: 0.48 });
    }
    // 海底からの地明かり。
    //
    // 銅は暖色の下でしか銅に見えない。白い投光器を上から当てるだけだと
    // 赤銅色が灰色に寄って、せっかくの材質が伝わらない。
    // それに、下から焚いた光は上からの光では出ない陰影を作る——
    // 建物のライトアップで下から照らすのは、そのほうが立体が起きるから
    const UP = [3.7, 1.42, 0.48];
    for (const t of [-9.0, -3.0, 3.0, 9.0]) {
      for (const side of [1, -1]) {
        const ux = -NAUTILUS.x / NAUTILUS.dist, uz = -NAUTILUS.z / NAUTILUS.dist;
        // 船の軸から左右へ 4.6m。手前(施設側)は明るく、奥は控えめに
        const px = NAUTILUS.x + sh * t + ux * side * 5.8;
        const pz = NAUTILUS.z + ch * t + uz * side * 5.8;
        const py = FLOOR_Y + reliefAt(px, pz) + 0.30;
        const d = new THREE.Vector3(-ux * side * 0.42, 1.0, -uz * side * 0.42).normalize();
        DOCK.push({ up: true, bx: px, by: py, bz: pz, hy: py, d });
        lights.push({
          p: [px, py, pz], d: [d.x, d.y, d.z],
          c: side > 0 ? UP : UP.map((v) => v * 0.40), k: 0.62,
        });
      }
    }
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
  const relief = reliefAt;
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
  // 観測棟の外灯の器具。光る点だけだと暗闇に浮いた玉になる
  for (const f of ANX_FIX) {
    strut(S, [f.px, f.py, f.pz],
          [f.px + f.d.x * 0.42, f.py + f.d.y * 0.42, f.pz + f.d.z * 0.42], 0.26, STEEL);
    neon.add([f.px + f.d.x * 0.55, f.py + f.d.y * 0.55, f.pz + f.d.z * 0.55],
             [4.2, 4.1, 3.8], 0.12, 0);
  }

  // ---- ノーチラス号 ----
  //
  // 停泊している船を1隻置くと、施設の意味が変わる。建物だけなら
  // 「そこにある構造物」だが、船が横付けされていれば「人が出入りして
  // いる場所」になる。しかも船は大きさの分かるものなので、
  // 施設の規模もこれで初めて読める
  //
  // 船体は施設の外殻とは別の材質で描く。鉄板の割付と鋲は船の
  // ローカル座標が要るので、共用のシェーダには載せられない
  {
    const N = new Buf();
    const naut = buildNautilus(N, neon, world, {
      origin: [NAUTILUS.x, NAUTILUS.y, NAUTILUS.z],
      heading: NAUTILUS.heading,
      pitch: NAUTILUS.pitch,
      roll: NAUTILUS.roll,
      strut,
    });
    group.add(new THREE.Mesh(N.geo(), mat(naut.frag, { side: THREE.DoubleSide })));
  }
  // 停泊地の投光器。灯具だけ光らせても支柱が無いと宙に浮くので、
  // 海底から立てる
  for (const L of DOCK) {
    if (L.up) {
      // 地明かりの器具。海底に伏せた小さな筒
      const hd = [L.bx + L.d.x * 0.55, L.by + L.d.y * 0.55, L.bz + L.d.z * 0.55];
      strut(S, [L.bx, L.by - 0.35, L.bz], hd, 0.30, STEEL2);
      neon.add(hd, [4.2, 2.5, 1.15], 0.16, 0);
      continue;
    }
    strut(S, [L.bx, L.by - 0.4, L.bz], [L.bx, L.hy, L.bz], 0.16, STEEL2);
    strut(S, [L.bx, L.by + 0.2, L.bz], [L.bx, L.by - 0.35, L.bz], 0.62, STEEL2);
    // 灯具の筐体。光る点だけだと、暗闇に浮いた玉になる
    const hd = [L.bx + L.d.x * 0.45, L.hy + L.d.y * 0.45, L.bz + L.d.z * 0.45];
    strut(S, [L.bx, L.hy, L.bz], hd, 0.38, STEEL);
    neon.add([L.bx + L.d.x * 0.6, L.hy + L.d.y * 0.6, L.bz + L.d.z * 0.6],
             [7.0, 6.8, 6.2], 0.22, 0);
  }
  // 給電の臍帯。船と施設をつなぐ一本があるかないかで、
  // 「停泊している船」と「たまたまそこに落ちている船」が分かれる。
  // 水中の綱はぴんと張らない——自重で垂れる形を作る
  {
    const a = [DOCK[0].bx, DOCK[0].hy - 0.5, DOCK[0].bz];
    const sh = Math.sin(NAUTILUS.heading), ch = Math.cos(NAUTILUS.heading);
    // 留め先は司令塔の天。船体の背には鋸歯が並んでいるので、
    // そこへ向けて垂らすと綱が船の中をくぐる。たるみも
    // 控えめにしないと同じことになる(はじめ 2.4m 垂らして貫通した)
    const b = [NAUTILUS.x + sh * -0.5, NAUTILUS.y + 4.6, NAUTILUS.z + ch * -0.5];
    const SAG = 1.0, N = 8;
    let prev = a;
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const cur = [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t - Math.sin(t * Math.PI) * SAG,
        a[2] + (b[2] - a[2]) * t,
      ];
      strut(S, prev, cur, 0.075, STEEL2);
      prev = cur;
    }
  }

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
    const R0 = hullR + 0.2, R1 = MD - (ANNEX.radius + 0.2);
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const r = R0 + (R1 - R0) * t;
      // ふだんは海底に沿う。区画の手前でだけ、取り付き高さへ登る
      const onFloor = FLOOR_Y + riseAt(r) + 1.75;
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
        const gy = FLOOR_Y + riseAt(r);
        strut(S, [px, py - rad * 0.7, pz], [px, gy - 0.15, pz], 0.16, STEEL2);
        strut(S, [px, gy + 0.35, pz], [px, gy - 0.1, pz], 0.55, STEEL2);
      }
      // 天面の航路灯。通路そのものが道しるべになる
      if (i % 2 === 0) {
        neon.add([px, py + rad + 0.12, pz], [3.4, 1.5, 0.28], 0.065, 0);
      }
    });

    // ---- 取付部 ----
    //
    // 通路は壁に突き当たったところで**ただ途切れて**いた。
    // 管が壁に刺さっているだけなので、そこが接続部だと読めない。
    // 実物の水中構造物なら必ずフランジ(鍔)で留めるし、
    // 鍔があると「継いである」ことがひと目で分かる
    const [ex, ey, ez] = link[link.length - 1];
    const SIDES2 = 12;
    const ring2 = (r, off) => {
      const o = [];
      for (let k = 0; k < SIDES2; k++) {
        const th = (k / SIDES2) * Math.PI * 2;
        o.push(S.v(ex + Math.cos(ma) * off - Math.sin(ma) * Math.cos(th) * r,
                   ey + Math.sin(th) * r,
                   ez + Math.sin(ma) * off + Math.cos(ma) * Math.cos(th) * r, STEEL2));
      }
      return o;
    };
    // 鍔を2枚。管の端と、壁に当たる面
    const fa = ring2(1.32, -0.05), fb = ring2(1.92, -0.05);
    const fc = ring2(1.92, 0.30), fd = ring2(1.34, 0.30);
    for (let k = 0; k < SIDES2; k++) {
      const k2 = (k + 1) % SIDES2;
      S.quad(fa[k], fa[k2], fb[k2], fb[k]);
      S.quad(fb[k], fb[k2], fc[k2], fc[k]);
      S.quad(fc[k], fc[k2], fd[k2], fd[k]);
    }
    // 締めボルト。鍔に等間隔で並ぶ
    for (let k = 0; k < SIDES2; k++) {
      const th = (k / SIDES2) * Math.PI * 2;
      const bx = ex - Math.sin(ma) * Math.cos(th) * 1.62;
      const by = ey + Math.sin(th) * 1.62;
      const bz = ez + Math.cos(ma) * Math.cos(th) * 1.62;
      strut(S, [bx - Math.cos(ma) * 0.10, by, bz - Math.sin(ma) * 0.10],
            [bx + Math.cos(ma) * 0.12, by, bz + Math.sin(ma) * 0.12], 0.075, STEEL);
    }
    // 接続部の標識灯。玄関まわりであることを灯りで言う
    for (const th of [Math.PI * 0.5, Math.PI * 1.5]) {
      neon.add([ex - Math.sin(ma) * Math.cos(th) * 1.9, ey + Math.sin(th) * 1.9,
                ez + Math.cos(ma) * Math.cos(th) * 1.9], [0.5, 2.6, 3.4], 0.08, 0);
    }
  }

  // ---- 区域照明の柱 ----
  //
  // 光は downField() が格子から計算している。柱もその格子から生やす。
  // 位置と有無は downCellOk / downLampY を共有しているので、
  // 「光っているのに柱が無い」「柱があるのに暗い」が起きない。
  //
  // 等間隔に並んでいることが大事。自然の海底に等間隔の柱は無いので、
  // それだけで「人が敷設した区域」に見える。しかも奥へ向かって
  // 規則正しく小さくなるので、霧の中の距離が読めるようになる
  const downMasts = [];
  {
    const D = DOWNLIGHT;
    const nCell = Math.ceil(D.outer / D.pitch);
    for (let i = -nCell; i <= nCell; i++) {
      for (let j = -nCell; j <= nCell; j++) {
        const px = i * D.pitch, pz = j * D.pitch;
        if (!downCellOk(px, pz)) continue;
        const r = Math.hypot(px, pz);
        const gy = FLOOR_Y + reliefAt(px, pz);
        const hy = downLampY(px, pz);
        // 柱。遠いほど細く見えるので、太さは変えない
        strut(S, [px, gy - 0.3, pz], [px, hy, pz], 0.17, STEEL2);
        // 接地板。泥に沈みかけた短い裾。上を向いた平らな面は作らない
        strut(S, [px, gy + 0.42, pz], [px, gy - 0.25, pz], 0.62, STEEL2);
        // 灯具。下向きの短い筒
        strut(S, [px, hy + 0.15, pz], [px, hy - 0.42, pz], 0.42, STEEL);
        // 外周へ行くほど暗い。シェーダ側の taper と揃える
        const k = 1 - THREE.MathUtils.smoothstep(r, D.fade, D.outer);
        neon.add([px, hy - 0.66, pz], [4.6 * k, 4.9 * k, 5.2 * k], 0.17, 0);
        // 光の錐。**水中の照明が照明に見えるのは、床の溜まりではなく錐**。
        // 溜まりのほうは 30m も離れると霧に埋もれて、明暗の比が
        // 1.2 倍しか出ない(実測)。錐は加算合成なので霧の上に乗る。
        // 遠くのぶんまで描くと重なりで塗り潰すので、近い列だけ
        if (r < D.fade + 4) {
          downMasts.push({ p: [px, hy - 0.55, pz], d: new THREE.Vector3(0, -1, 0),
                           len: hy - 0.55 - gy, r0: 0.40, r1: 4.6 });
        }
        // 遊べる範囲(半径60m)の中だけ当たり判定を持たせる。
        // 全部に付けると、行けない場所の柱のために毎フレーム
        // 判定を回すことになる
        if (world && r < 58) {
          world.addStatic(new THREE.Vector3(px, gy + (hy - gy) * 0.5, pz),
                          0.55, (hy - gy) * 0.5 + 0.4, 0.55);
        }
      }
    }
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
    const by = FLOOR_Y + riseAt(r);
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

    // 境界球を自分で入れる。
    //
    // これが無いと「近づくと海藻がまるごと消える」。position に入って
    // いるのは葉のローカル座標(±0.2m くらい)で、世界のどこに生えて
    // いるかは aRoot として頂点シェーダで足している。three は
    // position しか見ないので、境界球は原点の小さな球のままになる。
    // 原点が画角から外れた瞬間——つまり施設から離れて外を向いた瞬間
    // ——に、海藻が1枚残らず視錐台カリングで消える。
    //
    // 実際に生えている範囲を測って入れておけば、正しく判定される
    let far = 0;
    for (const [bx, by, bz, h] of blades) {
      far = Math.max(far, Math.hypot(bx, by + h, bz) + h * 0.5);
    }
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), far + 1.0);
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

  // ---- メガロドン ----
  //
  // 光の受け方はマイワシと分ける。あちらは体側が反射率 0.8 の銀なので
  // 投光器を 0.22 倍まで落としてあるが、サメの背は 0.05——同じ倍率を
  // 掛けたら**ただの黒い影**になる。腹の白と背の黒の差が
  // 見えないサメは、大きいだけの塊にしか見えない
  const SHARK_ENV = EXT_FOG + FLOOD + /* glsl */ `
    vec3 fishLight(vec3 a, vec3 n, vec3 wp, vec3 V, float sp, float si) {
      vec3 col = a * (vec3(0.034, 0.052, 0.070) + floodLight(wp, n) * 0.95);
      // 海底からの照り返し。区域照明で床は明るいので、下を向いた面には
      // 必ず光が回る。これが無いと、灯りより高いところを泳ぐあいだ
      // **真っ黒な影**にしかならず、腹の白と背の黒の対比が消える
      col += a * vec3(0.10, 0.15, 0.17) * max(-n.y, 0.0);
      // 濡れた肌の照り。楯鱗はざらついているので、鏡ではなく鈍く広く
      col += floodLight(wp, normalize(n + V * 0.5)) * si * 0.06;
      return col;
    }
    vec3 fishCaustics(vec3 wp, vec3 n) { return vec3(0.0); }
    vec3 fishFog(vec3 c, vec3 wp) { return extFog(c, wp); }
    vec3 fishRim() { return vec3(0.055, 0.100, 0.130); }
  `;
  const megalodon = new Megalodon(group, {
    env: SHARK_ENV,
    // 当たり判定。体に沿って動く球をいくつか置く。
    // ここを渡し忘れていたので、24m の体を素通りできていた
    world,
    // Shimada et al. (2025) の推定巡航速度は 2.1〜3.5 km/h
    // (≒0.6〜1.0 m/s)で、ホホジロザメと同程度。3.2 m/s はその3倍で、
    // 24m の体がすっ飛んでいた。少しだけ上乗せして 1.5 m/s——
    // 体長ぶん進むのに 16 秒かかる速さで、これがいちばん大きく見える
    speed: 1.5,
    rNear: 17.5,
    rFar: 34.0,
    // 内側を回るときは舷窓の正面。ここが合っていないと、
    // 部屋にいるあいだ一度も姿を見ないまま終わる
    yNear: deckY + 2.9,
    yFar: 17.5,
    // いちばん内側では天蓋の上を越える。ガラスの天井にした甲斐が
    // いちばん出るのがこの瞬間
    yOver: domeTop + 4.2,
    floorAt: (r) => FLOOR_Y + riseAt(r),
    // 越えるべき高さ。区域照明の柱と同じ式から引く——
    // 目分量で決めると、いつか柱を突き抜ける
    clearAt: (r) => (r > DOWNLIGHT.inner - 1.0
      ? FLOOR_Y + riseAt(r) + DOWNLIGHT.head + 2.6
      : -Infinity),
  });

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
  {
    // 発光面は MeshBasicMaterial なので uStationI を読めない。
    // 区域照明を絞ったときに**ここだけ点いたまま**になるので、
    // 印を付けておいて JS 側から色を落とす
    const m = new THREE.Mesh(glow.geo(), new THREE.MeshBasicMaterial({
      color: 0xcfe6ff, toneMapped: false, side: THREE.DoubleSide }));
    m.userData.stationLit = true;
    group.add(m);
  }

  // ---- 光の筋 ----
  const beams = new THREE.BufferGeometry();
  {
    // 筋の長さは海底に届くところで止める。突き抜けさせると、
    // 加算合成なので泥の中にも光の錐が描かれる
    const SEGB = 16;
    const pos = [], nrm = [], tt = [], idx = [];
    const up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3(1, 0, 0);
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    // 舷窓の投光器と、区域照明の柱。寸法が違うので器具ごとに持たせる
    const beamSrc = fixtures.map((f) => ({ p: f.p, d: f.d, len: 11.0, r0: 0.34, r1: 3.2 }))
      .concat(downMasts);
    for (const f of beamSrc) {
      const LEN = f.len, R0 = f.r0, R1 = f.r1;
      // 軸が真下のときは up との外積が 0 になる。基準を横に取り替える
      e1.copy(Math.abs(f.d.y) > 0.95 ? side : up).cross(f.d).normalize();
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
  // 笠の頂の上。中に埋めると外から見えない。
  //
  // ここは数値を直に書いていた(7.0 + 5.2*0.42)。観測棟を低くしたとき
  // 標識だけが元の高さに取り残されて、屋根から 4.6m 浮いた赤い玉に
  // なった。しかも「建物の一番上」の目印なので、縮尺を測るときに
  // それが天辺として効いてしまう。寸法は必ず定数から引く
  beacon.position.set(mx, ANNEX.base + ANNEX.wall + ANNEX.radius * 0.22 + 0.45, mz);
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

  // ---- 区域照明の明るさで一緒に絞るもの ----
  //
  // シェーダを持つ材質は uStationI を直接読めるが、MeshBasicMaterial は
  // 読めない。印を付けた分だけ、素の色を控えておいて毎フレーム掛ける
  const stationLit = [];
  group.traverse((o) => {
    if (o.isMesh && o.userData.stationLit) {
      stationLit.push({ mat: o.material, base: o.material.color.clone() });
    }
  });

  // ---- 図鑑から「見に行く」ための対象 ----
  //
  // 動くものは毎回いまの位置を返し、建物は固定点を返す。
  const _camAt = new THREE.Vector3();
  let followSchool = null;
  const nearestSchool = () => {
    let best = schools[0], bd = Infinity;
    for (const sc of schools) {
      const d = sc.schoolCenter.distanceToSquared(_camAt);
      if (d < bd) { bd = d; best = sc; }
    }
    return best;
  };

  // 建物の固定点。
  //
  // 中心を渡してはいけない——追跡は視線をその点へ向けるので、
  // 船体の中心を渡すと**壁の内側**を見つめることになる。少し上、
  // 外殻より高いところを狙う
  const _followNaut = new THREE.Vector3(NAUTILUS.x, NAUTILUS.y + 3.0, NAUTILUS.z);
  const _followTower = new THREE.Vector3(
    ANNEX.x, ANNEX.base + ANNEX.wall * 0.55, ANNEX.z);
  // 区域照明は、柱そのものではなく柱の並びを見せたい。
  // 施設と観測塔を結ぶ線から外して、柱がいちばん詰まって見える方角に取る
  const _followDown = (() => {
    const a = Math.PI * 0.42, r = DOWNLIGHT.inner + DOWNLIGHT.pitch * 0.7;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    return new THREE.Vector3(x, FLOOR_Y + reliefAt(x, z) + 3.2, z);
  })();

  // ---- 見にいく立ち位置 ----
  //
  // 追跡は「距離を詰めて、視線を向ける」だけで、壁を抜けてはくれない。
  // ここは水槽と違って、対象と観客のあいだに**耐圧殻がある**。
  // 部屋の中から潜水艦の札を押しても、壁を見つめるだけでした。
  //
  // なので外の札には立ち位置を持たせて、押されたときにそこへ移る。
  // 対象と施設を結ぶ線の上、対象の手前に置く——真横や真後ろから
  // 寄ると、振り返ったときに施設が画面の外にいて、自分がどこに
  // いるのか分からなくなる
  const _from = new THREE.Vector3();
  const viewFrom = (target, back, lift) => {
    const d = _from.set(target.x, 0, target.z);
    const L = d.length() || 1;
    const k = Math.max(L - back, hullR + 4.0) / L;   // 殻の中まで下がらない
    const x = target.x * k, z = target.z * k;
    return new THREE.Vector3(x, Math.max(target.y + lift, FLOOR_Y + reliefAt(x, z) + 3.0), z);
  };

  const followTargets = {
    megalodon: {
      // 回遊しているので、対象ではなく回遊路の内側に立つ。
      // 天蓋の上なら、内周(17.5m)も外周(34m)も同じ場所から見える
      from: () => _fromMeg,
      get: () => megalodon.pos,
      dist: [15, 36],
    },
    sardine: {
      // 群れは舷窓ごとに散らしてある。いちばん近い1群を**選んだ瞬間に
      // 決めて**、そこから離さない。毎フレーム選び直すと、寄っていく
      // 途中で別の群れが近くなり、そのたび向きが飛ぶ
      start: () => { followSchool = nearestSchool(); },
      from: () => viewFrom(followSchool.schoolCenter, 9.0, 1.5),
      get: () => {
        if (!followSchool) followSchool = nearestSchool();
        return followSchool.schoolCenter;
      },
      dist: [5, 14],
    },
    nautilus: { from: () => _fromNaut, get: () => _followNaut, dist: [18, 38] },
    tower: { from: () => _fromTower, get: () => _followTower, dist: [22, 46] },
    downlight: { from: () => _fromDown, get: () => _followDown, dist: [14, 32] },
  };
  const _fromMeg = new THREE.Vector3(0, domeTop + 6.0, 0);
  const _fromNaut = viewFrom(_followNaut, 22.0, 4.0);
  const _fromTower = viewFrom(_followTower, 30.0, 2.0);
  const _fromDown = viewFrom(_followDown, 16.0, 7.0);

  return {
    followTargets,
    // サメの居場所。音を鳴らすのに要る——距離で音量を決めるので
    get sharkPos() { return megalodon.pos; },
    update(dt, t, camAt) {
      if (camAt) _camAt.copy(camAt);
      megalodon.update(dt);
      const si = U.uStationI.value;
      for (const e of stationLit) e.mat.color.copy(e.base).multiplyScalar(si);
      // 2.6秒周期でひと呼吸。ずっと点いていると人工物に見えない
      const ph = (t % 2.6) / 2.6;
      const on = Math.exp(-Math.pow((ph - 0.12) * 9.0, 2)) * si;
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
export function strut(M, a, b, rad, col) {
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
 * 観測所。中に入れる、3層のガラスの塔。
 *
 * 作りは下から:
 *   台座    海底に据わる鋼の輪。玄関の踏み段がここから出る
 *   1階     作業階。腰壁の上にガラス帯。連絡通路と戸口はここ
 *   2〜3階  観測階。床から天井までガラス。外周は回廊で、
 *           真ん中は3層ぶん吹き抜け
 *   冠      浅い円錐と、軒を一周するネオンの環
 *
 * 骨は12本の柱。柱にネオンの縦線を通してあるので、
 * 遠くからは「光の柱が12本立った輪」として読める。
 *
 * 寸法の手がかりを外に出すのがいちばん大事なところ。床の帯が
 * 3本の水平線として外から見え、回廊の手すりが腰の高さで並ぶ。
 * これが無いと、どれだけ大きく作っても「拡大した小屋」になる。
 */
function buildAnnex(S, neon, world, group, mat) {
  const { x: cx, z: cz, radius: R, storey: SH, levels: LV,
          wallTh: TH, gallery: GW, sill, door, doorArc } = ANNEX;
  const base = ANNEX.base, floorY = ANNEX.floor;
  const voidR = ANNEX.voidR;
  const N = 60;                              // 円の分割
  const COLN = 12;                           // 柱の本数
  const eaves = floorY + SH * LV;            // 軒の高さ
  const apex = eaves + R * 0.22;
  const lvlY = (i) => floorY + SH * i;       // i階の床(0が1階)

  // 出入口はプロテウスのほう(=原点向き)から少しずらして開ける
  const dA = ANNEX.a + Math.PI + ANNEX.doorOff;
  const inDoor = (a) => {
    const d = Math.abs(((a - dA + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    return d < doorArc;
  };
  const ang = (k) => (k / N) * Math.PI * 2;
  const P = (a, r, y, col = STEEL) => S.v(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r, col);

  // 発光する帯。器具ではなく「光る線」なので、点を並べるのではなく
  // 帯そのものを描く。Neon の八面体を何十個も並べると豆電球になる
  const NEONB = new Buf();
  const neonBand = (r, y0, y1, col, a0 = 0, a1 = Math.PI * 2, seg = N) => {
    let prev = null;
    for (let k = 0; k <= seg; k++) {
      const a = a0 + (a1 - a0) * (k / seg);
      const cur = [NEONB.v(cx + Math.cos(a) * r, y0, cz + Math.sin(a) * r, col),
                   NEONB.v(cx + Math.cos(a) * r, y1, cz + Math.sin(a) * r, col)];
      if (prev) NEONB.quad(prev[0], prev[1], cur[1], cur[0]);
      prev = cur;
    }
  };
  const NEON_CYAN = [0.28, 0.92, 1.00];
  const NEON_WARM = [1.00, 0.62, 0.22];

  // ---- 台座 ----
  for (let k = 0; k < N; k++) {
    const a0 = ang(k), a1 = ang(k + 1);
    S.quad(P(a0, R + 0.8, base - 1.1), P(a1, R + 0.8, base - 1.1),
           P(a1, R + 0.55, base, STEEL2), P(a0, R + 0.55, base, STEEL2));
    S.quad(P(a0, R + 0.55, base, STEEL2), P(a1, R + 0.55, base, STEEL2),
           P(a1, R, base), P(a0, R, base));
  }

  // ---- 1階の床 ----
  {
    const hub0 = S.v(cx, floorY, cz, DECKC);
    const rim = [];
    for (let k = 0; k < N; k++) rim.push(P(ang(k), R - TH, floorY, DECKC));
    for (let k = 0; k < N; k++) S.tri(hub0, rim[(k + 1) % N], rim[k]);
  }

  // ---- 柱 ----
  //
  // 12本。ガラスを支えているものが見えないと、壁が浮いた輪に見える。
  // 柱の外面にネオンの縦線を通す
  const colHalf = 0.30 / R;                  // 柱の半角
  for (let m = 0; m < COLN; m++) {
    const a = (m / COLN) * Math.PI * 2 + 0.26;
    if (inDoor(a)) continue;
    const q = [];
    for (const [aa, rr] of [[a - colHalf, R + 0.14], [a + colHalf, R + 0.14],
                            [a + colHalf, R - TH], [a - colHalf, R - TH]]) {
      q.push([P(aa, rr, base, STEEL2), P(aa, rr, eaves, STEEL)]);
    }
    for (let j = 0; j < 4; j++) {
      const j2 = (j + 1) % 4;
      S.quad(q[j][0], q[j2][0], q[j2][1], q[j][1]);
    }
    // 柱のネオン。外面に細い縦線を1本
    neonBand(R + 0.16, floorY + 0.4, eaves - 0.3, NEON_CYAN,
             a - colHalf * 0.45, a + colHalf * 0.45, 1);
  }

  // ---- 床の帯 ----
  //
  // 各階の床を外へ 0.2m 出して、厚み 0.5m の輪として見せる。
  // **外から見える水平線はこれだけ**で、階数と大きさはここで伝わる
  for (let i = 0; i <= LV; i++) {
    const y = i === LV ? eaves : lvlY(i);
    const y0 = y - (i === 0 ? 0.62 : 0.28), y1 = y + 0.22;
    for (let k = 0; k < N; k++) {
      const a0 = ang(k), a1 = ang(k + 1);
      S.quad(P(a0, R + 0.20, y0, STEEL2), P(a1, R + 0.20, y0, STEEL2),
             P(a1, R + 0.20, y1, STEEL2), P(a0, R + 0.20, y1, STEEL2));
      S.quad(P(a0, R + 0.20, y1, STEEL), P(a1, R + 0.20, y1, STEEL),
             P(a1, R - TH, y1, STEEL), P(a0, R - TH, y1, STEEL));
      S.quad(P(a1, R + 0.20, y0, STEEL2), P(a0, R + 0.20, y0, STEEL2),
             P(a0, R - TH, y0, STEEL2), P(a1, R - TH, y0, STEEL2));
    }
    // 帯の下端に沿ってネオン。夜の建物が階ごとに分かれて見える
    neonBand(R + 0.23, y0 + 0.04, y0 + 0.16, i === LV ? NEON_WARM : NEON_CYAN);
  }

  // ---- 腰壁(1階だけ) ----
  //
  // 1階は作業階なので、腰まで鋼。ここが全面ガラスだと、
  // 机も装置も置けない部屋になる
  const ySill = floorY + sill;
  const yDoor = floorY + door;
  for (let k = 0; k < N; k++) {
    const a0 = ang(k), a1 = ang(k + 1);
    const y0 = inDoor(ang(k + 0.5)) ? yDoor : base;
    const y1 = inDoor(ang(k + 0.5)) ? lvlY(1) - 0.28 : ySill;
    S.quad(P(a0, R, y0), P(a1, R, y0), P(a1, R, y1), P(a0, R, y1));
    S.quad(P(a1, R - TH, y0), P(a0, R - TH, y0), P(a0, R - TH, y1), P(a1, R - TH, y1));
  }
  // 戸口の見付。板厚を見せないと、壁が厚さ0の紙に見える
  for (const sgn of [-1, 1]) {
    const a = dA + doorArc * sgn;
    S.quad(P(a, R, floorY), P(a, R - TH, floorY), P(a, R - TH, yDoor), P(a, R, yDoor));
  }
  for (let k = 0; k < N; k++) {
    const a0 = ang(k), a1 = ang(k + 1);
    if (!inDoor(ang(k + 0.5))) continue;
    S.quad(P(a0, R, yDoor), P(a0, R - TH, yDoor), P(a1, R - TH, yDoor), P(a1, R, yDoor));
    S.quad(P(a1, R, floorY), P(a1, R - TH, floorY), P(a0, R - TH, floorY), P(a0, R, floorY));
  }
  // 戸口を縁取るネオン。暗い海で入口が分かるのは灯りだけ
  neonBand(R + 0.22, floorY + 0.15, floorY + 0.28, NEON_WARM,
           dA - doorArc - 0.03, dA + doorArc + 0.03, 6);
  neonBand(R + 0.22, yDoor - 0.14, yDoor - 0.01, NEON_WARM,
           dA - doorArc - 0.03, dA + doorArc + 0.03, 6);

  // ---- 方立 ----
  // 柱と柱のあいだに細い縦桟。ガラスが一枚板に見えないように
  for (let m = 0; m < COLN * 3; m++) {
    const a = (m / (COLN * 3)) * Math.PI * 2 + 0.26 + Math.PI / (COLN * 3);
    if (inDoor(a)) continue;
    const w = 0.045;
    for (let i = 0; i < LV; i++) {
      const y0 = (i === 0 ? ySill : lvlY(i) + 0.22);
      const y1 = (i === LV - 1 ? eaves : lvlY(i + 1)) - 0.28;
      S.quad(P(a - w, R + 0.02, y0), P(a + w, R + 0.02, y0),
             P(a + w, R + 0.02, y1), P(a - w, R + 0.02, y1));
      S.quad(P(a + w, R - TH, y0), P(a - w, R - TH, y0),
             P(a - w, R - TH, y1), P(a + w, R - TH, y1));
    }
  }

  // ---- ガラス ----
  // 加算で映り込みだけを足す板。半透明合成にすると外のマリンスノーや
  // 遠景と描画順を争う
  {
    const SEG = 72;
    const pos = [], nrm = [], idx = [];
    const bands = [];
    for (let i = 0; i < LV; i++) {
      bands.push([i === 0 ? ySill + 0.05 : lvlY(i) + 0.24,
                  (i === LV - 1 ? eaves : lvlY(i + 1)) - 0.30]);
    }
    bands.forEach(([ylo, yhi], bi) => {
      const b0 = pos.length / 3;
      for (let j = 0; j <= 1; j++) {
        const y = j ? yhi : ylo;
        for (let k = 0; k <= SEG; k++) {
          const a = (k / SEG) * Math.PI * 2;
          pos.push(cx + Math.cos(a) * R, y, cz + Math.sin(a) * R);
          nrm.push(Math.cos(a), 0, Math.sin(a));
        }
      }
      for (let k = 0; k < SEG; k++) {
        // 1階の戸口の上は鋼の欄間なので、ガラスを張らない
        if (bi === 0 && inDoor(((k + 0.5) / SEG) * Math.PI * 2)) continue;
        const p0 = b0 + k, p1 = p0 + 1, p2 = p0 + SEG + 1, p3 = p2 + 1;
        idx.push(p0, p2, p3, p0, p3, p1);
      }
    });
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

  // ---- 回廊 ----
  //
  // 2階と3階は外周だけ。真ん中は3層ぶん抜けている。
  // 入って見上げたときに階数が数えられるのがこの吹き抜けの役目
  for (let i = 1; i < LV; i++) {
    const y = lvlY(i);
    for (let k = 0; k < N; k++) {
      const a0 = ang(k), a1 = ang(k + 1);
      S.quad(P(a0, R - TH, y, DECKC), P(a1, R - TH, y, DECKC),
             P(a1, voidR, y, DECKC), P(a0, voidR, y, DECKC));
      // 床裏。下から見上げるので、ここが抜けていると床が紙になる
      S.quad(P(a1, R - TH, y - 0.24, STEEL2), P(a0, R - TH, y - 0.24, STEEL2),
             P(a0, voidR, y - 0.24, STEEL2), P(a1, voidR, y - 0.24, STEEL2));
      S.quad(P(a0, voidR, y - 0.24, STEEL2), P(a1, voidR, y - 0.24, STEEL2),
             P(a1, voidR, y, STEEL2), P(a0, voidR, y, STEEL2));
    }
    // 手すり。腰の高さ(1.05m)。**この一本が建物の寸法を語る**
    for (let m = 0; m < 24; m++) {
      const a = (m / 24) * Math.PI * 2;
      strut(S, [cx + Math.cos(a) * voidR, y, cz + Math.sin(a) * voidR],
            [cx + Math.cos(a) * voidR, y + 1.05, cz + Math.sin(a) * voidR], 0.035, STEEL2);
    }
    for (const h of [0.55, 1.05]) {
      let prev = null;
      for (let k = 0; k <= N; k++) {
        const a = ang(k % N);
        const cur = [cx + Math.cos(a) * voidR, y + h - 0.03, cz + Math.sin(a) * voidR];
        if (prev) strut(S, prev, cur, 0.032, STEEL2);
        prev = cur;
      }
    }
    // 手すりの内側にネオン。吹き抜けが階ごとに光の輪で縁取られる
    neonBand(voidR - 0.06, y + 0.94, y + 1.02, NEON_CYAN);
  }

  // ---- 階段 ----
  // 吹き抜けの縁を回って上がる。上下に行き来する手段が見えないと、
  // 上の階が「立入れない飾り」になる
  {
    const sa0 = dA + Math.PI * 0.55;
    for (let i = 0; i < LV - 1; i++) {
      const y0 = lvlY(i), y1 = lvlY(i + 1);
      const a0 = sa0 + i * 1.5, a1 = a0 + 1.35;
      const rIn = voidR + 0.15, rOut = R - TH - 0.15;
      const ST = 12;
      for (let s = 0; s < ST; s++) {
        const t0 = s / ST, t1 = (s + 1) / ST;
        const aa = a0 + (a1 - a0) * t0, ab = a0 + (a1 - a0) * t1;
        const ya = y0 + (y1 - y0) * t0, yb = y0 + (y1 - y0) * t1;
        S.quad(P(aa, rIn, ya, DECKC), P(ab, rIn, yb, DECKC),
               P(ab, rOut, yb, DECKC), P(aa, rOut, ya, DECKC));
        S.quad(P(aa, rOut, ya - 0.16, STEEL2), P(ab, rOut, yb - 0.16, STEEL2),
               P(ab, rIn, yb - 0.16, STEEL2), P(aa, rIn, ya - 0.16, STEEL2));
      }
      // 段の外側の手すり
      for (let s = 0; s <= 4; s++) {
        const t = s / 4;
        const aa = a0 + (a1 - a0) * t, ya = y0 + (y1 - y0) * t;
        strut(S, [cx + Math.cos(aa) * rIn, ya, cz + Math.sin(aa) * rIn],
              [cx + Math.cos(aa) * rIn, ya + 1.05, cz + Math.sin(aa) * rIn], 0.035, STEEL2);
      }
      neonBand(rIn - 0.05, y0, y1, NEON_CYAN, a0, a1, 8);
    }
  }

  // ---- 冠 ----
  {
    const top = S.v(cx, apex, cz, STEEL);
    for (let k = 0; k < N; k++) {
      S.tri(P(ang(k), R + 0.20, eaves), P(ang(k + 1), R + 0.20, eaves), top);
    }
    // 梁。屋根が一枚の傘に見えないよう、放射状に通す
    for (let m = 0; m < COLN; m++) {
      const a = (m / COLN) * Math.PI * 2 + 0.26;
      strut(S, [cx + Math.cos(a) * (R + 0.1), eaves + 0.08, cz + Math.sin(a) * (R + 0.1)],
            [cx, apex - 0.05, cz], 0.085, STEEL2);
    }
    // 頂のネオン環
    neonBand(R * 0.30, apex - R * 0.24, apex - R * 0.19, NEON_WARM);
  }

  // ---- 玄関の踏み段 ----
  //
  // 床は海底より 0.95m 高い。穴だけ開いていると、壁に四角い明かりが
  // 浮いているようにしか見えない
  {
    const D = 3.0;
    const px = -Math.sin(dA), pz = Math.cos(dA);
    const hw = R * Math.sin(doorArc) + 0.40;
    const ox = cx + Math.cos(dA) * (R + 0.20), oz = cz + Math.sin(dA) * (R + 0.20);
    // 足もとの海底。地形と同じ式で取らないと、斜路の先が砂に埋まるか宙に浮く
    const gy = FLOOR_Y + reliefAt(ox + Math.cos(dA) * D, oz + Math.sin(dA) * D);
    const pt = (u, out, y) => S.v(ox + px * u + Math.cos(dA) * out, y,
                                  oz + pz * u + Math.sin(dA) * out, DECKC);
    const xyz = (i) => [S.p[i * 3], S.p[i * 3 + 1], S.p[i * 3 + 2]];
    const y0 = floorY - 0.06;
    S.quad(pt(-hw, 0, y0), pt(hw, 0, y0), pt(hw, D * 0.5, y0), pt(-hw, D * 0.5, y0));
    S.quad(pt(-hw, D * 0.5, y0), pt(hw, D * 0.5, y0),
           pt(hw, D, gy + 0.06), pt(-hw, D, gy + 0.06));
    for (const sgn of [-1, 1]) {
      S.quad(pt(sgn * hw, 0, y0), pt(sgn * hw, D * 0.5, y0),
             pt(sgn * hw, D * 0.5, y0 - 0.24), pt(sgn * hw, 0, y0 - 0.24));
      S.quad(pt(sgn * hw, D * 0.5, y0), pt(sgn * hw, D, gy + 0.06),
             pt(sgn * hw, D, gy - 0.18), pt(sgn * hw, D * 0.5, y0 - 0.24));
      const posts = [[0.15, y0], [D * 0.5, y0], [D * 0.95, gy + 0.06]];
      posts.forEach(([u, yy]) => {
        strut(S, xyz(pt(sgn * hw, u, yy)), xyz(pt(sgn * hw, u, yy + 1.05)), 0.045, STEEL2);
      });
      for (let i = 0; i < posts.length - 1; i++) {
        strut(S, xyz(pt(sgn * hw, posts[i][0], posts[i][1] + 1.05)),
              xyz(pt(sgn * hw, posts[i + 1][0], posts[i + 1][1] + 1.05)), 0.040, STEEL2);
      }
      const gl = pt(sgn * (hw - 0.12), D * 0.78, (y0 + gy) * 0.5 + 0.2);
      neon.add([S.p[gl * 3], S.p[gl * 3 + 1] + 0.1, S.p[gl * 3 + 2]],
               [3.4, 1.9, 0.5], 0.065, 0);
    }
  }

  // ---- 中の設え ----
  // 何も無い筒は部屋ではない。作業台と器械があって初めて
  // 「人が使っている観測室」になる
  for (let m = 0; m < 7; m++) {
    const a = (m / 7) * Math.PI * 2 + 0.6;
    if (inDoor(a)) continue;
    const bx = cx + Math.cos(a) * (R - 1.35), bz = cz + Math.sin(a) * (R - 1.35);
    const px = -Math.sin(a), pz = Math.cos(a);
    const q = [];
    for (const [u, v] of [[-1.2, -0.45], [1.2, -0.45], [1.2, 0.45], [-1.2, 0.45]]) {
      q.push(S.v(bx + px * u + Math.cos(a) * v, floorY + 0.95,
                 bz + pz * u + Math.sin(a) * v, STEEL2));
    }
    S.quad(q[0], q[1], q[2], q[3]);
    for (const u of [-1.0, 1.0]) {
      strut(S, [bx + px * u, floorY + 0.95, bz + pz * u],
            [bx + px * u, floorY, bz + pz * u], 0.055, STEEL2);
    }
    neon.add([bx + px * 0.5 + Math.cos(a) * 0.1, floorY + 1.20, bz + pz * 0.5 + Math.sin(a) * 0.1],
             [0.35, 1.9, 1.5], 0.085, 0);
    neon.add([bx - px * 0.5 + Math.cos(a) * 0.1, floorY + 1.20, bz - pz * 0.5 + Math.sin(a) * 0.1],
             [1.9, 1.2, 0.30], 0.070, 0.7, m * 1.3);
  }
  // 各階の天井灯
  for (let i = 0; i < LV; i++) {
    const yc = (i === LV - 1 ? eaves : lvlY(i + 1)) - 0.45;
    const rr = i === 0 ? 3.4 : (voidR + R - TH) * 0.5;
    for (let m = 0; m < 6; m++) {
      const a = (m / 6) * Math.PI * 2 + 0.8 + i * 0.5;
      neon.add([cx + Math.cos(a) * rr, yc, cz + Math.sin(a) * rr], [3.0, 3.3, 3.6], 0.16, 0);
    }
  }
  // 吹き抜けの床に一点。入ったときに広さが分かる
  neon.add([cx, floorY + 0.06, cz], [1.6, 1.7, 1.9], 0.12, 0);

  // ネオンは加算合成の発光板。水の霧は掛けない——
  // 掛けると近くの帯まで濁って、光っているものに見えなくなる。
  //
  // 属性名に注意。Buf は頂点色を `aCol` で持つが(自前シェーダの
  // 都合)、three の `vertexColors: true` が探すのは `color`。
  // 名前が合わないと属性は未束縛のまま (0,0,0) が読まれ、
  // 加算合成なので**帯がまるごと消える**。実際1本も光っていなかった
  {
    const ng = NEONB.geo();
    ng.setAttribute('color', ng.getAttribute('aCol'));
    const nm = new THREE.Mesh(ng, new THREE.MeshBasicMaterial({
      vertexColors: true, toneMapped: false, side: THREE.DoubleSide,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    // こちらも uStationI を読めない口。material.color は頂点色に
    // 掛かるので、白のままにしておけば JS から一括で絞れる
    nm.userData.stationLit = true;
    group.add(nm);
  }

  // ---- 当たり判定 ----
  if (world) {
    const _b = new THREE.Vector3();
    // 壁。刻みは戸口を基準に並べる——角度0から等間隔に置くと、
    // 戸口が刻みのどこに落ちるかで通れる幅が変わってしまう
    const NW = 56, GAP = 0.185;
    const HH = eaves - base;
    for (let k = 0; k < NW; k++) {
      const s = -Math.PI + (k + 0.5) * (Math.PI * 2 / NW);
      if (Math.abs(s) < GAP) continue;
      const a = dA + s;
      world.addStatic(_b.set(cx + Math.cos(a) * (R + 0.55), base + HH * 0.5,
                             cz + Math.sin(a) * (R + 0.55)),
                      0.50, HH * 0.6, 0.50);
    }
    // 冠の蓋。壁だけ塞いでも、上から降りて屋根を抜けられてしまう。
    // 楕円体では平らな蓋が作れないので、中心をうんと上に置いて
    // 下側の面だけが軒の高さに来るようにする
    world.addStatic(_b.set(cx, apex + 6.4, cz), R + 0.6, 7.2, R + 0.6);
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
