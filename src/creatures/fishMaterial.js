import * as THREE from 'three';
import { baseUniforms } from '../env.js';
import { UW_FRAG_PRELUDE, UW_FRAG_OUTPUT } from '../glsl.js';

// ============ 魚の遊泳シェーダ ============
// 遊泳様式(swimming mode)を再現:
//  - subcarangiform(イワシ): 振幅が尾に向かって増大する進行波
//  - labriform(ハギ類): 体は硬く、胸びれの羽ばたきが主
// 頂点シェーダで体軸に進行波を与え、法線もヨー回転で追従させる。

export const FISH_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uSwimFreq;   // 尾の振り角速度
uniform float uWaveAmp;    // 波の振幅(体長比)
uniform float uWaveNum;    // 体に乗る波数
uniform float uHeadAmp;    // 頭部の首振り
uniform float uFishLen;
uniform float uFlapFreq;   // 胸びれ
uniform float uVertAxis;   // 0=左右うねり(魚類) 1=上下うねり(クジラ類)
attribute vec2 aBodyUV;
attribute float aPart;
attribute float aHeight;   // 体の中心からの実際の高さ(H比)
#ifdef USE_INSTANCING
attribute vec4 aInfo;      // x:位相 y:速度倍率 z:サイズ w:色ゆらぎ
#endif
varying vec2 vBodyUV;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vPart;
varying float vTint;
varying float vHeight;

void main() {
  vBodyUV = aBodyUV;
  vPart = aPart;
  vHeight = aHeight;
  float phase = 0.0;
  float spd = 1.0;
  float tint = 0.5;
#ifdef USE_INSTANCING
  phase = aInfo.x;
  spd = aInfo.y;
  tint = aInfo.w;
#endif
  vTint = tint;

  vec3 p = position;
#ifdef USE_INSTANCING
  p *= aInfo.z; // 個体ごとの体格差
#endif
  vec3 n = normal;
  float t = clamp(aBodyUV.x, 0.0, 1.3); // 尾びれは1超
  float w = uTime * uSwimFreq * spd + phase;

  // 進行波: 頭は小さく、尾に向かって振幅増大
  float amp = uWaveAmp * (uHeadAmp + pow(min(t, 1.0), 2.0)) * uFishLen;
  float arg = w - t * uWaveNum * 6.2831853;
  float disp = sin(arg) * amp;
  // 尾びれは体より遅れて大きく振れる(柔軟な膜の表現)。
  // 尾柄(t=1)から先で滑らかに増やすので、胴体との境で折れない
  disp += sin(arg + 1.1) * amp * 0.85 * max(t - 1.0, 0.0) * 9.0;
  // 魚類は左右、クジラ類は上下に波打つ
  vec3 waveAxis = mix(vec3(1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), uVertAxis);
  p += waveAxis * disp;

  // 体軸回転で法線を追従(進行波の傾き)。左右=ヨー、上下=ピッチ
  float slope = cos(arg) * uWaveAmp * uWaveNum * 4.5 * (uHeadAmp + pow(min(t, 1.0), 2.0));
  float ca = cos(slope), sa = sin(slope);
  if (uVertAxis < 0.5) {
    n = vec3(n.x * ca - n.z * sa, n.y, n.x * sa + n.z * ca);
  } else {
    n = vec3(n.x, n.y * ca - n.z * sa, n.y * sa + n.z * ca);
  }

  // 胸びれの羽ばたき
  if (aPart == 3.0 || aPart == 4.0) {
    float side = aPart == 4.0 ? 1.0 : -1.0;
    float flap = sin(uTime * uFlapFreq * spd + phase * 1.7 + side * 1.57);
    float dist = abs(p.x) / max(uFishLen * 0.2, 1e-3);
    p.y += flap * dist * uFishLen * 0.08;
    p.x += side * flap * dist * uFishLen * 0.03;
  }

  vec4 wp = modelMatrix
  #ifdef USE_INSTANCING
    * instanceMatrix
  #endif
    * vec4(p, 1.0);
  vWorldPos = wp.xyz;

  mat3 nm = mat3(modelMatrix);
#ifdef USE_INSTANCING
  nm = nm * mat3(instanceMatrix);
#endif
  vNormal = normalize(nm * n);

  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

// ---- 模様関数(種ごと) ----
// uPattern: 0=マイワシ 1=カクレクマノミ 2=ナンヨウハギ 3=ジンベエザメ 4=ザトウクジラ
const PATTERN_GLSL = /* glsl */ `
uniform float uPattern;
uniform float uTimeP;

// v(高さ方向)は断面角のcosなので、同じvは左右両側に対応する。
// これを利用して「両側の目」を1つの式で描く
float eyeDot(float u, float v, float eu, float ev, float size) {
  vec2 d = vec2((u - eu) * 2.2, v - ev);
  return smoothstep(size, size * 0.55, length(d));
}

vec3 fishAlbedo(vec2 buv, vec3 wp, vec3 n, vec3 V, float tint, float part, float hgt, out float glossMul) {
  float u = clamp(buv.x, 0.0, 1.0);
  float v = buv.y;
  glossMul = 1.0;
  vec3 col = vec3(0.5);

  if (uPattern < 0.5) {
    // ---- マイワシ: 銀色の体、背は青緑、体側に黒斑列 ----
    vec3 belly = vec3(0.82, 0.86, 0.88);
    vec3 back  = vec3(0.10, 0.22, 0.30);
    col = mix(belly, back, smoothstep(0.45, 0.8, v));
    // 体側の黒斑(マイワシの特徴)
    float spotRow = smoothstep(0.03, 0.0, abs(v - 0.68) - 0.02);
    float spots = step(0.6, sin(u * 42.0 + tint * 6.0)) * spotRow;
    col = mix(col, vec3(0.05, 0.06, 0.08), spots * smoothstep(0.15, 0.3, u) * smoothstep(0.95, 0.8, u));
    // 鱗の虹色反射(見る角度で色相が流れる)
    float fres = pow(1.0 - abs(dot(n, V)), 2.0);
    col += vec3(
      sin(fres * 9.0 + u * 14.0) * 0.5 + 0.5,
      sin(fres * 9.0 + u * 14.0 + 2.1) * 0.5 + 0.5,
      sin(fres * 9.0 + u * 14.0 + 4.2) * 0.5 + 0.5
    ) * 0.09 * smoothstep(0.3, 0.55, v) * smoothstep(0.8, 0.55, v);
    glossMul = 2.6;
  } else if (uPattern < 1.5) {
    // ---- カクレクマノミ: 橙地に黒縁の白帯3本 ----
    vec3 orange = vec3(0.95, 0.38, 0.07);
    col = orange * (0.85 + tint * 0.3);
    float wob = sin(v * 6.0 + u * 3.0) * 0.015;
    float band = 0.0;
    // 頭・胴・尾柄の3本。胴の帯は三角形に張り出す(実物の特徴)
    band = max(band, smoothstep(0.045, 0.03, abs(u - 0.17 + wob)));
    float mid = 0.055 + smoothstep(0.4, 1.0, v) * 0.03;
    band = max(band, smoothstep(mid + 0.015, mid - 0.005, abs(u - 0.50 + wob)));
    band = max(band, smoothstep(0.04, 0.025, abs(u - 0.86 + wob)));
    float edge = band * smoothstep(1.0, 0.6, band); // 帯の縁
    col = mix(col, vec3(0.96, 0.97, 0.98), band);
    col = mix(col, vec3(0.02), edge * 0.9);
    // ひれの先端は黒縁
    glossMul = 0.6;
  } else if (uPattern < 2.5) {
    // ---- ナンヨウハギ: 瑠璃色 + 黒い「パレット」模様 + 黄色い尾 ----
    vec3 blue = vec3(0.06, 0.22, 0.75);
    col = blue * (0.8 + tint * 0.35);
    // 尾びれの黄色
    col = mix(col, vec3(0.95, 0.78, 0.08), smoothstep(0.86, 0.95, u));
    // 黒帯: 目の後ろから尾柄へ、体側上部で幅広に
    float band1 = smoothstep(0.10, 0.14, u) * smoothstep(0.88, 0.84, u)
                * smoothstep(0.42, 0.5, v);
    float notch = smoothstep(0.28, 0.38, u) * smoothstep(0.72, 0.6, u)
                * smoothstep(0.62, 0.52, v);
    float black = clamp(band1 - notch, 0.0, 1.0);
    col = mix(col, vec3(0.015, 0.015, 0.03), black * 0.95);
    glossMul = 0.8;
  } else if (uPattern < 3.5) {
    // ---- ジンベエザメ ----
    // 濃い青灰色の背に、淡い縦帯と横線が作る「市松の格子」。
    // その升目ひとつずつに白斑が入る。頭部だけは格子がなく、
    // 細かい斑点が密に散る。腹は白く、境界がはっきり分かれる。
    vec3 back  = vec3(0.105, 0.140, 0.185);
    vec3 belly = vec3(0.76, 0.785, 0.795);
    vec3 pale  = vec3(0.74, 0.80, 0.815);   // 斑と格子線の色

    // 腹との境界。頭では高く(頭の下面はほぼ白い)、胴では低い位置に来る
    float border = 0.205 + 0.08 * smoothstep(0.22, 0.02, u)
                 + sin(u * 19.0 + tint * 5.0) * 0.010;
    col = mix(belly, back, smoothstep(border - 0.025, border + 0.055, v));

    // --- 胴: 市松の格子と、升目ごとの白斑 ---
    // 格子の間隔をゆるく歪ませて、方眼紙のような機械的な並びを崩す
    float wob = fbm(vec2(u * 3.5, v * 2.2)) * 0.55;
    vec2 g = vec2(u * 17.0 + wob, v * 9.0 + wob * 0.6);
    vec2 cell = floor(g);
    vec2 f = fract(g) - 0.5;
    float grid = max(smoothstep(0.462, 0.500, abs(f.x)) * 0.75,  // 淡い縦帯
                     smoothstep(0.452, 0.495, abs(f.y)));        // 淡い横線
    vec2 jt = (vec2(hash12(cell), hash12(cell + 7.3)) - 0.5) * 0.34;
    float rad = 0.195 + hash12(cell * 3.1) * 0.085;
    float spot = smoothstep(rad, rad * 0.35, length((f + jt) * vec2(1.0, 1.1)));
    spot *= step(0.10, hash12(cell * 1.71));       // ときどき抜ける

    // --- 頭部: 格子はなく、細かい斑点が密に散る ---
    vec2 hg = vec2(u * 58.0, v * 28.0);
    vec2 hcell = floor(hg);
    vec2 hjt = (vec2(hash12(hcell + 2.1), hash12(hcell + 9.7)) - 0.5) * 0.5;
    float hspot = smoothstep(0.21, 0.07, length(fract(hg) - 0.5 + hjt))
                * step(0.38, hash12(hcell * 5.3));

    float headMix = smoothstep(0.30, 0.08, u);
    // 頭の前面は面積が広くのっぺりしやすいので、細かいむらを足す
    col *= 1.0 + (fbm(vec2(u * 40.0, v * 26.0)) - 0.5) * 0.16 * headMix;
    float marks = mix(max(spot, grid * 0.30), hspot * 0.9, headMix);
    float topMask = smoothstep(border + 0.02, border + 0.13, v);
    col = mix(col, pale, clamp(marks, 0.0, 1.0) * topMask * 0.9);

    // --- 5対の大きな鰓裂(頭のうしろ、胸びれの手前) ---
    float gv = clamp((v - 0.30) / 0.42, 0.0, 1.0);
    float gu = u - 0.105 - gv * 0.012;           // 上端ほどわずかに後ろへ倒れる
    float slits = 0.0;
    for (int gi = 0; gi < 5; gi++) {
      slits = max(slits, smoothstep(0.0080, 0.0018, abs(gu - float(gi) * 0.0245)));
    }
    slits *= smoothstep(0.0, 0.10, gv) * smoothstep(1.0, 0.85, gv);
    col = mix(col, back * 0.28, slits * 0.85);

    // --- 口: 吻の先端にあり、頭幅いっぱいに横へ広い(終端口) ---
    // 鼻先のリングはすべて u=0 なので、前面の上下位置は v で切り分ける
    // 口は吻の先端を横一文字に走る。角ばった頭では断面角(v)の等高線が
    // 角丸長方形になってしまうので、実際の高さ(hgt)で引く
    float front = smoothstep(0.038, 0.0, u);
    float gape = smoothstep(0.085, 0.030, abs(hgt - 0.10));
    col = mix(col, vec3(0.035, 0.045, 0.058), front * gape * 0.9);
    // 口の下のわずかに明るい唇
    col = mix(col, vec3(0.66, 0.685, 0.695),
              front * smoothstep(0.060, 0.020, abs(hgt + 0.02)) * 0.5);

    // --- 目: 頭の側面の角、低く前寄りに小さく ---
    col = mix(col, vec3(0.02, 0.025, 0.03), eyeDot(u, v, 0.048, 0.375, 0.022));

    // --- ひれ ---
    // 尾びれ・背びれ・胸びれとも背と同じ濃さで、上面に斑が乗る。
    // 体のUVをそのまま使うと腹の白がひれに流れ込んでしまうので、
    // ひれは独立して塗る。
    if (part > 0.5) {
      vec2 fg = vec2(buv.x * 23.0, v * 13.0);
      vec2 fc = floor(fg);
      float fs = smoothstep(0.26, 0.10, length(fract(fg) - 0.5))
               * step(0.46, hash12(fc * 2.7));
      col = mix(back, pale, fs * 0.6);
      // 縁はわずかに明るく、薄い膜らしく見せる
      col = mix(col, pale * 0.7, smoothstep(0.6, 1.0, abs(v - 0.5) * 2.0) * 0.3);
    }
    glossMul = 0.34;
  } else if (uPattern < 4.5) {
    // ---- ザトウクジラ: 黒に近い背、白い腹と喉の畝(ヴェントラルグルーブ) ----
    vec3 back = vec3(0.09, 0.105, 0.135);
    vec3 belly = vec3(0.78, 0.80, 0.83);
    float border = 0.34 + sin(u * 14.0 + tint * 6.0) * 0.02;
    col = mix(belly, back, smoothstep(border - 0.06, border + 0.08, v));
    // 喉から腹の畝: 体軸に沿う筋(断面角=vに沿って刻む)
    float groove = pow(abs(sin(v * 62.0)), 6.0)
                 * smoothstep(0.36, 0.18, v) * smoothstep(0.62, 0.35, u);
    col = mix(col, vec3(0.55, 0.57, 0.60), groove * 0.5);
    // 皮膚のまだら(フジツボ痕・傷): セル内の小さな点として描く
    vec2 mg = vec2(u * 40.0, v * 18.0);
    float mottle = step(0.90, hash12(floor(mg)))
                 * smoothstep(0.32, 0.15, length(fract(mg) - 0.5))
                 * smoothstep(0.4, 0.6, v);
    col += vec3(0.12) * mottle;
    // 胸びれとフリューク腹側は白
    if (part > 2.5) col = mix(col, vec3(0.85, 0.88, 0.90), 0.85);
    // フリュークの腹側も背と同じ暗さ。尾柄から滑らかに移行させる
    if (abs(part - 1.0) < 0.1) {
      float toFluke = clamp((buv.x - 1.0) / 0.20, 0.0, 1.0);
      col = mix(col, back * 0.9, smoothstep(0.5, 0.7, v) * toFluke);
    }
    // 目(両側、口角の少し上)
    col = mix(col, vec3(0.02), eyeDot(u, v, 0.09, 0.42, 0.03));
    glossMul = 0.35;
  } else if (uPattern < 5.5) {
    // ---- バンドウイルカ: 背は濃灰、体側は中灰、腹は淡い ----
    // 「ケープ」と呼ばれる背の濃色部が、体側で波打つ境界を作るのが特徴
    vec3 cape  = vec3(0.085, 0.095, 0.115);
    vec3 flank = vec3(0.245, 0.265, 0.285);
    vec3 belly = vec3(0.62, 0.615, 0.585);
    // 体側の境界: 頭の後ろで高く、背びれの下で下がり、尾へ向かって上がる
    float capeLine = 0.60 + 0.14 * sin(u * 5.2 - 1.1) - 0.10 * smoothstep(0.0, 0.35, u);
    col = mix(flank, cape, smoothstep(capeLine - 0.10, capeLine + 0.06, v));
    float bellyLine = 0.30 - 0.07 * smoothstep(0.25, 0.75, u);
    col = mix(belly, col, smoothstep(bellyLine - 0.09, bellyLine + 0.10, v));
    // 目から胸びれへ走る細い暗色線
    float stripe = smoothstep(0.035, 0.0, abs(v - (0.46 - (u - 0.16) * 0.42)))
                 * smoothstep(0.15, 0.20, u) * smoothstep(0.36, 0.30, u);
    col = mix(col, cape * 0.75, stripe * 0.6);
    // 口の裂け目(吻から頬へ)
    float mouth = smoothstep(0.022, 0.0, abs(v - 0.36)) * smoothstep(0.005, 0.03, u) * smoothstep(0.19, 0.15, u);
    col = mix(col, vec3(0.10, 0.10, 0.11), mouth * 0.8);
    // 噴気孔(頭頂のくぼみ)
    float blow = smoothstep(0.030, 0.012, length(vec2((u - 0.185) * 2.4, v - 0.99)));
    col = mix(col, vec3(0.09, 0.09, 0.10), blow * 0.85);
    // ひれは背と同じ濃さ
    if (part > 0.5) col = mix(col, cape, 0.75);
    // 目
    col = mix(col, vec3(0.03, 0.03, 0.035), eyeDot(u, v, 0.175, 0.50, 0.030));
    glossMul = 1.5;   // 濡れた皮膚のつや
  } else if (uPattern < 6.5) {
    // ---- シロイルカ: 全身ほぼ白。陰影だけで形を見せる ----
    vec3 white = vec3(0.70, 0.705, 0.715);
    col = white;
    // 腹側はごくわずかに明るく、背は少しだけくすむ
    col *= 0.94 + 0.10 * (1.0 - smoothstep(0.45, 0.95, v));
    // 背びれの代わりの低い隆起(背中の稜線がうっすら影になる)
    float ridge = smoothstep(0.030, 0.0, abs(v - 0.985))
                * smoothstep(0.36, 0.46, u) * smoothstep(0.80, 0.68, u);
    col = mix(col, white * 0.86, ridge * 0.7);
    // 皮膚の質感(かすかな斑)
    col *= 0.97 + 0.06 * fbm(vec2(u * 22.0, v * 9.0));
    // 口の裂け目と、口角のわずかな影(ほほえんで見えるライン)
    float mouth = smoothstep(0.020, 0.0, abs(v - 0.34))
                * smoothstep(0.01, 0.05, u) * smoothstep(0.24, 0.17, u);
    col = mix(col, vec3(0.40, 0.40, 0.41), mouth * 0.75);
    // 噴気孔
    float blow = smoothstep(0.030, 0.012, length(vec2((u - 0.235) * 2.4, v - 0.99)));
    col = mix(col, vec3(0.42, 0.43, 0.44), blow * 0.7);
    // 小さな黒い目
    col = mix(col, vec3(0.06, 0.06, 0.07), eyeDot(u, v, 0.225, 0.52, 0.024));
    glossMul = 1.7;
  } else {
    // ---- カマイルカ: 黒い背・白い腹に、体側を走る淡灰色の帯 ----
    vec3 back  = vec3(0.055, 0.060, 0.075);
    vec3 belly = vec3(0.72, 0.715, 0.70);
    vec3 sash  = vec3(0.40, 0.425, 0.445);   // サスペンダー模様
    // 背と腹の境界。頭寄りで高く、尾に向かって下がる
    float line = 0.46 - 0.10 * smoothstep(0.2, 0.9, u);
    col = mix(belly, back, smoothstep(line - 0.10, line + 0.08, v));
    // 体側の淡い帯: 目の上あたりから始まり、尾柄で背へ駆け上がる
    float sashCenter = 0.60 + 0.30 * smoothstep(0.45, 0.95, u);
    float sashW = 0.10 + 0.06 * smoothstep(0.3, 0.9, u);
    float band = smoothstep(sashW, sashW * 0.35, abs(v - sashCenter))
               * smoothstep(0.16, 0.28, u);
    col = mix(col, sash, band * 0.85);
    // 尾柄の後半はさらに淡くなる
    col = mix(col, sash * 1.25, band * smoothstep(0.62, 0.92, u) * 0.6);
    // 吻は黒い
    col = mix(col, back, smoothstep(0.16, 0.04, u) * 0.8);
    // 背びれは前縁が黒く後縁が淡い二色
    if (abs(part - 2.0) < 0.1) {
      col = mix(back, sash * 1.15, smoothstep(0.46, 0.60, buv.x));
    }
    // 目
    col = mix(col, vec3(0.02, 0.02, 0.03), eyeDot(u, v, 0.185, 0.50, 0.028));
    glossMul = 1.6;
  }
  return col;
}
`;

export const FISH_FRAGMENT = UW_FRAG_PRELUDE + PATTERN_GLSL + /* glsl */ `
varying vec2 vBodyUV;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vPart;
varying float vTint;
varying float vHeight;

void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 V = normalize(cameraPosition - vWorldPos);

  float glossMul;
  vec3 albedo = fishAlbedo(vBodyUV, vWorldPos, n, V, vTint, vPart, vHeight, glossMul);

  // ひれは薄く透ける
  float finAlpha = vPart > 0.5 ? 0.75 : 1.0;

  vec3 col = underwaterLight(albedo, n, vWorldPos, V, 48.0, 0.35 * glossMul);
  // 体表に落ちる揺らめく光
  col += causticsLight(vWorldPos, n, 0.55) * albedo * 2.0;
  // 逆光時のひれの透過。尾びれは付け根から徐々に薄くなるので、
  // 透過も尾柄から滑らかに立ち上げて境目を見せない
  if (vPart > 0.5) {
    float trans = clamp(dot(-n, uSunDir), 0.0, 1.0);
    float ramp = vPart < 1.5 ? clamp((vBodyUV.x - 1.0) / 0.18, 0.0, 1.0) : 1.0;
    col += albedo * trans * 0.4 * uSunI * ramp;
  }
  // 銀鱗のリム(水中でのぼんやりした輪郭光)
  float fr = pow(1.0 - abs(dot(n, V)), 3.0);
  col += uAmbTop * fr * 0.35;

  col = applyUnderwaterFog(col, vWorldPos);
  gl_FragColor = vec4(col, finAlpha);
  ${UW_FRAG_OUTPUT}
}
`;

export function createFishMaterial({ pattern, len, swim, vertAxis = 0 }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...baseUniforms(),
      uPattern: { value: pattern },
      uTimeP: { value: 0 },
      uFishLen: { value: len },
      uSwimFreq: { value: swim.freq ?? 8 },
      uWaveAmp: { value: swim.amp ?? 0.06 },
      uWaveNum: { value: swim.waveNum ?? 0.8 },
      uHeadAmp: { value: swim.headAmp ?? 0.1 },
      uFlapFreq: { value: swim.flapFreq ?? 5 },
      uVertAxis: { value: vertAxis },
    },
    vertexShader: FISH_VERTEX,
    fragmentShader: FISH_FRAGMENT,
    side: THREE.DoubleSide,
    transparent: false,
  });
}
