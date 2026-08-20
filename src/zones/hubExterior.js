import * as THREE from 'three';
import { baseUniforms } from '../env.js';
import { UW_FRAG_PRELUDE, UW_FRAG_OUTPUT } from '../glsl.js';

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
  const body = lights.map((L) => `s += flood1(wp, n, ${v3(L.p)}, ${v3(L.d)});`).join('\n      ');
  return /* glsl */ `
    vec3 flood1(vec3 wp, vec3 n, vec3 lp, vec3 ld) {
      vec3 d = lp - wp;
      float dist = length(d);
      vec3 L = d / max(dist, 0.001);
      // 器具から見て、その点は照射方向の何度ずれているか
      float cs = dot(-L, ld);
      float cone = smoothstep(0.55, 0.90, cs);
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
      return (max(dot(n, L), 0.0) * 0.88 + 0.12) * att * cone * absorb;
    }
    vec3 floodLight(vec3 wp, vec3 n) {
      vec3 s = vec3(0.0);
      ${body}
      return vec3(9.6, 9.2, 9.0) * s;
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

/**
 * 施設の外を建てる。
 *
 * @param {THREE.Group} root  ゾーンの根
 * @param {number[]} winAngles 舷窓の角度。投光器はここに取り付ける
 * @param {number} hullR      殻の外半径
 * @param {number} deckY      甲板の高さ
 * @returns {{update:Function}}
 */
export function buildExterior(root, winAngles, hullR, deckY, domeTop) {
  const group = new THREE.Group();
  group.userData.portal = true;      // 作り直しのときに一緒に消える
  root.add(group);

  // ---- 投光器の配置 ----
  // 舷窓1枚につき2基。窓の真上に1基だと、窓の正面がいちばん暗くなる。
  // 左右に振って、見ている先が両側から照らされるようにする
  const FL_Y = deckY + 5.6;
  const lights = [];
  const fixtures = [];
  for (const wa of winAngles) {
    for (const off of [-0.155, 0.155]) {
      const a = wa + off;
      const p = [Math.cos(a) * (hullR + 0.55), FL_Y, Math.sin(a) * (hullR + 0.55)];
      // 外向き・下向き。海底の見える範囲を照らす角度に振る
      const d = new THREE.Vector3(Math.cos(a) * 0.62, -0.78, Math.sin(a) * 0.62).normalize();
      lights.push({ p, d: [d.x, d.y, d.z], a });
      fixtures.push({ p, d, a });
    }
  }
  const FLOOD = floodGLSL(lights);

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
  // 施設は窪地の底にいる。遠くへ行くほど底が持ち上がる。
  //
  // 平らな底にすると、部屋の中心に立って窓を見たとき、水平の視線には
  // 何も映らない——敷居に遮られて海底は見えず、真っ暗な四角になる。
  // 実際そうなっていた。海底は「下にある」だけでなく「遠くで立ち上がって
  // 目の高さまで来る」ものにして初めて、窓の正面に海が見える
  const rise = (r) => {
    const t = Math.min(Math.max((r - 22) / 56, 0), 1);
    return t * t * (3 - 2 * t) * 8.5;
  };
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
  // 岩。海底に何も無いと、距離感が出ない
  for (let i = 0; i < 34; i++) {
    const a = noise() * Math.PI * 2;
    const r = 17 + Math.pow(noise(), 0.7) * 52;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const rad = 0.5 + noise() * 1.9;
    blob(S, x, FLOOR_Y + relief(x, z) + rad * 0.35, z, rad, noise, ROCK);
  }

  // 隣の区画。円筒＋短い連絡通路。
  // 建物が1つだけだと施設ではなく「箱」で、大きさも分からない
  // 34m だと窓の半分を塞ぐ「壁」になり、遠くの建物に見えなかった。
  // 48m まで下げると、霧の向こうの影として読める
  const ma = winAngles.length ? winAngles[0] + 0.30 : 0.8;
  const MD = 48;
  const mBase = FLOOR_Y + rise(MD) + 0.4;
  const mx = Math.cos(ma) * MD, mz = Math.sin(ma) * MD;
  cylinder(S, mx, mBase, mz, 5.2, 7.0, STEEL);
  strut(S, [mx, mBase + 4.0, mz],
        [Math.cos(ma) * (hullR + 1.0), deckY + 1.6, Math.sin(ma) * (hullR + 1.0)],
        0.75, STEEL2);

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
  group.add(new THREE.Mesh(S.geo(), mat(HULL_FRAG, { side: THREE.DoubleSide })));

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

  // やぐらの頭にも小さな灯。色を変えて、区画の標識と区別する
  const mastLights = masts.map((p, i) => {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0x9fe8c0, toneMapped: false }));
    m.position.set(p[0], p[1], p[2]);
    m.userData.ph = i * 0.37;
    group.add(m);
    return m;
  });

  return {
    update(t) {
      // 2.6秒周期でひと呼吸。ずっと点いていると人工物に見えない
      const ph = (t % 2.6) / 2.6;
      const on = Math.exp(-Math.pow((ph - 0.12) * 9.0, 2));
      beacon.material.color.setRGB(1.0 * (0.10 + on), 0.16 * (0.10 + on), 0.10 * (0.10 + on));
      beacon.scale.setScalar(0.6 + on * 0.7);
      for (const m of mastLights) {
        // ゆっくり明滅。全部が同時に点くと電飾になる
        const k = 0.55 + 0.45 * Math.sin(t * 0.8 + m.userData.ph * 6.0);
        m.scale.setScalar(0.7 + k * 0.5);
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
