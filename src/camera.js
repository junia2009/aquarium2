import * as THREE from 'three';
import { WORLD } from './env.js';
import { sandHeight } from './environment/seabed.js';

// ============ ダイバー視点の自由カメラ ============
// OrbitControls のような「注視点の軸」を持たず、ダイバーのように泳ぎ回れる。
//   左ドラッグ            : 見回す(視線の回転)
//   右ドラッグ / Shift+ドラッグ: 平行移動(上下左右)
//   ホイール              : 前進・後退(視線方向へ滑空)
//   WASD / 矢印 + E(上) Q(下): 遊泳移動、Shiftで加速
//   タッチ: 1本指=見回す, 2本指=平行移動+ピンチで前後
// 追跡モード中は視線と距離だけ緩やかに補正し、操作の自由は残す。

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export class DiveCamera {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;

    // 姿勢(YXZ: ロールなし)
    this.yaw = 0;
    this.pitch = 0;
    this.targetYaw = 0;
    this.targetPitch = 0;

    this.pos = camera.position.clone();
    this.vel = new THREE.Vector3();       // キー移動(平滑)
    this.glide = new THREE.Vector3();     // ホイール/ピンチの滑空(減衰)
    this.panDelta = new THREE.Vector3();  // ドラッグ平行移動(即時適用分)

    this.keys = new Set();
    this.pointers = new Map();
    this.pinchDist = 0;
    this.follow = null; // { getter, minD, maxD }
    this.world = null;  // 衝突ワールド(岩などをすり抜けない)
    // 地面からどれだけ上まで降りられるか。
    //
    // 既定の0.9mは「潜っている人の体の半径」で、水中のゾーンではこれでよい。
    // ただし磯のように被写体が数cmの生き物だと、0.9m上からでは
    // 甲幅5cmのカニが画面の3%にしかならず、追跡しても何も見えない。
    // 見るものの大きさはゾーンごとに桁が違うので、ゾーンごとに決める
    this.clearance = 0.9;

    this._bind();
  }

  /** 地面からの最低の高さ。ゾーンを切り替えるたびに設定しなおす */
  setClearance(v) {
    this.clearance = v;
  }

  lookAt(p) {
    _v.copy(p).sub(this.pos).normalize();
    this.targetYaw = this.yaw = Math.atan2(-_v.x, -_v.z);
    this.targetPitch = this.pitch = Math.asin(THREE.MathUtils.clamp(_v.y, -1, 1));
  }

  setFollow(getter, minD = 5, maxD = 15) {
    this.follow = { getter, minD, maxD };
  }

  clearFollow() {
    this.follow = null;
  }

  _bind() {
    const dom = this.dom;
    dom.style.touchAction = 'none';

    dom.addEventListener('pointerdown', (e) => {
      dom.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey });
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });

    dom.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;

      if (this.pointers.size === 2) {
        // ---- 2本指: 平行移動 + ピンチ前後 ----
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const pinch = dist - this.pinchDist;
        this.pinchDist = dist;
        this._dolly(pinch * 0.045);
        this._pan(dx * 0.5, dy * 0.5);
      } else if (p.button === 2 || p.button === 1 || p.shift) {
        // ---- 右/中ドラッグ, Shift+ドラッグ: 平行移動 ----
        this._pan(dx, dy);
      } else {
        // ---- 左ドラッグ: 見回す(シーンが指についてくる向き) ----
        this.targetYaw += dx * 0.0028;
        this.targetPitch += dy * 0.0028;
        this.targetPitch = THREE.MathUtils.clamp(this.targetPitch, -1.35, 1.35);
      }
    });

    const release = (e) => {
      this.pointers.delete(e.pointerId);
    };
    dom.addEventListener('pointerup', release);
    dom.addEventListener('pointercancel', release);

    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._dolly(-e.deltaY * 0.014);
    }, { passive: false });

    dom.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      // 遊び方の動画などを開いている間は泳がない
      if (document.body.classList.contains('modal-open')) return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  // 視線方向へ滑空する速度を加える
  _dolly(amount) {
    this.camera.getWorldDirection(_fwd);
    this.glide.addScaledVector(_fwd, amount);
  }

  // 画面基準の平行移動(即時適用分に積む)
  _pan(dx, dy) {
    const scale = 0.017 * (this.camera.fov / 58);
    _right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    _v.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    this.panDelta.addScaledVector(_right, -dx * scale);
    this.panDelta.addScaledVector(_v, dy * scale);
  }

  _keyVelocity(out) {
    out.set(0, 0, 0);
    const k = this.keys;
    const fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const strafe = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const lift = (k.has('KeyE') || k.has('Space') ? 1 : 0) - (k.has('KeyQ') || k.has('KeyC') ? 1 : 0);
    if (!fwd && !strafe && !lift) return out;

    // 水平は視線のヨーのみ、上下はワールド軸(ダイバーの感覚)
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    out.x = (-sy * fwd + cy * strafe);
    out.z = (-cy * fwd - sy * strafe);
    out.y = lift;
    out.normalize();
    const speed = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) ? 16 : 7;
    return out.multiplyScalar(speed);
  }

  update(dt) {
    // ---- キー移動(慣性つき) ----
    const target = this._keyVelocity(_v);
    this.vel.lerp(target, 1 - Math.exp(-5 * dt));
    this.pos.addScaledVector(this.vel, dt);

    // ---- 滑空(ホイール/ピンチ)は緩やかに減衰、速度上限あり ----
    if (this.glide.length() > 9) this.glide.setLength(9);
    this.pos.addScaledVector(this.glide, dt * 6);
    this.glide.multiplyScalar(Math.exp(-3.2 * dt));

    // ---- ドラッグ平行移動 ----
    this.pos.add(this.panDelta);
    this.panDelta.set(0, 0, 0);

    // ---- 追跡モード: 視線と距離を緩やかに補正 ----
    if (this.follow) {
      const tp = this.follow.getter();
      _v.copy(tp).sub(this.pos);
      const dist = _v.length();
      // 離れすぎ/近すぎだけ引き戻す(操作の自由は残す)
      if (dist > this.follow.maxD) {
        this.pos.addScaledVector(_v.normalize(), (dist - this.follow.maxD) * (1 - Math.exp(-2.5 * dt)));
      } else if (dist < this.follow.minD) {
        this.pos.addScaledVector(_v.normalize(), (dist - this.follow.minD) * (1 - Math.exp(-2.5 * dt)));
      }
      // 視線をゆっくり対象へ
      _v.copy(tp).sub(this.pos).normalize();
      const desYaw = Math.atan2(-_v.x, -_v.z);
      const desPitch = Math.asin(THREE.MathUtils.clamp(_v.y, -1, 1));
      const pull = 1 - Math.exp(-1.6 * dt);
      this.targetYaw += wrapAngle(desYaw - this.targetYaw) * pull;
      this.targetPitch += (desPitch - this.targetPitch) * pull;
    }

    // ---- 岩などをすり抜けない ----
    if (this.world) this.world.pushOut(this.pos, 0.6, this.glide);

    // ---- 世界の境界(砂・水面・遠すぎ防止) ----
    const floorLimit = sandHeight(this.pos.x, this.pos.z) + this.clearance;
    if (this.pos.y < floorLimit) this.pos.y = floorLimit;
    // 水面は抜けられる。上空は見晴らし台くらいの高さで止める
    if (this.pos.y > WORLD.surfaceY + 26) this.pos.y = WORLD.surfaceY + 26;
    const r = Math.hypot(this.pos.x, this.pos.z);
    const maxR = 42;
    if (r > maxR) {
      this.pos.x *= maxR / r;
      this.pos.z *= maxR / r;
    }

    // ---- 姿勢の平滑化 ----
    const s = 1 - Math.exp(-14 * dt);
    this.yaw += wrapAngle(this.targetYaw - this.yaw) * s;
    this.pitch += (this.targetPitch - this.pitch) * s;

    this.camera.position.copy(this.pos);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}
