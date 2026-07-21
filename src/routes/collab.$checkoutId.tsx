import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { unifiedMergeView } from "@codemirror/merge";
import { CollabConnection, commonSplice, peerExtension } from "../lib/collab-client.ts";
import { redlineExtension } from "../lib/collab-redline.ts";
import { DEFAULT_REPO_PATH, normalizeRepoPath } from "../lib/checkout-shared.ts";

/**
 * PoC page for the no-Yjs collab lane: one file, one CodeMirror editor,
 * @codemirror/collab against the platform workspace through the vessel.
 * The redline toggle composes two independent layers over the live doc:
 * @codemirror/merge's unified view vs the mount base (struck-out deletions,
 * highlighted insertions, per-chunk accept/reject) and the attribution layer
 * (author-colored marks from the server's op-log fold).
 *   /collab/<checkoutId>?path=/tasks/foo.md&repo=/repos/config
 */
export const Route = createFileRoute("/collab/$checkoutId")({
  validateSearch: (search: Record<string, unknown>) => ({
    path: typeof search.path === "string" ? search.path : "/tasks/design-review.md",
    repo: typeof search.repo === "string" ? search.repo : DEFAULT_REPO_PATH,
  }),
  component: CollabPage,
});

function CollabPage() {
  const { checkoutId } = Route.useParams();
  const { path, repo } = Route.useSearch();
  const host = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState("connecting…");
  const [redline, setRedline] = useState(true);
  const toggleRef = useRef<((on: boolean) => void) | null>(null);

  useEffect(() => {
    const repoPath = normalizeRepoPath(repo) ?? DEFAULT_REPO_PATH;
    const connection = new CollabConnection(checkoutId, repoPath, path);
    connection.onStatus = setStatus;
    const redlineLayer = new Compartment();
    let view: EditorView | null = null;
    let cancelled = false;

    const redlineExtensions = async (): Promise<Extension> => [
      // Content layer: diff vs the mount base (re-fetched per toggle so a
      // commit mid-session refreshes the baseline).
      unifiedMergeView({ original: (await connection.readBase()) ?? "" }),
      // Attribution layer: who, from the op-log fold.
      redlineExtension(connection),
    ];

    const buildState = (content: string, version: number, redlines: Extension) =>
      EditorState.create({
        doc: content,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          peerExtension(connection, version),
          redlineLayer.of(redlines),
        ],
      });

    toggleRef.current = (on: boolean) => {
      if (view === null) return;
      void (async () => {
        const extensions = on ? await redlineExtensions() : [];
        view?.dispatch({ effects: redlineLayer.reconfigure(extensions) });
      })();
    };

    // Snapshot re-sync (past the history floor, or the session's epoch
    // rotated): rebuild at the snapshot, then re-enter carried local edits as
    // one fresh unconfirmed change so they push like ordinary typing.
    connection.onReseed = (snapshot, carried) => {
      if (cancelled || view === null) return;
      connection.reseed(snapshot);
      view.setState(buildState(snapshot.content, snapshot.version, []));
      // Carried local edits re-enter as ONE fresh unconfirmed change, pushed
      // like ordinary typing.
      const splice = commonSplice(snapshot.content, carried);
      if (splice !== null) view.dispatch({ changes: splice });
      setStatus(`re-synced · v${snapshot.version}`);
    };

    void connection
      .open()
      .then(async (opened) => {
        if (cancelled || host.current === null) return;
        view = new EditorView({
          parent: host.current,
          state: buildState(opened.content, opened.version, await redlineExtensions()),
        });
        setStatus(`live · v${opened.version} · ${connection.clientId}`);
      })
      .catch((error: unknown) => {
        setStatus(`failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    return () => {
      cancelled = true;
      toggleRef.current = null;
      view?.destroy();
    };
  }, [checkoutId, path, repo]);

  return (
    <div className="flex h-dvh flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-2 font-mono text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">collab poc</span>
        <span>{checkoutId}</span>
        <span>{path}</span>
        <span data-testid="collab-status">{status}</span>
        <button
          type="button"
          className={`ml-auto rounded border px-2 py-0.5 ${redline ? "bg-foreground text-background" : ""}`}
          onClick={() => {
            const next = !redline;
            setRedline(next);
            toggleRef.current?.(next);
          }}
        >
          redline
        </button>
      </div>
      <div ref={host} className="min-h-0 flex-1 overflow-auto [&_.cm-editor]:h-full" />
    </div>
  );
}
