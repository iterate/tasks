import { lazy, Suspense } from "react";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { RotateCcwIcon, Trash2Icon } from "lucide-react";
import type { TaskChangeStatus } from "../state.ts";
import { stateLabel, type BoardTask, type PresenceUser } from "../lib/board-model.ts";
import { TaskStateIcon } from "./board.tsx";

// CodeMirror (plus the Yjs binding) is by far the heaviest thing this app
// ships; it only matters once a task sheet opens, so it loads on demand.
const TaskEditor = lazy(() =>
  import("./task-editor.tsx").then((module) => ({ default: module.TaskEditor })),
);
import { Button } from "../ui/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../ui/alert-dialog.tsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../ui/sheet.tsx";

/**
 * The task detail panel: a right-side sheet in the apps/os dialect, except
 * the body is not a plain textarea — it is the checkout's live CodeMirror
 * editor, so collaborators' cursors and selections render inside it and
 * every keystroke merges through the shared doc.
 */
export function TaskSheet({
  task,
  text,
  awareness,
  columns,
  presence,
  changeStatus,
  onChangeState,
  onRevert,
  onDelete,
  onClose,
}: {
  task: BoardTask | null;
  text: Y.Text | undefined;
  awareness: Awareness;
  columns: string[];
  presence: PresenceUser[];
  changeStatus: TaskChangeStatus | undefined;
  onChangeState: (state: string) => void;
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
        {task === null ? null : (
          <>
            <SheetHeader className="shrink-0 gap-1 border-b pr-12">
              <SheetTitle className="truncate text-base">{task.title}</SheetTitle>
              <SheetDescription className="truncate font-mono text-xs">
                {task.path}
              </SheetDescription>
            </SheetHeader>
            <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-1.5">
              <Select
                items={columns.map((state) => ({ label: stateLabel(state), value: state }))}
                value={columnState(task, columns)}
                onValueChange={(value) => {
                  if (typeof value === "string" && value !== "") onChangeState(value);
                }}
              >
                <SelectTrigger aria-label="Task state" size="sm" className="w-36 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {columns.map((state) => (
                    <SelectItem key={state} value={state}>
                      <span className="flex items-center gap-2">
                        <TaskStateIcon state={state} />
                        {stateLabel(state)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {presence.length > 0 ? (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  {presence.map((user, index) => (
                    <span
                      key={`${user.name}${index}`}
                      className="rounded-full border px-2 py-0.5 text-[11px]"
                      style={{ color: user.color, borderColor: `${user.color}66` }}
                    >
                      {user.name}
                    </span>
                  ))}
                  here
                </span>
              ) : null}
              <div className="ml-auto flex items-center gap-1">
                {changeStatus === undefined ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    title="Revert to the base commit's version"
                    onClick={onRevert}
                  >
                    <RotateCcwIcon aria-hidden className="size-3.5" />
                    Revert
                  </Button>
                )}
                <AlertDialog>
                  <AlertDialogTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        title="Delete task"
                      />
                    }
                  >
                    <Trash2Icon aria-hidden className="size-3.5" />
                    Delete
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete {task.title}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Removes {task.path} from the checkout. It stays restorable from the
                        Deleted strip until someone commits.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={onDelete}>
                        Delete task
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
              {text === undefined ? (
                <p className="p-4 text-sm text-muted-foreground">This task no longer exists.</p>
              ) : (
                <Suspense
                  fallback={<p className="p-4 text-sm text-muted-foreground">opening editor…</p>}
                >
                  <TaskEditor path={task.path} text={text} awareness={awareness} />
                </Suspense>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function columnState(task: BoardTask, columns: string[]): string {
  const literal = task.state.trim();
  if (literal === "" || literal === "backlog") return "todo";
  return columns.includes(literal) ? literal : "todo";
}
