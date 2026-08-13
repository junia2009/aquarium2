import * as THREE from 'three';

// ============ 水槽の世界定数 ============
export const WORLD = {
  surfaceY: 16,   // 水面の高さ
  floorY: 0,      // 砂底の基準
  half: 28,       // 生物の遊泳範囲(半径)
};

// 氷のないゾーン用の空の被覆テクスチャ。
// sampler2D を null のままにすると、実装によっては警告が出たり
// 黒(＝全面が氷)として読まれたりするので、必ず何かを差しておく。
function emptyCover() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
}

// ============ 全マテリアル共有ユニフォーム ============
// 同じオブジェクト参照を各マテリアルに渡すことで、一括更新される
export const U = {
  uTime:       { value: 0 },
  uSunDir:     { value: new THREE.Vector3(0.28, 0.9, 0.16).normalize() }, // 太陽方向(上向き)
  uSunColor:   { value: new THREE.Color('#ffefcf') },
  uSunI:       { value: 1.0 },                       // 太陽光の強さ(UIスライダー連動)
  uFogColor:   { value: new THREE.Color('#0b3a58') }, // 水中散乱色
  uFogDensity: { value: 0.024 },
  uSurfaceY:   { value: WORLD.surfaceY },
  uAmbTop:     { value: new THREE.Color('#3b87a8') }, // 上方からの環境光
  uAmbBottom:  { value: new THREE.Color('#07222f') }, // 下方(底)からの照り返し

  // ---- ダイバーライト(深海ゾーン用) ----
  // 太陽の届かない深さでは、見えるものは「自分の光が当たったもの」と
  // 「自分で光るもの」だけになる。uLampI = 0 のゾーンでは一切効かない。
  uLampPos:    { value: new THREE.Vector3() },        // カメラ位置
  uLampDir:    { value: new THREE.Vector3(0, 0, -1) },// カメラの向き
  uLampColor:  { value: new THREE.Color('#eaf4ff') },
  uLampI:      { value: 0.0 },                        // 0=消灯(既存ゾーン)
  uLampCos:    { value: Math.cos(0.42) },             // 光錐の半頂角のcos
  uLampReach:  { value: 26.0 },                       // 届く距離

  // ---- 流氷の覆い(流氷ゾーン用) ----
  // 海が氷の板で蓋をされていると、太陽光はその割れ目(リード)からしか
  // 入らない。氷の下は薄暗く、リードの真下だけが眩しい——氷の海の
  // 明暗はほぼこれだけで決まる。
  // 被覆率をXZ平面のテクスチャに焼いておき、sunReach() が全マテリアルで
  // 参照する。uIceOn = 0 のゾーンでは一切効かない。
  uIceTex:     { value: emptyCover() },                // R = 氷の被覆(0..1)
  uIceOn:      { value: 0.0 },
  uIceExtent:  { value: 160.0 },                      // テクスチャが覆うXZの一辺(m)
};

// 氷のないゾーン用の既定テクスチャ(被覆0)。sampler2D は未バインドだと
// 実装によって警告や黒読みになるので、必ず何かを差しておく
export function setIceCover(tex, extent) {
  U.uIceTex.value = tex;
  U.uIceOn.value = tex ? 1.0 : 0.0;
  if (extent) U.uIceExtent.value = extent;
}

export function baseUniforms() {
  // 参照共有: value オブジェクトごと共有するのがポイント
  return {
    uTime: U.uTime,
    uSunDir: U.uSunDir,
    uSunColor: U.uSunColor,
    uSunI: U.uSunI,
    uFogColor: U.uFogColor,
    uFogDensity: U.uFogDensity,
    uSurfaceY: U.uSurfaceY,
    uAmbTop: U.uAmbTop,
    uAmbBottom: U.uAmbBottom,
    uLampPos: U.uLampPos,
    uLampDir: U.uLampDir,
    uLampColor: U.uLampColor,
    uLampI: U.uLampI,
    uLampCos: U.uLampCos,
    uLampReach: U.uLampReach,
    uIceTex: U.uIceTex,
    uIceOn: U.uIceOn,
    uIceExtent: U.uIceExtent,
  };
}
