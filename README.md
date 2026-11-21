# paraplot

A small parametric CAD / SDF modeller that runs in the browser.

- **scene as code** — a pure javascript function builds a scene graph
- **implicit surfaces** — shapes are signed distance fields, including custom equations
- **set operations** — union, intersect, subtract with optional smooth blending
- **groups & transforms** — local coordinate systems (translate / rotate / scale)
- **splines** — 3D tube paths, extruded profiles and lathe profiles, with a point editor
- **parameters** — constants become sliders, toggles and colour pickers
- **WebGL2 raymarcher** — soft shadows, ambient occlusion, materials, ground grid
- **smoothness analysis** — normals, mean curvature, gradient and zebra views, plus curvature combs
- **renders on demand** — idle costs nothing; interactive frames are drafted and refined
- **Monaco** — javascript editing with DSL typings, completions and a generated GLSL tab

```
npm install
npm run dev      # http://127.0.0.1:5173
npm run check    # headless tests for the pure pipeline
npm run build
```

## Component tree

The **components** tab (before `scene.js`) shows the compiled scene graph as a
tree. Every node has two actions:

- **eye** — hide that component (and its subtree). `subtract` keeps its base, so
  hiding a cutter simply stops cutting.
- **target** — *solo*: render only that component, keeping the transforms and
  modifiers of its ancestors so it stays in place. This is how you inspect one
  stage of the pipeline in isolation.

Active filters show up as a chip in the viewport (`1 hidden`, `solo rail left`)
and can be cleared from there. The generated `shader.glsl`, node/uniform counts
and viewport all follow the filtered tree. Groups can be named for readability:

```js
group({ name: 'plate', t: [0, 0.07, 0] }, paint(box({ s: … }), k.finish))
```

The filter state is transient (paths depend on the tree shape); visibility and
solo reset when you reopen a project.

The editor/viewport split is draggable (double click resets it, arrow keys work
when the splitter is focused) and the position is remembered in `localStorage`.

## Spline workspace

The spline editor's position is controlled from the **top bar** (`splines` group
next to the compile status):

- **dock** — the compact panel at the bottom right (default).
- **editor pane** — the spline workspace takes the place of the code editor; the
  code/Monaco state is kept and restored when you bring it back.
- **viewport** — the spline workspace replaces the scene renderer. The main
  raymarcher is paused (no GPU work) and resumes exactly where it left off.

The workspace header has a `×` shortcut back to the dock. While it is enlarged,
the dock shows a small placeholder with a `restore` action.

The workspace shows the 2D control-point editor next to a **live 3D preview**
(`2D / split / 3D`), rendered by the same SDF raymarcher as the main scene: the
swept tube (or lathe/extrude solid), the control cage and the handles, with
orbit/zoom, framing, shadows, AO and the ground grid. Drag a control point in 2D
and the 3D preview follows immediately; the camera reframes only when you switch
splines. Spline edits are stored as **per-point offsets** from the generated curve. This
matters for animated splines (like the dog's tail): your edit changes the rest
shape while the animation keeps running around it.

The workspace shares the comb toggle and the XY/XZ/YZ projection with
the dock. The 2D canvas supports **pan** (drag empty space, or middle/right drag)
and **wheel zoom** around the cursor, with a fit button in the corner; the view is
kept while you drag points and refits when you switch splines or resize. The comb
toggle also draws **3D curvature combs** in the preview (spikes plus an envelope),
so it remains useful in the `3D` view.

## Projects

The app opens on a project browser. A project stores its source, parameter
values, spline overrides, viewport settings and a preview image. Everything is
auto-saved to **IndexedDB** in your browser ~600 ms after you stop editing; the
preview is a 640×400 JPEG captured from the WebGL canvas (a draft-refined frame,
then downscaled) and refreshed ~1.7 s after edits settle and when you leave the
editor. `Ctrl/⌘+S` forces a save.

Projects are addressed by hash routes (`#/p/<id>`), so a reload or a shared link
reopens the same scene. Renaming happens inline in the editor header.

The **Examples** section on the landing page uses pre-rendered stills from
`public/examples/`; opening one creates a fresh project copy, so the example
itself is never modified. Deleting is a two-step action on the project card.

If IndexedDB is blocked (some private modes), the app falls back to an
in-memory store and shows a warning on the landing page.

## A scene

```js
export const params = {
  span:  num(2.4, { min: 1.2, max: 4, step: 0.01 }),
  holes: int(4, { min: 1, max: 8 }),
  tint:  color('#c3ccd6'),
};

// pure: values in, shape out
export default function build(k) {
  const plate = translate([0, 0.07, 0],
    paint(box({ s: [k.span / 2, 0.07, 0.5], round: 0.03 }), k.tint));

  const holes = range(k.holes).map((i) =>
    translate([lerp(-1, 1, i / Math.max(1, k.holes - 1)), 0.07, 0],
      cylinder({ r: 0.07, h: 1 })));

  const handle = spline({
    points: [[-1, 0.1, 0], [0, 1.4, 0], [1, 0.1, 0]],
    r: 0.05,
  });

  return subtract(smoothUnion(0.05, plate, handle), ...holes);
}
```

## Anchoring to splines

Name a spline and take a point from it; the reference is anchored to the curve:

```js
const rail = spline({ name: 'rail', points, r: 0.05 });
const left = spline({ name: 'rail left', points: other, r: 0.05 });

const bar = capsule({ a: rail.at(0.5), b: left.at(0.5), r: 0.05 });
// or move a part to the curve:
translate(rail.at(0.25), sphere({ r: 0.1 }));
```

`at(t)` (`t` in `[0, 1]`) returns an **opaque point reference** accepted by
`capsule({ a, b })` and `translate(point, …)`. References are resolved by the
compiler **after spline overrides**, so dragging the rail in the spline editor
moves everything anchored to it, and nothing duplicates the curve formula.
Resolution is a compile-time step — the renderer still receives plain capsule
endpoints and transforms, so this adds no GPU work. Splines used by `at()` must
have a unique `name` (there is a clear error otherwise).

A named spline can also be **reused under several transforms** (the bracket
example defines one `rail` and instances it left/right). Shared subtrees are
emitted once and instanced with transforms: the instances are identical, share
their uniforms and shader function, and the spline editor shows a single tab, so
one edit updates all of them.

## The DSL

### Parameters

`num`, `int`, `bool`, `color`, `select` and `vec3` return plain values and add a
control to the dock. Colours accept `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa`
(8-digit values are what Monaco's inline colour picker inserts; the alpha channel
is ignored because materials are opaque). A parameter can also be a plain constant; anything that is
not a control is passed through untouched.

```js
export const params = {
  radius: num(0.6, { min: 0.1, max: 2, step: 0.01, label: 'radius', unit: 'm' }),
  holes:  int(6, { min: 3, max: 12 }),
  hollow: bool(true),
  finish: color('#c3ccd6'),
  mode:   select('box', ['box', 'sphere']),
  offset: vec3([0, 0, 0], { min: -1, max: 1 }),
};
```

### Groups and transforms

A group establishes a local coordinate system for its children. The forward
transform is `translate * rotate * scale`, so scale happens first and rotation is
in Euler degrees applied X → Y → Z.

```js
group({ t: [1, 0, 0], r: [0, 45, 0], s: [1, 1, 0.5] }, box(), sphere());
translate([0, 1, 0], sphere());   // sugar for group({ t })
rotate([0, 90, 0], cylinder());   // degrees
scale(2, sphere());               // uniform
```

Children of a group are combined with `union` unless `op` and `k` say otherwise:

```js
group({ t: [0, 1, 0], op: 'smoothUnion', k: 0.1 }, a, b);
```

### Primitives

| | |
|---|---|
| `sphere({ r })` | `box({ s: [x,y,z], round })` |
| `ellipsoid({ r: [x,y,z] })` | `torus({ R, r })` |
| `cylinder({ r, h, round })` | `cone({ r, h })` |
| `capsule({ a, b, r })` | `plane({ n, d })` |
| `spline({ points, r, closed, seg })` | `extrude({ points, h, round })` |
| `lathe({ points, seg })` | `implicit(equation, opts)` |

`box` and `cylinder` take half extents / total height and are centred on the
origin. `lathe` revolves `[radius, y]` pairs around the Y axis; `extrude` sweeps
an `[x, y]` profile along Z.

### Set operations

```js
union(a, b, ...);
intersect(a, b, ...);
subtract(base, a, b, ...);
smoothUnion(k, a, b, ...);
smoothIntersect(k, a, b, ...);
smoothSubtract(k, base, a, b, ...);
```

All of them accept arrays and falsy values, so mapping over parameters works:

```js
union(parts.map(makePart));
```

### Modifiers

```js
offset(node, 0.05);     // dilate (negative erodes)
shell(node, 0.02);      // hollow, wall half-thickness
paint(node, '#e0a267', { rough: 0.35 });  // material
```

### Time and animation

`t` is the scene clock in seconds. Declare a second argument on the build
function and the viewport re-evaluates the scene every frame while playing:

```js
export default function build(k, t) {
  const angle = t * k.speed * 360;           // degrees
  return rotate([0, angle, 0], sphere({ r: k.size }));
}
```

The pipeline stays pure: the scene is a function of `(source, params, overrides,
time)`, so any time is reproducible. Structure must not depend on `t` if you
want to avoid shader recompiles — numeric values are uniforms, so ordinary
motion is free.

Implicit equations get a built-in `time` uniform, which is the cheapest way to
animate (no javascript runs per frame at all):

```js
implicit('abs(sin(x*f + time*s) * cos(y*f)) - th', {
  vars: { f: 6, th: 0.4, s: 0.5 },
  bounds: 1.6,
});
```

The play/pause button in the viewport freezes both the clock and the shader
time, and the `t` chip shows the current value.

### Implicit equations

The equation is a string in a tiny expression language which is compiled to
GLSL — no eval and no shader injection.

```js
implicit('x*x + y*y + z*z - 1', { bounds: 1.2 });

implicit('abs(sin(x*f) * cos(y*f) + sin(y*f) * cos(z*f)) - t', {
  vars: { f: 6, t: 0.4 },
  bounds: 1.6,
});
```

Available: `x`, `y`, `z`, `p` (vec3, so `p.x`), `time`, `pi`, `tau`, and
`sin cos tan asin acos atan abs sign floor ceil round fract sqrt exp log pow
min max mod clamp mix step smoothstep length dot cross normalize select vec2
vec3`. `^` (or `**`) is exponentiation.

Fields that are not true distance functions are divided by the gradient
(`normalize: true`, the default) so the raymarcher can advance safely. `bounds`
should be conservative.

### Splines and the editor

Any `spline`, `extrude` or `lathe` node appears in the spline dock. Drag control
points, double click to append, use the plane switch for 3D paths. Edits are
stored as overrides outside the source and re-enter the pure pipeline as an
input. Give a spline a `name` to keep its edits attached to it when other
splines change. `seg` is the number of samples per span (and therefore the
polyline resolution of the SDF).

## Purity

The pipeline is a pure function:

```
source ──parse──▶ module ──build(k, t)──▶ scene graph ──codegen──▶ GLSL + uniforms
                     ▲                          ▲
              param values               spline overrides
```

`compileScene(source, values, overrides, time)` has no side effects and
identical inputs produce byte-identical shaders (the parsed module is memoised,
which is safe because modules are pure). The React app only holds the inputs
(source, parameter values, spline points, clock) and feeds them back in.

User code is executed with `new Function` in a scope containing only the DSL
bindings (plus whatever globals javascript provides); it is a pure data
constructor by contract. Do not use `Date`, `Math.random` or DOM APIs if you
want deterministic scenes.

Parameter values and spline points are uploaded as uniforms, so moving a slider
or dragging a spline control point does **not** recompile the shader — the
structure is unchanged. Structural edits (adding children, toggling a shape)
do.

## Smoothness analysis

The viewport has a `shaded / normals / curvature / gradient / zebra` selector:

- **normals** — world-space normal encoded as RGB (R = +x, G = +y, B = +z).
- **curvature** — mean curvature `H ≈ ½Δd` sampled from the distance field, colour
  coded from concave (cool) through flat (neutral) to convex (warm), with a
  colour bar and a κ full-scale slider. Useful for finding tight fillets, creases
  and weak blends.
- **gradient** — `|∇d|` of the field. A true distance field stays at 1; colour
  deviations expose non-metric fields or missing `normalize`.
- **zebra** — reflected environment stripes. Continuous bands reveal G1/G2
  smoothness across blends, unions and patches.

Analysis views hide the ground grid and never bake themselves into project
previews. The mode (and the curvature scale) is saved with the project.

**Curvature combs** — the splines dock header (and the enlarged spline
workspace) has a `comb` toggle next to the XY/XZ/YZ selector. It samples the curve,
fits a circle through each triple of neighbouring points and draws a spike away
from the local centre of curvature with length proportional to `κ = 1/R`,
plus an envelope through the tips. The readout shows `κmax` in world units. It
works for 3D path splines (projected onto the chosen plane) and for lathe /
extrude profiles, and in the spline workspace it is also rendered as 3D spikes
(with an envelope) in the live preview.

Enabling the comb reveals two sliders (both in the dock and in the workspace
header):

- **density** (8–120) — number of spikes along the curve; the comb is re-sampled
  at a higher resolution so it can exceed the drawing resolution.
- **scale** (×0.2–3) — spike length multiplier.

Both sliders drive the 2D and 3D combs together.

## Deploying

Pushes to `main` (or `master`) deploy through GitHub Actions
(`.github/workflows/deploy.yml`) to GitHub Pages at
**https://nikhedonia.net/paraplot/**.

- The workflow builds with `VITE_BASE=/paraplot/`, so the HTML, JS/CSS, Monaco
  and render workers, and the example images all resolve under the `/paraplot/`
  sub-path. The app uses hash routes (`#/p/<id>`), so no server rewrites are
  needed.
- Repository **Settings → Pages → Build and deployment → Source** must be
  **GitHub Actions**. Enable it once; the workflow then deploys on every push.
- **`nikhedonia.net` must be the custom domain of the user site
  (`nikhedonia.github.io`)**, not of this project repository. GitHub then serves
  project sites under `https://nikhedonia.net/<repo>/`, which is why the base
  path is `/paraplot/`. (Setting the custom domain directly on this repository
  would serve it at the domain root instead and the `/paraplot/` base would be
  wrong.) No `CNAME` file is needed in this repo for Actions deployments.
- The repository must be named `paraplot` (the Pages path). If you rename it,
  update `VITE_BASE` in the workflow and the URL. If you instead serve the site
  at the domain root, set `VITE_BASE: /`.
- Enable **Enforce HTTPS** in the Pages settings once the certificate is ready.
- Locally `npm run build` uses `/`; to reproduce the deployed asset paths run
  `VITE_BASE=/paraplot/ npm run build` and serve `dist` under `/paraplot/`.

## Analytics

GA4 is wired through `src/analytics.ts`. The deploy workflow exposes the
repository secret **`GA_MEASUREMENT_ID`** as `VITE_GA_MEASUREMENT_ID` at build
time; when it is absent, analytics is disabled and no gtag script is loaded.
Vite inlines `VITE_*` values into the bundle — a measurement ID is a public
identifier; the secret only keeps it out of git.

After adding the secret, re-run the workflow (Actions → “Deploy to GitHub
Pages” → Run workflow) so the deployed bundle is rebuilt with it.

Tracked events:

- `page_view` — landing / editor (sanitised paths, no project ids)
- `project_create` (`mode`: blank|example), `project_open`, `project_delete`,
  `project_rename`
- `example_open`
- `analysis_view`, `spline_workspace`, `curvature_comb`, `playback_toggle`
- `component_visibility`, `component_solo`
- `compile_error` (a category only: `syntax`, `implicit` or `dsl`)

No source code, project names, project ids, spline points or parameter values
are sent. GA sets analytics cookies; add a consent flow if your jurisdiction
requires one.

Local testing: `VITE_GA_MEASUREMENT_ID=G-XXXXXXX npm run dev`.

## Performance

The viewport only draws when something actually changes:

- **on demand** — after the last frame the rAF loop stops. A static scene sits at
  `idle` in the HUD with no rAF loop and no GPU work (a slider drag draws one
  frame, then sleeps again). Only live scenes (animated graph, or `time` in an
  implicit) keep drawing.
- **offscreen rendering** — the GL context lives in a Web Worker on an
  `OffscreenCanvas` (the HUD shows `sdf · worker`). Shader compilation, draw
  submission and preview JPEG encoding never run on the main thread. Browsers
  without `transferControlToOffscreen` fall back to the main thread; force that
  with `?mainRender=1`.
- **one frame in flight** — the loop never queues GPU work: if a worker frame is
  still running the vsync is dropped, not buffered. Slow GPUs therefore degrade
  frame rate instead of input latency.
- **adaptive resolution** — while animating, the internal scale drifts between
  0.5× and 1× based on the acknowledged frame rate, so each submitted frame stays
  inside the budget. The HUD resolution chip shows the result.
- **draft + refine** — while orbiting/zooming the buffer drops to 0.62×, shadows
  are skipped and the march budget is 88 steps; ~170 ms after the interaction
  stops one full-quality frame is drawn at the configured quality.
- **pixel budget** — the drawing buffer is capped at 2.6 MP, so 4K/retina screens
  automatically render at a lower internal scale.
- **no shader recompiles for numbers** — every geometric value lives in one
  uniform pool; parameter and time changes only upload uniforms. The shader text
  only changes when the tree shape changes.
- **program cache** — compiled GL programs are kept in a small LRU keyed by the
  shader source, so toggling a structural parameter or flipping between presets
  is instant.
- **module cache** — the parsed scene module is memoised by source.
- **shader clock** — `time` in an implicit equation is a uniform, so a living
  surface needs zero javascript per frame.
- **cheaper shading** — shadow rays are skipped for back-facing pixels, 30-step
  soft shadows, and the ray/AABB clip rejects empty space before marching.

Measured on a software rasteriser (Chrome/SwiftShader) with a deliberately large
scene (281 nodes, 2112 lines of generated GLSL), the worst main-thread stall
while recompiling the shader after a structural edit:

| renderer | worst main-thread gap |
|---|---|
| main thread | **1044 ms** |
| offscreen worker | **~30 ms** |

(The remaining ~30 ms is the pure scene compile on the main thread; typical
scenes compile in well under a millisecond. Rendering is fully off-thread.)

Pausing the clock freezes both animations, and hiding the tab stops the loop.

## Rendering

Fullscreen triangle, one fragment shader, no meshes. The scene graph is emitted
as one small GLSL function per node returning `vec2(distance, material)`:

- transforms push the query point into local space and scale the result back
- set operations combine `min` / `max` / smooth variants, carrying the material
- `smoothstep`-free soft shadows, 5-tap AO, hemisphere + key + rim lighting
- ray/AABB clipping from the scene bounds computed on the CPU
- analytic ground grid composited after the march
- all geometry numbers live in one `u_values` pool, so the shader text only
  changes when the tree shape changes

## Layout

```
src/core      pure pipeline: dsl, scene types, expression parser, codegen, bounds
src/render    WebGL2 renderer + the raymarching glsl prelude
src/store     project records, IndexedDB persistence, starter scene
src/ui        landing, editor shell, Monaco, viewport, component tree,
              spline workspace + live 3D preview, parameter/spline docks
public        pre-rendered example stills
scripts       headless checks (npm run check)
```

## Notes / limits

- Non-uniform scale uses the smallest axis scale for distances, which is safe
  but slightly conservative.
- Smooth blends with large `k` can violate the distance bound; keep them modest.
- `plane` is infinite; its bounds are a heuristic, which affects framing.
- The implicit expression language has no comparison operators; use `select`,
  `min`, `max` and `abs`.
- The spline editor shows splines at `t = 0`; for animated scenes the handles
  are the rest pose, not the current frame.
