import type { Vec2, Vec3, Aabb } from './types';

export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const deg2rad = (d: number) => (d * Math.PI) / 180;

export function vec3(x: number | Vec3, y?: number, z?: number): Vec3 {
  if (Array.isArray(x)) return [x[0], x[1], x[2]];
  return [x, y ?? x, z ?? x];
}

export function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

export function isVec2(v: unknown): v is Vec2 {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
}

export function normalize3(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Row major 3x3, forward rotation Rz * Ry * Rx (degrees). Matches the shader. */
export function eulerMatrix(deg: Vec3): number[] {
  const [rx, ry, rz] = [deg2rad(deg[0]), deg2rad(deg[1]), deg2rad(deg[2])];
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  const Rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const Ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const Rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return mul3(Rz, mul3(Ry, Rx));
}

export function mul3(a: number[], b: number[]): number[] {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

export function apply3(m: number[], v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export const emptyAabb = (): Aabb => ({
  min: [Infinity, Infinity, Infinity],
  max: [-Infinity, -Infinity, -Infinity],
});

export const isEmptyAabb = (b: Aabb) => b.min[0] > b.max[0];

export function growAabb(b: Aabb, d: number): Aabb {
  return {
    min: [b.min[0] - d, b.min[1] - d, b.min[2] - d],
    max: [b.max[0] + d, b.max[1] + d, b.max[2] + d],
  };
}

export function unionAabb(a: Aabb, b: Aabb): Aabb {
  if (isEmptyAabb(a)) return b;
  if (isEmptyAabb(b)) return a;
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

export function intersectAabb(a: Aabb, b: Aabb): Aabb {
  if (isEmptyAabb(a) || isEmptyAabb(b)) return emptyAabb();
  return {
    min: [Math.max(a.min[0], b.min[0]), Math.max(a.min[1], b.min[1]), Math.max(a.min[2], b.min[2])],
    max: [Math.min(a.max[0], b.max[0]), Math.min(a.max[1], b.max[1]), Math.min(a.max[2], b.max[2])],
  };
}

export function transformAabb(b: Aabb, t: Vec3, r: Vec3, s: Vec3): Aabb {
  const m = eulerMatrix(r);
  let out = emptyAabb();
  for (let i = 0; i < 8; i++) {
    const c: Vec3 = [
      i & 1 ? b.max[0] : b.min[0],
      i & 2 ? b.max[1] : b.min[1],
      i & 4 ? b.max[2] : b.min[2],
    ];
    const p = apply3(m, [c[0] * s[0], c[1] * s[1], c[2] * s[2]]);
    for (let k = 0; k < 3; k++) {
      out.min[k] = Math.min(out.min[k], p[k] + t[k]);
      out.max[k] = Math.max(out.max[k], p[k] + t[k]);
    }
  }
  return out;
}

/**
 * Accept #rgb, #rgba, #rrggbb and #rrggbbaa (Monaco's colour picker inserts the
 * alpha form). Materials are opaque, so the alpha channel is dropped.
 */
export function normalizeHexColor(input: string): string {
  if (typeof input !== 'string') {
    throw new Error(`color(): expected a hex string, got ${String(input)}`);
  }
  let h = input.trim().replace(/^#/, '').toLowerCase();
  if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
  if (h.length === 8) h = h.slice(0, 6);
  if (!/^[0-9a-f]{6}$/.test(h)) {
    throw new Error(
      `color(): invalid hex colour "${input}" (use #rgb, #rgba, #rrggbb or #rrggbbaa)`,
    );
  }
  return `#${h}`;
}

export function parseHexColor(input: string): Vec3 {
  const h = normalizeHexColor(input).slice(1);
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  // sRGB -> linear so that the shader works in linear space
  const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return [toLinear(r), toLinear(g), toLinear(b)];
}

export const linearToHex = (c: Vec3): string => {
  const toSrgb = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
  return (
    '#' +
    c
      .map((v) => Math.round(clamp(toSrgb(v), 0, 1) * 255).toString(16).padStart(2, '0'))
      .join('')
  );
};
