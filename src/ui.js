import { SPECIES } from './species.js';
import { U } from './env.js';

// ============ UI(図鑑パネル・コントロール) ============
export function setupUI({ onFollow, onFree, audio }) {
  const panel = document.getElementById('panel');
  const toggle = document.getElementById('panelToggle');
  const cards = document.getElementById('cards');
  const infoPop = document.getElementById('infoPop');
  const freeBtn = document.getElementById('freeBtn');
  const soundBtn = document.getElementById('soundBtn');
  const sunSlider = document.getElementById('sunSlider');
  const fpsEl = document.getElementById('fps');

  let activeCard = null;

  toggle.addEventListener('click', () => panel.classList.toggle('open'));

  for (const sp of SPECIES) {
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

  function clearActive() {
    if (activeCard) activeCard.classList.remove('active');
    activeCard = null;
    freeBtn.classList.add('hidden');
    infoPop.classList.add('hidden');
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

  return { tickFPS, clearActive };
}
