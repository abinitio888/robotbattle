// Ljudeffekter, skapade direkt med Web Audio (inga ljudfiler). Allt är korta syntljud: brus
// för smällar, svepande toner för specialer och små melodier för vinst, lådor och uppdrag.
// Webbläsare startar inget ljud förrän man tryckt på något, så ljudet vaknar vid första
// knapptryckningen. M stänger av/sätter på (sparas i webbläsaren).
const Sound = (function () {
  'use strict';
  let ctx = null;
  let master = null;
  let noiseBuf = null;
  let muted = false;
  try { muted = localStorage.getItem('robotbattle-muted') === '1'; } catch (e) { /* ingen lagring */ }

  function wake() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  window.addEventListener('keydown', wake);
  window.addEventListener('pointerdown', wake);

  const ready = () => ctx && ctx.state === 'running' && !muted;

  // En ton som glider från f0 till f1 under dur sekunder.
  function tone(f0, f1, dur, { type = 'square', vol = 0.3, at = 0 } = {}) {
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  // Brus genom ett filter: smällar, sus och explosioner.
  function noise(dur, { freq = 1200, q = 1, vol = 0.4, at = 0, type = 'bandpass' } = {}) {
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  const notes = (list, step, opts) => list.forEach((f, i) => tone(f, f, step * 1.6, { ...opts, at: i * step }));

  // Många träffar på en gång (t.ex. flerträffsspecialer) blir annars ett enda brus.
  let lastHit = 0;

  const fx = {
    // Ett slag som träffar; tunga träffar dånar mer.
    hit(dmg) {
      const now = performance.now();
      if (now - lastHit < 45) return;
      lastHit = now;
      const heavy = dmg >= 15;
      noise(heavy ? 0.18 : 0.08, { freq: heavy ? 500 : 1400, q: 0.8, vol: heavy ? 0.6 : 0.35 });
      tone(heavy ? 160 : 260, heavy ? 50 : 120, heavy ? 0.2 : 0.09, { type: 'triangle', vol: heavy ? 0.5 : 0.3 });
    },
    swing() { noise(0.07, { freq: 2500, q: 2, vol: 0.12, type: 'highpass' }); },
    jump() { tone(220, 520, 0.12, { type: 'square', vol: 0.08 }); },
    special() {
      tone(180, 900, 0.35, { type: 'sawtooth', vol: 0.12 });
      tone(270, 1350, 0.35, { type: 'square', vol: 0.06, at: 0.03 });
    },
    superPower() {
      tone(90, 700, 0.6, { type: 'sawtooth', vol: 0.18 });
      noise(0.6, { freq: 300, q: 0.5, vol: 0.3, type: 'lowpass' });
    },
    ko() {
      noise(0.7, { freq: 220, q: 0.4, vol: 0.7, type: 'lowpass' });
      tone(200, 30, 0.8, { type: 'sawtooth', vol: 0.3 });
    },
    win() { notes([523, 659, 784, 1047, 784, 1047], 0.11, { type: 'square', vol: 0.12 }); },
    lose() { notes([392, 330, 262, 196], 0.18, { type: 'triangle', vol: 0.2 }); },
    // rank: 0 vanlig ... 4 gudomlig — sällsyntare lådor får en längre, ljusare melodi.
    box(rank) {
      noise(0.25, { freq: 800, q: 0.6, vol: 0.3 });
      const scale = [523, 659, 784, 988, 1175, 1319, 1568];
      notes(scale.slice(0, 2 + Math.min(5, rank + 1)), 0.08, { type: 'triangle', vol: 0.18, at: 0.15 });
      if (rank >= 3) notes([1568, 2093, 1568, 2093], 0.06, { type: 'square', vol: 0.06 });
    },
    quest() { notes([784, 988, 1319], 0.07, { type: 'square', vol: 0.1 }); },
    challenge() {
      tone(110, 220, 0.25, { type: 'sawtooth', vol: 0.2 });
      tone(165, 330, 0.25, { type: 'sawtooth', vol: 0.12, at: 0.12 });
    },
  };

  const api = { get muted() { return muted; } };
  for (const [name, fn] of Object.entries(fx)) api[name] = (...args) => { if (ready()) fn(...args); };
  api.toggle = () => {
    muted = !muted;
    try { localStorage.setItem('robotbattle-muted', muted ? '1' : '0'); } catch (e) { /* ingen lagring */ }
    wake();
    if (master) master.gain.value = muted ? 0 : 0.5;
    return muted;
  };
  return api;
}());
