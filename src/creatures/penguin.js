import * as THREE from 'three';
import { buildFishGeometry } from './fishGeometry.js';

// ============ ペンギン ============
//
// ペンギンは鳥である。
// 泳ぐ姿だけを見て作ると、どうしても「ひれの生えた紡錘形」——つまり魚か
// 小型の鯨になる。実際そうなった。鳥として通るために要るのは3つで、
// どれも欠けると一目で嘘だと分かる。
//
//   1. 翼。骨が癒合した一枚の硬い櫂で、関節がない。曲げるのではなく
//      肩から根元ごと振る。空を飛ぶ鳥とまったく同じ動作を水中でやる
//   2. 脚。羽毛の切れた先に、鱗に覆われた裸の跗蹠(ふしょ)と3本の趾が
//      出る。爪がある。この一節があるかないかが、鳥か海獣かを分ける
//   3. 尾。羽軸の詰まった硬い風切羽が扇に並んだもの。関節で振れる。
//      立つときはこれを後ろへ蹴り出して、足と三点で体を支える
//
// この3つのために、遊泳シェーダは体の波をほぼ切って、翼・首・尾・足首の
// 4つの関節を別々に回している(→ fishMaterial.js)。
//
// 4種は頭の模様で見分ける。体型はどれも同じ紡錘形なので、
// 大きさ・嘴の長さ・顔の描き分けがそのまま「種の違い」になる。

// ---- 体型 ----
// 太さ(hProfile)と体軸の上下(yOffset)を直接いじると、どこをどう動かせば
// 何が変わるのか分からなくなる。ザトウクジラで効いたやり方をここでも使う:
// まず「背の輪郭」と「腹の輪郭」を別々に決め、そこから
//   太さ  = (背 - 腹) / 2
//   体軸  = (背 + 腹) / 2
// を機械的に出す。横から見た形をそのまま数字にできるので、
// 「頭が小さい」「胸が浅い」といった直しがそのまま一箇所の修正になる。
//
// 泳ぐペンギンの横顔:
//   ・嘴の付け根の顔は細い。ここが太いと、嘴が壁から生えて見える
//   ・頭は t=0.1 の丸い塊。そのうしろの項(うなじ)で背の線が一度下がる
//   ・背の線は、そこから尾の手前までほとんど平ら。
//     ここが肝心で、背を魚のように弓なりに盛り上げた瞬間、
//     どれだけ寸法を合わせても小型の鯨にしか見えなくなる。
//     ペンギンの厚みは全部「腹側」に付いている
//   ・その腹はいちばん深いのが t=0.4〜0.5。そこから急に細らせない。
//     ペンギンは太い。立たせると見えるのは頭より下——つまり胸から腹に
//     かけての部分だけなので、ここが早く細ると一気に痩せて見える。
//     紡錘形ではなく洋梨だと思ったほうが近い
//   ・尻は丸い。ここを魚の尾柄のように細く絞ると、後ろ半分が
//     そのまま魚になる。ペンギンの尾は「丸い尻から突き出た小さな楔」で、
//     胴のほうは最後まで厚みを保ったまま終わる
//   ・頭は太らせない。体が太るほど頭は相対的に小さく見えるもので、
//     それがずんぐりした鳥の見え方そのもの
//   ・腹のいちばん深いところは思っているより「後ろ」にある。立たせると
//     t軸は上から下になるので、ここが前寄りだと胸から下がすぼまって、
//     洋梨ではなく雫の形になる。実際そうなっていた——立ち姿が
//     細く見えた原因の半分はこれで、太さそのものより配りかたの問題だった
const DORSAL  = [0.26, 0.77, 0.66, 0.82, 0.84, 0.84, 0.83, 0.82, 0.78, 0.62, 0.33];
const VENTRAL = [-0.13, -0.43, -0.55, -1.02, -1.16, -1.21, -1.21, -1.15, -1.00, -0.66, -0.22];
// 背と腹から太さと体軸を機械的に出す。H が「胴の最大半深さ」を意味するよう
// 最大値で正規化しておく
const H_RAW = DORSAL.map((d, i) => (d - VENTRAL[i]) / 2);
const H_MAX = Math.max(...H_RAW);
const H_PROFILE = H_RAW.map((x) => x / H_MAX);
const Y_PROFILE = DORSAL.map((d, i) => (d + VENTRAL[i]) / 2 / H_MAX);
// 幅。頭骨は細く、いちばん太いのは深さと同じ t=0.4〜0.5
// 首のくびれは、横から見た項の窪みより「上から見た細さ」のほうがよく効く
const W_PROFILE = [0.185, 0.575, 0.55, 0.86, 0.99, 1.00, 1.00, 0.98, 0.91, 0.70, 0.28];

// 断面積の平均が最大断面の何倍か。体重から寸法を出すのに要る。
// ここを「だいたい0.5」と目分量で置いていたが、上の表から積分すると
// 0.61 だった。1割以上ずれていて、そのぶん体が痩せていた
const SHAPE_FILL = (() => {
  let sum = 0;
  for (let i = 0; i < H_PROFILE.length; i++) {
    const w = (i === 0 || i === H_PROFILE.length - 1) ? 0.5 : 1;
    sum += H_PROFILE[i] * W_PROFILE[i] * w;
  }
  return sum / (H_PROFILE.length - 1);
})();

/**
 * 体重から胴の最大半深さ・半幅を出す。
 *
 * 体積 = π・H・W・胴長・SHAPE_FILL。ここで割る密度は「肉の密度」では
 * なく「羽毛の外形の見かけ密度」でなければならない。描いているのは
 * 羽毛の輪郭であって、中身ではない。ペンギンの羽は何層も重なって
 * 分厚い空気の層を抱えていて、休んでいる個体が背中を出して水に浮くのは
 * そのため。0.9(肉の密度)で割ると、その空気の層のぶんだけ体が痩せる。
 *
 * 断面の縦横比は 1.22。ペンギンの胴は円ではなく、わずかに背腹に高い。
 */
// 羽毛を含めた外形の見かけ密度。
//
// 0.68 にしていたが、それでも細いと言われて胴回りを計算したら74cmだった。
// オウサマペンギンの実測は75〜85cmなので、下限を割っていた。
//
// 効いているのは羽毛の空気層で、ペンギンの羽は2〜3cmの厚さの空気を
// 抱えている。半径11cmの胴に2.5cm足せば13.5cm——線寸で23%、体積なら
// 5割増える。描いているのはこの外側の輪郭なので、そのぶん
// 見かけ密度は肉より大きく下がる。陸では断熱のためさらに羽毛を立てる。
// 0.55 で胴回り82cm、実測のまん中に入る
const PLUMAGE_DENSITY = 0.55;
// 断面の縦横比(深さ/幅)。ペンギンの胴はわずかに背腹へ高いが、
// 竜骨突起の張った胸は横にも広い。1.2を超えると正面から見て板になる
const BODY_ASPECT = 1.12;
function girth(massKg, bodyLen) {
  const hw = (massKg / PLUMAGE_DENSITY / 1000) / (Math.PI * bodyLen * SHAPE_FILL);
  const width = Math.sqrt(hw / BODY_ASPECT);
  return { width, height: width * BODY_ASPECT };
}

// 翼の付け根。ここは fishGeometry の addPairedFin と必ず同じ値を使う。
// ずれるとシェーダの回転軸が肩から外れ、翼がもげたように動く
const WING_AT = 0.27;
const WING_LOW = -0.08;      // 負 = 体軸より上。肩は背寄りにある

// 翼の平面形(付け根→先端の弦長比)。ペンギンの翼は鯨類の胸びれと違い、
// 付け根がいちばん広く、そこから先端までまっすぐ細っていく。
// 中ほどが膨らむ既定の分布のままだと、櫂ではなく飛行機の主翼になる
const WING_CHORD = [1.00, 1.02, 1.00, 0.96, 0.90, 0.83, 0.75, 0.66, 0.56, 0.40, 0.05];

// ---- 尾の関節 ----
// 尾は胴から一直線に後ろへ伸びている。泳ぐときはそれでいいが、
// そのまま立たせると、体を起こしたぶん尾の先が真下へ降りて甲板に刺さり、
// 足のほうが宙に浮く。首と同じで、曲がらないなら曲げられるようにすればいい。
//   TAIL_PIVOT_T   尾を振る軸の位置(体長比)。尾骨の付け根
//   TAIL_FROM/TO   曲げの配分。ここより前は動かない
// 軸は体軸のわずかに背側に置く。尾骨は背側を通っているので、
// 腹側に置くと曲げたとき総排出腔のあたりが不自然に膨らむ
const TAIL_PIVOT_T = 0.87;
const TAIL_FROM = 0.86;
const TAIL_TO = 1.02;

// ---- 脚 ----
// 跗蹠の根元(羽毛の下)と足首。足首から先だけが関節で前へ倒れる。
// ANKLE_T を体のいちばん後ろの下端まで持っていかないと、立たせたとき
// 尻のほうが下まで垂れて足が地面に届かない
const HIP_T = 0.74;
const ANKLE_T = 0.95;
// 歩くとき脚を振る軸。ここから足裏までの長さが振り子の腕になり、
// 歩幅も歩調も速さも全部そこから決まるので、位置がそのまま歩き方になる。
// 羽毛の出口(0.86)に置くと腕が短すぎて、8cmの歩幅で小刻みに震える
// ことになった。実際の股関節はもっと体の奥にある
const HIP_PIVOT_T = 0.78;
// 振りの配分。軸のところで一点に折らず、羽毛から出るまでに配る。
// 跗蹠のローカル座標(0=根元 1=足首の先)で、軸が 0.14、出口が 0.55
const HIP_FROM = 0.14, HIP_TO = 0.55;
// 3本の前趾。開き(ラジアン、外向きが正)と長さの比。
// 中趾がいちばん長く、内趾がいちばん短い。3本を同じ長さにすると
// 蹼の後縁が円弧になって、鳥の足ではなく団扇になる
const TOE_DIR = [-0.34, 0.00, 0.36];
const TOE_LEN = [0.84, 1.00, 0.93];

// 立ち姿の体の傾き。接地の高さをジオメトリから逆算するのに要るので、
// 群れではなくモデル側に置いて共有する。
// 86度——ほぼ垂直。ペンギンの脚は体の後ろに付いていて、尾を地面に
// つけて三点で支えるので、体はまっすぐ立つ
export const STAND_PITCH = 1.50;
// 足首を回す角。体軸まわりにしか回せないので、「足裏が水平になって
// 趾が前を向く」角度は体の傾きから一意に決まる。目分量で入れると
// 足が斜めに浮くか、裏返る
export const STAND_FOOT = STAND_PITCH - Math.PI;

/**
 * 種ごとの寸法。total は嘴の先から尾柄まで(尾びれの張り出しはこの外)。
 * mass は体重(kg)で、胴の太さはそこから girth() が出す。
 *
 * 太さを目分量で決めると、必ず細長くなって鯨に見える。
 * だが体重から出しても痩せることがあって、そこで二度つまずいた。
 *   1回目 断面の平均率を「だいたい0.5」と置いていた。表から積分すると
 *         0.61 で、1割以上のずれ
 *   2回目 割る密度に肉の密度(0.9)を使っていた。描いているのは羽毛の
 *         輪郭なので、抱えている空気のぶん見かけはもっと軽い(0.75)
 * どちらも「式は合っているのに細い」という形で出てくるので、
 * 見た目の違和感から原因にたどり着くのが難しい。
 *
 * 体重は、氷に上がってくる時期のよく肥えた成鳥に合わせてある。
 * 換羽前の個体はさらに重い。
 *
 * total は尾羽の張り出しを含まないので、図鑑にある「全長」より短い。
 * ここを全長そのままにしていたぶん、どの種も1割ほど長すぎて、
 * 同じ体重でもそのぶん痩せて見えていた。
 */
export const PENGUIN_KINDS = {
  king: {
    key: 'king', species: 0, name: 'オウサマペンギン',
    total: 1.02, beak: 0.125, mass: 17,
    // キングの嘴は細長く、先端だけがわずかに下へ落ちる。
    // 下嘴の側面には長い橙色の板(嘴板)がある
    beakH: 0.0125, beakW: 0.0090, beakDroop: 0.008,
    // キングの翼は現生種でいちばん長い。体長の4割近くある
    flipper: { width: 0.400, len: 0.150, chord: 0.100, thick: 0.16 },
    tail: { len: 0.085, height: 0.30 },   // 尾は短い
    beatFreq: 1.55,   // 大きい種ほどゆっくり打つ
    speed: 2.4,
    // 息継ぎまでの潜水時間(秒)。実物は数分潜れるが、見ていて何も
    // 起きないので水槽の尺に縮めてある。とはいえ短くしすぎると、
    // 群れが息継ぎに往復しているところしか見えなくなる
    dive: 34,
    // 息継ぎのとき氷へ跳び乗る割合。大きく重い種ほど跳び乗りにくい。
    // 上がるときは群れごと上がるので、個体ごとに判じていた頃の半分でいい
    haulOutChance: 0.10,
    // --- 習性 ---
    // キングは深海性。海底近くまで潜って長く留まり、群れはばらける。
    // 息継ぎは静かに浮上するだけで、ポーポイジングはあまりしない
    depth: [0.12, 0.62],      // 遊泳層(0=海底 1=水面)
    cohesion: 0.55,           // 群れの密度
    hoverChance: 0.34,        // 立ち止まって漂う割合
    hoverTime: [3.5, 7.0],
    arcs: [1, 2],             // ポーポイジングの弧の本数
    standTime: [7, 14],       // 氷の上にいる時間
    turnRate: 1.8,            // 旋回の鋭さ
  },
  gentoo: {
    key: 'gentoo', species: 1, name: 'ジェンツーペンギン',
    total: 0.775, beak: 0.055, mass: 8.0,
    beakH: 0.0130, beakW: 0.0100, beakDroop: 0.004,
    flipper: { width: 0.390, len: 0.145, chord: 0.102, thick: 0.16 },
    // ジェンツーの尾は現生ペンギンでいちばん長い。歩くと氷を掃いていく。
    // この一本の刷毛が、この種をこの種に見せている
    tail: { len: 0.170, height: 0.38 },
    beatFreq: 2.05,
    speed: 3.1,       // 現生のペンギンでいちばん速い
    dive: 28,
    haulOutChance: 0.18,
    // ジェンツーは最速。浅い層を鋭く曲がりながら走り、
    // 息継ぎは連続したポーポイジングで済ませる。立ち止まることは少ない
    depth: [0.40, 0.92],
    cohesion: 1.4,
    hoverChance: 0.10,
    hoverTime: [2.0, 3.5],
    arcs: [2, 5],
    standTime: [8, 15],
    turnRate: 3.4,
  },
  adelie: {
    key: 'adelie', species: 2, name: 'アデリーペンギン',
    total: 0.685, beak: 0.042, mass: 5.7,
    // アデリーの嘴は半ば羽毛に埋もれていて、露出部が短く太い
    beakH: 0.0125, beakW: 0.0100, beakDroop: 0.002,
    flipper: { width: 0.375, len: 0.140, chord: 0.104, thick: 0.16 },
    tail: { len: 0.115, height: 0.34 },
    beatFreq: 2.25,
    speed: 2.6,
    dive: 26,
    haulOutChance: 0.26,   // 氷の上でいちばんよく見かける種
    // アデリーは群れがいちばん密。ひとかたまりで動き、
    // 氷へもよく上がって長く立っている
    depth: [0.45, 0.95],
    cohesion: 2.1,
    hoverChance: 0.20,
    hoverTime: [2.5, 5.0],
    arcs: [2, 4],
    standTime: [10, 20],
    turnRate: 2.8,
  },
  chinstrap: {
    key: 'chinstrap', species: 3, name: 'ヒゲペンギン',
    total: 0.700, beak: 0.042, mass: 5.0,
    beakH: 0.0125, beakW: 0.0098, beakDroop: 0.003,
    flipper: { width: 0.380, len: 0.142, chord: 0.102, thick: 0.16 },
    tail: { len: 0.120, height: 0.34 },
    beatFreq: 2.20,
    speed: 2.7,
    dive: 27,
    haulOutChance: 0.20,
    // ヒゲはよく漂う。水中で立ち止まってあたりを見回す時間が長い
    depth: [0.38, 0.90],
    cohesion: 1.2,
    hoverChance: 0.30,
    hoverTime: [3.0, 6.0],
    arcs: [2, 4],
    standTime: [12, 22],
    turnRate: 3.0,
  },
};

// ---- ジオメトリの連結 ----
// buildFishGeometry の出す属性(position/aBodyUV/aHeight/aPart)に合わせて、
// 嘴と脚を同じ1つのメッシュへ足し込む。インスタンス描画に載せるため、
// 部位ごとにメッシュを分けたくない。
function mergeInto(dst, src) {
  const base = dst.pos.length / 3;
  dst.pos.push(...src.pos);
  dst.uv.push(...src.uv);
  dst.h.push(...src.h);
  dst.part.push(...src.part);
  for (const i of src.idx) dst.idx.push(i + base);
}

// リング列から面を張る(位置は呼び出し側が決める)。
// hVal は aHeight に入れる値。脚では「跗蹠(0)か足(1)か」の区別に使い、
// シェーダはこれを見て足首から先だけを回す
function loft(rings, seg, pointAt, uvAt, partId, hVal = 0) {
  const pos = [], uv = [], h = [], part = [], idx = [];
  for (let i = 0; i <= rings; i++) {
    for (let j = 0; j <= seg; j++) {
      const p = pointAt(i / rings, j / seg);
      pos.push(p[0], p[1], p[2]);
      const q = uvAt(i / rings, j / seg);
      uv.push(q[0], q[1]);
      h.push(hVal);
      part.push(partId);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j, b = a + 1;
      const c = (i + 1) * (seg + 1) + j, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  return { pos, uv, h, part, idx };
}

// ---- 嘴 ----
// 顔の丸い先端から生え、先へ細く尖る。キングだけ極端に長い。
//
// 断面は円ではなく、上下に稜(りょう)を持った菱形に近い形にする。
// まん丸の円錐にすると、どうしても「刺さった棒」に見えてしまう。
// 合わせ目(口の線)は断面のいちばん横に張り出したところ、
// つまり v=0.5 にぴったり来るようにする。ここがずれると、
// シェーダ側の「下嘴だけ橙」の塗り分けが上下にはみ出す。
function buildBeak(kind, zBase) {
  const L = kind.beak;
  return loft(12, 16, (t, s) => {
    const a = s * Math.PI * 2;
    const cy = Math.cos(a), sx = Math.sin(a);
    // 太さは先の3割までほとんど変わらず、そこから急に尖る。
    // 根元から一様に細らせると、嘴ではなく錐(きり)になる
    const k = Math.pow(1 - Math.pow(t, 2.2) * 0.975, 0.42);
    // 上嘴のほうが厚い(下嘴は薄い板)
    const hh = kind.beakH * k * (cy > 0 ? 1.0 : 0.80);
    const ww = kind.beakW * k;
    // 上面の稜。断面を菱形寄りにして、丸棒に見せない
    const ridge = 1 + 0.20 * Math.pow(Math.max(cy, 0), 3.0);
    // ほぼまっすぐで、先端だけが鉤状に落ちる
    const droop = -kind.beakDroop * (t * t * 0.35 + Math.pow(t, 5) * 1.0);
    // 合わせ目でくびれさせる。1本の線が入るだけで棒が嘴になる。
    // ただし深くえぐると、そこが陰になって側面が丸ごと隠れ、
    // 下嘴の橙が「底のふちの線」にしか見えなくなる
    const seam = 1 - 0.12 * Math.exp(-Math.pow(cy / 0.16, 2.0));
    return [sx * ww * seam, droop + cy * hh * ridge, zBase + t * L];
  // v は断面の角度。0 に潰すと上下の塗り分けがまったく効かない
  }, (t, s2) => [t * 0.14, Math.cos(s2 * Math.PI * 2) * 0.5 + 0.5], 5);
}

// ---- 脚: 跗蹠(ふしょ)と趾 ----
//
// 鳥の脚は、途中で羽毛が切れて鱗に覆われた裸の部分が出る。
// 見えているのはいちばん先の一節——跗蹠と3本の前趾、そして爪だけで、
// 大腿も脛も羽毛の下、体のなかに折り畳まれている。
// この一節を省くと、どれだけ形を整えても鳥には見えない。
//
// 前は足を「尾の下から生えた蹼の板」として作っていた。それだと立たせた
// とき足首が体のなかほどにあることになり、尻のほうが下まで垂れて
// 足が宙に浮く。実際そうなっていた。跗蹠は体のいちばん後ろの下端
// (ANKLE_T)まで届いていなければならない。
//
// 足首は球関節として作る。跗蹠の先を足首を中心とした半球で閉じ、
// 足の踵をその球のなかから始めれば、いくら回しても継ぎ目が開かない。
//
//   aHeight = 0 : 跗蹠。体に固定されていて回らない
//   aHeight = 1 : 足。足首を軸に前へ倒れる
//
// 向きに注意。立つと体がほぼ垂直になるので、体の腹側(-y)は「前」を、
// 背側(+y)は「後ろ」を向く。足首を回すと表裏が入れ替わり、
// モデル座標の +y 側が世界の下——つまり足裏になる。
// だから趾の骨の盛り上がりは -y 側に、平らな足裏は +y 側に作る。
function buildLeg(kind, geom) {
  const parts = { pos: [], uv: [], h: [], part: [], idx: [] };
  const L = kind.total;
  const { zAt, ventralAt } = geom;
  // 実物の足は大きい。キングで13cmほどあり、これが体を支える面になる。
  // 泳ぎだけを考えて小さくすると、立たせたとき支えが無くて
  // 棒が刺さっているようにしか見えない
  const FOOT = L * 0.118;          // 足首から趾の先まで
  const TOE_R = L * 0.021;         // 趾の太さ
  // 左右の脚は正中線の近くに寄せる。外へ開くほど、そこの腹の面が
  // 丸みで持ち上がるぶん脚が早く羽毛から出て、鷺のような長い脚に見える
  const legX = L * 0.023;          // 片側の中心からの距離
  const rHip = L * 0.011, rAnkle = L * 0.024;
  const rAt = (w) => rHip + (rAnkle - rHip) * w;

  const zHip = zAt(HIP_T), zAnkle = zAt(ANKLE_T);
  // 跗蹠は羽毛の下では腹の線に沿わせ、足首でそこから下へ抜ける。
  // まっすぐな棒にすると腹の下に一本の桟が渡ってしまう
  // 腹の線より内側を走らせ、足首の手前で一気に抜ける。
  // 一様に降ろすと胴の下半分にずっと桟が渡っているように見えるので、
  // 降下は三乗で最後に寄せる。羽毛が切れるのは足首の少し手前だけ
  // 腹の面の高さは、正中線ではなく脚が通る x のところで測る。
  // 断面は楕円なので、中心から離れるほど面は持ち上がる。ここを中心の
  // 値で測ると、脚がその差のぶんだけ早く羽毛の外へ出てしまう
  const hug = (w) => {
    const t = HIP_T + (ANKLE_T - HIP_T) * w;
    return ventralAt(t, legX) + rAt(w) * 1.35;
  };
  const yAnkle = ventralAt(ANKLE_T, 0) - rAnkle * 0.62;
  const drop = yAnkle - hug(1);
  const yAxis = (w) => hug(w) + drop * w * w * w;

  const zPivot = zAt(HIP_PIVOT_T);
  const wPivot = (HIP_PIVOT_T - HIP_T) / (ANKLE_T - HIP_T);

  // 左右は別の部位番号にする(6=左 7=右)。歩くときは片脚ずつ別々に
  // 動かすので、シェーダがどちらの脚かを知らないと話にならない
  for (const side of [-1, 1]) {
    const x0 = side * legX;
    const partId = side > 0 ? 7 : 6;

    // --- 跗蹠 + 足首の球 ---
    // t の前半で棒、後半で足首を中心とした半球を閉じる
    mergeInto(parts, loft(12, 10, (t, s) => {
      const a = s * Math.PI * 2;
      let cx, cy, cz, r;
      if (t <= 0.72) {
        const w = t / 0.72;
        cx = x0; cy = yAxis(w); cz = zHip + (zAnkle - zHip) * w;
        r = rAt(w);
      } else {
        // 足首の球。中心は動かさず、半径だけを落として閉じる
        const b = ((t - 0.72) / 0.28) * Math.PI * 0.5;
        cx = x0; cy = yAnkle; cz = zAnkle - rAnkle * Math.sin(b);
        r = rAnkle * Math.cos(b);
      }
      return [cx + Math.sin(a) * r, cy + Math.cos(a) * r * 0.94, cz];
    }, (t, s) => [t, s], partId, 0));

    // --- 足: 3本の前趾と蹼 ---
    // 薄い膜を1枚張ると紙細工に見えるので、閉じた薄い立体にして、
    // 趾の骨が通るところだけ背側に厚みを盛る。蹼はそのあいだで薄い
    // 足裏は足首の球より下に出す。球のほうが下に残ると、踵の玉で
    // 立っていることになって足裏が地面から浮く
    const yFoot = yAnkle + rAnkle * 0.78;
    mergeInto(parts, loft(10, 26, (t, q) => {
      // q は断面を一周する。前半が足裏(+y)、後半が趾の背(-y)
      const across = q <= 0.5 ? q * 2 : (1 - q) * 2;   // 0=内側の縁 1=外側の縁
      const sole = q <= 0.5;
      // 趾は f = 0,1,2 の3本。縁は趾の外側へ少しはみ出させる。
      // 趾の中心を縁に置くと、上面と下面の輪が閉じず穴が開く
      const f = -0.42 + across * 2.84;
      const k = Math.min(Math.max(Math.floor(f), 0), 1);
      const ang = TOE_DIR[k] + (TOE_DIR[k + 1] - TOE_DIR[k]) * (f - k);
      const tl = TOE_LEN[k] + (TOE_LEN[k + 1] - TOE_LEN[k]) * (f - k);
      // 趾のあいだは蹼。後縁が2度えぐれた扇になる
      const ext = FOOT * tl * (1 - 0.19 * Math.abs(Math.sin(f * Math.PI)));
      const e = ext * (0.08 + 0.92 * t);
      // 趾の骨。3本のところだけ背が盛り上がる
      const ridge = Math.pow(Math.abs(Math.cos(f * Math.PI)), 2.5);
      const taper = Math.pow(1 - t * 0.62, 0.75);
      // 爪。趾の先で厚みを尖らせ、鉤状に下へ(モデルの +y へ)曲げる
      const ct = Math.max(0, (t - 0.86) / 0.14);
      const claw = ridge * ct * ct;
      // 縁で上面と下面をぴたりと閉じる
      const shut = Math.min(Math.sin(across * Math.PI) * 6, 1);
      const th = shut * (sole
        ? TOE_R * 0.17 * taper                                  // 足裏は平ら
        : -TOE_R * (0.18 + 0.82 * ridge) * taper * (1 - claw * 0.75));
      return [
        x0 + side * Math.sin(ang) * e,
        yFoot + th + claw * TOE_R * 0.45,
        zAnkle - Math.cos(ang) * e,
      ];
    }, (t, q) => [t, q <= 0.5 ? q * 2 : (1 - q) * 2], partId, 1));
  }
  return { parts, zAnkle, yAnkle, zPivot, yPivot: yAxis(wPivot) };
}

/**
 * 1羽ぶんのジオメトリ。胴・翼・尾は buildFishGeometry に任せ、
 * 嘴と脚をそこへ連結する。
 */
export function buildPenguinGeometry(kind) {
  const bodyLen = kind.total - kind.beak;
  const { height: H, width: W } = girth(kind.mass, bodyLen);
  // 顔は丸く前へ出す。ここを短くすると顔が壁になり、
  // 嘴が板から突き出した釘のように見える
  const noseFrac = 0.032;

  const body = buildFishGeometry({
    length: bodyLen, height: H, width: W,
    hProfile: H_PROFILE, wProfile: W_PROFILE, yOffset: Y_PROFILE,
    smooth: true,
    rings: 40, radial: 26,
    nose: { rings: 6, len: noseFrac, flat: 2.4 },
    // 尾。硬い風切羽が十数枚、水平の扇に並んだもの。
    // 長さは種でまるで違い、ジェンツーのそれは氷を掃くほど長い。
    // 魚の尾びれのように上下へ広げると即座に魚になるので、必ず水平に
    tail: { len: kind.tail.len, height: kind.tail.height, fork: 0.0, horizontal: true },
    dorsal: null,
    // 翼。骨が癒合した一枚の硬い櫂なので、クジラの胸びれと同じ立体の
    // 作り方をしつつ、瘤をなくし、平面形を付け根最大の一様テーパーにする
    pectoral: {
      shape: 'flipper', at: WING_AT, low: WING_LOW,
      width: kind.flipper.width, len: kind.flipper.len,
      chord: kind.flipper.chord, thick: kind.flipper.thick,
      knobs: 0, droop: 0.04,
      chordProfile: WING_CHORD, sweepLin: 0.55,
      segs: 40, chordSegs: 10,
    },
  });

  // プロファイルの線形サンプル。付け根の位置を出すのに使う
  const s = (arr, t) => {
    const x = Math.min(Math.max(t, 0), 1) * (arr.length - 1);
    const i = Math.min(Math.floor(x), arr.length - 2);
    const f = x - i;
    return arr[i] * (1 - f) + arr[i + 1] * f;
  };

  const dst = {
    pos: Array.from(body.attributes.position.array),
    uv: Array.from(body.attributes.aBodyUV.array),
    h: Array.from(body.attributes.aHeight.array),
    part: Array.from(body.attributes.aPart.array),
    idx: Array.from(body.index.array),
  };

  // 嘴は顔の丸みの途中から生やす。先端の一点で閉じるところまで待つと
  // 嘴の付け根に細い円錐の首が見えてしまう
  const zNose = bodyLen / 2;
  mergeInto(dst, buildBeak(kind, zNose + noseFrac * bodyLen * 0.80));

  // 体の station(t)を実寸へ直す関数。尾びれのぶん胴が少し詰まるので、
  // buildFishGeometry と同じ式を使わないと脚が数センチずれる
  const bodySpan = bodyLen - kind.tail.len * bodyLen * 0.15;
  const zAt = (t) => zNose - t * bodySpan;
  // 体の腹側の面。x を渡すと、その断面位置での高さを返す(断面は楕円)
  const ventralAt = (t, x = 0) => {
    const hw = Math.max(s(W_PROFILE, t) * W, 1e-4);
    const k = Math.sqrt(Math.max(1 - Math.pow(Math.min(Math.abs(x) / hw, 1), 2), 0));
    return (s(Y_PROFILE, t) - s(H_PROFILE, t) * k) * H;
  };
  const leg = buildLeg(kind, { zAt, ventralAt });
  mergeInto(dst, leg.parts);

  const geo = new THREE.BufferGeometry();
  geo.setIndex(dst.idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(dst.pos, 3));
  geo.setAttribute('aBodyUV', new THREE.Float32BufferAttribute(dst.uv, 2));
  geo.setAttribute('aHeight', new THREE.Float32BufferAttribute(dst.h, 1));
  geo.setAttribute('aPart', new THREE.Float32BufferAttribute(dst.part, 1));
  geo.computeVertexNormals();

  // 翼の付け根。シェーダはここを軸に翼を振る。
  // w は翼の張り出し。シェーダはこれで「付け根から何割か」を測り、
  // 体に埋まった内端を動かさずにおく
  geo.userData.wingRoot = new THREE.Vector4(
    s(W_PROFILE, WING_AT) * W * 0.9,
    s(Y_PROFILE, WING_AT) * H - s(H_PROFILE, WING_AT) * H * WING_LOW,
    zNose - WING_AT * bodyLen,
    kind.flipper.width * bodyLen
  );
  // 首の付け根(y, z)。シェーダはここを軸に頭だけを前へ倒す。
  // 体型プロファイルのくびれ(t=0.2)と必ず同じ位置にすること
  // 軸を体の中心に置くと、曲げたとき喉がつぶれて背が伸びる。
  // 実際の頸椎は背側を通っているので、軸も項(うなじ)寄りに置く
  const NECK_T = 0.22;
  geo.userData.neckPivot = new THREE.Vector2(
    (s(Y_PROFILE, NECK_T) + s(H_PROFILE, NECK_T) * 0.45) * H,
    zNose - NECK_T * bodyLen
  );
  // 尾の付け根(y, z)と曲げの配分。シェーダはここを軸に尾を後ろへ蹴り出す
  geo.userData.tailPivot = new THREE.Vector4(
    (s(Y_PROFILE, TAIL_PIVOT_T) + s(H_PROFILE, TAIL_PIVOT_T) * 0.30) * H,
    zAt(TAIL_PIVOT_T), TAIL_FROM, TAIL_TO
  );
  // 足首(y, z)と、歩くとき脚を振る軸(y, z)。1本のベクトルにまとめて渡す
  geo.userData.footPivot = new THREE.Vector4(
    leg.yAnkle, leg.zAnkle, leg.yPivot, leg.zPivot);
  Object.assign(geo.userData, solveStand(dst, geo.userData, kind));
  geo.userData.length = kind.total;
  return geo;
}

/**
 * 立ち姿の接地を、ジオメトリから解く。
 *
 * 「体をこれだけ起こして、尾をこれだけ曲げて、足をこう倒せば立つはず」
 * と式で書くと必ず外れる。二度やって二度とも外れた——一度目は尾が甲板に
 * 刺さり、二度目は足が宿に浮いた。だから頂点をシェーダとまったく同じだけ
 * CPU で動かして、実際にいちばん下に来るものを測る。
 *
 * 返すもの:
 *   standBend  尾の曲げ角。足裏より下に残るものが無くなるまで曲げる
 *   standDrop  体の原点から足裏までの深さ。甲板からの浮かせ量そのもの
 *   standHalfW 接地点の左右の広がり。よちよち歩きで傾けたときの補正に使う
 *   standFwd   接地点が体の真下からどれだけ前にあるか
 *   hipDrop    体の原点から脚を振る軸まで
 *   legReach   その軸から足裏まで。歩幅と歩調はこの長さで決まる
 *   standClear 足裏より上に残った余裕(負なら何かが甲板を突き抜けている)
 */
function solveStand(dst, ud, kind) {
  const cp = Math.cos(STAND_PITCH), sp = Math.sin(STAND_PITCH);
  const fc = Math.cos(STAND_FOOT), fs = Math.sin(STAND_FOOT);
  const tp = ud.tailPivot, fp = ud.footPivot;
  // モデル座標の点が、立ち姿で甲板からどれだけ下に来るか
  const depth = (y, z) => -(y * cp + z * sp);

  // --- 足裏 ---
  const sole = [];
  // --- 尾を曲げれば持ち上がるもの(胴と尾) ---
  // 翼は畳んでも肩から体長の3割ほどしか下りず、甲板には遠く届かない。
  // 掃引の再現が要るだけの見返りが無いので外してある
  const bendable = [];
  // --- 何をしても動かないもの(嘴と跗蹠) ---
  // これを曲げの探索に混ぜてはいけない。跗蹠の先の踵は足裏のすぐ上に
  // あるので、混ぜると「いくら尾を曲げても余裕が出ない」ことになって
  // 探索が上限まで走り、尾が背中へ跳ね上がる(実際そうなった)
  const fixed = [];
  for (let i = 0; i < dst.part.length; i++) {
    const part = dst.part[i];
    if (part > 2.5 && part < 4.5) continue;
    const x = dst.pos[i * 3], y = dst.pos[i * 3 + 1], z = dst.pos[i * 3 + 2];
    if (part > 5.5 && dst.h[i] > 0.5) {
      // 足首を軸に前へ倒す
      const dy = y - fp.x, dz = z - fp.y;
      sole.push([Math.abs(x), fp.x + dy * fc - dz * fs, fp.y + dy * fs + dz * fc]);
    } else if (part < 0.5 || Math.abs(part - 1) < 0.5) {   // 胴と尾
      const u = dst.uv[i * 2];
      const e = Math.min(Math.max((u - tp.z) / (tp.w - tp.z), 0), 1);
      bendable.push([y, z, e * e * (3 - 2 * e)]);
    } else {
      fixed.push([y, z]);
    }
  }

  let standDrop = -Infinity, standHalfW = 0, standFwd = 0, nContact = 0;
  for (const p of sole) standDrop = Math.max(standDrop, depth(p[1], p[2]));
  for (const p of sole) {
    if (depth(p[1], p[2]) <= standDrop - kind.total * 0.02) continue;
    standHalfW = Math.max(standHalfW, p[0]);
    // 接地点は体の真下ではなく、少し前にある。甲板の高さを体の位置で
    // 引くと、雪の斜面の上で足が数センチ浮いたり埋まったりする
    standFwd += -p[1] * sp + p[2] * cp;
    nContact++;
  }
  if (nContact) standFwd /= nContact;
  // 歩きの寸法。振り子の腕の長さは「脚を振る軸から足裏まで」で、
  // 歩幅も歩調も速さも、ぜんぶここから出る(→ penguinFlock の gait)
  const hipDrop = depth(fp.z, fp.w);
  const legReach = standDrop - hipDrop;

  // 尾を少しずつ曲げて、足裏より下に残るものが無くなる角度を探す。
  // 曲げ足りないと尾が甲板に刺さり、曲げすぎると尾が背中へ跳ね上がる。
  // 尾の長さは種で倍以上違うので、ここを定数にはできない
  const want = kind.total * 0.006;
  let standBend = 0.85, standClear = -1;      // 最低でもこれだけは曲げる
  for (let a = 0.85; a <= 1.75; a += 0.01) {
    let deepest = -Infinity;
    for (const [y, z, w] of bendable) {
      const ta = a * w;
      const c = Math.cos(ta), sn = Math.sin(ta);
      const dy = y - tp.x, dz = z - tp.y;
      deepest = Math.max(deepest, depth(tp.x + dy * c - dz * sn, tp.y + dy * sn + dz * c));
    }
    standBend = a;
    standClear = standDrop - deepest;
    if (standClear >= want) break;
  }
  // 動かないものも含めた本当の余裕。負なら甲板を突き抜けている
  for (const [y, z] of fixed) standClear = Math.min(standClear, standDrop - depth(y, z));
  return { standBend, standDrop, standHalfW, standFwd, standClear, hipDrop, legReach };
}
