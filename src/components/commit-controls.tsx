import { useEffect, useRef, useState } from "react";
import type { TaskChangeStatus, TaskChangeSummary } from "../state.ts";

const STATUS_LETTER: Record<TaskChangeStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
};
const STATUS_COLOR: Record<TaskChangeStatus, string> = {
  added: "#6fbf8f",
  modified: "#d9a05b",
  deleted: "#e08a92",
};
const STATUS_WORD: Record<TaskChangeStatus, string> = {
  added: "New",
  modified: "Edited",
  deleted: "Deleted",
};

/** The A/M/D letter a changed card (or panel row) wears. */
export function ChangeStatusMark({ status }: { status: TaskChangeStatus }) {
  return (
    <span
      title={STATUS_WORD[status]}
      style={{
        color: STATUS_COLOR[status],
        fontFamily: "ui-monospace, monospace",
        fontWeight: 600,
        fontSize: "0.75rem",
        flex: "none",
      }}
    >
      {STATUS_LETTER[status]}
    </span>
  );
}

/**
 * The board's git surface: a Commit button with the autosave countdown beside
 * it, and a dropdown panel reviewing the pending change set — one row per
 * changed task file, a commit-message input (empty auto-generates), an AI
 * "write commit message" helper, and Discard all. Ported from the apps/os
 * tasks view's TaskCommitControls.
 */
export function CommitControls({
  taskChanges,
  commitMessage,
  onCommitMessageChange,
  commitPending,
  generatingMessage,
  autoSaveDueAt,
  canCommit,
  onMakeCommit,
  onWriteCommitMessage,
  onDiscardAll,
}: {
  taskChanges: readonly TaskChangeSummary[];
  commitMessage: string;
  onCommitMessageChange: (message: string) => void;
  commitPending: boolean;
  generatingMessage: boolean;
  autoSaveDueAt: number | undefined;
  canCommit: boolean;
  onMakeCommit: () => void;
  onWriteCommitMessage: () => void;
  onDiscardAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dirty = taskChanges.length > 0;
  const busy = commitPending || generatingMessage;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node | null)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", display: "flex", alignItems: "center", gap: "0.6rem" }}
    >
      {dirty && !commitPending && autoSaveDueAt !== undefined ? (
        <AutoSaveCountdown dueAt={autoSaveDueAt} />
      ) : null}
      <span style={{ display: "flex" }}>
        <button
          type="button"
          disabled={!dirty || busy || !canCommit}
          onClick={onMakeCommit}
          title={
            dirty
              ? "Commit task changes (empty message uses a generated summary)"
              : "No task changes to commit"
          }
          style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
        >
          {commitPending ? "Committing…" : `Commit${dirty ? ` (${taskChanges.length})` : ""}`}
        </button>
        <button
          type="button"
          disabled={!dirty}
          onClick={() => setOpen((current) => !current)}
          aria-label="Review task changes"
          aria-expanded={open}
          style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: "none" }}
        >
          ▾
        </button>
      </span>
      {open && dirty ? (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 0.4rem)",
            right: 0,
            width: "24rem",
            maxWidth: "calc(100vw - 2rem)",
            background: "#14171b",
            border: "1px solid #2a2f36",
            borderRadius: "8px",
            padding: "0.75rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.6rem",
            zIndex: 20,
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.45)",
          }}
        >
          <span style={{ color: "#9aa3ad", fontSize: "0.8rem" }}>
            {taskChanges.length} uncommitted task {taskChanges.length === 1 ? "file" : "files"}.
            Leave the message empty to auto-generate.
          </span>
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: "0.5rem",
              maxHeight: "10rem",
              overflowY: "auto",
              background: "#0e1114",
              border: "1px solid #2a2f36",
              borderRadius: "8px",
              display: "flex",
              flexDirection: "column",
              gap: "0.3rem",
            }}
          >
            {taskChanges.map((change) => (
              <li
                key={change.path}
                title={change.path}
                style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8rem" }}
              >
                <ChangeStatusMark status={change.status} />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {change.title}
                </span>
                <span style={{ color: "#6b7280", flex: "none" }}>{STATUS_WORD[change.status]}</span>
              </li>
            ))}
          </ul>
          <input
            value={commitMessage}
            onChange={(event) => onCommitMessageChange(event.target.value)}
            placeholder="Commit message (leave empty to auto-generate)"
            aria-label="Commit message"
            disabled={busy}
            style={{ fontSize: "0.85rem" }}
          />
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <button
              type="button"
              disabled={busy || !canCommit}
              onClick={onWriteCommitMessage}
              style={{ fontSize: "0.85rem" }}
            >
              {generatingMessage ? "Writing…" : "Write commit message"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Discard all uncommitted task changes?")) {
                  onDiscardAll();
                  setOpen(false);
                }
              }}
              style={{ fontSize: "0.85rem", color: "#e6b3b8" }}
            >
              Discard all
            </button>
            <button
              type="button"
              disabled={busy || !canCommit}
              onClick={onMakeCommit}
              style={{ marginLeft: "auto", fontSize: "0.85rem" }}
            >
              {commitPending ? "Committing…" : "Commit"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Ticks in its own leaf so the board behind it never re-renders on ticks. */
function AutoSaveCountdown({ dueAt }: { dueAt: number }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  const secondsLeft = Math.max(0, Math.ceil((dueAt - nowMs) / 1000));
  return (
    <span style={{ color: "#6b7280", fontSize: "0.8rem", fontVariantNumeric: "tabular-nums" }}>
      {secondsLeft <= 0 ? "Auto saving…" : `Auto saving in ${secondsLeft}s`}
    </span>
  );
}

/**
 * Deleted cards leave the board instantly, so this strip is where a pending
 * deletion stays visible — and reversible — until it is committed.
 */
export function DeletedTasksStrip({
  deletedChanges,
  onRestore,
}: {
  deletedChanges: readonly TaskChangeSummary[];
  onRestore: (path: string) => void;
}) {
  if (deletedChanges.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "0.5rem",
        margin: "0 0 0.75rem",
      }}
    >
      <span style={{ color: "#6b7280", fontSize: "0.8rem" }}>Deleted</span>
      {deletedChanges.map((change) => (
        <span
          key={change.path}
          title={change.path}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.4rem",
            background: "rgba(224, 138, 146, 0.08)",
            border: "1px solid rgba(224, 138, 146, 0.35)",
            borderRadius: "999px",
            padding: "0.15rem 0.35rem 0.15rem 0.6rem",
            fontSize: "0.8rem",
            color: "#e08a92",
          }}
        >
          {change.title}
          <button
            type="button"
            onClick={() => onRestore(change.path)}
            title={`Restore ${change.title}`}
            style={{
              background: "transparent",
              border: "none",
              padding: "0 0.25rem",
              color: "#e6e8eb",
              fontSize: "0.8rem",
            }}
          >
            restore
          </button>
        </span>
      ))}
    </div>
  );
}
