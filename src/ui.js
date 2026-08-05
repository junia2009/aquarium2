import { U } from './env.js';

// ============ UI(ゾーン切替・図鑑パネル・コントロール) ============
export function setupUI({ zones, onFollow, onFree, onZone, audio }) {
  const panel = document.getElementById('panel');
  const toggle = document.getElementById('panelToggle');
  const cards = document.getElementById('cards');
  const infoPop = document.getElementById('infoPop');
  const freeBtn = document.getElementById('freeBtn');
  const soundBtn = document.getElementById('soundBtn');
  const sunSlider = document.getElementById('sunSlider');
  const fpsEl = document.getElementById('fps');
  const zoneBar = document.getElementById('zoneBar');
  const titleEl = document.querySelector('#hud-title h1');
  const subEl = document.querySelector('#hud-title h1 span');

  let activeCard = null;

  toggle.addEventListener('click', () => panel.classList.toggle('open'));

  // ---- ゾーン切替タブ ----
  const zoneBtns = new Map();
  for (const z of zones) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'zone';
    b.innerHTML = `<span class="zi">${z.icon}</span>${z.name}`;
    b.addEventListener('click', () => onZone(z.key));
    zoneBar.appendChild(b);
    zoneBtns.set(z.key, b);
  }

  function clearActive() {
    if (activeCard) activeCard.classList.remove('active');
    activeCard = null;
    freeBtn.classList.add('hidden');
    infoPop.classList.add('hidden');
  }

  // ---- ゾーンに合わせて図鑑を差し替える ----
  function setZone(def) {
    for (const [k, b] of zoneBtns) b.classList.toggle('on', k === def.key);
    titleEl.childNodes[0].nodeValue = def.name + ' ';
    subEl.textContent = def.sub;
    clearActive();
    cards.replaceChildren();
    for (const sp of def.species) {
      const el = document.createElement('div');
      el.className = 'card';
      el.innerHTML = `
        <div class="row"><span class="icon">${sp.icon}</span>
          <span class="name">${sp.name}</span></div>
        <div class="sci">${sp.sci}</div>
        <div class="desc">${sp.desc}</div>
        <div class="eco">${sp.eco}</div>
      `;
      el.addEventListener('click', () => {
        if (activeCard === el) {
          clearActive();
          onFree();
          return;
        }
        if (activeCard) activeCard.classList.remove('active');
        activeCard = el;
        el.classList.add('active');
        freeBtn.classList.remove('hidden');
        infoPop.innerHTML = `<b>${sp.icon} ${sp.name}</b><br>${sp.desc}`;
        infoPop.classList.remove('hidden');
        onFollow(sp.key);
        // モバイルではパネルを閉じて観察しやすく
        if (window.innerWidth < 720) panel.classList.remove('open');
      });
      cards.appendChild(el);
    }
  }

  freeBtn.addEventListener('click', () => {
    clearActive();
    onFree();
  });

  soundBtn.addEventListener('click', () => {
    const on = audio.toggle();
    soundBtn.textContent = on ? '🔊 環境音' : '🔇 環境音';
    soundBtn.classList.toggle('on', on);
  });

  sunSlider.addEventListener('input', () => {
    U.uSunI.value = sunSlider.value / 100;
  });

  // ---- 遊び方の動画 ----
  // 開いている間だけ再生する。閉じたら必ず止めて頭出しに戻す
  // (裏で鳴り続けたり、次に開いたとき途中から始まったりしないように)。
  const guide = document.getElementById('guide');
  const guideVideo = document.getElementById('guideVideo');
  // 開いている間に押されていたキーが残ると、閉じた瞬間に泳ぎ出してしまう
  const diveKeysReset = () => window.dispatchEvent(new Event('blur'));
  // 上から順に、再生できる最初の形式が選ばれる
  const GUIDE_SRC = [
    ['./media/aquarium-guide.mp4', 'video/mp4'],
    ['./media/aquarium-guide.webm', 'video/webm'],
  ];
  function openGuide() {
    guide.classList.remove('hidden');
    document.body.classList.add('modal-open');   // 開いている間はカメラを動かさない
    if (!guideVideo.firstChild) {
      for (const [src, type] of GUIDE_SRC) {
        const s = document.createElement('source');
        s.src = src; s.type = type;
        guideVideo.appendChild(s);
      }
      guideVideo.load();
    }
    guideVideo.currentTime = 0;
    guideVideo.play().catch(() => {});   // 自動再生が拒否されても操作で再生できる
  }
  function closeGuide() {
    guide.classList.add('hidden');
    document.body.classList.remove('modal-open');
    diveKeysReset();
    guideVideo.pause();
    guideVideo.currentTime = 0;
  }
  document.getElementById('guideBtn').addEventListener('click', openGuide);
  document.getElementById('guideClose').addEventListener('click', closeGuide);
  // 背景を押しても閉じる(動画本体を押したときは閉じない)
  guide.addEventListener('click', (e) => { if (e.target === guide) closeGuide(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !guide.classList.contains('hidden')) closeGuide();
  });

  // FPS表示(0.5秒ごと)
  let frames = 0;
  let acc = 0;
  function tickFPS(dt) {
    frames++;
    acc += dt;
    if (acc >= 0.5) {
      fpsEl.textContent = `${Math.round(frames / acc)} fps`;
      frames = 0;
      acc = 0;
    }
  }

  return { tickFPS, clearActive, setZone };
}
