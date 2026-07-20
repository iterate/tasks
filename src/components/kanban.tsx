import { useEffect, useState } from "react";
import type { DragEvent } from "react";
import type { TaskCard, TaskChangeStatus } from "../state.ts";
import { columnsForTasks } from "../tasks-model.ts";
import { ChangeStatusMark } from "./commit-controls.tsx";

/**
 * The board: columns from `columnsForTasks`, native HTML5 drag & drop for
 * moves, a per-column inline "+ add", and a detail overlay per card. Every
 * mutation here is SYNCHRONOUS and LOCAL — a working-tree write that repaints
 * this render, no network anywhere. The commit surface (routes/index.tsx)
 * turns the accumulated changes into git commits later.
 */
export function Kanban({
  tasks,
  taskChangeByPath,
  onMove,
  onAdd,
  onWrite,
  onDiscard,
  onDelete,
}: {
  tasks: TaskCard[];
  /** Uncommitted status per changed path — cards wear an A/M mark. */
  taskChangeByPath: ReadonlyMap<string, TaskChangeStatus>;
  onMove: (task: TaskCard, state: string) => void;
  onAdd: (title: string, state: string) => void;
  /** Write-through from the detail editor: the full markdown source. */
  onWrite: (task: TaskCard, source: string) => void;
  /** Revert a card's local edits back to its baseline. */
  onDiscard: (path: string) => void;
  onDelete: (task: TaskCard) => void;
}) {
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const columns = columnsForTasks(tasks);
  const selectedTask = selectedPath
    ? (tasks.find((task) => task.path === selectedPath) ?? null)
    : null;

  const dropOn = (event: DragEvent<HTMLDivElement>, state: string) => {
    event.preventDefault();
    setDropTarget(null);
    const path = event.dataTransfer.getData("text/plain") || dragPath;
    setDragPath(null);
    if (!path) return;
    const task = tasks.find((candidate) => candidate.path === path);
    if (task) onMove(task, state);
  };

  return (
    <>
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "flex-start", overflowX: "auto" }}>
        {columns.map((column) => (
          <div
            key={column.state}
            onDragOver={(event) => {
              event.preventDefault();
              setDropTarget(column.state);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDropTarget((current) => (current === column.state ? null : current));
              }
            }}
            onDrop={(event) => dropOn(event, column.state)}
            style={{
              flex: "0 0 15rem",
              background: dropTarget === column.state ? "#161b21" : "#101317",
              border: `1px solid ${dropTarget === column.state ? "#3a4250" : "#2a2f36"}`,
              borderRadius: "8px",
              padding: "0.6rem",
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
              minHeight: "6rem",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                padding: "0 0.15rem",
              }}
            >
              <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>{column.state}</span>
              <span style={{ color: "#6b7280", fontSize: "0.75rem" }}>{column.tasks.length}</span>
            </div>
            {column.tasks.map((task) => (
              <Card
                key={task.path}
                task={task}
                changeStatus={taskChangeByPath.get(task.path)}
                dragging={dragPath === task.path}
                onDragStart={(event) => {
                  event.dataTransfer.setData("text/plain", task.path);
                  event.dataTransfer.effectAllowed = "move";
                  setDragPath(task.path);
                }}
                onDragEnd={() => setDragPath(null)}
                onOpen={() => setSelectedPath(task.path)}
              />
            ))}
            <AddTask state={column.state} onAdd={onAdd} />
          </div>
        ))}
      </div>
      {selectedTask ? (
        <TaskDetail
          key={selectedTask.path}
          task={selectedTask}
          changeStatus={taskChangeByPath.get(selectedTask.path)}
          onWrite={onWrite}
          onDiscard={onDiscard}
          onDelete={onDelete}
          onClose={() => setSelectedPath(null)}
        />
      ) : null}
    </>
  );
}

function Card({
  task,
  changeStatus,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  task: TaskCard;
  changeStatus: TaskChangeStatus | undefined;
  dragging: boolean;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onOpen: () => void;
}) {
  const hasDots = task.labels.length > 0 || task.agent !== null;
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
      style={{
        background: "#22262c",
        border: "1px solid #2a2f36",
        borderRadius: "8px",
        padding: "0.5rem 0.6rem",
        cursor: "grab",
        opacity: dragging ? 0.4 : 1,
        display: "flex",
        flexDirection: "column",
        gap: "0.35rem",
      }}
    >
      <span style={{ display: "flex", alignItems: "baseline", gap: "0.4rem" }}>
        <span style={{ flex: 1, fontSize: "0.85rem", overflowWrap: "anywhere" }}>{task.title}</span>
        {changeStatus !== undefined ? <ChangeStatusMark status={changeStatus} /> : null}
      </span>
      {hasDots ? (
        <span style={{ display: "flex", gap: "0.3rem", alignItems: "center" }}>
          {task.labels.map((label) => (
            <Dot key={label} title={label} background={labelColor(label)} />
          ))}
          {task.agent !== null ? (
            <Dot
              title={`agent: ${task.agent}`}
              background="transparent"
              border="1.5px solid #8b93e6"
            />
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function Dot({
  title,
  background,
  border,
}: {
  title: string;
  background: string;
  border?: string;
}) {
  return (
    <span
      title={title}
      style={{
        width: "6px",
        height: "6px",
        borderRadius: "50%",
        background,
        border,
        display: "inline-block",
        flex: "none",
      }}
    />
  );
}

/** Deterministic muted color per label — dots, not text badges. */
function labelColor(label: string): string {
  let hash = 0;
  for (let index = 0; index < label.length; index++) {
    hash = (hash * 31 + label.charCodeAt(index)) | 0;
  }
  return `hsl(${Math.abs(hash) % 360} 55% 55%)`;
}

function AddTask({ state, onAdd }: { state: string; onAdd: (title: string, state: string) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");

  const add = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    onAdd(trimmed, state);
    setTitle("");
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          background: "transparent",
          border: "none",
          color: "#6b7280",
          textAlign: "left",
          padding: "0.2rem 0.15rem",
        }}
      >
        + add
      </button>
    );
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        add();
      }}
    >
      <input
        autoFocus
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setTitle("");
            setOpen(false);
          }
        }}
        placeholder="task title"
        aria-label={`add task to ${state}`}
        style={{ width: "100%", fontSize: "0.85rem" }}
      />
    </form>
  );
}

function TaskDetail({
  task,
  changeStatus,
  onWrite,
  onDiscard,
  onDelete,
  onClose,
}: {
  task: TaskCard;
  changeStatus: TaskChangeStatus | undefined;
  onWrite: (task: TaskCard, source: string) => void;
  onDiscard: (path: string) => void;
  onDelete: (task: TaskCard) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.55)",
        display: "flex",
        justifyContent: "flex-end",
        zIndex: 10,
      }}
    >
      <div
        style={{
          width: "min(34rem, 100%)",
          height: "100%",
          background: "#14171b",
          borderLeft: "1px solid #2a2f36",
          padding: "1.25rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <code style={{ color: "#9aa3ad", fontSize: "0.8rem", flex: 1, overflowWrap: "anywhere" }}>
            {task.path}
          </code>
          {changeStatus !== undefined ? <ChangeStatusMark status={changeStatus} /> : null}
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
        {/* Write-through: every keystroke is a working-tree edit. The value is
            the effective source, so reverting (or a matching HEAD refresh)
            repaints the textarea from the same single source of truth. */}
        <textarea
          value={task.source}
          onChange={(event) => onWrite(task, event.target.value)}
          spellCheck={false}
          style={{
            flex: 1,
            minHeight: "16rem",
            fontFamily: "ui-monospace, monospace",
            fontSize: "0.8rem",
            resize: "none",
            background: "#0b0d10",
          }}
        />
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            type="button"
            onClick={() => onDiscard(task.path)}
            disabled={changeStatus === undefined}
            title="Revert this card's uncommitted edits"
          >
            Revert
          </button>
          <button
            type="button"
            onClick={() => {
              if (!window.confirm(`Delete ${task.path}?`)) return;
              onDelete(task);
              onClose();
            }}
            style={{ color: "#e6b3b8" }}
          >
            Delete
          </button>
          <span style={{ marginLeft: "auto", alignSelf: "center", color: "#6b7280", fontSize: "0.75rem" }}>
            {changeStatus === undefined ? "in sync with HEAD" : "uncommitted local change"}
          </span>
        </div>
      </div>
    </div>
  );
}
