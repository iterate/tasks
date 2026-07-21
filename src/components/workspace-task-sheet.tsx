import { useEffect, useRef, useState } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { unifiedMergeView } from "@codemirror/merge";
import { XIcon } from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "../ui/sheet.tsx";
import { Button } from "../ui/button.tsx";
import { Badge } from "../ui/badge.tsx";
import { cn } from "../ui/utils.ts";
import type { TaskChangeStatus } from "../state.ts";
import { stateLabel, type BoardTask } from "../lib/board-model.ts";
import { CollabConnection, commonSplice, peerExtension } from "../lib/collab-client.ts";
import { redlineExtension } from "../lib/collab-redline.ts";

/**
 * The task detail sheet on the WORKSPACE lane: a live collaborative editor
 * (rebase model over the vessel WS) with the redline layers — merge view vs
 * the mount base plus author attribution — where the Yjs sheet had y-collab.
 */
export function WorkspaceTaskSheet({
  task,
  checkoutId,
  repoPath,
  columns,
  changeStatus,
  onLiveContent,
  onChangeState,
  onDelete,
  onClose,
}: {
  task: BoardTask | null;
  checkoutId: string;
  repoPath: string;
  columns: string[];
  changeStatus: TaskChangeStatus | undefined;
  onLiveContent: (path: string, content: string) => void;
  onChangeState: (state: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={task !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 data-[side=right]:sm:w-[62vw] data-[side=right]:sm:max-w-[62vw]"
      >
        {task !== null && (
          <SheetBody
            key={task.path}
            task={task}
            checkoutId={checkoutId}
            repoPath={repoPath}
            columns={columns}
            changeStatus={changeStatus}
            onLiveContent={onLiveContent}
            onChangeState={onChangeState}
            onDelete={onDelete}
            onClose={onClose}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function SheetBody({
  task,
  checkoutId,
  repoPath,
  columns,
  changeStatus,
  onLiveContent,
  onChangeState,
  onDelete,
  onClose,
}: {
  task: BoardTask;
  checkoutId: string;
  repoPath: string;
  columns: string[];
  changeStatus: TaskChangeStatus | undefined;
  onLiveContent: (path: string, content: string) => void;
  onChangeState: (state: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState("connecting…");
  const [redline, setRedline] = useState(false);
  const redlineRef = useRef(redline);
  redlineRef.current = redline;
  const toggleRef = useRef<((on: boolean) => void) | null>(null);

  useEffect(() => {
    const connection = new CollabConnection(checkoutId, repoPath, `/${task.path}`);
    connection.onStatus = setStatus;
    const redlineLayer = new Compartment();
    let view: EditorView | null = null;
    let cancelled = false;

    const redlineExtensions = async (): Promise<Extension> => [
      unifiedMergeView({ original: (await connection.readBase()) ?? "" }),
      redlineExtension(connection),
    ];

    const liveReflector = EditorView.updateListener.of((update) => {
      if (update.docChanged) onLiveContent(task.path, update.state.doc.toString());
    });

    const buildState = (content: string, version: number, redlines: Extension) =>
      EditorState.create({
        doc: content,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          placeholder("Write the task as markdown…"),
          peerExtension(connection, version),
          liveReflector,
          redlineLayer.of(redlines),
          EditorView.theme({
            "&": { fontSize: "14px", height: "100%" },
            ".cm-content": { fontFamily: "var(--font-mono, ui-monospace)", padding: "16px" },
          }),
        ],
      });

    toggleRef.current = (on: boolean) => {
      void (async () => {
        const extensions = on ? await redlineExtensions() : [];
        view?.dispatch({ effects: redlineLayer.reconfigure(extensions) });
      })();
    };

    connection.onReseed = (snapshot, carried) => {
      if (cancelled || view === null) return;
      connection.reseed(snapshot);
      view.setState(buildState(snapshot.content, snapshot.version, []));
      const splice = commonSplice(snapshot.content, carried);
      if (splice !== null) view.dispatch({ changes: splice });
      toggleRef.current?.(redlineRef.current);
    };

    void connection
      .open()
      .then((opened) => {
        if (cancelled || host.current === null) return;
        view = new EditorView({
          parent: host.current,
          state: buildState(opened.content, opened.version, []),
        });
        setStatus("live");
      })
      .catch((cause: unknown) =>
        setStatus(`failed: ${cause instanceof Error ? cause.message : String(cause)}`),
      );
    return () => {
      cancelled = true;
      toggleRef.current = null;
      view?.destroy();
    };
  }, [checkoutId, repoPath, task.path, onLiveContent]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <SheetTitle className="min-w-0 flex-1 truncate text-base">{task.title}</SheetTitle>
        {changeStatus !== undefined && (
          <Badge
            variant="outline"
            className={cn(
              "capitalize",
              changeStatus === "added" && "border-emerald-300 text-emerald-700",
              changeStatus === "modified" && "border-amber-300 text-amber-700",
            )}
          >
            {changeStatus}
          </Badge>
        )}
        <select
          className="h-8 rounded-md border bg-transparent px-2 text-sm"
          value={columns.includes(task.state) ? task.state : columns[0]}
          onChange={(event) => onChangeState(event.target.value)}
        >
          {columns.map((column) => (
            <option key={column} value={column}>
              {stateLabel(column)}
            </option>
          ))}
        </select>
        <Button
          variant={redline ? "default" : "outline"}
          size="sm"
          onClick={() => {
            const next = !redline;
            setRedline(next);
            toggleRef.current?.(next);
          }}
        >
          Changes
        </Button>
        <Button variant="ghost" size="sm" onClick={onDelete}>
          Delete
        </Button>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <XIcon className="size-4" />
        </Button>
      </div>
      <div className="flex items-center gap-2 border-b px-4 py-1 font-mono text-[11px] text-muted-foreground">
        <span className="truncate">{task.path}</span>
        <span className="ml-auto">{status}</span>
      </div>
      <div ref={host} className="min-h-0 flex-1 overflow-auto" />
    </div>
  );
}
