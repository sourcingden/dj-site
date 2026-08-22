# Vendored libraries

The site is otherwise dependency-free (see the root of the repo — no `package.json`,
no bundler). This file is the site's only external JS dependency, vendored locally as
a static ES module rather than pulled from a CDN, so the page never depends on a
third-party script host at runtime (the only other external request the site makes is
Google Fonts, in `index.html`).

It's used for the `Orb` accent visual layer on top of the site's own hand-rolled
`AudioEngine`/`Wave` (see `main.js`) — see that file's "Phase 8" comments for how it's
wired in.

## `three.module.js`

- Source: `three@0.160.0`, minified single-file ESM build
  (`build/three.module.min.js` from the npm package).
- License: MIT — see `LICENSE.three.txt`.
- Why this version: the last release where `three.module.js` is one self-contained
  file. Newer releases (0.161+) split the build into `three.module.js` +
  `three.core.js`, which would mean vendoring and keeping two files in sync instead
  of one, for no benefit here — this project only uses long-stable core APIs
  (`WebGLRenderer`, `Scene`, `PerspectiveCamera`, `IcosahedronGeometry`,
  `ShaderMaterial`, `Mesh`, `Color`).
- Only the core module is vendored — no examples/addons (no `OrbitControls`, no
  post-processing) since `Orb` in `main.js` writes its own `ShaderMaterial` and uses a
  static camera.

## Updating

Bump the version in the URL below and re-run, then re-check the "Why this version"
note above still holds before jumping past a major split like the 0.160→0.161 one:

```sh
curl -sSL -o three.module.js "https://unpkg.com/three@<version>/build/three.module.min.js"
```
