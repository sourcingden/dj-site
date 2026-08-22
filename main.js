/* ==========================================================================
   diskevich — main.js

   Phase 0: skeleton wiring (tap-to-enter -> awake state).
   Phase 1: audio engine — AudioContext, AnalyserNode, bass/mid/high bands,
            mute, suspended-state handling, synthetic placeholder track.
   Phase 8: Orb, a Three.js + GLSL background accent, additive on top of
            the wave, and the micro-VU pulse wired into frameLoop() below.
            Three.js is the site's first external JS dependency (vendor/,
            see vendor/README.md for what's vendored and why), which is
            why this file is loaded as an ES module (index.html's
            <script type="module">) instead of a plain script.

   Entry & reveal: tap/click anywhere is the site's only gesture — see
   beginExperience() near the bottom bootstrapping IIFE. It unlocks audio,
   wakes the wave, and kicks off startRevealSequence(), which staggers in
   the wordmark, bio and links one at a time, then eases the wave down to a
   settled amplitude via tweenMixToOne(). See AudioEngine.currentTargetVolume()
   and Wave.draw()'s `mix` parameter for how the audio and visual sides each
   read that settle value.
   ========================================================================== */

import * as THREE from './vendor/three.module.js';

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
   Artist-name fit
   -----------------------------------------------------------------------
   --fs-display's clamp() is tuned against the Unbounded display font's
   metrics. If that font hasn't loaded yet (or fails entirely — slow
   connection, a content blocker) the browser renders the same font-size in
   a fallback face instead, which can measure meaningfully wider for the
   same 9 characters and overflow — with nowrap set in CSS, an overflowing
   *inline* heading like this doesn't wrap, but with block/flex ancestors
   it can still be forced onto a second line, breaking "diskevich" mid-word.
   This measures the actual rendered width against the space really
   available and shrinks the font-size to fit, whichever font is in play.
   -------------------------------------------------------------------------- */
function fitArtistName() {
  const el = document.querySelector('.artist-name');
  const scene = document.querySelector('.scene');
  if (!el || !scene) return;
  el.style.fontSize = ''; // back to the CSS clamp() baseline before measuring
  const sceneStyle = getComputedStyle(scene);
  const available = document.documentElement.clientWidth - parseFloat(sceneStyle.paddingLeft) - parseFloat(sceneStyle.paddingRight);
  const natural = el.scrollWidth;
  if (natural > 0 && natural > available) {
    const base = parseFloat(getComputedStyle(el).fontSize);
    el.style.fontSize = base * (available / natural) * 0.97 + 'px'; // small safety margin
  }
}

(() => {
  let fitTimer = null;
  const scheduleFit = () => {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(fitArtistName, 120);
  };
  fitArtistName();
  window.addEventListener('resize', scheduleFit);
  if (document.fonts && document.fonts.ready) {
    // Refit once Unbounded actually finishes loading/swapping in — the
    // pre-swap fallback-font measurement above may no longer apply.
    document.fonts.ready.then(fitArtistName).catch(() => {});
  }
})();

/* --------------------------------------------------------------------------
   Reduced motion (Phase 6)
   -----------------------------------------------------------------------
   Read live via a MediaQueryList so toggling the OS setting mid-session
   takes effect immediately, no reload needed. Wave freezes the time input
   to its idle/audio displacement (so it stops breathing/animating on its
   own) while still letting pointer-driven distortion — direct user
   interaction, not ambient motion — spring normally. Audio never
   autoplays for these users: entry still flips the site to 'awake' on
   first interaction, but AudioEngine.start() is skipped.
   -------------------------------------------------------------------------- */
const reducedMotionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
function prefersReducedMotion() {
  return !!(reducedMotionQuery && reducedMotionQuery.matches);
}

/* --------------------------------------------------------------------------
   Synthetic placeholder loop
   -----------------------------------------------------------------------
   Fallback only — the site now ships with a real track.mp3, so this path
   normally never runs. Kept as a safety net for a deploy that's missing the
   file (or a decode failure): procedurally renders a ~30s obscure/hypnotic
   loop (four-on-the-floor kick = bass, sparse minor-interval arpeggio =
   mid, filtered noise hats = high) so the analyser still has real
   bass/mid/high content to react to instead of the site going silent.
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

  // Single source of truth for "what should the gain node actually be right
  // now" — used by loadBuffer()'s initial value, start()'s fade-in target,
  // and toggleMute(), so none of them can drift out of sync with each
  // other. Full volume once started, until manually muted — there's no
  // "mode" to duck toward anymore (see main.js's tweenMixToOne(), which is
  // a purely visual settle, not an audio one).
  function currentTargetVolume() {
    return muted ? 0 : 1;
  }

  async function loadBuffer() {
    try {
      const res = await fetch('track.mp3');
      if (!res.ok) throw new Error('track.mp3 not found');
      const arrayBuffer = await res.arrayBuffer();
      buffer = await ctx.decodeAudioData(arrayBuffer);
    } catch (err) {
      usingSyntheticLoop = true;
      console.warn(
        '[diskevich] track.mp3 missing or failed to decode — falling back to a generated ' +
          'placeholder loop. Check that track.mp3 was actually included in the deploy.',
        err
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
    gainNode.gain.value = currentTargetVolume();

    // Gain BEFORE the analyser (not after): the analyser has to measure
    // what's actually audible. With gain downstream of it, muting only
    // silenced the speakers — the analyser kept reading the full,
    // unattenuated signal, so the wave kept dancing to music the visitor
    // could no longer hear. This way, muted (or mixed toward booking) ->
    // analyser reads a quieter/silent signal -> bands decay toward 0 on
    // their own; Wave's explicit pause() (below) makes the mute case
    // instant and dramatic instead of a several-frame fade — the mix case
    // is meant to fade smoothly, so it's left to this natural decay.
    gainNode.connect(analyser).connect(ctx.destination);
  }

  // iOS Safari (and some other WebKit-based mobile browsers) only honors
  // AudioContext.resume() as an audio-unlocking action when it's called
  // *synchronously* inside a genuine user-gesture handler — not after any
  // await, even a fetch or a heavy computation that resolves almost
  // instantly. start() below does real async work first (awaiting preload,
  // which may still be mid-flight on a slow connection), so calling
  // resume() only at the end of that chain works on desktop Chrome but can
  // silently fail to unlock audio on iOS: the context stays 'suspended'
  // forever, the analyser only ever reads silence, and the wave — driven
  // solely by its ~9px idle-noise term at that point — reads as "static"
  // even though the code all technically runs. unlock() exists purely to
  // be the *first* synchronous statement in the entry gesture's handler
  // (beginExperience(), main.js's bottom IIFE), so the resume call happens
  // as close to the raw gesture as possible; start() still does the real
  // awaited setup afterward.
  function unlock() {
    if (!ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return; // preload()'s own try/catch will set audioUnavailable
      ctx = new Ctx();
    }
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {}); // fire-and-forget; start() re-checks state
    }
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
          if (!ctx) {
            if (!Ctx) throw new Error('Web Audio API not supported in this browser');
            ctx = new Ctx(); // begins 'suspended' until a user-gesture resume()
          }
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
    source.connect(gainNode); // gain -> analyser -> destination, see loadBuffer()
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
      const target = currentTargetVolume();
      gainNode.gain.cancelScheduledValues(ctx.currentTime);
      gainNode.gain.setValueAtTime(0, ctx.currentTime);
      gainNode.gain.linearRampToValueAtTime(target, ctx.currentTime + fadeInMs / 1000);
    }
    play();
  }

  // iOS in particular can interrupt/suspend an already-unlocked
  // AudioContext during backgrounding — independent of the rAF loop
  // stop/start on visibilitychange (main.js's bottom IIFE), and with no
  // event of its own to say so. Called from that same visibilitychange
  // handler on returning to the foreground, purely as a "if it's stuck,
  // try again" nudge — a no-op fire-and-forget when there's nothing to
  // resume (never started, or already running).
  function resumeIfSuspended() {
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  }

  function toggleMute() {
    muted = !muted;
    if (gainNode && ctx) {
      // cancelScheduledValues first: without it, if the wake sequence's
      // fade-in ramp (start(), above) is still in flight — reachable simply
      // by clicking mute within ~1.5s of the initial interaction — that
      // ramp keeps running completely uninterrupted, since a still-active
      // linearRampToValueAtTime's own scheduled end time otherwise takes
      // priority over a new setTargetAtTime call layered on top of it. Found
      // by instrumenting the actual gain value over time, not by inspection:
      // muting appeared to do nothing for up to a second and a half.
      gainNode.gain.cancelScheduledValues(ctx.currentTime);
      gainNode.gain.setTargetAtTime(currentTargetVolume(), ctx.currentTime, 0.05);
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
    unlock,
    preload,
    start,
    resumeIfSuspended,
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

  // Multi-touch: keyed by 'mouse' or a touch's identifier, so several
  // simultaneous fingers each pull the wave independently instead of only
  // the first one being tracked. Desktop mouse goes through the exact same
  // map/keying as a one-item touch list — no parallel code path.
  const pointers = new Map(); // key -> {x, y}
  // Per-key last-seen position+time, used only to derive scratch drag
  // velocity — separate from `pointers` because it needs to persist one
  // extra read (the "previous" sample) that the spring/distortion side has
  // no use for.
  const pointerHistory = new Map(); // key -> {x, y, ts}

  // Pause/dissolve (mute -> "pause"): the most recently rendered frame's
  // inputs, cached so pause() — called from a click handler, not from
  // inside draw() — can freeze the *actual last-seen* shape rather than
  // recomputing something slightly different.
  let lastT = 0;
  let lastBands = { bass: 0, mid: 0, high: 0 };
  let lastGlobalScale = 1;
  let paused = false;
  let dissolveStartTs = null;
  // Wall-clock (Date.now(), not the rAF `t` clock) backup for the transient
  // check below — see draw()'s STUCK_TRANSIENT_CEILING_MS use of this.
  let dissolveWallStartMs = null;
  let frozenPoints = [];
  let particles = [];
  const DISSOLVE_DURATION_S = 0.7;

  // Assemble (reverse of dissolve): the wave never just sits there as a
  // static line while dormant — see the `!awake`/settled-dissolve branches
  // in draw(), which draw nothing at all in that state. Starting playback
  // (the very first wake, or resuming after mute) instead earns a moment
  // of particles converging into the line, which then fades in alongside
  // them, before normal live drawing takes over. See wake()/resume() for
  // the two trigger points and spawnAssembleParticles() for the particle
  // side.
  let assembling = false;
  let assembleStartTs = null;
  let assembleWallStartMs = null; // see dissolveWallStartMs's own comment
  let assembleTargetPoints = [];
  const ASSEMBLE_DURATION_S = 0.8;

  // Last-resort safety valve for both transient states above: their normal
  // "< DURATION" checks use the rAF `t` clock, which self-heals correctly
  // even across a huge gap (a long-backgrounded tab's first frame back
  // computes a huge elapsed value, correctly exceeds DURATION, falls
  // through to live drawing on its own). This wall-clock backup exists for
  // whatever *isn't* that case — any clock discontinuity that isn't just
  // "a big but valid elapsed time" — so a transient state can never survive
  // more than a few seconds of genuine real time no matter what.
  const STUCK_TRANSIENT_CEILING_MS = 5000;

  const color = { fg: '#f2ede4', accent: '#c97a3d', selection: '#ff2d78' };

  function readColorTokens() {
    const styles = getComputedStyle(document.documentElement);
    color.fg = styles.getPropertyValue('--color-fg').trim() || color.fg;
    color.accent = styles.getPropertyValue('--color-accent').trim() || color.accent;
    // Second accent tone for the rave-burst color cycle (see
    // triggerRaveBurst) — reuses the existing bright ::selection color
    // rather than inventing a third one.
    color.selection = styles.getPropertyValue('--color-selection-bg').trim() || color.selection;
  }

  function hexToRgb(hex) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function hexToRgba(hex, alpha) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // Linear interpolation between two hex colors — used only for the
  // rave-burst color cycle (see triggerRaveBurst), computed fresh each call
  // rather than cached, so it never risks leaving a stale mixed color
  // behind in the module's normal fg/accent tokens.
  // Returns {r,g,b} rather than a formatted string — the caller decides
  // whether it needs a solid rgb() or an alpha-bearing rgba().
  function mixHex(hexA, hexB, t) {
    const a = hexToRgb(hexA);
    const b = hexToRgb(hexB);
    return {
      r: Math.round(a.r + (b.r - a.r) * t),
      g: Math.round(a.g + (b.g - a.g) * t),
      b: Math.round(a.b + (b.b - a.b) * t),
    };
  }

  function rgbaCss({ r, g, b }, alpha) {
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
    // scratchPhaseOffsetMs: a global, transient phase "lurch" from the
    // scratch gesture (see updateScratch) — added here so it warps every
    // term (bass/mid/high/idle) at once, the same way phaseShift already
    // does for the echo layers, rather than needing its own amplitude path.
    const tt = t + phaseShift + scratchPhaseOffsetMs;
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
      // (springY[i] || 0): springY is sized to pointCount+1 by
      // ensureSpringArrays() (called from resize(), which init() always
      // runs before anything else can call this) — should never actually
      // be out of sync, but if it ever is on some real device's init-order
      // edge case, an `undefined` here would silently turn the whole sum
      // into NaN, and Canvas just no-ops non-finite coordinates — the line
      // vanishes with no error at all. Cheap enough to guard unconditionally.
      const y = midY + (displacement(u, t, bands, phaseShift, ampScale) + (springY[i] || 0)) * globalScale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }

  // Returns the main line's current on-screen points (same math tracePath
  // uses for its main-line call: phaseShift 0, layer ampScale 1, yOffset 0)
  // as plain {x,y} pairs — used to freeze a shape at the moment of pause,
  // separate from the stroking path tracePath draws directly to ctx.
  function capturePoints(t, bands, globalScale) {
    const midY = height / 2;
    const pts = new Array(pointCount + 1);
    for (let i = 0; i <= pointCount; i++) {
      const u = i / pointCount;
      pts[i] = {
        x: u * width,
        y: midY + (displacement(u, t, bands, 0, 1) + (springY[i] || 0)) * globalScale,
      };
    }
    return pts;
  }

  // A few particles per point, not "millions" — canvas 2D animating actual
  // millions of individually-simulated particles at 60fps isn't realistic
  // on any device this site targets. This density (a few hundred, scaled
  // with pointCount so it's lighter on mobile) already reads as a proper
  // shatter/dust dissolve rather than a sparse scatter of dots.
  const PARTICLES_PER_POINT = 3;

  function spawnDissolveParticles(points) {
    particles = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      for (let k = 0; k < PARTICLES_PER_POINT; k++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 30 + Math.random() * 150;
        particles.push({
          x: p.x + (Math.random() - 0.5) * 4,
          y: p.y + (Math.random() - 0.5) * 4,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 15, // slight upward drift, like dust lifting
          size: 1 + Math.random() * 2.4,
          life: 0,
          maxLife: DISSOLVE_DURATION_S * (0.6 + Math.random() * 0.6),
          color: Math.random() < 0.6 ? color.fg : color.accent,
        });
      }
    }
  }

  function updateAndDrawParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.95;
      p.vy *= 0.95;
      const fade = 1 - p.life / p.maxLife;
      ctx.beginPath();
      ctx.fillStyle = hexToRgba(p.color, fade * 0.9);
      ctx.arc(p.x, p.y, Math.max(0.2, p.size * fade), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- Assemble: the reverse of the dissolve above ----
  // Same particle count per target point, but a deterministic ease-in
  // toward a fixed target instead of velocity/drag physics — dissolve's
  // outward burst wants organic, unpredictable drift; coming together
  // reads better as a clean, confident convergence. Each particle stores
  // its own immutable startX/startY (where it appears) and targetX/targetY
  // (the point on the line it's heading for); updateAndDrawAssembleParticles
  // re-lerps position from those every frame rather than integrating
  // velocity, so there's no drift to accumulate or reset.
  function spawnAssembleParticles(targetPoints) {
    particles = [];
    for (let i = 0; i < targetPoints.length; i++) {
      const p = targetPoints[i];
      for (let k = 0; k < PARTICLES_PER_POINT; k++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 30 + Math.random() * 200;
        particles.push({
          startX: p.x + Math.cos(angle) * dist,
          startY: p.y + Math.sin(angle) * dist - 20, // slight downward settle, mirroring the dissolve's upward lift
          targetX: p.x,
          targetY: p.y,
          size: 1 + Math.random() * 2.4,
          life: 0,
          maxLife: ASSEMBLE_DURATION_S * (0.7 + Math.random() * 0.3),
          color: Math.random() < 0.6 ? color.fg : color.accent,
        });
      }
    }
  }

  function updateAndDrawAssembleParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;
      const progress = Math.min(1, p.life / p.maxLife);
      if (progress >= 1) {
        particles.splice(i, 1);
        continue;
      }
      const eased = easeOutExpo(progress);
      const x = p.startX + (p.targetX - p.startX) * eased;
      const y = p.startY + (p.targetY - p.startY) * eased;
      const fade = 1 - progress; // fades out as it merges into the now-solidifying line
      ctx.beginPath();
      ctx.fillStyle = hexToRgba(p.color, fade * 0.9);
      ctx.arc(x, y, Math.max(0.2, p.size * fade), 0, Math.PI * 2);
      ctx.fill();
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

  // ---- scratch-gesture tuning ----
  // A fast horizontal drag reads as "scratching a record": a global phase
  // jolt applied once to every displacement term at once (not a per-point
  // effect like the spring pull), decaying fast so it feels percussive
  // rather than a slow fade. Visual only — no AudioBufferSourceNode
  // playbackRate manipulation, which risks sounding broken and wasn't
  // asked for.
  const SCRATCH_VELOCITY_SCALE = 0.14; // px/ms -> normalized energy
  const SCRATCH_MAX_ENERGY = 1;
  const SCRATCH_DECAY_HZ = 6; // fast exponential decay = percussive, not a fade
  const SCRATCH_PHASE_KICK_MS = 900; // phase offset (ms-equivalent) at full energy
  const SCRATCH_MIN_DRAG_PX = 3; // ignore touch/mouse jitter noise

  let scratchEnergy = 0;
  let scratchDirection = 1;
  let scratchPhaseOffsetMs = 0; // recomputed once/frame in draw(), read by displacement()

  function ensureSpringArrays() {
    if (springY.length !== pointCount + 1) {
      springY = new Array(pointCount + 1).fill(0);
      springVY = new Array(pointCount + 1).fill(0);
    }
  }

  function stepPhysics(t, bands, dtSec) {
    const dt = Math.min(dtSec, MAX_DT);
    const R = pointerRadius();
    const active = pointers.size ? Array.from(pointers.values()) : null;

    for (let i = 0; i <= pointCount; i++) {
      const u = i / pointCount;
      const x = u * width;

      let target = 0;
      if (active) {
        const naturalY = height / 2 + displacement(u, t, bands, 0, 1);
        // Multiple simultaneous touches: each line-point picks up whichever
        // pointer pulls it *hardest* (nearest), not the sum of all of them —
        // summing could stack unboundedly where two fingers' fields
        // overlap; nearest-wins keeps every touch visually independent
        // while bounding displacement to what one pointer already produces.
        for (let p = 0; p < active.length; p++) {
          const dx = active[p].x - x;
          const dy = active[p].y - naturalY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < R) {
            const falloff = 1 - dist / R;
            const candidate = dy * falloff * falloff * PULL_STRENGTH;
            if (Math.abs(candidate) > Math.abs(target)) target = candidate;
          }
        }
      }

      // Guard against an out-of-sync springY/springVY the same way
      // tracePath/capturePoints do (see their own comment) — the spring
      // integrator writes back into these arrays every frame, so an
      // undefined here wouldn't just be transient: it'd turn to NaN once
      // and then stay NaN forever, since NaN + anything is still NaN.
      const curY = springY[i] || 0;
      const curVY = springVY[i] || 0;
      const accel = SPRING_K * (target - curY) - SPRING_C * curVY;
      springVY[i] = curVY + accel * dt;
      springY[i] = curY + springVY[i] * dt;
    }
  }

  // Scratch energy decays once per frame (not per line-point — same
  // discipline as globalScale/wakeProgress being computed once and reused).
  function updateScratch(dt) {
    scratchEnergy *= Math.exp(-SCRATCH_DECAY_HZ * dt); // frame-rate-independent exponential decay
    scratchPhaseOffsetMs = scratchEnergy * scratchDirection * SCRATCH_PHASE_KICK_MS;
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

  // key: 'mouse' for the mouse, or a Touch's `identifier` for a finger.
  function setPointer(key, x, y) {
    // Scratch velocity: derived from consecutive samples of the *same*
    // key, so a two-finger drag doesn't read velocity across two different
    // fingers' positions. Skipped entirely under reduced motion — this is
    // a much more dramatic, transient effect than the smooth spring pull,
    // so it gets the stricter treatment (same category as the rave-burst
    // animation being skipped outright, not toned down).
    if (!prefersReducedMotion()) {
      const now = performance.now();
      const prev = pointerHistory.get(key);
      if (prev) {
        const dt = Math.max(1, now - prev.ts);
        const dx = x - prev.x;
        if (Math.abs(dx) > SCRATCH_MIN_DRAG_PX) {
          const vx = dx / dt; // px/ms
          const instantEnergy = Math.min(SCRATCH_MAX_ENERGY, Math.abs(vx) * SCRATCH_VELOCITY_SCALE);
          // Only ever raises energy here; updateScratch()'s per-frame decay
          // is the only thing that lowers it — keeps a fast flick from
          // getting diluted by a slower sample landing right after it.
          if (instantEnergy > scratchEnergy) {
            scratchEnergy = instantEnergy;
            scratchDirection = Math.sign(vx) || scratchDirection;
          }
        }
      }
      pointerHistory.set(key, { x, y, ts: now });
    }
    pointers.set(key, { x, y });
  }

  function clearPointer(key) {
    pointers.delete(key);
    pointerHistory.delete(key);
  }

  function bindPointerEvents() {
    // window-level, not canvas-level: mouse/touch events still bubble up to
    // window even when the topmost element under the cursor is a button
    // (entry hint, mute, theme toggle), so the distortion field stays live
    // over UI.
    window.addEventListener('mousemove', (e) => setPointer('mouse', e.clientX, e.clientY));
    window.addEventListener('mouseleave', () => clearPointer('mouse'));

    window.addEventListener(
      'touchstart',
      (e) => {
        for (const touch of e.touches) setPointer(touch.identifier, touch.clientX, touch.clientY);
      },
      { passive: true }
    );
    window.addEventListener(
      'touchmove',
      (e) => {
        for (const touch of e.touches) setPointer(touch.identifier, touch.clientX, touch.clientY);
      },
      { passive: true }
    );
    // changedTouches, not touches: touches lists every finger still down,
    // so clearing all of *those* on one finger lifting would wrongly drop
    // every other finger still touching the screen.
    const releaseHandler = (e) => {
      for (const touch of e.changedTouches) clearPointer(touch.identifier);
    };
    window.addEventListener('touchend', releaseHandler, { passive: true });
    window.addEventListener('touchcancel', releaseHandler, { passive: true });
  }

  function init() {
    canvas = document.getElementById('wave-canvas');
    ctx = canvas.getContext('2d');
    readColorTokens();
    resize();
    window.addEventListener('resize', onResize);
    bindPointerEvents();
  }

  // Concept spec: before the first interaction the site is 'sleeping' — the
  // wave should barely move, not breathe at full amplitude.
  const SLEEP_SCALE = 0.12;

  // Settled spec: once the reveal sequence lands and mix eases to 1, the
  // wave doesn't disappear, it recedes to a dim, quiet backdrop behind the
  // readable panel — same idea as SLEEP_SCALE, just the *other* end of the
  // mix axis instead of a one-time pre-interaction state.
  const BUSINESS_SCALE = 0.32;

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // Classic ease-out-expo, evaluated in JS so the canvas amplitude ramp can
  // follow the same "fast start, long settle" character as the CSS token
  // --ease-out-expo used for the entry-screen fade — not a byte-for-byte
  // match (that would need a full cubic-bezier solver for one moment), just
  // the same *feel*, so the wake reads as one coordinated motion.
  function easeOutExpo(x) {
    return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x);
  }

  // Glow pulse: the glow layer breathes with live bass instead of sitting
  // at a fixed width/alpha — bass hits now read as a visible "swell" in
  // the light around the line, not just a shape change. Scaled by
  // globalScale too (not just bands.bass) so a stray band value can't pop
  // the glow while sleeping or mid-dissolve, when globalScale is near 0.
  const GLOW_BASE_WIDTH = 8;
  const GLOW_BASS_WIDTH_GAIN = 10;
  const GLOW_BASE_ALPHA = 0.18;
  const GLOW_BASS_ALPHA_GAIN = 0.22;
  const GLOW_MAX_ALPHA = 0.5; // clamp so a hot bass hit can't wash out the main line

  // Secret "rave burst": a long-press on the artist name (wired in the
  // bottom IIFE, no visible affordance — see triggerRaveBurst's own call
  // site) triggers a few seconds of exaggerated amplitude + a cycling
  // main-line/glow color, then eases back. Undiscoverable by design,
  // matching the "obscure, rare" brand language already established
  // elsewhere in this file's comments.
  const RAVE_DURATION_MS = 4000;
  const RAVE_AMP_BOOST = 2.2; // peak globalScale multiplier
  const RAVE_ATTACK_MS = 300;
  const RAVE_RELEASE_MS = 700;
  const RAVE_CYCLE_SPEED = 0.008; // color-cycle angular speed, ms^-1
  const RAVE_FLASH_MS = 900; // reduced-motion fallback duration

  let raveActive = false;
  let raveStartTs = null;
  // Reduced motion never runs the amplitude/color animation (consistent
  // with pause()'s precedent of skipping dramatic transient effects
  // outright rather than a toned-down variant) — instead, a single
  // instant, non-animated color swap: a state change, not motion, so the
  // easter egg still rewards discovery without introducing motion.
  let raveFlash = false;
  let raveFlashStartTs = null;

  function triggerRaveBurst() {
    if (paused || raveActive) return;
    if (prefersReducedMotion()) {
      raveFlash = true;
      raveFlashStartTs = performance.now();
      return;
    }
    raveActive = true;
    raveStartTs = performance.now();
  }

  // 0..1 envelope: eases in (RAVE_ATTACK_MS), holds, eases out
  // (RAVE_RELEASE_MS) — reuses easeOutExpo rather than a new curve, same
  // signature motion as the wake sequence. nowTs must be real time (like
  // pause()'s nowTs), not the possibly-frozen effectiveT.
  function raveEnvelope(nowTs) {
    if (!raveActive) return 0;
    const elapsed = nowTs - raveStartTs;
    if (elapsed >= RAVE_DURATION_MS) {
      raveActive = false;
      return 0;
    }
    if (elapsed < RAVE_ATTACK_MS) return easeOutExpo(elapsed / RAVE_ATTACK_MS);
    const releaseStart = RAVE_DURATION_MS - RAVE_RELEASE_MS;
    if (elapsed > releaseStart) return 1 - easeOutExpo((elapsed - releaseStart) / RAVE_RELEASE_MS);
    return 1;
  }

  // The normal 4-layer stack (2 echoes + glow + main), shared between the
  // regular awake/sleeping path and the dormant post-dissolve state — both
  // are just "the wave at some globalScale", the only difference is what
  // scale and whether it's driven by live audio. raveMix (0..1) is the
  // rave-burst envelope, if any is active — it only tints the glow and
  // main line (echoes stay on the normal fg-based colors, keeping the
  // burst readable instead of noisy), and only as local variables here,
  // never written back into the module's cached color.fg/color.accent.
  function drawLayers(t, bands, globalScale, raveMix, raveStatic) {
    tracePath(t, bands, -420, 0.72, 10, globalScale);
    ctx.strokeStyle = hexToRgba(color.fg, 0.08);
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    tracePath(t, bands, -220, 0.85, 5, globalScale);
    ctx.strokeStyle = hexToRgba(color.fg, 0.16);
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Glow: one wide, low-alpha stroke under the main line — the cheap
    // alternative to setting shadowBlur every frame.
    const glowPulse = bands.bass * globalScale;
    const glowAlpha = Math.min(GLOW_MAX_ALPHA, GLOW_BASE_ALPHA + glowPulse * GLOW_BASS_ALPHA_GAIN);
    let glowStroke = hexToRgba(color.accent, glowAlpha);
    let mainStroke = color.fg;
    if (raveMix > 0) {
      // Static flash (reduced motion): hold one fixed blend, no oscillation
      // — a color swap is a state change, not motion.
      const cyclePos = raveStatic ? 0.5 : (Math.sin(t * RAVE_CYCLE_SPEED) + 1) / 2; // 0..1
      const glowRgb = mixHex(color.accent, color.selection, raveMix * cyclePos);
      const mainRgb = mixHex(color.fg, color.selection, raveMix * (1 - cyclePos));
      glowStroke = rgbaCss(glowRgb, Math.min(1, glowAlpha + raveMix * 0.5)); // brighter, still not fully solid
      mainStroke = rgbaCss(mainRgb, 1);
    }

    tracePath(t, bands, 0, 1, 0, globalScale);
    ctx.strokeStyle = glowStroke;
    ctx.lineWidth = (GLOW_BASE_WIDTH + glowPulse * GLOW_BASS_WIDTH_GAIN) * (1 + raveMix); // wider halo mid-burst
    ctx.lineJoin = 'round';
    ctx.stroke();

    tracePath(t, bands, 0, 1, 0, globalScale);
    ctx.strokeStyle = mainStroke;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // Pause ("mute" doubles as pause): freezes the wave at its last rendered
  // shape, then that shape dissolves into particles and scatters — rather
  // than continuing to animate to music the visitor can no longer hear
  // (which is what happened before: gain sat downstream of the analyser,
  // see AudioEngine.loadBuffer — fixed there, this is the dramatic,
  // guaranteed-instant version of "stop reacting" on top of that fix).
  // Deliberately independent of the settle tween's mix value: easing
  // toward the settled state dims the wave smoothly (see draw()'s
  // BUSINESS_SCALE blend below), it never triggers this dissolve — that
  // stays a hard, unambiguous "silenced" signal reserved for the mute
  // button.
  // nowTs must be the same clock as the `t` passed to draw() (i.e.
  // performance.now()/rAF timestamps), not an "effective" (possibly
  // reduced-motion-frozen) time — the burst's own duration always runs in
  // real time regardless of that.
  function pause(nowTs) {
    if (paused) return;
    paused = true;
    // A burst mid-mute shouldn't leave dangling state that resumes
    // strangely on unmute (dormant redraw already ignores rave entirely,
    // but this keeps raveActive/raveFlash from re-surfacing at all).
    raveActive = false;
    raveFlash = false;
    frozenPoints = capturePoints(lastT, lastBands, lastGlobalScale);
    dissolveWallStartMs = Date.now();
    if (prefersReducedMotion()) {
      // Skip the burst entirely — jump straight to the dormant state next
      // frame — rather than still playing a ~700ms transition.
      dissolveStartTs = nowTs - DISSOLVE_DURATION_S * 1000 - 1;
      particles = [];
    } else {
      dissolveStartTs = nowTs;
      spawnDissolveParticles(frozenPoints);
    }
  }

  // Shared by wake() and resume() below — spawns the converging particles
  // and hands their target shape to draw()'s `assembling` branch, which
  // fades the line itself in alongside them.
  function beginAssemble(nowTs, targetPoints) {
    assembling = true;
    assembleStartTs = nowTs;
    assembleWallStartMs = Date.now();
    assembleTargetPoints = targetPoints;
    spawnAssembleParticles(targetPoints);
  }

  // First-ever wake (main.js's beginExperience(), on the entry gesture):
  // the wave has never been drawn before this, so there's no "last shape"
  // to reassemble into — capture a fresh target at rest (silent bands,
  // SLEEP_SCALE) instead of reusing frozenPoints the way resume() does.
  function wake(nowTs) {
    if (prefersReducedMotion()) return; // no assemble flourish — draw() just starts live next frame
    beginAssemble(nowTs, capturePoints(0, { bass: 0, mid: 0, high: 0 }, SLEEP_SCALE));
  }

  function resume(nowTs) {
    paused = false;
    // Reassemble into the exact shape it dissolved from when there is one
    // (the normal case — mute always freezes a shape first) — a true
    // reverse of the dissolve, not just a generic "some wave shape".
    const targets = frozenPoints.length ? frozenPoints : capturePoints(lastT, lastBands, SLEEP_SCALE);
    particles = [];
    frozenPoints = [];
    dissolveStartTs = null;
    if (!prefersReducedMotion()) {
      beginAssemble(nowTs, targets);
    }
  }

  function draw(t, dt, bands, wakeProgress, mix = 0, awake = true) {
    // Reduced motion (Phase 6): freeze the time input to the shape math so
    // the idle-noise breathing and audio ripples stop animating on their
    // own — the wave becomes a static (but still organically-shaped, not a
    // flat line) curve. `dt` for the pointer spring is left untouched, so
    // direct interaction — user-initiated, not ambient motion — still
    // eases and settles normally; reduced motion targets automatic motion,
    // not a response to something the visitor is actively doing.
    const effectiveT = prefersReducedMotion() ? 0 : t;
    updateScratch(dt);

    ctx.clearRect(0, 0, width, height);

    if (paused) {
      const dissolveElapsed = dissolveStartTs !== null ? (t - dissolveStartTs) / 1000 : Infinity;
      // The wall-clock term is the STUCK_TRANSIENT_CEILING_MS safety valve
      // (see its own comment) — belt-and-suspenders alongside the `t`-based
      // check, which already self-heals correctly on its own for an
      // ordinary large time gap.
      const dissolveStuck = dissolveWallStartMs !== null && Date.now() - dissolveWallStartMs > STUCK_TRANSIENT_CEILING_MS;
      const dissolveActive = dissolveElapsed < DISSOLVE_DURATION_S && !dissolveStuck;

      if (dissolveActive) {
        const fade = 1 - dissolveElapsed / DISSOLVE_DURATION_S;
        ctx.beginPath();
        for (let i = 0; i < frozenPoints.length; i++) {
          const p = frozenPoints[i];
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.strokeStyle = hexToRgba(color.fg, fade);
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke();
      }

      updateAndDrawParticles(dt);

      // Settled: once the dissolve's actually finished, nothing more is
      // drawn — no lingering idle line left sitting there. stepPhysics
      // still runs so any pointer-spring offset decays cleanly instead of
      // freezing mid-interaction; it just has nothing left to visibly
      // affect until resume()'s assemble effect draws something again.
      if (!dissolveActive) {
        stepPhysics(effectiveT, bands, dt);
      }

      lastT = effectiveT;
      lastBands = bands;
      lastGlobalScale = SLEEP_SCALE;
      return;
    }

    if (assembling) {
      const assembleElapsed = (t - assembleStartTs) / 1000;
      // Same STUCK_TRANSIENT_CEILING_MS safety valve as the dissolve branch
      // above.
      const assembleStuck = assembleWallStartMs !== null && Date.now() - assembleWallStartMs > STUCK_TRANSIENT_CEILING_MS;
      if (assembleElapsed < ASSEMBLE_DURATION_S && !assembleStuck) {
        // The line solidifies (fades 0->1) at the same rate the particles
        // converge onto it — the reverse of the dissolve's frozen line
        // fading 1->0 while its particles scatter outward.
        const fade = assembleElapsed / ASSEMBLE_DURATION_S;
        ctx.beginPath();
        for (let i = 0; i < assembleTargetPoints.length; i++) {
          const p = assembleTargetPoints[i];
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.strokeStyle = hexToRgba(color.fg, fade);
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke();

        updateAndDrawAssembleParticles(dt);

        lastT = effectiveT;
        lastBands = bands;
        lastGlobalScale = SLEEP_SCALE;
        return;
      }
      // Just finished this frame — clear the flag and fall straight into
      // normal live drawing below instead of a blank frame in between.
      assembling = false;
      particles = [];
    }

    if (!awake) {
      // Dormant: nothing drawn until the first interaction triggers
      // wake()'s assemble effect above — no idle line sitting in the
      // background before that either. stepPhysics still runs for the
      // same reason as the settled-dissolve branch above.
      stepPhysics(effectiveT, bands, dt);
      lastT = effectiveT;
      lastBands = bands;
      lastGlobalScale = SLEEP_SCALE;
      return;
    }

    // Rave burst (see triggerRaveBurst): raveAmpMix drives the amplitude
    // boost (only while the full animated burst is actually running);
    // raveColorMix drives drawLayers' color cycle and is also nonzero
    // during the reduced-motion flash fallback, which never touches
    // amplitude. raveStatic tells drawLayers to hold one fixed blended
    // color instead of oscillating — the flash is a state change, not motion.
    let raveAmpMix = 0;
    let raveColorMix = 0;
    let raveStatic = false;
    if (raveActive) {
      raveAmpMix = raveEnvelope(t);
      raveColorMix = raveAmpMix;
    } else if (raveFlash) {
      if (t - raveFlashStartTs < RAVE_FLASH_MS) {
        raveColorMix = 1;
        raveStatic = true;
      } else {
        raveFlash = false;
      }
    }

    // wakeProgress is 0 while sleeping, ramps 0->1 over the wake sequence
    // (Phase 7), and stays 1 once fully awake — the wave visibly unfurls
    // from barely-moving to its mix-appropriate amplitude instead of
    // snapping. The unfurl's *target* isn't a flat 1: it's
    // lerp(1, BUSINESS_SCALE, mix) — mix stays 0 through the whole wake
    // ramp (main.js's tweenMixToOne() doesn't start until well after
    // wakeProgress has already reached 1, see startRevealSequence()), so
    // in practice the wave unfurls to full amplitude first and only eases
    // down afterward, but the formula holds either way.
    const wakeTarget = lerp(1, BUSINESS_SCALE, mix);
    const baseGlobalScale = SLEEP_SCALE + (wakeTarget - SLEEP_SCALE) * easeOutExpo(wakeProgress);
    // Rave burst (see triggerRaveBurst) multiplies on top of that
    // mix-appropriate base rather than a flat full-amplitude assumption —
    // a burst triggered near full-booking still boosts proportionally off
    // the dimmer, quieter base the fader currently implies, instead of
    // jumping to full-artist amplitude regardless of where the fader is.
    const globalScale = baseGlobalScale * (1 + raveAmpMix * (RAVE_AMP_BOOST - 1));
    lastT = effectiveT;
    lastBands = bands;
    lastGlobalScale = globalScale;

    stepPhysics(effectiveT, bands, dt);
    drawLayers(effectiveT, bands, globalScale, raveColorMix, raveStatic);
  }

  return {
    init,
    draw,
    refreshColors: readColorTokens,
    pause,
    resume,
    wake,
    // Test-only, zero runtime cost — mirrors the existing
    // window.diskevichDebug.mobileMode getter pattern.
    get pointerCount() {
      return pointers.size;
    },
    get scratchEnergy() {
      return scratchEnergy;
    },
    triggerRaveBurst,
    get raveActive() {
      return raveActive;
    },
    get assembling() {
      return assembling;
    },
  };
})();

/* --------------------------------------------------------------------------
   Orb (Phase 8)
   -----------------------------------------------------------------------
   A soft, bass-deforming background glow behind the wave — Three.js + a
   hand-written GLSL shader, vendored locally (vendor/three.module.js — see
   vendor/README.md). Sits one z-index below #wave-canvas (style.css), so
   the wave line always reads on top of it; fades with --mix via CSS, same
   idiom as everywhere else, no JS needed for that part.

   Vertex shader displaces an icosahedron along its own normals using a
   classic 3D simplex noise function (Ashima Arts / Stefan Gustavson's
   widely-used public implementation, MIT-licensed, hand-copied inline —
   small enough that vendoring a whole noise library for it isn't worth a
   second dependency) combined with the live uBass uniform. Fragment shader
   adds a Fresnel rim term tinted with the same --color-accent token Wave
   reads, so both accents stay visually in sync.

   No GSAP: AudioEngine.bands is already the exact EMA-smoothed "inertia"
   a tween library would add on top, so uBass is fed straight from it.
   Desktop-only + reduced-motion-gated (mirrors Cursor/Magnetic)
   and fails soft if a WebGL context can't be obtained at all — never
   throws into the bootstrap IIFE. Rendered from inside the existing
   frameLoop() (see render(), called next to Wave.draw()) rather than a
   second independent rAF loop, so it shares one frame clock and gets
   tab-hidden pause/resume for free via frameLoop's own
   stopLoop()/startLoop().
   -------------------------------------------------------------------------- */
const Orb = (() => {
  let renderer = null;
  let scene, camera, mesh, material;
  let ready = false;
  let clockStart = 0;

  const VERTEX_SHADER = `
    uniform float uTime;
    uniform float uBass;
    varying vec3 vNormal;
    varying vec3 vViewPosition;

    // --- Ashima Arts / Stefan Gustavson simplex noise (webgl-noise, MIT) ---
    vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
    vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

    float snoise(vec3 v) {
      const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
      const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
      vec3 i  = floor(v + dot(v, C.yyy));
      vec3 x0 = v - i + dot(i, C.xxx);
      vec3 g = step(x0.yzx, x0.xyz);
      vec3 l = 1.0 - g;
      vec3 i1 = min(g.xyz, l.zxy);
      vec3 i2 = max(g.xyz, l.zxy);
      vec3 x1 = x0 - i1 + C.xxx;
      vec3 x2 = x0 - i2 + C.yyy;
      vec3 x3 = x0 - D.yyy;
      i = mod289(i);
      vec4 p = permute(permute(permute(
                 i.z + vec4(0.0, i1.z, i2.z, 1.0))
               + i.y + vec4(0.0, i1.y, i2.y, 1.0))
               + i.x + vec4(0.0, i1.x, i2.x, 1.0));
      float n_ = 0.142857142857;
      vec3 ns = n_ * D.wyz - D.xzx;
      vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
      vec4 x_ = floor(j * ns.z);
      vec4 y_ = floor(j - 7.0 * x_);
      vec4 x = x_ * ns.x + ns.yyyy;
      vec4 y = y_ * ns.x + ns.yyyy;
      vec4 h = 1.0 - abs(x) - abs(y);
      vec4 b0 = vec4(x.xy, y.xy);
      vec4 b1 = vec4(x.zw, y.zw);
      vec4 s0 = floor(b0) * 2.0 + 1.0;
      vec4 s1 = floor(b1) * 2.0 + 1.0;
      vec4 sh = -step(h, vec4(0.0));
      vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
      vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
      vec3 p0 = vec3(a0.xy, h.x);
      vec3 p1 = vec3(a0.zw, h.y);
      vec3 p2 = vec3(a1.xy, h.z);
      vec3 p3 = vec3(a1.zw, h.w);
      vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
      p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
      vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
      m = m * m;
      return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
    }

    // Displacement amount for a given (unit-length) direction off the sphere —
    // a separate function, not inlined into main(), because the normal
    // recomputation below needs to re-sample it at neighboring points.
    float displacement(vec3 dir) {
      float n = snoise(dir * 1.1 + vec3(0.0, 0.0, uTime * 0.1));
      // Gentle undulation, not spikes: at radius 1 this tops out around
      // ~20% of the radius even at full bass — tuned down hard from an
      // initial pass that read as a jagged crystal/starburst rather than a
      // soft glowing orb (see main.js git history/PR discussion).
      return n * (0.035 + uBass * 0.16);
    }

    void main() {
      vec3 n = normal;
      vec3 pos = position + n * displacement(n);

      // Recompute the normal from the *displaced* surface via a finite-
      // difference tangent frame, rather than reusing the original sphere's
      // normal. With any non-trivial displacement, the stale sphere normal
      // stops matching the actual surface and the Fresnel term in the
      // fragment shader below reads as flat, faceted shading instead of a
      // smooth glow.
      vec3 tangent = normalize(cross(n, abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
      vec3 bitangent = normalize(cross(n, tangent));
      float eps = 0.01;
      vec3 nT = normalize(n + tangent * eps);
      vec3 nB = normalize(n + bitangent * eps);
      vec3 posT = position + tangent * eps + nT * displacement(nT);
      vec3 posB = position + bitangent * eps + nB * displacement(nB);
      vec3 displacedNormal = normalize(cross(posT - pos, posB - pos));
      if (dot(displacedNormal, n) < 0.0) displacedNormal = -displacedNormal; // keep it outward-facing

      vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
      vViewPosition = -mvPosition.xyz;
      vNormal = normalize(normalMatrix * displacedNormal);
      gl_Position = projectionMatrix * mvPosition;
    }
  `;

  const FRAGMENT_SHADER = `
    uniform vec3 uColor;
    uniform float uOpacity;
    varying vec3 vNormal;
    varying vec3 vViewPosition;

    void main() {
      vec3 viewDir = normalize(vViewPosition);
      // Higher power + a lower base fill than a first pass: reads as a rim
      // of light around the silhouette with a mostly-transparent center,
      // rather than a solid faceted shape — "glow", not "material".
      float fresnel = pow(1.0 - max(dot(normalize(vNormal), viewDir), 0.0), 2.6);
      vec3 color = uColor * (0.06 + fresnel * 1.2);
      gl_FragColor = vec4(color, fresnel * uOpacity);
    }
  `;

  function readColor() {
    const hex = (getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() || '#c97a3d').replace(
      '#',
      ''
    );
    const h = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
    const n = parseInt(h, 16);
    return new THREE.Color(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }

  function refreshColors() {
    if (!material) return;
    material.uniforms.uColor.value.copy(readColor());
  }

  function resize() {
    if (!renderer) return;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2); // same DPR cap as Wave.resize()
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false); // false: leave canvas.style sizing to CSS (100%)
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  let resizeTimer = null;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 120); // debounced, same as Wave.onResize()
  }

  function init() {
    if (mobileMode || prefersReducedMotion()) return;
    const canvas = document.getElementById('orb-canvas');
    if (!canvas) return;

    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    } catch (err) {
      // No WebGL (old browser, disabled at the OS/driver level, etc.) — fail
      // soft exactly like AudioEngine.preload()'s own audioUnavailable path.
      console.warn('[diskevich] Orb: WebGL unavailable, skipping the 3D accent.', err);
      renderer = null;
      return;
    }
    renderer.setClearColor(0x000000, 0); // transparent — the page's own background shows through

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 20);
    // Distance tuned so the orb reads as a background accent behind the
    // wave (roughly a third of viewport height), not a hero element — an
    // initial pass at z=3.4 filled ~70% of the screen and fought the wave
    // for attention instead of sitting quietly behind it.
    camera.position.z = 7.5;

    material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        uTime: { value: 0 },
        uBass: { value: 0 },
        uColor: { value: readColor() },
        uOpacity: { value: 0.85 },
      },
      transparent: true,
      depthWrite: false,
      // Additive, not normal alpha blending: normal blending against the
      // *light* theme's near-white background made the Fresnel rim read as
      // a solid, hard-edged pale disc with a dark outline — the opposite of
      // "glow". Additive blending only ever brightens what's already there
      // (and clips harmlessly toward white near a light background instead
      // of drawing a visible edge), so the same shader reads as a warm glow
      // in both themes instead of needing separate tuning for each.
      blending: THREE.AdditiveBlending,
    });
    mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 5), material);
    scene.add(mesh);

    // Defensive touch (matches the codebase's fail-soft style elsewhere):
    // a lost context would otherwise make render() below throw every frame.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      ready = false;
    });

    resize();
    window.addEventListener('resize', onResize);
    clockStart = performance.now();
    ready = true;
  }

  // Called from frameLoop(), right alongside Wave.draw() — see that call's
  // own try/catch for why a throw here must never be allowed to repeat
  // silently forever. Mirrors Wave.draw()'s own `!awake` branch: nothing
  // is ever rendered pre-interaction (the canvas simply stays untouched,
  // i.e. fully transparent) so the orb appears as part of the same wake
  // moment as the wave, rather than sitting there from first paint.
  function render(ts, bands, awake) {
    if (!ready || !awake) return;
    material.uniforms.uTime.value = (ts - clockStart) / 1000;
    material.uniforms.uBass.value = bands.bass;
    mesh.rotation.y += 0.0016;
    mesh.rotation.x += 0.0007;
    renderer.render(scene, camera);
  }

  return { init, render, refreshColors };
})();

/* --------------------------------------------------------------------------
   Cursor (Phase 7)
   -----------------------------------------------------------------------
   A small dot that follows the pointer and grows into a ring over anything
   clickable — reinforces "this is interactive" precisely where the design
   otherwise has almost no conventional affordances (no buttons-that-look-
   like-buttons, no underlines except the dates-trigger/social links). Fine-
   pointer devices only: touch has no hover state and the OS cursor is
   already correct there, so this stays out of mobileMode's way entirely.
   Position updates via CSS transform (compositor-only, not layout) with a
   short transition for a touch of trailing lag rather than a robotic 1:1
   snap; that transition duration is the shared --dur-fast token, so it
   goes to 0 automatically under prefers-reduced-motion like everything else.
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
      const overInteractive = !!(e.target && e.target.closest && e.target.closest('button, a, input'));
      dot.classList.toggle('cursor-dot--active', overInteractive);
    });
    window.addEventListener('mouseleave', () => dot.classList.add('cursor-dot--hidden'));
    window.addEventListener('mouseenter', () => dot.classList.remove('cursor-dot--hidden'));
  }

  return { init };
})();

/* --------------------------------------------------------------------------
   Magnetic
   -----------------------------------------------------------------------
   Extends the wave's own "things lean toward the pointer" language to the
   rest of the interface: the mute/theme toggles, the social-link icons,
   and the dates-trigger link ([data-magnetic] on each) nudge a few px
   toward a nearby cursor instead of sitting inert until directly hovered.
   Desktop/fine-pointer only, same gate as Cursor — there's no "nearby" on
   a touchscreen. Pointer-only by design: a keyboard-focused element must never carry a stale
   mouse-driven offset, so focusin explicitly resets it (this is also why
   the pull itself is plain CSS transform + transition rather than a JS
   spring loop like the wave's — a keyframe-free transition is trivial to
   snap back to zero).
   -------------------------------------------------------------------------- */
const Magnetic = (() => {
  const MAGNETIC_RADIUS = 90; // px from element center where the pull begins
  const MAGNETIC_STRENGTH = 0.35; // fraction of offset applied at zero distance
  const MAGNETIC_MAX_OFFSET = 14; // px cap — a nudge, not a jump
  const REST_TRANSFORM = 'none';

  let elements = [];
  let mouseX = -9999;
  let mouseY = -9999;
  let rafPending = false;

  function isEligible(el) {
    // Skip anything sitting inside the still-inert deck-b-panel (mix below
    // the reveal threshold, see main.js's applyMix()) — inert already
    // blocks pointer/keyboard interaction with it, so a magnetic nudge
    // there would be pulling something the visitor can't actually reach yet.
    return !el.closest('[inert]');
  }

  function applyPull() {
    rafPending = false;
    for (const el of elements) {
      if (!isEligible(el)) {
        el.style.transform = REST_TRANSFORM;
        continue;
      }
      const rect = el.getBoundingClientRect();
      const dx = mouseX - (rect.left + rect.width / 2);
      const dy = mouseY - (rect.top + rect.height / 2);
      const dist = Math.hypot(dx, dy);
      if (dist < MAGNETIC_RADIUS) {
        const falloff = 1 - dist / MAGNETIC_RADIUS;
        const pull = falloff * falloff * MAGNETIC_STRENGTH; // quadratic, echoes Wave's pointer falloff
        const ox = Math.max(-MAGNETIC_MAX_OFFSET, Math.min(MAGNETIC_MAX_OFFSET, dx * pull));
        const oy = Math.max(-MAGNETIC_MAX_OFFSET, Math.min(MAGNETIC_MAX_OFFSET, dy * pull));
        el.style.transform = `translate(${ox.toFixed(1)}px, ${oy.toFixed(1)}px)`;
      } else {
        el.style.transform = REST_TRANSFORM;
      }
    }
  }

  function onMouseMove(e) {
    mouseX = e.clientX;
    mouseY = e.clientY;
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(applyPull);
    }
  }

  function init() {
    if (mobileMode) return;
    elements = Array.from(document.querySelectorAll('[data-magnetic]'));
    if (!elements.length) return;

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseleave', () => {
      elements.forEach((el) => (el.style.transform = REST_TRANSFORM));
    });
    // Pointer pull is a pointer-only enhancement — keyboard Tab must land
    // on the element at its natural rest position, under its normal
    // :focus-visible ring, never mid-nudge from a stale mousemove.
    window.addEventListener('focusin', (e) => {
      const el = e.target && e.target.closest && e.target.closest('[data-magnetic]');
      if (el) el.style.transform = REST_TRANSFORM;
    });
  }

  return { init };
})();

/* -------------------------------------------------------------------------- */

(() => {
  const body = document.body;
  const html = document.documentElement;
  const deckBPanel = document.getElementById('deck-b-panel');
  const muteToggle = document.getElementById('mute-toggle');
  const themeToggle = document.getElementById('theme-toggle');
  const entryHint = document.getElementById('entry-hint');
  const datesTrigger = document.getElementById('dates-trigger');
  const datesDialog = document.getElementById('dates-dialog');
  const datesDialogClose = document.getElementById('dates-dialog-close');

  // Start loading/generating audio once the page has painted and settled
  // (Phase 6: keeps the — possibly chunky, especially for the synthetic
  // placeholder loop — decode/generate work off the critical initial-paint
  // path) rather than at parse time, but still well ahead of the first
  // interaction so the wake moment has no perceptible lag.
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
  Orb.init(); // no-ops internally on mobile / reduced-motion / no WebGL
  Cursor.init();
  Magnetic.init();

  // Wake sequence (Phase 7): one duration drives all three parts of the
  // reveal — the sleeping-state CSS, the wave's amplitude ramp, and the
  // audio fade-in — so they read as one coordinated 1.5s moment instead of
  // three unrelated timings that happen to overlap. Read from the CSS
  // token rather than re-declaring 1500 here, so there's exactly one
  // source of truth. Floored at 300ms: if prefers-reduced-motion was
  // active at page load, --dur-wake reads as 0ms (per the Phase 0 token
  // override) — harmless on its own since the ramp is skipped entirely
  // whenever reduced motion is active at interaction time (see
  // beginExperience below), but this keeps the captured constant itself
  // safe to use (no divide-by-zero) for the edge case of someone switching
  // the OS setting off between load and first interaction.
  const WAKE_DURATION_MS = Math.max(
    300,
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-wake')) || 1500
  );
  let wakeStartTs = null;

  /* --------------------------------------------------------------------
     Reveal & settle — the site's one continuous "mix" value
     -----------------------------------------------------------------
     --mix (0..1) drives the legibility scrim, the orb's fade, and Wave's
     amplitude ceiling (see style.css and Wave.draw()'s BUSINESS_SCALE
     blend) — same three consumers the old crossfader drove, but no longer
     scrubbed by a drag/scroll gesture. It's a one-shot value now: 0 while
     the wave is fully awake and energetic, tweened up to 1 by
     tweenMixToOne() once startRevealSequence() (below) has finished
     staggering the wordmark/bio/links in, so the wave visibly settles
     down right as the text finishes landing.
     -------------------------------------------------------------------- */
  let mix = 0;
  let entryStarted = false;

  function setMixVisual(value) {
    mix = value;
    html.style.setProperty('--mix', mix.toFixed(4));
  }

  function easeOutExpo(x) {
    return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x);
  }

  const MIX_TWEEN_DURATION_MS = 1800; // a touch longer than WAKE_DURATION_MS — settling reads as unhurried, not rushed

  function tweenMixToOne() {
    if (prefersReducedMotion()) {
      setMixVisual(1);
      return;
    }
    const startMix = mix;
    const startTs = performance.now();
    function tick(ts) {
      const t = Math.min(1, (ts - startTs) / MIX_TWEEN_DURATION_MS);
      setMixVisual(startMix + (1 - startMix) * easeOutExpo(t));
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  const REVEAL_GROUP_SELECTORS = ['.mark', '.bio-text', '.links-group'];
  const REVEAL_STEP_DELAY_MS = 700; // comfortably longer than each fade's own --dur-medium
  const MIX_TWEEN_DELAY_MS = 500; // one beat of stillness after the last group lands, before the wave starts settling

  // Staggers the wordmark, bio, and links in one at a time, then hands off
  // to tweenMixToOne() once they've all landed. Called once, from
  // beginExperience() below.
  function startRevealSequence() {
    const groups = REVEAL_GROUP_SELECTORS.map((sel) => deckBPanel.querySelector(sel)).filter(Boolean);

    // Flip once, here, not per child — the panel becomes meaningfully
    // present the moment the sequence begins and never goes back (there's
    // no drag gesture left that could scrub it back below some threshold).
    deckBPanel.removeAttribute('inert');
    deckBPanel.setAttribute('aria-hidden', 'false');

    if (prefersReducedMotion()) {
      groups.forEach((el) => el.classList.add('is-revealed'));
      tweenMixToOne();
      return;
    }

    groups.forEach((el, i) => {
      setTimeout(() => el.classList.add('is-revealed'), WAKE_DURATION_MS + i * REVEAL_STEP_DELAY_MS);
    });
    const lastStepStart = WAKE_DURATION_MS + (groups.length - 1) * REVEAL_STEP_DELAY_MS;
    setTimeout(tweenMixToOne, lastStepStart + MIX_TWEEN_DELAY_MS);
  }

  async function beginExperience() {
    if (entryStarted) return;
    entryStarted = true;
    entryHint.disabled = true;
    // Must be the very first thing that happens, synchronously, before any
    // await — see AudioEngine.unlock()'s own comment for why.
    if (!prefersReducedMotion()) {
      AudioEngine.unlock();
    }
    body.dataset.state = 'awake';
    wakeStartTs = performance.now();
    // Reverse-dissolve: the wave was drawing nothing at all up to this
    // point (see Wave.draw()'s `!awake` branch) — this is what makes it
    // appear at all, particles converging into the line rather than it
    // just snapping into existence. No-ops under reduced motion (see
    // Wave.wake()'s own check) — the very next frame just starts live.
    // Own try/catch, deliberately separate from AudioEngine.start() below:
    // this function is async and never awaited by its click/pointerdown
    // caller, so an uncaught throw here would silently reject the whole
    // function's promise and skip everything after it — including
    // starting the actual music, which matters far more than the visual
    // flourish does. The two must be able to fail independently.
    try {
      Wave.wake(wakeStartTs);
    } catch (err) {
      console.error('[diskevich] Wave.wake() threw — audio still starts below.', err);
    }
    // Self-scheduled off WAKE_DURATION_MS rather than chained onto
    // AudioEngine.start()'s promise below — that promise resolves once
    // playback *starts*, not once the fade-in ramp has *finished*, so it's
    // not a reliable "the wake moment is visually complete" signal.
    startRevealSequence();
    // Reduced motion (Phase 6): leave the sleeping state, but don't start
    // audio — nothing here should autoplay for these visitors.
    if (!prefersReducedMotion()) {
      await AudioEngine.start(WAKE_DURATION_MS);
    }
  }

  // The site's only entry gesture: tap/click anywhere. #entry-hint is the
  // accessible, keyboard-reachable version — a real <button>, so Enter/
  // Space fire its native click, no separate keydown handler needed. The
  // page-wide pointerdown/touchstart listeners are the fallback for a tap
  // landing anywhere else. All three call the same idempotent
  // beginExperience(), so whichever fires first wins. Clicking the
  // always-visible theme toggle while still asleep will, correctly, both
  // flip the theme *and* trigger entry — that's the intended reading of
  // "tap anywhere", not a bug to special-case around.
  entryHint.addEventListener('click', beginExperience);
  window.addEventListener('pointerdown', beginExperience, { once: true });
  window.addEventListener('touchstart', beginExperience, { passive: true, once: true });

  // Tour dates dialog. Native <dialog>/showModal() handles focus-trapping
  // and Esc-to-close on its own — the only custom bit needed is closing on
  // a backdrop click, i.e. a click landing on the dialog element itself
  // (its box extends out to the backdrop) rather than on anything inside it.
  datesTrigger.addEventListener('click', () => datesDialog.showModal());
  datesDialogClose.addEventListener('click', () => datesDialog.close());
  datesDialog.addEventListener('click', (e) => {
    if (e.target === datesDialog) datesDialog.close();
  });

  muteToggle.addEventListener('click', () => {
    const muted = AudioEngine.toggleMute();
    muteToggle.setAttribute('aria-pressed', String(muted));
    body.dataset.muted = String(muted);

    // Mute doubles as pause for the wave, not just the speakers: freeze +
    // dissolve into particles (then nothing) on mute; on unmute, Wave.resume()
    // plays that dissolve in reverse — particles reassembling into the
    // exact shape it dissolved from — before handing off to the same
    // wake-unfurl amplitude ramp the original wake uses.
    if (muted) {
      Wave.pause(performance.now());
    } else {
      wakeStartTs = performance.now();
      Wave.resume(wakeStartTs);
    }
  });

  // Theme toggle. data-theme is already set on <html> by the inline
  // head script (saved choice -> system preference -> dark), before
  // first paint; this just reflects that into aria-pressed and handles
  // switching it. A manual choice here always wins from this point on
  // and persists across visits — it does not keep following the OS
  // setting if that changes later, which is the standard, expected
  // behavior once someone has explicitly picked a theme.
  themeToggle.setAttribute('aria-pressed', String(html.getAttribute('data-theme') === 'light'));

  themeToggle.addEventListener('click', () => {
    const next = html.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    html.setAttribute('data-theme', next);
    themeToggle.setAttribute('aria-pressed', String(next === 'light'));
    try {
      localStorage.setItem('diskevich-theme', next);
    } catch (e) {
      // Private browsing / storage disabled: theme still applies for this
      // session, it just won't persist across visits.
    }
    // --color-fg / --color-accent just changed; Wave/Orb both cached them
    // at init and only re-read on demand, not every frame.
    Wave.refreshColors();
    Orb.refreshColors();
  });

  // Secret "rave burst": long-press on the artist name. No visible
  // affordance, no keyboard equivalent — .artist-name is a plain
  // non-interactive <h1>, so nothing keyboard-reachable is affected.
  // Pointer Events unify mouse+touch for this one-off addition even
  // though the rest of the file uses separate mouse/touch handlers —
  // simpler than duplicating press-and-hold logic for two input types.
  (() => {
    const RAVE_LONG_PRESS_MS = 1700;
    const RAVE_MOVE_CANCEL_PX = 24; // movement beyond this cancels the press
    const artistNameEl = document.querySelector('.artist-name');
    if (!artistNameEl) return;

    let pressTimer = null;
    let pressStart = null;

    function cancelPress() {
      clearTimeout(pressTimer);
      pressTimer = null;
      pressStart = null;
      artistNameEl.classList.remove('rave-pressing');
    }

    artistNameEl.addEventListener('pointerdown', (e) => {
      if (body.dataset.state !== 'awake') return;
      pressStart = { x: e.clientX, y: e.clientY };
      artistNameEl.classList.add('rave-pressing');
      pressTimer = setTimeout(() => {
        Wave.triggerRaveBurst();
        pressStart = null;
        artistNameEl.classList.remove('rave-pressing');
      }, RAVE_LONG_PRESS_MS);
    });
    artistNameEl.addEventListener('pointermove', (e) => {
      if (!pressStart) return;
      const moved = Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y);
      if (moved > RAVE_MOVE_CANCEL_PX) cancelPress();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((evt) => artistNameEl.addEventListener(evt, cancelPress));
  })();

  // Dev/debug access, zero runtime cost otherwise: window.diskevichAudio.bands
  // for live bass/mid/high, window.diskevichDebug.mobileMode / .mix to check
  // which branch is active and the current settle progress. (The old DJ_DEBUG
  // console logger and on-screen fps meter were removed in Phase 6.)
  window.diskevichAudio = AudioEngine;
  window.diskevichDebug = {
    get mobileMode() {
      return mobileMode;
    },
    get mix() {
      return mix;
    },
    get pointerCount() {
      return Wave.pointerCount;
    },
    get scratchEnergy() {
      return Wave.scratchEnergy;
    },
    get raveActive() {
      return Wave.raveActive;
    },
  };

  let lastTime = 0;
  let mobileFrameCounter = 0;
  let rafId = null;
  let lastSleepDrawTs = 0;
  let waveDrawErrorLogged = false; // see the try/catch around Wave.draw() in frameLoop
  let orbRenderErrorLogged = false; // see the try/catch around Orb.render() in frameLoop
  // Barely-moving content doesn't need 60fps: while sleeping (pre-
  // interaction), redraw only a few times a second instead of every frame.
  // Genuinely cheaper (near-zero CPU during however long the page sits
  // there untouched), and it keeps the pre-interaction screen visually
  // calmer.
  const SLEEP_REDRAW_INTERVAL_MS = 200;

  function frameLoop(ts) {
    rafId = requestAnimationFrame(frameLoop);
    const dt = lastTime ? ts - lastTime : 0;
    lastTime = ts;

    const awake = body.dataset.state === 'awake';
    if (!awake && ts - lastSleepDrawTs < SLEEP_REDRAW_INTERVAL_MS) return;
    lastSleepDrawTs = ts;

    // Wake sequence (Phase 7): 0 while sleeping, ramps 0->1 over
    // WAKE_DURATION_MS once entry is first triggered, 1 once fully
    // awake. Reduced motion jumps straight to the end state instead of
    // animating the ramp — a static wave shouldn't spend 1.5s visibly
    // growing its own amplitude, that's still ambient motion, just a
    // one-shot instead of a loop.
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
    // A throw here must never be allowed to blank the canvas forever: the
    // next requestAnimationFrame(frameLoop) call above is already
    // scheduled before this runs, so an uncaught exception on some
    // real-device edge case would otherwise repeat at the same point every
    // single frame — clearRect() runs, nothing after it does, with zero
    // visible sign to the visitor that anything's wrong. One bad frame
    // (logged, so it's diagnosable) beats a permanently invisible wave.
    try {
      Wave.draw(ts, dt / 1000, bands, wakeProgress, mix, awake);
    } catch (err) {
      if (!waveDrawErrorLogged) {
        waveDrawErrorLogged = true;
        console.error('[diskevich] Wave.draw() threw — recovering on next frame.', err);
      }
    }

    // Phase 8: micro-VU pulse (style.css's .mute-toggle rule reads this).
    // Only while awake — bands are naturally silent
    // beforehand anyway, so there's nothing meaningful to write. Mute-aware
    // for free: gain sits before the analyser (see AudioEngine.loadBuffer()),
    // so bands.bass already decays toward 0 on mute without any special-
    // casing here.
    if (awake) {
      html.style.setProperty('--band-bass', bands.bass.toFixed(3));
    }

    // Same try/catch-and-log-once shape as Wave.draw() above, for the same
    // reason: one bad frame (logged) beats a silently-repeating throw.
    try {
      Orb.render(ts, bands, awake);
    } catch (err) {
      if (!orbRenderErrorLogged) {
        orbRenderErrorLogged = true;
        console.error('[diskevich] Orb.render() threw — recovering on next frame.', err);
      }
    }
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
    if (document.hidden) {
      stopLoop();
    } else {
      startLoop();
      // iOS can suspend an already-unlocked AudioContext during
      // backgrounding with no event of its own to say so — see
      // AudioEngine.resumeIfSuspended()'s own comment. No-op if the
      // experience never started or audio's already running fine.
      if (entryStarted) {
        AudioEngine.resumeIfSuspended();
      }
    }
  });
  startLoop();
})();
