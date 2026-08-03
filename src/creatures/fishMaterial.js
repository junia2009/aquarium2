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
#ifdef USE_INSTANCING
attribute vec4 aInfo;      // x:位相 y:速度倍率 z:サイズ w:色ゆらぎ
#endif
varying vec2 vBodyUV;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vPart;
varying float vTint;

void main() {
  vBodyUV = aBodyUV;
  vPart = aPart;
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

vec3 fishAlbedo(vec2 buv, vec3 wp, vec3 n, vec3 V, float tint, float part, out float glossMul) {
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
    // ---- ジンベエザメ: 青灰色の背に市松状の白斑と縞、白い腹 ----
    vec3 back = vec3(0.14, 0.19, 0.26);
    vec3 belly = vec3(0.80, 0.84, 0.85);
    col = mix(belly, back, smoothstep(0.26, 0.44, v));
    // 白斑: 格子セルごとに少しずらした円。背側のみ
    vec2 g = vec2(u * 30.0, v * 11.0);
    vec2 cell = floor(g);
    vec2 f = fract(g) - 0.5;
    vec2 jitter = (vec2(hash12(cell), hash12(cell + 7.3)) - 0.5) * 0.45;
    float spot = smoothstep(0.30, 0.16, length(f + jitter));
    spot *= step(0.30, hash12(cell * 1.71));         // 出現をまばらに
    float topMask = smoothstep(0.38, 0.50, v);
    col = mix(col, vec3(0.88, 0.92, 0.94), spot * topMask * 0.9);
    // 斑列の間の淡い横縞(市松模様の格子線)
    float stripe = smoothstep(0.42, 0.5, abs(fract(g.y) - 0.5));
    col += vec3(0.10, 0.12, 0.13) * stripe * topMask * 0.5;
    // 口元(先端下側)を暗く
    col = mix(col, vec3(0.10, 0.12, 0.14), smoothstep(0.05, 0.0, u) * smoothstep(0.55, 0.35, v));
    // 目(両側)
    col = mix(col, vec3(0.02), eyeDot(u, v, 0.07, 0.52, 0.035));
    glossMul = 0.5;
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
  } else {
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

void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 V = normalize(cameraPosition - vWorldPos);

  float glossMul;
  vec3 albedo = fishAlbedo(vBodyUV, vWorldPos, n, V, vTint, vPart, glossMul);

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
