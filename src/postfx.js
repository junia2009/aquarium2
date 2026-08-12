import * as THREE from 'three';

// ============ 水の前方散乱(距離でぼける) ============
//
// 水中では、物から目へ向かう光がその道中で何度も細かく散らされる。
// 散乱角の小さいぶんは目に届くので、물체の一点から出た光が
// わずかな広がりを持って到達する。結果として、遠いものほど輪郭がぼやける。
// 水中写真がどれも眠たい絵になるのはこのためで、
// 「距離で暗くなる/色が抜ける」だけでは水の中には見えない。
//
// フォグ(吸収と散乱光の足し込み)は各マテリアルで既に入れてあるが、
// ぼけは1ピクセルの計算では作れない。シーンを一度テクスチャへ描き、
// 深度から距離を復元して、距離に応じた半径でぼかす。
//
// ぼけ半径は水の濁り(uFogDensity)から決める。同じ距離でも、
// 澄んだ大水槽より濁った深海のほうが早く輪郭を失う。

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uDepth;
uniform vec2 uTexel;        // 1 / 描画バッファの解像度
uniform float uNear;
uniform float uFar;
uniform float uDensity;     // 水の濁り(uFogDensity と同じ値)
uniform float uMaxRadius;   // 最大ぼけ半径(ピクセル)
uniform float uStrength;    // 水中にいる度合い。頭が水面から出ると0へ
varying vec2 vUv;

// 深度バッファ(0..1)から視線方向の距離(m)へ
float viewDistance(float d) {
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

// 距離からぼけ半径(ピクセル)へ
float radiusAt(float depth) {
  float dist = viewDistance(depth);
  // 散乱で失われる鮮鋭さ。距離とともに飽和する。
  // 1-exp() のままだと近〜中距離で効きすぎて、10mの魚まで溶けてしまう。
  // 累乗して立ち上がりを遅らせ、「近くはくっきり、遠くから順に溶ける」
  // という水中写真の見え方に合わせる
  float soft = pow(1.0 - exp(-dist * uDensity), 1.6);
  // 手前でも完全に硬い輪郭にはしない(水は常に少し散らす)
  return uMaxRadius * (0.06 + 0.94 * soft) * uStrength;
}

void main() {
  // ぼけ半径はその画素自身の距離で決める。
  //
  // 「サンプルごとにそのサンプルの距離で重みを決める」ほうが散乱の
  // 向きとしては正しいのだが、そうすると探す範囲(遠い背景の広い半径)と
  // 実際に効く範囲(手前の物の狭い半径)が桁で食い違い、12点では
  // まったく足りずに輪郭のまわりが 18→28→18→67→18 と振動する。
  // 中心の半径で素直に重み付けすれば、点の密度が半径に見合うので滑らかに出る。
  // 手前の物の輪郭が外側へわずかに滲むが、これは水中で実際に見える
  // 「もやの暈(かさ)」そのものなので、むしろ都合がよい。
  float radius = radiusAt(texture2D(uDepth, vUv).x);
  // ほとんどぼけない画素で12点も舐めるのは無駄。手前の物と、
  // 水上へ出たときの空はここで抜ける
  if (radius < 0.35) { gl_FragColor = texture2D(uScene, vUv); }
  else {

  // 黄金角スパイラルの12点。半径を広げるほど点の間隔が空くので、
  // 数が足りないと輪郭のまわりに点々の影(ゴースト)が出る
  vec4 sum = texture2D(uScene, vUv);
  float wsum = 1.0;
  for (int i = 0; i < 12; i++) {
    float fi = float(i) + 0.5;
    float a = fi * 2.39996323;                 // 黄金角
    float r = sqrt(fi / 12.0) * radius;
    vec2 off = vec2(cos(a), sin(a)) * r * uTexel;
    // 中心ほど重い(ガウシアン近似)
    float w = exp(-(r * r) / (radius * radius + 1e-4) * 1.4);
    sum += texture2D(uScene, vUv + off) * w;
    wsum += w;
  }
  gl_FragColor = sum / wsum;
  }

  #include <colorspace_fragment>
}
`;

export class UnderwaterScatter {
  /**
   * @param renderer
   * @param maxRadius 最大ぼけ半径。1080p 相当での画素数で指定する
   */
  constructor(renderer, { maxRadius = 6.0 } = {}) {
    this.maxRadius = maxRadius;
    this.enabled = true;

    // シーンは「トーンマッピング済みのリニア値」で受ける。
    // ここを sRGB にすると、ぼかしがガンマの掛かった値の上で行われて
    // 明暗の境目が濁る。色空間の変換は最後の1回だけにする。
    this.rt = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,          // 深海の暗部でバンドが出ないように
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.rt.texture.minFilter = THREE.LinearFilter;
    this.rt.texture.magFilter = THREE.LinearFilter;
    this.rt.depthTexture = new THREE.DepthTexture(1, 1);
    this.rt.depthTexture.type = THREE.UnsignedIntType;

    this.uniforms = {
      uScene: { value: this.rt.texture },
      uDepth: { value: this.rt.depthTexture },
      uTexel: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.1 },
      uFar: { value: 500 },
      uDensity: { value: 0.024 },
      uMaxRadius: { value: maxRadius },
      uStrength: { value: 1 },
    };

    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: VERT,
        fragmentShader: FRAG,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,        // トーンマッピングはシーン側で済んでいる
      })
    );
    quad.frustumCulled = false;
    this.quadScene.add(quad);

    this.setSize(renderer);
  }

  setSize(renderer) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.rt.setSize(size.x, size.y);
    this.uniforms.uTexel.value.set(1 / size.x, 1 / size.y);
    // ぼけ半径は画面の高さに比例させる。画素数で固定すると、
    // 解像度の高い端末だけ相対的にくっきりしてしまう
    this.uniforms.uMaxRadius.value = this.maxRadius * (size.y / 1080);
  }

  /**
   * @param density ゾーンの濁り(U.uFogDensity)
   * @param strength 水中にいる度合い(0で無効)。水上では光路に水がないので
   *                 空や遠景をぼかしてはいけない
   */
  render(renderer, scene, camera, density, strength = 1) {
    if (!this.enabled) { renderer.setRenderTarget(null); renderer.render(scene, camera); return; }
    this.uniforms.uNear.value = camera.near;
    this.uniforms.uFar.value = camera.far;
    this.uniforms.uDensity.value = density;
    this.uniforms.uStrength.value = strength;
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(this.quadScene, this.quadCam);
  }
}
