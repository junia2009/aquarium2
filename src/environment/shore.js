import * as THREE from 'three';
import { baseUniforms, U, WORLD } from '../env.js';
import { UW_FRAG_PRELUDE, UW_FRAG_OUTPUT, UW_SKY } from '../glsl.js';
import { fbm3, noise3 } from '../noise.js';
import { ContactShadows } from './contactShadow.js';

// ============ 磯(岩礁海岸) ============
//
// ここまでの4ゾーンは、どれも「水の中」の話だった。水面はいつも頭上の
// 天井で、位置が変わることもなかった。
//
// 磯は水際そのものが主役になる。潮が満ちれば岩が沈み、引けば現れる。
// 波が寄せれば水は岩を駆け上がり、引けば泡だけが残る。同じ岩が
// 1分後には濡れて黒く、5分後には乾いて白い。
//
// この「濡れているかどうかの履歴」が、磯のすべてを決めている。
// 生き物がどこに住めるかも、岩が何色に見えるかも。

// ---- 潮 ----
// 実際の潮汐は半日周期だが、それでは誰も満ち引きを見られない。
// 3分でひと回りさせる。干満差は2.2m——日本の太平洋岸の大潮くらい。
export const TIDE = {
  mean: WORLD.surfaceY,   // 平均水面。ほかのゾーンと同じ16
  amp: 1.1,               // 片振幅。満潮 17.1 / 干潮 14.9
  period: 180,            // 秒
};

/** t 秒における潮位 */
export function tideAt(t) {
  return TIDE.mean + TIDE.amp * Math.sin((t / TIDE.period) * Math.PI * 2 - Math.PI * 0.5);
}

// ---- 波の打ち寄せ ----
// 潮位の上にもう一段、数秒周期のうねりが乗る。これが岩を駆け上がって
// 戻る「波」になる。単純な正弦にすると機械的なので、周期の違う3つを
// 重ねて、たまに大きいのが来るようにする(実際、磯で待っていると
// 数分に一度だけ足元まで届く波が来る)
export function surgeAt(t) {
  return 0.30 * Math.sin(t * 0.62)
       + 0.20 * Math.sin(t * 0.41 + 1.7)
       + 0.14 * Math.sin(t * 0.23 + 4.1);
}

/** いまの水際の高さ(潮位 + 波の打ち上げ) */
export function waterAt(t) { return tideAt(t) + surgeAt(t); }

// ---- 地形 ----
// -Z が沖、+Z が陸。断面は沖で急に落ち、潮間帯でいったん平らな棚になり、
// そこから陸へ立ち上がる。この「棚」が磯の主役で、干満差のなかに
// すっぽり収まっていないと、潮が引いても現れる岩がない。
const PROFILE = [
  [-40, 1.0], [-30, 4.2], [-22, 8.4], [-15, 12.2], [-10, 14.2],
  [-5, 15.35], [0, 15.75], [5, 16.15], [9, 16.75], [14, 18.2],
  [20, 20.4], [28, 23.2], [40, 27.0],
];

function profileAt(z) {
  if (z <= PROFILE[0][0]) return PROFILE[0][1];
  const last = PROFILE[PROFILE.length - 1];
  if (z >= last[0]) return last[1];
  for (let i = 0; i < PROFILE.length - 1; i++) {
    const [z0, y0] = PROFILE[i], [z1, y1] = PROFILE[i + 1];
    if (z <= z1) {
      const t = (z - z0) / (z1 - z0);
      return y0 + (y1 - y0) * (t * t * (3 - 2 * t));   // なめらかに繋ぐ
    }
  }
  return last[1];
}

// ---- 潮だまり ----
// 岩の窪みに取り残された水。磯でいちばん見たいものなので、
// 偶然できるのに任せず、置く場所を決めておく。
//
// r は半径、depth は縁からの深さ。縁(rim)と底(floor)の実高は
// 地形から測って後で埋める。
//
// 深さは実物どおり浅く。10〜50cmしかない。
//
// 最初これを1.6mの窪みにしていたら、干潮の海面(14.9m)より底が
// 低くなり、世界じゅうに敷いてある海面の一枚板が窪みの中に顔を出した。
// 岩に空いた穴から海が覗いて、白く光って見えた原因はこれ。
// 潮だまりの底は、いちばん潮が引いたときの海面より上になければならない。
export const POOLS = [
  { x: -7.5, z: 1.5, r: 3.4, depth: 0.42 },
  { x: 4.0, z: -1.0, r: 2.6, depth: 0.34 },
  { x: 11.5, z: 3.5, r: 2.1, depth: 0.28 },
  { x: -15.0, z: 5.0, r: 1.7, depth: 0.24 },
  { x: 0.5, z: 6.5, r: 1.4, depth: 0.20 },
];

/**
 * 潮だまりの皿。
 *
 * 「地形から一定の深さを引く」やり方はやめた。傾いた岩の上では
 * それは窪みにならない。実際そうなって、皿の中央が自分のこぼれ口より
 * 1.3m 高い「斜面のくぼみ」ができ、水は溜まりようがなかった。
 *
 * 深さではなく、目標の高さまで削る。中央は floor、縁で rim へ戻る皿。
 * 岩がそれより低いところは埋めない(岩を足すと地形が盛り上がる)。
 * こうすれば、どんな傾きの上でも必ず水の溜まる窪みになる
 */
function poolFloorAt(x, z, base) {
  let y = base;
  for (const p of POOLS) {
    const d = Math.hypot(x - p.x, z - p.z);
    // 効き目は半径の1.5倍まで伸ばす。半径ぴったりで打ち切ると、
    // そこに垂直な壁が立つ。周りの岩が縁より1m高い窪みでは、
    // 円筒形の穴を岩にドリルで開けたような形になっていた
    const R = p.r * 1.5;
    if (d >= R) continue;
    const u = Math.min(d / p.r, 1);
    // 皿。中央は底、縁で rim
    const dish = p.floor + (p.rim - p.floor) * u * u * u;
    // 縁の外では地形の高さへ戻していく
    const t = Math.min(Math.max((d - p.r) / (R - p.r), 0), 1);
    const w = 1 - t * t * (3 - 2 * t);
    y = Math.min(y, dish * w + base * (1 - w));
  }
  return y;
}

// ---- 節理 ----
// 岩がノイズの丘と決定的に違うのは、「割れている」こと。
// 岩盤には節理(joint)が走っていて、地表は多角形のブロックの集まりになる。
// ブロックごとに数cmずつ段差があり、境目には溝が走る。
//
// この構造が無いと、どれだけ細かいノイズを足しても
// 「なめらかな起伏にざらつきを塗ったもの」にしかならない。
// ボロノイでセルを切り、セルごとに高さをずらして境に溝を掘る。
//
// 溝は地形として彫る。色で描くのではなく実際に凹ませておくと、
// 焼いた遮蔽(cav)が自動的に暗くしてくれる——描画と形が食い違わない
function hash2(i, j) {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  const t = Math.sin(i * 269.5 + j * 183.3) * 43758.5453;
  return [s - Math.floor(s), t - Math.floor(t)];
}

function joints(x, z) {
  const px = Math.floor(x), pz = Math.floor(z);
  let f1 = 9, f2 = 9, id = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = px + dx, cz = pz + dz;
      const [hx, hz] = hash2(cx, cz);
      const d = Math.hypot(x - (cx + hx), z - (cz + hz));
      if (d < f1) { f2 = f1; f1 = d; id = hx * 0.63 + hz * 0.37; }
      else if (d < f2) { f2 = d; }
    }
  }
  return { id, edge: f2 - f1 };
}

// fbm3 は 0〜1 のあいだを動くので、平均は0ではない。値はオクターブ数で
// 決まる(2段 0.375 / 3段 0.437 / 4段 0.468。実測)。
//
// 高さに足すときは、これを引いてからでなければならない。
// 引き忘れていたせいで、上の4つの fbm 項だけで地形が +0.98m 持ち上がり、
// 干満(14.9〜17.1m)のなかにあるはずの潮間帯の棚が 17.9m にあった。
// 潮がひと巡りしても水際は画面の外にしか現れず、手前はいつでも
// からからに乾いた岩の平原だった。「磯に見えない」の半分はこれ。
const FBM_MEAN = [0, 0.250, 0.375, 0.437, 0.468];
const fbmC = (x, z, oct) => fbm3(x, 0, z, oct) - FBM_MEAN[oct];

/**
 * 磯の高さ場。
 * 岩は砂と違って「面」ではなく「割れて積み重なったもの」なので、
 * なめらかなノイズだけだと粘土の丘になる。段(ベンチ)と割れ目を入れる。
 */
function rockBase(x, z) {
  // 岬と入り江。これは「高さを足す」のではなく「断面を前後にずらす」。
  // 高さで足していたときは、たまたま見える範囲(x -30..16)で
  // sin がずっと正で、平均 +1.4m の下駄を履いていた。
  // そもそも岬とは岸の線が沖へ張り出すことなので、z をずらすのが正しい。
  // こうすると水際そのものが蛇行し、高さには下駄を履かせない
  const cape = Math.sin(x * 0.075) * 5.0 + Math.sin(x * 0.031 + 2.2) * 7.5;
  let y = profileAt(z + cape);
  // 潮間帯の棚のあたりでだけ強く効かせる。沖と陸では薄める
  const bench = Math.exp(-Math.pow((z - 2) / 16, 2));
  // 岩塊。粗いうねりから細かい凹凸まで3段。ここを1段で済ませると
  // 「なめらかな丘」になり、どれだけ色を岩にしても砂丘に見える
  y += fbmC(x * 0.055, z * 0.055, 3) * 1.5;
  y += fbmC(x * 0.17 + 11, z * 0.17, 3) * 0.55;
  y += fbmC(x * 0.52 + 41, z * 0.52, 2) * 0.16;
  // 段。堆積岩の層が波に削られると階段状の棚になる。
  // 高さを量子化するだけで、粘土の丘が割れた岩に変わる。
  // 磯全体に効かせること——潮間帯だけ段にすると、そこだけ床材に見える
  const step = 0.60;
  y += (Math.round(y / step) * step - y) * (0.42 + 0.34 * bench);
  // 割れ目。細く深い溝が岸に直交して何本も走る。
  // 幅は数十cm。ここを広くすると溝ではなく谷になる
  const seam = Math.abs(Math.sin(x * 0.62 + noise3(x * 0.03, 0, z * 0.03) * 3.0));
  y -= Math.pow(1 - Math.min(seam * 7.0, 1), 2) * 0.55 * (0.4 + 0.6 * bench);
  // 岸に平行な層理面の隙間も一組
  const bed = Math.abs(Math.sin(z * 0.48 + noise3(x * 0.04, 0, z * 0.02) * 2.2));
  y -= Math.pow(1 - Math.min(bed * 8.0, 1), 2) * 0.30 * bench;
  // 節理。2.4m角のブロックに割り、ブロックごとに段差をつけて境に溝を掘る。
  // これが岩を「割れたもの」に見せる。さらに細かい割れも一段重ねる
  const j1 = joints(x * 0.42, z * 0.42);
  y += (j1.id - 0.5) * 0.40;
  y -= Math.pow(1 - Math.min(j1.edge * 4.5, 1), 2) * 0.26;
  const j2 = joints(x * 1.35 + 50, z * 1.35);
  y += (j2.id - 0.5) * 0.13;
  y -= Math.pow(1 - Math.min(j2.edge * 5.5, 1), 2) * 0.085;
  // 3段目。25cm角の細かい割れ。頂点が7cm刻みになったぶん、
  // ここまで彫っておかないと、細かくした頂点が表すものが無い
  const j3 = joints(x * 4.0 + 130, z * 4.0);
  y += (j3.id - 0.5) * 0.045;
  y -= Math.pow(1 - Math.min(j3.edge * 6.0, 1), 2) * 0.030;
  // 岩肌そのもののざらつき。10〜30cmの起伏
  y += fbmC(x * 1.7 + 77, z * 1.7, 2) * 0.055;
  return y;
}

/** 磯の高さ場(潮だまりの窪みまで入れた最終形) */
export function shoreTerrain(x, z) {
  const base = rockBase(x, z);
  // POOLS の rim/floor が決まるのは下の探索のあと。それまでは素の岩
  return poolsReady ? poolFloorAt(x, z, base) : base;
}
let poolsReady = false;

// 縁の高さは地形から測る。手で置くと必ず地形とずれて、
// 「水面が岩にめり込んでいる」か「宙に浮いている」かのどちらかになる。
// いちばん低い縁がこぼれ口になり、そこまでしか水は溜まらない
function rimAt(x, z, r) {
  let lo = Infinity;
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    lo = Math.min(lo, rockBase(x + Math.cos(a) * r * 1.04, z + Math.sin(a) * r * 1.04));
  }
  return lo;
}

// ---- 置く場所も地形から探す ----
// x,z を手で決めて縁の高さだけ測る、というやり方をしていた。
// そのあと地形の底上げを直したら、地形が1.7m下がって、
// 大きい2つの溜まりの底が干潮面(14.9m)より低くなった。
// 世界じゅうに敷いてある海の一枚板が底から顔を出して白く光る、
// 以前に一度踏んだ穴を、そのまま踏み直したことになる。
//
// 潮だまりとは「潮が引いているあいだ水が残っている窪み」で、
// 成立する条件は高さで決まっている。
//   ・縁が満潮(17.1m)より低い  → 満潮には水没して海と繋がる
//   ・底が干潮(14.9m)より高い  → 引いても水が残る
//   ・縁が平均潮位より少し上    → 何時間も干上がって見える
// なら、その高さの場所を地形に探させればよい。手で置いてはいけない。
//
// 岸に直交する z 方向が高さの勾配なので、x は活かして z だけを動かす。
// 見た目の散らばりは保たれる
const POOL_BAND = [TIDE.mean + 0.15, TIDE.mean + 0.90];
const POOL_TARGET = (POOL_BAND[0] + POOL_BAND[1]) / 2;
for (const p of POOLS) {
  let bestZ = p.z, bestRim = rimAt(p.x, p.z, p.r), bestCost = Infinity;
  for (let i = 0; i <= 72; i++) {
    // 元の位置を中心に ±9m。近いほうを優先する(意図した配置を壊さない)
    const z = p.z + (i / 72 * 2 - 1) * 9.0;
    const rim = rimAt(p.x, z, p.r);
    if (rim < POOL_BAND[0] || rim > POOL_BAND[1]) continue;
    // もともと窪んでいる場所を選ぶ。中央が縁より高い斜面に皿を切ると、
    // 削り取る量が1mを超えて、岩に丸い穴を開けたようになる
    const mound = rockBase(p.x, z) - rim;
    const cost = Math.abs(rim - POOL_TARGET) + mound * 0.9 + Math.abs(z - p.z) * 0.06;
    if (cost < bestCost) { bestCost = cost; bestZ = z; bestRim = rim; }
  }
  p.z = bestZ;
  p.rim = bestRim;
  // 底は必ず干潮面より上。探索が空振りしても、ここで守られる
  p.floor = Math.max(bestRim - p.depth, TIDE.mean - TIDE.amp + 0.10);
  p.depth = bestRim - p.floor;
}
poolsReady = true;

// ---- 描かれている高さ ----
// 岩は190mを480分割した格子で描いていて、頂点と頂点のあいだは
// 線形補間される。一方 shoreTerrain() は連続関数なので、両者は食い違う。
// とくに節理の溝は幅4cmしかないので、7cm刻みの頂点はその底を拾えず、
// 関数だけが深く落ちる。
//
// 生き物を shoreTerrain() の高さに置くと、この差のぶんだけ岩に沈む。
// 実測で -22cm〜+12cm ずれていた。カニは甲幅3〜7cmなので、
// 自分の体の3倍も埋まるか、宙に浮くかのどちらかになっていた。
// 「常にめり込んでいる」「薄っぺらい」の正体はこれ。
//
// 流氷でペンギンが氷にめり込んだときとまったく同じ構図で、
// 教訓も同じ——描くものと、その上に立たせるものは、
// 同じ高さの出どころを見ていなければならない。
const MESH_SIZE = 190, MESH_SEG = 480;
const MESH_HALF = MESH_SIZE / 2;
const meshWarp = (u) => u * (0.20 + 0.80 * u * u);
const GRID = new Float64Array(MESH_SEG + 1);
for (let i = 0; i <= MESH_SEG; i++) GRID[i] = meshWarp((i / MESH_SEG) * 2 - 1) * MESH_HALF;

/** 座標 v を含む格子セルの番号と、その中での位置(0〜1) */
function meshCell(v, out) {
  if (v <= GRID[0]) { out.i = 0; out.t = 0; return out; }
  if (v >= GRID[MESH_SEG]) { out.i = MESH_SEG - 1; out.t = 1; return out; }
  let lo = 0, hi = MESH_SEG;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (GRID[mid] <= v) lo = mid; else hi = mid;
  }
  out.i = lo;
  out.t = (v - GRID[lo]) / (GRID[lo + 1] - GRID[lo]);
  return out;
}
const _cx = { i: 0, t: 0 }, _cz = { i: 0, t: 0 };

/**
 * いま画面に描かれている岩の高さ。
 * 生き物を置くときは必ずこちらを使う。shoreTerrain() は
 * メッシュを作るときだけのもの。
 *
 * 4隅を双線形に混ぜてはいけない。1マスは四角ではなく三角2枚で、
 * 対角線で折れている。双線形はその折れを無視して四角の「捻れ」の
 * 半分ぶんずれる——実測でまだ3cmあり、甲幅3cmのカニ1匹ぶんだった。
 * PlaneGeometry の分割は (a,b,d)(b,c,d)、つまり対角は
 * 「x+ 側の手前」と「z+ 側の奥」を結ぶ線。tx+tz で三角を選び、
 * その3頂点が張る平面をそのまま読む
 */
export function meshHeightAt(x, z) {
  meshCell(x, _cx); meshCell(z, _cz);
  const x0 = GRID[_cx.i], x1 = GRID[_cx.i + 1];
  const z0 = GRID[_cz.i], z1 = GRID[_cz.i + 1];
  const tx = _cx.t, tz = _cz.t;
  if (tx + tz <= 1) {
    // 手前側の三角。(x0,z0) (x1,z0) (x0,z1)
    const h00 = shoreTerrain(x0, z0);
    return h00 + (shoreTerrain(x1, z0) - h00) * tx + (shoreTerrain(x0, z1) - h00) * tz;
  }
  // 奥側の三角。(x1,z1) (x0,z1) (x1,z0)
  const h11 = shoreTerrain(x1, z1);
  return h11 + (shoreTerrain(x0, z1) - h11) * (1 - tx) + (shoreTerrain(x1, z0) - h11) * (1 - tz);
}

/** そこが潮だまりの中なら、その定義を返す */
export function poolAt(x, z) {
  for (const p of POOLS) if (Math.hypot(x - p.x, z - p.z) < p.r) return p;
  return null;
}

/**
 * その地点の「水面」。潮だまりの中では、海が引いても縁の高さまで水が残る。
 * 生き物の判定にも描画にも同じ関数を使う——別々に持つと必ずずれる
 */
export function localWater(x, z, sea) {
  const p = poolAt(x, z);
  if (!p) return sea;
  // 縁いっぱいには溜まらない。少し蒸発・浸透したぶん下がる
  return Math.max(sea, Math.min(p.rim - 0.06, p.rim));
}

// ============ 岩の表面 ============
// 磯の岩の色は、その高さが「1日のうちどれだけ水に浸かるか」で決まる。
// 上から順に、乾いた岩・黒い地衣類・フジツボ・イガイ・海藻。
// この帯状分布(zonation)は世界中の岩礁で見られるもので、
// 磯を磯に見せているのはほとんどこれ。
//
// ただし帯だけではハリボテになる。実際そうなった。原因はペンギンの
// 羽毛のときとまったく同じで、粗さが「色」にしか入っていなかったこと。
// メッシュは50cm刻みなので、法線を揺らさないかぎり光の当たり方は
// なめらかなまま——どれだけ色を岩にしても、粘土の塊に見える。
//
// 岩を岩に見せているのは3つ。
//   1. 細かい凹凸。cm単位の起伏が無数に光を拾う
//   2. 窪みの暗さ。割れ目や皿の底は空が見えないぶん暗い(遮蔽)
//   3. 転がっている石。磯は「一枚の地形」ではなく、割れた岩の集積
//
// 地形も転石も同じ見え方でなければならないので、ここに関数として括り出して
// 両方のシェーダから呼ぶ。別々に書くと必ず色が食い違う。
const SHORE_SURFACE = (n) => /* glsl */ `
uniform float uTide;
uniform float uWater;
uniform float uWetTop;
uniform vec4 uPools[${n}];

// 岩肌の細かい凹凸。返すのは「起伏の高さ(メートル)」。
// 単位を決めておかないと、勾配を法線に足すときの大きさが決まらない。
//
// ここを 0.55 / 0.30 / 0.15 という無次元の値にしていたのが、
// 岩が薄っぺらく見えた原因だった。いちばん細かい成分は周期3cmなので、
// 高さ0.15mの起伏が3cmごとに上下することになり、勾配は9を超える。
// それを法線に足せば、元の面の向きは完全に消える。
// 結果、どの面も同じ明るさになって、立体感がまるごと失われていた。
//
// 実際の岩肌の凹凸は、粗いうねりで3cm、細かい粒で数mm。
float rockBump(vec2 p) {
  return fbm(p * 2.2) * 0.058 + fbm(p * 8.0) * 0.021 + fbm(p * 22.0) * 0.008;
}

// 法線を岩肌の起伏で曲げる。遠くではちらつくので距離で消す
vec3 rockNormal(vec3 wp, vec3 n, float amt) {
  if (amt < 0.01) return n;
  // 差分の幅は、いちばん細かい成分(周期4.5cm)より小さく取る。
  // 大きいとその成分を飛ばしてしまい、勾配が出鱈目になる
  float e = 0.018;
  float b0 = rockBump(wp.xz);
  float bx = rockBump(wp.xz + vec2(e, 0.0));
  float bz = rockBump(wp.xz + vec2(0.0, e));
  // 勾配は無次元(面の傾きそのもの)。だいたい0.3=17度に収まる
  vec3 g = vec3(-(bx - b0), 0.0, -(bz - b0)) / e;
  return normalize(n + g * amt);
}

/**
 * 磯の岩の見え方。地形にも転石にも同じものを使う。
 * cav は窪み具合(0=平ら 1=深い窪み)。遮蔽の代わりに使う
 */
/**
 * 岩盤にも転石にも同じものを使うが、2つだけ違いを受け取る。
 *
 * lith   … 岩種による色みの倍率。岩盤は vec3(1) で「この磯の岩の色」。
 *          転石は流れ着いた石なので、玄武岩・凝灰岩・石英と色がばらつく
 * growth … 生き物の付きやすさ。岩盤は 1。
 *          転石は波に転がされるので、フジツボもイガイも定着できない。
 *          動かない substrate にしか帯状分布は生まれない——
 *          これは見た目の都合ではなく、そういう理屈でそうなっている
 */
vec3 shoreSurfaceEx(vec3 wp, vec3 nIn, float cav, float bumpAmt,
                    vec3 lith, float growth) {
  float h = wp.y;
  vec3 n = rockNormal(wp, normalize(nIn), bumpAmt);

  // ---- 地色 ----
  // 反射率は低く保つこと。乾いた岩でも0.2〜0.3、濡れれば0.1を切る。
  // ここを0.5にしていたら、水上の直射日光で真っ白に飛んだ
  float grain = fbm(wp.xz * 0.55) * 0.5 + fbm(wp.xz * 2.4) * 0.3;
  // 色のむらに使うほうは 0〜1 に戻して使う。
  // rockBump はメートルを返すようになったので、そのままでは効かない
  float fine = fbm(wp.xz * 8.0);
  // 日本の磯の岩はたいてい灰色(安山岩・凝灰岩)で、褐色ではない。
  // ここを茶色にしていたら全体が砂丘のような色になった
  vec3 dry = mix(vec3(0.104, 0.106, 0.107), vec3(0.188, 0.190, 0.188), grain);
  // 層理。堆積岩は高さ方向に色の縞が出る
  dry = mix(dry, vec3(0.140, 0.138, 0.132), fbm(vec2(wp.x * 0.22, wp.y * 1.6)) * 0.5);
  // 鉄分のしみ。一様に掛けると岩ぜんたいが錆色になるので、
  // 狭い範囲に濃く出す。まだらであることに意味がある
  dry = mix(dry, vec3(0.205, 0.140, 0.088),
            smoothstep(0.66, 0.82, fbm(wp.xz * 0.31 + 21.0)) * 0.50);
  // 濡れて乾いたあとに残る塩と、削れて出た新しい面の白っぽさ
  dry = mix(dry, vec3(0.315, 0.312, 0.300),
            smoothstep(0.62, 0.78, fbm(wp.xz * 0.85 + 7.0)) * 0.45);
  // 細かい凹凸そのものの陰影。法線だけでなく色も少し振る
  dry *= 0.86 + 0.28 * fine;
  // 岩種。転石だけがここで色を変える
  dry *= lith;

  // ---- 帯状分布 ----
  // 基準は平均潮位に固定する。いまの水位を基準にすると、
  // 波が来るたびにフジツボの帯が上下に泳いでしまう
  float rel = h - ${TIDE.mean.toFixed(2)};
  float weed = smoothstep(-0.30, -1.30, rel) * (0.55 + 0.45 * fbm(wp.xz * 0.38));
  float mussel = smoothstep(-1.05, -0.55, rel) * smoothstep(0.15, -0.25, rel)
               * smoothstep(0.20, 0.32, fbm(wp.xz * 0.46));
  // フジツボ。しきい値を 0.18〜0.30 にしていたら、fbm はほぼ常に
  // これを超えるので、帯のなかが「一面びっしり」の板になっていた。
  // マスクだけを描かせて確かめたら、手前の岩ぜんたいが100%だった。
  // 実際の被度は4〜8割で、素の岩が筋や面で抜ける。2段の斑で抜かす
  float barn = smoothstep(-0.15, 0.30, rel) * smoothstep(1.35, 0.75, rel)
             * smoothstep(0.30, 0.58, fbm(wp.xz * 0.58))
             * (0.42 + 0.58 * smoothstep(0.34, 0.62, fbm(wp.xz * 1.9)));
  float lichen = smoothstep(1.10, 1.70, rel) * smoothstep(3.4, 2.2, rel)
               * smoothstep(0.26, 0.44, fbm(wp.xz * 0.32));
  // 転がる石には付かない
  weed *= growth; mussel *= growth; barn *= growth; lichen *= growth;

  vec3 col = dry;
  col = mix(col, vec3(0.046, 0.042, 0.035), lichen * 0.92);
  // フジツボは石灰質の殻。粒立ちがあるので、細かいノイズで白を散らす。
  //
  // 反射率は 0.76 ではなく 0.42。0.76 にしていたら、水上の直射日光
  // (環境光+直射で照度が約1.9)を掛けた時点で1を超え、トーンマッピングで
  // 真っ白に飛んで、磯が雪原に見えていた。
  // フジツボの殻は白いが、殻と殻のあいだは影なので、面としての
  // 反射率は 0.3〜0.4 にしかならない
  col = mix(col, vec3(0.420, 0.406, 0.376) * (0.62 + 0.55 * fine), barn * 0.90);
  col = mix(col, vec3(0.022, 0.022, 0.036), mussel * 0.95);
  col = mix(col, vec3(0.034, 0.048, 0.020), weed * 0.95);
  col = mix(col, vec3(0.098, 0.176, 0.068),
            weed * smoothstep(0.52, 0.74, fbm(wp.xz * 0.72)) * 0.7);

  // 上を向いた面ほど生き物が付く……のだが、ここを厳しくしすぎると
  // 帯が消える。段々に削れた岩は法線が寝ていないので、
  // smoothstep(0.35, 0.85, n.y) では全面が「壁」と判定されて
  // 帯が15%まで薄まり、一様な灰色の岩になっていた。
  // 実際のフジツボもイガイも垂直な岩壁にびっしり付く
  float up = smoothstep(0.02, 0.55, n.y);
  col = mix(dry, col, 0.38 + 0.62 * up);

  // ---- 濡れ ----
  float sub = smoothstep(0.05, -0.10, h - uWater);
  float damp = smoothstep(0.02, -0.55, h - uWetTop);
  float inPool = 0.0;
  for (int i = 0; i < ${n}; i++) {
    vec4 pl = uPools[i];
    inPool = max(inPool, smoothstep(pl.z, pl.z * 0.90, length(wp.xz - pl.xy))
                       * smoothstep(0.04, -0.10, h - pl.w));
  }
  float wet = max(max(sub, inPool), damp * 0.72);
  col *= mix(1.0, 0.58, wet);
  // 窪みは乾きにくい。割れ目の底に水が残っているのが磯の見え方
  col *= mix(1.0, 0.72, cav * (1.0 - wet) * 0.6);

  // ---- 遮蔽 ----
  // 割れ目や皿の底は空が見えないぶん暗い。これが無いと、
  // どれだけ凹凸を作っても平らな板に模様を描いたようにしか見えない
  float ao = 1.0 - cav * 0.62;

  vec3 viewDir = normalize(cameraPosition - wp);
  // 濡れた岩は光るが鏡ではない。0.55にしていたら潮だまりの皿で
  // ハイライトが広がり、岩に空いた穴が発光しているように見えた
  vec3 lit = underwaterLight(col * ao, n, wp, viewDir,
                             mix(8.0, 42.0, wet), mix(0.015, 0.10, wet));

  // ---- 泡 ----
  // 水際の白。波が砕けた線と、引いたあとに残る泡の名残
  float lineF = smoothstep(0.30, 0.0, abs(h - uWater))
              * (0.45 + 0.55 * fbm(vec2(wp.x * 3.4, wp.z * 3.4 + uTime * 1.6)));
  float left = smoothstep(0.0, 0.45, h - uWater) * smoothstep(0.75, 0.10, h - uWater)
             * smoothstep(0.45, 0.75, fbm(vec2(wp.x * 5.0, wp.z * 5.0 - uTime * 0.7)));
  float foam = clamp(lineF * 0.85 + left * 0.6, 0.0, 1.0) * up;
  lit = mix(lit, vec3(0.92, 0.95, 0.96), foam);

  return applyUnderwaterFog(lit, wp);
}

/** 岩盤。この磯の岩の色で、生き物も普通に付く */
vec3 shoreSurface(vec3 wp, vec3 nIn, float cav, float bumpAmt) {
  return shoreSurfaceEx(wp, nIn, cav, bumpAmt, vec3(1.0), 1.0);
}
`;

/** 岩と転石が共有するユニフォーム */
function shoreUniforms() {
  return {
    ...baseUniforms(),
    uTide: { value: TIDE.mean },
    uWater: { value: TIDE.mean },
    uWetTop: { value: TIDE.mean },
    // 潮だまり (x, z, 半径, 水面の高さ)。岩のほうにも渡さないと、
    // 溜まりの中の岩が「乾いた岩」に塗られる。覗きこんで見えているのは
    // 水の膜ではなく、ほとんど「濡れて黒くなった底」のほうだから
    uPools: { value: POOLS.map((p) => new THREE.Vector4(p.x, p.z, p.r, p.rim - 0.06)) },
  };
}

export function createShoreRock(parent) {
  const size = MESH_SIZE, seg = MESH_SEG;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const N = seg + 1;
  const H = size / 2;

  // ---- 頂点を中央に寄せる ----
  // 190mを均等に割ると1マス50cmになる。カメラは岩の3〜10m先にいるので、
  // 50cmのマスは画面上で数十ピクセルあり、稜線にポリゴンの折れが出る。
  // 法線をいくら揺らしてもシルエットは直らない——陰影の問題ではなく
  // 解像度の問題だから。
  //
  // 見たいのは潮間帯(原点から20mほど)で、その外側は粗くてよい。
  // 同じ頂点数のまま、間隔を中央で細かく・外周で粗くする。
  // 中央で7cm、外周で1m。格子の並びは変えないので、遮蔽を焼くときの
  // 隣接インデックスはそのまま使える
  // 歪めかたは meshHeightAt と共有する。ここがずれたら
  // 「描かれている高さ」を返せなくなる
  for (let i = 0; i < pos.count; i++) {
    pos.setX(i, meshWarp(pos.getX(i) / H) * H);
    pos.setZ(i, meshWarp(pos.getZ(i) / H) * H);
  }
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, shoreTerrain(pos.getX(i), pos.getZ(i)));
  }
  geo.computeVertexNormals();

  // ---- 窪み具合を焼く ----
  // まわりより低いところは空が見えないぶん暗い。これを入れないと、
  // 割れ目も皿の底も同じ明るさで、凹凸が「模様」にしか見えない。
  //
  // 地形関数を points ぶん呼び直すと数百万回になるので、
  // 格子であることを使って隣の頂点をそのまま読む
  const cav = new Float32Array(pos.count);
  const gridY = (ix, iz) => pos.getY(Math.min(Math.max(iz, 0), N - 1) * N
                                   + Math.min(Math.max(ix, 0), N - 1));
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const y = gridY(ix, iz);
      let sum = 0, cnt = 0;
      // 近傍と中距離の2段。近いほうが割れ目、遠いほうが皿を拾う
      for (const k of [1, 3, 7]) {
        sum += gridY(ix - k, iz) + gridY(ix + k, iz)
             + gridY(ix, iz - k) + gridY(ix, iz + k);
        cnt += 4;
      }
      // まわりの平均より何m低いか。0.8mでほぼ真っ黒な窪みとみなす
      cav[iz * N + ix] = Math.min(Math.max((sum / cnt - y) / 0.8, 0), 1);
    }
  }
  geo.setAttribute('aCav', new THREE.BufferAttribute(cav, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: shoreUniforms(),
    vertexShader: /* glsl */ `
      attribute float aCav;
      varying vec3 vW;
      varying vec3 vN;
      varying float vCav;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        vCav = aCav;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: UW_FRAG_PRELUDE + SHORE_SURFACE(POOLS.length) + /* glsl */ `
      varying vec3 vW;
      varying vec3 vN;
      varying float vCav;
      void main() {
        // 細かい凹凸は近くでだけ。遠くで出すと画面がざらついて
        // 岩ではなくノイズになる
        float amt = 0.55 * (1.0 - smoothstep(6.0, 34.0, distance(cameraPosition, vW)));
        gl_FragColor = vec4(shoreSurface(vW, vN, vCav, amt), 1.0);
        ${UW_FRAG_OUTPUT}
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -4;
  parent.add(mesh);
  return { mesh, mat };
}

// ============ 転石 ============
// 磯は「一枚の地形」ではなく、割れた岩が積み重なった場所。
// 波に転がされた石が platform の上に散らばっていて、これが無いと
// どれだけ地形を作りこんでも「一枚の起伏」にしか見えない。
//
// 角は取れているが丸くはない。正20面体の頂点をばらして平面で囲むと、
// 「割れて、少し転がされた石」の形になる。
function boulderGeometry(seed) {
  // 面の数。もとは detail=1(80面)を非インデックス化して平らな面のまま
  // 使っていた。地表に出るのが直径の2割だけだった頃はそれで足りたが、
  // 4割出すようにしたら、1m先で角ばった水晶のかたまりに見えた。
  //
  // 転石は波に転がされて丸くなった石なので、稜線があってはいけない。
  // 面を増やし、法線もつないで滑らかにする。肌のざらつきは
  // 断面ではなく shoreSurface() の法線ゆらぎのほうで出す
  // ——地形のときに学んだのと同じ切り分け
  const g = new THREE.IcosahedronGeometry(1, 2);   // 320面
  const p = g.getAttribute('position');
  const o = seed * 3.7;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // 向きの滑らかな関数で膨らませる。頂点ごとの乱数だと棘になる。
    // 粗い瘤で±20%、細かい起伏で±6%
    const f = 1.0
      + fbmC(x * 1.6 + o, z * 1.6 + y * 1.6, 3) * 0.40
      + fbmC(x * 4.3 + o + 31, z * 4.3 + y * 4.3, 2) * 0.12;
    // 縦を潰す。転がって落ち着いた石は平たい
    p.setXYZ(i, x * f, y * f * 0.72, z * f);
  }
  g.computeVertexNormals();
  return g;
}

export function createBoulders(parent, count = 190) {
  let s = 20250816;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const geo = boulderGeometry(7);
  const mat = new THREE.ShaderMaterial({
    uniforms: shoreUniforms(),
    vertexShader: /* glsl */ `
      // xyz: 岩種の色み倍率 / w: 生き物の付きやすさ
      attribute vec4 aStone;
      varying vec3 vW;
      varying vec3 vN;
      varying float vCav;
      varying vec4 vStone;
      void main() {
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        // 石の下側は地面との隙間で暗い。石そのものの側の遮蔽で、
        // 地面側に落ちる接地影(ContactShadows)と対になっている
        vCav = smoothstep(0.25, -0.75, vN.y) * 0.85;
        vStone = aStone;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: UW_FRAG_PRELUDE + SHORE_SURFACE(POOLS.length) + /* glsl */ `
      varying vec3 vW;
      varying vec3 vN;
      varying float vCav;
      varying vec4 vStone;
      void main() {
        float amt = 0.75 * (1.0 - smoothstep(5.0, 26.0, distance(cameraPosition, vW)));
        gl_FragColor = vec4(
          shoreSurfaceEx(vW, vN, vCav, amt, vStone.rgb, vStone.a), 1.0);
        ${UW_FRAG_OUTPUT}
      }
    `,
  });

  // ---- 岩種 ----
  // 転石は「そこで割れた岩」ではなく「流れ着いた石」なので、岩盤と
  // 同じ色をしている必要がない。実際の磯の石は必ず何種類か混じっていて、
  // その混ざりぐあいが「岩盤の上に石が載っている」と教えている。
  // 岩盤とまったく同じ色・同じ陰影で塗っていたら、地表に出しても
  // 岩と石の見分けがつかなかった。
  //
  // 日本の太平洋岸の磯にあるあたり。倍率は岩盤の灰色(反射率0.10〜0.19)に
  // 掛ける値なので、いちばん白い石英でも 0.19*1.95 = 0.37 に収まる
  const LITH = [
    { c: [1.00, 1.00, 1.00], w: 34 },   // 安山岩。岩盤と同じ、割れて落ちたもの
    { c: [0.70, 0.73, 0.80], w: 20 },   // 玄武岩。青みの濃い灰
    { c: [1.52, 1.46, 1.30], w: 20 },   // 凝灰岩。乾くと白っぽい黄土
    { c: [1.34, 1.02, 0.78], w: 15 },   // 鉄分で赤褐色に染まったもの
    { c: [0.55, 0.58, 0.56], w:  7 },   // 黒っぽい緻密な石
    { c: [1.95, 1.92, 1.84], w:  4 },   // 石英。ときどき白いのが混じる
  ];
  const LITH_TOTAL = LITH.reduce((a, l) => a + l.w, 0);
  const pickLith = (u) => {
    let t = u * LITH_TOTAL;
    for (const l of LITH) { t -= l.w; if (t <= 0) return l.c; }
    return LITH[0].c;
  };

  const stone = new Float32Array(count * 4);
  geo.setAttribute('aStone', new THREE.InstancedBufferAttribute(stone, 4));
  const bodies = [];
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.frustumCulled = false;
  // 転石の接地影。地形にいちばん効くのはここ——生き物は数cmだが、
  // 石は20cm〜1mあって、いつでも画面に写っている
  const shadow = new ContactShadows(parent, count, U.uSunDir.value);
  const nv = new THREE.Vector3();
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const sv = new THREE.Vector3(), pv = new THREE.Vector3();
  let placed = 0;
  for (let i = 0; i < count * 6 && placed < count; i++) {
    const x = (rnd() - 0.5) * 74;
    const z = -26 + rnd() * 46;
    // 潮だまりの中には置かない。皿の底に岩を積むと水が見えなくなる
    if (poolAt(x, z)) continue;
    // 転石も「描かれている岩の高さ」に乗せる。関数の高さに置くと
    // 節理の溝ぶん(最大22cm)沈み、直径40cmの石が半分埋まる
    const y = meshHeightAt(x, z);
    // 大きい石は下のほう(波に転がされて溜まる)、上は小石だけ
    const high = Math.min(Math.max((y - TIDE.mean) / 3.0, 0), 1);
    const size = (0.22 + rnd() * rnd() * 1.15) * (1 - high * 0.55);
    e.set(rnd() * 0.7 - 0.35, rnd() * Math.PI * 2, rnd() * 0.7 - 0.35);
    q.setFromEuler(e);
    // 埋める量。0.30(直径の3割)にしていたのは、置く高さがまだ
    // shoreTerrain() だった時代の埋め合わせだった。当時は最大22cm
    // 勝手に沈んでいたので、そのうえ3割埋めれば地表に出るのは2割だけ。
    // 直径35cmの石が7cmの瘤にしかならず、岩肌のざらつき(±5.5cm)に
    // 埋もれて、190個あるのに1つも見えていなかった。
    //
    // 高さが正確になり、接地影も付いたので、素直に「載せる」。
    // 少し落ち着いたぶんだけ埋めて、直径の4割強を地表に出す
    pv.set(x, y - size * 0.08, z);
    sv.set(size * (0.85 + rnd() * 0.5), size, size * (0.85 + rnd() * 0.5));
    m.compose(pv, q, sv);
    // 半径 R の丸い石が高度 θ の日射で落とす影は、短径 R・長径 R/sinθ の
    // 楕円で、足元から R/tanθ ずれる。ここは R = size/2、sinθ = 0.86 なので
    // 影のいちばん遠い縁は接地点から 1.77R = 0.89*size にある。
    //
    // 最初これを直径 size*1.25(=1.25R)で置いたら、影が石の輪郭より
    // 内側にしか出ず、石自身にすっかり隠れた。差分を測っても
    // 「影を入れても画面が1画素も変わらない」という結果になった。
    // 影は物の影より広くなければ見えない
    const e2 = 0.14;
    nv.set(-(meshHeightAt(x + e2, z) - meshHeightAt(x - e2, z)), 2 * e2,
           -(meshHeightAt(x, z + e2) - meshHeightAt(x, z - e2))).normalize();
    shadow.place(placed, x, y, z, size * 1.30, size * 0.50, nv);

    // 岩種と、個体ごとの色みのゆらぎ(同じ岩種でも1つずつ違う)
    const lith = pickLith(rnd());
    const j = 0.88 + rnd() * 0.26;
    // 生き物の付きやすさ。転がされる石には定着できない。
    // どれくらい転がされるかは大きさで決まる——25cmの礫は時化のたびに
    // 転がるが、1.2mの巨礫はめったに動かないので、岩盤と同じように
    // フジツボもイガイも付く。見た目の都合ではなく、そういう理屈
    const growth = 0.05 + 0.85 * Math.min(Math.max((size - 0.30) / 0.85, 0), 1);
    stone[placed * 4 + 0] = lith[0] * j;
    stone[placed * 4 + 1] = lith[1] * j;
    stone[placed * 4 + 2] = lith[2] * j;
    stone[placed * 4 + 3] = growth;

    // ぶつかる形。楕円体の半径は幾何と同じ(縦は 0.72 倍に潰してある)
    if (size >= 0.70) {
      bodies.push({ x: pv.x, y: pv.y, z: pv.z,
                    rx: sv.x * 0.5, ry: sv.y * 0.36, rz: sv.z * 0.5 });
    }

    mesh.setMatrixAt(placed++, m);
  }
  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  geo.getAttribute('aStone').needsUpdate = true;
  shadow.commit(placed);
  parent.add(mesh);
  // 大きい石だけ、ぶつかる形を外へ渡す。カメラが地面の35cm上まで
  // 降りられるようになったので、入れておかないと巨礫をすり抜ける。
  // 小石まで入れるとカメラが礫の海に押されて動けなくなるので、
  // 「すり抜けたら気づく大きさ」だけにする
  return { mesh, mat, bodies };
}


// ============ 潮だまりの水面 ============
// 海が引いても、窪みの水は縁の高さで残る。海の一枚板とは別に、
// 小さな円盤を潮だまりごとに置く。海面がその縁より上にあるときは
// 隠す——二重に描くと水面が二枚重なって暗くなる。
export function createTidePools(parent) {
  const group = new THREE.Group();
  const discs = [];
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...baseUniforms() },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vW;
      varying vec2 vL;
      void main() {
        vL = position.xz;
        vec3 p = position;
        // 溜まり水はうねらない。風で細かく震えるだけ
        p.y += sin(p.x * 9.0 + uTime * 2.3) * 0.008
             + sin(p.z * 11.0 - uTime * 1.7) * 0.008;
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    // 空を映すので UW_SKY も要る(共通のプレリュードには入っていない)
    fragmentShader: UW_FRAG_PRELUDE + UW_SKY + /* glsl */ `
      varying vec3 vW;
      varying vec2 vL;
      void main() {
        vec3 viewDir = normalize(cameraPosition - vW);
        // 上から覗きこむ浅い水。ほとんど透けて、斜めから見ると空を映す。
        //
        // ただし映しすぎないこと。フレネルを素直に1まで持っていくと、
        // 浅い角度で見た溜まりが真っ白に飛んで、水ではなく光源になる
        // (実際そうなって、岩に空いた穴が発光しているように見えた)。
        // 溜まりの見えかたを決めているのは、映りこみよりも
        // 「濡れて黒くなった底」のほう
        float fres = pow(1.0 - clamp(abs(viewDir.y), 0.0, 1.0), 3.0) * 0.55;
        vec3 sky = skyColor(reflect(-viewDir, vec3(0.0, 1.0, 0.0))) * 0.62;
        // 水そのものの色。浅く、底の岩の色をかぶるので暗く緑がかる
        vec3 tint = uFogColor * 0.55;
        vec3 col = mix(tint, sky, clamp(fres, 0.0, 0.75));
        // 縁は薄くなって岩に溶ける。円板の切り口を見せない
        float edge = smoothstep(1.0, 0.86, length(vL));
        float a = mix(0.14, 0.62, fres) * edge;
        gl_FragColor = vec4(col, a);
        ${UW_FRAG_OUTPUT}
      }
    `,
  });

  for (const p of POOLS) {
    const geo = new THREE.CircleGeometry(1, 40);
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(p.x, p.rim - 0.06, p.z);
    m.scale.setScalar(p.r * 0.97);
    m.renderOrder = 56;
    group.add(m);
    discs.push({ mesh: m, pool: p });
  }
  parent.add(group);

  return {
    group,
    /** 海面が縁を越えたら隠す(海の水面が覆うので二重になる) */
    update(sea) {
      for (const d of discs) d.mesh.visible = sea < d.pool.rim - 0.05;
    },
  };
}
