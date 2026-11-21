import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';

type TokenKind =
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'type'
  | 'function'
  | 'operator'
  | 'punct'
  | 'ident'
  | 'plain';

interface Token {
  text: string;
  kind: TokenKind;
}

const JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'break',
  'continue', 'new', 'class', 'extends', 'export', 'default', 'import', 'from', 'async', 'await',
  'try', 'catch', 'throw', 'typeof', 'instanceof', 'in', 'of', 'delete', 'void', 'yield', 'this',
  'true', 'false', 'null', 'undefined',
]);

const GLSL_KEYWORDS = new Set([
  'return', 'if', 'else', 'for', 'while', 'do', 'break', 'continue', 'discard', 'uniform', 'in',
  'out', 'inout', 'const', 'struct', 'precision', 'highp', 'mediump', 'lowp', 'true', 'false',
  'layout',
]);

const TYPE_WORDS = new Set([
  'Number', 'String', 'Boolean', 'Array', 'Object', 'Promise',
  'int', 'float', 'bool', 'vec2', 'vec3', 'vec4', 'mat2', 'mat3', 'mat4', 'sampler2D',
]);

const NUMBER_RE = /^(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/;
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*/;

function tokenize(source: string, language: 'javascript' | 'glsl'): Token[] {
  const out: Token[] = [];
  const glsl = language === 'glsl';
  const keywords = glsl ? GLSL_KEYWORDS : JS_KEYWORDS;
  let i = 0;

  const push = (text: string, kind: TokenKind) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ text, kind });
  };

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    // comments
    if (c === '/' && next === '/') {
      let j = i + 2;
      while (j < source.length && source[j] !== '\n') j++;
      push(source.slice(i, j), 'comment');
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const j = end === -1 ? source.length : end + 2;
      push(source.slice(i, j), 'comment');
      i = j;
      continue;
    }

    // strings and template literals (template substitutions stay strings here)
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === c) {
          j++;
          break;
        }
        if (c !== '`' && source[j] === '\n') break;
        j++;
      }
      push(source.slice(i, j), 'string');
      i = j;
      continue;
    }

    // numbers
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(next ?? ''))) {
      const m = NUMBER_RE.exec(source.slice(i));
      if (m) {
        push(m[0], 'number');
        i += m[0].length;
        continue;
      }
    }

    // identifiers, keywords and calls
    if (/[A-Za-z_$]/.test(c)) {
      const m = IDENT_RE.exec(source.slice(i));
      if (m) {
        const word = m[0];
        let after = i + word.length;
        while (after < source.length && /[ \t]/.test(source[after])) after++;
        const isCall = source[after] === '(';
        const kind: TokenKind = keywords.has(word)
          ? 'keyword'
          : TYPE_WORDS.has(word)
            ? 'type'
            : isCall
              ? 'function'
              : 'ident';
        push(word, kind);
        i += word.length;
        continue;
      }
    }

    // whitespace stays plain (merged with punctuation)
    if (/\s/.test(c)) {
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j])) j++;
      push(source.slice(i, j), 'plain');
      i = j;
      continue;
    }

    // multi-character operators, then punctuation
    const op = /^(?:===|!==|=>|==|!=|<=|>=|&&|\|\||\*\*|\+\+|--|\+=|-=|\*=|\/=|%=|<<|>>)/.exec(
      source.slice(i),
    );
    if (op) {
      push(op[0], 'operator');
      i += op[0].length;
      continue;
    }
    if (/[+\-*/%=<>!&|^~?:]/.test(c)) {
      push(c, 'operator');
      i++;
      continue;
    }
    if (/[()[\]{},;.]/.test(c)) {
      push(c, 'punct');
      i++;
      continue;
    }

    push(c, 'plain');
    i++;
  }

  return out;
}

export interface SourcePreviewProps {
  value: string;
  note: string;
  language?: 'javascript' | 'glsl';
  busy?: boolean;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onActivate?: () => void;
}

/**
 * Lightweight highlighting editor shown until the user opens Monaco. The
 * textarea is transparent and sits over a highlighted <pre>; both share the
 * same metrics and scroll position, so editing and selection stay native.
 */
function SourcePreviewImpl({
  value,
  note,
  language = 'javascript',
  busy = false,
  readOnly = false,
  onChange,
  onActivate,
}: SourcePreviewProps) {
  const preRef = useRef<HTMLPreElement | null>(null);
  // the textarea is the real input: keep typing native and let the syntax
  // colours catch up a frame later instead of tokenising on every keystroke
  const [highlighted, setHighlighted] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setHighlighted(value), 110);
    return () => window.clearTimeout(id);
  }, [value]);
  const tokens = useMemo(() => tokenize(highlighted, language), [highlighted, language]);

  return (
    <div className={`source-preview ${readOnly ? 'is-readonly' : ''}`}>
      <div className="source-preview-note">
        {busy ? <span className="spinner mini" /> : <Icon name="code" size={11} />}
        <span>{note}</span>
        {onActivate && (
          <button className="ghostbtn source-preview-edit" onClick={onActivate}>
            full editor
          </button>
        )}
      </div>
      <div className="source-code">
        <pre className="source-highlight" aria-hidden="true" ref={preRef}>
          <code>
            {tokens.map((t, i) => (
              <span key={i} className={`tok-${t.kind}`}>
                {t.text}
              </span>
            ))}
          </code>
        </pre>
        <textarea
          className="source-preview-text"
          value={value}
          readOnly={readOnly}
          onChange={(e) => onChange?.(e.target.value)}
          onScroll={(e) => {
            const pre = preRef.current;
            if (!pre) return;
            pre.scrollTop = e.currentTarget.scrollTop;
            pre.scrollLeft = e.currentTarget.scrollLeft;
          }}
          spellCheck={false}
          wrap="off"
          aria-label="scene source"
        />
      </div>
    </div>
  );
}

export const SourcePreview = memo(SourcePreviewImpl);
