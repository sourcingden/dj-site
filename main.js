/* ==========================================================================
   diskevich — main.js — "SIDE A"

   The site was rebuilt around one idea: the phone is the tape, scroll is
   the playhead, and your hands are the signal. There is no audio anywhere
   in this file — the wave that used to react to an FFT now reacts to
   scroll velocity, touch, drag and (optionally) device tilt, through the
   Energy module below, which deliberately mirrors the old AudioEngine's
   {bass, mid, high} output shape so the entire Wave rendering pipeline —
   value noise, springs, multi-touch, scratch, assemble particles — could
   survive the rewrite untouched.

   Module map:
     Energy   — synthesizes {bass, mid, high} from interaction instead of
                an analyser. bass=swell (scroll+charge), mid=flow (drag+
                tilt), high=spark (taps+scratch). Same EMA-smoothing idiom
                the old AudioEngine used.
     Wave     — canvas 2D line renderer. Physics is the original file's;
                sizing, baseline, amplitude and touch-scoping are new.
     Orb      — three.js accent, now a dynamic import, desktop-only.
     Cursor / Magnetic — desktop-only enhancements, gated on real hover.
     Tilt     — opt-in gyroscope parallax, never load-bearing.
     Bootstrap IIFE — chapter scroll engine, THE DROP, portrait develop/
                scrub, the bottom rail, theme toggle, frame loop.
   ========================================================================== */

/* --------------------------------------------------------------------------
   Shared mobile detection — now LIVE, not compute-once.
   -----------------------------------------------------------------------
   A matchMedia change listener + a subscriber list, so switching from
   coarse to fine pointer (or back) can actually re-init/destroy the
   desktop-only modules (Orb/Cursor/Magnetic) instead of just flipping a
   flag nothing re-reads.
   -------------------------------------------------------------------------- */
const coarseQuery = window.matchMedia
  ? window.matchMedia('(max-width: 768px), (pointer: coarse)')
  : null;
let mobileMode = coarseQuery ? coarseQuery.matches : false;
const mobileModeSubscribers = [];
function onMobileModeChange(fn) {
  mobileModeSubscribers.push(fn);
}
if (coarseQuery) {
  const handler = (e) => {
    mobileMode = e.matches;
    mobileModeSubscribers.forEach((fn) => {
      try {
        fn(mobileMode);
      } catch (err) {
        console.error('[diskevich] mobileMode subscriber threw', err);
      }
    });
  };
  if (coarseQuery.addEventListener) coarseQuery.addEventListener('change', handler);
  else if (coarseQuery.addListener) coarseQuery.addListener(handler); // older Safari
}

const fineHoverQuery = window.matchMedia ? window.matchMedia('(hover: hover) and (pointer: fine)') : null;
function hasFineHover() {
  return fineHoverQuery ? fineHoverQuery.matches : false;
}

/* --------------------------------------------------------------------------
   Reduced motion
   -------------------------------------------------------------------------- */
const reducedMotionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
function prefersReducedMotion() {
  return reducedMotionQuery ? reducedMotionQuery.matches : false;
}

function easeOutExpo(x) {
  return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x);
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/* --------------------------------------------------------------------------
   Energy
   -----------------------------------------------------------------------
   Drop-in replacement for the old AudioEngine.update()'s job: returns an
   EMA-smoothed {bass, mid, high}, 0..1 each, every frame. Nothing
   downstream needs to know the source changed.

     bass ("swell")  — scroll velocity (a fling surges it) + press-and-hold
                        charge. Long decay: a fling keeps rolling.
     mid  ("flow")   — active drag/pointer presence + tilt magnitude.
     high ("spark")  — taps + the existing scratch-gesture energy already
                        computed inside Wave.

   Each band has its own attack/decay rate rather than one shared
   smoothing constant — fast attack reads as responsive, slow release
   reads as inertia, and that asymmetry is what keeps the wave feeling
   alive instead of twitchy. After IDLE_ATTRACT_MS with no interaction at
   all, a slow "attract" breathing lifts the floor so the wave never goes
   flat and invites another touch.
   -------------------------------------------------------------------------- */
const Energy = (() => {
  const bands = { bass: 0, mid: 0, high: 0 };
  // Raw, un-smoothed instantaneous targets — decay on their own each frame,
  // separately from the EMA applied on top when reading them into bands.
  let swellTarget = 0;
  let flowTarget = 0;
  let sparkTarget = 0;

  const SWELL_ATTACK = 0.999; // ~ (1 - exp(-rate*dt)) done inline below
  const SWELL_DECAY_HZ = 0.9;
  const FLOW_DECAY_HZ = 2.5;
  const SPARK_DECAY_HZ = 8;

  let lastInteractionTs = performance.now();
  const IDLE_ATTRACT_MS = 12000;
  const ATTRACT_PERIOD_MS = 6000;

  let dragActive = false;
  let chargeActive = false;
  let chargeStartTs = null;
  const CHARGE_RAMP_MS = 1400;

  function markInteraction() {
    lastInteractionTs = performance.now();
  }

  // Scroll velocity in px/ms, fed once per rAF from the scroll handler.
  function scroll(velocityPxPerMs) {
    const mag = Math.min(1, Math.abs(velocityPxPerMs) * 2.2);
    if (mag > swellTarget) swellTarget = mag;
    markInteraction();
  }

  function drag(active) {
    dragActive = active;
    if (active) markInteraction();
  }

  function tilt(magnitude01) {
    // Additive, gentle — tilt alone shouldn't dominate flow the way an
    // active drag does.
    flowTarget = Math.max(flowTarget, Math.min(1, magnitude01 * 0.6));
  }

  function tap(strength01) {
    sparkTarget = Math.max(sparkTarget, Math.min(1, strength01));
    markInteraction();
  }

  function scratch(energy01) {
    sparkTarget = Math.max(sparkTarget, energy01);
    if (energy01 > 0.05) markInteraction();
  }

  function chargeStart() {
    chargeActive = true;
    chargeStartTs = performance.now();
    markInteraction();
  }
  function chargeEnd() {
    chargeActive = false;
    chargeStartTs = null;
  }

  function update(dtSec) {
    const dt = Math.max(0, Math.min(0.1, dtSec));

    // Charge: while held, ramps swellTarget toward 1 over CHARGE_RAMP_MS —
    // this is chapter 04's hold-to-charge, feeding the same swell band a
    // fling does.
    if (chargeActive && chargeStartTs !== null) {
      const held = performance.now() - chargeStartTs;
      swellTarget = Math.max(swellTarget, Math.min(1, held / CHARGE_RAMP_MS));
    }

    // Drag: a steady, moderate lift to flow while a finger/mouse is down
    // and moving, independent of scratch/tap.
    if (dragActive) flowTarget = Math.max(flowTarget, 0.35);

    // Idle attract: after IDLE_ATTRACT_MS of silence, a slow sine lifts the
    // floor a little so the wave keeps inviting a touch rather than going
    // dead flat. Never as loud as real interaction.
    const idleFor = performance.now() - lastInteractionTs;
    let attract = 0;
    if (idleFor > IDLE_ATTRACT_MS && !prefersReducedMotion()) {
      const phase = ((performance.now() % ATTRACT_PERIOD_MS) / ATTRACT_PERIOD_MS) * Math.PI * 2;
      attract = (Math.sin(phase) * 0.5 + 0.5) * 0.22;
    }

    // Exponential decay toward 0 each frame (frame-rate independent),
    // floored by the idle-attract term.
    swellTarget = Math.max(attract * 0.6, swellTarget * Math.exp(-SWELL_DECAY_HZ * dt));
    flowTarget = Math.max(attract * 0.4, dragActive ? flowTarget : flowTarget * Math.exp(-FLOW_DECAY_HZ * dt));
    sparkTarget = Math.max(0, sparkTarget * Math.exp(-SPARK_DECAY_HZ * dt));

    // EMA into the exposed bands — same smoothing idiom the old
    // AudioEngine.update() used, just per-band rates instead of one shared
    // constant, since attack character matters more here than it did
    // reading real FFT data.
    bands.bass += (swellTarget - bands.bass) * 0.18;
    bands.mid += (flowTarget - bands.mid) * 0.22;
    bands.high += (sparkTarget - bands.high) * 0.5;

    return bands;
  }

  return {
    update,
    scroll,
    drag,
    tilt,
    tap,
    scratch,
    chargeStart,
    chargeEnd,
    get bands() {
      return bands;
    },
  };
})();

/* --------------------------------------------------------------------------
   Wave
   -----------------------------------------------------------------------
   Draws the wave on #wave-canvas. Each point's vertical displacement is
   the sum of three Energy-driven sine ripples (swell/flow/spark, same math
   the old bass/mid/high ripples used), a slow idle value-noise breathing
   term, and now a fourth term: travelling tap ripples (see spawnRipple()).

   Sizing authority: a ResizeObserver on the canvas element itself is now
   the ONLY thing that sets canvas.width/height — CSS owns the layout box,
   JS never writes canvas.style.width/height, which is what let the two
   disagree during an iOS URL-bar collapse. baselineY is derived from
   visualViewport rather than window.innerHeight, for the same reason.

   Touch scoping: bindPointerEvents() is gone — attachInteraction(el) binds
   to a specific element (the chapter 04 hit-test surface) instead of
   window, so scrolling anywhere else on the page never touches the
   spring/scratch physics. Coordinates stay clientX/clientY throughout
   (the canvas is still position:fixed;inset:0), so there is no coordinate
   translation needed between the hit-test element and the fixed canvas.
   -------------------------------------------------------------------------- */
const Wave = (() => {
  let canvas, ctx;
  let width = 0;
  let height = 0;
  let pointCount = 120;
  let baselineY = 0;
  let chapterOffset = 0;
  let chapterAmpMul = 1; // per-chapter amplitude multiplier (e.g. dimmer behind text)

  let springY = [];
  let springVY = [];

  const pointers = new Map(); // key -> {x, y}
  const pointerHistory = new Map(); // key -> {x, y, ts}

  let lastT = 0;

  // Assemble: the entry moment's particles-converging-into-a-line effect.
  // Kept from the original file — it pairs perfectly with THE DROP.
  let assembling = false;
  let assembleStartTs = null;
  let assembleWallStartMs = null;
  let assembleTargetPoints = [];
  const ASSEMBLE_DURATION_S = 0.8;
  const STUCK_TRANSIENT_CEILING_MS = 5000;

  const color = { fg: '#f2ede4', accent: '#c97a3d', selection: '#ff2d78' };

  function readColorTokens() {
    const styles = getComputedStyle(document.documentElement);
    color.fg = styles.getPropertyValue('--color-fg').trim() || color.fg;
    color.accent = styles.getPropertyValue('--color-accent').trim() || color.accent;
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

  // ---- cheap 1D value noise, summed at two octaves ----
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

  // ---- tuning: amplitudes now scale with the viewport instead of being
  // fixed CSS-pixel constants, so the wave is proportionally the same size
  // on a phone as on a desktop rather than ~2x more dominant. See
  // ampUnit(), recomputed on every resize(). ----
  let ampUnit = 40;
  function computeAmpUnit() {
    return Math.min(height * 0.075, 72);
  }

  const IDLE_SCALE = 1.4;
  const IDLE_SPEED = 0.00022;
  const BASS_FREQ = 1.3;
  const BASS_SPEED = 0.00055;
  const MID_FREQ = 4.4;
  const MID_SPEED = 0.0011;
  const MID_PHASE = Math.PI / 3;
  const HIGH_FREQ = 15;
  const HIGH_SPEED = 0.0021;
  const EDGE_FADE = 0.06;

  function edgeFade(u) {
    if (u < EDGE_FADE) return u / EDGE_FADE;
    if (u > 1 - EDGE_FADE) return (1 - u) / EDGE_FADE;
    return 1;
  }

  // ---- travelling tap ripples ----
  // A fourth additive displacement term: each tap spawns a Gaussian wave
  // packet expanding outward (in normalized u-space) from the touch point,
  // decaying over its lifetime. Capped and pruned so a flurry of taps
  // can't accumulate unboundedly.
  let ripples = [];
  const RIPPLE_LIFE_S = 1.5;
  const RIPPLE_SPEED = 0.9; // u-units/sec, each direction
  const RIPPLE_WIDTH = 0.05; // Gaussian sigma in u-space
  const RIPPLE_MAX = 6;

  function spawnRipple(u) {
    if (ripples.length >= RIPPLE_MAX) ripples.shift();
    ripples.push({ u, age: 0 });
  }

  function rippleDisplacement(u, dt) {
    if (!ripples.length) return 0;
    let sum = 0;
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      r.age += dt;
      if (r.age >= RIPPLE_LIFE_S) {
        ripples.splice(i, 1);
        continue;
      }
      const fade = 1 - r.age / RIPPLE_LIFE_S;
      const travel = r.age * RIPPLE_SPEED;
      // Two fronts, expanding both directions from the origin.
      const dLeft = Math.abs(u - (r.u - travel));
      const dRight = Math.abs(u - (r.u + travel));
      const d = Math.min(dLeft, dRight);
      const g = Math.exp(-(d * d) / (2 * RIPPLE_WIDTH * RIPPLE_WIDTH));
      sum += g * fade;
    }
    return sum;
  }

  function displacement(u, t, bands, phaseShift, ampScale, rippleTerm) {
    const tt = t + phaseShift + scratchPhaseOffsetMs;
    const unit = ampUnit;
    const bass = unit * 1.0 * bands.bass * Math.sin(u * Math.PI * 2 * BASS_FREQ + tt * BASS_SPEED);
    const mid = unit * 0.4 * bands.mid * Math.sin(u * Math.PI * 2 * MID_FREQ + tt * MID_SPEED + MID_PHASE);
    const high = unit * 0.18 * bands.high * Math.sin(u * Math.PI * 2 * HIGH_FREQ + tt * HIGH_SPEED);
    const idle = unit * 0.16 * (idleNoise(u * IDLE_SCALE + tt * IDLE_SPEED) * 2 - 1);
    const ripple = unit * 0.9 * (rippleTerm || 0);
    return (bass + mid + high + idle + ripple) * ampScale * edgeFade(u) * chapterAmpMul;
  }

  function tracePath(t, bands, phaseShift, ampScale, yOffset, globalScale, dt) {
    const midY = baselineY + yOffset;
    ctx.beginPath();
    for (let i = 0; i <= pointCount; i++) {
      const u = i / pointCount;
      const x = u * width;
      const rip = rippleDisplacement(u, i === 0 ? dt : 0); // advance ripple age once per frame, on i===0
      const y = midY + (displacement(u, t, bands, phaseShift, ampScale, rip) + (springY[i] || 0)) * globalScale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }

  function capturePoints(t, bands, globalScale) {
    const midY = baselineY;
    const pts = new Array(pointCount + 1);
    for (let i = 0; i <= pointCount; i++) {
      const u = i / pointCount;
      pts[i] = {
        x: u * width,
        y: midY + (displacement(u, t, bands, 0, 1, 0) + (springY[i] || 0)) * globalScale,
      };
    }
    return pts;
  }

  const PARTICLES_PER_POINT = 3;
  let particles = [];

  function spawnAssembleParticles(targetPoints) {
    particles = [];
    for (let i = 0; i < targetPoints.length; i++) {
      const p = targetPoints[i];
      for (let k = 0; k < PARTICLES_PER_POINT; k++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 30 + Math.random() * 200;
        particles.push({
          startX: p.x + Math.cos(angle) * dist,
          startY: p.y + Math.sin(angle) * dist - 20,
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
      const fade = 1 - progress;
      ctx.beginPath();
      ctx.fillStyle = hexToRgba(p.color, fade * 0.9);
      ctx.arc(x, y, Math.max(0.2, p.size * fade), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function computePointCount(w) {
    if (mobileMode) {
      return Math.max(40, Math.min(90, Math.round(w / 20)));
    }
    return Math.max(60, Math.min(220, Math.round(w / 14)));
  }

  function pointerRadius() {
    // Keyed off the SMALLER dimension so a phone's radius doesn't float
    // relative to its narrow axis — the old formula (width * 0.18, floored
    // at 140px) put 37% of a 375px screen under one finger; this keeps it
    // proportional on both axes.
    return Math.min(320, Math.max(64, Math.min(width, height) * 0.16));
  }

  const PULL_STRENGTH = 0.55;
  const SPRING_HZ = 5;
  const SPRING_ZETA = 0.55;
  const SPRING_K = (2 * Math.PI * SPRING_HZ) ** 2;
  const SPRING_C = 2 * SPRING_ZETA * 2 * Math.PI * SPRING_HZ;
  const MAX_DT = 0.05;

  const SCRATCH_VELOCITY_SCALE = 0.14;
  const SCRATCH_MAX_ENERGY = 1;
  const SCRATCH_DECAY_HZ = 6;
  const SCRATCH_PHASE_KICK_MS = 900;
  const SCRATCH_MIN_DRAG_PX = 3;

  let scratchEnergy = 0;
  let scratchDirection = 1;
  let scratchPhaseOffsetMs = 0;

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
        const naturalY = baselineY + displacement(u, t, bands, 0, 1, 0);
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

      const curY = springY[i] || 0;
      const curVY = springVY[i] || 0;
      const accel = SPRING_K * (target - curY) - SPRING_C * curVY;
      springVY[i] = curVY + accel * dt;
      springY[i] = curY + springVY[i] * dt;
    }
  }

  function updateScratch(dt) {
    scratchEnergy *= Math.exp(-SCRATCH_DECAY_HZ * dt);
    scratchPhaseOffsetMs = scratchEnergy * scratchDirection * SCRATCH_PHASE_KICK_MS;
    Energy.scratch(scratchEnergy);
  }

  /* ---- sizing: ResizeObserver is the single source of truth ---- */
  function applySize(cssW, cssH, bufW, bufH) {
    width = cssW;
    height = cssH;
    canvas.width = bufW;
    canvas.height = bufH;
    // Scale factor per axis rather than a flat dpr — device-pixel-content-
    // box can round each axis slightly differently.
    ctx.setTransform(bufW / cssW || 1, 0, 0, bufH / cssH || 1, 0, 0);
    ampUnit = computeAmpUnit();
    pointCount = computePointCount(width);
    ensureSpringArrays();
    updateBaseline();
  }

  let ro = null;
  function initResizeObserver() {
    if (!('ResizeObserver' in window)) {
      // Ancient-browser fallback: one-time size, no live updates.
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      applySize(rect.width, rect.height, Math.round(rect.width * dpr), Math.round(rect.height * dpr));
      return;
    }
    ro = new ResizeObserver((entries) => {
      const e = entries[0];
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = e.contentBoxSize ? e.contentBoxSize[0].inlineSize : e.contentRect.width;
      const ch = e.contentBoxSize ? e.contentBoxSize[0].blockSize : e.contentRect.height;
      const d = e.devicePixelContentBoxSize;
      applySize(cw, ch, d ? d[0].inlineSize : Math.round(cw * dpr), d ? d[0].blockSize : Math.round(ch * dpr));
    });
    try {
      ro.observe(canvas, { box: 'device-pixel-content-box' });
    } catch (err) {
      ro.observe(canvas); // Safari < 16.4
    }
  }

  /* baselineY: derived from the VISUAL viewport, not window.innerHeight —
     #wave-canvas is position:fixed;inset:0, which resolves against the
     LAYOUT viewport, so with the URL bar showing, height/2 is not the
     middle of what's actually visible. chapterOffset (set per active
     chapter, see setChapterMode) seats the wave below text rather than
     through it. */
  function updateBaseline() {
    const vv = window.visualViewport;
    baselineY = (vv ? vv.height : height) * 0.5 + chapterOffset;
  }

  function setChapterMode(offset, ampMul) {
    chapterOffset = offset || 0;
    chapterAmpMul = ampMul == null ? 1 : ampMul;
    updateBaseline();
  }

  function setPointer(key, x, y) {
    if (!prefersReducedMotion()) {
      const now = performance.now();
      const prev = pointerHistory.get(key);
      if (prev) {
        const dt = Math.max(1, now - prev.ts);
        const dx = x - prev.x;
        if (Math.abs(dx) > SCRATCH_MIN_DRAG_PX) {
          const vx = dx / dt;
          const instantEnergy = Math.min(SCRATCH_MAX_ENERGY, Math.abs(vx) * SCRATCH_VELOCITY_SCALE);
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

  // Bound to a SPECIFIC element (the chapter 04 hit-test surface), not
  // window — this is the fix for "scrolling triggers the scratch effect".
  // clientX/clientY are viewport coordinates, exactly the space the fixed
  // canvas draws in, so no translation is needed regardless of which
  // element the listener lives on.
  function attachInteraction(el) {
    if (!el || el.__waveBound) return;
    el.__waveBound = true;

    let dragCount = 0;

    el.addEventListener('mousemove', (e) => {
      setPointer('mouse', e.clientX, e.clientY);
      Energy.drag(true);
    });
    el.addEventListener('mouseleave', () => {
      clearPointer('mouse');
      Energy.drag(false);
    });
    el.addEventListener('mousedown', () => Energy.chargeStart());
    ['mouseup', 'mouseleave'].forEach((evt) => el.addEventListener(evt, () => Energy.chargeEnd()));

    el.addEventListener(
      'touchstart',
      (e) => {
        dragCount = e.touches.length;
        for (const touch of e.touches) {
          setPointer(touch.identifier, touch.clientX, touch.clientY);
          const u = touch.clientX / Math.max(1, width);
          spawnRipple(u);
          Energy.tap(0.6);
        }
        Energy.drag(true);
        Energy.chargeStart();
      },
      { passive: true }
    );
    el.addEventListener(
      'touchmove',
      (e) => {
        for (const touch of e.touches) setPointer(touch.identifier, touch.clientX, touch.clientY);
      },
      { passive: true }
    );
    const releaseHandler = (e) => {
      for (const touch of e.changedTouches) clearPointer(touch.identifier);
      dragCount = Math.max(0, dragCount - e.changedTouches.length);
      if (dragCount === 0) {
        Energy.drag(false);
        Energy.chargeEnd();
      }
    };
    el.addEventListener('touchend', releaseHandler, { passive: true });
    el.addEventListener('touchcancel', releaseHandler, { passive: true });
  }

  function init() {
    canvas = document.getElementById('wave-canvas');
    ctx = canvas.getContext('2d');
    readColorTokens();
    initResizeObserver();
    window.visualViewport?.addEventListener('resize', updateBaseline, { passive: true });
    window.visualViewport?.addEventListener('scroll', updateBaseline, { passive: true });
  }

  const SLEEP_SCALE = 0.12;
  const SETTLED_SCALE = 0.32; // was BUSINESS_SCALE — crossfader-era naming, renamed on this rewrite

  const GLOW_BASE_WIDTH = 8;
  const GLOW_BASS_WIDTH_GAIN = 10;
  const GLOW_BASE_ALPHA = 0.18;
  const GLOW_BASS_ALPHA_GAIN = 0.22;
  const GLOW_MAX_ALPHA = 0.5;

  // ---- rave burst envelope, reused as THE DROP's engine and as chapter
  // 04's hold->burst — see triggerRaveBurst()'s call sites in the
  // bootstrap IIFE below. Unchanged math from the original file. ----
  const RAVE_DURATION_MS = 4000;
  const RAVE_AMP_BOOST = 2.2;
  const RAVE_ATTACK_MS = 300;
  const RAVE_RELEASE_MS = 700;
  const RAVE_CYCLE_SPEED = 0.008;
  const RAVE_FLASH_MS = 900;

  let raveActive = false;
  let raveStartTs = null;
  let raveFlash = false;
  let raveFlashStartTs = null;
  let raveDurationMs = RAVE_DURATION_MS;
  let raveAttackMs = RAVE_ATTACK_MS;
  let raveReleaseMs = RAVE_RELEASE_MS;

  function triggerRaveBurst(opts) {
    if (raveActive) return;
    raveDurationMs = (opts && opts.durationMs) || RAVE_DURATION_MS;
    raveAttackMs = (opts && opts.attackMs) || RAVE_ATTACK_MS;
    raveReleaseMs = (opts && opts.releaseMs) || RAVE_RELEASE_MS;
    if (prefersReducedMotion()) {
      raveFlash = true;
      raveFlashStartTs = performance.now();
      return;
    }
    raveActive = true;
    raveStartTs = performance.now();
  }

  function raveEnvelope(nowTs) {
    if (!raveActive) return 0;
    const elapsed = nowTs - raveStartTs;
    if (elapsed >= raveDurationMs) {
      raveActive = false;
      return 0;
    }
    if (elapsed < raveAttackMs) return easeOutExpo(elapsed / raveAttackMs);
    const releaseStart = raveDurationMs - raveReleaseMs;
    if (elapsed > releaseStart) return 1 - easeOutExpo((elapsed - releaseStart) / raveReleaseMs);
    return 1;
  }

  function drawLayers(t, bands, globalScale, raveMix, raveStatic, dt) {
    tracePath(t, bands, -420, 0.72, 10, globalScale, dt);
    ctx.strokeStyle = hexToRgba(color.fg, 0.08);
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    tracePath(t, bands, -220, 0.85, 5, globalScale, 0);
    ctx.strokeStyle = hexToRgba(color.fg, 0.16);
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    const glowPulse = bands.bass * globalScale;
    const glowAlpha = Math.min(GLOW_MAX_ALPHA, GLOW_BASE_ALPHA + glowPulse * GLOW_BASS_ALPHA_GAIN);
    let glowStroke = hexToRgba(color.accent, glowAlpha);
    let mainStroke = color.fg;
    if (raveMix > 0) {
      const cyclePos = raveStatic ? 0.5 : (Math.sin(t * RAVE_CYCLE_SPEED) + 1) / 2;
      const glowRgb = mixHex(color.accent, color.selection, raveMix * cyclePos);
      const mainRgb = mixHex(color.fg, color.selection, raveMix * (1 - cyclePos));
      glowStroke = rgbaCss(glowRgb, Math.min(1, glowAlpha + raveMix * 0.5));
      mainStroke = rgbaCss(mainRgb, 1);
    }

    tracePath(t, bands, 0, 1, 0, globalScale, 0);
    ctx.strokeStyle = glowStroke;
    ctx.lineWidth = (GLOW_BASE_WIDTH + glowPulse * GLOW_BASS_WIDTH_GAIN) * (1 + raveMix);
    ctx.lineJoin = 'round';
    ctx.stroke();

    tracePath(t, bands, 0, 1, 0, globalScale, 0);
    ctx.strokeStyle = mainStroke;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  function beginAssemble(nowTs, targetPoints) {
    assembling = true;
    assembleStartTs = nowTs;
    assembleWallStartMs = Date.now();
    assembleTargetPoints = targetPoints;
    spawnAssembleParticles(targetPoints);
  }

  function wake(nowTs) {
    if (prefersReducedMotion()) return;
    beginAssemble(nowTs, capturePoints(0, { bass: 0, mid: 0, high: 0 }, SLEEP_SCALE));
  }

  function draw(t, dt, bands, wakeProgress, mix = 0, awake = true) {
    const effectiveT = prefersReducedMotion() ? 0 : t;
    updateScratch(dt);

    ctx.clearRect(0, 0, width, height);

    if (assembling) {
      const assembleElapsed = (t - assembleStartTs) / 1000;
      const assembleStuck = assembleWallStartMs !== null && Date.now() - assembleWallStartMs > STUCK_TRANSIENT_CEILING_MS;
      if (assembleElapsed < ASSEMBLE_DURATION_S && !assembleStuck) {
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
        return;
      }
      assembling = false;
      particles = [];
    }

    if (!awake) {
      // The wave is ALIVE from first paint now (no audio-unlock gate to
      // wait on) — this branch only guards the brief window before init()
      // has run at all.
      stepPhysics(effectiveT, bands, dt);
      lastT = effectiveT;
      return;
    }

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

    const wakeTarget = lerp(1, SETTLED_SCALE, mix);
    const baseGlobalScale = SLEEP_SCALE + (wakeTarget - SLEEP_SCALE) * easeOutExpo(wakeProgress);
    const globalScale = baseGlobalScale * (1 + raveAmpMix * (RAVE_AMP_BOOST - 1));
    lastT = effectiveT;

    stepPhysics(effectiveT, bands, dt);
    drawLayers(effectiveT, bands, globalScale, raveColorMix, raveStatic, dt);
  }

  return {
    init,
    draw,
    refreshColors: readColorTokens,
    wake,
    attachInteraction,
    setChapterMode,
    spawnRipple: (u) => spawnRipple(u),
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
   Orb
   -----------------------------------------------------------------------
   Same three.js + GLSL accent as before, now behind a DYNAMIC import
   inside init() rather than a static top-level import — mobile never pays
   for the 656KB module since init() bails before the import on any
   non-fine-hover device. frameLoop()'s render() call needs no change:
   `ready` is only set true at the very end of a completed init(), so an
   Orb that hasn't finished importing yet renders nothing, exactly like
   the pre-init() state already did.
   -------------------------------------------------------------------------- */
const Orb = (() => {
  let THREE = null;
  let renderer = null;
  let scene, camera, mesh, material;
  let ready = false;
  let clockStart = 0;
  let canvasEl = null;
  let ro = null;

  const VERTEX_SHADER = `
    uniform float uTime;
    uniform float uBass;
    varying vec3 vNormal;
    varying vec3 vViewPosition;

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

    float displacement(vec3 dir) {
      float n = snoise(dir * 1.1 + vec3(0.0, 0.0, uTime * 0.1));
      return n * (0.035 + uBass * 0.16);
    }

    void main() {
      vec3 n = normal;
      vec3 pos = position + n * displacement(n);

      vec3 tangent = normalize(cross(n, abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
      vec3 bitangent = normalize(cross(n, tangent));
      float eps = 0.01;
      vec3 nT = normalize(n + tangent * eps);
      vec3 nB = normalize(n + bitangent * eps);
      vec3 posT = position + tangent * eps + nT * displacement(nT);
      vec3 posB = position + bitangent * eps + nB * displacement(nB);
      vec3 displacedNormal = normalize(cross(posT - pos, posB - pos));
      if (dot(displacedNormal, n) < 0.0) displacedNormal = -displacedNormal;

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
    if (!renderer || !canvasEl) return;
    const rect = canvasEl.getBoundingClientRect();
    const w = rect.width || window.innerWidth;
    const h = rect.height || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  async function init() {
    if (!hasFineHover() || prefersReducedMotion()) return;
    canvasEl = document.getElementById('orb-canvas');
    if (!canvasEl) return;

    try {
      THREE = await import('./vendor/three.module.js');
    } catch (err) {
      console.warn('[diskevich] Orb: three.js failed to load, skipping the 3D accent.', err);
      return;
    }

    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvasEl, alpha: true, antialias: true });
    } catch (err) {
      console.warn('[diskevich] Orb: WebGL unavailable, skipping the 3D accent.', err);
      renderer = null;
      return;
    }
    renderer.setClearColor(0x000000, 0);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 20);
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
      blending: THREE.AdditiveBlending,
    });
    mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 5), material);
    scene.add(mesh);

    canvasEl.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      ready = false;
    });

    if ('ResizeObserver' in window) {
      ro = new ResizeObserver(resize);
      ro.observe(canvasEl);
    } else {
      window.addEventListener('resize', resize);
    }
    resize();
    clockStart = performance.now();
    ready = true;
  }

  function destroy() {
    ready = false;
    if (ro) {
      ro.disconnect();
      ro = null;
    }
    if (renderer) {
      renderer.dispose();
      renderer = null;
    }
  }

  function render(ts, bands, awake) {
    if (!ready || !awake) return;
    material.uniforms.uTime.value = (ts - clockStart) / 1000;
    material.uniforms.uBass.value = bands.bass;
    mesh.rotation.y += 0.0016;
    mesh.rotation.x += 0.0007;
    renderer.render(scene, camera);
  }

  return { init, destroy, render, refreshColors };
})();

onMobileModeChange((coarse) => {
  if (coarse) Orb.destroy();
  else Orb.init().catch(() => {});
});

/* --------------------------------------------------------------------------
   Cursor
   -------------------------------------------------------------------------- */
const Cursor = (() => {
  let dot = null;
  let bound = false;

  function onMove(e) {
    dot.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0)`;
    const overInteractive = !!(e.target && e.target.closest && e.target.closest('button, a, input'));
    dot.classList.toggle('cursor-dot--active', overInteractive);
  }
  function onLeave() {
    dot.classList.add('cursor-dot--hidden');
  }
  function onEnter() {
    dot.classList.remove('cursor-dot--hidden');
  }

  function init() {
    if (!hasFineHover() || bound) return;
    bound = true;
    dot = document.createElement('div');
    dot.className = 'cursor-dot';
    dot.setAttribute('aria-hidden', 'true');
    document.body.appendChild(dot);
    document.body.classList.add('has-custom-cursor');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseleave', onLeave);
    window.addEventListener('mouseenter', onEnter);
  }

  function destroy() {
    if (!bound) return;
    bound = false;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseleave', onLeave);
    window.removeEventListener('mouseenter', onEnter);
    document.body.classList.remove('has-custom-cursor');
    dot?.remove();
    dot = null;
  }

  return { init, destroy };
})();

onMobileModeChange((coarse) => {
  if (coarse) Cursor.destroy();
  else Cursor.init();
});

/* --------------------------------------------------------------------------
   Magnetic
   -----------------------------------------------------------------------
   Now writes --mag-x/--mag-y custom properties instead of el.style.transform
   directly — an inline transform silently wins over any CSS transform
   (see style.css's own note on why the VU pulse had to use box-shadow for
   exactly this reason), and chapter reveal transforms now live on these
   same elements, so the collision would be real once this ships.
   -------------------------------------------------------------------------- */
const Magnetic = (() => {
  const MAGNETIC_RADIUS = 90;
  const MAGNETIC_STRENGTH = 0.35;
  const MAGNETIC_MAX_OFFSET = 14;

  let elements = [];
  let mouseX = -9999;
  let mouseY = -9999;
  let rafPending = false;
  let bound = false;

  function applyPull() {
    rafPending = false;
    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      const dx = mouseX - (rect.left + rect.width / 2);
      const dy = mouseY - (rect.top + rect.height / 2);
      const dist = Math.hypot(dx, dy);
      if (dist < MAGNETIC_RADIUS) {
        const falloff = 1 - dist / MAGNETIC_RADIUS;
        const pull = falloff * falloff * MAGNETIC_STRENGTH;
        const ox = Math.max(-MAGNETIC_MAX_OFFSET, Math.min(MAGNETIC_MAX_OFFSET, dx * pull));
        const oy = Math.max(-MAGNETIC_MAX_OFFSET, Math.min(MAGNETIC_MAX_OFFSET, dy * pull));
        el.style.setProperty('--mag-x', `${ox.toFixed(1)}px`);
        el.style.setProperty('--mag-y', `${oy.toFixed(1)}px`);
      } else {
        el.style.setProperty('--mag-x', '0px');
        el.style.setProperty('--mag-y', '0px');
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

  function onMouseLeave() {
    elements.forEach((el) => {
      el.style.setProperty('--mag-x', '0px');
      el.style.setProperty('--mag-y', '0px');
    });
  }

  function onFocusIn(e) {
    const el = e.target && e.target.closest && e.target.closest('[data-magnetic]');
    if (el) {
      el.style.setProperty('--mag-x', '0px');
      el.style.setProperty('--mag-y', '0px');
    }
  }

  function init() {
    if (!hasFineHover() || bound) return;
    elements = Array.from(document.querySelectorAll('[data-magnetic]'));
    if (!elements.length) return;
    bound = true;
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseleave', onMouseLeave);
    window.addEventListener('focusin', onFocusIn);
  }

  function destroy() {
    if (!bound) return;
    bound = false;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseleave', onMouseLeave);
    window.removeEventListener('focusin', onFocusIn);
    onMouseLeave();
  }

  return { init, destroy };
})();

onMobileModeChange((coarse) => {
  if (coarse) Magnetic.destroy();
  else Magnetic.init();
});

/* --------------------------------------------------------------------------
   Tilt — opt-in gyroscope parallax, never load-bearing.
   -----------------------------------------------------------------------
   Every consumer reads x/y as an additive offset from 0, so denial,
   absence, reduced-motion and desktop all produce exactly 0 and the site
   is identical minus the parallax. request() must be called with
   transient activation (a real click on the "tilt" control) — iOS shows a
   native permission modal, which is deliberately NOT wired to the first
   tap (see THE DROP below): a system alert on top of that moment would
   ruin it, and can suspend an AudioContext-equivalent mid-animation on
   some WebKit versions.
   -------------------------------------------------------------------------- */
const Tilt = (() => {
  let x = 0;
  let y = 0;
  let active = false;
  const SMOOTH = 0.12;

  function onOrientation(e) {
    if (e.beta == null || e.gamma == null) return;
    const tx = Math.max(-1, Math.min(1, (e.gamma || 0) / 30));
    const ty = Math.max(-1, Math.min(1, ((e.beta || 0) - 45) / 30));
    x += (tx - x) * SMOOTH;
    y += (ty - y) * SMOOTH;
  }

  function attach() {
    if (active || prefersReducedMotion()) return;
    active = true;
    window.addEventListener('deviceorientation', onOrientation, { passive: true });
  }

  function request() {
    if (!('DeviceOrientationEvent' in window) || prefersReducedMotion()) return Promise.resolve(false);
    const gated = typeof DeviceOrientationEvent.requestPermission === 'function';
    if (!gated) {
      attach();
      return Promise.resolve(true);
    }
    return DeviceOrientationEvent.requestPermission()
      .then((state) => {
        if (state === 'granted') {
          attach();
          return true;
        }
        return false;
      })
      .catch(() => false);
  }

  return {
    request,
    get x() {
      return x;
    },
    get y() {
      return y;
    },
    get active() {
      return active;
    },
  };
})();

/* -------------------------------------------------------------------------- */

(() => {
  const body = document.body;
  const html = document.documentElement;
  const themeToggle = document.getElementById('theme-toggle');
  const tiltToggle = document.getElementById('tilt-toggle');
  const chapters = Array.from(document.querySelectorAll('.chapter'));
  const railDots = document.getElementById('rail-dots');
  const railEnergy = document.getElementById('rail-energy');

  document.documentElement.classList.add('js');

  Wave.init();
  Orb.init().catch(() => {});
  Cursor.init();
  Magnetic.init();

  /* ------------------------------------------------------------------
     THE DROP — the site's one entry gesture
     ------------------------------------------------------------------
     No audio to unlock any more, so nothing is functionally gated on
     this tap. The site is alive (the wave idles) from first paint. The
     first interaction of ANY kind (tap/click/key/scroll) fires the DROP:
     the portrait develops, the wave detonates via the reused rave
     envelope, one screen invert, a haptic thump — then the page unlocks
     for scrolling.
     ------------------------------------------------------------------ */
  let entryStarted = false;
  let wakeStartTs = null;
  const WAKE_DURATION_MS = 900;

  function haptic(pattern) {
    if (prefersReducedMotion()) return;
    try {
      navigator.vibrate?.(pattern);
    } catch (err) {
      /* iOS Safari: navigator.vibrate is permanently undefined. No-op. */
    }
  }

  function beginExperience() {
    if (entryStarted) return;
    entryStarted = true;
    body.dataset.state = 'awake';
    html.setAttribute('data-entered', '');
    wakeStartTs = performance.now();

    try {
      Wave.wake(wakeStartTs);
    } catch (err) {
      console.error('[diskevich] Wave.wake() threw.', err);
    }

    Wave.triggerRaveBurst({ durationMs: WAKE_DURATION_MS + 400, attackMs: 260, releaseMs: 500 });

    if (!prefersReducedMotion()) {
      body.classList.add('is-dropping');
      requestAnimationFrame(() => body.classList.add('is-developed'));
      setTimeout(() => body.classList.remove('is-dropping'), WAKE_DURATION_MS + 500);
    } else {
      body.classList.add('is-developed');
    }

    haptic([10, 30, 18]);
  }

  const entryEvents = ['pointerdown', 'touchstart', 'keydown', 'wheel'];
  entryEvents.forEach((evt) =>
    window.addEventListener(evt, beginExperience, { passive: evt !== 'keydown', once: true })
  );
  window.addEventListener('scroll', beginExperience, { passive: true, once: true });

  /* ------------------------------------------------------------------
     Scroll engine — one rAF-throttled handler drives --progress AND
     feeds scroll velocity into Energy, so there is exactly one scroll
     listener on the page.
     ------------------------------------------------------------------ */
  let lastScrollY = window.scrollY;
  let lastScrollT = performance.now();
  let scrollPending = false;
  let lastProgress = -1;
  let scrollingFlag = false;
  let scrollIdleTimer = null;

  function onScroll() {
    if (scrollPending) return;
    scrollPending = true;
    requestAnimationFrame(() => {
      scrollPending = false;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const y = window.scrollY;
      const t = performance.now();
      const dt = Math.max(1, t - lastScrollT);
      const velocity = (y - lastScrollY) / dt; // px/ms
      Energy.scroll(velocity);
      const p = max > 0 ? clamp01(y / max) : 0;
      if (Math.abs(p - lastProgress) > 0.002) {
        lastProgress = p;
        html.style.setProperty('--progress', p.toFixed(4));
      }
      lastScrollY = y;
      lastScrollT = t;
      scrollingFlag = true;
      clearTimeout(scrollIdleTimer);
      scrollIdleTimer = setTimeout(() => {
        scrollingFlag = false;
      }, 150);
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });

  /* ------------------------------------------------------------------
     Chapter activation — a 10%-tall band across the middle of the
     screen, so exactly one chapter is "active" at a time. Drives CSS
     (html[data-chapter]), Wave's per-chapter offset/amplitude, and the
     rail's progress dots.
     ------------------------------------------------------------------ */
  const CHAPTER_WAVE_MODE = {
    'ch-gate': { offset: 0, amp: 0.6 },
    'ch-name': { offset: 60, amp: 0.5 },
    'ch-manifesto': { offset: 0, amp: 0.35 },
    'ch-who': { offset: 0, amp: 0.2 },
    'ch-instrument': { offset: 0, amp: 1.15 },
    'ch-dates': { offset: 0, amp: 0.35 },
    'ch-listen': { offset: 0, amp: 0.35 },
  };

  function setActiveChapter(id) {
    html.dataset.chapter = id;
    const mode = CHAPTER_WAVE_MODE[id] || { offset: 0, amp: 0.5 };
    Wave.setChapterMode(mode.offset, mode.amp);
    if (railDots) {
      const idx = chapters.findIndex((c) => c.id === id);
      Array.from(railDots.children).forEach((dot, i) => {
        dot.classList.toggle('is-active', i === idx);
      });
    }
  }

  if ('IntersectionObserver' in window && chapters.length) {
    const chapterObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) setActiveChapter(entry.target.id);
        });
      },
      { rootMargin: '-45% 0px -45% 0px', threshold: 0 }
    );
    chapters.forEach((c) => chapterObserver.observe(c));
    if (chapters[0]) setActiveChapter(chapters[0].id);
  }

  /* ------------------------------------------------------------------
     The instrument — chapter 04's hit-test surface. Physics is
     untouched; only the binding target changed (see Wave.attachInteraction).
     ------------------------------------------------------------------ */
  const waveStage = document.querySelector('.wave-stage');
  if (waveStage) Wave.attachInteraction(waveStage);

  // Desktop enhancement: on a fine-pointer device, also feed the mouse
  // into the wave from anywhere on the page (not touch — touch stays
  // scoped to the instrument chapter everywhere).
  if (hasFineHover() && waveStage) {
    window.addEventListener('mousemove', (e) => {
      if (!waveStage.contains(document.elementFromPoint(e.clientX, e.clientY))) return;
    });
  }

  /* ------------------------------------------------------------------
     Portrait — develop (GATE) is pure CSS (see body.is-developed in
     style.css); scrub (chapter 03 WHO) is a small veil canvas that
     erodes under the finger and heals over ~2s. Runs only while that
     chapter is active.
     ------------------------------------------------------------------ */
  (() => {
    const stage = document.querySelector('.who-stage');
    const veilCanvas = document.querySelector('.who-veil');
    if (!stage || !veilCanvas) return;
    const vctx = veilCanvas.getContext('2d');
    let vw = 0;
    let vh = 0;
    let veilActive = false;

    function resizeVeil() {
      const rect = stage.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      vw = rect.width;
      vh = rect.height;
      veilCanvas.width = Math.round(vw * dpr);
      veilCanvas.height = Math.round(vh * dpr);
      vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      vctx.globalCompositeOperation = 'source-over';
      vctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim() || '#0a0a0a';
      vctx.fillRect(0, 0, vw, vh);
    }
    if ('ResizeObserver' in window) new ResizeObserver(resizeVeil).observe(stage);
    else window.addEventListener('resize', resizeVeil);
    resizeVeil();

    function erode(x, y) {
      vctx.globalCompositeOperation = 'destination-out';
      const g = vctx.createRadialGradient(x, y, 0, x, y, 70);
      g.addColorStop(0, 'rgba(0,0,0,0.9)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      vctx.fillStyle = g;
      vctx.beginPath();
      vctx.arc(x, y, 70, 0, Math.PI * 2);
      vctx.fill();
      Energy.tap(0.3);
    }

    function heal() {
      vctx.globalCompositeOperation = 'source-over';
      vctx.fillStyle = 'rgba(10,10,10,0.012)';
      vctx.fillRect(0, 0, vw, vh);
    }

    function toStageXY(clientX, clientY) {
      const rect = stage.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    }

    stage.addEventListener(
      'pointermove',
      (e) => {
        if (!veilActive) return;
        const { x, y } = toStageXY(e.clientX, e.clientY);
        if (x >= 0 && y >= 0 && x <= vw && y <= vh) erode(x, y);
      },
      { passive: true }
    );
    stage.addEventListener(
      'touchmove',
      (e) => {
        if (!veilActive) return;
        for (const t of e.touches) {
          const { x, y } = toStageXY(t.clientX, t.clientY);
          if (x >= 0 && y >= 0 && x <= vw && y <= vh) erode(x, y);
        }
      },
      { passive: true }
    );

    onMobileModeChange(() => {}); // placeholder: no mobile-specific behaviour needed here

    function healLoopStep() {
      if (veilActive) heal();
      requestAnimationFrame(healLoopStep);
    }
    requestAnimationFrame(healLoopStep);

    // Only run while the WHO chapter is actually the active one.
    const stageObserver = new MutationObserver(() => {
      veilActive = html.dataset.chapter === 'ch-who';
    });
    stageObserver.observe(html, { attributes: true, attributeFilter: ['data-chapter'] });
    veilActive = html.dataset.chapter === 'ch-who';
  })();

  /* ------------------------------------------------------------------
     Manifesto reveals — per-line, via IntersectionObserver + a CSS
     class-toggle transition (not @keyframes), so prefers-reduced-motion
     is automatically respected through --dur-medium already zeroing.
     ------------------------------------------------------------------ */
  if ('IntersectionObserver' in window) {
    const lineObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) entry.target.classList.add('is-revealed');
        });
      },
      { threshold: 0.5 }
    );
    document.querySelectorAll('.manifesto-line').forEach((el) => lineObserver.observe(el));
  } else {
    document.querySelectorAll('.manifesto-line').forEach((el) => el.classList.add('is-revealed'));
  }

  /* ------------------------------------------------------------------
     Gyro opt-in — an explicit control inside chapter 04, never on the
     first tap (see Tilt's own comment for why).
     ------------------------------------------------------------------ */
  if (tiltToggle) {
    if (!('DeviceOrientationEvent' in window)) {
      tiltToggle.hidden = true;
    } else {
      tiltToggle.addEventListener('click', async () => {
        const granted = await Tilt.request();
        tiltToggle.setAttribute('aria-pressed', String(granted));
        tiltToggle.classList.toggle('is-active', granted);
        haptic(12);
      });
    }
  }

  /* ------------------------------------------------------------------
     Theme toggle — unchanged behaviour from the original file.
     ------------------------------------------------------------------ */
  if (themeToggle) {
    themeToggle.setAttribute('aria-pressed', String(html.getAttribute('data-theme') === 'light'));
    themeToggle.addEventListener('click', () => {
      const next = html.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      html.setAttribute('data-theme', next);
      themeToggle.setAttribute('aria-pressed', String(next === 'light'));
      try {
        localStorage.setItem('diskevich-theme', next);
      } catch (err) {
        /* Private browsing / storage disabled: theme still applies this session. */
      }
      Wave.refreshColors();
      Orb.refreshColors();
      haptic(8);
    });
  }

  window.diskevichDebug = {
    get mobileMode() {
      return mobileMode;
    },
    get progress() {
      return lastProgress;
    },
    get energy() {
      return Energy.bands;
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
    get chapter() {
      return html.dataset.chapter;
    },
    get tiltActive() {
      return Tilt.active;
    },
  };

  /* ------------------------------------------------------------------
     Frame loop — Energy.update() replaces AudioEngine.update(); the wave
     is always "awake" once entryStarted (no more waiting on an audio
     unlock), and continues to idle-breathe via Energy's own floor even
     before the first interaction.
     ------------------------------------------------------------------ */
  let lastTime = 0;
  let rafId = null;
  let lastSleepDrawTs = 0;
  let waveDrawErrorLogged = false;
  let orbRenderErrorLogged = false;
  const SLEEP_REDRAW_INTERVAL_MS = 200;

  function frameLoop(ts) {
    rafId = requestAnimationFrame(frameLoop);
    const dt = lastTime ? ts - lastTime : 0;
    lastTime = ts;

    const awake = body.dataset.state === 'awake';
    // Jank valve: skip every other Wave.draw() while actively scrolling —
    // a full-screen fixed canvas repainting under iOS momentum scroll is
    // the single biggest jank risk in this design.
    if (scrollingFlag && Math.floor(ts / 16) % 2 === 0) return;
    if (!awake && ts - lastSleepDrawTs < SLEEP_REDRAW_INTERVAL_MS) return;
    lastSleepDrawTs = ts;

    let wakeProgress = 0;
    if (awake) {
      wakeProgress = prefersReducedMotion() ? 1 : Math.min(1, (ts - wakeStartTs) / WAKE_DURATION_MS);
    }

    Energy.tilt(Math.hypot(Tilt.x, Tilt.y));
    const bands = Energy.update(dt / 1000);

    try {
      Wave.draw(ts, dt / 1000, bands, wakeProgress, 0, true);
    } catch (err) {
      if (!waveDrawErrorLogged) {
        waveDrawErrorLogged = true;
        console.error('[diskevich] Wave.draw() threw — recovering on next frame.', err);
      }
    }

    html.style.setProperty('--band-bass', bands.bass.toFixed(3));
    html.style.setProperty('--tilt-x', Tilt.x.toFixed(3));
    html.style.setProperty('--tilt-y', Tilt.y.toFixed(3));
    if (railEnergy) {
      const level = clamp01((bands.bass + bands.mid + bands.high) / 2.2);
      railEnergy.style.setProperty('--energy', level.toFixed(3));
    }

    try {
      Orb.render(ts, bands, awake);
    } catch (err) {
      if (!orbRenderErrorLogged) {
        orbRenderErrorLogged = true;
        console.error('[diskevich] Orb.render() threw — recovering on next frame.', err);
      }
    }
  }

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
