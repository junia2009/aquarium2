import * as THREE from 'three';
import { baseUniforms, WORLD, U } from '../env.js';
import { PENGUIN_KINDS, buildPenguinGeometry, STAND_PITCH, STAND_FOOT } from './penguin.js';
import { createFishMaterial } from './fishMaterial.js';
import { wander1 } from '../noise.js';
import { clampToTerrain } from '../collision.js';
import { sandHeight } from '../environment/seabed.js';

// ============ ペンギンの群れ ============
//
// 泳ぎの中身が、ここまでの生き物と根本的に違う。
// 魚もイルカも、体をくねらせて「連続的に」進む。ペンギンは翼を打つ鳥なので、
//   ・数回続けて強く打って加速し(バースト)
//   ・翼を左右に伸ばしたまま滑る(グライド)
// を繰り返す。速度計を付ければ、のこぎりの歯のような波形になる。
// 一定速度で泳がせると、どれだけ翼を動かしても鳥には見えない。
//
// 打つ速さは一定ではないので、羽ばたきの位相は時間×周波数では作れない。
// 速さを変えた瞬間に位相が飛んで、翼が瞬間移動してしまう。
// CPU側で位相を積分し、振幅とあわせて aInfo で渡す(→ fishMaterial.js)。

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _qb = new THREE.Matrix4();
const _axis = new THREE.Vector3();
const _bait = new THREE.Vector3();
const _bite = new THREE.Vector3();

const GRAVITY = 9.8;

// ============ 気泡の尾 ============
//
// 潜るペンギンは銀色の泡を引く。あれは吐いた息ではない。
// 羽毛のあいだに抱えこんだ空気が、加速と水圧で押し出されているもの。
// だから泡が出るのは「速く泳いだとき」と「深く潜ったとき」で、
// ゆっくり漂っているときには出ない。ここもそう作る。
//
// 粒は生まれた時刻・場所・初速だけをCPUが書き込み、その後の運動は
// GPUが計算する。書き込みが起きるのは粒が生まれる瞬間だけなので、
// 数百粒あってもCPUの負荷はほとんどない。
const BUBBLE_MAX = 1600;

class BubbleTrail {
  constructor(parent) {
    this.n = BUBBLE_MAX;
    this.head = 0;
    this.origin = new Float32Array(BUBBLE_MAX * 3);
    this.birth = new Float32Array(BUBBLE_MAX).fill(-999);
    this.vel = new Float32Array(BUBBLE_MAX * 3);
    this.seed = new Float32Array(BUBBLE_MAX * 2);
    for (let i = 0; i < BUBBLE_MAX; i++) {
      this.seed[i * 2 + 0] = Math.random();          // 大きさ
      this.seed[i * 2 + 1] = Math.random() * 100;    // 揺らぎの位相
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.origin, 3));
    geo.setAttribute('aBirth', new THREE.BufferAttribute(this.birth, 1));
    geo.setAttribute('aVel', new THREE.BufferAttribute(this.vel, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 2));
    this.geo = geo;

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        ...baseUniforms(),
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uSurfaceY;
        uniform float uPixelRatio;
        attribute float aBirth;
        attribute vec3 aVel;
        attribute vec2 aSeed;
        varying float vA;
        void main() {
          float age = uTime - aBirth;
          float life = 3.2 + aSeed.x * 2.0;
          if (aBirth < -900.0 || age < 0.0 || age > life) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; return;
          }
          vec3 p = position;
          // 生まれた瞬間の勢い(ペンギンの後流)は、粘性ですぐ抜ける
          p += aVel / 3.0 * (1.0 - exp(-3.0 * age));
          // 浮上。小さな泡は水の粘性に負けてゆっくりしか上がらない。
          // 大きい泡ほど速い(終端速度は半径にだいたい比例する)
          // 羽毛から出る泡はごく小さい(数mm)。小さい泡ほど水の粘性に
          // 負けて上がるのが遅く、そのぶん長く尾を引く
          float rise = 0.10 + aSeed.x * 0.22;
          p.y += rise * age;
          // 泡は上がりながら左右に揺れる。まっすぐ上げると噴水になる
          float ph = aSeed.y + age * 2.4;
          p.x += sin(ph) * 0.045 * age;
          p.z += cos(ph * 1.13) * 0.045 * age;

          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          // 上がるほど水圧が下がって膨らむ
          float grow = 1.0 + 0.25 * age;
          gl_PointSize = (0.0035 + aSeed.x * 0.0075) * grow * 900.0 * uPixelRatio / max(-mv.z, 0.1);
          // 水面に達したら消える
          vA = smoothstep(0.0, 0.25, age) * (1.0 - smoothstep(life * 0.6, life, age));
          vA *= smoothstep(0.0, 0.6, uSurfaceY - p.y);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          if (d > 0.5) discard;
          // 気泡は水と空気の境界。全反射で縁がいちばん明るく、中は抜ける
          float rim = smoothstep(0.30, 0.50, d) * smoothstep(0.5, 0.46, d);
          float hl = exp(-dot(c - vec2(-0.13, -0.13), c - vec2(-0.13, -0.13)) * 70.0);
          float a = (rim * 1.5 + hl * 0.8 + 0.04) * vA;
          gl_FragColor = vec4(vec3(0.82, 0.93, 1.0) * a, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 58;
    parent.add(this.points);
    this.dirty = false;
  }

  emit(pos, vel, time, spread = 0.05) {
    const i = this.head % this.n;
    this.head++;
    this.origin[i * 3 + 0] = pos.x + (Math.random() - 0.5) * spread;
    this.origin[i * 3 + 1] = pos.y + (Math.random() - 0.5) * spread;
    this.origin[i * 3 + 2] = pos.z + (Math.random() - 0.5) * spread;
    this.vel[i * 3 + 0] = vel.x * 0.35 + (Math.random() - 0.5) * 0.3;
    this.vel[i * 3 + 1] = vel.y * 0.35 + (Math.random() - 0.5) * 0.3;
    this.vel[i * 3 + 2] = vel.z * 0.35 + (Math.random() - 0.5) * 0.3;
    this.birth[i] = time;
    this.dirty = true;
  }

  flush() {
    if (!this.dirty) return;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aBirth.needsUpdate = true;
    this.geo.attributes.aVel.needsUpdate = true;
    this.dirty = false;
  }
}

export { BubbleTrail };

// ============ 群れ ============
export class PenguinFlock {
  /**
   * @param kind    PENGUIN_KINDS のいずれか
   * @param iceField createIceCanopy が返す field(氷の下面・甲板の高さ場)
   */
  constructor(parent, {
    kind = PENGUIN_KINDS.king,
    count = 6,
    center = new THREE.Vector3(0, 9, 0),
    radius = 16,
    iceField = null,
    bubbles = null,
    splash = null,
    openSpots = [],
    haulOuts = [],
  } = {}) {
    this.kind = kind;
    this.center = center.clone();
    this.radius = radius;
    this.iceField = iceField;
    this.bubbles = bubbles;
    this.splash = splash;
    this.openSpots = openSpots.length ? openSpots : [{ x: center.x, z: center.z }];
    this.haulOuts = haulOuts;
    this.time = 0;
    this.world = null;
    this.neighbors = null;
    // 餌。撒かれているあいだだけ、群れの用事がこれに変わる
    this.feed = null;
    this.feedT = 0;

    const geo = buildPenguinGeometry(kind);
    this.mat = createFishMaterial({
      pattern: 9,
      len: kind.total,
      species: kind.species,
      wing: geo.userData.wingRoot,
      neck: geo.userData.neckPivot,
      foot: geo.userData.footPivot,
      tail: geo.userData.tailPivot,
      // 体はほとんど曲げない。翼で進む鳥なので、うねりは硬直を避けるぶんだけ
      swim: { freq: 1.0, amp: 0.008, waveNum: 0.35, headAmp: 0.05, flapFreq: kind.beatFreq * 6.28 },
    });
    this.mesh = new THREE.InstancedMesh(geo, this.mat, count);
    this.mesh.frustumCulled = false;
    // 立ち姿の実測値(→ penguin.js の solveStand)。
    //   standDrop  体の原点から足裏まで。甲板からの浮かせ量そのもの
    //   standHalfW 接地面の左右の広がり。よちよち歩きで傾けたぶんの補正に使う
    //   standBend  尾をどれだけ後ろへ蹴り出せば足が接地するか
    this.standDrop = geo.userData.standDrop;
    this.standHalfW = geo.userData.standHalfW;
    this.standFwd = geo.userData.standFwd;
    this.standBend = geo.userData.standBend;
    this.hipDrop = geo.userData.hipDrop;

    // ---- 歩きの寸法 ----
    // 全部、脚の長さから出す。速さを先に決めて足を後から付けると、
    // どう動かしても氷を滑るだけになる(実際そうなっていた)。
    //   R      振り子の腕。脚を振る軸から足裏まで
    //   SWING  振り出しの片振幅。実測されている歩幅から逆算すると
    //          コウテイで26度ほどになる
    //   DUTY   一歩のうち接地している割合。歩行では両脚が同時に地面に
    //          着いている時間があり、宙に浮く瞬間は無い
    //   周期   脚を振り子と見たときの固有周期の1.6倍。ヒトも鳥も
    //          だいたいこの比のところで歩く
    const R = geo.userData.legReach;
    const SWING = 0.48, DUTY = 0.68;
    const strideT = 2 * Math.PI / (1.6 * Math.sqrt(9.8 / R));
    // 接地しているあいだに体が進む距離。これが一歩ぶん
    const step = 2 * R * Math.sin(SWING);
    this.gait = {
      R, swing: SWING, duty: DUTY, strideT,
      step,
      // 速さは歩幅と歩調の結果。ここを独立に決めた瞬間に足が滑る
      speed: step / (DUTY * strideT),
    };

    // aInfo は羽ばたき用に意味が変わる:
    //   x = 羽ばたきの位相(CPUが積分する) / y = 振幅(0で滑空)
    //   z = 体格 / w = 色ゆらぎ(体のうねりの位相にも使う)
    this.info = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      this.info[i * 4 + 0] = Math.random() * Math.PI * 2;
      this.info[i * 4 + 1] = 1;
      this.info[i * 4 + 2] = 0.92 + Math.random() * 0.16;
      this.info[i * 4 + 3] = Math.random();
    }
    this.infoAttr = new THREE.InstancedBufferAttribute(this.info, 4);
    geo.setAttribute('aInfo', this.infoAttr);
    // 姿勢。翼を畳む・首を曲げるといった「泳ぎ以外の格好」はここで作る。
    // 行列だけでは体が一本の棒のままなので、立ち姿も入水も作れない
    this.pose = new Float32Array(count * 4);
    this.poseAttr = new THREE.InstancedBufferAttribute(this.pose, 4);
    geo.setAttribute('aPose', this.poseAttr);
    // 関節が4つ(翼・首・足首・尾)になって vec4 に収まらなくなったぶん
    this.pose2 = new Float32Array(count * 4);
    this.pose2Attr = new THREE.InstancedBufferAttribute(this.pose2, 4);
    geo.setAttribute('aPose2', this.pose2Attr);
    // 個体差(見た目)。1羽ずつ違う顔と体格を持たせる。
    //   x = 太り具合 / y = 顔の模様のくせ / z = 首の長さ(m) / w = 羽色の濃さ
    // 一様乱数だと全員が「そこそこ違う」になって、かえって平均的な群れに
    // なる。実際は大多数が標準で、たまに際立った個体がいる。
    // 一様乱数を2つ足して0中心に寄せ、裾だけ伸ばす
    const bell = () => (Math.random() + Math.random() - 1);
    this.trait = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      this.trait[i * 4 + 0] = bell() * 0.11;                  // 太り具合
      this.trait[i * 4 + 1] = bell() * 1.15;                  // 顔のくせ
      this.trait[i * 4 + 2] = bell() * 0.022 * kind.total;    // 首の長さ
      // 褪せは少数派。大多数は艶のある黒で、たまに換羽前の褐色がいる
      this.trait[i * 4 + 3] = 1 - Math.pow(Math.random(), 2.2) * 0.45;
    }
    geo.setAttribute('aTrait', new THREE.InstancedBufferAttribute(this.trait, 4));
    parent.add(this.mesh);

    // ---- 群れの重心 ----
    // ペンギンは群れで海に出る。餌場へは隊列で泳ぎ、潜水も浮上も
    // そろえる。個体ごとに勝手な深さで勝手に息継ぎへ行かせると、
    // 同じ種が水槽じゅうに散らばって、どこを見ればいいのか分からない
    // 絵になる——実際そうなっていた。
    //
    // 重心をひとつ置いて、そこを泳がせる。個体はそれに寄り、向きを
    // そろえる。息継ぎも上陸も重心が決めて、全員で行く。
    this.pod = {
      pos: center.clone(),
      heading: Math.random() * Math.PI * 2,
      // 遊泳層のなかでの上下。0=層の底 1=層の天井
      level: 0.5,
      breath: kind.dive * (0.25 + Math.random() * 0.5),
      target: null,
      plan: 'porpoise',
      seed: Math.random() * 40,
    };
    // 群れの広がり。結束の強い種ほど密にかたまる。
    // アデリーはひとかたまり、キングはばらけて泳ぐ
    this.spread = Math.min(1.4 + 2.4 / Math.max(kind.cohesion, 0.5), 5.5);

    this.members = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random();
      // 個体ごとの体格倍率。立ち高さも歩幅も歩調も、これで伸び縮みする。
      // 倍率を掛け忘れると、大きい個体は氷に3cm埋まり、小さい個体は浮く
      const sc = this.info[i * 4 + 2];
      // せっかちさ。歩調に効くので、姿勢の前に決めておく
      const haste = 0.84 + Math.random() * 0.34;
      this.members.push({
        pos: new THREE.Vector3(
          center.x + Math.cos(a) * radius * 0.4,
          center.y + (Math.random() - 0.5) * 3,
          center.z + Math.sin(a) * radius * 0.4
        ),
        vel: new THREE.Vector3(),
        heading: a + 1.6,
        pitch: 0,
        bank: 0,
        seed: Math.random() * 50,
        speed: kind.speed,
        wingPhase: Math.random() * Math.PI * 2,
        wingAmp: 1,
        // バースト・グライドの交代。翼を打つ鳥の泳ぎはこの往復でできている
        stroking: true,
        phaseT: 0.6 + Math.random() * 1.6,
        state: 'swim',
        body: kind.total * 0.16,
        // 息継ぎ。潜水時間を使い切ると開水面か氷の縁へ向かう
        breath: kind.dive * (0.05 + Math.random() * 0.7),
        plan: 'porpoise',
        target: null,
        aimX: 0, aimZ: 0,
        arcs: 0,
        slide: 0,
        rest: 0,
        curiousT: 0,
        curX: 0, curY: 0, curZ: 0,
        // --- 姿勢(シェーダへ渡す) ---
        wingLift: 0,      // 翼の上下オフセット
        wingSweep: 0,     // 翼を体側へ畳む量
        neck: 0,          // 首の前傾
        feet: 0,          // 足の前倒し
        tail: 0,          // 尾の蹴り出し
        // --- 歩き ---
        scale: sc,
        // 歩調と速さ。振り子は長いほどゆっくり振れるので、
        // 大きい個体はゆったり大股に歩く。
        // せっかちな個体は同じ歩幅をより速く刻む。歩調を上げたぶん
        // 速さも同じ率で上げること——ここを片方だけ変えると
        // 「歩幅 = 速さ × 接地時間」が崩れて足が地面を滑る
        strideT: this.gait.strideT * Math.sqrt(sc) / haste,
        walkSpeed: this.gait.speed * Math.sqrt(sc) * haste,
        stride: Math.random() * Math.PI * 2,   // 歩調の位相
        hipL: 0, hipR: 0, // 左右の脚の振り
        swing: 0,         // 遊脚の縮み(符号でどちらの脚か)
        yaw: 0,           // 体のひねり
        waddle: 0,        // よちよち歩きの左右の振れ
        // --- 立ち止まり ---
        hoverT: 0,
        scull: 0,         // 漕ぎの位相

        // --- 気性 ---
        // 見た目だけ変えても、全員が同じ間合いで同じように動いていると
        // やはり双子に見える。せっかちな個体・のんびりした個体、
        // よく寄ってくる個体・警戒して離れている個体を作る。
        // どれも「その個体のくせ」であって、状況では変わらない
        //
        // せっかち。歩調と、立ち止まっていられる時間に効く
        haste,
        // 好奇心。潜水者に寄ってくるかどうかと、寄ってからの粘り
        nosy: 0.35 + Math.random() * 1.3,
        // 落ち着きのなさ。立っているときの首振りと向きの変えかた
        fidget: 0.55 + Math.random() * 1.1,
        // よちよちの深さ。体を大きく倒す個体とそうでない個体がいる
        rollAmp: 0.82 + Math.random() * 0.4,
      });
    }
  }

  setWorld(world) { this.world = world; }
  setNeighbors(list) { this.neighbors = list; }

  /** 図鑑からの追跡先。群れの平均ではなく先頭の個体を返す。
   *  散らばった群れの平均は、たいてい誰もいない空間を指してしまう */
  get lead() { return this.members[0].pos; }

  /**
   * 立っている個体を甲板からどれだけ浮かせるか。
   *
   * 素の standDrop は体をまっすぐ立てたときの足裏までの深さ。
   * よちよち歩きで体を左右へ倒すと、倒したぶん足裏の外側の角が
   * 下がるので、そのぶんを足す。これを忘れると、一歩ごとに
   * 足先が氷にめり込む
   */
  ground(m, load) {
    const w = m.waddle || 0, y = m.yaw || 0;
    const g = this.gait;
    const sc = m.scale;
    const cw = Math.cos(w), sw = Math.sin(w);
    const cy = Math.cos(y), sy = Math.sin(y);
    let lift = -1e9, sway = 0, surge = 0;
    const legs = [
      [m.hipL || 0, Math.max(-(m.swing || 0), 0), -this.standHalfW * sc, load ? load[0] : 0.5],
      [m.hipR || 0, Math.max(m.swing || 0, 0), this.standHalfW * sc, load ? load[1] : 0.5],
    ];
    for (const [hip, sh, sx, wt] of legs) {
      const d = (this.hipDrop + g.R * (1 - sh) * Math.cos(hip)) * sc;
      // 高さは深いほうに合わせる。浅いほうに合わせると足が甲板を突き抜ける。
      // 支持脚が垂直になる一歩の中間で体はいちばん高くなり、踏み替えで
      // いちばん低くなる——倒立振り子そのもの
      lift = Math.max(lift, d * cw - sx * sw);
      // 体を倒すときも、ひねるときも、回転の中心は体の真ん中ではなく
      // 接地した足。放っておくと倒すたびに支持足が6cm横滑りし、
      // ひねるたびに1cm前後する。体のほうを足の上へ送らなければならない。
      // 荷重で混ぜるのは、踏み替えで飛ばないようにするため
      sway += (sx * (1 - cw) - d * sw) * wt;
    }
    // ひねりのほうは打ち消せない。左右の足は前後にずれた位置に着いて
    // いるので、体を鉛直軸まわりに回せば、どちらかの足は必ずその場で
    // ひねられる。実際の足も氷の上でそうやって捻れているので、
    // 打ち消そうとするかわりに振れ幅のほうを抑えてある
    void cy; void sy;
    return { lift, sway };
  }

  /** 甲板からの浮かせ量だけが要るとき(立ち止まり) */
  liftAt(m) { return this.ground(m).lift; }

  /**
   * 一歩のなかの位相 u(0..1)から、その脚の振りと縮みを出す。
   *
   *   接地(u < duty): 足は地面に釘付け。体が前へ進むぶんだけ、脚は
   *     前方から後方へ振れていく。角度を時間に対して一次で動かすと
   *     足のずれは1mmに収まるので、そのまま一次で回す
   *   遊脚(u >= duty): 足を持ち上げて前へ運び直す。跗蹠を軸方向へ
   *     縮めて上げる。縮めないと、支持脚とすれ違う瞬間——両脚とも
   *     垂直になるところ——で足が地面を擦る
   */
  /** 脚をまっすぐに戻す(泳ぎ・空中・腹這い) */
  restLegs(m, dt, k) {
    const f = 1 - Math.exp(-k * dt);
    m.hipL += (0 - m.hipL) * f;
    m.hipR += (0 - m.hipR) * f;
    m.swing += (0 - m.swing) * f;
    m.yaw += (0 - m.yaw) * f;
  }

  gaitLeg(u) {
    const g = this.gait;
    if (u < g.duty) {
      return { th: g.swing * (2 * (u / g.duty) - 1), sh: 0, stance: true };
    }
    const b = (u - g.duty) / (1 - g.duty);
    return { th: g.swing * (1 - 2 * (b * b * (3 - 2 * b))),
             sh: Math.sin(Math.PI * b), stance: false };
  }

  /**
   * どちらの脚がどれだけ体重を受けているか(左, 右)。
   *
   * 「浮いていないほうの脚が支えている」で切り替えると、踏み替えの
   * 1フレームで体が左右に6cm跳ぶ。歩行には両脚が同時に着いている
   * 時間があって、そのあいだに荷重が片方からもう片方へ移っていく。
   * 倒し込みも、体を足の上へ送る量も、この配分から作る
   */
  loadAt(u) {
    const b = this.gait.duty - 0.5;        // 両脚接地の長さ
    const ease = (x) => { const c = Math.min(Math.max(x, 0), 1); return c * c * (3 - 2 * c); };
    if (u < b) { const k = ease(u / b); return [k, 1 - k]; }
    if (u < 0.5) return [1, 0];
    if (u < 0.5 + b) { const k = ease((u - 0.5) / b); return [1 - k, k]; }
    return [0, 1];
  }

  /**
   * 足が乗っている甲板の高さ。
   *
   * 足は体の真下ではなく、体長の2割ほど前にある。雪の吹き溜まりで
   * 甲板は数十センチうねっているので、体の位置で高さを引くと
   * 斜面の上で足だけが浮いたり埋まったりする
   */
  deckUnderFeet(m) {
    if (!this.iceField) return WORLD.surfaceY;
    // 足は硬い板なので、その下でいちばん高いところに乗る。
    // 一点だけ見ると、雪の起伏の谷を拾ったときに趾が雪に埋まる
    const f = this.standFwd * m.scale, half = this.standHalfW * m.scale * 1.6;
    const sx = Math.sin(m.heading), cz = Math.cos(m.heading);
    let d = -1e4;
    for (const a of [-half, 0, half]) {
      d = Math.max(d, this.iceField.deck(m.pos.x + sx * (f + a), m.pos.z + cz * (f + a)));
    }
    return d;
  }

  /** その位置で泳げる上限(氷の下面か水面) */
  ceilingAt(x, z) {
    return this.iceField ? this.iceField.under(x, z) : WORLD.surfaceY;
  }

  /**
   * 視線の先にいる個体を「気にさせる」。
   *
   * イワシは音圧で散り、深海のクラゲは警報を出すが、ペンギンは逆で、
   * 動くものがあると寄ってくる。潜水者のまわりを一周してのぞき込み、
   * 満足すると離れていく——南極の海でいちばんよく知られた行動なので、
   * ここでの「タップ」はそれにした。
   *
   * @returns 気にした個体がいれば true
   */
  curiousAlongRay(ray, slack = 1.0) {
    // 泳いでいても、漂っていても、息継ぎへ向かう途中でも寄ってくる。
    // 群れは一斉に動くようになったので、「泳いでいる個体だけ」に絞ると、
    // 群れが息継ぎに向かっているあいだタップがまるごと効かなくなる。
    // 実際のペンギンも、潜水者を見つけると用事を中断して見に来る
    const open = (m) => m.state === 'swim' || m.state === 'hover' || m.state === 'approach';
    let best = null, bestT = 1e9;
    for (const m of this.members) {
      if (!open(m)) continue;
      // 体を回転楕円体とみなして視線との交差を解く。
      // 「視線にいちばん近い個体」を選ぶと、はるか後ろの1羽が
      // 手前の1羽を差し置いて選ばれることがある
      const r = m.body * 1.6 + slack;
      _v.copy(m.pos).sub(ray.origin);
      const b = _v.dot(ray.direction);
      if (b < 0) continue;
      const disc = r * r - (_v.lengthSq() - b * b);
      if (disc < 0) continue;
      const tHit = b - Math.sqrt(disc);
      if (tHit > 0 && tHit < bestT) { bestT = tHit; best = m; }
    }
    if (!best) return false;
    // 当たった個体と、その近くの数羽が一緒に来る。ペンギンは群れで動く
    const px = ray.origin.x + ray.direction.x * 1.4;
    const py = ray.origin.y + ray.direction.y * 1.4;
    const pz = ray.origin.z + ray.direction.z * 1.4;
    for (const m of this.members) {
      if (!open(m)) continue;
      if (m !== best && m.pos.distanceTo(best.pos) > 6) continue;
      // 寄ってくるかどうかは個体による。臆病な個体はその場に留まる。
      // 全員がいっせいに寄ってくると、群れではなく一個の生き物に見える
      if (m !== best && m.nosy < 0.6) continue;
      // 漂っていた個体は泳ぎに戻ってから寄ってくる
      m.state = 'swim';
      m.stroking = true;
      m.phaseT = 1.4;
      // 好奇心の強い個体ほど長く付いてまわり、近くまで寄る
      m.curiousT = (5.5 + Math.random() * 3.5) * m.nosy;
      const shy = 2.2 / Math.max(m.nosy, 0.5);
      m.curX = px + (Math.random() - 0.5) * shy;
      m.curY = py + (Math.random() - 0.5) * shy * 0.64;
      m.curZ = pz + (Math.random() - 0.5) * shy;
    }
    return true;
  }

  /**
   * 餌に気づかせる。
   *
   * ペンギンの主食はオキアミで、群れで見つけて群れで突っ込む。
   * 大事なのは「群れごと向かうが、口に運ぶのは一羽ずつ」という点。
   * 全員が同じ一点へ吸い寄せられると団子になって、食べているようには
   * 見えない。個体はそれぞれ自分のいちばん近い粒を狙う。
   */
  noticeFeed(cloud) {
    this.feed = cloud;
    this.feedT = 30;
    // 漂っていた個体も泳ぎに戻る
    for (const m of this.members) {
      if (m.state === 'hover') { m.state = 'swim'; m.stroking = true; m.phaseT = 1.2; }
    }
  }

  /**
   * 息継ぎに行く。群れ全体でひとつの行き先を選び、全員で向かう。
   *
   *   ・たいていは開水面へ出て、水面すれすれをポーポイジングする。
   *     隊列で水面を切っていく「点線のような列」が、海のペンギンの姿
   *   ・ときどき氷へ跳び乗る(上陸点が近くにあるときだけ)
   *
   * 行き先を個体ごとに選ばせると、同じ群れが四方へ散る。
   * 実際のペンギンは潜るのも浮くのもそろっていて、群れ全体が
   * 一斉に消えて一斉に出てくる。
   */
  planSurfacing() {
    const p = this.pod;
    const wantIce = Math.random() < this.kind.haulOutChance && this.haulOuts.length;
    let best = null, bestD = 1e9;
    if (wantIce) {
      for (const h of this.haulOuts) {
        const d = Math.hypot(h.fromX - p.pos.x, h.fromZ - p.pos.z);
        if (d < bestD) { bestD = d; best = h; }
      }
    }
    if (best && bestD < 34) {
      p.plan = 'haulOut';
      p.target = best;
    } else {
      // 開水面へ。氷の下で浮上しても息はできない
      best = null; bestD = 1e9;
      for (const s of this.openSpots) {
        const d = Math.hypot(s.x - p.pos.x, s.z - p.pos.z);
        if (d < bestD) { bestD = d; best = s; }
      }
      p.plan = 'porpoise';
      p.target = best ? { x: best.x, z: best.z, fromX: best.x, fromZ: best.z } : null;
    }
    if (!p.target) { p.breath = this.kind.dive * 0.4; return; }

    const arcs = this.kind.arcs[0]
      + Math.floor(Math.random() * (this.kind.arcs[1] - this.kind.arcs[0] + 1));
    for (const m of this.members) {
      if (m.state !== 'swim' && m.state !== 'hover') continue;
      m.plan = p.plan;
      m.arcs = arcs;
      if (p.plan === 'haulOut') {
        // 同じ板を目指すが、着地点は少しずつずらす。同じ一点に跳ぶと
        // 全員が重なって立つことになる
        const a = Math.random() * Math.PI * 2, r = Math.random() * 1.3;
        m.target = { ...p.target, x: p.target.x + Math.cos(a) * r, z: p.target.z + Math.sin(a) * r };
      } else {
        m.target = p.target;
      }
      m.aimX = m.target.fromX; m.aimZ = m.target.fromZ;
      m.state = 'approach';
    }
  }

  /**
   * 群れの重心を進める。
   *
   * ふだんは餌場をゆるく蛇行し、息継ぎのときは行き先へ向かう。
   * 個体はこれに寄って泳ぐので、重心の動きがそのまま群れの動きになる。
   */
  updatePod(dt, t) {
    const p = this.pod, k = this.kind;
    const surf = WORLD.surfaceY;
    // まだ水中にいる仲間がいるあいだは、重心も付いていく
    let inWater = 0;
    for (const m of this.members) if (m.state === 'swim' || m.state === 'hover') inWater++;

    if (p.target) {
      // 息継ぎの往復が済んだら次の潜水へ。氷の上で休んでいる仲間は
      // 別の時計で動いているので、ここでは待たない
      let running = 0;
      for (const m of this.members) if (m.state === 'approach' || m.state === 'air') running++;
      if (running === 0) {
        p.target = null;
        p.breath = k.dive * (0.85 + Math.random() * 0.4);
      }
    } else {
      p.breath -= dt;
      if (p.breath <= 0 && inWater > 0) this.planSurfacing();
    }

    // 針路。餌があればそこへ、息継ぎ地点があればそこへ、
    // どちらも無ければ持ち場のなかを蛇行する
    let want;
    const bait = this.feedT > 0 && this.feed && this.feed.active
      ? this.feed.focus(_bait) : null;
    if (bait && !p.target) {
      want = Math.atan2(bait.x - p.pos.x, bait.z - p.pos.z);
    } else if (p.target) {
      want = Math.atan2(p.target.fromX - p.pos.x, p.target.fromZ - p.pos.z);
    } else {
      const dx = p.pos.x - this.center.x, dz = p.pos.z - this.center.z;
      const away = Math.hypot(dx, dz);
      want = p.heading + wander1(t * 0.13 + p.seed, p.seed) * 1.2;
      // 持ち場から出そうになったら戻る。群れごとに海域を分けておかないと、
      // 4種が同じところで団子になる
      if (away > this.radius) want = Math.atan2(-dx, -dz);
    }
    let diff = want - p.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    p.heading += THREE.MathUtils.clamp(diff * 1.4, -k.turnRate * 0.5, k.turnRate * 0.5) * dt;

    const podSpeed = k.speed * (p.target ? 0.85 : bait ? 0.80 : 0.45);
    p.pos.x += Math.sin(p.heading) * podSpeed * dt;
    p.pos.z += Math.cos(p.heading) * podSpeed * dt;
    // 重心が実際の群れから離れないよう、ゆるく引き戻す。
    // これが無いと、上陸などで足並みが乱れたとき重心だけが先へ行って、
    // 誰もいない場所を目指して全員が追いかけることになる
    if (inWater > 0) {
      let cx = 0, cz = 0;
      for (const m of this.members) {
        if (m.state !== 'swim' && m.state !== 'hover') continue;
        cx += m.pos.x; cz += m.pos.z;
      }
      const f = 1 - Math.exp(-0.5 * dt);
      p.pos.x += (cx / inWater - p.pos.x) * f;
      p.pos.z += (cz / inWater - p.pos.z) * f;
    }

    // 深さ。遊泳層のなかをゆっくり上下する。息継ぎへ向かうときは浅く
    const wantLevel = p.target ? 0.95 : 0.5 + 0.45 * wander1(t * 0.07 + p.seed * 2, p.seed);
    p.level += (wantLevel - p.level) * (1 - Math.exp(-0.6 * dt));
    const floor = sandHeight(p.pos.x, p.pos.z) + 1.0;
    const lo = floor + (surf - floor) * k.depth[0];
    const hi = floor + (surf - floor) * k.depth[1];
    p.pos.y = lo + (hi - lo) * p.level;
    // 餌があるあいだは、種ごとの遊泳層より餌の深さを優先する。
    // 層に閉じこめると、撒いた場所によっては誰も来ない
    if (bait && !p.target) p.pos.y += (bait.y - p.pos.y) * (1 - Math.exp(-1.2 * dt));
    if (this.feedT > 0) this.feedT -= dt;
  }

  /**
   * 誰かが先に入水したら、残りも続く。
   *
   * ペンギンが氷の縁で溜まってなかなか飛び込まないのは、いちばん最初に
   * 入るのがいちばん危ないから。逆に一羽が入ると堰を切ったように続く。
   */
  rally() {
    let i = 0;
    for (const m of this.members) {
      if (m.state !== 'onIce' || m.iceStage !== 'stand') continue;
      m.rest = Math.min(m.rest, 0.6 + (i++) * 0.9 + Math.random() * 0.8);
    }
  }

  update(dt) {
    this.time += dt;
    const t = this.time;
    const k = this.kind;
    this.updatePod(dt, t);
    const others = this.neighbors || this.members;
    const cruise = k.speed;
    const surf = WORLD.surfaceY;

    for (let i = 0; i < this.members.length; i++) {
      const m = this.members[i];

      // ================= 水の外 =================
      if (m.state === 'air' || m.state === 'onIce') {
        this.updateAirborne(m, dt, i);
        continue;
      }

      // ---- 息継ぎ ----
      // どこへ行くかは群れが決める(→ updatePod)。ここに残っているのは
      // 取り残された個体のための保険で、群れとはぐれたまま延々と
      // 潜り続けないようにするためのもの
      m.breath -= dt;
      if (m.state === 'swim' && m.breath <= 0 && !this.pod.target) {
        this.pod.breath = 0;
        m.breath = k.dive;
      }
      // 息継ぎに向かったまま水面へ出られないことがある(狙った割れ目が
      // ふさがっている、途中で氷に阻まれる)。諦めて泳ぎに戻す道を
      // 用意しておかないと、その個体は永遠に助走し続ける
      if (m.state === 'approach') {
        m.giveUp = (m.giveUp || 0) + dt;
        if (m.giveUp > 14) { m.state = 'swim'; m.giveUp = 0; m.breath = k.dive * 0.5; }
      } else m.giveUp = 0;

      // ---- バーストとグライドの交代 ----
      // 打っているあいだは加速し、止めているあいだは減速する。
      // 速度が一定だと、翼をいくら振っても推進しているように見えない
      m.phaseT -= dt;
      if (m.phaseT <= 0) {
        m.stroking = !m.stroking;
        m.phaseT = m.stroking
          ? 1.2 + Math.random() * 1.6      // 打つ
          : 1.1 + Math.random() * 2.2;     // 滑る
        // 滑りに入るとき、ときどきそのまま止まる。
        // ペンギンは常に泳いでいるわけではなく、水中で立ち止まって
        // あたりを見回している時間がかなりある。ここが無いと、
        // 何かに追われているように延々と走り続けることになる
        if (!m.stroking && m.state === 'swim' && m.curiousT <= 0
            && Math.random() < k.hoverChance) {
          m.state = 'hover';
          m.hoverT = k.hoverTime[0] + Math.random() * (k.hoverTime[1] - k.hoverTime[0]);
          m.scull = 0;
        }
      }
      let target = m.stroking ? cruise * 1.60 : cruise * 0.42;
      // 餌を追っているあいだは滑らない。翼を打ち続けて追いかける
      const chasing = this.feedT > 0 && this.feed && this.feed.active && m.state === 'swim';
      if (chasing) { target = cruise * 1.5; m.stroking = true; m.phaseT = 1.0; }
      if (m.state === 'hover') {
        // ほぼ静止。前へ進むためではなく、その場に留まるために漕ぐ。
        // 翼は小刻みに速く、振幅は小さい(前進の羽ばたきとは別の動き)
        m.hoverT -= dt;
        target = cruise * 0.10;
        m.scull += dt;
        if (m.hoverT <= 0) { m.state = 'swim'; m.stroking = true; m.phaseT = 1.2; }
      }
      // 打ち出しは速く、惰性の減速はやや遅い(推力が消えて抵抗だけになる)。
      // ここを近づけすぎると速度がほぼ一定になり、翼をいくら動かしても
      // 「進んでいる」ように見えない——最初がまさにそれだった
      let rate = m.stroking ? 2.4 : 1.25;
      if (m.state === 'approach') {
        // 助走中は打ちっぱなし。水面を割るには巡航の倍は要る
        target = cruise * (m.plan === 'haulOut' ? 2.5 : 1.9);
        rate = 2.2;
        m.stroking = true;
        m.phaseT = 1.0;
      }
      m.speed += (target - m.speed) * (1 - Math.exp(-rate * dt));

      // ---- 翼 ----
      // 打つ速さは出したい推力で決まる。速く泳ぐほど速く打つ。
      // 位相は積分する(時間×周波数だと、速さを変えた瞬間に翼が飛ぶ)
      const effort = THREE.MathUtils.clamp((m.speed - cruise * 0.5) / cruise, 0, 1.6);
      const rateHz = m.state === 'hover'
        ? k.beatFreq * 1.45        // 漕ぎは速く小さく
        : k.beatFreq * (0.55 + 0.75 * effort);
      m.wingPhase += rateHz * Math.PI * 2 * dt;
      if (m.wingPhase > Math.PI * 2) m.wingPhase -= Math.PI * 2;
      // 滑空では翼を左右に伸ばしたまま止める。振幅を0へ落とすと
      // その姿勢になる。ただし打つのをやめた瞬間に止めるのではなく、
      // 振り切ってから静かに畳む
      const wantAmp = m.state === 'hover' ? 0.30 : m.stroking ? 1 : 0.06;
      m.wingAmp += (wantAmp - m.wingAmp) * (1 - Math.exp(-(m.stroking ? 7 : 3.6) * dt));
      // 水中の姿勢。泳いでいるときは翼を横へ張り、首はまっすぐ。
      // 立ち止まっているときだけ首を少し上げてあたりを見る
      const wantSweep = m.state === 'hover' ? 0.22 : 0.0;
      // 水中では脚を尾のうしろへ伸ばし、尾ともども一直線の舵にする
      m.feet += (0 - m.feet) * (1 - Math.exp(-4 * dt));
      m.tail += (0 - m.tail) * (1 - Math.exp(-4 * dt));
      this.restLegs(m, dt, 4);
      m.waddle *= Math.exp(-5 * dt);
      const wantNeck = m.state === 'hover'
        ? -0.20 + 0.28 * Math.sin(m.scull * 1.1 + m.seed)   // 見回す
        : 0.0;
      m.wingSweep += (wantSweep - m.wingSweep) * (1 - Math.exp(-3 * dt));
      m.neck += (wantNeck - m.neck) * (1 - Math.exp(-2.6 * dt));

      // ---- 針路 ----
      let turn;
      // 餌がいちばん優先。近くの粒をひとつ狙い、口が届いたら食べる
      const bite = chasing ? this.feed.nearest(m.pos, 16, _bite) : null;
      if (bite) {
        if (m.pos.distanceTo(bite) < m.body * 1.7) {
          this.feed.eatNear(m.pos, m.body * 2.0);
          m.neck = -0.28;          // 食いつく瞬間だけ首を伸ばす
        }
        const want = Math.atan2(bite.x - m.pos.x, bite.z - m.pos.z);
        let diff = want - m.heading;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        turn = diff * 3.4;
      } else if (m.curiousT > 0) {
        // のぞきに来ている。近づいたら速度を落として、まわりを回る
        m.curiousT -= dt;
        const d = Math.hypot(m.curX - m.pos.x, m.curZ - m.pos.z);
        const want = d > 2.2
          ? Math.atan2(m.curX - m.pos.x, m.curZ - m.pos.z)
          : Math.atan2(m.curX - m.pos.x, m.curZ - m.pos.z) + 1.25;   // 近くでは回り込む
        let diff = want - m.heading;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        turn = diff * 3.0;
      } else if (m.state === 'approach') {
        // 息継ぎ地点へまっすぐ向かう
        const want = Math.atan2(m.aimX - m.pos.x, m.aimZ - m.pos.z);
        let diff = want - m.heading;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        turn = diff * 2.6;
      } else {
        // ---- 群れについていく ----
        // 重心へ寄る力と、隊列をそろえる力の2つ。
        // 「持ち場から出たら中心へ戻す」だけだと、囲いのなかを
        // 銘々に泳ぐ雲になって群れには見えない。寄る先が動いていて、
        // かつ向きがそろっていて、はじめて群れになる
        // 銘々の蛇行。旋回の鋭い種でこれを大きくすると、群れにいるのに
        // ひとりでうろうろしているように見えるので頭を押さえる
        turn = wander1(t * 0.22 + m.seed * 3, m.seed)
             * Math.min(0.3 + k.turnRate * 0.22, 0.8);
        const dx = this.pod.pos.x - m.pos.x, dz = this.pod.pos.z - m.pos.z;
        const r = Math.hypot(dx, dz);
        // 群れの内側にいるあいだは自由。外へ出るほど強く引き戻される
        const pull = THREE.MathUtils.clamp((r - this.spread * 0.45) / this.spread, 0, 1.5);
        if (pull > 0) {
          let diff = Math.atan2(dx, dz) - m.heading;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          turn += diff * pull * (0.9 + k.cohesion * 0.8);
        }
        // 隊列。まわりと同じ向きへそろえる
        let ad = this.pod.heading - m.heading;
        while (ad > Math.PI) ad -= Math.PI * 2;
        while (ad < -Math.PI) ad += Math.PI * 2;
        turn += ad * (0.5 + k.cohesion * 0.5);
      }
      // 仲間との近接回避
      for (const o of others) {
        if (o === m) continue;
        const ox = m.pos.x - o.pos.x, oz = m.pos.z - o.pos.z;
        const oy = m.pos.y - o.pos.y;
        const near = (m.body + o.body) * 2.6;
        const d2 = ox * ox + oz * oz;
        if (d2 < near * near && Math.abs(oy) < near && d2 > 1e-4) {
          const away = Math.atan2(ox, oz);
          let diff = away - m.heading;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          turn += diff * (1 - Math.sqrt(d2) / near) * 2.2;
        }
      }
      m.heading += THREE.MathUtils.clamp(turn, -k.turnRate, k.turnRate) * dt;
      // 翼で進む生き物は、曲がるとき体ごと大きく傾ける。
      // 舵で曲がる魚と違い、傾けた翼の揚力そのもので曲がるため
      const wantBank = THREE.MathUtils.clamp(-turn * 0.55, -1.0, 1.0);
      m.bank += (wantBank - m.bank) * (1 - Math.exp(-4 * dt));

      // ---- 深さ ----
      const floor = sandHeight(m.pos.x, m.pos.z) + m.body + 0.6;
      // 遊泳層は種ごと。キングは海底近くまで潜って長く留まり、
      // ジェンツーとアデリーは浅い層を走る。同じ水槽の別の高さで
      // 暮らしているように見せる
      const bandLo = floor + (surf - floor) * k.depth[0];
      const bandHi = floor + (surf - floor) * k.depth[1];
      // 深さも群れでそろえる。銘々の深さで泳がせると、上から下まで
      // まんべんなく散らばって層が見えなくなる
      let targetY = THREE.MathUtils.clamp(
        this.pod.pos.y + this.spread * 0.45 * wander1(t * 0.10 + m.seed, m.seed),
        bandLo, bandHi);
      if (bite) targetY = bite.y;
      if (m.curiousT > 0) targetY = m.curY;
      // 立ち止まっているあいだは深さを変えない
      if (m.state === 'hover') targetY = m.pos.y + Math.sin(m.scull * 1.7) * 0.04;
      // 頭上を塞いでいるのは氷だけ。水面は壁ではない。
      // ここを一律に「水面まで」で止めると、跳ぶための上向きの速度が
      // 作れず、いつまでも水面下をなぞるだけになる(実際そうなった)
      const iced = this.iceField ? this.iceField.hasIce(m.pos.x, m.pos.z) : false;
      const ceil = iced ? this.ceilingAt(m.pos.x, m.pos.z) - m.body - 0.25 : surf + 3.0;
      let dist2Aim = 1e9;
      if (m.state === 'approach') {
        dist2Aim = Math.hypot(m.aimX - m.pos.x, m.aimZ - m.pos.z);
        // 息継ぎ地点の手前で潜り、そこから斜めに駆け上がる。
        // 水面直下を横に走ってから跳ぼうとしても、上向きの速度が作れない。
        // 目標は水面より上に置く。水面ちょうどに置くと、近づくほど
        // 残り距離が0に収束して上昇がゆるみ、水平になってしまう
        targetY = dist2Aim > 9 ? surf - 5.0 : surf + 2.5;
      }
      targetY = THREE.MathUtils.clamp(targetY, floor, Math.max(ceil, floor + 0.2));

      const dy = targetY - m.pos.y;
      const vy = THREE.MathUtils.clamp(dy * 1.6, -m.speed * 0.75, m.speed * 0.85);
      m.pitch += (Math.atan2(vy, m.speed) - m.pitch) * (1 - Math.exp(-5 * dt));

      const ch = Math.cos(m.pitch) * m.speed;
      m.vel.set(Math.sin(m.heading) * ch, Math.sin(m.pitch) * m.speed, Math.cos(m.heading) * ch);
      m.pos.addScaledVector(m.vel, dt);

      // ---- 離水 ----
      // 水面へ達したところで弾道へ切り替える。速度はここで作り直さず、
      // 助走で得たものをそのまま引き継ぐ(作り直すと、水面で
      // 一瞬にして仰角が変わり、跳ね上がったように見える)
      if (m.state === 'approach' && m.pos.y > surf - m.body * 0.6 && m.vel.y > 0) {
        this.launch(m, dist2Aim);
        continue;
      }

      if (this.world) this.world.pushOut(m.pos, m.body, m.vel);
      clampToTerrain(m.pos, m.body + 0.3, m.vel);
      // 氷は突き抜けさせない。押し戻すだけでなく、上向きの速度も殺す。
      // 氷が無いところでは何もしない——水面は通り抜けてよい
      if (this.iceField && this.iceField.hasIce(m.pos.x, m.pos.z)) {
        const hardCeil = this.ceilingAt(m.pos.x, m.pos.z) - m.body * 0.6;
        if (m.pos.y > hardCeil) {
          m.pos.y = hardCeil;
          if (m.vel.y > 0) m.vel.y = 0;
          m.pitch = Math.min(m.pitch, 0);
        }
      } else if (m.state !== 'approach' && m.pos.y > surf - m.body * 0.7) {
        // ふだんの遊泳では水面から出ない。出るのは息継ぎのときだけ
        m.pos.y = surf - m.body * 0.7;
        if (m.vel.y > 0) m.vel.y = 0;
        m.pitch = Math.min(m.pitch, 0);
      }

      // ---- 気泡の尾 ----
      // 羽毛の空気は、加速したときと深いところで押し出される。
      // 漂っているときに出しっぱなしにすると、ただの泡発生装置になる
      if (this.bubbles && m.state !== 'hover') {
        const depth = Math.max(WORLD.surfaceY - m.pos.y, 0);
        const push = THREE.MathUtils.clamp((m.speed - cruise * 0.9) / (cruise * 0.6), 0, 1);
        const rateB = push * (0.8 + depth * 0.16) * 62;
        m.bubbleAcc = (m.bubbleAcc || 0) + rateB * dt;
        while (m.bubbleAcc >= 1) {
          m.bubbleAcc -= 1;
          // 泡は背中と翼の付け根から抜ける。尾のあたりに置くと
          // 「排気」に見えてしまう
          // 泡は一点からではなく、背中から尾にかけて全体から抜ける。
          // 一点から出すと排気管になる
          const along = -Math.random() * 0.55 * k.total / Math.max(m.speed, 0.5);
          _v.copy(m.pos).addScaledVector(m.vel, along);
          _v.y += m.body * 0.45;
          this.bubbles.emit(_v, m.vel, U.uTime.value, m.body * 0.9);
        }
      }

      // ---- 姿勢 ----
      this.poseAt(m, i);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.infoAttr.needsUpdate = true;
    this.poseAttr.needsUpdate = true;
    this.pose2Attr.needsUpdate = true;
    if (this.bubbles) this.bubbles.flush();
  }

  /**
   * 離水。助走で得た速度をそのまま弾道へ渡す。
   *
   * ポーポイジングは「息継ぎのついでの跳躍」ではなく、速く泳ぐための手段。
   * 水面ぎわを泳ぐと造波抵抗で急に重くなるので、ある速さを超えると
   * 空中を飛んだほうが安く済む。だから弧は低く長い。
   * 氷へ跳び乗るときだけは話が別で、板の高さを越える必要があるから
   * 立ち上がりが急になる。
   */
  launch(m, distToAim) {
    const surf = WORLD.surfaceY;
    m.pos.y = surf;
    if (m.plan === 'haulOut') {
      // 板の乾舷を越える高さが要る。真上に近い角度で強く跳ぶ
      const h = this.iceField
        ? Math.max(this.iceField.deck(m.target.x, m.target.z) - surf, 0.3)
        : 0.4;
      const reach = Math.hypot(m.target.x - m.pos.x, m.target.z - m.pos.z);
      // まず板を越える高さを満たす初速を出し、その滞空時間で
      // 着地点まで届くかを見る。届かないなら、水平を速くするのではなく
      // もっと高く跳ぶ(滞空時間を伸ばす)。水平だけ上げると
      // 板をかすめて向こうへ飛び越してしまう
      let vy = Math.sqrt(2 * GRAVITY * (h + 0.55));
      let flight = 2 * vy / GRAVITY;
      const FWD_MAX = 5.5;
      if (reach / flight > FWD_MAX) {
        flight = reach / FWD_MAX;
        vy = Math.min(flight * GRAVITY / 2, 7.5);
        flight = 2 * vy / GRAVITY;
      }
      const fwd = THREE.MathUtils.clamp(reach / flight, 0.8, FWD_MAX);
      m.heading = Math.atan2(m.target.x - m.pos.x, m.target.z - m.pos.z);
      m.vel.set(Math.sin(m.heading) * fwd, vy, Math.cos(m.heading) * fwd);
    } else {
      // ポーポイジングの弧。低く長い
      const fwd = Math.max(m.speed * 0.92, 3.0);
      const vy = 1.9 + Math.random() * 0.9;
      m.vel.set(Math.sin(m.heading) * fwd, vy, Math.cos(m.heading) * fwd);
    }
    m.state = 'air';
    m.wingAmp = 0.25;         // 空中では翼を伸ばしたまま
    if (this.splash) this.splash.burst(_v.copy(m.pos), U.uTime.value, 0.34);
  }

  /** 空中と氷の上。水中とは支配する式がまったく違うので分けてある */
  updateAirborne(m, dt, i) {
    const surf = WORLD.surfaceY;

    if (m.state === 'air') {
      m.vel.y -= GRAVITY * dt;
      m.pos.addScaledVector(m.vel, dt);
      m.heading = Math.atan2(m.vel.x, m.vel.z);
      // 姿勢は速度に沿う。跳び出しは頭が上、落ちるにつれ頭が下がる
      m.pitch = Math.atan2(m.vel.y, Math.hypot(m.vel.x, m.vel.z));
      m.bank += (0 - m.bank) * (1 - Math.exp(-5 * dt));

      // 空中では翼を後ろへ引きつけ、体をまっすぐ伸ばす。
      // 左右に広げたままだと、飛んでいるのではなく落ちている絵になる
      m.wingSweep += (1.15 - m.wingSweep) * (1 - Math.exp(-9 * dt));
      m.neck += (0 - m.neck) * (1 - Math.exp(-8 * dt));
      m.tail += (0 - m.tail) * (1 - Math.exp(-8 * dt));
      this.restLegs(m, dt, 8);

      const deck = this.iceField ? this.iceField.deck(m.pos.x, m.pos.z) : -1e4;
      // 氷の上へ着地。跳び乗った勢いで少し滑ってから立ち上がる
      if (m.plan === 'haulOut' && deck > -100 && m.pos.y <= deck + m.body && m.vel.y < 0) {
        m.pos.y = deck + m.body * 0.55;
        m.state = 'onIce';
        m.iceStage = 'land';
        m.slide = Math.hypot(m.vel.x, m.vel.z);
        // 立っていられる時間。せっかちな個体は先に腰を上げる
        m.rest = (this.kind.standTime[0]
               + Math.random() * (this.kind.standTime[1] - this.kind.standTime[0])) / m.haste;
        m.breath = this.kind.dive * (0.8 + Math.random() * 0.4);
        m.wingAmp = 0;
        return this.poseAt(m, i);
      }
      // 水へ戻る
      if (m.pos.y <= surf && m.vel.y < 0) {
        m.pos.y = surf;
        // 頭から入る入水は水を切って入るので、しぶきは小さい。
        // 腹から落ちたときだけ派手になる
        const nose = -m.pitch;   // 0.8rad ほどで頭から
        if (this.splash) {
          this.splash.burst(_v.copy(m.pos), U.uTime.value,
                            nose > 0.6 ? 0.26 : 0.5);
        }
        m.speed = Math.hypot(m.vel.x, m.vel.z) * 0.85;
        m.arcs = (m.arcs || 0) - 1;
        if (m.plan === 'porpoise' && m.arcs > 0) {
          // まだ弧を続ける。水面すれすれを走り、すぐまた跳ぶ
          m.state = 'approach';
          m.aimX = m.pos.x + Math.sin(m.heading) * 5;
          m.aimZ = m.pos.z + Math.cos(m.heading) * 5;
        } else {
          m.state = 'swim';
          m.breath = this.kind.dive * (0.8 + Math.random() * 0.4);
        }
        m.wingAmp = 1;
        m.wingSweep = 0;
      }
      return this.poseAt(m, i);
    }

    // ================= 氷の上 =================
    // 跳び乗ってから水へ戻るまでを3段に分ける。
    //   land  : 着地の勢いで腹這いのまま滑る
    //   stand : 立ち上がってあたりを見る(氷上のペンギンの本来の姿)
    //   edge  : 縁へ歩き、体を前へ折って頭から入水する
    //
    // 最初は「腹這いのまま滑って、そのまま縁から落ちる」で済ませていた。
    // 立ち姿を諦めたのは、この体が首の曲がらない紡錘形で、
    // 直立させると嘴が真上を向いてしまうからだった。
    // だが順序が逆で、曲がらないなら曲げられるようにすればいい。
    // 首を曲げられるようにした今、氷の上のペンギンは立っている。
    const deckAt = (x, z) => Math.max(this.iceField ? this.iceField.deck(x, z) : surf, surf);
    // 立ち姿の傾き・尾の曲げ・足首の角、そして体を浮かせる高さは
    // すべてモデル側で実測してある(→ penguin.js の solveStand)。
    // ここで式を書き直すと、必ずまた尾が刺さるか足が浮く
    const standPitch = STAND_PITCH;
    const FEET_DOWN = STAND_FOOT;

    if (m.iceStage === 'land') {
      m.slide *= Math.exp(-2.6 * dt);
      m.pos.x += Math.sin(m.heading) * m.slide * dt;
      m.pos.z += Math.cos(m.heading) * m.slide * dt;
      m.pos.y = deckAt(m.pos.x, m.pos.z) + m.body * 0.55;
      m.pitch += (0 - m.pitch) * (1 - Math.exp(-6 * dt));
      m.wingSweep += (0.6 - m.wingSweep) * (1 - Math.exp(-5 * dt));
      m.waddle *= Math.exp(-4 * dt);
      // 腹這いのあいだ尾はまっすぐ。曲げるのは立ち上がってから
      m.tail *= Math.exp(-4 * dt);
      this.restLegs(m, dt, 4);
      if (m.slide < 0.25) { m.iceStage = 'stand'; m.lookT = 0; m.sway = 0; }
      return this.poseAt(m, i);
    }

    if (m.iceStage === 'stand') {
      // 立ち上がる。翼は体側へ垂れ、首は前へ折れて嘴が水平に近くなる
      m.pos.y += (Math.max(this.deckUnderFeet(m), surf) + this.liftAt(m) - m.pos.y)
               * (1 - Math.exp(-4 * dt));
      m.pitch += (standPitch - m.pitch) * (1 - Math.exp(-3.2 * dt));
      // 翼は畳みきらない。ぴたりと体側へ貼りつけると、脇腹と同じ黒が
      // 重なって輪郭に溶け、翼がどこにあるのか分からなくなる。
      // 実際のペンギンも、立っているとき翼をわずかに開いて風を通す
      m.wingSweep += (1.24 - m.wingSweep) * (1 - Math.exp(-3.0 * dt));
      m.wingAmp += (0 - m.wingAmp) * (1 - Math.exp(-4 * dt));
      // 足を前へ倒して、体を支える板にする
      m.feet += (FEET_DOWN - m.feet) * (1 - Math.exp(-3.0 * dt));
      // 尾を後ろへ蹴り出す。これをやらないと尾の先が甲板に刺さり、
      // そのぶん体が持ち上がって足が宙に浮く
      m.tail += (this.standBend - m.tail) * (1 - Math.exp(-3.0 * dt));
      // 立ち止まっていても完全には止まらない。重心を左右へ送って揺れる
      m.waddle += (Math.sin(m.lookT * 1.5 + m.seed) * 0.05 - m.waddle) * (1 - Math.exp(-3 * dt));
      this.restLegs(m, dt, 3);
      // 首は立ち上がりに合わせて折る。ここを止めると嘴が空を指す。
      // 落ち着きのない個体はしきりに首を振り、向きもよく変える。
      // 同じ周期で全員が首を振っていると、群れが機械仕掛けに見える
      m.lookT += dt;
      const fg = m.fidget;
      const look = 1.16 + 0.26 * Math.sin(m.lookT * 0.9 * fg + m.seed) * fg
                        + 0.14 * Math.sin(m.lookT * 2.7 * fg + m.seed * 3);
      m.neck += (look * Math.min(m.lookT / 1.2, 1) - m.neck) * (1 - Math.exp(-4 * dt));
      // その場でゆっくり向きを変える。棒立ちのままだと置物になる
      m.heading += Math.sin(m.lookT * 0.42 * fg + m.seed * 2) * 0.5 * fg * dt;
      m.rest -= dt;
      if (m.rest <= 0) {
        m.iceStage = 'edge'; m.edgeT = 0; m.sway = 0;
        this.rally();       // 一羽が動くと、残りも腰を上げる
      }
      return this.poseAt(m, i);
    }

    // ---- 縁で前へ倒れる ----
    // 立った姿勢からいきなり弾道へ渡すと、水面を割る1フレームで
    // 体が +75度 から -30度 までねじれる(イルカのブリーチングで
    // 踏んだのとまったく同じ失敗)。縁でいったん止まり、
    // 体を前へ倒しきってから離れる。倒れる動作そのものが入水の初速になる。
    if (m.iceStage === 'tip') {
      m.tipT += dt;
      const e = Math.min(m.tipT / 0.75, 1);
      const ease = e * e * (3 - 2 * e);
      m.pitch = standPitch + (-0.75 - standPitch) * ease;
      m.neck += (0 - m.neck) * (1 - Math.exp(-5 * dt));
      // 蹴り出しながら足を畳み、尾を伸ばして体を一直線にする。
      // 曲げたまま入水すると、水中で尾が背中側へ折れたままになる
      m.feet += (0 - m.feet) * (1 - Math.exp(-4 * dt));
      m.tail += (0 - m.tail) * (1 - Math.exp(-4 * dt));
      m.waddle *= Math.exp(-6 * dt);
      this.restLegs(m, dt, 5);
      m.pos.y = (m.lastDeck || surf) + this.standDrop * m.scale * Math.cos(ease * 1.1);
      // 倒れるにつれて重心が縁の外へ出て、そのまま落ちる
      m.pos.x += Math.sin(m.heading) * 0.55 * ease * dt;
      m.pos.z += Math.cos(m.heading) * 0.55 * ease * dt;
      if (e >= 1) {
        m.state = 'air';
        m.plan = 'dive';
        m.arcs = 0;
        m.vel.set(Math.sin(m.heading) * 1.5, -0.9, Math.cos(m.heading) * 1.5);
        m.wingSweep = 1.15;
        m.wingAmp = 0.2;
      }
      return this.poseAt(m, i);
    }

    // ---- 縁まで歩く ----
    //
    // 一度目は「位置を等速で足して、体を左右に揺らす」で作った。
    // それは歩きではなく、氷の上を滑りながら体を振っているだけで、
    // 実際そう見えていた。揺れの大きさをどう直しても直らない——
    // 足が地面を掴んでいないのだから当然だった。
    //
    // 本物のペンギンの歩きは、こうなっている。
    //
    //  ・接地している足は動かない。動くのは体のほう。あたりまえに
    //    聞こえるが、これを守ると歩幅・歩調・速さが全部つながって
    //    決まってしまう。脚の長さ R と振り出しの角 θ が歩幅を決め、
    //    脚を振り子とみた固有周期が歩調を決め、その積が速さになる。
    //    速さを先に決めて足を後から付けると、どうやっても滑る
    //  ・左右の倒し込みは「揺れ」ではなく、遊脚を地面から離すための
    //    動作。脚が短く足が大きいので、支持脚の上へ体を倒さないと
    //    反対の足が上がらない。Griffin と Kram は、この倒し込みで
    //    力学的エネルギーの8割を回収していることを示した——
    //    よちよち歩きは無駄な動きではなく、歩くための仕掛けそのもの
    //  ・体をひねる。脚が正中線の近くに付いているので、片脚を前へ
    //    出すと骨盤ごと回る。この回旋がないと歩幅が取れない
    //  ・支持脚が垂直になる一歩の中間で、体がいちばん高くなる
    //    (倒立振り子)。踏み替えでいちばん低い
    //
    // だから、脚の位相を主役にして、倒し込みも、ひねりも、上下動も、
    // 前進も、全部そこから出す。
    m.edgeT += dt;
    const g = this.gait;
    const tx = m.target ? m.target.fromX : m.pos.x;
    const tz = m.target ? m.target.fromZ : m.pos.z;
    const want = Math.atan2(tx - m.pos.x, tz - m.pos.z);
    let dh = want - m.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    // 向きもその場でくるくる変えられない。歩きながら少しずつ回る
    m.heading += THREE.MathUtils.clamp(dh * 1.1, -0.75, 0.75) * dt;

    // 歩調。左右の脚は半周ずれる
    m.stride = (m.stride + dt / m.strideT * Math.PI * 2) % (Math.PI * 2);
    const u = m.stride / (Math.PI * 2);
    const legL = this.gaitLeg(u);
    const legR = this.gaitLeg((u + 0.5) % 1);
    m.hipL = legL.th;
    m.hipR = legR.th;
    // 遊脚は跗蹠を1割縮めて足を上げる。両脚が同時に遊ぶことはないので、
    // 符号でどちらの脚かを表してシェーダへ1本で渡す(正 = 右)
    m.swing = (legR.sh - legL.sh) * 0.13;

    // 荷重の乗っているほうへ倒し込む。+ が左脚(部位6)側。
    // 目分量で位相を合わせると必ずずれるので、荷重配分から直接作る
    const load = this.loadAt(u);
    // よちよちの深さも個体で違う。大きく倒して歩く個体と、
    // すり足のようにあまり倒さない個体がいる
    const wantRoll = 0.14 * m.rollAmp * (load[0] - load[1]);
    m.waddle += (wantRoll - m.waddle) * (1 - Math.exp(-25 * dt));
    // 前へ出ている脚のほうへ骨盤が回る
    m.yaw += ((m.hipR - m.hipL) * 0.09 - m.yaw) * (1 - Math.exp(-12 * dt));

    // 前進。速さは歩幅と歩調の結果であって、独立の数字ではない
    m.pos.x += Math.sin(m.heading) * m.walkSpeed * dt;
    m.pos.z += Math.cos(m.heading) * m.walkSpeed * dt;
    // 倒し込みとひねりのぶん、体を支持足の上へ送る。重心は直進せず、
    // 左右へ数センチずつジグザグに振れながら進む
    const gr = this.ground(m, load);
    const dLat = gr.sway - (m.sway || 0);
    m.sway = gr.sway;
    m.pos.x += Math.cos(m.heading) * dLat;
    m.pos.z -= Math.sin(m.heading) * dLat;
    // 足と尾はしっかり倒したまま
    m.feet += (FEET_DOWN - m.feet) * (1 - Math.exp(-4 * dt));
    m.tail += (this.standBend - m.tail) * (1 - Math.exp(-4 * dt));
    m.bank = 0;
    // 甲板の高さ場は格子の外側が大きな負の値なので、縁の1マス手前から
    // 一気に落ちる。そのまま足元の高さに使うと、飛び込む直前に体が
    // 30cm沈む。最後に踏んだ甲板の高さを覚えておいて、そこで踏み切る
    const deckHere = this.deckUnderFeet(m);
    const onDeck = deckHere > surf + 0.05;
    if (onDeck) m.lastDeck = deckHere;
    // 上下動も支持脚から出る。別に足す弾みは要らない
    m.pos.y = (m.lastDeck || surf) + gr.lift;

    // 半歩先の足元を見る。縁に着いてから倒れ始めたのでは遅く、
    // 体が宙に浮いたまま前傾することになる
    const aheadX = m.pos.x + Math.sin(m.heading) * 0.55;
    const aheadZ = m.pos.z + Math.cos(m.heading) * 0.55;
    const brink = !this.iceField || this.iceField.deck(aheadX, aheadZ) <= surf + 0.05;
    if (!onDeck || brink || m.edgeT > 16) {
      m.iceStage = 'tip';
      m.tipT = 0;
    }
    return this.poseAt(m, i);
  }

  /** 行列を1体ぶん書き込む */
  poseAt(m, i) {
    // 体の向きは進行方向そのものではない。歩いているあいだは、
    // 前へ出した脚のほうへ骨盤ごと回る。脚が体の中心線に近いので、
    // この「ひねり」なしでは一歩ぶんの歩幅がそもそも取れない
    const hd = m.heading + (m.yaw || 0);
    _fwd.set(Math.sin(hd) * Math.cos(m.pitch), Math.sin(m.pitch),
             Math.cos(hd) * Math.cos(m.pitch)).normalize();
    _up.set(0, 1, 0);
    _right.crossVectors(_up, _fwd);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    _up.crossVectors(_fwd, _right);
    _m.makeBasis(_right, _up, _fwd);
    _q.setFromAxisAngle(_fwd, m.bank);
    _m.premultiply(_qb.makeRotationFromQuaternion(_q));
    // よちよち歩きの左右の倒れ込み。体軸ではなく「進行方向の水平軸」まわりに
    // 倒す。体軸まわりに回すと、立っているときは縦軸まわりの回転になって
    // ただ体をひねるだけになる
    if (m.waddle) {
      _axis.set(Math.sin(m.heading), 0, Math.cos(m.heading));
      _q.setFromAxisAngle(_axis, m.waddle);
      _m.premultiply(_qb.makeRotationFromQuaternion(_q));
    }
    _m.setPosition(m.pos);
    const s = this.info[i * 4 + 2];
    _m.scale(_v.set(s, s, s));
    this.mesh.setMatrixAt(i, _m);
    this.info[i * 4 + 0] = m.wingPhase;
    this.info[i * 4 + 1] = m.wingAmp;
    this.pose[i * 4 + 0] = m.wingLift;
    this.pose[i * 4 + 1] = m.wingSweep;
    this.pose[i * 4 + 2] = m.neck;
    this.pose[i * 4 + 3] = m.feet;
    this.pose2[i * 4 + 0] = m.tail;
    this.pose2[i * 4 + 1] = m.hipL;
    this.pose2[i * 4 + 2] = m.hipR;
    this.pose2[i * 4 + 3] = m.swing;
  }
}
