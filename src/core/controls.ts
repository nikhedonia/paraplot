import type { Vec3 } from './types';
import { clamp, isVec3, normalizeHexColor, parseHexColor, linearToHex } from './math';

export interface NumberControl {
  __ctl: 'number';
  value: number;
  min: number;
  max: number;
  step: number;
  label?: string;
  unit?: string;
}

export interface IntControl {
  __ctl: 'int';
  value: number;
  min: number;
  max: number;
  step: number;
  label?: string;
  unit?: string;
}

export interface BoolControl {
  __ctl: 'bool';
  value: boolean;
  label?: string;
}

export interface ColorControl {
  __ctl: 'color';
  value: string;
  label?: string;
}

export interface SelectControl {
  __ctl: 'select';
  value: string;
  options: string[];
  label?: string;
}

export interface Vec3Control {
  __ctl: 'vec3';
  value: Vec3;
  min: number;
  max: number;
  step: number;
  label?: string;
}

export type Control = NumberControl | IntControl | BoolControl | ColorControl | SelectControl | Vec3Control;
export type ParamValue = number | boolean | string | Vec3;
export type ParamSchema = Record<string, Control | ParamValue>;
export type ParamValues = Record<string, ParamValue>;

export interface NumberOpts {
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  unit?: string;
}

export interface Vec3Opts {
  min?: number;
  max?: number;
  step?: number;
  label?: string;
}

const autoStep = (min: number, max: number) => {
  const span = Math.abs(max - min);
  if (span <= 0) return 0.01;
  const raw = span / 100;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  return Math.max(mag / 10, Number(raw.toPrecision(1)));
};

export function num(value: number, opts: NumberOpts = {}): NumberControl {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`num(): value must be a finite number, got ${String(value)}`);
  }
  const span = Math.max(Math.abs(value), 1);
  const min = opts.min ?? (value >= 0 ? 0 : -span * 2);
  const max = opts.max ?? (value >= 0 ? span * 2 : 0);
  return {
    __ctl: 'number',
    value,
    min,
    max,
    step: opts.step ?? autoStep(min, max),
    label: opts.label,
    unit: opts.unit,
  };
}

export function int(value: number, opts: NumberOpts = {}): IntControl {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`int(): value must be a finite number, got ${String(value)}`);
  }
  const v = Math.round(value);
  const span = Math.max(Math.abs(v), 1);
  const min = Math.round(opts.min ?? 0);
  const max = Math.round(opts.max ?? (v >= 0 ? span * 2 : 0));
  return {
    __ctl: 'int',
    value: v,
    min,
    max,
    step: Math.max(1, Math.round(opts.step ?? 1)),
    label: opts.label,
    unit: opts.unit,
  };
}

export function bool(value: boolean, label?: string): BoolControl {
  return { __ctl: 'bool', value: !!value, label };
}

export function color(value: string, label?: string): ColorControl {
  // alpha is accepted but dropped: materials are opaque
  return { __ctl: 'color', value: normalizeHexColor(value), label };
}

export function select(value: string, options: string[], label?: string): SelectControl {
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error('select(): options must be a non-empty array');
  }
  if (!options.includes(value)) {
    throw new Error(`select(): value "${value}" is not one of ${options.join(', ')}`);
  }
  return { __ctl: 'select', value, options: [...options], label };
}

export function vec3Control(value: Vec3, opts: Vec3Opts = {}): Vec3Control {
  if (!isVec3(value)) throw new Error('vec3(): expected [x, y, z]');
  return {
    __ctl: 'vec3',
    value: [value[0], value[1], value[2]],
    min: opts.min ?? -2,
    max: opts.max ?? 2,
    step: opts.step ?? 0.01,
    label: opts.label,
  };
}

export const isControl = (v: unknown): v is Control =>
  !!v && typeof v === 'object' && typeof (v as { __ctl?: unknown }).__ctl === 'string';

function coerce(c: Control, raw: ParamValue | undefined): ParamValue {
  if (raw === undefined) return cloneValue(c.value);
  switch (c.__ctl) {
    case 'number':
    case 'int': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return c.value;
      return clamp(c.__ctl === 'int' ? Math.round(raw) : raw, c.min, c.max);
    }
    case 'bool':
      return typeof raw === 'boolean' ? raw : c.value;
    case 'color':
      return typeof raw === 'string' ? safeColor(raw, c.value) : c.value;
    case 'select':
      return typeof raw === 'string' && c.options.includes(raw) ? raw : c.value;
    case 'vec3': {
      if (!isVec3(raw)) return cloneValue(c.value);
      return [
        clamp(raw[0], c.min, c.max),
        clamp(raw[1], c.min, c.max),
        clamp(raw[2], c.min, c.max),
      ];
    }
  }
}

const safeColor = (raw: string, fallback: string) => {
  try {
    return normalizeHexColor(raw);
  } catch {
    return fallback;
  }
};

const cloneValue = <T extends ParamValue>(v: T): T => (Array.isArray(v) ? ([...v] as T) : v);

/**
 * Pure resolution of a schema + user overrides -> the values handed to `build`.
 * Unknown keys in `values` are ignored; missing keys fall back to defaults.
 */
export function resolveParams(schema: ParamSchema, values: ParamValues): ParamValues {
  const out: ParamValues = {};
  for (const key of Object.keys(schema)) {
    const entry = schema[key];
    out[key] = isControl(entry) ? coerce(entry, values[key]) : cloneValue(entry as ParamValue);
  }
  return out;
}

export function controlsOf(schema: ParamSchema): Array<{ key: string; control: Control }> {
  return Object.keys(schema)
    .filter((k) => isControl(schema[k]))
    .map((key) => ({ key, control: schema[key] as Control }));
}

export function defaultValues(schema: ParamSchema): ParamValues {
  return resolveParams(schema, {});
}

export { linearToHex };
