import * as THREE from 'three';
import { sandHeight } from './environment/seabed.js';

// ============ 衝突ワールド ============
// 障害物を軸平行な楕円体で近似して保持する。楕円体なら、扁平な岩や
// 細長い生物を1つの式で扱えて、押し出し方向も解析的に求まる。
//
//  hard : 実体のある障害物(岩・大型生物)。めり込んだら押し出す
//  soft : 実体のない障害物(海藻)。避ける操舵はするが押し出さない
//
// 地形(砂底)は高さ場なので専用に扱う。

const _n = new THREE.Vector3();
const _d = new THREE.Vector3();

export class CollisionWorld {
  constructor() {
    this.bodies = [];
  }

  /** 静的な障害物。center はコピーされる */
  addStatic(center, rx, ry, rz, { soft = false } = {}) {
    this.bodies.push({ center: center.clone(), rx, ry, rz, soft, ref: null });
    return this;
  }

  /** 動く障害物。ref.pos を毎フレーム参照する */
  addDynamic(ref, rx, ry, rz) {
    this.bodies.push({ center: null, rx, ry, rz, soft: false, ref });
    return this;
  }

  static _centerOf(b) {
    return b.ref ? b.ref.pos : b.center;
  }

  /**
   * めり込みを解消する。pos を最短距離で楕円体の外へ出し、
   * vel があれば面に食い込む速度成分を取り除いて滑らせる。
   * skipRef を渡すと自分自身を無視する。
   */
  pushOut(pos, radius, vel = null, skipRef = null) {
    let hit = false;
    for (const b of this.bodies) {
      if (b.soft) continue;
      if (b.ref && b.ref === skipRef) continue;
      const c = CollisionWorld._centerOf(b);
      if (!c) continue;
      const rx = b.rx + radius, ry = b.ry + radius, rz = b.rz + radius;
      const ux = (pos.x - c.x) / rx;
      const uy = (pos.y - c.y) / ry;
      const uz = (pos.z - c.z) / rz;
      const d2 = ux * ux + uy * uy + uz * uz;
      if (d2 >= 1 || d2 < 1e-9) continue;

      const d = Math.sqrt(d2);
      // 正規化空間で表面まで戻す
      const k = (1 - d) / d;
      pos.x += ux * rx * k;
      pos.y += uy * ry * k;
      pos.z += uz * rz * k;

      if (vel) {
        // 楕円体表面の法線(勾配)
        _n.set(ux / rx, uy / ry, uz / rz).normalize();
        const into = vel.dot(_n);
        if (into < 0) vel.addScaledVector(_n, -into);
      }
      hit = true;
    }
    return hit;
  }

  /**
   * 障害物から離れる力を求める。range だけ余裕を持たせた楕円体に
   * 入っていたら、外向きの力を積む。近づいている(closing)ほど強い。
   */
  avoidForce(pos, vel, radius, range, out, skipRef = null) {
    out.set(0, 0, 0);
    const speed = vel.length();
    for (const b of this.bodies) {
      if (b.ref && b.ref === skipRef) continue;
      const c = CollisionWorld._centerOf(b);
      if (!c) continue;
      const rx = b.rx + radius + range;
      const ry = b.ry + radius + range;
      const rz = b.rz + radius + range;
      const ux = (pos.x - c.x) / rx;
      const uy = (pos.y - c.y) / ry;
      const uz = (pos.z - c.z) / rz;
      const d2 = ux * ux + uy * uy + uz * uz;
      if (d2 >= 1) continue;

      const d = Math.max(Math.sqrt(d2), 1e-4);
      _d.set(pos.x - c.x, pos.y - c.y, pos.z - c.z);
      if (_d.lengthSq() < 1e-8) _d.set(0, 1, 0);
      _d.normalize();
      // 相手に向かって進んでいるほど強く反応する
      const closing = speed > 1e-4 ? Math.max(-vel.dot(_d) / speed, 0) : 0;
      out.addScaledVector(_d, (1 - d) * (0.4 + closing * 1.6));
    }
    return out;
  }

  /** 前方 lookAhead 先の地形の高さ(登り坂を先読みする) */
  terrainAhead(pos, dirX, dirZ, lookAhead) {
    return sandHeight(pos.x + dirX * lookAhead, pos.z + dirZ * lookAhead);
  }
}

/** 砂底にめり込ませない。clearance は体の半径ぶんの余裕 */
export function clampToTerrain(pos, clearance, vel = null) {
  const y = sandHeight(pos.x, pos.z) + clearance;
  if (pos.y < y) {
    pos.y = y;
    if (vel && vel.y < 0) vel.y *= -0.15;
    return true;
  }
  return false;
}
