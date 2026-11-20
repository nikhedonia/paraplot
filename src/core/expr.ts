/**
 * Implicit equation language.
 *
 * A tiny, safe expression parser that turns text like
 *
 *   "abs(sin(x*f) * cos(y*f) + sin(z*f)) - t"
 *
 * into a GLSL expression. No eval, no code execution, no string injection:
 * only the documented functions and the declared variables are allowed.
 */

interface FuncSpec {
  glsl: string;
  min: number;
  max: number;
}

const FUNCS: Record<string, FuncSpec> = {
  sin: { glsl: 'sin', min: 1, max: 1 },
  cos: { glsl: 'cos', min: 1, max: 1 },
  tan: { glsl: 'tan', min: 1, max: 1 },
  asin: { glsl: 'asin', min: 1, max: 1 },
  acos: { glsl: 'acos', min: 1, max: 1 },
  atan: { glsl: 'atan', min: 1, max: 2 },
  atan2: { glsl: 'atan', min: 2, max: 2 },
  abs: { glsl: 'abs', min: 1, max: 1 },
  sign: { glsl: 'sign', min: 1, max: 1 },
  floor: { glsl: 'floor', min: 1, max: 1 },
  ceil: { glsl: 'ceil', min: 1, max: 1 },
  round: { glsl: 'round', min: 1, max: 1 },
  fract: { glsl: 'fract', min: 1, max: 1 },
  sqrt: { glsl: 'sqrt', min: 1, max: 1 },
  exp: { glsl: 'exp', min: 1, max: 1 },
  log: { glsl: 'log', min: 1, max: 1 },
  pow: { glsl: 'pow', min: 2, max: 2 },
  min: { glsl: 'min', min: 2, max: 2 },
  max: { glsl: 'max', min: 2, max: 2 },
  mod: { glsl: 'mod', min: 2, max: 2 },
  clamp: { glsl: 'clamp', min: 3, max: 3 },
  mix: { glsl: 'mix', min: 3, max: 3 },
  step: { glsl: 'step', min: 2, max: 2 },
  smoothstep: { glsl: 'smoothstep', min: 3, max: 3 },
  length: { glsl: 'length', min: 1, max: 1 },
  dot: { glsl: 'dot', min: 2, max: 2 },
  cross: { glsl: 'cross', min: 2, max: 2 },
  normalize: { glsl: 'normalize', min: 1, max: 1 },
  select: { glsl: 'selectf', min: 3, max: 3 },
  vec2: { glsl: 'vec2', min: 2, max: 2 },
  vec3: { glsl: 'vec3', min: 3, max: 3 },
};

const CONSTS: Record<string, number> = {
  pi: Math.PI,
  PI: Math.PI,
  tau: Math.PI * 2,
  TAU: Math.PI * 2,
};

const AXES = /^[xyzw]{1,4}$/;

const fmt = (v: number): string => {
  if (!Number.isFinite(v)) throw new Error('implicit(): variables must be finite numbers');
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return `${v}.0`;
  return String(v);
};

type Token =
  | { k: 'num'; v: string; pos: number }
  | { k: 'id'; v: string; pos: number }
  | { k: 'op'; v: string; pos: number };

const OPS = '+-*/%^(),.';

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (!m) throw new Error(`unexpected "${c}" at ${i}`);
      out.push({ k: 'num', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ k: 'id', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (src.startsWith('**', i)) {
      out.push({ k: 'op', v: '^', pos: i });
      i += 2;
      continue;
    }
    if (OPS.includes(c)) {
      out.push({ k: 'op', v: c, pos: i });
      i++;
      continue;
    }
    throw new Error(`unexpected character "${c}" at ${i}`);
  }
  return out;
}

type VarEmitter = (name: string, value: number) => string;

class Parser {
  private i = 0;
  constructor(
    private readonly toks: Token[],
    private readonly vars: Record<string, number>,
    private readonly emitVar?: VarEmitter,
  ) {}

  parse(): string {
    const out = this.expr();
    if (this.i < this.toks.length) {
      const t = this.toks[this.i];
      throw new Error(`unexpected "${t.v}" at ${t.pos}`);
    }
    return out;
  }

  private peek(): Token | undefined {
    return this.toks[this.i];
  }

  private eatOp(v: string): boolean {
    const t = this.peek();
    if (t && t.k === 'op' && t.v === v) {
      this.i++;
      return true;
    }
    return false;
  }

  private expectOp(v: string) {
    if (!this.eatOp(v)) {
      const t = this.peek();
      throw new Error(`expected "${v}" at ${t ? t.pos : 'end of expression'}`);
    }
  }

  private expr(): string {
    let a = this.term();
    for (;;) {
      if (this.eatOp('+')) a = `(${a} + ${this.term()})`;
      else if (this.eatOp('-')) a = `(${a} - ${this.term()})`;
      else return a;
    }
  }

  private term(): string {
    let a = this.unary();
    for (;;) {
      if (this.eatOp('*')) a = `(${a} * ${this.unary()})`;
      else if (this.eatOp('/')) a = `(${a} / ${this.unary()})`;
      else if (this.eatOp('%')) a = `mod(${a}, ${this.unary()})`;
      else return a;
    }
  }

  private unary(): string {
    if (this.eatOp('-')) return `(-${this.unary()})`;
    if (this.eatOp('+')) return this.unary();
    return this.power();
  }

  private power(): string {
    const a = this.primary();
    if (this.eatOp('^')) return `pow(${a}, ${this.unary()})`;
    return a;
  }

  private primary(): string {
    const t = this.peek();
    if (!t) throw new Error('unexpected end of expression');

    let value: string;

    if (t.k === 'num') {
      this.i++;
      value = t.v.includes('.') || /[eE]/.test(t.v) ? t.v : `${t.v}.0`;
    } else if (t.k === 'id') {
      this.i++;
      const name = t.v;
      if (this.eatOp('(')) {
        const spec = FUNCS[name];
        if (!spec) throw new Error(`unknown function "${name}" at ${t.pos}`);
        const args: string[] = [];
        if (!this.eatOp(')')) {
          for (;;) {
            args.push(this.expr());
            if (this.eatOp(')')) break;
            this.expectOp(',');
          }
        }
        if (args.length < spec.min || args.length > spec.max) {
          const want = spec.min === spec.max ? `${spec.min}` : `${spec.min}..${spec.max}`;
          throw new Error(`${name}() takes ${want} argument(s), got ${args.length}`);
        }
        value = `${spec.glsl}(${args.join(', ')})`;
      } else if (name in this.vars) {
        value = this.emitVar ? this.emitVar(name, this.vars[name]) : fmt(this.vars[name]);
      } else if (name in CONSTS) {
        value = fmt(CONSTS[name]);
      } else if (name === 'x' || name === 'y' || name === 'z') {
        value = `p.${name}`;
      } else if (name === 'p') {
        value = 'p';
      } else if (name === 'time') {
        value = 'u_time';
      } else {
        throw new Error(
          `unknown identifier "${name}" at ${t.pos}. ` +
            `Use x, y, z, p, or pass a variable map: implicit(expr, { vars: { ${name}: 1 } })`,
        );
      }
    } else if (t.v === '(') {
      this.i++;
      value = `(${this.expr()})`;
      this.expectOp(')');
    } else {
      throw new Error(`unexpected "${t.v}" at ${t.pos}`);
    }

    // swizzles: p.x, (p).xy
    while (this.eatOp('.')) {
      const n = this.peek();
      if (!n || n.k !== 'id') throw new Error(`expected a swizzle after "." at ${n ? n.pos : 'end'}`);
      if (!AXES.test(n.v)) throw new Error(`invalid swizzle ".${n.v}" at ${n.pos}`);
      this.i++;
      value = `${value}.${n.v}`;
    }

    return value;
  }
}

/**
 * Parse an implicit equation into a GLSL expression.
 *
 * `emitVar` lets the code generator replace named constants with uniform
 * references (instead of inlining them), which keeps the shader text stable
 * while a slider moves.
 */
export function compileExpression(
  src: string,
  vars: Record<string, number> = {},
  emitVar?: VarEmitter,
): string {
  if (typeof src !== 'string') {
    throw new Error('implicit(): the equation must be a string, e.g. "x*x + y*y - 1"');
  }
  if (!src.trim()) throw new Error('implicit(): the equation is empty');
  const cleanVars: Record<string, number> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`implicit(): invalid variable name "${k}"`);
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`implicit(): variable "${k}" must be a finite number`);
    }
    cleanVars[k] = v;
  }
  return new Parser(tokenize(src), cleanVars, emitVar).parse();
}

export const EXPR_FUNCTIONS = Object.keys(FUNCS);
