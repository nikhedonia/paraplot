/**
 * Headless sanity checks for the pure pipeline.
 *   npm run check
 */
import { compileScene } from '../src/core/compile';
import { PRESETS } from '../src/core/presets';
import { compileExpression } from '../src/core/expr';
import { sampleSpline } from '../src/core/spline';
import { normalizeHexColor } from '../src/core/math';

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
  ok(base.animated === (preset.id === 'orbit'), `animated flag is ${base.animated}`);
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
    if (preset.id === 'orbit') ok(moved, 'build(k, t) responds to time');
    if (preset.id === 'gyroid') {
      ok(p.usesTime, 'implicit reads the shader clock');
      ok(!moved, 'implicit time stays a uniform');
    }
  }

  // spline overrides flow through
  if (p.splines.length > 0) {
    const s = p.splines[0];
    const pts = s.points.map((pt, i) => pt.map((v) => v + (i === 0 ? 0.01 : 0)));
    const withOverride = compileScene(preset.source, {}, { [s.id]: pts });
    ok(withOverride.ok, 'compiles with spline overrides');
    if (withOverride.ok) {
      const after = withOverride.program.splines.find((x) => x.id === s.id);
      ok(!!after && Math.abs(after.points[0][0] - pts[0][0]) < 1e-9, 'override is applied');
      ok(withOverride.program.glsl === p.glsl, 'shader text stable while dragging splines');
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
