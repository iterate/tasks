import { DragDropProvider, useDraggable, useDroppable } from "@dnd-kit/react";
import { useMemo, type ReactNode } from "react";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleEllipsisIcon,
  FolderIcon,
  PlusIcon,
  TagIcon,
} from "lucide-react";
import { cn } from "../ui/utils.ts";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";
import type { TaskChangeStatus } from "../state.ts";
import { columnsForTasks, taskColumnState } from "../tasks-model.ts";
import {
  stateLabel,
  type BoardTask,
  type PresenceUser,
  type RowField,
} from "../lib/board-model.ts";
import { agoText, type RecentSpan, type RecentTouch } from "../lib/recency.ts";

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
  recentSpansByPath,
  onMove,
  onAdd,
  onOpen,
}: {
  tasks: BoardTask[];
  rowField: RowField;
  taskChangeByPath: Map<string, TaskChangeStatus>;
  presenceByPath: Map<string, PresenceUser[]>;
  recentByPath: Map<string, RecentTouch>;
  recentSpansByPath: Map<string, RecentSpan[]>;
  onMove: (task: BoardTask, state: string, folder: string, labels?: string[]) => void;
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
        // Dropping into another tag row re-tags the task (no-tag row clears).
        const labels =
          rowField === "label" && source.rowKey !== target.rowKey
            ? row.value === null
              ? []
              : [row.value]
            : undefined;
        if (
          taskColumnState(task.state) !== target.state ||
          task.folder !== folder ||
          labels !== undefined
        ) {
          onMove(task, target.state, folder, labels);
        }
      }}
    >
      <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-muted/30 p-2">
        {/* w-max + mx-auto: wider than the viewport it scrolls as before,
            narrower it floats centered. */}
        <div className="mx-auto flex min-h-full w-max flex-col gap-4">
          {rows.map((row, rowIndex) => (
            <section
              key={row.key}
              className={cn("flex min-w-full flex-col", rows.length === 1 && "min-h-full flex-1")}
            >
              {rowField === null || rows.length === 1 ? null : (
                <header className="sticky left-0 flex h-9 w-fit max-w-[calc(100vw-4rem)] items-center gap-2 px-2 text-sm font-medium">
                  {rowField === "folder" ? (
                    <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <TagIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className={cn("truncate text-xs", rowField === "folder" && "font-mono")}>
                    {row.label}
                  </span>
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
                    recentSpansByPath={recentSpansByPath}
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
  recentSpansByPath,
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
  recentSpansByPath: Map<string, RecentSpan[]>;
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
        "group/cell flex min-h-36 w-72 flex-none flex-col pb-4 transition-colors",
        isDropTarget && "rounded-lg bg-accent/40",
      )}
    >
      {showHeader ? (
        <header className="flex h-10 shrink-0 items-center gap-2 px-3">
          <TaskStateIcon state={state} />
          <h2 className="truncate text-sm font-medium">{stateLabel(state)}</h2>
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {tasks.length}
          </span>
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
              spans={recentSpansByPath.get(task.path)}
              onOpen={onOpen}
            />
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 h-8 w-full justify-center text-xs text-muted-foreground opacity-0 transition-opacity group-hover/cell:opacity-100 focus-visible:opacity-100"
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
  spans,
  onOpen,
}: {
  task: BoardTask;
  rowKey: string;
  changeStatus: TaskChangeStatus | undefined;
  presence: PresenceUser[];
  touch: RecentTouch | undefined;
  spans: RecentSpan[] | undefined;
  onOpen: (path: string) => void;
}) {
  const { ref, isDragging } = useDraggable({
    id: `card:${encodeURIComponent(task.path)}:${encodeURIComponent(rowKey)}`,
    type: "task",
  });
  const changeWord =
    changeStatus === "added" ? "New" : changeStatus === "modified" ? "Edited" : undefined;
  const hoverLines = [
    changeWord,
    touch ? `${touch.author.name} ${touch.action} this · ${agoText(touch.at)}` : undefined,
  ].filter((line): line is string => line !== undefined);
  const card = (
    <button
      type="button"
      ref={ref}
      onClick={() => onOpen(task.path)}
      style={
        touch
          ? { boxShadow: `0 0 0 1px ${touch.author.color}, 0 0 8px 0 ${touch.author.color}40` }
          : undefined
      }
      className={cn(
        "relative w-full cursor-grab rounded-md border border-border/70 bg-card p-2.5 text-left transition-[background-color,border-color,box-shadow,opacity] hover:bg-accent/40 active:cursor-grabbing",
        changeStatus === "added" &&
          "border-emerald-500/60 shadow-[inset_0_0_10px_-4px_rgba(16,185,129,0.4)]",
        changeStatus === "modified" &&
          "border-amber-500/60 shadow-[inset_0_0_10px_-4px_rgba(245,158,11,0.4)]",
        isDragging && "opacity-40",
      )}
    >
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
      <div className="flex items-start">
        <span className="min-w-0 flex-1 text-sm leading-snug font-medium">
          <HighlightedText text={task.title} offset={task.titleFrom} spans={spans} />
        </span>
      </div>
      {task.summary === "" ? null : (
        <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          <HighlightedText text={task.summary} offset={task.summaryFrom} spans={spans} />
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
  if (hoverLines.length === 0) return card;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="block w-full" />}>{card}</TooltipTrigger>
      <TooltipContent side="bottom" className="flex flex-col gap-0.5">
        {hoverLines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A card string with the recently-inserted characters washed in their
 * author's color — the same glow the editor shows, projected through the
 * string's offset in the task's source.
 */
function HighlightedText({
  text,
  offset,
  spans,
}: {
  text: string;
  offset: number | null;
  spans: RecentSpan[] | undefined;
}) {
  if (offset === null || spans === undefined || spans.length === 0 || text === "") {
    return <>{text}</>;
  }
  const end = offset + text.length;
  const overlapping = spans
    .filter((span) => span.from < end && span.to > offset)
    .sort((a, b) => a.from - b.from);
  if (overlapping.length === 0) return <>{text}</>;
  const segments: ReactNode[] = [];
  let cursor = 0;
  for (const span of overlapping) {
    const from = Math.max(Math.max(0, span.from - offset), cursor);
    const to = Math.min(text.length, span.to - offset);
    if (to <= from) continue;
    if (from > cursor) segments.push(text.slice(cursor, from));
    segments.push(
      <span
        key={`${from}:${to}`}
        style={{
          backgroundColor: `${span.author.color}2e`,
          borderBottom: `1.5px solid ${span.author.color}`,
        }}
        title={`${span.author.name} · ${agoText(span.at)}`}
      >
        {text.slice(from, to)}
      </span>,
    );
    cursor = to;
  }
  if (cursor < text.length) segments.push(text.slice(cursor));
  return <>{segments}</>;
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
  rowField: RowField,
): Array<{ key: string; label: string | null; value: string | null; tasks: BoardTask[] }> {
  if (rowField === null) return [{ key: "all", label: null, value: null, tasks }];
  const groups = new Map<string, BoardTask[]>();
  if (rowField === "folder") {
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
  // Tags: a task appears in every tag's row; untagged tasks share one
  // trailing "No tag" row. The tag set is just whatever exists in the data.
  for (const task of tasks) {
    const labels = task.labels.length === 0 ? [""] : task.labels;
    for (const label of labels) {
      const group = groups.get(label) ?? [];
      group.push(task);
      groups.set(label, group);
    }
  }
  if (groups.size === 0) groups.set("", []);
  return [...groups]
    .sort(([left], [right]) => {
      if (left === "") return 1;
      if (right === "") return -1;
      return left.localeCompare(right);
    })
    .map(([label, grouped]) => ({
      key: `label:${label}`,
      label: label === "" ? "No tag" : label,
      value: label === "" ? null : label,
      tasks: grouped,
    }));
}

function parseCardId(id: string): { path: string; rowKey: string } | null {
  const match = /^card:([^:]+):(.+)$/.exec(id);
  return match
    ? { path: decodeURIComponent(match[1]!), rowKey: decodeURIComponent(match[2]!) }
    : null;
}

function parseCellId(id: string): { rowKey: string; state: string } | null {
  const match = /^cell:([^:]+):([^:]+)$/.exec(id);
  return match
    ? { rowKey: decodeURIComponent(match[1]!), state: decodeURIComponent(match[2]!) }
    : null;
}
