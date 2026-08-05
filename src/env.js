import * as THREE from 'three';

// ============ 水槽の世界定数 ============
export const WORLD = {
  surfaceY: 16,   // 水面の高さ
  floorY: 0,      // 砂底の基準
  half: 28,       // 生物の遊泳範囲(半径)
};

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
};

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
  };
}
