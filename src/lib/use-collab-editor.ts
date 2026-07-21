import { useCallback, useEffect, useRef, useState } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CollabConnection, peerExtension, setCollabDisplayName } from "./collab-client.ts";
import { whoami } from "./use-checkout.ts";

let identityLoaded = false;
async function ensureCollabIdentity(): Promise<void> {
  if (identityLoaded) return;
  identityLoaded = true;
  try {
    const me = await whoami();
    const name = me.name ?? me.email ?? me.userId;
    if (name) setCollabDisplayName(name);
  } catch {
    // Anonymous is fine — tooltips fall back to "someone".
  }
}
import { redlineExtension } from "./collab-redline.ts";
import type { CollabEditorApi } from "./collab-editor-api.ts";

/**
 * The ONE collaborative-editor state machine, shared by every surface that
 * hosts a live doc (the /collab page, the task sheet). Owns: connection
 * lifecycle, editor construction, the redline compartment (both layers share
 * `changes()`'s single baseline), and snapshot re-sync.
 *
 * Snapshot recovery is HONEST: the acked prefix of local unconfirmed ops is
 * dropped exactly (the server tells us `ackedSeq`); if genuinely unacked
 * local edits remain, they are surfaced via `recovery` for the user to
 * review — never silently merged into other people's text.
 */
export function useCollabEditor(input: {
  checkoutId: string;
  repoPath: string;
  /** Repo-relative file path (no leading slash). */
  path: string;
  /** Extra extensions for the surface (keymaps, theme, listeners). */
  extensions: Extension;
  /** Redline layers on at build time (kept in sync with toggle()). */
  redline: boolean;
  /** Place the caret on mount: select the `# headline` text (so typing
   * replaces it — the new-task flow) or park at its end. */
  focusHeadline?: "select" | "end";
  onLiveContent?: (path: string, content: string) => void;
  onStatus?: (status: string) => void;
  /** Filled with the live-doc API while the editor is mounted (see
   * CollabEditorApi — the board mutates open files through this). */
  apiRef?: { current: CollabEditorApi | null };
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const [status, setStatusState] = useState("connecting…");
  const [recovery, setRecovery] = useState<string | null>(null);
  const redlineRef = useRef(input.redline);
  const toggleRef = useRef<((on: boolean) => void) | null>(null);
  const { checkoutId, repoPath, path, extensions, onLiveContent, onStatus, focusHeadline, apiRef } = input;
  // Ref writes never happen during render — React may replay render work.
  useEffect(() => {
    redlineRef.current = input.redline;
    toggleRef.current?.(input.redline);
  }, [input.redline]);
  const setStatus = useCallback(
    (next: string) => {
      setStatusState(next);
      onStatus?.(next);
    },
    [onStatus],
  );

  useEffect(() => {
    const connection = new CollabConnection(checkoutId, repoPath, `/${path}`);
    connection.onStatus = setStatus;
    const redlineLayer = new Compartment();
    let view: EditorView | null = null;
    let cancelled = false;

    // Redlines are the attribution layer only: added-text highlights,
    // deletion markers, who/when tooltips. No merge chunks, no accept/reject.
    const redlineExtensions = async (): Promise<Extension> => redlineExtension(connection);

    let reflectTimer: ReturnType<typeof setTimeout> | null = null;
    const liveReflector =
      onLiveContent === undefined
        ? []
        : EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            // Debounced: reflecting every keystroke reparses the whole board.
            if (reflectTimer) clearTimeout(reflectTimer);
            reflectTimer = setTimeout(
              () => onLiveContent(path, update.state.doc.toString()),
              200,
            );
          });

    const buildState = (content: string, version: number, redlines: Extension) =>
      EditorState.create({
        doc: content,
        extensions: [
          extensions,
          liveReflector,
          peerExtension(connection, version),
          redlineLayer.of(redlines),
        ],
      });

    toggleRef.current = (on: boolean) => {
      void (async () => {
        const layers = on ? await redlineExtensions() : [];
        if (!cancelled) view?.dispatch({ effects: redlineLayer.reconfigure(layers) });
      })();
    };

    connection.onReseed = (snapshot, unsynced) => {
      if (cancelled || view === null) return;
      connection.reseed(snapshot);
      view.setState(buildState(snapshot.content, snapshot.version, []));
      toggleRef.current?.(redlineRef.current);
      // Unacked local edits cannot be positionally rebased without the
      // server history that is gone — surface them, never guess a merge.
      setRecovery(unsynced);
      setStatus(`re-synced · v${snapshot.version}`);
    };

    void ensureCollabIdentity()
      .then(() => connection.open())
      .then(async (opened) => {
        if (cancelled || host.current === null) return;
        const layers = redlineRef.current ? await redlineExtensions() : [];
        if (cancelled || host.current === null) return;
        view = new EditorView({
          parent: host.current,
          state: buildState(opened.content, opened.version, layers),
        });
        if (apiRef !== undefined) {
          const live = view;
          apiRef.current = {
            applyTransform: (transform) => {
              const current = live.state.doc.toString();
              const next = transform(current);
              if (next === current) return;
              // Minimal splice: only the changed region moves, so concurrent
              // edits elsewhere survive and attribution stays honest.
              let start = 0;
              const maxStart = Math.min(current.length, next.length);
              while (start < maxStart && current[start] === next[start]) start++;
              let endCurrent = current.length;
              let endNext = next.length;
              while (
                endCurrent > start &&
                endNext > start &&
                current[endCurrent - 1] === next[endNext - 1]
              ) {
                endCurrent--;
                endNext--;
              }
              live.dispatch({
                changes: { from: start, insert: next.slice(start, endNext), to: endCurrent },
              });
            },
            path,
            source: () => live.state.doc.toString(),
          };
        }
        if (focusHeadline !== undefined) {
          const heading = /^#\s+(.*)$/m.exec(opened.content);
          if (heading !== null) {
            const end = heading.index + heading[0].length;
            const start = end - (heading[1]?.length ?? 0);
            view.dispatch({
              scrollIntoView: true,
              selection:
                focusHeadline === "select" ? { anchor: start, head: end } : { anchor: end },
            });
          }
          view.focus();
        }
        setStatus(`live · v${opened.version}`);
      })
      .catch((cause: unknown) =>
        setStatus(`failed: ${cause instanceof Error ? cause.message : String(cause)}`),
      );
    return () => {
      cancelled = true;
      if (reflectTimer) clearTimeout(reflectTimer);
      toggleRef.current = null;
      if (apiRef !== undefined) apiRef.current = null;
      view?.destroy();
    };
  }, [checkoutId, repoPath, path, extensions, onLiveContent, setStatus, focusHeadline, apiRef]);

  return {
    dismissRecovery: () => setRecovery(null),
    host,
    /** Unacked local text lost from the doc by a snapshot re-sync, for the
     * user to review/copy — null when recovery is clean. */
    recovery,
    status,
    toggle: (on: boolean) => toggleRef.current?.(on),
  };
}
