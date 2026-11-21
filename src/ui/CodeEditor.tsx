import { memo, useEffect, useRef, useState } from 'react';

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  language?: string;
  active?: boolean;
  path?: string;
}

function CodeEditorImpl({
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
  const valueRef = useRef(value);
  valueRef.current = value;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let cleanup = () => {};
    const host = hostRef.current;
    if (!host) return;

    void import('../monaco-setup').then(({ setupMonaco }) => {
      if (cancelled || !hostRef.current) return;
      const monaco = setupMonaco();
      const model = monaco.editor.createModel(
        valueRef.current,
        language,
        monaco.Uri.parse(`inmemory://paraplot/${path}`),
      );
      const editor = monaco.editor.create(host, {
        model,
        theme: 'paraplot',
        readOnly: readOnlyRef.current,
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
      setLoading(false);
      const sub = editor.onDidChangeModelContent(() => {
        if (!readOnlyRef.current) onChangeRef.current?.(editor.getValue());
      });

      cleanup = () => {
        sub.dispose();
        editor.dispose();
        model.dispose();
        editorRef.current = null;
      };
    }).catch((err: unknown) => {
      if (!cancelled) {
        setLoading(false);
        setLoadError((err as Error)?.message ?? 'could not load the editor');
      }
    });

    return () => {
      cancelled = true;
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, path]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  useEffect(() => {
    if (!active) return;
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (model && model.getValue() !== value) {
      model.setValue(value);
    }
  }, [value, active]);

  useEffect(() => {
    if (!active) return;
    const editor = editorRef.current;
    if (!editor) return;
    const id = requestAnimationFrame(() => editor.layout());
    return () => cancelAnimationFrame(id);
  }, [active]);

  return (
    <div className="code-editor-wrap">
      <div className="code-editor" ref={hostRef} />
      {(loading || loadError) && (
        <div className="source-preview">
          <div className={`source-preview-note ${loadError ? 'error' : ''}`}>
            {loadError ? <span>!</span> : <span className="spinner mini" />}
            {loadError ?? 'loading the editor — source is read-only'}
          </div>
          <pre>
            <code>{value}</code>
          </pre>
        </div>
      )}
    </div>
  );
}

export const CodeEditor = memo(CodeEditorImpl);
