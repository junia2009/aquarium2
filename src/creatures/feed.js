import * as THREE from 'three';
import { baseUniforms, U, WORLD } from '../env.js';

// ============ 餌 ============
//
// 水族館でいちばん人が集まるのは餌の時間で、それは魚が動くからではなく
// 「魚がこちらの行動に応えて動く」からだと思う。眺めるだけの水槽と、
// 一度でも餌をまいた水槽とでは、そのあとの見え方が変わる。
//
// なので餌は「粒を撒くエフェクト」ではなく、
//   ・撒いた粒が世界に残り、漂い、沈み、やがて散る
//   ・生き物がそれを目指して寄り、1粒ずつ食べて減っていく
// という状態にした。減っていくのが見えないと、食べているように見えない。
//
// 餌の種類はゾーンで違う。
//   プランクトン: ほとんど動かず、ゆっくり沈む。イワシとジンベエザメ
//   オキアミ    : 自分で泳ぐ。群れを作り、捕食者が来ると跳ねて散る
//   小魚        : 水面近くで銀色にひらめく。イルカ
//   有機物      : 沈降物。深海へまっすぐ落ちていく
//
// 粒は最大でも200ほどなので、CPUで動かして毎フレーム転送している。
// 「食べたら消える」を素直に書くには、GPU任せにしないほうがいい。

const MAX = 220;

// tint  色 / size 粒の大きさ / sink 沈降速度(m/s) / dart 自分で泳ぐ強さ
// cohere 群れの中心へ寄る強さ / life 消えるまでの秒数
// rate  1秒あたりに食べられる口数。フレームレートに依らせないための上限で、
//       これがないと速いPCほど餌が一瞬で消える(=食べる場面が見られない)
export const FEED_KINDS = {
  // うっすら緑がかった懸濁物。ほとんど自分では動かない
  plankton: { tint: [0.62, 0.86, 0.66], size: 0.055, sink: 0.10, dart: 0.0, cohere: 0.0, life: 42, rate: 7 },
  // オキアミ。赤みがあり、密な群れを作って自分で泳ぐ
  krill: { tint: [1.00, 0.44, 0.36], size: 0.070, sink: 0.02, dart: 0.55, cohere: 1.3, life: 40, rate: 6 },
  // 小魚。水面近くでひらめく
  fry: { tint: [0.86, 0.90, 0.96], size: 0.085, sink: 0.03, dart: 0.85, cohere: 1.0, life: 34, rate: 5 },
  // 沈降する有機物。深海ではこれが唯一の食べもの
  detritus: { tint: [0.78, 0.74, 0.66], size: 0.060, sink: 0.34, dart: 0.0, cohere: 0.0, life: 50, rate: 5 },
};

// 群れが固まりきらないための最小半径。これより内側では寄せない
const SWARM_CORE = 0.8;

export class FeedCloud {
  /**
   * @param kind FEED_KINDS のいずれか(キー文字列)
   */
  constructor(parent, kind = 'plankton') {
    this.k = FEED_KINDS[kind] || FEED_KINDS.plankton;
    this.n = 0;                       // 生きている粒の数
    this.credit = 0;                  // このフレームに残っている口数
    this.pos = [];
    this.vel = [];
    this.age = new Float32Array(MAX);
    this.ph = new Float32Array(MAX);  // 揺らぎの位相
    for (let i = 0; i < MAX; i++) {
      this.pos.push(new THREE.Vector3());
      this.vel.push(new THREE.Vector3());
      this.ph[i] = Math.random() * 100;
    }
    this.buf = new Float32Array(MAX * 3);
    this.alphaBuf = new Float32Array(MAX);
    this.center = new THREE.Vector3();

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.buf, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphaBuf, 1));
    geo.setDrawRange(0, 0);
    this.geo = geo;

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        ...baseUniforms(),
        uTint: { value: new THREE.Color(...this.k.tint) },
        uSize: { value: this.k.size },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      },
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        uniform float uSize;
        uniform float uPixelRatio;
        attribute float aAlpha;
        varying float vA;
        void main() {
          vA = aAlpha;
          vec4 mv = viewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uSize * 900.0 * uPixelRatio / max(-mv.z, 0.1);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uTint;
        varying float vA;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          if (d > 0.5) discard;
          // 中が濃く縁がぼける粒。四角い点にすると紙吹雪になる
          float a = (1.0 - smoothstep(0.16, 0.5, d)) * vA;
          gl_FragColor = vec4(uTint * (0.7 + 0.6 * (1.0 - d * 2.0)), a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 57;
    parent.add(this.points);
  }

  /** ひとつかみ撒く。撒いた点を中心に、少し散らして落とす */
  drop(p, count = 90, spread = 0.9) {
    for (let c = 0; c < count && this.n < MAX; c++) {
      const i = this.n++;
      const a = Math.random() * Math.PI * 2;
      const r = Math.pow(Math.random(), 0.5) * spread;
      this.pos[i].set(
        p.x + Math.cos(a) * r,
        p.y + (Math.random() - 0.5) * spread * 0.8,
        p.z + Math.sin(a) * r
      );
      // 撒いた勢い。手から離れた粒は少し散ってから落ち着く
      this.vel[i].set((Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.5,
                      (Math.random() - 0.5) * 0.8);
      this.age[i] = 0;
    }
    this.center.copy(p);
  }

  /** i 番目を消して、末尾の粒を詰める */
  remove(i) {
    const last = --this.n;
    if (i !== last) {
      this.pos[i].copy(this.pos[last]);
      this.vel[i].copy(this.vel[last]);
      this.age[i] = this.age[last];
      this.ph[i] = this.ph[last];
    }
  }

  /**
   * 球のなかの粒を食べる。食べた数を返す。
   * 生き物側は「近づいて、口が届いたら呼ぶ」だけでよい。
   *
   * 呼ぶ側は毎フレーム呼ぶので、ここで口数を秒あたりに制限している。
   * こうしないと減る速さが描画のフレームレートで変わってしまい、
   * 速いPCでは撒いた瞬間に消えて、餌に群がる場面そのものが見られない。
   *
   * @param max 一度に飲みこめる数。ジンベエザメのような濾過摂食者は複数
   */
  eatNear(p, radius, max = 1) {
    if (this.credit < 1) return 0;
    const r2 = radius * radius;
    let ate = 0;
    for (let i = 0; i < this.n && ate < max && this.credit >= 1; i++) {
      if (this.pos[i].distanceToSquared(p) < r2) {
        this.remove(i); i--; ate++; this.credit -= 1;
      }
    }
    return ate;
  }

  /** いちばん近い粒。生き物が狙う先 */
  nearest(p, maxDist, out) {
    let best = -1, bd = maxDist * maxDist;
    for (let i = 0; i < this.n; i++) {
      const d = this.pos[i].distanceToSquared(p);
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) return null;
    return out.copy(this.pos[best]);
  }

  /** 群れが向かう先。生きている粒の重心 */
  focus(out) {
    if (this.n === 0) return null;
    out.set(0, 0, 0);
    for (let i = 0; i < this.n; i++) out.add(this.pos[i]);
    return out.multiplyScalar(1 / this.n);
  }

  get active() { return this.n > 0; }

  /**
   * @param hunters 近づくと餌が逃げる相手(オキアミと小魚だけ)。
   *                {pos} の配列
   */
  update(dt, floorAt = null, hunters = null) {
    const k = this.k;
    const t = U.uTime.value;
    // このフレームぶんの口数を配る。溜めこめるのは2口までで、
    // カクついたフレームのあとにまとめて消えることがないようにしている
    this.credit = Math.min((this.credit || 0) + dt * k.rate, 2);
    // 自分で泳ぐ餌は群れる。オキアミの群れは動物の集団としては
    // 世界でいちばん密なものの部類で、散らばったままだと餌に見えない
    let cx = 0, cy = 0, cz = 0;
    if (k.cohere > 0 && this.n > 0) {
      for (let i = 0; i < this.n; i++) { cx += this.pos[i].x; cy += this.pos[i].y; cz += this.pos[i].z; }
      cx /= this.n; cy /= this.n; cz /= this.n;
    }
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      if (this.age[i] > k.life) { this.remove(i); i--; continue; }
      const p = this.pos[i], v = this.vel[i];
      // 撒いた勢いは水の粘性ですぐ抜ける
      v.multiplyScalar(Math.exp(-2.2 * dt));
      v.y -= k.sink * dt * 2.0;
      v.y = Math.max(v.y, -k.sink);
      // 自分で泳ぐ餌。オキアミは群れのなかで小刻みに向きを変える
      if (k.dart > 0) {
        const ph = this.ph[i];
        v.x += Math.sin(t * 3.1 + ph) * k.dart * dt;
        v.y += Math.sin(t * 2.3 + ph * 1.7) * k.dart * 0.5 * dt;
        v.z += Math.cos(t * 2.7 + ph * 1.3) * k.dart * dt;
        // 群れの中心へ戻る。中心の近くでは効かせないので、
        // 一点に潰れずに雲のかたちを保つ。捕食者に散らされたあと
        // ゆっくり集まりなおすのも、これがやっている
        if (k.cohere > 0) {
          const dx = cx - p.x, dy = cy - p.y, dz = cz - p.z;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d > SWARM_CORE) {
            const s = k.cohere * Math.min((d - SWARM_CORE) * 0.6, 1) * dt / d;
            v.x += dx * s; v.y += dy * s; v.z += dz * s;
          }
        }
        // 捕食者が来ると跳ねて散る。オキアミの逃避反応(テイルフリップ)は
        // 動物プランクトンでいちばん速い部類で、これがあると
        // 「食べられている」のが一目で分かる
        if (hunters) {
          for (const h of hunters) {
            const dx = p.x - h.pos.x, dy = p.y - h.pos.y, dz = p.z - h.pos.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < 2.2 * 2.2 && d2 > 1e-4) {
              const s = (1 - Math.sqrt(d2) / 2.2) * 7.0 * dt / Math.sqrt(d2);
              v.x += dx * s; v.y += dy * s; v.z += dz * s;
            }
          }
        }
      }
      p.addScaledVector(v, dt);
      // 底に着いたら止まる。そこで食べられるのを待つ
      if (floorAt) {
        const fy = floorAt(p.x, p.z) + 0.06;
        if (p.y < fy) { p.y = fy; v.y = 0; v.x *= 0.4; v.z *= 0.4; }
      }
      if (p.y > WORLD.surfaceY - 0.05) { p.y = WORLD.surfaceY - 0.05; v.y = Math.min(v.y, 0); }

      this.buf[i * 3] = p.x; this.buf[i * 3 + 1] = p.y; this.buf[i * 3 + 2] = p.z;
      // 撒きはじめは湧いて出るように、終わりは溶けるように
      this.alphaBuf[i] = Math.min(this.age[i] * 4, 1)
                       * (1 - Math.max((this.age[i] - k.life * 0.7) / (k.life * 0.3), 0));
    }
    this.geo.setDrawRange(0, this.n);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }
}
