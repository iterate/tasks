import { EditorView, Decoration, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { getSyncedVersion } from "@codemirror/collab";
import type { CollabConnection } from "./collab-client.ts";
import type { CollabChangeSegment } from "./tasks-api.ts";

/**
 * The ATTRIBUTION layer of the redline view: author-colored marks over
 * inserted text and ⌫ flags where base text vanished, fed by the server's
 * `changes()` fold of the op log. Content-level struck-out deletions are
 * @codemirror/merge's job (composed alongside in the page); this layer only
 * answers "who".
 */

/** Stable, legible per-author hue (agents get the platform violet). */
export function authorColor(clientId: string, alpha = 0.35): string {
  if (clientId === "external") return `hsla(262, 83%, 58%, ${alpha})`;
  let hash = 0;
  for (const char of clientId) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `hsla(${((hash % 360) + 360) % 360}, 70%, 45%, ${alpha})`;
}

class DeletionFlag extends WidgetType {
  constructor(
    readonly clientId: string,
    readonly text: string,
  ) {
    super();
  }
  override eq(other: DeletionFlag) {
    return other.clientId === this.clientId && other.text === this.text;
  }
  toDOM() {
    const flag = document.createElement("span");
    flag.className = "cm-redline-del";
    flag.style.color = authorColor(this.clientId, 1);
    flag.textContent = "⌫";
    flag.title = `deleted by ${this.clientId}: "${this.text.slice(0, 120)}"`;
    return flag;
  }
}

export function decorate(segments: CollabChangeSegment[], docLength: number): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  // RangeSetBuilder demands ascending positions; the server sorts, but
  // clamping (and any future source) must not be able to crash the layer —
  // sort defensively, deletions before insertions at a tie.
  const ordered = [...segments].sort((left, right) => {
    const position = (segment: CollabChangeSegment) =>
      segment.kind === "inserted" ? Math.min(segment.from, docLength) : Math.min(segment.at, docLength);
    return (
      position(left) - position(right) ||
      (left.kind === "deleted" ? -1 : 0) - (right.kind === "deleted" ? -1 : 0)
    );
  });
  for (const segment of ordered) {
    if (segment.kind === "deleted") {
      const at = Math.min(segment.at, docLength);
      builder.add(at, at, Decoration.widget({ side: -1, widget: new DeletionFlag(segment.clientId, segment.text) }));
    } else {
      const from = Math.min(segment.from, docLength);
      const to = Math.min(segment.to, docLength);
      if (from >= to) continue;
      builder.add(
        from,
        to,
        Decoration.mark({
          attributes: {
            style: `background: ${authorColor(segment.clientId, 0.18)}; border-bottom: 2px solid ${authorColor(segment.clientId, 0.9)}`,
            title: `inserted by ${segment.clientId}`,
          },
          class: "cm-redline-ins",
        }),
      );
    }
  }
  return builder.finish();
}

const REFRESH_DEBOUNCE_MS = 500;

/** Fetch-and-decorate: refreshes after edits settle, maps between fetches. */
export function redlineExtension(connection: CollabConnection) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      timer: ReturnType<typeof setTimeout> | null = null;
      done = false;

      constructor(readonly view: EditorView) {
        void this.refresh();
      }

      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        // Keep marks visually anchored while the authoritative fold catches up.
        this.decorations = this.decorations.map(update.changes);
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.refresh(), REFRESH_DEBOUNCE_MS);
      }

      generation = 0;

      async refresh() {
        if (this.done) return;
        const mine = ++this.generation;
        try {
          const changes = await connection.changes();
          if (this.done || this.generation !== mine) return; // out-of-order
          // Segments are in CONFIRMED-head coordinates: install only when the
          // editor is synced to that head; otherwise keep the current mapped
          // decorations and try again once the versions agree.
          if (changes.headVersion !== getSyncedVersion(this.view.state)) {
            this.timer = setTimeout(() => void this.refresh(), REFRESH_DEBOUNCE_MS);
            return;
          }
          const segments: CollabChangeSegment[] = [
            ...changes.inserted.map((span) => ({ ...span, kind: "inserted" as const })),
            ...changes.deleted.map((span) => ({ ...span, kind: "deleted" as const })),
          ];
          this.decorations = decorate(segments, this.view.state.doc.length);
          // Nudge a measure/paint without touching the doc.
          this.view.dispatch({});
        } catch {
          // Attribution is decorative — a failed refresh just tries again on
          // the next edit; the merge view still shows the content diff.
        }
      }

      destroy() {
        this.done = true;
        if (this.timer) clearTimeout(this.timer);
      }
    },
    { decorations: (value) => value.decorations },
  );
  return [plugin, theme];
}

const theme = EditorView.baseTheme({
  ".cm-redline-del": { cursor: "help", fontWeight: "bold", padding: "0 1px" },
  ".cm-redline-ins": { borderRadius: "2px" },
});
