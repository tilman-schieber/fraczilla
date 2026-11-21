// The fractal type registry. Everything the UI knows about a type lives here:
// add an entry (plus its shader code) and the panel, type browser, URL links
// and journeys pick it up automatically.
//
// code:    formula id in the shader and reference worker
// deep:    supports perturbation deep zoom (to ~10^30)
// chaotic: abs()-style formula with noisy regions (autopilot looks ahead)
// quick:   shown as a quick pick in the panel

export const FAMILIES = [
  { id: 'mandel', name: 'MANDELBROT FAMILY' },
  { id: 'abs', name: 'ABS() FAMILY' },
];

export const FRACTALS = [
  {
    id: 'mandelbrot', name: 'MANDELBROT', family: 'mandel', code: 0, degree: 2, ySign: 1,
    home: ['-0.6', '0', 1.25], deep: true, quick: true,
    blurb: 'z² + c. The original, with infinite seahorses and minibrots.',
  },
  {
    id: 'burningship', name: 'BURNING SHIP', family: 'abs', code: 1, degree: 2, ySign: -1,
    home: ['-0.4', '-0.55', 1.15], deep: true, quick: true, chaotic: true,
    blurb: '(|x| + i|y|)² + c. A burning galleon and its cathedral antenna.',
  },
  {
    id: 'tricorn', name: 'TRICORN', family: 'mandel', code: 2, degree: 2, ySign: 1,
    home: ['-0.3', '0', 1.45], deep: true, quick: true, chaotic: true,
    blurb: 'conj(z)² + c, the "Mandelbar". Three-cornered, with zebra cliffs.',
  },
  {
    id: 'multibrot3', name: 'MULTIBROT³', family: 'mandel', code: 4, degree: 3, ySign: 1,
    home: ['0', '0', 1.3], deep: true,
    blurb: 'z³ + c. Two-fold symmetry and three-armed spirals.',
  },
  {
    id: 'multibrot4', name: 'MULTIBROT⁴', family: 'mandel', code: 5, degree: 4, ySign: 1,
    home: ['-0.15', '0', 1.25], deep: true,
    blurb: 'z⁴ + c. Three-fold symmetry and four-armed blooms.',
  },
  {
    id: 'celtic', name: 'CELTIC', family: 'abs', code: 3, degree: 2, ySign: 1,
    home: ['-0.4', '0', 1.3], deep: true, chaotic: true,
    blurb: '|Re(z²)| + i·Im(z²) + c. Knotwork shores and floating islands.',
  },
];

export const byId = (id) => FRACTALS.find((f) => f.id === id);
