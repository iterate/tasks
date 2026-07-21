import { useEffect, useRef, useState } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { unifiedMergeView } from "@codemirror/merge";
import { CollabConnection, peerExtension } from "./collab-client.ts";
import { redlineExtension } from "./collab-redline.ts";

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
  onLiveContent?: (path: string, content: string) => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState("connecting…");
  const [recovery, setRecovery] = useState<string | null>(null);
  const redlineRef = useRef(input.redline);
  redlineRef.current = input.redline;
  const toggleRef = useRef<((on: boolean) => void) | null>(null);
  const { checkoutId, repoPath, path, extensions, onLiveContent } = input;

  useEffect(() => {
    const connection = new CollabConnection(checkoutId, repoPath, `/${path}`);
    connection.onStatus = setStatus;
    const redlineLayer = new Compartment();
    let view: EditorView | null = null;
    let cancelled = false;

    const redlineExtensions = async (): Promise<Extension> => {
      // ONE baseline for both layers — changes() carries the content the
      // attribution folded from, so merge chunks and author marks agree.
      const changes = await connection.changes();
      return [unifiedMergeView({ original: changes.baseContent }), redlineExtension(connection)];
    };

    const liveReflector =
      onLiveContent === undefined
        ? []
        : EditorView.updateListener.of((update) => {
            if (update.docChanged) onLiveContent(path, update.state.doc.toString());
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

    void connection
      .open()
      .then(async (opened) => {
        if (cancelled || host.current === null) return;
        const layers = redlineRef.current ? await redlineExtensions() : [];
        if (cancelled || host.current === null) return;
        view = new EditorView({
          parent: host.current,
          state: buildState(opened.content, opened.version, layers),
        });
        setStatus(`live · v${opened.version}`);
      })
      .catch((cause: unknown) =>
        setStatus(`failed: ${cause instanceof Error ? cause.message : String(cause)}`),
      );
    return () => {
      cancelled = true;
      toggleRef.current = null;
      view?.destroy();
    };
  }, [checkoutId, repoPath, path, extensions, onLiveContent]);

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
