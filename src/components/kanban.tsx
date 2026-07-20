import { useEffect, useState } from "react";
import type { DragEvent } from "react";
import type { BoardApi, BoardState, TaskCard } from "../state.ts";
import { columnsForTasks } from "../tasks-model.ts";

/**
 * The board: columns from `columnsForTasks`, native HTML5 drag & drop for
 * moves, a per-column inline "+ add", and a detail overlay per card. No
 * optimistic state anywhere — every mutation just awaits the api call and the
 * pushed live-state patch repaints the board (controls disable in flight).
 */
export function Kanban({ board, api }: { board: BoardState; api: BoardApi | null }) {
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const columns = columnsForTasks(board.tasks);
  const selectedTask = selectedPath
    ? (board.tasks.find((task) => task.path === selectedPath) ?? null)
    : null;

  const dropOn = async (event: DragEvent<HTMLDivElement>, state: string) => {
    event.preventDefault();
    setDropTarget(null);
    const path = event.dataTransfer.getData("text/plain") || dragPath;
    setDragPath(null);
    if (!path || api === null || moving) return;
    const task = board.tasks.find((candidate) => candidate.path === path);
    if (!task || task.state === state) return;
    setMoving(true);
    try {
      await api.moveTask({ path, state });
    } finally {
      setMoving(false);
    }
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
            onDrop={(event) => void dropOn(event, column.state)}
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
                draggable={api !== null && !moving}
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
            <AddTask
              state={column.state}
              api={api}
              // Adding while a drag-move is committing would race the same
              // board; one in-flight mutation at a time keeps it legible.
              disabled={moving}
            />
          </div>
        ))}
      </div>
      {selectedTask ? (
        <TaskDetail
          key={selectedTask.path}
          task={selectedTask}
          api={api}
          onClose={() => setSelectedPath(null)}
        />
      ) : null}
    </>
  );
}

function Card({
  task,
  draggable,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  task: TaskCard;
  draggable: boolean;
  dragging: boolean;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onOpen: () => void;
}) {
  const hasDots = task.labels.length > 0 || task.agent !== null;
  return (
    <div
      draggable={draggable}
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
      <span style={{ fontSize: "0.85rem", overflowWrap: "anywhere" }}>{task.title}</span>
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

function AddTask({
  state,
  api,
  disabled,
}: {
  state: string;
  api: BoardApi | null;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const add = async () => {
    const trimmed = title.trim();
    if (!trimmed || api === null) return;
    setBusy(true);
    try {
      await api.addTask({ title: trimmed, state });
      setTitle("");
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={api === null || disabled}
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
        void add();
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
        disabled={busy}
        style={{ width: "100%", fontSize: "0.85rem" }}
      />
    </form>
  );
}

function TaskDetail({
  task,
  api,
  onClose,
}: {
  task: TaskCard;
  api: BoardApi | null;
  onClose: () => void;
}) {
  // Local draft only — a live-state push while editing must not clobber the
  // textarea. The component is keyed by path, so a different card remounts it.
  const [source, setSource] = useState(task.source);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const save = async () => {
    if (api === null) return;
    setBusy(true);
    try {
      await api.updateTask({ path: task.path, source });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (api === null || !window.confirm(`Delete ${task.path}?`)) return;
    setBusy(true);
    try {
      await api.deleteTask({ path: task.path });
      onClose();
    } finally {
      setBusy(false);
    }
  };

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
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <textarea
          value={source}
          onChange={(event) => setSource(event.target.value)}
          disabled={busy}
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
          <button type="button" onClick={() => void save()} disabled={busy || api === null}>
            Save
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy || api === null}
            style={{ color: "#e6b3b8" }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
