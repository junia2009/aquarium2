import * as THREE from 'three';

// ============ タップ/クリックの当たり判定 ============
// 画面をタップした「音圧」をどこに発生させるかを決める。
// カメラから固定距離に置くと群れの奥行きが合ったときしか反応しないので、
// 群れ自身の位置からレイに沿った奥行きを求める。

const _v = new THREE.Vector3();

/** レイに最も近い個体を返す。{ idx, perp, t } / 該当なしは idx = -1 */
export function nearestAlongRay(ray, positions, count) {
  let bestPerp2 = Infinity, bestIdx = -1, bestT = 0;
  for (let i = 0; i < count; i++) {
    _v.copy(positions[i]).sub(ray.origin);
    const t = _v.dot(ray.direction);
    if (t < 0.5) continue; // カメラの背後は無視
    const perp2 = Math.max(_v.lengthSq() - t * t, 0);
    if (perp2 < bestPerp2) { bestPerp2 = perp2; bestIdx = i; bestT = t; }
  }
  return { idx: bestIdx, perp: Math.sqrt(bestPerp2), t: bestT };
}

/**
 * 群れに対する音圧の発生点。
 * 直撃(垂線距離 < hitRadius)ならその個体の位置、
 * 外れていても最寄り個体と同じ奥行きのレイ上に置くので、
 * 群れがどの距離にいてもタップが届く。
 * 該当個体がなければ null。
 */
export function disturbPoint(ray, school, hitRadius, out) {
  const hit = nearestAlongRay(ray, school.pos, school.count);
  if (hit.idx < 0) return null;
  if (hit.perp < hitRadius) out.copy(school.pos[hit.idx]);
  else out.copy(ray.origin).addScaledVector(ray.direction, hit.t);
  return out;
}
