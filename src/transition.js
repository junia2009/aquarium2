import * as THREE from 'three';
import { sandHeight } from './environment/seabed.js';

// ============ ハッチをくぐる ============
//
// これまでは押した瞬間に enterZone を呼んでいたので、画面がぷつりと
// 切り替わっていました。リンクを踏んだのと同じで、「くぐった」ことに
// なっていない。ハッチを穴として作った意味がありません。
//
// 通り抜けたと感じさせるのに要るのは3つで、どれも同時に動かないと
// 効きません。
//
//   1. 加速。等速で近づくと「移動した」だけになります。引き込まれる
//      感じは、速度そのものではなく速度が増えていくことから来ます。
//   2. 画角の広がり。近づくほど視野の端が後ろへ流れます。位置だけ
//      動かして画角を止めると、絵が拡大するだけで速さが出ません。
//   3. 行き先の水の色が縁から閉じてきて、通り抜けた瞬間に画面を覆う。
//      ゾーンの入れ替えはその覆われている一瞬に行います——
//      見えていないので継ぎ目がない。切り替えを隠すためではなく、
//      「穴の中は行き先の水で満ちている」という理屈のほうが先で、
//      継ぎ目が消えるのはその結果です。
//
// 出るときは逆向きに。行き先のカメラ位置の少し手前から滑り出して、
// 速度を持ったまま到着します。到着位置にいきなり置くと、そこだけ
// 「ワープした」ように見えてしまう。

const IN_DUR = 1.05;
const OUT_DUR = 0.95;
// 引き戻されるとき(施設へ帰る)は、くぐるより短い。
// 帰り道が行きと同じ重さだと、往復するたびに待たされる
const BACK_IN = 0.62, BACK_OUT = 0.70;
const FOV_GAIN = 30;        // 吸い込まれるあいだに広がる画角(度)

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
// 向きを求めるための当て馬。
//
// ここは Object3D ではいけない。Object3D.lookAt は +Z を的に向けるが、
// カメラとライトだけは -Z を向ける(three が isCamera / isLight を見て
// 分岐している)。Object3D で作った四元数をカメラに入れると、
// ちょうど真後ろを向く——実際そうなって、ハッチに向かうはずの
// カメラが反対側の壁を見ながら飛んでいった
const _probe = new THREE.PerspectiveCamera();
const _dark = new THREE.Color();

// THREE.Color が持っているのは**線形**の値。そのまま 255 倍して CSS へ
// 渡すと、#1e6fa8 が rgb(3,41,100) になる——ほとんど黒で、覆いを
// 出しているのに何も見えなかった。CSS は sRGB なので、渡す前に戻す
const _srgb = new THREE.Color();
function rgba(c, a) {
  _srgb.copy(c).convertLinearToSRGB();
  return `rgba(${Math.round(_srgb.r * 255)},${Math.round(_srgb.g * 255)},`
       + `${Math.round(_srgb.b * 255)},${a.toFixed(3)})`;
}

export class PortalWarp {
  constructor(camera, diveCam) {
    this.camera = camera;
    this.diveCam = diveCam;
    this.phase = null;          // null / 'in' / 'out'
    this.t = 0;

    this.q0 = new THREE.Quaternion();
    this.q1 = new THREE.Quaternion();
    this.p0 = new THREE.Vector3();
    this.p1 = new THREE.Vector3();
    this.tint = new THREE.Color();
    this.focus = new THREE.Vector3();   // 画面上でワイプの中心になる点

    // 覆いは DOM で持つ。ポストエフェクトに1枚足すより軽く、
    // 端末の解像度に関係なく同じ見た目になる
    const el = document.createElement('div');
    el.id = 'warp';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
    this.el = el;
  }

  get active() { return this.phase !== null; }

  /**
   * ハッチへ吸い込まれる。
   * @param {THREE.Vector3} center ハッチの中心(世界座標)
   * @param {THREE.Vector3} normal ハッチの法線(部屋の内側向き)
   * @param {THREE.Color}   tint   行き先の水の色
   * @param {Function}      swap   覆われている一瞬に呼ばれる。ゾーンを入れ替える
   */
  enter(center, normal, tint, swap, audio) {
    if (this.active) return;
    this.swap = swap;
    this.audio = audio;
    this.tint.copy(tint);
    this.baseFov = this.camera.fov;
    this.dur = IN_DUR;
    this.outDur = OUT_DUR;

    this.p0.copy(this.camera.position);
    // 円板の面を 45cm 通り越したところで終わる。手前で止めると
    // 「扉の前まで来た」で終わってしまう
    this.p1.copy(center).addScaledVector(normal, -0.45);
    this.q0.copy(this.camera.quaternion);
    _probe.position.copy(this.p0);
    _probe.up.set(0, 1, 0);
    _probe.lookAt(center);
    this.q1.copy(_probe.quaternion);
    this.focus.copy(center);

    this.phase = 'in';
    this.t = 0;
    audio?.warp?.(1);
  }

  /** 施設へ帰る。くぐる先が無いので、視線の先へ短く引き込む */
  back(tint, swap, audio) {
    if (this.active) return;
    this.swap = swap;
    this.audio = audio;
    this.tint.copy(tint);
    this.baseFov = this.camera.fov;
    this.dur = BACK_IN;
    this.outDur = BACK_OUT;

    this.p0.copy(this.camera.position);
    this.camera.getWorldDirection(_fwd);
    this.p1.copy(this.p0).addScaledVector(_fwd, 3.2);
    this.q0.copy(this.camera.quaternion);
    this.q1.copy(this.camera.quaternion);
    this.focus.copy(this.p0).addScaledVector(_fwd, 8);

    this.phase = 'in';
    this.t = 0;
    audio?.warp?.(0);
  }

  /** 到着側の目標。ゾーンを入れ替えたあとに main から渡される */
  setArrival(pos, look, clearance) {
    this.a1 = pos.clone();
    // 到着地点の手前から滑り出す。真後ろへ下げると地形へ潜り込む
    // ことがあるので、下がったぶんだけ持ち上げて、床でも止める
    _fwd.copy(look).sub(pos).normalize();
    this.a0 = pos.clone().addScaledVector(_fwd, -3.6);
    this.a0.y += 0.9;
    const floor = sandHeight(this.a0.x, this.a0.z) + (clearance ?? 0.9);
    if (this.a0.y < floor) this.a0.y = floor;
    _probe.position.copy(this.a0);
    _probe.up.set(0, 1, 0);
    _probe.lookAt(look);
    this.q0.copy(_probe.quaternion);
    _probe.position.copy(pos);
    _probe.lookAt(look);
    this.q1.copy(_probe.quaternion);
    this.focus.copy(look);
  }

  update(dt) {
    if (!this.phase) return;
    const cam = this.camera;
    this.t += dt;

    if (this.phase === 'in') {
      const u = Math.min(this.t / this.dur, 1);
      // 加速する。t^2.6 は「引かれて落ちていく」ときの伸び方に近く、
      // 前半はほとんど動かず、最後の3割で一気に詰める
      const e = Math.pow(u, 2.6);
      cam.position.lerpVectors(this.p0, this.p1, e);
      // 向きは位置より早く決める。飛び込む先を見ないまま突っ込むと、
      // 何に吸い込まれたのか分からない
      cam.quaternion.slerpQuaternions(this.q0, this.q1,
        THREE.MathUtils.smoothstep(u * 1.45, 0, 1));
      cam.fov = this.baseFov + FOV_GAIN * Math.pow(u, 1.8);
      cam.updateProjectionMatrix();
      this._paint(u, e);

      if (u >= 1) {
        this.swap();          // ここで入れ替える。画面は覆われている
        this.phase = 'out';
        this.t = 0;
      }
      return;
    }

    // --- 出る ---
    const v = Math.min(this.t / this.outDur, 1);
    const e = 1 - Math.pow(1 - v, 2.6);      // 減速して着地
    cam.position.lerpVectors(this.a0, this.a1, e);
    cam.quaternion.slerpQuaternions(this.q0, this.q1, e);
    cam.fov = this.baseFov + FOV_GAIN * (1 - e);
    cam.updateProjectionMatrix();
    this._paint(1 - v, 1 - e);

    if (v >= 1) {
      cam.fov = this.baseFov;
      cam.updateProjectionMatrix();
      this.el.style.opacity = '0';
      // 自由カメラへ返す。位置と向きを引き継がないと、
      // 手を離した瞬間に元の場所へ戻ってしまう
      const d = this.diveCam;
      d.pos.copy(cam.position);
      d.vel.set(0, 0, 0);
      d.glide.set(0, 0, 0);
      // くぐっているあいだのドラッグは溜まったままになっている。
      // 捨てないと、着いた瞬間に画面がひと跳ねする
      d.panDelta.set(0, 0, 0);
      d.lookAt(this.focus);
      this.phase = null;
    }
  }

  /**
   * 覆いを描く。
   * a: 0→1 で閉じていく度合い / e: 位置の進み具合
   *
   * 中心はハッチの画面上の位置。単に画面中央から広げると、
   * 見ているものと関係のない場所から色が湧いてくることになる
   */
  _paint(a, e) {
    const cam = this.camera;
    _v.copy(this.focus).project(cam);
    const sx = THREE.MathUtils.clamp(_v.x * 0.5 + 0.5, -0.5, 1.5) * 100;
    const sy = THREE.MathUtils.clamp(0.5 - _v.y * 0.5, -0.5, 1.5) * 100;
    // 芯は最後に一気に開く。早くから覆うと、吸い込まれる絵そのものが
    // 見えなくなる
    const core = Math.pow(THREE.MathUtils.clamp((a - 0.40) / 0.60, 0, 1), 1.7);
    const edge = Math.pow(a, 1.25);
    // 芯の半径。進むほど広がって、最後に画面を飲む
    const r = 6 + 96 * Math.pow(a, 1.9);
    const dark = _dark.copy(this.tint).multiplyScalar(0.22);
    // いちばん下に、最後の2割だけ立ち上がるべた塗りを敷く。
    //
    // 放射状の層だけだと、画面の隅は最後まで 2% ほど透けたままで、
    // 入れ替えの瞬間に前のゾーンの輪郭が一瞬だけ見える。
    // 「覆われているあいだに差し替える」が前提なので、
    // ここは完全に塞げていないと理屈が崩れる
    const solid = THREE.MathUtils.smoothstep(a, 0.80, 1.0);
    this.el.style.background =
      `radial-gradient(circle at ${sx.toFixed(1)}% ${sy.toFixed(1)}%,`
      + ` ${rgba(this.tint, core)} 0%,`
      + ` ${rgba(this.tint, core * 0.55)} ${r.toFixed(1)}%,`
      + ` ${rgba(this.tint, 0)} ${(r + 26).toFixed(1)}%),`
      + `radial-gradient(circle at ${sx.toFixed(1)}% ${sy.toFixed(1)}%,`
      + ` ${rgba(dark, 0)} ${(18 + 30 * (1 - edge)).toFixed(1)}%,`
      + ` ${rgba(dark, edge * 0.96)} 100%),`
      + `linear-gradient(${rgba(dark, solid)}, ${rgba(dark, solid)})`;
    this.el.style.opacity = '1';
  }
}
