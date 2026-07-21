import { useEffect, useRef } from "react";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";

const editorTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "transparent",
      color: "var(--foreground)",
      fontSize: "0.85rem",
      height: "100%",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-content": {
      fontFamily: "ui-monospace, monospace",
      caretColor: "var(--foreground)",
      padding: "0.6rem 0.25rem",
    },
    ".cm-scroller": { fontFamily: "ui-monospace, monospace" },
    ".cm-ySelectionInfo": {
      fontFamily: "system-ui, sans-serif",
      fontSize: "0.65rem",
      padding: "0.05rem 0.3rem",
      borderRadius: "4px",
      opacity: 1,
    },
  },
  { dark: true },
);

/**
 * The collaborative markdown editor for one task file: CodeMirror 6 bound to
 * the checkout's Y.Text via yCollab, so remote collaborators' cursors and
 * selection highlights render live (colored by their awareness `user`).
 * While mounted, it advertises the open file on awareness `openPath` — the
 * board uses that for its card presence dots.
 */
export function TaskEditor({
  path,
  text,
  awareness,
}: {
  path: string;
  text: Y.Text;
  awareness: Awareness;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const undoManager = new Y.UndoManager(text);
    const view = new EditorView({
      state: EditorState.create({
        doc: text.toString(),
        extensions: [
          keymap.of([...yUndoManagerKeymap, ...defaultKeymap]),
          EditorView.lineWrapping,
          editorTheme,
          yCollab(text, awareness, { undoManager }),
        ],
      }),
      parent: container,
    });
    return () => {
      view.destroy();
      undoManager.destroy();
    };
  }, [text, awareness]);

  useEffect(() => {
    awareness.setLocalStateField("openPath", path);
    return () => {
      awareness.setLocalStateField("openPath", null);
    };
  }, [path, awareness]);

  return <div ref={containerRef} style={{ flex: 1, minHeight: "16rem", overflow: "hidden" }} />;
}
