// ============ 水中環境音(WebAudioで手続き生成) ============
// ブラウンノイズをローパスに通した水中の「こもったざわめき」+
// ゆらぎ + 時折の泡音。外部音源ファイル不要。

export class UnderwaterAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = false;
    this.bubbleTimer = null;
  }

  start() {
    if (!this.ctx) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.ctx = ctx;

      // --- ブラウンノイズ(深いゴーッという水中音) ---
      const len = ctx.sampleRate * 4;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.5;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 240;
      lp.Q.value = 0.6;
      this.waterLP = lp;

      // 水のうねりに合わせたゆらぎ
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.11;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 90;
      this.waterLFO = lfoGain;
      lfo.connect(lfoGain).connect(lp.frequency);
      lfo.start();

      this.master = ctx.createGain();
      this.master.gain.value = 0;
      this.master.connect(ctx.destination);

      // 水中の層
      this.waterGain = ctx.createGain();
      this.waterGain.gain.value = 1;
      src.connect(lp).connect(this.waterGain).connect(this.master);
      src.start();

      // --- 水上の層(水面のさざめきと風) ---
      // 水中のこもったゴーッとは正反対に、高域まで抜ける明るいノイズ。
      // 頭が水面から出た瞬間にこちらへ入れ替える。
      const abuf = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
      const ad = abuf.getChannelData(0);
      let pink = 0;
      for (let i = 0; i < ad.length; i++) {
        const w = Math.random() * 2 - 1;
        pink = pink * 0.72 + w * 0.28;       // ピンクノイズ寄り
        ad[i] = (pink * 1.6 + w * 0.35) * 0.9;
      }
      const asrc = ctx.createBufferSource();
      asrc.buffer = abuf;
      asrc.loop = true;

      const abp = ctx.createBiquadFilter();
      abp.type = 'bandpass';
      abp.frequency.value = 900;
      abp.Q.value = 0.5;

      // 波が寄せては返す、ゆっくりした音量の呼吸
      const swellNode = ctx.createGain();
      swellNode.gain.value = 0.7;
      const swell = ctx.createOscillator();
      swell.frequency.value = 0.13;
      const swellDepth = ctx.createGain();
      swellDepth.gain.value = 0.25;
      swell.connect(swellDepth).connect(swellNode.gain);

      this.airGain = ctx.createGain();
      this.airGain.gain.value = 0;
      asrc.connect(abp).connect(swellNode).connect(this.airGain).connect(this.master);
      asrc.start();
      swell.start();

      this.above = 0;
    }
    this.ctx.resume();
    this.master.gain.setTargetAtTime(0.16, this.ctx.currentTime, 1.2);
    this.enabled = true;

    // --- 時折の泡音(短いバンドパスノイズ) ---
    const scheduleBubble = () => {
      // 深海に切り替わったら止まる(1000mでは気泡が水圧で潰れる)
      if (!this.enabled || this.zone === 'abyss') { this.bubbleTimer = null; return; }
      const ctx = this.ctx;
      const dur = 0.08 + Math.random() * 0.12;
      const n = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
      const d = n.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      const s = ctx.createBufferSource();
      s.buffer = n;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 600 + Math.random() * 1400;
      bp.Q.value = 8;
      const g = ctx.createGain();
      g.gain.value = 0.02 + Math.random() * 0.03;
      s.connect(bp).connect(g).connect(ctx.destination);
      s.start();
      this.bubbleTimer = setTimeout(scheduleBubble, 400 + Math.random() * 2500);
    };
    this._scheduleBubble = scheduleBubble;

    // --- 深海の低いうなり ---
    // 熱水噴出孔と、遠くの地殻がきしむ音。泡は出ない
    // (水深1000mでは気泡が水圧に押し潰されてしまう)
    const scheduleRumble = () => {
      if (!this.enabled || this.zone !== 'abyss') { this.rumbleTimer = null; return; }
      const ctx = this.ctx;
      const dur = 2.5 + Math.random() * 4.0;
      const n = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
      const d = n.getChannelData(0);
      let brown = 0;
      for (let i = 0; i < d.length; i++) {
        brown = (brown + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        // ゆっくり立ち上がってゆっくり消える
        const t = i / d.length;
        d[i] = brown * 3.5 * Math.sin(Math.PI * t);
      }
      const s2 = ctx.createBufferSource();
      s2.buffer = n;
      const lp2 = ctx.createBiquadFilter();
      lp2.type = 'lowpass';
      lp2.frequency.value = 55 + Math.random() * 60;
      lp2.Q.value = 2.5;
      const g = ctx.createGain();
      g.gain.value = 0.09 + Math.random() * 0.10;
      s2.connect(lp2).connect(g).connect(this.master);
      s2.start();
      this.rumbleTimer = setTimeout(scheduleRumble, 4000 + Math.random() * 11000);
    };
    this._scheduleRumble = scheduleRumble;

    this.zone = this.zone || 'sea';
    this._applyZone();
  }

  /**
   * ゾーンごとの環境音。深海は「泡がなく、高域もない」のが特徴。
   * 音のほうが先に深海だと分かる、くらいでちょうどいい。
   */
  setZone(key) {
    this.zone = key;
    if (this.ctx && this.enabled) this._applyZone();
  }

  _applyZone() {
    const abyss = this.zone === 'abyss';
    const now = this.ctx.currentTime;
    // 深海のざわめきは、浅い海よりさらに低くこもる
    this.waterLP.frequency.setTargetAtTime(abyss ? 85 : 240, now, 1.5);
    this.waterLFO.gain.setTargetAtTime(abyss ? 22 : 90, now, 1.5);
    this.master.gain.setTargetAtTime(abyss ? 0.13 : 0.16, now, 1.5);
    clearTimeout(this.bubbleTimer); this.bubbleTimer = null;
    clearTimeout(this.rumbleTimer); this.rumbleTimer = null;
    if (abyss) this._scheduleRumble();
    else this._scheduleBubble();
  }

  // 海の残響。水中は高域が早く減衰するので、暗く長い尾を引く
  _reverb() {
    if (this.conv) return this.conv;
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * 3.4);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        lp += ((Math.random() * 2 - 1) - lp) * 0.11;   // 低域寄りのノイズ
        const t = i / len;
        d[i] = lp * Math.pow(1 - t, 2.4) * (1 - Math.exp(-i / 500));
      }
    }
    const conv = ctx.createConvolver();
    conv.buffer = buf;
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    conv.connect(wet).connect(ctx.destination);
    this.conv = conv;
    return conv;
  }

  // ============ ザトウクジラの鳴き声(モーン) ============
  // 純粋な正弦波 + 一定周期のビブラートはテルミン(お化けの効果音)になる。
  // 実物は倍音の豊かなうなりで、規則的な震えはなく、わずかに不安定に揺れる。
  //   ・のこぎり波を二枚重ねて声帯の厚みを出す
  //   ・共鳴フィルタを音程に追従させて「声」らしさを与える
  //   ・息のざらつきを混ぜる
  //   ・海の残響で広い空間に響かせる
  whaleCall() {
    if (!this.enabled || !this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.05;
    const dur = 3.4 + Math.random() * 2.0;
    const N = 128;

    // --- 音程の輪郭: 低く始まり持ち上がって、長く尾を引いて下降する ---
    const f0 = 82 + Math.random() * 46;
    const peak = f0 * (1.7 + Math.random() * 0.5);
    const rise = 0.30 + Math.random() * 0.12;
    const curve = new Float32Array(N);
    let drift = 0, dv = 0;
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      const shape = t < rise
        ? Math.pow(t / rise, 0.7)
        : 1 - 0.72 * Math.pow((t - rise) / (1 - rise), 1.4);
      // 機械的なビブラートではなく、ゆっくりした不規則なゆらぎ
      dv = dv * 0.80 + (Math.random() - 0.5) * 0.9;
      drift = drift * 0.90 + dv;
      curve[i] = (f0 + (peak - f0) * shape) * (1 + drift * 0.004);
    }

    // --- 声帯: のこぎり波を少しデチューンして二枚重ね + 芯になる低い正弦 ---
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueCurveAtTime(curve, t0, dur);
    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.detune.value = -16 + Math.random() * 9;
    osc2.frequency.setValueCurveAtTime(curve, t0, dur);
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    const subCurve = new Float32Array(N);
    for (let i = 0; i < N; i++) subCurve[i] = curve[i] * 0.5;
    sub.frequency.setValueCurveAtTime(subCurve, t0, dur);

    // --- 共鳴(声の通り道)。音程に追従させると母音のように聞こえる ---
    const form = ctx.createBiquadFilter();
    form.type = 'lowpass';
    form.Q.value = 5.0;
    const fc = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      fc[i] = Math.min(curve[i] * (2.3 + 1.7 * Math.sin((i / N) * Math.PI)), 5000);
    }
    form.frequency.setValueCurveAtTime(fc, t0, dur);

    // 水中は高域が通らない
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1200;

    // --- 息のざらつき ---
    const nb = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = nb;
    const nbp = ctx.createBiquadFilter();
    nbp.type = 'bandpass';
    nbp.frequency.value = 260 + Math.random() * 160;
    nbp.Q.value = 1.1;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t0);
    ng.gain.exponentialRampToValueAtTime(0.20, t0 + dur * 0.32);
    ng.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    // --- ゆっくり膨らんで、ゆっくり消える ---
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.08, t0 + dur * 0.30);
    g.gain.setValueAtTime(0.08, t0 + dur * 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(form);
    osc2.connect(form);
    form.connect(lp);
    sub.connect(lp);
    noise.connect(nbp).connect(ng).connect(lp);
    lp.connect(g);
    g.connect(ctx.destination);
    g.connect(this._reverb());

    const stopAt = t0 + dur + 0.1;
    osc.start(t0); osc2.start(t0); sub.start(t0); noise.start(t0);
    osc.stop(stopAt); osc2.stop(stopAt); sub.stop(stopAt); noise.stop(stopAt);
    osc.onended = () => { try { g.disconnect(); lp.disconnect(); } catch (e) { /* 既に切断済み */ } };
  }

  // ============ イルカの鳴き声 ============
  // 個体識別に使う「シグネチャーホイッスル」= 素早く上下する口笛のような音と、
  // エコーロケーションのクリック列を組み合わせる。
  // 種によって声の高さ・長さ・うねり方が違う。
  dolphinCall(kind = 'bottlenose') {
    if (!this.enabled || !this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.02;
    const reverb = this._reverb();

    // シロイルカは「海のカナリア」と呼ばれるほど声色が豊かで、低めによく響く。
    // カマイルカは小柄なぶん高く短い。
    const V = {
      bottlenose: { base: 2200, span: 1600, dur: [0.5, 0.5], wob: [1.5, 2.0], climb: [0.35, 0.7] },
      beluga: { base: 900, span: 900, dur: [1.1, 1.0], wob: [3.0, 4.0], climb: [-0.3, 1.1] },
      whiteSided: { base: 3400, span: 2200, dur: [0.28, 0.3], wob: [2.0, 2.5], climb: [0.5, 0.9] },
    }[kind] || { base: 2200, span: 1600, dur: [0.5, 0.5], wob: [1.5, 2.0], climb: [0.35, 0.7] };

    // --- ホイッスル: 音程がうねりながら駆け上がる ---
    const dur = V.dur[0] + Math.random() * V.dur[1];
    const N = 64;
    const f0 = V.base + Math.random() * V.span;
    const curve = new Float32Array(N);
    const wob = V.wob[0] + Math.random() * V.wob[1];   // うねりの回数
    const climb = V.climb[0] + Math.random() * V.climb[1];
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      curve[i] = Math.max(f0 * (1 + climb * t) * (1 + 0.18 * Math.sin(t * Math.PI * 2 * wob)), 60);
    }
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueCurveAtTime(curve, t0, dur);
    // 倍音を少し足すと「口笛」らしくなる
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    const c2 = new Float32Array(N);
    for (let i = 0; i < N; i++) c2[i] = Math.min(curve[i] * 2, 18000);
    osc2.frequency.setValueCurveAtTime(c2, t0, dur);
    const g2 = ctx.createGain();
    g2.gain.value = 0.22;

    const wg = ctx.createGain();
    wg.gain.setValueAtTime(0.0001, t0);
    wg.gain.exponentialRampToValueAtTime(0.05, t0 + 0.06);
    wg.gain.setValueAtTime(0.05, t0 + dur * 0.7);
    wg.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(wg);
    osc2.connect(g2).connect(wg);
    wg.connect(ctx.destination);
    wg.connect(reverb);
    osc.start(t0); osc2.start(t0);
    osc.stop(t0 + dur + 0.05); osc2.stop(t0 + dur + 0.05);

    // --- クリック列: 短いパルスが加速しながら並ぶ ---
    const clicks = 12 + Math.floor(Math.random() * 10);
    let ct = t0 + dur * 0.35;
    let gap = 0.045;
    for (let i = 0; i < clicks; i++) {
      const n = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.006), ctx.sampleRate);
      const d = n.getChannelData(0);
      for (let k = 0; k < d.length; k++) d[k] = (Math.random() * 2 - 1) * (1 - k / d.length);
      const s = ctx.createBufferSource();
      s.buffer = n;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 5000 + Math.random() * 3000;
      bp.Q.value = 3;
      const cg = ctx.createGain();
      cg.gain.value = 0.020;
      s.connect(bp).connect(cg).connect(ctx.destination);
      cg.connect(reverb);
      s.start(ct);
      ct += gap;
      gap *= 0.93;   // だんだん詰まっていく
    }
  }

  /**
   * 水上と水中で環境音を入れ替える。
   * t=0 で水中のこもった低音、t=1 で水面のさざめきと風。
   */
  setAbove(t) {
    if (!this.ctx || !this.waterGain) return;
    t = Math.max(0, Math.min(1, t));
    if (Math.abs(t - this.above) < 0.01) return;
    this.above = t;
    const now = this.ctx.currentTime;
    // 頭が出入りする一瞬で切り替わるので、時定数は短く
    this.waterGain.gain.setTargetAtTime(1 - t * 0.92, now, 0.12);
    this.airGain.gain.setTargetAtTime(t * 0.55, now, 0.12);
  }

  stop() {
    this.enabled = false;
    if (this.bubbleTimer) { clearTimeout(this.bubbleTimer); this.bubbleTimer = null; }
    if (this.rumbleTimer) { clearTimeout(this.rumbleTimer); this.rumbleTimer = null; }
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4);
    }
  }

  toggle() {
    if (this.enabled) this.stop();
    else this.start();
    return this.enabled;
  }
}
