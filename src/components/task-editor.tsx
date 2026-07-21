import { useEffect, useRef } from "react";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, keymap, type DecorationSet } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { agoText, RECENT_TOUCH_TTL_MS, transactionAuthor } from "../lib/recency.ts";

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
    ".cm-tooltip": {
      backgroundColor: "var(--popover)",
      color: "var(--popover-foreground)",
      border: "1px solid var(--border)",
      borderRadius: "6px",
      padding: "0.2rem 0.5rem",
      fontSize: "0.7rem",
      fontFamily: "system-ui, sans-serif",
    },
  },
  { dark: false },
);

// ---------------------------------------------------------------------------
// Recency glow: remote insertions get a mark decoration in their author's
// color for RECENT_TOUCH_TTL_MS. Yjs hands us exactly which items each
// remote transaction added (and their author's clientID); CodeMirror's
// decoration mapping keeps the marks glued to the right characters while
// everyone keeps typing. Hovering a glow names the author.
// ---------------------------------------------------------------------------

type GlowSpec = { from: number; to: number; color: string; name: string; at: number; id: number };

const addGlow = StateEffect.define<GlowSpec>();
const clearGlow = StateEffect.define<number>();

const glowField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(addGlow)) {
        const { from, to, color, name, at, id } = effect.value;
        if (to > from) {
          next = next.update({
            add: [
              Decoration.mark({
                attributes: {
                  // No border-radius: adjacent per-keystroke marks must read
                  // as ONE straight underline, not a scalloped row of pills.
                  style: `background-color: ${color}2e; border-bottom: 1.5px solid ${color};`,
                  "data-glow-id": String(id),
                  "data-glow-name": name,
                  "data-glow-at": String(at),
                },
              }).range(from, to),
            ],
          });
        }
      } else if (effect.is(clearGlow)) {
        const cleared = String(effect.value);
        next = next.update({
          filter: (_from, _to, value) => value.spec.attributes?.["data-glow-id"] !== cleared,
        });
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const glowHover = hoverTooltip((view, pos) => {
  let found: { from: number; to: number; name: string; at: number } | null = null;
  view.state.field(glowField).between(pos, pos, (from, to, value) => {
    const name = value.spec.attributes?.["data-glow-name"];
    const at = Number(value.spec.attributes?.["data-glow-at"]);
    if (typeof name === "string" && Number.isFinite(at)) {
      found = { from, to, name, at };
      return false;
    }
  });
  if (found === null) return null;
  const { from, to, name, at } = found;
  return {
    pos: from,
    end: to,
    above: true,
    create: () => {
      const dom = document.createElement("div");
      dom.textContent = `${name} · ${agoText(at)}`;
      return { dom };
    },
  };
});

/**
 * The collaborative markdown editor for one task file: CodeMirror 6 bound to
 * the checkout's Y.Text via yCollab, so remote collaborators' cursors and
 * selection highlights render live (colored by their awareness `user`), and
 * fresh remote insertions glow in their author's color. While mounted, it
 * advertises the open file on awareness `openPath` — the board uses that for
 * its card presence dots.
 */
export function TaskEditor({
  path,
  text,
  awareness,
  focusHeadline,
  onSubmit,
}: {
  path: string;
  text: Y.Text;
  awareness: Awareness;
  /** Place the caret on the first `# heading` after mount: "select" covers
   * the heading text (typing replaces it), "end" parks after it. */
  focusHeadline?: "select" | "end";
  /** ⌘↩ — "I'm done here" (the sheet closes itself). */
  onSubmit?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const undoManager = new Y.UndoManager(text);
    const view = new EditorView({
      state: EditorState.create({
        doc: text.toString(),
        extensions: [
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                onSubmitRef.current?.();
                return true;
              },
            },
            ...yUndoManagerKeymap,
            ...defaultKeymap,
          ]),
          EditorView.lineWrapping,
          editorTheme,
          yCollab(text, awareness, { undoManager }),
          glowField,
          glowHover,
        ],
      }),
      parent: container,
    });

    if (focusHeadline !== undefined) {
      const content = view.state.doc.toString();
      const heading = /^#\s+(.*)$/m.exec(content);
      if (heading !== null) {
        const end = heading.index + heading[0].length;
        const start = end - (heading[1]?.length ?? 0);
        view.dispatch({
          selection: focusHeadline === "select" ? { anchor: start, head: end } : { anchor: end },
          scrollIntoView: true,
        });
      }
      view.focus();
    } else {
      // Opening an existing task: ready to type, caret at the end.
      view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
      view.focus();
    }

    // yCollab's own Y observer registered first (at view creation), so by
    // the time this observer runs the CM doc already reflects the event and
    // the delta's indices are valid CM positions.
    let glowId = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const observer = (event: Y.YTextEvent, transaction: Y.Transaction) => {
      const doc = text.doc;
      if (doc === null) return;
      const author = transactionAuthor(doc, transaction);
      if (author === null) return;

      const effects: Array<StateEffect<GlowSpec>> = [];
      let index = 0;
      for (const op of event.delta) {
        if (typeof op.retain === "number") index += op.retain;
        else if (typeof op.insert === "string") {
          const id = ++glowId;
          effects.push(
            addGlow.of({
              from: index,
              to: index + op.insert.length,
              color: author.color,
              name: author.name,
              at: Date.now(),
              id,
            }),
          );
          const timer = setTimeout(() => {
            timers.delete(timer);
            view.dispatch({ effects: clearGlow.of(id) });
          }, RECENT_TOUCH_TTL_MS);
          timers.add(timer);
          index += op.insert.length;
        }
      }
      // Deferred: for LOCAL typing this observer fires inside CodeMirror's
      // own dispatch cycle, where a nested dispatch would throw.
      if (effects.length > 0) queueMicrotask(() => view.dispatch({ effects }));
    };
    text.observe(observer);

    return () => {
      text.unobserve(observer);
      for (const timer of timers) clearTimeout(timer);
      view.destroy();
      undoManager.destroy();
    };
    // focusHeadline is a mount-time hint only — refocusing on every prop
    // wobble would fight the user's caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, awareness]);

  useEffect(() => {
    awareness.setLocalStateField("openPath", path);
    return () => {
      awareness.setLocalStateField("openPath", null);
    };
  }, [path, awareness]);

  return <div ref={containerRef} style={{ flex: 1, minHeight: "16rem", overflow: "hidden" }} />;
}
