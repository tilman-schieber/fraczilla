// The fractal type registry. Everything the UI knows about a type lives here:
// add an entry (plus its shader code) and the panel, type browser, URL links
// and journeys pick it up automatically.
//
// code:    formula id in the shader and reference worker
// deep:    supports perturbation deep zoom (to ~10^30)
// chaotic: abs()-style formula with noisy regions (no meaningful "mirror of c")
// quick:   shown as a quick pick in the panel
// julia:   false if the type has no Julia counterpart
// juliaHome: overview of its Julia sets (default 0, 0, 1.6)
// start:   journey to open the type on (a Julia highlight), instead of home
// seq:     Lyapunov forcing sequence (A/B)
// minScale: zoom floor for float-only types (they top out near 10^5x)

export const FAMILIES = [
  { id: 'mandel', name: 'MANDELBROT FAMILY' },
  { id: 'abs', name: 'ABS() FAMILY' },
  { id: 'roots', name: 'NEWTON & ROOT FINDERS' },
  { id: 'magnet', name: 'MAGNETS' },
  { id: 'classic', name: 'DOS-ERA CLASSICS' },
  { id: 'beyond', name: 'BEYOND ESCAPE TIME' },
];

export const FRACTALS = [
  {
    id: 'mandelbrot', name: 'MANDELBROT', family: 'mandel', code: 0, degree: 2, ySign: 1,
    home: ['-0.6', '0', 1.25], deep: true, quick: true,
    blurb: 'z² + c. The original, with infinite seahorses and minibrots.',
  },
  {
    id: 'burningship', name: 'BURNING SHIP', family: 'abs', code: 1, degree: 2, ySign: -1,
    home: ['-0.4', '-0.55', 1.15], deep: true, chaotic: true,
    blurb: '(|x| + i|y|)² + c. A burning galleon and its cathedral antenna.',
  },
  {
    id: 'tricorn', name: 'TRICORN', family: 'mandel', code: 2, degree: 2, ySign: 1,
    home: ['-0.3', '0', 1.45], deep: true, chaotic: true,
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
  {
    id: 'multibrot5', name: 'MULTIBROT⁵', family: 'mandel', code: 6, degree: 5, ySign: 1,
    home: ['0', '0', 1.2], deep: true,
    blurb: 'z⁵ + c. A four-fold star with five-armed spirals.',
  },
  {
    id: 'lambda', name: 'LAMBDA', family: 'mandel', code: 7, degree: 2, ySign: 1,
    home: ['1', '0', 1.9], deep: true, juliaHome: ['0.5', '0', 0.8], start: 'Lambda Dragon',
    blurb: 'c·z(1−z), the logistic map in the complex plane. Opens on its dragon; SPACE shows the c-plane.',
  },
  {
    id: 'buffalo', name: 'BUFFALO', family: 'abs', code: 8, degree: 2, ySign: -1,
    home: ['-0.45', '-0.3', 1.3], deep: true, chaotic: true,
    blurb: '|Re(z²)| + 2i|xy| + c. Burning Ship meets Celtic: horns and herds.',
  },
  {
    id: 'perpship', name: 'PERP. BURNING SHIP', family: 'abs', code: 9, degree: 2, ySign: 1,
    home: ['-0.5', '0', 1.3], deep: true, chaotic: true,
    blurb: 'x²−y² − 2i·x|y| + c. A ship with perpendicular, crystalline rigging.',
  },
  {
    id: 'perpmandel', name: 'PERP. MANDELBROT', family: 'abs', code: 10, degree: 2, ySign: 1,
    home: ['-0.5', '0', 1.3], deep: true, chaotic: true,
    blurb: 'x²−y² − 2i·|x|y + c. Mandelbrot, folded: seahorses grow antlers.',
  },
  {
    id: 'newton', name: 'NEWTON', family: 'roots', code: 100, degree: 2, ySign: 1,
    home: ['0', '0', 1.6], julia: false,
    blurb: "Newton's method on z³ − 1. Three basins braided along infinitely fine borders.",
  },
  {
    id: 'nova', name: 'NOVA', family: 'roots', code: 101, degree: 2, ySign: 1,
    home: ['-0.6', '0', 0.45], quick: true,
    blurb: 'Newton + c. Converging orbits paint a set full of Newton-ish minibrots.',
  },
  {
    id: 'magnet1', name: 'MAGNET I', family: 'magnet', code: 102, degree: 2, ySign: 1,
    home: ['1.6', '0', 2.6], quick: true, juliaHome: ['1', '0', 2.5],
    blurb: '((z² + c − 1) / (2z + c − 2))². Born from the physics of magnets.',
  },
  {
    id: 'magnet2', name: 'MAGNET II', family: 'magnet', code: 103, degree: 2, ySign: 1,
    home: ['1.2', '0', 2.4], juliaHome: ['1', '0', 2.5],
    blurb: 'The cubic magnet formula: lumpier, with nested hearts.',
  },
  {
    id: 'halley', name: 'HALLEY', family: 'roots', code: 111, degree: 2, ySign: 1,
    home: ['0', '0', 1.4], julia: false,
    blurb: "Halley's method on z⁵ − 1: Newton's sharper cousin, with jewelled basin borders.",
  },
  {
    id: 'phoenix', name: 'PHOENIX', family: 'classic', code: 109, degree: 2, ySign: 1,
    home: ['-0.35', '0', 1.0], start: 'Phoenix Bird',
    blurb: "z² + c − ½·z₋₁. Remembers its last step. Opens on the classic bird at c = 0.5667.",
  },
  {
    id: 'manowar', name: 'MANOWAR', family: 'classic', code: 110, degree: 2, ySign: 1,
    home: ['-0.05', '0', 0.3],
    blurb: 'z² + z₋₁ + c. A Mandelbrot with trailing jellyfish tentacles.',
  },
  {
    id: 'spider', name: 'SPIDER', family: 'classic', code: 104, degree: 2, ySign: 1,
    home: ['-0.4', '0', 1.4], quick: true, julia: false,
    blurb: 'z = z² + c, c = c/2 + z. A Mandelbrot whose c wanders along.',
  },
  {
    id: 'barnsley1', name: 'BARNSLEY M1', family: 'classic', code: 105, degree: 2, ySign: 1,
    home: ['0', '0', 1.6],
    blurb: "(z ∓ 1)·c by the sign of Re z. Michael Barnsley's piecewise classic.",
  },
  {
    id: 'sine', name: 'SINE', family: 'classic', code: 106, degree: 2, ySign: 1,
    home: ['0', '0', 3.2], juliaHome: ['0', '0', 3.2],
    blurb: 'c·sin(z). Transcendental: an endless row of Mandelbrot-like bugs.',
  },
  {
    id: 'cosine', name: 'COSINE', family: 'classic', code: 112, degree: 2, ySign: 1,
    home: ['1.5', '0', 2.4], juliaHome: ['0', '0', 3.2],
    blurb: 'cos(z) + c. A transcendental set that repeats every 2π along the real axis.',
  },
  {
    id: 'exp', name: 'EXPONENTIAL', family: 'classic', code: 113, degree: 2, ySign: 1,
    home: ['1', '0', 5], juliaHome: ['0', '0', 3],
    blurb: 'c·eᶻ. Cantor bouquets: infinitely many hairs combed out to the right.',
  },
  {
    id: 'lyapunov', name: 'LYAPUNOV AB', family: 'beyond', code: 107, degree: 2, ySign: 1,
    home: ['3', '3', 1.05], quick: true, julia: false, seq: 'AB',
    blurb: 'Order vs chaos of the logistic map, alternating rates a and b.',
  },
  {
    id: 'zircon', name: 'ZIRCON ZITY', family: 'beyond', code: 107, degree: 2, ySign: 1,
    home: ['3.7', '2.95', 0.42], julia: false, seq: 'BBBBBBAAAAAA',
    blurb: 'Lyapunov with sequence BBBBBBAAAAAA: the famous golden city.',
  },
  {
    id: 'plasma', name: 'PLASMA', family: 'beyond', code: 108, degree: 2, ySign: 1,
    home: ['0', '0', 1.5], julia: false, minScale: 1e-4,
    blurb: 'Fractal noise clouds. Turn on color cycling for the full DOS effect.',
  },
];

export const byId = (id) => FRACTALS.find((f) => f.id === id);
