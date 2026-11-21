/**
 * Headless sanity checks for the pure pipeline.
 *   npm run check
 */
import { compileScene } from '../src/core/compile';
import { PRESETS } from '../src/core/presets';
import { compileExpression } from '../src/core/expr';
import { curvatureCombs, sampleSpline } from '../src/core/spline';
import { normalizeHexColor } from '../src/core/math';
import { STARTER_SOURCE } from '../src/store/projects';
import type { Node } from '../src/core/types';

let failures = 0;
const ok = (cond: unknown, label: string) => {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}`);
  }
};

for (const preset of PRESETS) {
  console.log(`\n${preset.name}`);
  const base = compileScene(preset.source, {}, {});
  ok(base.ok, `compiles${base.ok ? '' : `: ${base.error}`}`);
  if (!base.ok) continue;

  const p = base.program;
  ok(p.stats.nodes > 0, `${p.stats.nodes} nodes`);
  ok(p.glsl.includes('#version 300 es'), 'emits an ES 3.00 shader');
  ok(p.bounds.min.every(Number.isFinite) && p.bounds.max.every(Number.isFinite), 'finite bounds');
  ok(p.values.length >= p.stats.values, 'value pool matches');
  ok(p.materials.length >= 1, `${p.materials.length} materials`);
  ok(
    base.animated === (preset.id === 'orbit' || preset.id === 'dog' || preset.id === 'impeller'),
    `animated flag is ${base.animated}`,
  );
  ok(sampleSpline([[0, 0, 0], [1, 1, 0], [2, 0, 0]], false, 8).length > 3, 'spline sampling');
  ok(compileExpression('x*x + y*y - 1').length > 0, 'expression parser');

  // parameters are uniforms: as long as the tree shape is unchanged, the
  // shader text must be identical (so dragging a slider never recompiles)
  const keys = Object.keys(base.schema);
  const tweaked: Record<string, unknown> = {};
  for (const key of keys) {
    const c = base.schema[key] as { __ctl?: string; min?: number; max?: number };
    if (!c.__ctl) continue;
    if (c.__ctl === 'number' || c.__ctl === 'int') tweaked[key] = (c.min! + c.max!) / 2;
    if (c.__ctl === 'bool') tweaked[key] = false;
  }
  const changed = compileScene(preset.source, tweaked as Record<string, never>, {});
  ok(changed.ok, 'compiles with modified parameters');
  if (changed.ok) {
    ok(changed.program.values.some((v, i) => v !== p.values[i]), 'uniform values actually change');
  }

  let stable = 0;
  let recompiled = 0;
  for (const key of keys) {
    const c = base.schema[key] as { __ctl?: string; min?: number; max?: number };
    if (!c.__ctl) continue;
    let v: unknown = (c.min! + c.max!) / 2;
    if (c.__ctl === 'bool') v = false;
    if (c.__ctl === 'color') v = '#ff8800';
    if (c.__ctl === 'select') continue;
    const one = compileScene(preset.source, { [key]: v } as Record<string, never>, {});
    if (!one.ok) {
      failures++;
      console.log(`  FAIL ${key}: ${one.error}`);
      continue;
    }
    if (one.program.stats.nodes === p.stats.nodes) {
      stable++;
      if (one.program.glsl !== p.glsl) {
        failures++;
        console.log(`  FAIL ${key}: shader changed although the tree did not`);
      }
    } else {
      recompiled++;
    }
  }
  ok(stable > 0 && recompiled <= keys.length, `${stable} params are uniform-only, ${recompiled} change structure`);

  // time is an input to the same pure function
  const at1 = compileScene(preset.source, {}, {}, 1.0);
  ok(at1.ok, 'compiles at t = 1');
  if (at1.ok) {
    ok(at1.program.glsl === p.glsl, 'time does not change the shader text');
    const moved = at1.program.values.some((v, i) => v !== p.values[i]);
    if (preset.id === 'orbit' || preset.id === 'dog' || preset.id === 'impeller') {
      ok(moved, 'build(k, t) responds to time');
    }
    if (preset.id === 'gyroid') {
      ok(p.usesTime, 'implicit reads the shader clock');
      ok(!moved, 'implicit time stays a uniform');
    }
  }

  // spline overrides flow through
  if (p.splines.length > 0) {
    const s = p.splines[0];
    const delta = s.points.map((_, i) => {
      const d = new Array(s.dim).fill(0);
      if (i === 0) d[0] = 0.01;
      return d;
    });
    const withOffset = compileScene(preset.source, {}, { [s.id]: delta });
    ok(withOffset.ok, 'compiles with spline offsets');
    if (withOffset.ok) {
      const after = withOffset.program.splines.find((x) => x.id === s.id);
      ok(!!after && Math.abs(after.points[0][0] - (s.points[0][0] + 0.01)) < 1e-9, 'offset is applied');
      ok(withOffset.program.glsl === p.glsl, 'shader text stable while dragging splines');
    }
  }
}

console.log('\nerrors');
const bad = compileScene('export default () => sphere({ r: -1 })', {}, {});
ok(!bad.ok && /radius|r/.test(bad.error), 'invalid primitive reports a useful error');
const badSyntax = compileScene('export default (k) => {', {}, {});
ok(!badSyntax.ok, 'syntax errors are captured');
const noScene = compileScene('export const params = {}', {}, {});
ok(!noScene.ok && /default/.test(noScene.error), 'missing scene is reported');
try {
  compileExpression('x * nope');
  ok(false, 'unknown identifier rejected');
} catch (e) {
  ok(/unknown identifier/.test((e as Error).message), 'unknown identifier rejected');
}

console.log('\ncurvature comb');
const circle = Array.from({ length: 48 }, (_, i) => [
  Math.cos((i / 48) * Math.PI * 2) * 2,
  Math.sin((i / 48) * Math.PI * 2) * 2,
]);
const combs = curvatureCombs(circle, true, 1);
ok(combs.spikes.length === 48, 'one spike per sample');
ok(Math.abs(combs.maxK - 0.5) < 1e-3, 'circle curvature is 1/R');
ok(
  combs.spikes.every((s) => s.point[0] * s.dir[0] + s.point[1] * s.dir[1] > 0),
  'spikes point outward',
);

console.log('\nspline point references');
const REF_SRC = String.raw`
export default function build() {
  const rail = spline({ name: 'rail', points: [[0, 0, 0], [1, 1, 0], [2, 0, 0]], r: 0.05, seg: 8 });
  return union(
    paint(rail, '#aebbc7'),
    group({ name: 'bar' }, paint(capsule({ a: rail.at(0.5), b: [0, 0, 0], r: 0.02 }), '#e0a267')),
    group({ name: 'anchor', t: rail.at(0.25) }, sphere({ r: 0.1 })),
  );
}`;

const findNodes = (root: Node, pred: (n: Node) => boolean, out: Node[] = []): Node[] => {
  if (pred(root)) out.push(root);
  if (root.kind === 'group' || root.kind === 'op') root.children.forEach((c) => findNodes(c, pred, out));
  else if (root.kind === 'paint' || root.kind === 'offset' || root.kind === 'shell') findNodes(root.child, pred, out);
  return out;
};
const near = (a: number[], b: number[], eps = 1e-3) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps);

const refs = compileScene(REF_SRC, {}, {});
ok(refs.ok, `spline refs compile${refs.ok ? '' : `: ${refs.error}`}`);
if (refs.ok) {
  const capsule = findNodes(refs.program.scene, (n) => n.kind === 'capsule')[0] as any;
  ok(capsule && near(capsule.a, [1, 1, 0]), 'capsule endpoint resolves to the curve midpoint');
  ok(capsule && !capsule.aRef, 'reference is resolved before rendering');
  const anchor = findNodes(refs.program.scene, (n) => (n as any).name === 'anchor')[0] as any;
  ok(anchor && Math.hypot(...anchor.t) > 0.1 && !anchor.tRef, 'translations resolve references');

  const moved = compileScene(
    REF_SRC,
    {},
    { rail: [[0, 0, 0], [0, 1, 0], [0, 0, 0]] },
  );
  ok(moved.ok, 'refs compile with spline overrides');
  if (moved.ok) {
    const capsule = findNodes(moved.program.scene, (n) => n.kind === 'capsule')[0] as any;
    ok(capsule && near(capsule.a, [1, 2, 0]), 'anchored points follow spline overrides');
  }
}

const shared = compileScene(PRESETS[0].source, {}, {});
ok(shared.ok, `shared spline example compiles${shared.ok ? '' : `: ${shared.error}`}`);
if (shared.ok) {
  ok(shared.program.splines.length === 1, 'a reused spline is listed once for editing');
  const splines = findNodes(shared.program.scene, (n) => n.kind === 'spline');
  ok(splines.length === 2 && splines[0] === splines[1], 'one spline node is instanced twice');
  const overridden = compileScene(PRESETS[0].source, {}, {
    rail: shared.program.splines[0].points.map((_, i) => (i === 2 ? [0, 0.2, 0] : [0, 0, 0])),
  });
  ok(overridden.ok, 'shared spline compiles with overrides');
  if (overridden.ok) {
    const after = findNodes(overridden.program.scene, (n) => n.kind === 'spline');
    ok(after.length === 2 && after[0] === after[1], 'overrides keep the instances shared');
    ok(Math.abs((after[0] as any).points[2][1] - (shared.program.splines[0].points[2][1] + 0.2)) < 1e-6, 'override reaches the shared spline');
  }
}

const ANIM_REF = String.raw`
export default function build(k, t) {
  const wave = spline({ name: 'wave', points: [[0, 0, 0], [1, t, 0], [2, 0, 0]], r: 0.05, seg: 8 });
  return wave;
}`;
const animOffset = { wave: [[0, 0, 0], [0, 1, 0], [0, 0, 0]] };
const anim0 = compileScene(ANIM_REF, {}, animOffset, 0);
const anim1 = compileScene(ANIM_REF, {}, animOffset, 1);
ok(anim0.ok && anim1.ok, 'animated spline accepts offsets');
if (anim0.ok && anim1.ok) {
  const y0 = anim0.program.splines[0].points[1][1];
  const y1 = anim1.program.splines[0].points[1][1];
  ok(Math.abs(y0 - 1) < 1e-6 && Math.abs(y1 - 2) < 1e-6, 'edited animated spline keeps animating');
}

const unnamedRef = compileScene(
  "export default () => { const s = spline({ points: [[0,0,0],[1,1,0]] }); return translate(s.at(0.5), sphere()); }",
  {},
  {},
);
ok(!unnamedRef.ok && /name/.test(unnamedRef.error), 'at() requires a named spline');

const ambiguousRef = compileScene(
  "export default () => { const a = spline({ name: 'x', points: [[0,0,0],[1,1,0]] }); const b = spline({ name: 'x', points: [[0,0,0],[0,1,0]] }); return union(a, b, translate(a.at(0.5), sphere())); }",
  {},
  {},
);
ok(!ambiguousRef.ok && /ambiguous/.test(ambiguousRef.error), 'duplicate spline names are rejected when referenced');

console.log('\nruled surfaces');
const SURFACE_SRC = String.raw`
export default function build() {
  const a = spline({ name: 'a', points: [[0, 0, 0], [0, 1, 0], [0, 2, 0]], r: 0.02, seg: 8 });
  const b = spline({ name: 'b', points: [[1, 0, 0], [1, 1, 0], [1, 2, 0]], r: 0.02, seg: 8 });
  return surface({ a, b, thickness: 0.1, samples: 8 });
}`;
const sf = compileScene(SURFACE_SRC, {}, {});
ok(sf.ok, `ruled surface compiles${sf.ok ? '' : `: ${sf.error}`}`);
if (sf.ok) {
  const node = findNodes(sf.program.scene, (n) => n.kind === 'surface')[0] as any;
  ok(node?.edges?.a?.length === 9 && node?.edges?.b?.length === 9, 'surface uploads 9 edge pairs');
  ok(near(node.edges.a[0], [0, 0, 0]) && near(node.edges.b[0], [1, 0, 0]), 'first ruling joins a(0) to b(0)');
  ok(near(node.edges.a[4], [0, 1, 0]) && near(node.edges.b[4], [1, 1, 0]), 'edge samples advance with t');
  ok(
    sf.program.glsl.includes('vec3 connect0(vec3 a, vec3 b, float s)') &&
      sf.program.glsl.includes('return mix(a, b, s);'),
    'default linear connect is emitted as GLSL',
  );
  ok(
    sf.program.glsl.includes('int rulings = int(') &&
      sf.program.glsl.includes('for (int i = 0; i < rulings; i++)') &&
      sf.program.glsl.includes('connect0(a, b, float(j) / float(across))'),
    'the shader evaluates the connect per ruling',
  );
  ok(!('sections' in node), 'rulings are not baked on the CPU');
  ok(
    near(sf.program.bounds.min, [-0.05, -0.05, -0.05]) && near(sf.program.bounds.max, [1.05, 2.05, 0.05]),
    'surface bounds include the sheet thickness',
  );
  ok(sf.program.splines.map((s) => s.id).join(',') === 'a,b', 'construction curves are editable');

  const moved = compileScene(SURFACE_SRC, {}, { a: [[0.2, 0, 0], [0, 0, 0], [0, 0, 0]] });
  ok(moved.ok, 'surface compiles with spline overrides');
  if (moved.ok) {
    const m = findNodes(moved.program.scene, (n) => n.kind === 'surface')[0] as any;
    ok(near(m.edges.a[0], [0.2, 0, 0]), 'ruled surface follows an edited construction curve');
    ok(moved.program.glsl === sf.program.glsl, 'spline edits keep the surface shader stable');
  }
}

const CUSTOM_CONNECT = String.raw`
export default function build() {
  const a = spline({ name: 'a', points: [[0, 0, 0], [0, 1, 0]], r: 0.02 });
  const b = spline({ name: 'b', points: [[1, 0, 0], [1, 1, 0]], r: 0.02 });
  return surface({
    a, b, samples: 4, sSamples: 2, thickness: 0.04, margin: 1,
    connect: 'return mix(a, b, s) + vec3(0.0, 0.5 * sin(3.14159 * s), 0.0);',
  });
}`;
const bowed = compileScene(CUSTOM_CONNECT, {}, {});
ok(bowed.ok, `custom connect compiles${bowed.ok ? '' : `: ${bowed.error}`}`);
if (bowed.ok) {
  ok(bowed.program.glsl.includes('0.5 * sin(3.14159 * s)'), 'custom GLSL body is in the shader');
  ok(
    bowed.program.glsl.includes('int across = int(') &&
      bowed.program.glsl.includes('for (int j = 1; j <= across; j++)'),
    'sSamples subdivides the ruling loop',
  );
  ok(
    near(bowed.program.bounds.min, [-1.02, -1.02, -1.02]) &&
      near(bowed.program.bounds.max, [2.02, 2.02, 1.02]),
    'margin expands the surface bounds',
  );
}

const BARE_CONNECT = String.raw`
export default function build() {
  const a = spline({ name: 'a', points: [[0, 0, 0], [0, 1, 0]], r: 0.02 });
  const b = spline({ name: 'b', points: [[1, 0, 0], [1, 1, 0]], r: 0.02 });
  return surface({ a, b, connect: 'mix(a, b, s)' });
}`;
const bare = compileScene(BARE_CONNECT, {}, {});
ok(bare.ok && bare.program.glsl.includes('return mix(a, b, s);'), 'a bare connect expression is wrapped');

const ANIM_SURFACE = String.raw`
export default function build(k, t) {
  const a = spline({ name: 'a', points: [[0, 0, 0], [0, 1, 0]], r: 0.02 });
  const b = spline({ name: 'b', points: [[1, 0, 0], [1, 1 + t, 0]], r: 0.02 });
  return surface({ a, b, thickness: 0.04, samples: 6 });
}`;
const sa0 = compileScene(ANIM_SURFACE, {}, {}, 0);
const sa1 = compileScene(ANIM_SURFACE, {}, {}, 1);
ok(sa0.ok && sa1.ok, 'animated construction curves compile');
if (sa0.ok && sa1.ok) {
  const n0 = findNodes(sa0.program.scene, (n) => n.kind === 'surface')[0] as any;
  const n1 = findNodes(sa1.program.scene, (n) => n.kind === 'surface')[0] as any;
  ok(near(n0.edges.b[6], [1, 1, 0]) && near(n1.edges.b[6], [1, 2, 0]), 'surface resamples animated curves');
  ok(sa0.program.glsl === sa1.program.glsl, 'animating a surface keeps the shader stable');
}

const badSurface = compileScene(
  "export default () => surface({ a: sphere(), b: spline({ points: [[0,0,0],[1,1,0]] }) })",
  {},
  {},
);
ok(!badSurface.ok && /must be a spline/.test(badSurface.error), 'surface() requires spline-like curves');

const jsConnect = compileScene(
  "export default () => { const a = spline({ points: [[0,0,0],[1,0,0]] }); const b = spline({ points: [[0,1,0],[1,1,0]] }); return surface({ a, b, connect: (p, q, s) => p }); }",
  {},
  {},
);
ok(!jsConnect.ok && /must be GLSL/.test(jsConnect.error), 'surface() connect must be GLSL code');

const starter = compileScene(STARTER_SOURCE, {}, {});
ok(starter.ok, `typed starter compiles${starter.ok ? '' : `: ${starter.error}`}`);

const TS_SCENE = String.raw`
type Params = { size: number };
export const params = { size: num(1.1, { min: 0.2, max: 2 }) };
export default defineScene(params, (k: Params) => {
  const size: number = k.size;
  return sphere({ r: size as number });
});
`;
const tsScene = compileScene(TS_SCENE, {}, {});
ok(tsScene.ok, `typescript scene compiles${tsScene.ok ? '' : `: ${tsScene.error}`}`);
if (tsScene.ok) {
  const sphereNode = findNodes(tsScene.program.scene, (n) => n.kind === 'sphere')[0] as any;
  ok(Math.abs((sphereNode?.r ?? 0) - 1.1) < 1e-3, 'typescript annotations are stripped at runtime');
  ok(tsScene.values.size === 1.1, 'typed params resolve to values');
}

const REPEAT_SRC = String.raw`
export default function build() {
  return polarRepeat(
    { count: 6, spread: 70, name: 'ring' },
    translate([1.2, 0, 0], box({ s: [0.2, 0.1, 0.1] })),
  );
}`;
const rep = compileScene(REPEAT_SRC, {}, {});
ok(rep.ok, `polar repeat compiles${rep.ok ? '' : `: ${rep.error}`}`);
if (rep.ok) {
  const glsl = rep.program.glsl;
  ok(
    glsl.includes('atan(p.z, p.x)') &&
      glsl.includes('mod(ang - radians(') &&
      glsl.includes('int copies =') &&
      glsl.includes('for (int j = 1; j <= copies; j++)') &&
      glsl.includes('float a = ang + float(j) * sector') &&
      glsl.includes('float b = ang - float(j) * sector'),
    'repeat folds the overlapping sectors',
  );
  ok(glsl.includes('float count = max(') && glsl.includes('float spread = max('), 'copy count and spread are uniforms');
  const r = Math.hypot(1.4, 0.1);
  ok(
    near(rep.program.bounds.min, [-r, -0.1, -r]) && near(rep.program.bounds.max, [r, 0.1, r]),
    'repeat bounds cover the polar envelope',
  );
  const rep8 = compileScene(REPEAT_SRC.replace('count: 6', 'count: 8'), {}, {});
  ok(rep8.ok && rep8.program.glsl === rep.program.glsl, 'changing the repeat count keeps the shader stable');
}

console.log('\ncolours');
ok(normalizeHexColor('#abc') === '#aabbcc', 'short hex expands');
ok(normalizeHexColor('#abcd') === '#aabbcc', 'short hex with alpha drops alpha');
ok(normalizeHexColor('#A1B2C3FF') === '#a1b2c3', 'alpha hex is normalised');
ok(
  compileScene(
    "export const params = { tint: color('#a1b2c3ff') };\nexport default (k) => paint(sphere({ r: 1 }), k.tint)",
    {},
    {},
  ).ok,
  'color() control accepts alpha hex',
);
ok(
  compileScene("export default () => paint(sphere({ r: 1 }), '#11223380')", {}, {}).ok,
  'paint() accepts alpha hex',
);
const badColour = compileScene("export default () => paint(sphere({ r: 1 }), '#12345')", {}, {});
ok(!badColour.ok && /invalid hex colour/.test(badColour.error), 'bad hex is rejected');

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
