import { DragDropProvider, useDraggable, useDroppable } from "@dnd-kit/react";
import { useMemo } from "react";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleEllipsisIcon,
  FolderIcon,
  PlusIcon,
} from "lucide-react";
import { cn } from "../ui/utils.ts";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import type { TaskChangeStatus } from "../state.ts";
import { columnsForTasks, taskColumnState } from "../tasks-model.ts";
import { stateLabel, type BoardTask, type PresenceUser } from "../lib/board-model.ts";
import { agoText, type RecentTouch } from "../lib/recency.ts";

/**
 * The board proper, in the apps/os repo-ide dialect: rows are folder
 * swimlanes (or one row when grouping is off), columns are task states, and
 * every cell is a drop target. Cards wear change tint (emerald added, amber
 * modified) and the presence dots of collaborators editing them.
 */
export function Board({
  tasks,
  rowField,
  taskChangeByPath,
  presenceByPath,
  recentByPath,
  onMove,
  onAdd,
  onOpen,
}: {
  tasks: BoardTask[];
  rowField: "folder" | null;
  taskChangeByPath: Map<string, TaskChangeStatus>;
  presenceByPath: Map<string, PresenceUser[]>;
  recentByPath: Map<string, RecentTouch>;
  onMove: (task: BoardTask, state: string, folder: string) => void;
  onAdd: (state: string, folder: string | null) => void;
  onOpen: (path: string) => void;
}) {
  const columns = useMemo(() => columnsForTasks(tasks).map((column) => column.state), [tasks]);
  const rows = useMemo(() => rowGroups(tasks, rowField), [tasks, rowField]);
  const byPath = useMemo(() => new Map(tasks.map((task) => [task.path, task])), [tasks]);

  return (
    <DragDropProvider
      onDragEnd={(event) => {
        if (event.canceled) return;
        const source = parseCardId(String(event.operation.source?.id ?? ""));
        const target = parseCellId(String(event.operation.target?.id ?? ""));
        if (!source || !target) return;
        const task = byPath.get(source.path);
        const row = rows.find((candidate) => candidate.key === target.rowKey);
        if (!task || !row) return;
        const folder = rowField === "folder" ? (row.value ?? task.folder) : task.folder;
        if (taskColumnState(task.state) !== target.state || task.folder !== folder) {
          onMove(task, target.state, folder);
        }
      }}
    >
      <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-muted/30 p-2">
        <div className="flex min-h-full w-max min-w-full flex-col gap-4">
          {rows.map((row, rowIndex) => (
            <section
              key={row.key}
              className={cn("flex min-w-full flex-col", rows.length === 1 && "min-h-full flex-1")}
            >
              {rowField === null || rows.length === 1 ? null : (
                <header className="sticky left-0 flex h-9 w-fit max-w-[calc(100vw-4rem)] items-center gap-2 px-2 text-sm font-medium">
                  <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-mono text-xs">{row.label}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {row.tasks.length}
                  </span>
                </header>
              )}
              <div className="flex min-h-0 min-w-full flex-1 gap-2">
                {columns.map((state) => (
                  <BoardCell
                    key={state}
                    state={state}
                    rowKey={row.key}
                    rowValue={row.value}
                    showHeader={rowIndex === 0}
                    tasks={row.tasks.filter((task) => taskColumnState(task.state) === state)}
                    taskChangeByPath={taskChangeByPath}
                    presenceByPath={presenceByPath}
                    recentByPath={recentByPath}
                    onAdd={onAdd}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </DragDropProvider>
  );
}

function BoardCell({
  state,
  rowKey,
  rowValue,
  showHeader,
  tasks,
  taskChangeByPath,
  presenceByPath,
  recentByPath,
  onAdd,
  onOpen,
}: {
  state: string;
  rowKey: string;
  rowValue: string | null;
  showHeader: boolean;
  tasks: BoardTask[];
  taskChangeByPath: Map<string, TaskChangeStatus>;
  presenceByPath: Map<string, PresenceUser[]>;
  recentByPath: Map<string, RecentTouch>;
  onAdd: (state: string, folder: string | null) => void;
  onOpen: (path: string) => void;
}) {
  const { ref, isDropTarget } = useDroppable({
    id: `cell:${encodeURIComponent(rowKey)}:${encodeURIComponent(state)}`,
    accept: "task",
  });
  return (
    <section
      ref={ref}
      className={cn(
        "flex min-h-36 w-72 flex-none flex-col pb-4 transition-colors",
        isDropTarget && "rounded-lg bg-accent/40",
      )}
    >
      {showHeader ? (
        <header className="flex h-10 shrink-0 items-center gap-2 px-3">
          <TaskStateIcon state={state} />
          <h2 className="truncate text-sm font-medium">{stateLabel(state)}</h2>
          <span className="text-xs tabular-nums text-muted-foreground">{tasks.length}</span>
        </header>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col px-1 pb-1">
        <div className="flex flex-col gap-2">
          {tasks.map((task) => (
            <BoardCard
              key={task.path}
              task={task}
              rowKey={rowKey}
              changeStatus={taskChangeByPath.get(task.path)}
              presence={presenceByPath.get(task.path) ?? []}
              touch={recentByPath.get(task.path)}
              onOpen={onOpen}
            />
          ))}
        </div>
        <Button
          variant="outline"
          className="mt-2 h-10 w-full border-dashed text-muted-foreground"
          onClick={() => onAdd(state, rowValue)}
        >
          <PlusIcon aria-hidden className="size-3.5" />
          New task
        </Button>
      </div>
    </section>
  );
}

function BoardCard({
  task,
  rowKey,
  changeStatus,
  presence,
  touch,
  onOpen,
}: {
  task: BoardTask;
  rowKey: string;
  changeStatus: TaskChangeStatus | undefined;
  presence: PresenceUser[];
  touch: RecentTouch | undefined;
  onOpen: (path: string) => void;
}) {
  const { ref, isDragging } = useDraggable({
    id: `card:${encodeURIComponent(task.path)}:${encodeURIComponent(rowKey)}`,
    type: "task",
  });
  const changeLabel =
    changeStatus === "added" ? "new" : changeStatus === "modified" ? "edited" : undefined;
  return (
    <button
      type="button"
      ref={ref}
      onClick={() => onOpen(task.path)}
      title={touch ? `${touch.author.name} ${touch.action} this · ${agoText(touch.at)}` : undefined}
      style={
        touch
          ? {
              boxShadow: `0 0 0 1.5px ${touch.author.color}, 0 0 12px 1px ${touch.author.color}55`,
            }
          : undefined
      }
      className={cn(
        "relative w-full cursor-grab rounded-lg border bg-card p-3 text-left shadow-xs transition-[background-color,border-color,box-shadow,opacity] hover:border-foreground/15 hover:bg-accent/30 hover:shadow-sm active:cursor-grabbing",
        changeStatus === "added" &&
          "border-emerald-500/70 bg-emerald-500/5 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.12)] hover:border-emerald-500",
        changeStatus === "modified" &&
          "border-amber-500/70 bg-amber-500/5 shadow-[inset_0_0_0_1px_rgba(245,158,11,0.12)] hover:border-amber-500",
        isDragging && "opacity-40 shadow-none",
      )}
    >
      {changeLabel === undefined ? null : (
        <span
          className={cn(
            "absolute top-2 right-2 rounded-md px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase",
            changeStatus === "added" && "bg-emerald-500/15 text-emerald-700",
            changeStatus === "modified" && "bg-amber-500/15 text-amber-800",
          )}
        >
          {changeLabel}
        </span>
      )}
      {presence.length > 0 ? (
        <span className="absolute right-2 bottom-2 flex -space-x-1">
          {presence.slice(0, 4).map((user, index) => (
            <span
              key={`${user.name}${index}`}
              title={`${user.name} is here`}
              className="size-2.5 rounded-full ring-2 ring-card"
              style={{ backgroundColor: user.color }}
            />
          ))}
        </span>
      ) : null}
      <div className={cn("flex items-start gap-2", changeLabel !== undefined && "pr-12")}>
        <TaskStateIcon state={taskColumnState(task.state)} className="mt-0.5" />
        <span className="min-w-0 flex-1 text-sm leading-snug font-medium">{task.title}</span>
      </div>
      {task.summary === "" ? null : (
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {task.summary}
        </p>
      )}
      {task.labels.length > 0 ? (
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5">
          {task.labels.map((label) => (
            <Badge key={label} variant="secondary">
              {label}
            </Badge>
          ))}
        </div>
      ) : null}
    </button>
  );
}

export function TaskStateIcon({ state, className }: { state: string; className?: string }) {
  const shared = cn("size-3.5 shrink-0", className);
  switch (state) {
    case "in-progress":
      return <CircleDotIcon aria-hidden className={cn(shared, "text-amber-500")} />;
    case "in-review":
      return <CircleEllipsisIcon aria-hidden className={cn(shared, "text-sky-500")} />;
    case "done":
      return <CircleCheckIcon aria-hidden className={cn(shared, "text-emerald-600")} />;
    default:
      return <CircleDashedIcon aria-hidden className={cn(shared, "text-muted-foreground")} />;
  }
}

function rowGroups(
  tasks: BoardTask[],
  rowField: "folder" | null,
): Array<{ key: string; label: string | null; value: string | null; tasks: BoardTask[] }> {
  if (rowField === null) return [{ key: "all", label: null, value: null, tasks }];
  const groups = new Map<string, BoardTask[]>();
  for (const task of tasks) {
    const group = groups.get(task.folder) ?? [];
    group.push(task);
    groups.set(task.folder, group);
  }
  if (groups.size === 0) groups.set("/", []);
  return [...groups]
    .sort(([left], [right]) => {
      if (left === "/") return -1;
      if (right === "/") return 1;
      return left.localeCompare(right);
    })
    .map(([folder, grouped]) => ({
      key: `folder:${folder}`,
      label: folder,
      value: folder,
      tasks: grouped,
    }));
}

function parseCardId(id: string): { path: string } | null {
  const match = /^card:([^:]+):/.exec(id);
  return match ? { path: decodeURIComponent(match[1]!) } : null;
}

function parseCellId(id: string): { rowKey: string; state: string } | null {
  const match = /^cell:([^:]+):([^:]+)$/.exec(id);
  return match
    ? { rowKey: decodeURIComponent(match[1]!), state: decodeURIComponent(match[2]!) }
    : null;
}
