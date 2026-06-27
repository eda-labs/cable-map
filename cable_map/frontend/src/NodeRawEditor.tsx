import MonacoEditor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
// oxlint-disable-next-line import/default -- Vite's ?worker gives a default export at build time
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

// Self-host Monaco — the cluster is air-gapped, so don't let @monaco-editor/react fetch it from a
// CDN. YAML highlighting is a built-in basic language, so only the core editor worker is needed.
(globalThis as typeof globalThis & { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};
loader.config({ monaco });

// Replica of EDA's "eda-theme" (base vs-dark/vs + inherit) — colours mapped from EDA's MUI tokens
// so the editor blends into the form surface (editor.background = formBody), with the teal JSON-key
// rule and EDA-styled hover/suggest widgets.
monaco.editor.defineTheme('eda-dark', {
  base: 'vs-dark', inherit: true,
  rules: [{ token: 'string.key.json', foreground: '3dc9b0' }],
  colors: {
    'editor.background': '#1A222E',                  // color.formBody
    'editor.selectionBackground': '#B8D1FF19',       // color.selectedBackground
    'editorHoverWidget.background': '#F7F9FD',        // color.tooltip
    'editorHoverWidget.foreground': '#2B2B2B',        // color.textReverseTheme
    'editorSuggestWidget.background': '#1A222E',      // color.background
    'editorSuggestWidget.foreground': '#E3E3E3',     // color.text
    'editorSuggestWidget.selectedBackground': '#B8D1FF19',
    'editorSuggestWidget.selectedForeground': '#E3E3E3',
  },
});
monaco.editor.defineTheme('eda-light', {
  base: 'vs', inherit: true,
  rules: [{ token: 'string.key.json', foreground: '008080' }],
  colors: {
    'editor.background': '#FFFFFF',
    'editor.selectionBackground': '#2E78FF19',
    'editorHoverWidget.background': '#252D38',
    'editorHoverWidget.foreground': '#FFFFFF',
    'editorSuggestWidget.background': '#FFFFFF',
    'editorSuggestWidget.foreground': '#2B2B2B',
    'editorSuggestWidget.selectedBackground': '#2E78FF19',
    'editorSuggestWidget.selectedForeground': '#2B2B2B',
  },
});

// Read-only YAML view of a resource CR, lazy-loaded so Monaco isn't in the main bundle. Font is
// Monaco's default (Menlo/Monaco 14px) — same as EDA, which only customises the theme.
export default function NodeRawEditor({ value, dark, onEditorMount }: {
  value: string;
  dark: boolean;
  onEditorMount?: (editor: monaco.editor.IStandaloneCodeEditor) => void;
}) {
  return (
    <MonacoEditor
      height="100%"
      language="yaml"
      value={value}
      theme={dark ? 'eda-dark' : 'eda-light'}
      onMount={(editor) => onEditorMount?.(editor)}
      options={{
        readOnly: true, domReadOnly: true,
        minimap: { enabled: false }, scrollBeyondLastLine: false,
        fontSize: 14, lineNumbers: 'on', folding: true, wordWrap: 'on', automaticLayout: true,
      }}
    />
  );
}
