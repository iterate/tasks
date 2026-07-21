import { useMemo, useState } from "react";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { XIcon } from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "../ui/sheet.tsx";
import { Button } from "../ui/button.tsx";
import { Badge } from "../ui/badge.tsx";
import { cn } from "../ui/utils.ts";
import type { TaskChangeStatus } from "../state.ts";
import { stateLabel, type BoardTask } from "../lib/board-model.ts";
import { useCollabEditor } from "../lib/use-collab-editor.ts";

/**
 * The task detail sheet on the WORKSPACE lane: the shared collab-editor
 * state machine (rebase model over the vessel WS) with the redline layers
 * where the Yjs sheet had y-collab.
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
  const [redline, setRedline] = useState(false);
  const extensions = useMemo(
    () => [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      placeholder("Write the task as markdown…"),
      EditorView.theme({
        "&": { fontSize: "14px", height: "100%" },
        ".cm-content": { fontFamily: "var(--font-mono, ui-monospace)", padding: "16px" },
      }),
    ],
    [],
  );
  const editor = useCollabEditor({
    checkoutId,
    extensions,
    onLiveContent,
    path: task.path,
    redline,
    repoPath,
  });

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
            editor.toggle(next);
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
        <span className="ml-auto">{editor.status}</span>
      </div>
      {editor.recovery !== null && (
        <div className="border-b bg-amber-500/10 px-4 py-2 text-xs text-amber-900">
          <div className="flex items-center gap-2">
            <span>Unaccepted text from before the re-sync (not in the document):</span>
            <button type="button" className="ml-auto underline" onClick={editor.dismissRecovery}>
              dismiss
            </button>
          </div>
          <pre className="mt-1 rounded bg-white/60 p-2 whitespace-pre-wrap">{editor.recovery}</pre>
        </div>
      )}
      <div ref={editor.host} className="min-h-0 flex-1 overflow-auto" />
    </div>
  );
}
