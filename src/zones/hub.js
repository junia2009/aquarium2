import * as THREE from 'three';
import { baseUniforms, U } from '../env.js';
import { UW_FRAG_PRELUDE, UW_FRAG_OUTPUT } from '../glsl.js';
import { CollisionWorld } from '../collision.js';

// ============ ポータルエリア(海中研究施設) ============
//
// 水槽が増えるほど、下のタブは横に伸びていく。5つで既に画面から
// はみ出していた。タブは「数が増えても壊れない」形をしていない。
//
// かわりに、行き先そのものを場所にする。海中の研究施設に降り立ち、
// 壁に並んだハッチをくぐって各エリアへ行く。増えるときは
// ハッチが1つ増えるだけで、UIは何も伸びない。
//
// 見た目は『MEG ザ・モンスター』のマナ・ワンを下敷きにしている。
// あの施設が水中の建物として説得力を持っているのは、
//   ・円筒と球を組み合わせた与圧殻の形をしていること
//   ・構造リブ・手すり・注意帯といった「人が働く場所」の設えがあること
//   ・床にムーンプール(submersible の出入口)が開いていて、
//     そこだけ外の暗い海が見えていること
// の3つで、飾りではなく機能の形をしている。ここでも同じ順で作る。

const DECK_Y = 4.0;         // 甲板の高さ
const ROOM_R = 13.0;        // 与圧殻の内半径
const WALL_H = 7.0;         // 甲板から天井の付け根まで
const MOON_R = 4.2;         // ムーンプールの半径
const PORTAL_R = 1.75;      // ハッチの半径
const PORTAL_Y = DECK_Y + 2.45;

/**
 * 施設の床。カメラの接地判定に使う。
 * ムーンプールの中だけは下へ抜ける——落ちると外の海に出る、という
 * 場所であることが、当たり判定のうえでも成り立っていてほしい
 */
export function hubFloor(x, z) {
  const r = Math.hypot(x, z);
  if (r < MOON_R - 0.15) return DECK_Y - 26;
  return DECK_Y;
}

// 施設の金属。岩や生き物と同じ光で照らして、浮かないようにする
function metalMaterial(extra, vert, frag, opts = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { ...baseUniforms(), ...extra },
    side: opts.side ?? THREE.FrontSide,
    transparent: !!opts.transparent,
    depthWrite: opts.depthWrite ?? true,
    vertexShader: vert,
    fragmentShader: UW_FRAG_PRELUDE + frag,
  });
}

const LIT_VERT = /* glsl */ `
  attribute vec3 aCol;
  varying vec3 vCol;
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    vN = normalize(mat3(modelMatrix) * normal);
    vCol = aCol;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const LIT_FRAG = /* glsl */ `
  varying vec3 vCol;
  varying vec3 vN;
  varying vec3 vW;
  void main() {
    vec3 n = gl_FrontFacing ? normalize(vN) : -normalize(vN);
    vec3 viewDir = normalize(cameraPosition - vW);
    // 塗装した鋼。つや消しだが、濡れているので弱いハイライトが乗る
    vec3 col = underwaterLight(vCol, n, vW, viewDir, 22.0, 0.10);
    gl_FragColor = vec4(applyUnderwaterFog(col, vW), 1.0);
    ${UW_FRAG_OUTPUT}
  }
`;

// ---------------------------------------------------------------- 形を作る道具
class Buf {
  constructor() { this.p = []; this.c = []; this.i = []; }
  v(x, y, z, col) {
    const k = this.p.length / 3;
    this.p.push(x, y, z); this.c.push(col[0], col[1], col[2]);
    return k;
  }
  tri(a, b, c) { this.i.push(a, b, c); }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  geo() {
    const pos = new Float32Array(this.p);
    const nrm = new Float32Array(this.p.length);
    for (let f = 0; f < this.i.length; f += 3) {
      const a = this.i[f] * 3, b = this.i[f + 1] * 3, c = this.i[f + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const k of [a, b, c]) { nrm[k] += nx; nrm[k + 1] += ny; nrm[k + 2] += nz; }
    }
    for (let k = 0; k < nrm.length; k += 3) {
      const L = Math.hypot(nrm[k], nrm[k + 1], nrm[k + 2]) || 1;
      nrm[k] /= L; nrm[k + 1] /= L; nrm[k + 2] /= L;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('aCol', new THREE.BufferAttribute(new Float32Array(this.c), 3));
    g.setIndex(this.i);
    return g;
  }
}

// 塗装の色。実際の有人施設は白か明るい灰に塗る——暗い海の中で
// 何がどこにあるかを、限られた投光器で分からせないといけないから
const PAINT = [0.255, 0.268, 0.280];
const PAINT2 = [0.180, 0.190, 0.205];   // リブや影になる面
const DECK = [0.145, 0.152, 0.160];     // 甲板は滑り止めで暗い
const HAZARD = [0.290, 0.215, 0.055];   // 注意帯の黄
const RAIL = [0.215, 0.225, 0.235];
const DARK = [0.020, 0.024, 0.030];     // ムーンプールの奥

/** 施設の殻。甲板・壁・天井・ムーンプールをひとまとめに作る */
function buildShell() {
  const M = new Buf();
  const N = 64;                      // 円周の分割
  const ang = (k) => (k / N) * Math.PI * 2;

  // ---- 甲板 ----
  // ムーンプールの縁から壁まで。放射状の板で、継ぎ目に沿って色を変える
  const RINGS = 6;
  const grid = [];
  for (let i = 0; i <= RINGS; i++) {
    const r = MOON_R + (ROOM_R - MOON_R) * (i / RINGS);
    const row = [];
    for (let k = 0; k < N; k++) {
      const a = ang(k);
      // 板の継ぎ目。8枚の扇形に分かれている
      const seam = Math.abs(((a / (Math.PI * 2)) * 8) % 1 - 0.5) > 0.47;
      row.push(M.v(Math.cos(a) * r, DECK_Y, Math.sin(a) * r,
                   seam ? PAINT2 : DECK));
    }
    grid.push(row);
  }
  for (let i = 0; i < RINGS; i++) {
    for (let k = 0; k < N; k++) {
      const k2 = (k + 1) % N;
      M.quad(grid[i][k], grid[i][k2], grid[i + 1][k2], grid[i + 1][k]);
    }
  }
  // ムーンプールの注意帯。縁から内へ40cm
  const hz = [];
  for (let k = 0; k < N; k++) {
    const a = ang(k);
    // 黄と黒の縞。斜めに入る
    const stripe = ((a * 9 / Math.PI) % 1) < 0.5;
    hz.push(M.v(Math.cos(a) * (MOON_R - 0.4), DECK_Y + 0.004,
                Math.sin(a) * (MOON_R - 0.4), stripe ? HAZARD : PAINT2));
  }
  for (let k = 0; k < N; k++) {
    const k2 = (k + 1) % N;
    M.quad(hz[k], hz[k2], grid[0][k2], grid[0][k]);
  }
  // ムーンプールの井筒。下は暗い海へ抜ける
  const wellTop = [], wellBot = [];
  for (let k = 0; k < N; k++) {
    const a = ang(k);
    wellTop.push(M.v(Math.cos(a) * MOON_R, DECK_Y, Math.sin(a) * MOON_R, PAINT2));
    wellBot.push(M.v(Math.cos(a) * MOON_R, DECK_Y - 3.2, Math.sin(a) * MOON_R, DARK));
  }
  for (let k = 0; k < N; k++) {
    const k2 = (k + 1) % N;
    M.quad(wellTop[k2], wellTop[k], wellBot[k], wellBot[k2]);
  }

  // ---- 壁 ----
  // 円筒。縦のリブが等間隔に立つ。リブは飾りではなく、
  // 水圧を受ける殻の補強材で、実物にも必ずある
  const WROWS = 4;
  const wall = [];
  for (let i = 0; i <= WROWS; i++) {
    const y = DECK_Y + WALL_H * (i / WROWS);
    const row = [];
    for (let k = 0; k < N; k++) {
      const a = ang(k);
      // リブ。24本
      const rib = Math.abs(((a / (Math.PI * 2)) * 24) % 1 - 0.5) > 0.36;
      const r = ROOM_R - (rib ? 0.16 : 0);
      row.push(M.v(Math.cos(a) * r, y, Math.sin(a) * r, rib ? PAINT : PAINT2));
    }
    wall.push(row);
  }
  for (let i = 0; i < WROWS; i++) {
    for (let k = 0; k < N; k++) {
      const k2 = (k + 1) % N;
      M.quad(wall[i][k2], wall[i][k], wall[i + 1][k], wall[i + 1][k2]);
    }
  }
  // 甲板と壁のあいだの幅木
  for (let k = 0; k < N; k++) {
    const k2 = (k + 1) % N;
    M.quad(grid[RINGS][k2], grid[RINGS][k], wall[0][k], wall[0][k2]);
  }

  // ---- 天井 ----
  // 浅いドーム。放射状のリブが中心の要へ集まる
  const CROWS = 5;
  const domeH = 3.4;
  const dome = [];
  for (let i = 0; i <= CROWS; i++) {
    const t = i / CROWS;
    const r = ROOM_R * Math.cos(t * Math.PI * 0.5);
    const y = DECK_Y + WALL_H + domeH * Math.sin(t * Math.PI * 0.5);
    const row = [];
    for (let k = 0; k < N; k++) {
      const a = ang(k);
      const rib = Math.abs(((a / (Math.PI * 2)) * 16) % 1 - 0.5) > 0.38;
      row.push(M.v(Math.cos(a) * r, y - (rib ? 0.14 : 0), Math.sin(a) * r,
                   rib ? PAINT : PAINT2));
    }
    dome.push(row);
  }
  for (let i = 0; i < CROWS - 1; i++) {
    for (let k = 0; k < N; k++) {
      const k2 = (k + 1) % N;
      M.quad(dome[i][k2], dome[i][k], dome[i + 1][k], dome[i + 1][k2]);
    }
  }
  const apex = M.v(0, DECK_Y + WALL_H + domeH, 0, PAINT);
  for (let k = 0; k < N; k++) {
    M.tri(dome[CROWS - 1][(k + 1) % N], dome[CROWS - 1][k], apex);
  }
  return M.geo();
}

/**
 * 天井の投光器。
 *
 * 海中の建物は、外から光が来ない。だから照明器具そのものが
 * 「ここは人の作った場所だ」といちばん強く言う設えになる。
 * 器具の箱と、下を向いた発光面の2つで作る——発光面だけだと
 * 光が宙に浮き、箱だけだと消えた照明になる
 */
function buildLamps(root) {
  const M = new Buf();
  const glow = new Buf();
  const LAMP_Y = DECK_Y + WALL_H + 0.55;
  const LR = ROOM_R * 0.66;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    const cx = Math.cos(a) * LR, cz = Math.sin(a) * LR;
    // 器具の箱
    const w = 0.62, d = 0.30, h = 0.22;
    const c = Math.cos(a), s2 = Math.sin(a);
    const corner = (u, v, y) => M.v(cx + (-s2 * u + c * v), y, cz + (c * u + s2 * v), PAINT2);
    const top = [corner(-w, -d, LAMP_Y + h), corner(w, -d, LAMP_Y + h),
                 corner(w, d, LAMP_Y + h), corner(-w, d, LAMP_Y + h)];
    const bot = [corner(-w, -d, LAMP_Y), corner(w, -d, LAMP_Y),
                 corner(w, d, LAMP_Y), corner(-w, d, LAMP_Y)];
    for (let j = 0; j < 4; j++) {
      const j2 = (j + 1) % 4;
      M.quad(top[j], top[j2], bot[j2], bot[j]);
    }
    // 発光面。下向き
    const gc = (u, v) => glow.v(cx + (-s2 * u + c * v), LAMP_Y - 0.005,
                                cz + (c * u + s2 * v), [1, 1, 1]);
    const g0 = gc(-w * 0.82, -d * 0.7), g1 = gc(w * 0.82, -d * 0.7);
    const g2 = gc(w * 0.82, d * 0.7), g3 = gc(-w * 0.82, d * 0.7);
    glow.quad(g3, g2, g1, g0);
  }
  root.add(new THREE.Mesh(M.geo(), metalMaterial({}, LIT_VERT, LIT_FRAG)));
  root.add(new THREE.Mesh(glow.geo(), new THREE.MeshBasicMaterial({
    color: 0xdaeeff, toneMapped: false, side: THREE.DoubleSide })));
}

/** ムーンプールの手すり。人が働く場所であることを示す設え */
function buildRail() {
  const M = new Buf();
  const N = 48;
  const R = MOON_R + 0.55, H = 1.05;
  const top = [];
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    // 笠木。断面は小さな四角
    const ring = [];
    for (let j = 0; j < 4; j++) {
      const t = (j / 4) * Math.PI * 2 + Math.PI / 4;
      ring.push(M.v(c * (R + Math.cos(t) * 0.05), DECK_Y + H + Math.sin(t) * 0.05,
                    s * (R + Math.cos(t) * 0.05), RAIL));
    }
    top.push(ring);
  }
  for (let k = 0; k < N; k++) {
    const k2 = (k + 1) % N;
    for (let j = 0; j < 4; j++) {
      const j2 = (j + 1) % 4;
      M.quad(top[k][j], top[k][j2], top[k2][j2], top[k2][j]);
    }
  }
  // 支柱。12本
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const c = Math.cos(a) * R, s = Math.sin(a) * R;
    const lo = [], hi = [];
    for (let j = 0; j < 4; j++) {
      const t = (j / 4) * Math.PI * 2 + Math.PI / 4;
      const dx = Math.cos(t) * 0.045, dz = Math.sin(t) * 0.045;
      lo.push(M.v(c + dx, DECK_Y, s + dz, RAIL));
      hi.push(M.v(c + dx, DECK_Y + H, s + dz, RAIL));
    }
    for (let j = 0; j < 4; j++) {
      const j2 = (j + 1) % 4;
      M.quad(lo[j], lo[j2], hi[j2], hi[j]);
    }
  }
  return M.geo();
}

// ---------------------------------------------------------------- ポータル
//
// ハッチの中は「向こう側の水」。行き先ごとの水の色をそのまま出し、
// 波紋と集光模様を動かす。止まった絵にすると窓ではなく壁の模様になる。
const PORTAL_FRAG = /* glsl */ `
  uniform vec3 uTint;
  uniform float uGlow;
  varying vec2 vUv;
  varying vec3 vW;
  void main() {
    vec2 q = vUv * 2.0 - 1.0;
    float r = length(q);
    if (r > 1.0) discard;
    // 奥へ吸い込まれていく同心の波紋
    float rip = sin(r * 16.0 - uTime * 1.6) * 0.5 + 0.5;
    // 向こう側の水面から差す集光。ゆっくり流れる
    float ca = fbm(vec2(q.x * 2.2 + uTime * 0.09, q.y * 2.2 - uTime * 0.06));
    float core = pow(1.0 - r, 1.5);
    vec3 col = uTint * (0.35 + 1.15 * core + 0.30 * rip * (1.0 - r) + 0.55 * ca * (1.0 - r * 0.7));
    // 縁は暗く落として、奥行きのある穴に見せる
    col *= mix(0.25, 1.0, smoothstep(1.0, 0.72, r));
    gl_FragColor = vec4(col * uGlow, 1.0);
    ${UW_FRAG_OUTPUT}
  }
`;

const PORTAL_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vW;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vW = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

/** 行き先の名前を書いた銘板。文字はキャンバスから焼く */
function plaqueTexture(name, sub) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#161b20';
  g.fillRect(0, 0, 512, 128);
  g.fillStyle = '#2a323a';
  g.fillRect(0, 0, 512, 6);
  g.fillRect(0, 122, 512, 6);
  g.fillStyle = '#dfe8ef';
  g.font = 'bold 54px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText(name, 256, 62);
  g.fillStyle = '#7d97ab';
  g.font = '22px system-ui, sans-serif';
  g.letterSpacing = '6px';
  g.fillText(sub, 256, 100);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * ハッチを1枚立てる。
 * 枠(金属)・中身(向こう側の水)・銘板 の3つでできている。
 */
function buildPortal(parent, def, angle, portals) {
  const grp = new THREE.Group();
  const c = Math.cos(angle), s = Math.sin(angle);
  // 壁の内側にわずかに埋め込む
  grp.position.set(c * (ROOM_R - 0.22), PORTAL_Y, s * (ROOM_R - 0.22));
  // 部屋の中心を向かせる。+Z を向いた面を y 軸まわりに θ 回すと
  // 法線は (sinθ, 0, cosθ)。内向き (-cos a, 0, -sin a) にしたいので
  // θ = -a - π/2。ここを +π/2 にしていたら法線が外向きになり、
  // 円板も銘板も裏面カリングで消えて、枠のリングだけが残っていた
  grp.rotation.y = -angle - Math.PI * 0.5;
  parent.add(grp);

  // 中身。行き先の水の色で光る円板。
  //
  // 霧の色をそのまま使ってはいけない。5つの霧はどれも青系で、
  // 明るさを揃えた時点で見分けがつかなくなる(とくに深海は
  // #01070d で、正規化すると232倍しないと光らない)。
  // 行き先ごとに「その水を思い出せる色」を明示してもらう
  const tint = (def.env.portalTint || def.env.fogColor).clone();
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...baseUniforms(), uTint: { value: tint }, uGlow: { value: 1.0 } },
    vertexShader: PORTAL_VERT,
    fragmentShader: UW_FRAG_PRELUDE + PORTAL_FRAG,
  });
  const disc = new THREE.Mesh(new THREE.PlaneGeometry(PORTAL_R * 2, PORTAL_R * 2), mat);
  disc.position.z = 0.02;
  grp.add(disc);
  // 当たり判定はこの円板で取る。見えているものを押させる
  disc.userData.zone = def.key;
  portals.push({ mesh: disc, mat, key: def.key, def,
                 world: new THREE.Vector3(c * (ROOM_R - 0.6), PORTAL_Y, s * (ROOM_R - 0.6)) });

  // 枠。厚みのあるリング
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(PORTAL_R + 0.14, 0.17, 8, 40),
    metalMaterial({}, LIT_VERT, LIT_FRAG));
  // TorusGeometry は頂点色を持たないので、色を1本ぶん足す
  const cnt = ring.geometry.attributes.position.count;
  const cols = new Float32Array(cnt * 3);
  for (let i = 0; i < cnt; i++) { cols[i * 3] = PAINT[0]; cols[i * 3 + 1] = PAINT[1]; cols[i * 3 + 2] = PAINT[2]; }
  ring.geometry.setAttribute('aCol', new THREE.BufferAttribute(cols, 3));
  grp.add(ring);

  // 銘板
  const pl = new THREE.Mesh(
    new THREE.PlaneGeometry(2.6, 0.65),
    new THREE.MeshBasicMaterial({ map: plaqueTexture(def.name, def.sub), toneMapped: false }));
  pl.position.set(0, PORTAL_R + 0.85, 0.06);
  grp.add(pl);
  return grp;
}

// タップ判定用。毎回作ると GC が走る
const _ray = new THREE.Raycaster();

// ================================================================ ゾーン定義
export const HUB = {
  key: 'hub',
  name: 'マナ・ワン',
  sub: 'MANA ONE STATION',
  icon: '🛰',
  terrain: hubFloor,
  env: {
    // 与圧殻の中。濁りはほとんどないが、水は水なので light は水中の式のまま
    fogColor: new THREE.Color('#0e1a24'),
    fogDensity: 0.016,
    ambTop: new THREE.Color('#43596b'),
    ambBottom: new THREE.Color('#131c24'),
    // 天井の投光器を「上からの光」として使う。太陽ではない
    sunColor: new THREE.Color('#cfe2f2'),
    sunDir: new THREE.Vector3(0.12, 0.97, 0.20).normalize(),
    exposure: 1.05,
    swell: 0.0,
  },
  // 甲板の上に立つ。ムーンプールを正面に見て、ハッチが視界に入る位置
  // ハッチの並びを正面に見る位置。5枚が同時に視野へ入る高さまで下がる
  camera: {
    pos: new THREE.Vector3(0, DECK_Y + 4.0, 10.2),
    look: new THREE.Vector3(0, PORTAL_Y - 0.2, -12.0),
  },
  clearance: 1.5,
  // ここに生き物はいないので、餌やりのボタンは出さない。
  // 押せるのに何も起きないボタンは、壊れているのと区別がつかない
  feed: false,
  tap: 'ハッチをタップすると、その水槽へ行けます',
  species: [],

  build(root) {
    const shell = new THREE.Mesh(buildShell(), metalMaterial({}, LIT_VERT, LIT_FRAG,
      { side: THREE.DoubleSide }));
    root.add(shell);
    root.add(new THREE.Mesh(buildRail(), metalMaterial({}, LIT_VERT, LIT_FRAG)));
    buildLamps(root);

    const portals = [];
    const world = new CollisionWorld();
    // 壁。押し出し用の当たり判定を殻の外側に並べる。
    // 床のクランプだけで囲うと、壁に近づいたカメラが持ち上げられて
    // 殻を乗り越えてしまう
    const _b = new THREE.Vector3();
    for (let k = 0; k < 20; k++) {
      const a = (k / 20) * Math.PI * 2;
      world.addStatic(_b.set(Math.cos(a) * (ROOM_R + 2.2), DECK_Y + WALL_H * 0.5,
                             Math.sin(a) * (ROOM_R + 2.2)), 2.6, WALL_H, 2.6);
    }

    return {
      world,
      portals,
      // 行き先をあとから差してもらう。zones の一覧は main が持っている
      setDestinations(defs) {
        for (const g of [...root.children]) if (g.userData.portal) root.remove(g);
        portals.length = 0;
        defs.forEach((def, i) => {
          // 正面(-Z)から時計回りに等間隔。手前側は空けて、
          // 入ってきた向きにハッチが並んで見えるようにする
          // 30度おき。5枚で120度に収まる。
          // 51度おきだと3枚しか見えず、「選ぶ場所」なのに選択肢が
          // 画面の外にあった。36度おきでも、端の2枚は中心から41度で
          // 視野の端(43.6度)に掛かり、ハッチの縁が切れていた。
          // 選択肢は全部、切れずに見えていること
          const a = -Math.PI * 0.5 + (i - (defs.length - 1) / 2) * (Math.PI * 2 / 12);
          const g = buildPortal(root, def, a, portals);
          g.userData.portal = true;
        });
      },
      followTargets: {},
      species: [],
      onTap(ray) {
        // 見えている円板をそのまま撃つ。当たったらその行き先を返す——
        // main 側がゾーン切替として解釈する。
        // 「押せるもの」と「見えているもの」を別々に持たないこと
        _ray.ray.copy(ray);
        let best = null, bd = Infinity;
        for (const p of portals) {
          const r = _ray.intersectObject(p.mesh, false);
          if (r.length && r[0].distance < bd) { bd = r[0].distance; best = p.key; }
        }
        return best;
      },
      update(dt, camera) {
        // 近づいたハッチが明るくなる。どれが「いま入れるもの」かを
        // 光の強さで示す。文字より先に光のほうが目に入る
        for (const p of portals) {
          const d = camera.position.distanceTo(p.world);
          const want = 1.0 + 0.85 * Math.max(0, 1 - d / 7.5);
          p.mat.uniforms.uGlow.value += (want - p.mat.uniforms.uGlow.value)
            * Math.min(dt * 3.0, 1);
        }
      },
    };
  },
};
