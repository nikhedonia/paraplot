import { useEffect, useRef } from 'react';
import { setupMonaco } from '../monaco-setup';

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  language?: string;
  active?: boolean;
  path?: string;
}

export function CodeEditor({
  value,
  onChange,
  readOnly = false,
  language = 'javascript',
  active = true,
  path = 'scene.js',
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<any>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const monaco = setupMonaco();
    const host = hostRef.current;
    if (!host) return;

    const model = monaco.editor.createModel(value, language, monaco.Uri.parse(`inmemory://paraplot/${path}`));
    const editor = monaco.editor.create(host, {
      model,
      theme: 'paraplot',
      readOnly,
      automaticLayout: true,
      fontSize: 12.5,
      lineHeight: 19,
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontLigatures: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      renderLineHighlight: 'line',
      renderLineHighlightOnlyWhenFocus: true,
      padding: { top: 12, bottom: 24 },
      tabSize: 2,
      wordWrap: 'off',
      guides: { indentation: true, bracketPairs: false },
      bracketPairColorization: { enabled: true },
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9, useShadows: false },
      contextmenu: false,
      quickSuggestions: { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: true,
      fixedOverflowWidgets: true,
      lineNumbersMinChars: 3,
      glyphMargin: false,
      folding: false,
    });

    editorRef.current = editor;
    const sub = editor.onDidChangeModelContent(() => {
      if (!readOnly) onChangeRef.current?.(editor.getValue());
    });

    return () => {
      sub.dispose();
      editor.dispose();
      model.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readOnly, path]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (model && model.getValue() !== value) {
      model.setValue(value);
    }
  }, [value, readOnly]);

  useEffect(() => {
    if (!active) return;
    const editor = editorRef.current;
    if (!editor) return;
    const id = requestAnimationFrame(() => editor.layout());
    return () => cancelAnimationFrame(id);
  }, [active]);

  return <div className="code-editor" ref={hostRef} />;
}
