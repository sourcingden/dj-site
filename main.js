/* ==========================================================================
   diskevich — main.js

   Phase 0: skeleton wiring (tap-to-enter -> awake state).
   Phase 1: audio engine — AudioContext, AnalyserNode, bass/mid/high bands,
            mute, suspended-state handling, synthetic placeholder track.
   ========================================================================== */

/* --------------------------------------------------------------------------
   Shared mobile detection
   -----------------------------------------------------------------------
   Width + touch (coarse pointer), per the brief. Read by Wave (fewer wave
   points) and by the audio analysis throttle below (Phase 5: reduce point
   count and analysis frequency on mobile). Recomputed on resize so
   rotating a phone or resizing a window stays correct.
   -------------------------------------------------------------------------- */
let mobileMode = false;
function updateMobileMode() {
  mobileMode = window.innerWidth <= 768 || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
}
updateMobileMode();
window.addEventListener('resize', updateMobileMode);

/* --------------------------------------------------------------------------
   Reduced motion (Phase 6)
   -----------------------------------------------------------------------
   Read live via a MediaQueryList so toggling the OS setting mid-session
   takes effect immediately, no reload needed. Wave freezes the time input
   to its idle/audio displacement (so it stops breathing/animating on its
   own) while still letting pointer-driven distortion — direct user
   interaction, not ambient motion — spring normally. Audio never
   autoplays for these users: tap-to-enter still dismisses the entry
   screen, but AudioEngine.start() is skipped.
   -------------------------------------------------------------------------- */
const reducedMotionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
function prefersReducedMotion() {
  return !!(reducedMotionQuery && reducedMotionQuery.matches);
}

/* --------------------------------------------------------------------------
   Synthetic placeholder loop
   -----------------------------------------------------------------------
   TODO: replace with a real track.mp3 in the project root. Until then this
   procedurally renders a ~30s obscure/hypnotic loop (four-on-the-floor kick
   = bass, sparse minor-interval arpeggio = mid, filtered noise hats = high)
   so the analyser always has real bass/mid/high content to react to.
   -------------------------------------------------------------------------- */
// Yields back to the main thread periodically (Phase 6: this is what keeps
// generateSyntheticLoop's ~400 Web Audio node-creation calls from forming
// one long synchronous task that would spike Total Blocking Time on page
// load — each chunk between yields stays well under the 50ms "long task"
// threshold instead of one ~300ms+ block).
function yieldToMain() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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
    if (i % 30 === 0) await yieldToMain();
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
    if (i % 30 === 0) await yieldToMain();
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
    if (i % 30 === 0) await yieldToMain();
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
  let audioUnavailable = false;
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
    // Fewer bins on mobile (Phase 5): halves the per-call cost of
    // getByteFrequencyData, and bass/mid/high bucket averaging doesn't need
    // the extra resolution 2048 buys on a phone-class CPU anyway.
    analyser.fftSize = mobileMode ? 1024 : 2048;
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
        // Fallback (Phase 6): if Web Audio isn't available at all, or
        // anything in setup throws, fail soft — the wave already runs on
        // idle noise alone whenever `analyser` is null (see update()
        // below), so the site stays exactly as designed, just silent.
        try {
          const Ctx = window.AudioContext || window.webkitAudioContext;
          if (!Ctx) throw new Error('Web Audio API not supported in this browser');
          ctx = new Ctx(); // begins 'suspended' until a user-gesture resume()
          await loadBuffer();
        } catch (err) {
          audioUnavailable = true;
          console.warn('[diskevich] Web Audio unavailable — running on idle motion only, no sound.', err);
        }
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

  async function start(fadeInMs) {
    await preload(); // no-op await if already resolved; always safe
    if (audioUnavailable) return; // no-op: nothing to resume/play
    if (ctx.state === 'suspended') await ctx.resume();
    // Wake sequence (Phase 7): sound rises from 0 rather than starting at
    // full volume — sample-accurate native automation on the audio thread,
    // not a JS-polled fade, so it stays smooth regardless of main-thread load.
    if (fadeInMs && gainNode) {
      const target = muted ? 0 : 1;
      gainNode.gain.cancelScheduledValues(ctx.currentTime);
      gainNode.gain.setValueAtTime(0, ctx.currentTime);
      gainNode.gain.linearRampToValueAtTime(target, ctx.currentTime + fadeInMs / 1000);
    }
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

  function tracePath(t, bands, phaseShift, ampScale, yOffset, globalScale) {
    const midY = height / 2 + yOffset;
    ctx.beginPath();
    for (let i = 0; i <= pointCount; i++) {
      const u = i / pointCount;
      const x = u * width;
      const y = midY + (displacement(u, t, bands, phaseShift, ampScale) + springY[i]) * globalScale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }

  function computePointCount(w) {
    // ~1 point per 14 CSS px on desktop; sparser and capped lower on
    // mobile (touch or <=768px) — a phone GPU/CPU redraws far fewer
    // segments for a line that's rendered much smaller anyway.
    if (mobileMode) {
      return Math.max(40, Math.min(90, Math.round(w / 20)));
    }
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

  // Concept spec: before the first tap the site is 'sleeping' — the wave
  // should barely move, not breathe at full amplitude.
  const SLEEP_SCALE = 0.12;

  // Classic ease-out-expo, evaluated in JS so the canvas amplitude ramp can
  // follow the same "fast start, long settle" character as the CSS token
  // --ease-out-expo used for the entry-screen fade — not a byte-for-byte
  // match (that would need a full cubic-bezier solver for one moment), just
  // the same *feel*, so the wake reads as one coordinated motion.
  function easeOutExpo(x) {
    return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x);
  }

  function draw(t, dt, bands, wakeProgress) {
    // Reduced motion (Phase 6): freeze the time input to the shape math so
    // the idle-noise breathing and audio ripples stop animating on their
    // own — the wave becomes a static (but still organically-shaped, not a
    // flat line) curve. `dt` for the pointer spring is left untouched, so
    // direct interaction — user-initiated, not ambient motion — still
    // eases and settles normally; reduced motion targets automatic motion,
    // not a response to something the visitor is actively doing.
    const effectiveT = prefersReducedMotion() ? 0 : t;
    // wakeProgress is 0 while sleeping, ramps 0->1 over the wake sequence
    // (Phase 7), and stays 1 once fully awake — the wave visibly unfurls
    // from barely-moving to full amplitude instead of snapping.
    const globalScale = SLEEP_SCALE + (1 - SLEEP_SCALE) * easeOutExpo(wakeProgress);

    stepPhysics(effectiveT, bands, dt);

    ctx.clearRect(0, 0, width, height);

    // Echoes: faintest + furthest phase-shift drawn first (furthest back).
    tracePath(effectiveT, bands, -420, 0.72, 10, globalScale);
    ctx.strokeStyle = hexToRgba(color.fg, 0.08);
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    tracePath(effectiveT, bands, -220, 0.85, 5, globalScale);
    ctx.strokeStyle = hexToRgba(color.fg, 0.16);
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Glow: one wide, low-alpha stroke under the main line — the cheap
    // alternative to setting shadowBlur every frame.
    tracePath(effectiveT, bands, 0, 1, 0, globalScale);
    ctx.strokeStyle = hexToRgba(color.accent, 0.18);
    ctx.lineWidth = 8;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Main line.
    tracePath(effectiveT, bands, 0, 1, 0, globalScale);
    ctx.strokeStyle = color.fg;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  return { init, draw };
})();

/* --------------------------------------------------------------------------
   Cursor (Phase 7)
   -----------------------------------------------------------------------
   A small dot that follows the pointer and grows into a ring over anything
   clickable — reinforces "this is interactive" precisely where the design
   otherwise has almost no conventional affordances (no buttons-that-look-
   like-buttons, no underlines except overlay links). Fine-pointer devices
   only: touch has no hover state and the OS cursor is already correct
   there, so this stays out of mobileMode's way entirely. Position updates
   via CSS transform (compositor-only, not layout) with a short transition
   for a touch of trailing lag rather than a robotic 1:1 snap; that
   transition duration is the shared --dur-fast token, so it goes to 0
   automatically under prefers-reduced-motion like everything else.
   -------------------------------------------------------------------------- */
const Cursor = (() => {
  function init() {
    if (mobileMode) return;

    const dot = document.createElement('div');
    dot.className = 'cursor-dot';
    dot.setAttribute('aria-hidden', 'true');
    document.body.appendChild(dot);
    document.body.classList.add('has-custom-cursor');

    window.addEventListener('mousemove', (e) => {
      dot.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0)`;
      // e.target isn't always an Element (can be `document`, which has no
      // .closest) — e.g. when the pointer is right at the document edge.
      const overInteractive = !!(e.target && e.target.closest && e.target.closest('button, a'));
      dot.classList.toggle('cursor-dot--active', overInteractive);
    });
    window.addEventListener('mouseleave', () => dot.classList.add('cursor-dot--hidden'));
    window.addEventListener('mouseenter', () => dot.classList.remove('cursor-dot--hidden'));
  }

  return { init };
})();

/* --------------------------------------------------------------------------
   Overlays
   -----------------------------------------------------------------------
   Fullscreen bio/dates/booking panels. One open/close motion (defined in
   CSS: fade + slight rise), Esc and a click on the backdrop both close,
   focus moves into the panel on open and is trapped there (Tab/Shift+Tab
   cycle within it) and restored to the trigger button on close.
   -------------------------------------------------------------------------- */
const Overlays = (() => {
  let active = null;
  let lastFocused = null;

  const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

  function focusableIn(container) {
    return Array.from(container.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null);
  }

  function open(name) {
    const el = document.getElementById(`overlay-${name}`);
    if (!el || el === active) return;
    lastFocused = document.activeElement;
    active = el;
    el.removeAttribute('inert'); // must come before .focus() — an inert element can't receive it
    el.setAttribute('aria-hidden', 'false');
    el.dataset.open = 'true';
    const closeBtn = el.querySelector('[data-overlay-close]');
    if (closeBtn) closeBtn.focus();
  }

  function close() {
    if (!active) return;
    active.dataset.open = 'false';
    active.setAttribute('aria-hidden', 'true');
    active.setAttribute('inert', '');
    active = null;
    if (lastFocused) lastFocused.focus();
  }

  function onKeydown(e) {
    if (!active) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Tab') {
      const focusables = focusableIn(active);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function onBackdropClick(e) {
    // Only a direct click on the backdrop itself closes it — clicks inside
    // .overlay-inner bubble here too, so this must not fire for those.
    if (e.target === active) close();
  }

  function init() {
    document.querySelectorAll('[data-overlay-target]').forEach((btn) => {
      btn.addEventListener('click', () => open(btn.dataset.overlayTarget));
    });
    document.querySelectorAll('[data-overlay-panel]').forEach((panel) => {
      panel.addEventListener('click', onBackdropClick);
      const closeBtn = panel.querySelector('[data-overlay-close]');
      if (closeBtn) closeBtn.addEventListener('click', close);
    });
    document.addEventListener('keydown', onKeydown);
  }

  return { init };
})();

/* -------------------------------------------------------------------------- */

(() => {
  const body = document.body;
  const tapToEnter = document.getElementById('tap-to-enter');
  const muteToggle = document.getElementById('mute-toggle');

  // Start loading/generating audio once the page has painted and settled
  // (Phase 6: keeps the — possibly chunky, especially for the synthetic
  // placeholder loop — decode/generate work off the critical initial-paint
  // path) rather than at parse time, but still well ahead of the tap so
  // the wake moment has no perceptible lag.
  const kickOffAudioPreload = () => {
    if ('requestIdleCallback' in window) {
      requestIdleCallback(() => AudioEngine.preload(), { timeout: 2000 });
    } else {
      setTimeout(() => AudioEngine.preload(), 0);
    }
  };
  if (document.readyState === 'complete') {
    kickOffAudioPreload();
  } else {
    window.addEventListener('load', kickOffAudioPreload);
  }

  Wave.init();
  Overlays.init();
  Cursor.init();

  // Wake sequence (Phase 7): one duration drives all three parts of the
  // reveal — the entry screen's own CSS fade (already using this token
  // since Phase 0), the wave's amplitude ramp, and the audio fade-in — so
  // they read as one coordinated 1.5s moment instead of three unrelated
  // timings that happen to overlap. Read from the CSS token rather than
  // re-declaring 1500 here, so there's exactly one source of truth.
  // Floored at 300ms: if prefers-reduced-motion was active at page load,
  // --dur-wake reads as 0ms (per the Phase 0 token override) — harmless on
  // its own since the ramp is skipped entirely whenever reduced motion is
  // active at tap time (see both call sites below), but this keeps the
  // captured constant itself safe to use (no divide-by-zero) for the edge
  // case of someone switching the OS setting off between load and tap.
  const WAKE_DURATION_MS = Math.max(
    300,
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-wake')) || 1500
  );
  let wakeStartTs = null;

  tapToEnter.addEventListener('click', async () => {
    if (body.dataset.state === 'awake') return;
    body.dataset.state = 'awake';
    wakeStartTs = performance.now();
    // Reduced motion (Phase 6): dismiss the entry screen, but don't start
    // audio — nothing here should autoplay for these visitors.
    if (!prefersReducedMotion()) {
      await AudioEngine.start(WAKE_DURATION_MS);
    }
  });

  muteToggle.addEventListener('click', () => {
    const muted = AudioEngine.toggleMute();
    muteToggle.setAttribute('aria-pressed', String(muted));
    body.dataset.muted = String(muted);
  });

  // Dev/debug access, zero runtime cost otherwise: window.diskevichAudio.bands
  // for live bass/mid/high, window.diskevichDebug.mobileMode to check which
  // branch is active. (The old DJ_DEBUG console logger and on-screen fps
  // meter were removed in Phase 6.)
  window.diskevichAudio = AudioEngine;
  window.diskevichDebug = {
    get mobileMode() {
      return mobileMode;
    },
  };

  let lastTime = 0;
  let mobileFrameCounter = 0;
  let rafId = null;
  let lastSleepDrawTs = 0;
  // Barely-moving content doesn't need 60fps: while sleeping (pre-tap),
  // redraw only a few times a second instead of every frame. Genuinely
  // cheaper (near-zero CPU during however long the entry screen sits
  // there), and it keeps the pre-interaction screen visually calmer.
  const SLEEP_REDRAW_INTERVAL_MS = 200;

  function frameLoop(ts) {
    rafId = requestAnimationFrame(frameLoop);
    const dt = lastTime ? ts - lastTime : 0;
    lastTime = ts;

    const awake = body.dataset.state === 'awake';
    if (!awake && ts - lastSleepDrawTs < SLEEP_REDRAW_INTERVAL_MS) return;
    lastSleepDrawTs = ts;

    // Wake sequence (Phase 7): 0 while sleeping, ramps 0->1 over
    // WAKE_DURATION_MS once tapped, 1 once fully awake. Reduced motion
    // jumps straight to the end state instead of animating the ramp — a
    // static wave shouldn't spend 1.5s visibly growing its own amplitude,
    // that's still ambient motion, just a one-shot instead of a loop.
    let wakeProgress = 0;
    if (awake) {
      wakeProgress = prefersReducedMotion() ? 1 : Math.min(1, (ts - wakeStartTs) / WAKE_DURATION_MS);
    }

    // Phase 5: halve analysis frequency on mobile (still redraw the wave
    // every frame — only the relatively expensive getByteFrequencyData +
    // band-averaging read is skipped every other frame). The EMA smoothing
    // already in AudioEngine.update() makes the reused value indistinguishable
    // from a fresh one at this rate.
    let bands;
    if (mobileMode) {
      mobileFrameCounter++;
      bands = mobileFrameCounter % 2 === 0 ? AudioEngine.update() : AudioEngine.bands;
    } else {
      bands = AudioEngine.update();
    }
    Wave.draw(ts, dt / 1000, bands, wakeProgress);
  }

  // Phase 6: stop the loop entirely while the tab is hidden — no canvas
  // redraws, no analyser reads, no physics — and resume cleanly when it's
  // shown again. lastTime is reset on resume so the first post-resume
  // frame doesn't see a multi-second dt (Wave already clamps its own
  // physics dt too, but there's no reason to feed it a huge gap at all).
  function startLoop() {
    if (rafId !== null) return;
    lastTime = 0;
    rafId = requestAnimationFrame(frameLoop);
  }
  function stopLoop() {
    if (rafId === null) return;
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopLoop();
    else startLoop();
  });
  startLoop();
})();
