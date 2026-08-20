/* ==========================================================================
   diskevich — main.js

   Phase 0: skeleton wiring (tap-to-enter -> awake state).
   Phase 1: audio engine — AudioContext, AnalyserNode, bass/mid/high bands,
            mute, suspended-state handling, synthetic placeholder track.
   ========================================================================== */

/* --------------------------------------------------------------------------
   Synthetic placeholder loop
   -----------------------------------------------------------------------
   TODO: replace with a real track.mp3 in the project root. Until then this
   procedurally renders a ~30s obscure/hypnotic loop (four-on-the-floor kick
   = bass, sparse minor-interval arpeggio = mid, filtered noise hats = high)
   so the analyser always has real bass/mid/high content to react to.
   -------------------------------------------------------------------------- */
async function generateSyntheticLoop(sampleRate) {
  const duration = 30;
  const bpm = 122;
  const beatDur = 60 / bpm;
  const offlineCtx = new OfflineAudioContext(2, Math.ceil(sampleRate * duration), sampleRate);

  const master = offlineCtx.createGain();
  master.gain.value = 0.6;
  master.connect(offlineCtx.destination);

  // Bass: four-on-the-floor kick, pitch-enveloped sine.
  const totalBeats = Math.floor(duration / beatDur);
  for (let i = 0; i < totalBeats; i++) {
    const t = i * beatDur;
    const osc = offlineCtx.createOscillator();
    const gain = offlineCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.9, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    osc.connect(gain).connect(master);
    osc.start(t);
    osc.stop(t + 0.3);
  }

  // High: filtered noise hats on the offbeat.
  const hatLen = Math.ceil(sampleRate * 0.05);
  for (let i = 0; i < totalBeats * 2; i++) {
    const t = i * (beatDur / 2) + beatDur / 4;
    const noiseBuf = offlineCtx.createBuffer(1, hatLen, sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let j = 0; j < hatLen; j++) data[j] = Math.random() * 2 - 1;
    const src = offlineCtx.createBufferSource();
    src.buffer = noiseBuf;
    const hp = offlineCtx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const gain = offlineCtx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(hp).connect(gain).connect(master);
    src.start(t);
  }

  // Mid: sparse, hypnotic minor-interval arpeggio (obscure, not on every step).
  const scaleHz = [220, 261.63, 277.18, 329.63, 349.23];
  const stepDur = beatDur / 4;
  const totalSteps = Math.floor(duration / stepDur);
  for (let i = 0; i < totalSteps; i++) {
    if (Math.random() < 0.35) continue;
    const t = i * stepDur;
    const freq = scaleHz[i % scaleHz.length];
    const osc = offlineCtx.createOscillator();
    const bp = offlineCtx.createBiquadFilter();
    const gain = offlineCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    bp.type = 'bandpass';
    bp.frequency.value = freq * 2;
    bp.Q.value = 4;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + stepDur * 0.9);
    osc.connect(bp).connect(gain).connect(master);
    osc.start(t);
    osc.stop(t + stepDur);
  }

  return offlineCtx.startRendering();
}

/* --------------------------------------------------------------------------
   AudioEngine
   -----------------------------------------------------------------------
   - preload(): creates the AudioContext (starts 'suspended' per browser
     autoplay policy) and loads/generates the buffer, ahead of any user
     gesture, so the wake moment has zero decode lag.
   - start(): must be called from within a user-gesture handler. Resumes
     the suspended context, then starts playback.
   - update(): call once per animation frame. Reads the analyser, splits
     the spectrum into bass/mid/high, normalizes to 0-1, and smooths with
     an exponential moving average so the visual never jitters frame to
     frame even though the FFT data is noisy.
   -------------------------------------------------------------------------- */
const AudioEngine = (() => {
  let ctx = null;
  let analyser = null;
  let gainNode = null;
  let buffer = null;
  let started = false;
  let muted = false;
  let usingSyntheticLoop = false;
  let freqData = null;

  const bands = { bass: 0, mid: 0, high: 0 };
  const SMOOTHING = 0.25; // EMA factor; retuned visually in Phase 2 if needed

  async function loadBuffer() {
    try {
      const res = await fetch('track.mp3');
      if (!res.ok) throw new Error('track.mp3 not found');
      const arrayBuffer = await res.arrayBuffer();
      buffer = await ctx.decodeAudioData(arrayBuffer);
    } catch (err) {
      usingSyntheticLoop = true;
      console.warn(
        '[diskevich] track.mp3 not found — playing a generated placeholder loop. ' +
          'TODO: drop a real track.mp3 in the project root to replace it.'
      );
      buffer = await generateSyntheticLoop(ctx.sampleRate);
    }

    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048; // 1024 frequency bins
    analyser.smoothingTimeConstant = 0; // we own smoothing ourselves, see SMOOTHING
    freqData = new Uint8Array(analyser.frequencyBinCount);

    gainNode = ctx.createGain();
    gainNode.gain.value = muted ? 0 : 1;

    analyser.connect(gainNode).connect(ctx.destination);
  }

  let preloadPromise = null;

  function preload() {
    // Memoized so preload() is safe to call multiple times, and so start()
    // can always await the *same* in-flight load instead of just checking
    // whether ctx exists yet (ctx is assigned synchronously below, well
    // before loadBuffer()'s async work — decoding/generating the buffer and
    // creating the analyser — actually finishes).
    if (!preloadPromise) {
      preloadPromise = (async () => {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        ctx = new Ctx(); // begins 'suspended' until a user-gesture resume()
        await loadBuffer();
      })();
    }
    return preloadPromise;
  }

  function play() {
    if (started) return;
    started = true;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(analyser);
    source.start(0);
  }

  async function start() {
    await preload(); // no-op await if already resolved; always safe
    if (ctx.state === 'suspended') await ctx.resume();
    play();
  }

  function toggleMute() {
    muted = !muted;
    if (gainNode && ctx) {
      gainNode.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.05);
    }
    return muted;
  }

  function bandAverage(from, to) {
    let sum = 0;
    let count = 0;
    for (let i = from; i < to && i < freqData.length; i++) {
      sum += freqData[i];
      count++;
    }
    return count ? sum / count / 255 : 0;
  }

  function update() {
    if (!analyser) return bands;
    analyser.getByteFrequencyData(freqData);

    const nyquist = ctx.sampleRate / 2;
    const binCount = freqData.length;
    const binFor = (hz) => Math.min(binCount - 1, Math.round((hz / nyquist) * binCount));

    const rawBass = bandAverage(binFor(20), binFor(160));
    const rawMid = bandAverage(binFor(160), binFor(2000));
    const rawHigh = bandAverage(binFor(2000), binFor(12000));

    bands.bass += (rawBass - bands.bass) * SMOOTHING;
    bands.mid += (rawMid - bands.mid) * SMOOTHING;
    bands.high += (rawHigh - bands.high) * SMOOTHING;

    return bands;
  }

  return {
    preload,
    start,
    toggleMute,
    update,
    get bands() {
      return bands;
    },
    get isMuted() {
      return muted;
    },
    get isSynthetic() {
      return usingSyntheticLoop;
    },
  };
})();

/* --------------------------------------------------------------------------
   Wave
   -----------------------------------------------------------------------
   Draws the wave on #wave-canvas. Each point's vertical displacement is the
   sum of:
     (a) three sine ripples driven by the live bass/mid/high band values
         (bass = slow, tall swells; mid = medium ripples; high = fast, fine
         jitter), so the wave visibly reacts to the music, and
     (b) a slow scrolling value-noise field, so the wave keeps breathing
         even in total silence (idle / before playback starts).
   Three layers are drawn: two faint, phase-shifted "echoes" behind a
   glow pass and the crisp main line — no per-frame shadowBlur (expensive);
   the glow is a plain wide, low-alpha stroke underneath the main line.

   Phase 3 adds pointer/touch distortion: every point within radius R of the
   cursor is pulled toward its y-coordinate (falloff by distance), and a
   critically-underdamped spring per point carries that pull as a persistent
   offset added on top of the audio+idle displacement — so it eases in when
   the pointer approaches and springs back with a touch of overshoot when it
   leaves, instead of teleporting.
   -------------------------------------------------------------------------- */
const Wave = (() => {
  let canvas, ctx;
  let width = 0;
  let height = 0;
  let pointCount = 120;

  // Persistent per-point spring state for pointer distortion (offset from
  // the point's natural/audio-driven y, and its velocity). Sized to
  // pointCount+1 whenever the point count changes (resize).
  let springY = [];
  let springVY = [];

  const pointer = { x: 0, y: 0, active: false };

  const color = { fg: '#f2ede4', accent: '#c97a3d' };

  function readColorTokens() {
    const styles = getComputedStyle(document.documentElement);
    color.fg = styles.getPropertyValue('--color-fg').trim() || color.fg;
    color.accent = styles.getPropertyValue('--color-accent').trim() || color.accent;
  }

  function hexToRgba(hex, alpha) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // ---- cheap 1D value noise (lattice hash + smoothstep interpolation),
  // summed at two octaves for a slightly more organic "breathing" curve ----
  function hash(n) {
    const s = Math.sin(n * 12.9898) * 43758.5453123;
    return s - Math.floor(s);
  }
  function noise1D(x) {
    const i0 = Math.floor(x);
    const t = x - i0;
    const s = t * t * (3 - 2 * t);
    return hash(i0) * (1 - s) + hash(i0 + 1) * s;
  }
  function idleNoise(x) {
    return noise1D(x) * 0.65 + noise1D(x * 2.13 + 41.7) * 0.35;
  }

  // ---- tuning constants, in CSS-pixel space ----
  const IDLE_AMP = 9;
  const IDLE_SCALE = 1.4;
  const IDLE_SPEED = 0.00022;

  const BASS_AMP = 56;
  const BASS_FREQ = 1.3; // cycles across the full width
  const BASS_SPEED = 0.00055;

  const MID_AMP = 22;
  const MID_FREQ = 4.4;
  const MID_SPEED = 0.0011;
  const MID_PHASE = Math.PI / 3;

  const HIGH_AMP = 10;
  const HIGH_FREQ = 15;
  const HIGH_SPEED = 0.0021;

  const EDGE_FADE = 0.06; // fraction of width tapered to 0 at each edge

  function edgeFade(u) {
    if (u < EDGE_FADE) return u / EDGE_FADE;
    if (u > 1 - EDGE_FADE) return (1 - u) / EDGE_FADE;
    return 1;
  }

  function displacement(u, t, bands, phaseShift, ampScale) {
    const tt = t + phaseShift;
    const bass = BASS_AMP * bands.bass * Math.sin(u * Math.PI * 2 * BASS_FREQ + tt * BASS_SPEED);
    const mid = MID_AMP * bands.mid * Math.sin(u * Math.PI * 2 * MID_FREQ + tt * MID_SPEED + MID_PHASE);
    const high = HIGH_AMP * bands.high * Math.sin(u * Math.PI * 2 * HIGH_FREQ + tt * HIGH_SPEED);
    const idle = IDLE_AMP * (idleNoise(u * IDLE_SCALE + tt * IDLE_SPEED) * 2 - 1);
    return (bass + mid + high + idle) * ampScale * edgeFade(u);
  }

  function tracePath(t, bands, phaseShift, ampScale, yOffset) {
    const midY = height / 2 + yOffset;
    ctx.beginPath();
    for (let i = 0; i <= pointCount; i++) {
      const u = i / pointCount;
      const x = u * width;
      const y = midY + displacement(u, t, bands, phaseShift, ampScale) + springY[i];
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }

  function computePointCount(w) {
    // ~1 point per 14 CSS px, clamped to a sane range. Mobile gets a
    // further, device-aware reduction pass in Phase 5.
    return Math.max(60, Math.min(220, Math.round(w / 14)));
  }

  function pointerRadius() {
    // Scales with viewport so the distortion field feels proportional on
    // both a phone and an ultrawide monitor.
    return Math.min(320, Math.max(140, width * 0.18));
  }

  // ---- pointer-distortion spring tuning ----
  const PULL_STRENGTH = 0.55; // fraction of pointer distance pulled at zero range
  const SPRING_HZ = 5; // natural frequency: snappy but not twitchy
  const SPRING_ZETA = 0.55; // underdamped: a touch of elastic overshoot on release
  const SPRING_K = (2 * Math.PI * SPRING_HZ) ** 2;
  const SPRING_C = 2 * SPRING_ZETA * 2 * Math.PI * SPRING_HZ;
  const MAX_DT = 0.05; // clamp so a stalled tab / big frame gap can't blow up the integrator

  function ensureSpringArrays() {
    if (springY.length !== pointCount + 1) {
      springY = new Array(pointCount + 1).fill(0);
      springVY = new Array(pointCount + 1).fill(0);
    }
  }

  function stepPhysics(t, bands, dtSec) {
    const dt = Math.min(dtSec, MAX_DT);
    const R = pointerRadius();

    for (let i = 0; i <= pointCount; i++) {
      const u = i / pointCount;
      const x = u * width;

      let target = 0;
      if (pointer.active) {
        const naturalY = height / 2 + displacement(u, t, bands, 0, 1);
        const dx = pointer.x - x;
        const dy = pointer.y - naturalY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < R) {
          const falloff = 1 - dist / R;
          target = dy * falloff * falloff * PULL_STRENGTH;
        }
      }

      const accel = SPRING_K * (target - springY[i]) - SPRING_C * springVY[i];
      springVY[i] += accel * dt;
      springY[i] += springVY[i] * dt;
    }
  }

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS-pixel coordinates
    pointCount = computePointCount(width);
    ensureSpringArrays();
  }

  let resizeTimer = null;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 120); // debounced
  }

  function setPointer(x, y) {
    pointer.x = x;
    pointer.y = y;
    pointer.active = true;
  }

  function clearPointer() {
    pointer.active = false;
  }

  function bindPointerEvents() {
    // window-level, not canvas-level: mouse/touch events still bubble up to
    // window even when the topmost element under the cursor is a button
    // (nav, mute, tap-to-enter), so the distortion field stays live over UI.
    window.addEventListener('mousemove', (e) => setPointer(e.clientX, e.clientY));
    window.addEventListener('mouseleave', clearPointer);

    window.addEventListener(
      'touchstart',
      (e) => {
        const touch = e.touches[0];
        if (touch) setPointer(touch.clientX, touch.clientY);
      },
      { passive: true }
    );
    window.addEventListener(
      'touchmove',
      (e) => {
        const touch = e.touches[0];
        if (touch) setPointer(touch.clientX, touch.clientY);
      },
      { passive: true }
    );
    window.addEventListener('touchend', clearPointer, { passive: true });
    window.addEventListener('touchcancel', clearPointer, { passive: true });
  }

  function init() {
    canvas = document.getElementById('wave-canvas');
    ctx = canvas.getContext('2d');
    readColorTokens();
    resize();
    window.addEventListener('resize', onResize);
    bindPointerEvents();
  }

  function draw(t, dt, bands) {
    stepPhysics(t, bands, dt);

    ctx.clearRect(0, 0, width, height);

    // Echoes: faintest + furthest phase-shift drawn first (furthest back).
    tracePath(t, bands, -420, 0.72, 10);
    ctx.strokeStyle = hexToRgba(color.fg, 0.08);
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    tracePath(t, bands, -220, 0.85, 5);
    ctx.strokeStyle = hexToRgba(color.fg, 0.16);
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Glow: one wide, low-alpha stroke under the main line — the cheap
    // alternative to setting shadowBlur every frame.
    tracePath(t, bands, 0, 1, 0);
    ctx.strokeStyle = hexToRgba(color.accent, 0.18);
    ctx.lineWidth = 8;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Main line.
    tracePath(t, bands, 0, 1, 0);
    ctx.strokeStyle = color.fg;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  return { init, draw };
})();

/* -------------------------------------------------------------------------- */

(() => {
  const body = document.body;
  const tapToEnter = document.getElementById('tap-to-enter');
  const muteToggle = document.getElementById('mute-toggle');

  // Start loading/generating audio immediately so the wake moment has no
  // decode lag; the context stays 'suspended' (no sound) until the tap.
  AudioEngine.preload();
  Wave.init();

  tapToEnter.addEventListener('click', async () => {
    if (body.dataset.state === 'awake') return;
    body.dataset.state = 'awake';
    await AudioEngine.start();
  });

  muteToggle.addEventListener('click', () => {
    const muted = AudioEngine.toggleMute();
    muteToggle.setAttribute('aria-pressed', String(muted));
    body.dataset.muted = String(muted);
  });

  // Dev/debug access: set window.DJ_DEBUG = true in the console to log
  // live bass/mid/high values (throttled to 2/sec). Also reachable directly
  // as window.diskevichAudio.bands at any time.
  window.diskevichAudio = AudioEngine;

  let lastTime = 0;
  let debugAccum = 0;

  // TEMP (Phase 2 perf validation only — removed in Phase 6): on-screen fps
  // meter, lazily created the first time window.DJ_DEBUG is set so it costs
  // nothing on a normal page load.
  let fpsEl = null;
  let fpsFrames = 0;
  let fpsAccum = 0;

  function frameLoop(ts) {
    requestAnimationFrame(frameLoop);
    const dt = lastTime ? ts - lastTime : 0;
    lastTime = ts;

    const bands = AudioEngine.update();
    Wave.draw(ts, dt / 1000, bands);

    if (window.DJ_DEBUG) {
      debugAccum += dt;
      if (debugAccum > 500) {
        debugAccum = 0;
        console.log('[diskevich audio]', {
          bass: bands.bass.toFixed(2),
          mid: bands.mid.toFixed(2),
          high: bands.high.toFixed(2),
        });
      }

      if (!fpsEl) {
        fpsEl = document.createElement('div');
        fpsEl.style.cssText =
          'position:fixed;top:8px;left:8px;z-index:999;font:11px monospace;' +
          'color:#0f0;background:rgba(0,0,0,.6);padding:2px 6px;pointer-events:none;';
        document.body.appendChild(fpsEl);
      }
      fpsFrames++;
      fpsAccum += dt;
      if (fpsAccum > 500) {
        fpsEl.textContent = Math.round((fpsFrames * 1000) / fpsAccum) + ' fps';
        fpsFrames = 0;
        fpsAccum = 0;
      }
    } else if (fpsEl) {
      fpsEl.remove();
      fpsEl = null;
    }
  }
  requestAnimationFrame(frameLoop);
})();
