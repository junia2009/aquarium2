import * as THREE from 'three';
import { clampToTerrain } from '../collision.js';

// ============ 定住性の魚(クマノミなど)の遊泳 ============
// 縄張りの中で目標点を選んでは移動を繰り返す。
// クマノミ特有の「腰を振る」落ち着きのない泳ぎを再現するため、
// 目標の切り替えを速く、加減速を強めにしている。

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _m = new THREE.Matrix4();

export class Wanderer {
  constructor({ mesh, count, home, radius = 2.5, speed = [0.7, 1.9], retarget = [1.0, 2.8] }) {
    this.mesh = mesh;
    this.count = count;
    this.home = home.clone();
    this.radius = radius;
    this.speedRange = speed;
    this.retarget = retarget;
    this.fish = [];
    for (let i = 0; i < count; i++) {
      this.fish.push({
        pos: home.clone().add(new THREE.Vector3(
          (Math.random() - 0.5) * radius,
          Math.random() * radius * 0.5,
          (Math.random() - 0.5) * radius
        )),
        vel: new THREE.Vector3(0.1, 0, 0),
        target: home.clone(),
        timer: Math.random() * 2,
      });
    }
  }

  pickTarget(f) {
    // まれに縄張りの外周まで出て、すぐ戻る
    const far = Math.random() < 0.12 ? 2.2 : 1.0;
    const a = Math.random() * Math.PI * 2;
    const r = (0.4 + Math.random() * 0.6) * this.radius * far;
    f.target.set(
      this.home.x + Math.cos(a) * r,
      this.home.y + 0.4 + Math.random() * this.radius * 0.9,
      this.home.z + Math.sin(a) * r
    );
    f.timer = this.retarget[0] + Math.random() * (this.retarget[1] - this.retarget[0]);
  }

  update(dt) {
    const [sMin, sMax] = this.speedRange;
    for (let i = 0; i < this.count; i++) {
      const f = this.fish[i];
      f.timer -= dt;
      if (f.timer <= 0 || f.pos.distanceTo(f.target) < 0.3) this.pickTarget(f);

      // 目標へのシーク + 減衰
      const desired = _fwd.copy(f.target).sub(f.pos);
      const d = desired.length();
      desired.normalize().multiplyScalar(THREE.MathUtils.clamp(d * 2.0, sMin, sMax));
      f.vel.lerp(desired, 1 - Math.exp(-3.2 * dt));
      f.pos.addScaledVector(f.vel, dt);
      // 砂にめり込ませない(イソギンチャクは住処なので避けない)
      clampToTerrain(f.pos, 0.35, f.vel);

      // 姿勢(進行方向へ滑らかに向く)
      _fwd.copy(f.vel);
      _fwd.y *= 0.55; // 体はあまり上下に傾けない
      if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1);
      _fwd.normalize();
      _up.set(0, 1, 0);
      _right.crossVectors(_up, _fwd).normalize();
      _up.crossVectors(_fwd, _right);
      _m.makeBasis(_right, _up, _fwd);
      _m.setPosition(f.pos);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  get center() {
    return this.fish[0].pos;
  }
}
