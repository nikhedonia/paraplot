import { useEffect, useState } from 'react';
import type { Control, ParamSchema, ParamValue, ParamValues } from '../core/controls';
import { isControl } from '../core/controls';
import { normalizeHexColor } from '../core/math';
import { Icon } from './Icon';

export interface ParamPanelProps {
  schema: ParamSchema;
  values: ParamValues;
  onChange: (values: ParamValues) => void;
  onReset: () => void;
}

const fmt = (v: number, step: number) => {
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  const decimals = step >= 1 ? 0 : Math.min(4, Math.max(0, Math.ceil(-Math.log10(step))));
  return v.toFixed(decimals);
};

function NumField({
  value,
  decimals,
  min,
  max,
  step,
  onChange,
  className = '',
}: {
  value: number;
  decimals: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
  className?: string;
}) {
  const [text, setText] = useState(value.toFixed(decimals));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(value.toFixed(decimals));
  }, [value, decimals, focused]);
  return (
    <input
      className={className}
      type="number"
      inputMode="decimal"
      value={text}
      min={min}
      max={max}
      step={step}
      onFocus={() => setFocused(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur();
      }}
      onBlur={() => {
        setFocused(false);
        setText(value.toFixed(decimals));
      }}
      onChange={(e) => {
        setText(e.target.value);
        const n = parseFloat(e.target.value);
        if (Number.isFinite(n)) onChange(n);
      }}
    />
  );
}

export function ParamPanel({ schema, values, onChange, onReset }: ParamPanelProps) {
  const entries = Object.keys(schema).filter((k) => isControl(schema[k]));
  const set = (key: string, v: ParamValue) => onChange({ ...values, [key]: v });

  return (
    <section className="dock-panel params">
      <header className="dock-head">
        <span className="dock-title">parameters</span>
        <span className="dock-count">{entries.length}</span>
        <button className="ghostbtn" onClick={onReset} title="Reset all parameters">
          <Icon name="reset" size={13} />
          reset
        </button>
      </header>

      <div className="dock-body">
        {entries.length === 0 && (
          <p className="dock-empty">
            No parameters. Add <code>export const params = {'{ ... }'}</code> to expose constants here.
          </p>
        )}

        {entries.map((key) => {
          const c = schema[key] as Control;
          const v = values[key];

          if (c.__ctl === 'number' || c.__ctl === 'int') {
            const n = typeof v === 'number' ? v : c.value;
            const decimals = c.step >= 1 ? 0 : Math.min(4, Math.max(1, Math.ceil(-Math.log10(c.step))));
            return (
              <div className="param" key={key}>
                <div className="param-head">
                  <span className="param-name" title={key}>{c.label ?? key}</span>
                  <span className="param-value">
                    <NumField
                      value={n}
                      decimals={decimals}
                      min={c.min}
                      max={c.max}
                      step={c.step}
                      onChange={(x) => set(key, x)}
                    />
                    {c.unit ? <em>{c.unit}</em> : null}
                  </span>
                </div>
                <input
                  className="slider"
                  type="range"
                  min={c.min}
                  max={c.max}
                  step={c.step}
                  value={n}
                  onChange={(e) => set(key, parseFloat(e.target.value))}
                  style={{ ['--fill' as string]: `${((n - c.min) / Math.max(1e-9, c.max - c.min)) * 100}%` }}
                />
                <div className="param-range">
                  <span>{fmt(c.min, c.step)}</span>
                  <span>{fmt(c.max, c.step)}</span>
                </div>
              </div>
            );
          }

          if (c.__ctl === 'bool') {
            const on = typeof v === 'boolean' ? v : c.value;
            return (
              <div className="param row" key={key}>
                <span className="param-name" title={key}>{c.label ?? key}</span>
                <button
                  className={`toggle ${on ? 'on' : ''}`}
                  onClick={() => set(key, !on)}
                  aria-pressed={on}
                >
                  <span className="knob" />
                </button>
              </div>
            );
          }

          if (c.__ctl === 'color') {
            let hex = typeof v === 'string' ? v : c.value;
            try {
              hex = normalizeHexColor(hex);
            } catch {
              hex = '#000000';
            }
            return (
              <div className="param row" key={key}>
                <span className="param-name" title={key}>{c.label ?? key}</span>
                <label className="colorwell">
                  <span className="swatch" style={{ background: hex }} />
                  <span className="hex">{hex.toUpperCase()}</span>
                  <input type="color" value={hex} onChange={(e) => set(key, e.target.value)} />
                </label>
              </div>
            );
          }

          if (c.__ctl === 'select') {
            const val = typeof v === 'string' ? v : c.value;
            return (
              <div className="param row" key={key}>
                <span className="param-name" title={key}>{c.label ?? key}</span>
                <select value={val} onChange={(e) => set(key, e.target.value)}>
                  {c.options.map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              </div>
            );
          }

          // vec3
          const vec = Array.isArray(v) ? (v as [number, number, number]) : c.value;
          return (
            <div className="param" key={key}>
              <div className="param-head">
                <span className="param-name" title={key}>{c.label ?? key}</span>
                <span className="param-value mono">
                  {vec.map((x, i) => (
                    <span key={i} className={`axis-${'xyz'[i]}`}>{x.toFixed(2)}</span>
                  ))}
                </span>
              </div>
              {vec.map((x, i) => (
                <div className="vec-row" key={i}>
                  <span className={`vec-axis axis-${'xyz'[i]}`}>{'xyz'[i]}</span>
                  <input
                    className="slider"
                    type="range"
                    min={c.min}
                    max={c.max}
                    step={c.step}
                    value={x}
                    onChange={(e) => {
                      const next = [...vec] as [number, number, number];
                      next[i] = parseFloat(e.target.value);
                      set(key, next);
                    }}
                    style={{ ['--fill' as string]: `${((x - c.min) / Math.max(1e-9, c.max - c.min)) * 100}%` }}
                  />
                  <NumField
                    className="mini-num"
                    value={x}
                    decimals={2}
                    min={c.min}
                    max={c.max}
                    step={c.step}
                    onChange={(nv) => {
                      const next = [...vec] as [number, number, number];
                      next[i] = nv;
                      set(key, next);
                    }}
                  />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
