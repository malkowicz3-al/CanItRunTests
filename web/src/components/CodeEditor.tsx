import '../monaco';
import Editor from '@monaco-editor/react';
import { Loader, useComputedColorScheme } from '@mantine/core';

export function CodeEditor({ value, onChange, language, readOnly, path }: {
  value: string; onChange?: (v: string) => void; language: string; readOnly?: boolean;
  path?: string; // separate model per script, so undo history does not mix between requests
}) {
  const scheme = useComputedColorScheme('dark');
  return (
    <Editor
      height="100%"
      value={value}
      language={language}
      path={path}
      theme={scheme === 'dark' ? 'cirt-dark' : 'cirt-light'}
      loading={<Loader size="sm" />}
      onChange={(v) => onChange?.(v ?? '')}
      options={{
        readOnly, domReadOnly: readOnly, minimap: { enabled: false }, fontSize: 13, fontFamily: '"JetBrains Mono", Consolas, monospace', tabSize: 2,
        scrollBeyondLastLine: false, automaticLayout: true, fixedOverflowWidgets: true,
        wordWrap: readOnly ? 'on' : 'off', renderLineHighlight: readOnly ? 'none' : 'line', folding: true,
        lineNumbersMinChars: 3, padding: { top: 6 }, scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      }}
    />
  );
}
