/**
 * The raymarching fragment shader. `map()` is injected by the code generator;
 * everything else is a fixed, hand-tuned prelude.
 */

export const VERTEX_SRC = `#version 300 es
precision highp float;
in vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

export interface FragmentParts {
  mapFn: string;
  valueCount: number;
  materialCount: number;
}

export function fragmentShader(parts: FragmentParts): string {
  const values = Math.max(1, parts.valueCount);
  const mats = Math.max(1, parts.materialCount);

  return `#version 300 es
precision highp float;
precision highp int;

out vec4 fragColor;

uniform vec2  u_res;
uniform vec3  u_camPos;
uniform vec3  u_camTarget;
uniform float u_fov;
uniform float u_time;
uniform int   u_maxSteps;
uniform float u_eps;
uniform vec3  u_boxMin;
uniform vec3  u_boxMax;
uniform float u_shadows;
uniform float u_ao;
uniform float u_grid;
uniform float u_floorY;
uniform vec3  u_bgA;
uniform vec3  u_bgB;
uniform float u_values[${values}];
uniform vec3  u_matColor[${mats}];
uniform float u_matRough[${mats}];

/* ------------- value pool accessors ------------- */
vec2 v2(int i) { return vec2(u_values[i], u_values[i + 1]); }
vec3 v3(int i) { return vec3(u_values[i], u_values[i + 1], u_values[i + 2]); }

/* ------------- signed distance primitives ------------- */
float sdSphere(vec3 p, float r) { return length(p) - r; }

float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sdRoundBox(vec3 p, vec3 b, float r) { return sdBox(p, b - r) - r; }

float sdEllipsoid(vec3 p, vec3 r) {
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k1 > 1e-8 ? k0 * (k0 - 1.0) / k1 : -min(r.x, min(r.y, r.z));
}

float sdTorus(vec3 p, float R, float r) {
  vec2 q = vec2(length(p.xz) - R, p.y);
  return length(q) - r;
}

float sdRoundedCylinder(vec3 p, float ra, float rb, float hh) {
  vec2 d = vec2(length(p.xz) - ra + rb, abs(p.y) - hh + rb);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - rb;
}

float sdCappedCone(vec2 q, float h, float r1, float r2) {
  vec2 k1 = vec2(r2, h);
  vec2 k2 = vec2(r2 - r1, 2.0 * h);
  vec2 ca = vec2(q.x - min(q.x, (q.y < 0.0) ? r1 : r2), abs(q.y) - h);
  vec2 cb = q - k1 + k2 * clamp(dot(k1 - q, k2) / max(dot(k2, k2), 1e-8), 0.0, 1.0);
  float s = (cb.x < 0.0 && ca.y < 0.0) ? -1.0 : 1.0;
  return s * sqrt(min(dot(ca, ca), dot(cb, cb)));
}

float sdCone(vec3 p, float h, float r) {
  return sdCappedCone(vec2(length(p.xz), p.y), h, r, 0.0);
}

float sdSegment(vec3 p, vec3 a, vec3 b) {
  vec3 pa = p - a;
  vec3 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * h);
}

float sdCapsule(vec3 p, vec3 a, vec3 b, float r) { return sdSegment(p, a, b) - r; }

/* signed distance to a closed polygon, points live in the value pool */
float sdPoly(vec2 p, int off, int n) {
  vec2 v0 = v2(off);
  float d = dot(p - v0, p - v0);
  float s = 1.0;
  for (int i = 0; i < n; i++) {
    int j = (i == 0) ? n - 1 : i - 1;
    vec2 vi = v2(off + 2 * i);
    vec2 vj = v2(off + 2 * j);
    vec2 e = vj - vi;
    vec2 w = p - vi;
    vec2 b = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-8), 0.0, 1.0);
    d = min(d, dot(b, b));
    bvec3 c = bvec3(p.y >= vi.y, p.y < vj.y, e.x * w.y > e.y * w.x);
    if (all(c) || all(not(c))) s = -s;
  }
  return s * sqrt(d);
}

float sdPath(vec3 p, int off, int n, float r) {
  float d = 1e12;
  for (int i = 0; i < n - 1; i++) {
    d = min(d, sdCapsule(p, v3(off + 3 * i), v3(off + 3 * (i + 1)), r));
  }
  return d;
}

/* ------------- material aware set operations ------------- */
vec2 opUnion(vec2 a, vec2 b) { return (a.x < b.x) ? a : b; }
vec2 opIntersect(vec2 a, vec2 b) { return (a.x > b.x) ? a : b; }
vec2 opSubtract(vec2 a, vec2 b) { return vec2(max(a.x, -b.x), a.y); }

vec2 opSmoothUnion(vec2 a, vec2 b, float k) {
  if (k <= 0.0) return opUnion(a, b);
  float h = clamp(0.5 + 0.5 * (b.x - a.x) / k, 0.0, 1.0);
  return vec2(mix(b.x, a.x, h) - k * h * (1.0 - h), (a.x < b.x) ? a.y : b.y);
}

vec2 opSmoothIntersect(vec2 a, vec2 b, float k) {
  if (k <= 0.0) return opIntersect(a, b);
  float h = clamp(0.5 - 0.5 * (b.x - a.x) / k, 0.0, 1.0);
  return vec2(mix(b.x, a.x, h) + k * h * (1.0 - h), (a.x > b.x) ? a.y : b.y);
}

vec2 opSmoothSubtract(vec2 a, vec2 b, float k) {
  if (k <= 0.0) return opSubtract(a, b);
  float h = clamp(0.5 - 0.5 * (-b.x - a.x) / k, 0.0, 1.0);
  return vec2(mix(-b.x, a.x, h) + k * h * (1.0 - h), a.y);
}

/* ------------- rotations (inverse of Rz*Ry*Rx) ------------- */
vec3 rotX(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z);
}
vec3 rotY(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}
vec3 rotZ(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z);
}

/* ------------- generated scene ------------- */
${parts.mapFn}

/* ------------- marching ------------- */
bool boxHit(vec3 ro, vec3 rd, out float t0, out float t1) {
  vec3 inv = 1.0 / rd;
  vec3 a = (u_boxMin - ro) * inv;
  vec3 b = (u_boxMax - ro) * inv;
  vec3 lo = min(a, b);
  vec3 hi = max(a, b);
  t0 = max(max(lo.x, lo.y), max(lo.z, 0.0));
  t1 = min(min(hi.x, hi.y), hi.z);
  return t1 > t0;
}

float march(vec3 ro, vec3 rd, float tmin, float tmax) {
  float t = tmin;
  for (int i = 0; i < 512; i++) {
    if (i >= u_maxSteps) break;
    float d = map(ro + rd * t).x;
    if (isnan(d)) break;
    float eps = u_eps * max(1.0, t);
    if (d < eps) return t;
    t += max(d * 0.85, eps * 0.5);
    if (t > tmax) break;
  }
  return -1.0;
}

vec3 calcNormal(vec3 p) {
  const vec2 e = vec2(1.0, -1.0) * 0.0012;
  return normalize(
    e.xyy * map(p + e.xyy).x +
    e.yyx * map(p + e.yyx).x +
    e.yxy * map(p + e.yxy).x +
    e.xxx * map(p + e.xxx).x
  );
}

float softShadow(vec3 ro, vec3 rd, float k) {
  float res = 1.0;
  float t = 0.02;
  for (int i = 0; i < 30; i++) {
    float h = map(ro + rd * t).x;
    res = min(res, k * h / t);
    if (res < 0.005) break;
    t += clamp(h, 0.02, 0.32);
    if (t > 7.0) break;
  }
  return clamp(res, 0.0, 1.0);
}

float calcAO(vec3 p, vec3 n) {
  float occ = 0.0;
  float sca = 1.0;
  for (int i = 0; i < 5; i++) {
    float h = 0.012 + 0.14 * float(i) / 4.0;
    float d = map(p + n * h).x;
    occ += (h - d) * sca;
    sca *= 0.82;
  }
  return clamp(1.0 - 2.4 * occ, 0.0, 1.0);
}

/* ------------- shading ------------- */
vec3 shade(vec3 p, vec3 n, vec3 rd, int mat, float t) {
  vec3 base = u_matColor[clamp(mat, 0, ${mats - 1})];
  float rough = u_matRough[clamp(mat, 0, ${mats - 1})];

  vec3 keyDir = normalize(vec3(0.62, 0.88, 0.42));
  vec3 fillDir = normalize(vec3(-0.78, 0.30, -0.40));

  float ao = u_ao > 0.5 ? calcAO(p, n) : 1.0;

  float ndl = clamp(dot(n, keyDir), 0.0, 1.0);
  float ndf = clamp(dot(n, fillDir), 0.0, 1.0);
  // back-facing pixels need no shadow ray at all
  float sh = (u_shadows > 0.5 && ndl > 0.001) ? softShadow(p + n * 0.004, keyDir, 9.0) : 1.0;
  vec3 hv = normalize(keyDir - rd);
  float spec = pow(clamp(dot(n, hv), 0.0, 1.0), mix(110.0, 8.0, rough));
  float fres = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 5.0);

  vec3 amb = mix(vec3(0.030, 0.036, 0.046), vec3(0.10, 0.12, 0.15), 0.5 + 0.5 * n.y);
  vec3 col = base * (amb * ao
                   + vec3(1.00, 0.94, 0.86) * (1.75 * ndl * sh)
                   + vec3(0.34, 0.44, 0.62) * (0.55 * ndf * ao));
  col += vec3(1.00, 0.96, 0.90) * spec * sh * 1.25;
  col += base * fres * 0.22 * ao;
  return col;
}

float gridLines(vec2 p, float spacing) {
  vec2 q = p / spacing;
  vec2 g = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), vec2(1e-6));
  return 1.0 - clamp(min(g.x, g.y), 0.0, 1.0);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  vec3 ro = u_camPos;
  vec3 fw = normalize(u_camTarget - ro);
  vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(rt, fw);
  vec3 rd = normalize(fw + 2.0 * tan(0.5 * u_fov) * (uv.x * rt + uv.y * up));

  vec3 bg = mix(u_bgB, u_bgA, clamp(uv.y * 1.5 + 0.45, 0.0, 1.0));
  bg += vec3(0.015, 0.022, 0.030) * exp(-2.6 * dot(uv, uv));

  float t0, t1;
  float th = -1.0;
  if (boxHit(ro, rd, t0, t1)) {
    th = march(ro, rd, t0, t1);
  }

  vec3 col = bg;
  if (th > 0.0) {
    vec3 p = ro + rd * th;
    vec3 n = calcNormal(p);
    int mat = int(round(map(p).y));
    col = shade(p, n, rd, mat, th);
  }

  if (u_grid > 0.5 && abs(rd.y) > 1e-5) {
    float tp = (u_floorY - ro.y) / rd.y;
    if (tp > 0.0 && (th < 0.0 || tp < th)) {
      vec3 gp = ro + rd * tp;
      float fade = exp(-0.055 * length(gp.xz));
      float lines = gridLines(gp.xz, 0.25) * 0.26 + gridLines(gp.xz, 1.0) * 0.52;
      col = mix(col, vec3(0.22, 0.29, 0.35), clamp(lines * fade, 0.0, 1.0));
    }
  }

  col *= 1.0 - 0.28 * dot(uv * 0.95, uv * 0.95);
  col = col / (col + vec3(1.0));
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  col += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;

  fragColor = vec4(col, 1.0);
}
`;
}
