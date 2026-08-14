import * as THREE from 'three';
import { buildFishGeometry } from './fishGeometry.js';

// ============ ペンギン ============
//
// 水中を「飛ぶ」鳥。ここまでの3ゾーンの生き物とは推進の仕組みが根本から違う。
//   ・魚は体をくねらせ(進行波)、イルカは尾を上下に振る。
//     ペンギンは体をほとんど曲げず、板状の翼を打ち下ろして進む。
//   ・その翼には関節がない。骨が癒合して一枚の硬い櫂になっていて、
//     曲げるのではなく肩から根元ごと振る。
//   ・脚は尾のうしろへ畳んで舵にする。水中では歩く道具ではない。
// だから遊泳シェーダも、体の波をほぼ切って翼の回転だけで進ませる。
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
//   ・その腹はいちばん深いのが t=0.4 あたり
//   ・尻は丸い。ここを魚の尾柄のように細く絞ると、後ろ半分が
//     そのまま魚になる。ペンギンの尾は「丸い尻から突き出た小さな楔」で、
//     胴のほうは最後まで厚みを保ったまま終わる
const DORSAL  = [0.28, 0.82, 0.70, 0.78, 0.79, 0.78, 0.75, 0.71, 0.66, 0.50, 0.30];
const VENTRAL = [-0.14, -0.46, -0.56, -0.90, -1.04, -1.02, -0.95, -0.83, -0.64, -0.42, -0.18];
// 背と腹から太さと体軸を機械的に出す。H が「胴の最大半深さ」を意味するよう
// 最大値で正規化しておく
const H_RAW = DORSAL.map((d, i) => (d - VENTRAL[i]) / 2);
const H_MAX = Math.max(...H_RAW);
const H_PROFILE = H_RAW.map((x) => x / H_MAX);
const Y_PROFILE = DORSAL.map((d, i) => (d + VENTRAL[i]) / 2 / H_MAX);
// 幅。頭骨は細く、いちばん太いのは深さと同じ t=0.4
// 首のくびれは、横から見た項の窪みより「上から見た細さ」のほうがよく効く
const W_PROFILE = [0.20, 0.62, 0.56, 0.82, 1.00, 0.98, 0.93, 0.82, 0.66, 0.47, 0.22];

// 翼の付け根。ここは fishGeometry の addPairedFin と必ず同じ値を使う。
// ずれるとシェーダの回転軸が肩から外れ、翼がもげたように動く
const WING_AT = 0.27;
const WING_LOW = -0.05;      // 負 = 体軸より上。肩は背寄りにある

// 翼の平面形(付け根→先端の弦長比)。ペンギンの翼は鯨類の胸びれと違い、
// 付け根がいちばん広く、そこから先端までまっすぐ細っていく。
// 中ほどが膨らむ既定の分布のままだと、櫂ではなく飛行機の主翼になる
const WING_CHORD = [1.00, 1.02, 1.00, 0.96, 0.90, 0.83, 0.75, 0.66, 0.56, 0.40, 0.05];

/**
 * 種ごとの寸法。total は嘴の先から尾柄まで(尾びれの張り出しはこの外)。
 * height/width は胴の最大「半」深さ・半幅なので、見た目の胴回りはこの倍。
 *
 * 胴の長さと太さは体重から決めた。プロファイルの断面積の平均は最大断面の
 * 約 0.50 倍なので、体積 ≈ π・H・W・胴長・0.50。羽毛が空気を抱えるぶん
 * ペンギンの見かけ密度は水よりわずかに軽い(だいたい 0.9)。
 * この計算をせずに目分量で決めると、必ず細長くなって鯨に見える——
 * 実際、最初の2回はそれで失敗した。
 *   キング13kg → 15L、ジェンツー6.5kg → 7.6L、
 *   アデリー4.5kg → 5.3L、ヒゲ4.0kg → 4.7L
 */
export const PENGUIN_KINDS = {
  king: {
    key: 'king', species: 0, name: 'オウサマペンギン',
    total: 1.02, beak: 0.125, height: 0.114, width: 0.093,
    // キングの嘴は細長く、先端だけがわずかに下へ落ちる。
    // 下嘴の側面には長い橙色の板(嘴板)がある
    beakH: 0.0125, beakW: 0.0090, beakDroop: 0.008,
    flipper: { width: 0.335, len: 0.145, chord: 0.078, thick: 0.16 },
    beatFreq: 1.55,   // 大きい種ほどゆっくり打つ
    speed: 2.4,
    // 息継ぎまでの潜水時間(秒)。実物は数分潜れるが、
    // 見ていて何も起きないので水槽の尺に縮めてある
    dive: 26,
    // 息継ぎのとき氷へ跳び乗る割合。大きく重い種ほど跳び乗りにくい
    haulOutChance: 0.16,
  },
  gentoo: {
    key: 'gentoo', species: 1, name: 'ジェンツーペンギン',
    total: 0.80, beak: 0.055, height: 0.089, width: 0.073,
    beakH: 0.0130, beakW: 0.0100, beakDroop: 0.004,
    flipper: { width: 0.330, len: 0.140, chord: 0.080, thick: 0.16 },
    beatFreq: 2.05,
    speed: 3.1,       // 現生のペンギンでいちばん速い
    dive: 20,
    haulOutChance: 0.30,
  },
  adelie: {
    key: 'adelie', species: 2, name: 'アデリーペンギン',
    total: 0.72, beak: 0.042, height: 0.077, width: 0.063,
    // アデリーの嘴は半ば羽毛に埋もれていて、露出部が短く太い
    beakH: 0.0125, beakW: 0.0100, beakDroop: 0.002,
    flipper: { width: 0.320, len: 0.135, chord: 0.082, thick: 0.16 },
    beatFreq: 2.25,
    speed: 2.6,
    dive: 17,
    haulOutChance: 0.42,   // 氷の上でいちばんよく見かける種
  },
  chinstrap: {
    key: 'chinstrap', species: 3, name: 'ヒゲペンギン',
    total: 0.74, beak: 0.042, height: 0.072, width: 0.059,
    beakH: 0.0125, beakW: 0.0098, beakDroop: 0.003,
    flipper: { width: 0.325, len: 0.138, chord: 0.080, thick: 0.16 },
    beatFreq: 2.20,
    speed: 2.7,
    dive: 18,
    haulOutChance: 0.36,
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

// リング列から面を張る(位置は呼び出し側が決める)
function loft(rings, seg, pointAt, uvAt, partId, closed = true) {
  const pos = [], uv = [], h = [], part = [], idx = [];
  for (let i = 0; i <= rings; i++) {
    for (let j = 0; j <= seg; j++) {
      const p = pointAt(i / rings, j / seg);
      pos.push(p[0], p[1], p[2]);
      const q = uvAt(i / rings, j / seg);
      uv.push(q[0], q[1]);
      h.push(0);
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

// ---- 脚と蹼(みずかき) ----
// 水中では尾の左右下に揃えて畳み、舵として使う。立ち姿の脚を付けると、
// それだけで「陸の鳥が水に浮いている」絵になってしまう。
// 蹼が3本の趾(あしゆび)のあいだに張るので、後縁が2度えぐれた扇になる。
//
// 最初は尾のすぐ下に薄い板を寝かせただけで、どの向きから見ても
// 尾に溶けて消えてしまった。尾より一段下げ、外へ少し開き、
// 足裏をわずかに下へ向けて陰影が付くようにしてある。
function buildFeet(kind, zTail, yTail) {
  const parts = { pos: [], uv: [], h: [], part: [], idx: [] };
  const L = kind.total;
  const FOOT = L * 0.075;          // 踵から趾の先まで。尾より短い
  const TOE = L * 0.048;           // 外側の趾の張り出し
  for (const side of [-1, 1]) {
    const x0 = side * L * 0.026;
    mergeInto(parts, loft(6, 12, (t, s) => {
      // s: 内側の趾(0) → 外側の趾(1)。t: 踵(0) → 趾の先(1)
      const spread = TOE * Math.pow(t, 0.62);
      // 蹼のたわみ。趾は3本なので、あいだに2つの窪みができる
      const web = 1 - 0.22 * Math.pow(Math.sin(s * Math.PI * 3.0), 2.0) * Math.pow(t, 1.3);
      const lateral = (s - 0.15) * spread * web;     // 内側の趾はほぼ体軸に沿う
      return [
        x0 + side * lateral,
        // 外へ行くほどわずかに下がる。真っ平らに寝かせると陰影が付かず消える
        yTail - L * 0.010 * t - Math.abs(lateral) * 0.28,
        zTail - t * FOOT,
      ];
    }, (t, s) => [t, s], 6));
  }
  return parts;
}

/**
 * 1羽ぶんのジオメトリ。胴・翼・尾は buildFishGeometry に任せ、
 * 嘴と脚をそこへ連結する。
 */
export function buildPenguinGeometry(kind) {
  const bodyLen = kind.total - kind.beak;
  const H = kind.height, W = kind.width;
  // 顔は丸く前へ出す。ここを短くすると顔が壁になり、
  // 嘴が板から突き出した釘のように見える
  const noseFrac = 0.032;

  const body = buildFishGeometry({
    length: bodyLen, height: H, width: W,
    hProfile: H_PROFILE, wProfile: W_PROFILE, yOffset: Y_PROFILE,
    smooth: true,
    rings: 40, radial: 26,
    nose: { rings: 6, len: noseFrac, flat: 2.4 },
    // 尾は短く硬い楔。羽軸の詰まった板で、水平に少しだけ広がる
    tail: { len: 0.090, height: 0.20, fork: 0.0, horizontal: true },
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
  // 脚は尾柄の下から後ろへ。尾びれと同じ高さに置くと溶けるので一段下げる
  const zTail = zNose - bodyLen;
  mergeInto(dst, buildFeet(kind, zTail + bodyLen * 0.04, Y_PROFILE[10] * H - H * 0.16));

  const geo = new THREE.BufferGeometry();
  geo.setIndex(dst.idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(dst.pos, 3));
  geo.setAttribute('aBodyUV', new THREE.Float32BufferAttribute(dst.uv, 2));
  geo.setAttribute('aHeight', new THREE.Float32BufferAttribute(dst.h, 1));
  geo.setAttribute('aPart', new THREE.Float32BufferAttribute(dst.part, 1));
  geo.computeVertexNormals();

  // 翼の付け根。シェーダはここを軸に翼を振る
  const s = (arr, t) => {
    const x = Math.min(Math.max(t, 0), 1) * (arr.length - 1);
    const i = Math.min(Math.floor(x), arr.length - 2);
    const f = x - i;
    return arr[i] * (1 - f) + arr[i + 1] * f;
  };
  // w は翼の張り出し。シェーダはこれで「付け根から何割か」を測り、
  // 体に埋まった内端を動かさずにおく
  geo.userData.wingRoot = new THREE.Vector4(
    s(W_PROFILE, WING_AT) * W * 0.9,
    s(Y_PROFILE, WING_AT) * H - s(H_PROFILE, WING_AT) * H * WING_LOW,
    zNose - WING_AT * bodyLen,
    kind.flipper.width * bodyLen
  );
  geo.userData.length = kind.total;
  return geo;
}
