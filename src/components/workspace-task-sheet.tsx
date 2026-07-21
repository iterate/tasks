import { lazy, Suspense, useState } from "react";
import { XIcon } from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "../ui/sheet.tsx";
import { Button } from "../ui/button.tsx";
import { Badge } from "../ui/badge.tsx";
import { cn } from "../ui/utils.ts";
import type { TaskChangeStatus } from "../state.ts";
import { stateLabel, type BoardTask } from "../lib/board-model.ts";
import { TagPicker } from "./tag-picker.tsx";

// The editor stack (CM6 + collab + merge) loads only when a sheet opens.
const WorkspaceTaskEditor = lazy(() =>
  import("./workspace-task-editor.tsx").then((module) => ({
    default: module.WorkspaceTaskEditor,
  })),
);

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
  allTags,
  changeStatus,
  onLiveContent,
  onChangeState,
  onChangeLabels,
  onRevert,
  onDelete,
  onClose,
}: {
  task: BoardTask | null;
  checkoutId: string;
  repoPath: string;
  columns: string[];
  allTags: string[];
  changeStatus: TaskChangeStatus | undefined;
  onLiveContent: (path: string, content: string) => void;
  onChangeState: (state: string) => void;
  onChangeLabels: (labels: string[]) => void;
  onRevert: () => void;
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
            allTags={allTags}
            changeStatus={changeStatus}
            onLiveContent={onLiveContent}
            onChangeState={onChangeState}
            onChangeLabels={onChangeLabels}
            onRevert={onRevert}
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
  allTags,
  changeStatus,
  onLiveContent,
  onChangeState,
  onChangeLabels,
  onRevert,
  onDelete,
  onClose,
}: {
  task: BoardTask;
  checkoutId: string;
  repoPath: string;
  columns: string[];
  allTags: string[];
  changeStatus: TaskChangeStatus | undefined;
  onLiveContent: (path: string, content: string) => void;
  onChangeState: (state: string) => void;
  onChangeLabels: (labels: string[]) => void;
  onRevert: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [redline, setRedline] = useState(false);
  const [status, setStatus] = useState("connecting…");

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
          onClick={() => setRedline((current) => !current)}
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
      <div className="flex items-center gap-2 border-b px-4 py-1 text-[11px] text-muted-foreground">
        <span className="truncate font-mono">{task.path}</span>
        <TagPicker value={task.labels} options={allTags} onChange={onChangeLabels} />
        {changeStatus !== undefined && (
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={onRevert}>
            Revert
          </Button>
        )}
        <span className="ml-auto font-mono">{status}</span>
      </div>
      <Suspense
        fallback={<p className="p-4 text-sm text-muted-foreground">Loading editor…</p>}
      >
        <WorkspaceTaskEditor
          checkoutId={checkoutId}
          repoPath={repoPath}
          path={task.path}
          redline={redline}
          onLiveContent={onLiveContent}
          onStatus={setStatus}
        />
      </Suspense>
    </div>
  );
}
