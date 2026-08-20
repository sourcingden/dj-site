/* ==========================================================================
   diskevich — main.js
   Phase 0: skeleton wiring only.

   - tap-to-enter flips body[data-state] to "awake". This is the seam where
     Phase 1 will hook AudioContext.resume() + track playback (must happen
     inside this same user-gesture handler for autoplay policies).
   - Nav / mute / overlay open-close logic is intentionally not wired yet —
     that lands in Phase 1 (audio + mute) and Phase 4 (overlays + focus trap).
   ========================================================================== */

(() => {
  const body = document.body;
  const tapToEnter = document.getElementById('tap-to-enter');

  tapToEnter.addEventListener('click', () => {
    if (body.dataset.state === 'awake') return;
    body.dataset.state = 'awake';
    // TODO Phase 1: resume AudioContext + start track playback here.
  });
})();
