# Fraczilla

A GPU deep-zoom fractal explorer in the spirit of the classic DOS fractal programs. It runs entirely in the browser (WebGL2) and needs no build step.

- Smooth wheel, pinch and drag zooming down to about 10³⁰× by using perturbation theory. A Web Worker computes one reference orbit in BigInt fixed point, and the GPU iterates float32 deltas around it, with Zhuoran rebasing to avoid glitches.
- 26 fractal types in a type browser with live thumbnails (`F`):
  - deep zoom (perturbation, to ~10³⁰×): Mandelbrot, Tricorn, Multibrot 3/4/5, Lambda, Burning Ship, Celtic, Buffalo, Perpendicular Burning Ship, Perpendicular Mandelbrot
  - double-float (to ~10¹⁰×): Newton, Halley, Nova, Magnet I/II, Phoenix, Manowar, Spider, Barnsley M1, Sine, Cosine, Exponential
  - beyond escape time: Lyapunov (AB and Zircon Zity) and Plasma
  - most have a Julia counterpart: press SPACE over any point, or click the shown c to type one. `J` turns on a live preview of the Julia set under the mouse
- Journeys: smooth zoom-and-pan flights (van Wijk–Nuij) to curated spots. Curated Julia sets (marked **J**) sit in the same list, and each spot carries its own palette. Phoenix and Lambda open on their famous Julia sets.
- Coloring is a separate pass: 15 palettes plus random ones, color cycling, smooth or banded coloring, 3D lighting, edge ink, and a retro VGA mode.
- Progressive refinement with 2× anti-aliasing when the view is still, PNG export, and shareable URL links.
- **RENDER VIDEO / IMAGE** (`V`): pick an output size (window, 720p, 1080p, 1440p, 4K, square, 4:5, 9:16). A dashed frame shows the part of the view that gets saved; render any journey (or a dive to the current view) as a video, or save the view as a PNG at that size.

Link straight to a journey with `#fly=<name>`, for example https://gh.tschieber.de/fraczilla/#fly=the-abyss. Add `&hq=1` to prerender it in full quality first: the dive is rendered as anti-aliased keyframes one octave apart, composed into a 60 fps WebM video (WebCodecs) and played back; the video can be saved. The **SHARE DIVE TO HERE** button copies a link that replays a dive from the overview to the current view, with the current colors.

Serve the folder statically (for example `python3 -m http.server`) and open `index.html`. Press `H` in the app for the key list.

Before deploying, run `python3 tools/stamp.py`: it version-stamps the asset URLs so browsers never mix cached old modules with new ones.
