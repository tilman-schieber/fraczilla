# Fraczilla

A GPU deep-zoom fractal explorer in the spirit of the classic DOS fractal programs. It runs entirely in the browser (WebGL2) and needs no build step.

- Smooth wheel, pinch and drag zooming down to about 10³⁰× by using perturbation theory. A Web Worker computes one reference orbit in BigInt fixed point, and the GPU iterates float32 deltas around it, with Zhuoran rebasing to avoid glitches.
- Mandelbrot, Burning Ship, Tricorn, Celtic and Multibrot 3/4, each with a Julia counterpart (press SPACE over any point).
- Journeys: smooth zoom-and-pan flights (van Wijk–Nuij) to curated spots, plus an endless autopilot dive.
- Coloring is a separate pass: 15 palettes plus random ones, color cycling, smooth or banded coloring, 3D lighting, edge ink, and a retro VGA mode.
- Progressive refinement with 2× anti-aliasing when the view is still, PNG export, and shareable URL links.

Link straight to a journey with `#fly=<name>`, for example https://gh.tschieber.de/fraczilla/#fly=the-abyss.

Serve the folder statically (for example `python3 -m http.server`) and open `index.html`. Press `H` in the app for the key list.
