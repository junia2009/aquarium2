import * as THREE from 'three';
import { WORLD } from '../env.js';
import { wander1 } from '../noise.js';
import { clampToTerrain } from '../collision.js';

// ============ 群泳(ボイド)シミュレーション ============
// 分離・整列・結集の古典3則 + 遊泳目標のゆらぎ + 捕食者回避 +
// 驚愕反応(flash expansion: 群れが爆発的に散開して再集合する実挙動)。
// 近傍探索は一様グリッドで O(n)。

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _avoid = new THREE.Vector3();

/**
 * 単位球のなかの一様な点。餌の雲の内側を偏りなく埋めるのに使う。
 * 毎フレーム呼ばれるので、渡された Vector3 に書きこんで確保はしない
 */
function randomInBall(v) {
  do { v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1); }
  while (v.lengthSq() > 1);
  return v;
}

export class School {
  constructor({
    mesh,            // InstancedMesh
    count,
    params = {},
    center = new THREE.Vector3(0, 8, 0),
    homeRadius = 18,
    seed = 1,
  }) {
    this.mesh = mesh;
    this.count = count;
    this.seed = seed;
    this.center = center.clone();
    this.homeRadius = homeRadius;
    this.p = {
      perception: 2.6,     // 近傍認知半径(側線+視覚)
      sepDist: 0.85,
      maxSpeed: 6.5,
      minSpeed: 2.2,
      maxForce: 14,
      wSep: 1.6,
      wAli: 1.0,
      wCoh: 0.75,
      wHome: 0.6,
      yMin: 2.5,
      yMax: WORLD.surfaceY - 2.5,
      burstSpeed: 12,      // 驚愕時の瞬発速度
      bodyRadius: 0.28,    // 当たり判定の半径
      avoidRange: 1.4,     // 障害物を避け始める余裕
      ...params,
    };

    this.pos = [];
    this.vel = [];
    this.panics = []; // {pos, t0, radius, strength}
    this.lures = [];  // {pos, radius, strength} — 毎フレーム作り直す
    this.bait = null; // 餌のありか。あれば回遊目標より優先される
    this.baitSpread = 1.3;
    // 餌の雲のなかで個体ごとに狙う点。全員が中心を狙うと外側で
    // 押しあうだけになって、いつまでも粒に口が届かない
    this.baitOff = [];
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * homeRadius * 0.4;
      this.pos.push(new THREE.Vector3(
        center.x + Math.cos(a) * r,
        THREE.MathUtils.clamp(center.y + (Math.random() - 0.5) * 4, this.p.yMin, this.p.yMax),
        center.z + Math.sin(a) * r
      ));
      const sp = (this.p.minSpeed + this.p.maxSpeed) * 0.5;
      this.vel.push(new THREE.Vector3(Math.cos(a + 2), (Math.random() - 0.5) * 0.5, Math.sin(a + 2)).normalize().multiplyScalar(sp));
    }
    this.grid = new Map();
    this.schoolCenter = center.clone();
    this.time = 0;
    // 警戒度。隣の個体から次々に伝播する(実魚の驚愕が群れを走る現象)
    this.alarm = new Float32Array(count);
    this.alarmNext = new Float32Array(count);
    for (let i = 0; i < count; i++) this.baitOff.push(randomInBall(new THREE.Vector3()));
  }

  /**
   * 誘引点。チョウチンアンコウの擬餌のように「近寄ってしまう光」を置く。
   * 1フレーム限りなので、置く側が毎フレーム呼び直す。
   * 警戒中の個体には効かない(逃げている魚は光に見とれない)。
   */
  lure(point, radius = 6, strength = 3.5) {
    this.lures.push({ pos: point, radius, strength });
  }

  /**
   * 餌のありか。群れ全体の回遊目標をそこへ置きかえる。
   *
   * lure() は半径のなかの個体を引き寄せるだけなので、群れが遠くにいると
   * いつまでも気づかない。実際、水槽の反対側にいたイワシが餌の時間に
   * 寄ってくるのは一匹ずつが誘われるからではなく、群れごと向きを変えるから。
   * なので誘引とは別に、回遊の行き先そのものを餌へ向ける。
   * lure と同じく1フレーム限りなので、置く側が毎フレーム呼び直す。
   */
  feedAt(point, spread = 1.3) { this.bait = point; this.baitSpread = spread; }

  // クリック等による驚愕反応
  scare(point, radius = 9, strength = 60) {
    this.panics.push({ pos: point.clone(), t0: this.time, radius, strength });
    if (this.panics.length > 4) this.panics.shift();
  }

  cellKey(v, cs) {
    const x = Math.floor(v.x / cs) & 1023;
    const y = Math.floor(v.y / cs) & 1023;
    const z = Math.floor(v.z / cs) & 1023;
    return x | (y << 10) | (z << 20);
  }

  update(dt, predators = [], world = null) {
    this.time += dt;
    const p = this.p;
    const cs = p.perception;

    // グリッド構築
    this.grid.clear();
    for (let i = 0; i < this.count; i++) {
      const key = this.cellKey(this.pos[i], cs);
      let arr = this.grid.get(key);
      if (!arr) { arr = []; this.grid.set(key, arr); }
      arr.push(i);
    }

    // 群れ全体の遊泳目標(ゆっくり回遊する)
    const t = this.time * 0.05 + this.seed * 31;
    const target = _v3.set(
      this.center.x + wander1(t, this.seed) * this.homeRadius * 0.75,
      THREE.MathUtils.clamp(this.center.y + wander1(t + 50, this.seed) * 4.5, p.yMin + 1, p.yMax - 1),
      this.center.z + wander1(t + 100, this.seed) * this.homeRadius * 0.75
    );
    // 餌があるならそちらへ。行き先ごと差し替えるので、群れは
    // 遠くにいても向きを変えて寄ってくる
    if (this.bait) {
      target.set(this.bait.x, THREE.MathUtils.clamp(this.bait.y, p.yMin + 0.5, p.yMax - 0.5), this.bait.z);
    }

    const panicActive = this.panics.filter(pp => this.time - pp.t0 < 2.2);
    this.panics = panicActive;

    const centerAccum = _v2.set(0, 0, 0);

    for (let i = 0; i < this.count; i++) {
      const pos = this.pos[i];
      const vel = this.vel[i];
      const force = _v1.set(0, 0, 0);

      // ---- 近傍走査 ----
      let sepX = 0, sepY = 0, sepZ = 0;
      let aliX = 0, aliY = 0, aliZ = 0;
      let cohX = 0, cohY = 0, cohZ = 0;
      let nCount = 0;
      let nbrAlarm = 0;
      const cx = Math.floor(pos.x / cs), cy = Math.floor(pos.y / cs), cz = Math.floor(pos.z / cs);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const key = ((cx + dx) & 1023) | (((cy + dy) & 1023) << 10) | (((cz + dz) & 1023) << 20);
        const cell = this.grid.get(key);
        if (!cell) continue;
        for (const j of cell) {
          if (j === i) continue;
          const other = this.pos[j];
          const ox = pos.x - other.x, oy = pos.y - other.y, oz = pos.z - other.z;
          const d2 = ox * ox + oy * oy + oz * oz;
          if (d2 > cs * cs || d2 < 1e-6) continue;
          const d = Math.sqrt(d2);
          if (d < p.sepDist) {
            const inv = 1 / (d * d + 0.01);
            sepX += ox * inv; sepY += oy * inv; sepZ += oz * inv;
          }
          const ov = this.vel[j];
          aliX += ov.x; aliY += ov.y; aliZ += ov.z;
          cohX += other.x; cohY += other.y; cohZ += other.z;
          if (this.alarm[j] > nbrAlarm) nbrAlarm = this.alarm[j];
          nCount++;
          if (nCount > 12) break; // 認知上限(実魚も近傍数匹しか見ない)
        }
        if (nCount > 12) break;
      }

      if (nCount > 0) {
        const inv = 1 / nCount;
        // 餌についているあいだは隊列がゆるむ。プランクトン食の魚が
        // 餌の塊にたどりつくと、整った群れの形はいったん崩れて
        // めいめいが粒を追う。食べ終わるとまた隊列に戻る
        const g = this.bait ? 0.4 : 1;
        // 整列: 平均速度へ
        force.x += (aliX * inv - vel.x) * p.wAli * g;
        force.y += (aliY * inv - vel.y) * p.wAli * g;
        force.z += (aliZ * inv - vel.z) * p.wAli * g;
        // 結集: 近傍重心へ
        force.x += (cohX * inv - pos.x) * p.wCoh * g;
        force.y += (cohY * inv - pos.y) * p.wCoh * g;
        force.z += (cohZ * inv - pos.z) * p.wCoh * g;
      }

      // ---- 餌の粒へ ----
      // 狙った点まで来たら次の点を選びなおす。これで群れは雲のなかを
      // 絶えずかき回すように動き、止まってしまわない
      if (this.bait) {
        const o = this.baitOff[i], sp = this.baitSpread;
        const bx = this.bait.x + o.x * sp, by = this.bait.y + o.y * sp, bz = this.bait.z + o.z * sp;
        const dx = bx - pos.x, dy = by - pos.y, dz = bz - pos.z;
        if (dx * dx + dy * dy + dz * dz < 0.16) randomInBall(o);
        force.x += dx * 1.2; force.y += dy * 1.2; force.z += dz * 1.2;
      }

      // ---- 遊泳目標へ(弱い引力) ----
      force.x += (target.x - pos.x) * 0.06 * p.wHome;
      force.y += (target.y - pos.y) * 0.10 * p.wHome;
      force.z += (target.z - pos.z) * 0.06 * p.wHome;

      // ---- 境界(soft wall) ----
      const rr = Math.hypot(pos.x - this.center.x, pos.z - this.center.z);
      if (rr > this.homeRadius) {
        const push = (rr - this.homeRadius) * 2.0;
        force.x -= (pos.x - this.center.x) / rr * push;
        force.z -= (pos.z - this.center.z) / rr * push;
      }
      if (pos.y < p.yMin) force.y += (p.yMin - pos.y) * 6;
      if (pos.y > p.yMax) force.y -= (pos.y - p.yMax) * 6;

      // ---- 岩・海藻・大型生物の回避 ----
      if (world) {
        world.avoidForce(pos, vel, p.bodyRadius, p.avoidRange, _avoid);
        force.addScaledVector(_avoid, 22);
      }

      // ---- 捕食者・障害物回避 ----
      let panicked = 0;
      for (const pr of predators) {
        const dx = pos.x - pr.pos.x, dy = pos.y - pr.pos.y, dz = pos.z - pr.pos.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        const R = pr.radius;
        if (d2 < R * R && d2 > 1e-4) {
          const d = Math.sqrt(d2);
          const s = (1 - d / R) * 40;
          force.x += dx / d * s; force.y += dy / d * s; force.z += dz / d * s;
          panicked = Math.max(panicked, 1 - d / R);
        }
      }

      // ---- 驚愕反応(flash expansion) ----
      for (const pp of panicActive) {
        const age = this.time - pp.t0;
        const decay = Math.exp(-age * 2.2);
        const dx = pos.x - pp.pos.x, dy = pos.y - pp.pos.y, dz = pos.z - pp.pos.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < pp.radius * pp.radius && d2 > 1e-4) {
          const d = Math.sqrt(d2);
          const s = (1 - d / pp.radius) * pp.strength * decay;
          force.x += dx / d * s; force.y += dy / d * s; force.z += dz / d * s;
          panicked = Math.max(panicked, decay);
        }
      }

      // ---- 誘引(擬餌への接近) ----
      // 引力は距離に反比例させず、近いほど強くする。深海の小魚が
      // 光の一点へ吸い寄せられていく、あの動きになる
      for (const lu of this.lures) {
        const dx = lu.pos.x - pos.x, dy = lu.pos.y - pos.y, dz = lu.pos.z - pos.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < lu.radius * lu.radius && d2 > 1e-4) {
          const d = Math.sqrt(d2);
          const s = lu.strength * (1 - d / lu.radius) * (1 - panicked);
          force.x += dx / d * s; force.y += dy / d * s; force.z += dz / d * s;
        }
      }

      // ---- 警戒の伝播 ----
      // 直接刺激を受けた個体だけでなく、隣の慌てた仲間を見た個体も反応する。
      // 1フレームで1ホップずつ伝わるので、驚愕が群れを波のように走る。
      const relayed = nbrAlarm * 0.90 - dt * 0.9;
      const alarm = THREE.MathUtils.clamp(Math.max(panicked, relayed), 0, 1);
      this.alarmNext[i] = alarm;

      // ---- 分離(警戒時は強まり、群れが爆発的に広がる) ----
      if (nCount > 0) {
        const sw = p.wSep * 3.0 * (1 + alarm * 4.0);
        force.x += sepX * sw;
        force.y += sepY * sw;
        force.z += sepZ * sw;
      }

      // ---- 積分 ----
      const fLen = force.length();
      const maxF = p.maxForce * (1 + alarm * 3);
      if (fLen > maxF) force.multiplyScalar(maxF / fLen);
      vel.addScaledVector(force, dt);

      const speed = vel.length();
      const maxS = p.maxSpeed + (p.burstSpeed - p.maxSpeed) * alarm;
      if (speed > maxS) vel.multiplyScalar(maxS / speed);
      else if (speed < p.minSpeed) vel.multiplyScalar(p.minSpeed / Math.max(speed, 1e-4));

      pos.addScaledVector(vel, dt);

      // ---- めり込みの解消 ----
      if (world) world.pushOut(pos, p.bodyRadius, vel);
      clampToTerrain(pos, p.bodyRadius + 0.15, vel);

      centerAccum.add(pos);
    }

    // 警戒度のバッファを入れ替える(全個体が同じ時刻の値を参照するように)
    const swap = this.alarm;
    this.alarm = this.alarmNext;
    this.alarmNext = swap;

    this.schoolCenter.copy(centerAccum).multiplyScalar(1 / this.count);
    // 誘引点は1フレーム限り。置いた側が毎フレーム置き直す
    this.lures.length = 0;
    this.bait = null;
    this.writeMatrices(dt);
  }

  writeMatrices(dt) {
    const mesh = this.mesh;
    for (let i = 0; i < this.count; i++) {
      const pos = this.pos[i];
      const vel = this.vel[i];
      _fwd.copy(vel).normalize();
      _up.set(0, 1, 0);
      _right.crossVectors(_up, _fwd).normalize();
      _up.crossVectors(_fwd, _right);
      // 旋回によるバンク(横加速度に応じて体を傾ける)
      // 速度方向の変化を右方向成分で近似
      _m.makeBasis(_right, _up, _fwd);
      _m.setPosition(pos);
      mesh.setMatrixAt(i, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
}

// InstancedMesh用の個体差属性を作る
export function makeSchoolInstanceAttr(geo, count, sizeRange = [0.85, 1.15]) {
  const info = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    info[i * 4 + 0] = Math.random() * Math.PI * 2;                       // 位相
    info[i * 4 + 1] = 0.85 + Math.random() * 0.3;                        // 速度倍率
    info[i * 4 + 2] = sizeRange[0] + Math.random() * (sizeRange[1] - sizeRange[0]); // サイズ
    info[i * 4 + 3] = Math.random();                                     // 色個体差
  }
  geo.setAttribute('aInfo', new THREE.InstancedBufferAttribute(info, 4));
  return info;
}
