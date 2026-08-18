import * as THREE from 'three';
import { baseUniforms } from '../env.js';
import { UW_NOISE } from '../glsl.js';

// ============ 接地影 ============
//
// 磯の生き物は岩の高さに正しく乗るようになった。それでも、岩に貼った
// シールのように見える。足りないのは影で、しかも「落ち影」ではなく
// 接地影のほう。
//
// 物が地面に触れているとき、そこには2種類の暗がりがある。
//
//   1. 遮蔽(AO)。接触点のまわりは空が見えないぶん暗い。
//      光の向きにも強さにも関係なく、曇っていても水の中でも必ずある。
//      これが「触れている」ことを伝えている本体
//   2. 太陽の落ち影。日射の逆向きへ伸びる。日が弱ければ薄く、
//      深く沈めば水中の光が散乱で回りこむので消えていく
//
// 1だけでも接地は伝わる。2だけだと、日が陰った瞬間に物が浮く。
// だから両方を別の項として持つ。片方にまとめてはいけない。
//
// 実装は板を1枚、岩の面に沿って寝かせて敷き、下の色に掛け算する。
// 影マップを焼くのは、この寸法(数cm〜1m)と個体数(数百)には過剰。
//
// この板は自前で座標を持たない——高さも法線も呼ぶ側から渡してもらう。
// 岩の高さ場を知っている側(地形・生き物)は互いに import しあうので、
// ここが何かを import するとすぐ循環する。

// 影の色。真っ黒ではない。晴れた磯の影は空の色で埋められるので青く寄る
const TINT = 'vec3(0.255, 0.295, 0.355)';
// 遮蔽ぶんの濃さ。光の状態に関わらず、常にこれだけ暗い
const AO = 0.36;
// 太陽の落ち影ぶん。日射と水深で変わる
const CAST = 0.44;

const VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vW;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  uniform float uSunI;
  uniform float uSurfaceY;
  varying vec2 vUv;
  varying vec3 vW;
  void main() {
    // 板の中心からの距離。0=接触点 1=板の縁
    float r = length(vUv - 0.5) * 2.0;
    // 縁を崩す。完全な円は、岩の上にコインを置いたように見える。
    //
    // ノイズは板の中の座標(vUv)で引く。世界座標を26倍して引いていたら、
    // 磯の端(x=37m)で引数が960になり、sin を使ったハッシュの精度が
    // 飛んで r が壊れた。影が真っ白(=濃さ0)になり、
    // 「板はそこにあるのに影が出ない」という形で現れた。
    // 個体ごとの違いは、世界座標を8mで折り返して足すことで出す
    // ——引数が小さいまま保たれる
    vec2 q = vUv * 5.0 + vec2(mod(vW.x, 8.0), mod(vW.z, 8.0));
    r *= 0.80 + 0.40 * fbm(q);
    // 接地影は中心が濃く、すぐ薄くなる。線形に落とすと綿のかたまりになる
    float a = 1.0 - smoothstep(0.12, 1.0, r);
    a *= a;

    // 深く沈むほど落ち影は消える。水中の光は散乱で回りこむので、
    // 数m下では影が「柔らかくなる」ではなく「無くなる」に近い
    float sunk = smoothstep(0.0, 2.2, uSurfaceY - vW.y);
    float shade = ${AO.toFixed(2)} * a
                + ${CAST.toFixed(2)} * a * clamp(uSunI, 0.0, 1.4) * (1.0 - sunk);

    gl_FragColor = vec4(mix(vec3(1.0), ${TINT}, clamp(shade, 0.0, 1.0)), 1.0);
  }
`;

const _along = new THREE.Vector3();
const _across = new THREE.Vector3();
const _sv = new THREE.Vector3();

/**
 * 接地影の敷物。1インスタンス=1枚の板。
 *
 * 使う側は place() に「岩の上の点」「岩の法線」「板の直径」
 * 「物の中心が岩からどれだけ浮いているか」を渡す。
 */
export class ContactShadows {
  constructor(parent, count, sunDir) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);       // XZ 平面に寝かせる
    this.mat = new THREE.ShaderMaterial({
      uniforms: baseUniforms(),
      vertexShader: VERT,
      fragmentShader: UW_NOISE + FRAG,
      // 下の色に掛け算する。加算や不透明で塗ると、影が「黒い染み」になる。
      //
      // premultipliedAlpha は必須。three の MultiplyBlending は
      // blendFuncSeparate(DST_COLOR, ONE_MINUS_SRC_ALPHA, ZERO, ONE) で
      // 実装されていて、これが無いと three は
      //   "MultiplyBlending requires material.premultipliedAlpha = true"
      // を console.error に出したうえで、ブレンド関数を一切設定しない。
      // 板は描かれているのに画面が1画素も変わらない、という形で出る。
      // 撮影スクリプトが pageerror しか拾っていなかったので、
      // その1行に気づくまで、影の大きさや深度の設定を延々と疑っていた
      blending: THREE.MultiplyBlending,
      premultipliedAlpha: true,
      transparent: true,
      // 岩と同じ深さにあるので、書きこまずに読むだけ。
      // さらに polygonOffset でわずかに手前へ寄せる——法線方向へ持ち上げて
      // 逃がす手もあるが、数cmの生き物には持ち上げ量そのものが目立つ
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.mat, count);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // 岩のあとに描く。生き物より先
    this.mesh.renderOrder = 1;
    this.mesh.count = 0;
    parent.add(this.mesh);
    this._m = new THREE.Matrix4();
    // 影は円ではなく、日射の逆側へ伸びた楕円になる。
    // 太陽高度を θ とすると(sunDir が単位ベクトルなので sinθ = sunDir.y)、
    //   ・日射方向への長さは 1/sinθ 倍に伸びる
    //   ・足元から (h / tanθ) だけずれる
    // 磯の太陽は sunDir.y = 0.86(高度59度)なので、伸びは1.16倍、
    // ずれは浮き高さの0.59倍。円のまま置くと、真上から見たとき
    // 物の陰にすっかり隠れて、影が入っているのに何も変わらない
    const hx = Math.hypot(sunDir.x, sunDir.z) || 1e-6;
    this.sunX = sunDir.x / hx;          // 日射の水平向き(単位)
    this.sunZ = sunDir.z / hx;
    this.stretch = 1 / Math.max(sunDir.y, 0.35);
    this.lean = hx / Math.max(sunDir.y, 0.35);
  }

  /**
   * i 番目の板を置く。
   * @param size 物の幅(この 1.0 倍が影の短径。長径は太陽高度から伸ばす)
   * @param h 物の重心が岩からどれだけ浮いているか。影のずれ量を決める
   */
  place(i, x, y, z, size, h, nrm) {
    // 日射の水平向きを面に沿わせる。斜面では影も斜面に沿って伸びる
    _along.set(-this.sunX, 0, -this.sunZ);
    _along.addScaledVector(nrm, -_along.dot(nrm));
    if (_along.lengthSq() < 1e-8) _along.set(1, 0, 0);
    _along.normalize();
    _across.crossVectors(nrm, _along).normalize();
    this._m.makeBasis(_across, nrm, _along);
    this._m.scale(_sv.set(size, size, size * this.stretch));
    // 板は平らだが、岩は曲がっている。板が大きいほど周縁が岩の中へ潜り、
    // 深度テストで捨てられる。転石(板 0.76m)ではそれで影が1画素も
    // 出ていなかった——影だけを描かせると板はちゃんとそこにあるのに、
    // 岩を描くと消える、という形で気づいた。
    //
    // 沈む量は曲率半径 R の面で幅 w に対し w²/(2R)。岩の丸みは R≒4m
    // 程度なので (size/2)²/8 = size²/32。余裕を見て1.5倍だけ浮かせる。
    // size の2乗なので、数cmの生き物ではmm以下、転石では3cm近くになる
    const lift = size * size * 0.05;
    this._m.setPosition(x - this.sunX * this.lean * h + nrm.x * lift,
                        y + nrm.y * lift,
                        z - this.sunZ * this.lean * h + nrm.z * lift);
    this.mesh.setMatrixAt(i, this._m);
  }

  commit(n) {
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
