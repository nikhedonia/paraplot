export interface Preset {
  id: string;
  name: string;
  blurb: string;
  source: string;
}

// A plain template (not String.raw) so this example can itself contain a
// template literal; backticks and ${ must be escaped for the outer string.
const BRACKET = `// paraplot — a parametric handle bracket
// Everything below is a pure function of params.

export const params = {
  span:   num(2.4,  { min: 1.2, max: 4.0, step: 0.01,  label: 'span' }),
  depth:  num(1.15, { min: 0.5, max: 2.2, step: 0.01,  label: 'depth' }),
  plate:  num(0.14, { min: 0.06, max: 0.4, step: 0.005, label: 'plate' }),
  lift:   num(1.45, { min: 0.4, max: 3.0, step: 0.01,  label: 'lift' }),
  tube:   num(0.055,{ min: 0.02, max: 0.14, step: 0.002, label: 'tube' }),
  holes:  int(4,    { min: 1, max: 8, label: 'holes' }),
  blend:  num(0.05, { min: 0.0, max: 0.25, step: 0.002, label: 'blend' }),
  finish: color('#c3ccd6', 'finish'),
  accent: color('#c08552', 'accent'),
  drill:  bool(true, 'drill holes'),
};

export default function build(k) {
  const W = k.span, D = k.depth, T = k.plate;
  const end = W / 2 - 0.12;

  // --- base plate, a rounded box resting on y = 0
  const plate = group({ name: 'plate', t: [0, T / 2, 0] },
    paint(box({ s: [W / 2, T / 2, D / 2], round: 0.035 }), k.finish));

  // --- two spline rails (drag their control points in the spline dock)
  const railAt = (z) => {
    const points = range(5).map((i) => {
      const t = i / 4;
      return [lerp(-end, end, t), T - 0.05 + k.lift * Math.sin(Math.PI * t), z];
    });
    return group({ name: z < 0 ? 'rail left' : 'rail right' },
      paint(spline({ points, r: k.tube, seg: 12 }), k.accent));
  };

  // --- a cross bar joins the two rails into a handle
  const bar = group({ name: 'bar' },
    paint(capsule({
      a: [0, T - 0.05 + k.lift, -D * 0.3],
      b: [0, T - 0.05 + k.lift,  D * 0.3],
      r: k.tube,
    }), k.accent));

  const body = smoothUnion(k.blend,
    plate,
    railAt(-D * 0.3),
    railAt(D * 0.3),
    bar);

  // --- holes drilled straight through the plate
  const holes = range(k.holes).map((i) => {
    const n = Math.max(1, k.holes - 1);
    const x = n === 1 ? 0 : lerp(-W / 2 + 0.32, W / 2 - 0.32, i / n);
    return group({ name: \`hole \${i + 1}\` },
      translate([x, T / 2, 0], cylinder({ r: 0.075, h: T * 4, round: 0.01 })));
  });

  return k.drill ? subtract(body, ...holes) : body;
}
`;

const VASE = String.raw`// paraplot — a lathe turned vessel
// The profile is a 2d spline: edit it in the spline dock.

export const params = {
  height: num(1.85, { min: 0.8, max: 3.0, step: 0.01,  label: 'height' }),
  width:  num(0.62, { min: 0.15, max: 1.2, step: 0.005, label: 'width' }),
  neck:   num(0.28, { min: 0.06, max: 0.62, step: 0.005, label: 'neck' }),
  wall:   num(0.055, { min: 0.02, max: 0.14, step: 0.002, label: 'wall' }),
  hollow: bool(true, 'hollow'),
  clay:   color('#cfd2c9', 'clay'),
  glaze:  color('#3f7a72', 'glaze'),
  band:   num(0.16, { min: 0.0, max: 0.4, step: 0.005, label: 'band' }),
};

export default function build(k) {
  const h = k.height, w = k.width, n = k.neck;

  // [radius, y] pairs, from the foot to the rim
  const profile = [
    [0.0,        0.0],
    [w * 0.55,   0.0],
    [w * 0.74,   h * 0.07],
    [w,          h * 0.30],
    [w * 0.93,   h * 0.47],
    [w * 0.56,   h * 0.68],
    [n,          h * 0.87],
    [n * 1.10,   h * 0.965],
    [n * 0.92,   h],
    [0.0,        h],
  ];

  const outer = paint(lathe({ points: profile, seg: 10, name: 'vessel' }), k.clay);

  // a glaze band near the base
  const bandProfile = profile.map(([r, y]) => [r + 0.004, y]);
  const band = paint(
    intersect(
      lathe({ points: bandProfile, seg: 10, name: 'band' }),
      translate([0, k.band * 0.5, 0], box({ s: [w * 2, k.band * 0.5, w * 2] }))
    ),
    k.glaze);

  // hollow it out with a second, offset lathe
  const inner = profile.map(([r, y]) => [Math.max(0, r - k.wall), y + k.wall * 0.45]);
  const cavity = lathe({ points: inner, seg: 10, name: 'cavity' });

  const vessel = k.hollow ? subtract(outer, cavity) : outer;
  return union(vessel, band);
}
`;

const GYROID = String.raw`// paraplot — a gyroid lattice
// An implicit surface, clipped by a sphere.

export const params = {
  freq:   num(6.0,  { min: 2.0, max: 12.0, step: 0.05, label: 'frequency' }),
  thick:  num(0.46, { min: 0.12, max: 0.9, step: 0.01, label: 'thickness' }),
  radius: num(1.30, { min: 0.7, max: 2.0, step: 0.01,  label: 'radius' }),
  core:   num(0.55, { min: 0.0, max: 1.0, step: 0.01,  label: 'core' }),
  motion: num(0.5,  { min: 0.0, max: 2.0, step: 0.01,  label: 'motion' }),
  tint:   color('#7fa6a0', 'tint'),
};

export default function build(k) {
  const f = k.freq;

  // classic gyroid: sin(x)cos(y) + sin(y)cos(z) + sin(z)cos(x)
  // the equation is compiled by the built-in expression parser.
  // time is a shader uniform, so this animates without recompiling anything.
  const gyroid = group({ name: 'gyroid' }, implicit(
    'abs(sin(x*f + time*sp) * cos(y*f) + sin(y*f + time*sp) * cos(z*f) + sin(z*f) * cos(x*f + time*sp)) - th',
    { vars: { f: k.freq, th: k.thick, sp: k.motion }, bounds: 1.6 }));

  const ball = sphere({ r: k.radius });
  const lattice = intersect(gyroid, ball);

  if (k.core <= 0.001) return paint(lattice, k.tint);

  const hole = sphere({ r: k.core });
  return paint(intersect(subtract(ball, hole), gyroid), k.tint);
}
`;

const ORBIT = String.raw`// paraplot — a scene that moves
// The second argument is time in seconds. The scene is still a pure function
// of (parameters, time), so it is deterministic and replayable.

export const params = {
  count:  int(7,    { min: 3, max: 14, label: 'orbs' }),
  radius: num(1.15, { min: 0.6, max: 2.0, step: 0.01 }),
  size:   num(0.18, { min: 0.06, max: 0.34, step: 0.005 }),
  speed:  num(0.18, { min: -1.0, max: 1.0, step: 0.005, label: 'speed', unit: 'rev/s' }),
  wobble: num(0.45, { min: 0.0, max: 1.2, step: 0.01 }),
  tilt:   num(20,   { min: 0, max: 65, step: 0.5 }),
  gold:   color('#d9a05b', 'orbs'),
  steel:  color('#aebbc7', 'frame'),
};

export default function build(k, t) {
  const phase = t * k.speed * TAU;

  const orbs = range(k.count).map((i) => {
    const a = (i / k.count) * TAU + phase;
    const y = Math.sin(a * 2 + phase * 0.5) * k.wobble * 0.45;
    const r = k.size * (0.78 + 0.22 * Math.sin(a * 3 - phase));
    return group({ name: 'orb ' + (i + 1) },
      paint(translate([Math.cos(a) * k.radius, y, Math.sin(a) * k.radius], sphere({ r })), k.gold));
  });

  const rig = group({ name: 'rig', r: [k.tilt, 0, 0] },
    paint(torus({ R: k.radius, r: 0.032 }), k.steel),
    ...orbs);

  const core = group({ name: 'core' },
    paint(rotate([phase * 0.6, phase, phase * 0.3],
      box({ s: [0.24, 0.24, 0.24], round: 0.07 })), k.steel));

  return union(rig, core);
}
`;

export const PRESETS: Preset[] = [
  { id: 'bracket', name: 'Handle bracket', blurb: 'groups · set ops · splines', source: BRACKET },
  { id: 'vase', name: 'Lathe vessel', blurb: 'revolve · profiles · subtract', source: VASE },
  { id: 'gyroid', name: 'Gyroid lattice', blurb: 'implicit equation · shader clock', source: GYROID },
  { id: 'orbit', name: 'Orbital rig', blurb: 'animated · build(k, t)', source: ORBIT },
];

export const DEFAULT_SOURCE = BRACKET;
