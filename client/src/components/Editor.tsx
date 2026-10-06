import { useEffect, useRef } from 'react';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { tags } from '@lezer/highlight';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';

const mdHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontWeight: '700', fontSize: '1.5em', color: 'var(--accent)' },
  { tag: tags.heading2, fontWeight: '700', fontSize: '1.3em', color: 'var(--accent)' },
  { tag: tags.heading3, fontWeight: '700', fontSize: '1.15em', color: 'var(--accent)' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: '700', color: 'var(--accent)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--link)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--link)' },
  { tag: tags.monospace, color: 'var(--code)', background: 'var(--code-bg)', borderRadius: '3px' },
  { tag: tags.quote, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: tags.list, color: 'var(--accent)' },
  { tag: tags.processingInstruction, color: 'var(--muted)' },
  { tag: tags.contentSeparator, color: 'var(--muted)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '15px', background: 'transparent', color: 'var(--fg)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6', padding: '16px 0 40vh' },
  '.cm-content': { padding: '0 20px', maxWidth: '900px', caretColor: 'var(--fg)' },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--fg)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { background: 'var(--selection) !important' },
  '.cm-activeLine': { background: 'transparent' },
  '.cm-ySelectionInfo': { fontFamily: 'var(--sans)', fontSize: '11px', padding: '1px 4px', borderRadius: '3px', opacity: '1' },
});

export function Editor({ text, awareness, readOnly = false }: { text: Y.Text; awareness: Awareness; readOnly?: boolean }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    const undoManager = new Y.UndoManager(text, { trackedOrigins: new Set([null]) });
    const state = EditorState.create({
      doc: text.toString(),
      extensions: [
        keymap.of([...yUndoManagerKeymap, ...defaultKeymap, indentWithTab]),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        syntaxHighlighting(mdHighlight),
        EditorView.lineWrapping,
        placeholder('Start typing…'),
        yCollab(text, awareness, { undoManager }),
        theme,
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ],
    });
    const view = new EditorView({ state, parent: host.current });
    return () => {
      view.destroy();
      undoManager.destroy();
    };
  }, [text, awareness, readOnly]);

  return <div className="editor" ref={host} data-testid="editor" />;
}
