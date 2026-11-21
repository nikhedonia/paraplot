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

  // --- one spline, instanced twice with a transform. Both rails are the same
  // curve, so they stay identical and change together in the spline editor.
  const offset = D * 0.3;
  const railCurve = spline({
    name: 'rail',
    points: range(5).map((i) => {
      const t = i / 4;
      return [lerp(-end, end, t), T - 0.05 + k.lift * Math.sin(Math.PI * t), 0];
    }),
    r: k.tube,
    seg: 12,
  });

  const railPaint = paint(railCurve, k.accent);
  const railLeft = group({ name: 'rail left' },
    translate([0, 0, -offset], railPaint));
  const railRight = group({ name: 'rail right' },
    translate([0, 0, offset], railPaint));

  // --- the cross bar is anchored to the shared spline apex. at() returns an
  // opaque point reference, resolved after spline edits.
  const bar = group({ name: 'bar' },
    translate(railCurve.at(0.5),
      paint(capsule({ a: [0, 0, -offset], b: [0, 0, offset], r: k.tube }), k.accent)));

  const body = smoothUnion(k.blend,
    plate,
    railLeft,
    railRight,
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


const DOG = String.raw`// paraplot — a dog that wags its tail
// The second argument is time; everything except the tail is static.

export const params = {
  wag:    num(0.30, { min: 0.0, max: 0.7, step: 0.01, label: 'tail wag' }),
  speed:  num(1.10, { min: 0.1, max: 3.0, step: 0.05, label: 'wag speed' }),
  lift:   num(0.70, { min: 0.0, max: 1.0, step: 0.01, label: 'tail lift' }),
  collar: bool(true, 'collar'),
  fur:    color('#c08a5a', 'fur'),
  dark:   color('#6a4630', 'ears & nose'),
  red:    color('#c94f3d', 'collar'),
  cream:  color('#efd9b4', 'tail tip'),
};

export default function build(k, t) {
  // --- tail: a spline with a travelling wave, anchored to its own tip
  const tailPoints = range(6).map((i) => {
    const u = i / 5;
    const sway = Math.sin(t * k.speed * TAU - u * 2.4) * k.wag * Math.pow(u, 1.4);
    return [-0.52 - u * 0.62, 0.80 + u * 0.50 * k.lift, sway];
  });
  const tail = spline({ name: 'tail', points: tailPoints, r: 0.055, seg: 8 });

  // --- body, blended
  const torso  = translate([0, 0.60, 0], ellipsoid({ r: [0.55, 0.28, 0.27] }));
  const chest  = translate([0.34, 0.63, 0], sphere({ r: 0.27 }));
  const haunch = translate([-0.36, 0.60, 0], sphere({ r: 0.29 }));
  const neck   = capsule({ a: [0.42, 0.78, 0], b: [0.68, 1.00, 0], r: 0.15 });
  const head   = translate([0.82, 1.07, 0], ellipsoid({ r: [0.27, 0.24, 0.23] }));
  const snout  = translate([1.02, 0.99, 0], ellipsoid({ r: [0.17, 0.11, 0.12] }));

  const leg = (x, z, r) => capsule({ a: [x, 0.55, z], b: [x + 0.02, 0.10, z * 1.1], r });
  const paw = (x, z) => translate([x + 0.05, 0.055, z * 1.1], ellipsoid({ r: [0.10, 0.055, 0.08] }));

  return group({ name: 'dog' },
    smoothUnion(0.05,
      paint(torso, k.fur),
      paint(chest, k.fur),
      paint(haunch, k.fur),
      paint(neck, k.fur),
      paint(head, k.fur),
      paint(snout, k.fur),
      paint(leg(0.38, -0.18, 0.065), k.fur),
      paint(leg(0.38,  0.18, 0.065), k.fur),
      paint(leg(-0.35, -0.18, 0.07), k.fur),
      paint(leg(-0.35,  0.18, 0.07), k.fur),
      paint(paw(0.40, -0.18), k.dark),
      paint(paw(0.40,  0.18), k.dark),
      paint(paw(-0.37, -0.18), k.dark),
      paint(paw(-0.37,  0.18), k.dark),
      paint(tail, k.fur)),

    // floppy ears, eyes and nose
    paint(capsule({ a: [0.80, 1.24, -0.17], b: [0.72, 0.98, -0.27], r: 0.06 }), k.dark),
    paint(capsule({ a: [0.80, 1.24,  0.17], b: [0.72, 0.98,  0.27], r: 0.06 }), k.dark),
    paint(translate([1.00, 1.11, -0.15], sphere({ r: 0.04 })), k.dark),
    paint(translate([1.00, 1.11,  0.15], sphere({ r: 0.04 })), k.dark),
    paint(translate([1.17, 1.00, 0], sphere({ r: 0.05 })), k.dark),

    // cream tip follows the tail (opaque reference)
    translate(tail.at(1), paint(sphere({ r: 0.075 }), k.cream)),

    k.collar ? paint(translate([0.58, 0.90, 0], rotate([0, 0, -52], torus({ R: 0.19, r: 0.035 }))), k.red) : null,
  );
}
`;


const IMPELLER = String.raw`// paraplot — a centrifugal impeller
// Blades are ruled surfaces lofted between two edge splines:
// the root curve sits on the disc, the tip curve twists with "lean".

export const params = {
  blades:    int(7,    { min: 3, max: 12, label: 'blades' }),
  radius:    num(1.25, { min: 0.7, max: 1.7, step: 0.01,  label: 'radius' }),
  sweep:     num(52,   { min: 0, max: 90, step: 0.5,    label: 'sweep', unit: 'deg' }),
  lean:      num(1.25, { min: 0.4, max: 2.0, step: 0.01, label: 'blade lean' }),
  height:    num(0.50, { min: 0.15, max: 0.9, step: 0.01, label: 'blade height' }),
  thickness: num(0.06, { min: 0.025, max: 0.14, step: 0.002, label: 'blade thickness' }),
  hub:       num(0.34, { min: 0.18, max: 0.5, step: 0.005, label: 'hub radius' }),
  spin:      num(0.12, { min: 0.0, max: 1.0, step: 0.005, label: 'spin', unit: 'rev/s' }),
  steel:     color('#b9c2c9', 'steel'),
  brass:     color('#c08a4a', 'blades'),
};

export default function build(k, t) {
  const R = k.radius, hubR = k.hub, H = k.height, T = k.thickness;
  const discH = 0.14;
  const baseY = discH;

  // --- construction curves: the root and tip edges of a backward spiral
  const edge = (y, sweep) => range(6).map((i) => {
    const u = i / 5;
    const r = lerp(hubR - 0.02, R, u);
    const a = rad(sweep) * Math.pow(u, 1.2);
    return [Math.cos(a) * r, y, -Math.sin(a) * r];
  });

  const rootEdge = spline({ name: 'blade root', points: edge(baseY, k.sweep), r: 0.02, seg: 12 });
  const tipEdge  = spline({ name: 'blade tip',  points: edge(baseY + H, k.sweep * k.lean), r: 0.02, seg: 12 });

  // --- one blade: ruled surface root(t) --- tip(t), linear connect
  // the connect is GLSL and runs on the GPU; linear is the default
  const blade = surface({
    a: rootEdge,
    b: tipEdge,
    thickness: T,
    // the construction curves are sampled at 32 points; denser rulings do not
    // add edge detail and triple the cost of the overlapping-sector fold
    samples: 32,
    connect: 'return mix(a, b, s);',
  });

  // one blade, folded around the axis on the GPU: the shader evaluates only the
  // sectors the swept blade actually overlaps, whatever the blade count is
  const spread = k.sweep * Math.max(1, k.lean);
  const blades = paint(
    polarRepeat({ count: k.blades, spread, name: 'blades' }, blade),
    k.brass,
  );

  // --- disc, rim and lathe hub
  const disc = paint(translate([0, discH * 0.5, 0],
    cylinder({ r: R + 0.12, h: discH, round: 0.04 })), k.steel);

  const rim = paint(translate([0, discH, 0],
    torus({ R: R + 0.1, r: 0.045 })), k.steel);

  const hubTop = discH + H + 0.12;
  const hub = paint(lathe({
    name: 'hub',
    points: [
      [0, discH * 0.5],
      [hubR + 0.06, discH * 0.5],
      [hubR, discH * 0.7],
      [hubR, discH + H * 0.6],
      [hubR * 0.8, hubTop - 0.05],
      [hubR * 0.45, hubTop],
      [0, hubTop + 0.02],
    ],
    seg: 10,
  }), k.steel);

  // --- assemble and bore the shaft hole
  const body = union(disc, rim, hub, blades);
  const drilled = subtract(body, cylinder({ r: hubR * 0.32, h: 4, round: 0.01 }));

  return rotate([0, t * k.spin * 360, 0], drilled);
}
`;

export const PRESETS: Preset[] = [
  { id: 'bracket', name: 'Handle bracket', blurb: 'groups · set ops · splines', source: BRACKET },
  { id: 'vase', name: 'Lathe vessel', blurb: 'revolve · profiles · subtract', source: VASE },
  { id: 'gyroid', name: 'Gyroid lattice', blurb: 'implicit equation · shader clock', source: GYROID },
  { id: 'orbit', name: 'Orbital rig', blurb: 'animated · build(k, t)', source: ORBIT },
  { id: 'dog', name: 'Wagging dog', blurb: 'animated · spline tail', source: DOG },
  { id: 'impeller', name: 'Impeller', blurb: 'ruled blades · animated', source: IMPELLER },
];

export const DEFAULT_SOURCE = BRACKET;
