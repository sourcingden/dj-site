/* ==========================================================================
   diskevich — main.js

   Phase 0: skeleton wiring (tap-to-enter -> awake state).
   Phase 1: audio engine — AudioContext, AnalyserNode, bass/mid/high bands,
            mute, suspended-state handling, synthetic placeholder track.

   Crossfader: the tap-to-enter gate and the old bio/dates/booking
   nav+overlays are gone. A single range input (#crossfader-input) is now
   the site's only navigation — its value (mix, 0..1) drives both
   AudioEngine's gain and Wave's amplitude continuously, and is also the
   entry gesture (first interaction unlocks audio). See the bottom
   bootstrapping IIFE for the wiring, and AudioEngine.setMix() / Wave.draw()
   for how each side reads it.
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
   autoplays for these users: the crossfader still flips the site to
   'awake' on first interaction, but AudioEngine.start() is skipped.
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
   - setMix(): the crossfader's audio half. See currentTargetVolume().
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

  // Crossfader mix (0 = full artist deck, 1 = full booking deck). Volume is
  // just one axis of the same continuous blend Wave.draw() reads for the
  // visual side — see currentTargetVolume() below and main.js's bottom
  // bootstrapping IIFE, which is the only writer of this, via setMix().
  let mix = 0;

  const bands = { bass: 0, mid: 0, high: 0 };
  const SMOOTHING = 0.25; // EMA factor; retuned visually in Phase 2 if needed

  // Single source of truth for "what should the gain node actually be right
  // now" — used by loadBuffer()'s initial value, start()'s fade-in target,
  // toggleMute(), and setMix(), so none of them can drift out of sync with
  // each other. Mute always wins outright; otherwise volume is just 1-mix.
  function currentTargetVolume() {
    return muted ? 0 : 1 - mix;
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
  // be the *first* synchronous statement in the crossfader's first
  // pointerdown/keydown handler, so the resume call happens as close to
  // the raw gesture as possible; start() still does the real awaited setup
  // afterward.
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

  // Crossfader-driven volume (main.js's bottom IIFE calls this on every
  // 'input' event of the range fader). Same cancelScheduledValues +
  // setTargetAtTime smoothing as toggleMute() above, for the same reason —
  // a scrub mid-ramp shouldn't get stuck behind an earlier scheduled value.
  function setMix(newMix) {
    mix = Math.min(1, Math.max(0, newMix));
    if (gainNode && ctx) {
      gainNode.gain.cancelScheduledValues(ctx.currentTime);
      gainNode.gain.setTargetAtTime(currentTargetVolume(), ctx.currentTime, 0.05);
    }
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
    toggleMute,
    setMix,
    update,
    get bands() {
      return bands;
    },
    get isMuted() {
      return muted;
    },
    get mix() {
      return mix;
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

  // Pause/dissolve (mute -> "pause"): the most recently rendered frame's
  // inputs, cached so pause() — called from a click handler, not from
  // inside draw() — can freeze the *actual last-seen* shape rather than
  // recomputing something slightly different.
  let lastT = 0;
  let lastBands = { bass: 0, mid: 0, high: 0 };
  let lastGlobalScale = 1;
  let paused = false;
  let dissolveStartTs = null;
  let frozenPoints = [];
  let particles = [];
  const DISSOLVE_DURATION_S = 0.7;

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
        y: midY + (displacement(u, t, bands, 0, 1) + springY[i]) * globalScale,
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
    // (crossfader, mute, theme toggle), so the distortion field stays live
    // over UI.
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

  // Concept spec: before the first interaction the site is 'sleeping' — the
  // wave should barely move, not breathe at full amplitude.
  const SLEEP_SCALE = 0.12;

  // Crossfader spec: at full booking (mix=1) the wave doesn't disappear, it
  // recedes to a dim, quiet backdrop behind the readable panel — same idea
  // as SLEEP_SCALE, just the *other* end of a live, scrubbable axis instead
  // of a one-time pre-interaction state.
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

  // The normal 4-layer stack (2 echoes + glow + main), shared between the
  // regular awake/sleeping path and the dormant post-dissolve state — both
  // are just "the wave at some globalScale", the only difference is what
  // scale and whether it's driven by live audio.
  function drawLayers(t, bands, globalScale) {
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
    tracePath(t, bands, 0, 1, 0, globalScale);
    ctx.strokeStyle = hexToRgba(color.accent, 0.18);
    ctx.lineWidth = 8;
    ctx.lineJoin = 'round';
    ctx.stroke();

    tracePath(t, bands, 0, 1, 0, globalScale);
    ctx.strokeStyle = color.fg;
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
  // Deliberately independent of the crossfader's mix: dragging toward
  // booking dims the wave smoothly (see draw()'s BUSINESS_SCALE blend
  // below), it never triggers this dissolve — that stays a hard,
  // unambiguous "silenced" signal reserved for the mute button.
  // nowTs must be the same clock as the `t` passed to draw() (i.e.
  // performance.now()/rAF timestamps), not an "effective" (possibly
  // reduced-motion-frozen) time — the burst's own duration always runs in
  // real time regardless of that.
  function pause(nowTs) {
    if (paused) return;
    paused = true;
    frozenPoints = capturePoints(lastT, lastBands, lastGlobalScale);
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

  function resume() {
    paused = false;
    particles = [];
    frozenPoints = [];
    dissolveStartTs = null;
  }

  function draw(t, dt, bands, wakeProgress, mix = 0) {
    // Reduced motion (Phase 6): freeze the time input to the shape math so
    // the idle-noise breathing and audio ripples stop animating on their
    // own — the wave becomes a static (but still organically-shaped, not a
    // flat line) curve. `dt` for the pointer spring is left untouched, so
    // direct interaction — user-initiated, not ambient motion — still
    // eases and settles normally; reduced motion targets automatic motion,
    // not a response to something the visitor is actively doing.
    const effectiveT = prefersReducedMotion() ? 0 : t;

    ctx.clearRect(0, 0, width, height);

    if (paused) {
      const dissolveElapsed = dissolveStartTs !== null ? (t - dissolveStartTs) / 1000 : Infinity;
      const dissolveActive = dissolveElapsed < DISSOLVE_DURATION_S;

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

      if (!dissolveActive) {
        // Settled: the same barely-moving idle presentation as the
        // pre-interaction sleeping state — reads as "resting", not
        // "broken/empty". Bands are ~0 anyway once actually muted (gain
        // precedes the analyser), this just guarantees it regardless.
        // stepPhysics keeps running so any pointer-spring offset decays
        // cleanly rather than freezing mid-interaction.
        stepPhysics(effectiveT, bands, dt);
        drawLayers(effectiveT, bands, SLEEP_SCALE);
      }

      lastT = effectiveT;
      lastBands = bands;
      lastGlobalScale = SLEEP_SCALE;
      return;
    }

    // wakeProgress is 0 while sleeping, ramps 0->1 over the wake sequence
    // (Phase 7), and stays 1 once fully awake — the wave visibly unfurls
    // from barely-moving to its mix-appropriate amplitude instead of
    // snapping. The unfurl's *target* is no longer a flat 1 (Crossfader):
    // it's lerp(1, BUSINESS_SCALE, mix), so scrubbing the fader before the
    // wake ramp finishes still lands on the right amplitude, and scrubbing
    // afterward reshapes the wave live and continuously, with no separate
    // animation of its own — the crossfader IS the animation from then on.
    const wakeTarget = lerp(1, BUSINESS_SCALE, mix);
    const globalScale = SLEEP_SCALE + (wakeTarget - SLEEP_SCALE) * easeOutExpo(wakeProgress);
    lastT = effectiveT;
    lastBands = bands;
    lastGlobalScale = globalScale;

    stepPhysics(effectiveT, bands, dt);
    drawLayers(effectiveT, bands, globalScale);
  }

  return { init, draw, refreshColors: readColorTokens, pause, resume };
})();

/* --------------------------------------------------------------------------
   Cursor (Phase 7)
   -----------------------------------------------------------------------
   A small dot that follows the pointer and grows into a ring over anything
   clickable — reinforces "this is interactive" precisely where the design
   otherwise has almost no conventional affordances (no buttons-that-look-
   like-buttons, no underlines except the crossfader/social links). Fine-
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

/* -------------------------------------------------------------------------- */

(() => {
  const body = document.body;
  const html = document.documentElement;
  const crossfaderInput = document.getElementById('crossfader-input');
  const deckBPanel = document.getElementById('deck-b-panel');
  const muteToggle = document.getElementById('mute-toggle');
  const themeToggle = document.getElementById('theme-toggle');

  // Start loading/generating audio once the page has painted and settled
  // (Phase 6: keeps the — possibly chunky, especially for the synthetic
  // placeholder loop — decode/generate work off the critical initial-paint
  // path) rather than at parse time, but still well ahead of the first
  // fader interaction so the wake moment has no perceptible lag.
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
  Cursor.init();

  // Wake sequence (Phase 7): one duration drives all three parts of the
  // reveal — the sleeping-state CSS, the wave's amplitude ramp, and the
  // audio fade-in — so they read as one coordinated 1.5s moment instead of
  // three unrelated timings that happen to overlap. Read from the CSS
  // token rather than re-declaring 1500 here, so there's exactly one
  // source of truth. Floored at 300ms: if prefers-reduced-motion was
  // active at page load, --dur-wake reads as 0ms (per the Phase 0 token
  // override) — harmless on its own since the ramp is skipped entirely
  // whenever reduced motion is active at interaction time (see
  // beginCrossfading below), but this keeps the captured constant itself
  // safe to use (no divide-by-zero) for the edge case of someone switching
  // the OS setting off between load and first interaction.
  const WAKE_DURATION_MS = Math.max(
    300,
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-wake')) || 1500
  );
  let wakeStartTs = null;

  /* --------------------------------------------------------------------
     Crossfader
     -----------------------------------------------------------------
     Replaces Phase 0's tap-to-enter gate and the old bio/dates/booking
     nav+overlays wholesale: one range input is now the entire site's
     navigation. mix runs 0 (full artist: wave at full amplitude/volume,
     deck-b-panel invisible) to 1 (full booking: deck-b-panel fully
     readable, wave a dim backdrop, audio silent) — see
     AudioEngine.setMix() and Wave.draw()'s BUSINESS_SCALE blend for the
     two halves this one number drives. It also doubles as the entry
     gesture: the *first* pointerdown or keydown on it is what unlocks
     audio and kicks off the same wake-unfurl ramp tap-to-enter used to
     trigger — see AudioEngine.unlock()'s own comment for why that call has
     to be synchronous, inside the raw gesture handler, with no await
     before it (iOS Safari's gesture-chaining requirement).
     -------------------------------------------------------------------- */
  const REVEAL_THRESHOLD = 0.08; // below this, deck-b-panel is inert/hidden from AT — matches where it's visually still unreadable
  let mix = 0;
  let crossfaderStarted = false;

  function applyMix(value) {
    mix = value;
    // Single continuous parameter drives the panel's own CSS (opacity /
    // transform bound to var(--mix) in style.css) — no JS-computed
    // styles, no discrete thresholds for *appearance*. inert/aria-hidden
    // are the one place a threshold is unavoidable: screen readers have no
    // concept of "38% visible", so they get the panel exactly when it's
    // become meaningfully legible to sighted visitors.
    html.style.setProperty('--mix', mix.toFixed(4));
    const revealed = mix >= REVEAL_THRESHOLD;
    if (revealed) {
      deckBPanel.removeAttribute('inert');
      deckBPanel.setAttribute('aria-hidden', 'false');
    } else {
      // An element can't hold focus once it's inert; if a keyboard user had
      // tabbed into a dates/social link and then scrubbed back past the
      // threshold, blur first so focus doesn't get silently stranded
      // inside a now-inert subtree.
      if (deckBPanel.contains(document.activeElement)) {
        document.activeElement.blur();
      }
      deckBPanel.setAttribute('aria-hidden', 'true');
      deckBPanel.setAttribute('inert', '');
    }
    AudioEngine.setMix(mix);
  }
  applyMix(0); // sync --mix/AudioEngine with the range input's own default value

  async function beginCrossfading() {
    if (crossfaderStarted) return;
    crossfaderStarted = true;
    // Must be the very first thing that happens, synchronously, before any
    // await — see AudioEngine.unlock()'s own comment for why.
    if (!prefersReducedMotion()) {
      AudioEngine.unlock();
    }
    body.dataset.state = 'awake';
    wakeStartTs = performance.now();
    // Reduced motion (Phase 6): leave the sleeping state, but don't start
    // audio — nothing here should autoplay for these visitors.
    if (!prefersReducedMotion()) {
      await AudioEngine.start(WAKE_DURATION_MS);
    }
  }

  // pointerdown covers mouse drag and touch; keydown covers a keyboard user
  // tabbing to the fader and pressing an arrow key without ever pointing at
  // it. Both are idempotent via crossfaderStarted, so whichever fires first
  // wins and the other is a no-op.
  crossfaderInput.addEventListener('pointerdown', beginCrossfading);
  crossfaderInput.addEventListener('keydown', beginCrossfading);
  crossfaderInput.addEventListener('input', () => {
    applyMix(Number(crossfaderInput.value) / 100);
  });

  muteToggle.addEventListener('click', () => {
    const muted = AudioEngine.toggleMute();
    muteToggle.setAttribute('aria-pressed', String(muted));
    body.dataset.muted = String(muted);

    // Mute doubles as pause for the wave, not just the speakers: freeze +
    // dissolve into particles on mute, ease back in (reusing the same
    // wake-unfurl ramp as the original wake) on unmute.
    if (muted) {
      Wave.pause(performance.now());
    } else {
      Wave.resume();
      wakeStartTs = performance.now();
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
    // --color-fg / --color-accent just changed; Wave cached them at
    // init and only re-reads on demand, not every frame.
    Wave.refreshColors();
  });

  // Dev/debug access, zero runtime cost otherwise: window.diskevichAudio.bands
  // for live bass/mid/high, window.diskevichDebug.mobileMode / .mix to check
  // which branch is active and the current crossfader position. (The old DJ_DEBUG
  // console logger and on-screen fps meter were removed in Phase 6.)
  window.diskevichAudio = AudioEngine;
  window.diskevichDebug = {
    get mobileMode() {
      return mobileMode;
    },
    get mix() {
      return mix;
    },
  };

  let lastTime = 0;
  let mobileFrameCounter = 0;
  let rafId = null;
  let lastSleepDrawTs = 0;
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
    // WAKE_DURATION_MS once the crossfader is first touched, 1 once fully
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
    Wave.draw(ts, dt / 1000, bands, wakeProgress, mix);
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
