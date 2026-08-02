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

      // 水のうねりに合わせたゆらぎ
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.11;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 90;
      lfo.connect(lfoGain).connect(lp.frequency);
      lfo.start();

      this.master = ctx.createGain();
      this.master.gain.value = 0;
      src.connect(lp).connect(this.master).connect(ctx.destination);
      src.start();
    }
    this.ctx.resume();
    this.master.gain.setTargetAtTime(0.16, this.ctx.currentTime, 1.2);
    this.enabled = true;

    // --- 時折の泡音(短いバンドパスノイズ) ---
    const scheduleBubble = () => {
      if (!this.enabled) return;
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
    scheduleBubble();
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

  stop() {
    this.enabled = false;
    if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
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
