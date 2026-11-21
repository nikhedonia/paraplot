// Import the editor API + core contributions directly instead of the
// `monaco-editor` umbrella entry: the latter registers every bundled language
// (and its loader) on startup, none of which this app uses. Only the JS/TS/C++
// tokenizers and the TypeScript language service are kept.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import 'monaco-editor/esm/vs/editor/editor.all.js';
import 'monaco-editor/esm/vs/editor/common/standaloneStrings.js';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js';
import * as tsContribution from 'monaco-editor/esm/vs/language/typescript/monaco.contribution.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { DSL_TYPES } from './core/typings';

interface TsDefaults {
  setCompilerOptions(options: Record<string, unknown>): void;
  setDiagnosticsOptions(options: Record<string, unknown>): void;
  addExtraLib(content: string, filePath?: string): { dispose(): void };
}

interface TsApi {
  javascriptDefaults: TsDefaults;
  typescriptDefaults: TsDefaults;
  ScriptTarget: { ES2020: number };
  ModuleKind: { ESNext: number };
  ModuleResolutionKind: { NodeJs: number };
}

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker: (id: string, label: string) => Worker };
  }
}

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

let ready = false;

export function setupMonaco(): typeof monaco {
  if (ready) return monaco;
  ready = true;

  // monaco 0.55 types the namespace as deprecated but ships it at runtime
  const ts = tsContribution as unknown as TsApi;
  const js = ts.javascriptDefaults;
  const tsd = ts.typescriptDefaults;
  const compilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    allowJs: true,
    checkJs: false,
    noImplicitAny: false,
    strict: false,
    noUnusedLocals: false,
    allowNonTsExtensions: true,
  };
  const diagnostics = {
    noSemanticValidation: false,
    noSyntaxValidation: false,
    diagnosticCodesToIgnore: [6133, 6196, 80001, 80006],
  };
  js.setCompilerOptions({ ...compilerOptions, checkJs: true });
  js.setDiagnosticsOptions(diagnostics);
  js.addExtraLib(DSL_TYPES, 'ts:paraplot/dsl.d.ts');
  tsd.setCompilerOptions(compilerOptions);
  tsd.setDiagnosticsOptions(diagnostics);
  tsd.addExtraLib(DSL_TYPES, 'ts:paraplot/dsl.d.ts');

  monaco.editor.defineTheme('paraplot', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'cfd8e0' },
      { token: 'comment', foreground: '5d6b76', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c9a0dc' },
      { token: 'string', foreground: '9dc2a0' },
      { token: 'number', foreground: 'e0a267' },
      { token: 'regexp', foreground: '9dc2a0' },
      { token: 'type', foreground: '7fb6c9' },
      { token: 'delimiter', foreground: '7b8894' },
      { token: 'operator', foreground: '9aa8b4' },
      { token: 'function', foreground: '82c7c0' },
      { token: 'variable', foreground: 'cfd8e0' },
      { token: 'parameter', foreground: 'd8c4a4' },
    ],
    colors: {
      'editor.background': '#0b0e12',
      'editor.foreground': '#cfd8e0',
      'editorLineNumber.foreground': '#2f3a44',
      'editorLineNumber.activeForeground': '#7b8894',
      'editorCursor.foreground': '#e0a267',
      'editor.selectionBackground': '#223040',
      'editor.inactiveSelectionBackground': '#18222c',
      'editor.lineHighlightBackground': '#0f141a',
      'editorIndentGuide.background1': '#182028',
      'editorIndentGuide.activeBackground1': '#2b3742',
      'editorWidget.background': '#11161c',
      'editorWidget.border': '#222c35',
      'editorSuggestWidget.background': '#11161c',
      'editorSuggestWidget.border': '#222c35',
      'editorSuggestWidget.selectedBackground': '#1b2733',
      'editorHoverWidget.background': '#11161c',
      'editorHoverWidget.border': '#222c35',
      'scrollbarSlider.background': '#ffffff12',
      'scrollbarSlider.hoverBackground': '#ffffff20',
      'editorBracketHighlight.foreground1': '#e0a267',
      'editorBracketHighlight.foreground2': '#67b3a8',
      'editorBracketHighlight.foreground3': '#c9a0dc',
      'editorOverviewRuler.border': '#00000000',
    },
  });

  return monaco;
}

export { monaco };
