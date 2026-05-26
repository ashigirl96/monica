import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type ViewUpdate,
} from "@codemirror/view";
export type CmFocusListener = (focused: boolean) => void;
export type CmChangeListener = (doc: string) => void;

export interface CreateCmStateOptions {
  doc: string;
  dark: boolean;
  themeCompartment: Compartment;
  onFocus: CmFocusListener;
  onChange: CmChangeListener;
}

const baseExtensions: Extension[] = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  highlightActiveLine(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
];

export function darkExtension(dark: boolean): Extension {
  return dark ? oneDark : [];
}

export function createCmState({
  doc,
  dark,
  themeCompartment,
  onFocus,
  onChange,
}: CreateCmStateOptions): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      ...baseExtensions,
      markdown(),
      themeCompartment.of(darkExtension(dark)),
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.focusChanged) onFocus(update.view.hasFocus);
        if (update.docChanged && update.view.hasFocus) onChange(update.state.doc.toString());
      }),
    ],
  });
}

export { Compartment };
