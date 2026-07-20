import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { useBoard } from "../lib/use-board.ts";
import { useTaskCommit } from "../lib/use-task-commit.ts";
import {
  fileChangeForEntry,
  textContentForEntry,
  workingTreeStore,
  type FileEntry,
} from "../lib/working-tree.ts";
import type { BoardApi, BoardState, TaskCard } from "../state.ts";
import {
  fallbackCommitMessage,
  listTaskChanges,
  newTaskFile,
  overlayTaskCards,
  setTaskCardState,
  taskColumnState,
  taskPathForTitle,
} from "../tasks-model.ts";
import { CommitControls, DeletedTasksStrip } from "../components/commit-controls.tsx";
import { Kanban } from "../components/kanban.tsx";

export const Route = createFileRoute("/")({ component: BoardPage });

/**
 * The board IS the root route. The project is implicit in the reverse proxy
 * (`x-itx-project-id` + `iterate-project-auth` cookie); the client just dials
 * `/api/board`.
 */
function BoardPage() {
  const { board, api, connectionError } = useBoard();

  if (board === undefined) {
    return (
      <div>
        <BoardHeading projectId={null} />
        {connectionError ? (
          <ErrorCard message={connectionError} />
        ) : (
          <p style={{ color: "#9aa3ad" }}>connecting…</p>
        )}
      </div>
    );
  }

  return (
    <div>
      <BoardHeading projectId={board.projectId} />
      {connectionError ? <ErrorCard message={connectionError} /> : null}
      {board.status === "connecting" ? (
        <p style={{ color: "#9aa3ad" }}>connecting to the project repo…</p>
      ) : board.status === "error" ? (
        <ErrorCard message={board.error ?? "something went wrong"}>
          <button type="button" disabled={api === null} onClick={() => void api?.refresh()}>
            Retry
          </button>
        </ErrorCard>
      ) : board.projectId === null || board.commitOid === null ? null : (
        <ReadyBoard
          board={board}
          api={api}
          projectId={board.projectId}
          commitOid={board.commitOid}
        />
      )}
    </div>
  );
}

/**
 * The working board: HEAD tasks from live state with the browser's git-shaped
 * working tree laid over them. Drags, edits, adds, and deletes land in the
 * working tree synchronously (the UI repaints in the same render); the commit
 * controls — or the 60s idle autosave — flush the accumulated file changes as
 * ONE git commit through this session, attributed to the connected user.
 */
function ReadyBoard({
  board,
  api,
  projectId,
  commitOid,
}: {
  board: BoardState;
  api: BoardApi | null;
  projectId: string;
  commitOid: string;
}) {
  // Keyed by project AND HEAD oid: our own commit migrates surviving edits to
  // the new oid's store; an external commit orphans them (never nonsense
  // diffs against a checkout that no longer exists).
  const store = workingTreeStore({ projectId, commitOid });
  const changes = useSyncExternalStore(
    store.subscribe,
    () => store.changes,
    () => store.changes,
  );
  const headContents = useMemo(
    () => Object.fromEntries(board.tasks.map((task) => [task.path, task.source])),
    [board.tasks],
  );
  const tasks = useMemo(() => overlayTaskCards(headContents, changes), [changes, headContents]);
  const taskChanges = useMemo(
    () => listTaskChanges(changes, headContents),
    [changes, headContents],
  );
  const taskChangeByPath = useMemo(
    () => new Map(taskChanges.map((change) => [change.path, change.status] as const)),
    [taskChanges],
  );
  const deletedChanges = useMemo(
    () => taskChanges.filter((change) => change.status === "deleted"),
    [taskChanges],
  );
  const taskChangeSignature = useMemo(
    () =>
      taskChanges
        .map((change) => `${change.path}:${change.status}:${entryFingerprint(change.entry)}`)
        .join("|"),
    [taskChanges],
  );

  const [commitPending, setCommitPending] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  const commitTaskChanges = useCallback(
    async (message: string | undefined) => {
      if (api === null) throw new Error("not connected");
      // One snapshot drives the RPC payload, the fallback message, and the
      // post-commit cleanup, so all three describe the same change set. An
      // empty message summarizes deterministically — no AI call sits between
      // an autosave firing and the commit.
      const listed = listTaskChanges(store.changes, headContents);
      if (listed.length === 0) return;
      setCommitPending(true);
      setCommitError(null);
      try {
        const result = await api.commitChanges({
          message: message ?? fallbackCommitMessage(listed),
          changes: listed.map((change) => fileChangeForEntry(change.path, change.entry)),
        });
        // The DO refreshed the shared live state before resolving, so HEAD
        // already shows these changes. Equality-guarded cleanup: a slot the
        // user re-edited while the RPC was in flight no longer matches its
        // committed entry and survives — then migrates to the new oid's store.
        store.clearCommitted(new Map(listed.map((change) => [change.path, change.entry])));
        store.migrateTo(workingTreeStore({ projectId, commitOid: result.commitOid }));
      } catch (error) {
        setCommitError(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        setCommitPending(false);
      }
    },
    [api, headContents, projectId, store],
  );

  const commit = useTaskCommit({
    api,
    taskChanges,
    taskChangeSignature,
    onCommit: commitTaskChanges,
  });

  /** An edit identical to its baseline (staged snapshot, else HEAD) is no edit at all. */
  const writeTask = (path: string, content: string) => {
    const baseline = textContentForEntry(changes.get(path)?.staged) ?? headContents[path];
    store.setWorking(
      path,
      content === baseline ? undefined : ({ type: "write", content } satisfies FileEntry),
    );
  };
  const moveTask = (task: TaskCard, state: string) => {
    if (taskColumnState(task.state) === state) return;
    writeTask(task.path, setTaskCardState(task.source, state));
  };
  const addTask = (title: string, state: string) => {
    const reserved = new Set([...Object.keys(headContents), ...changes.keys()]);
    let file = newTaskFile({ title, state });
    for (let suffix = 2; reserved.has(file.path); suffix++) {
      file = { ...file, path: taskPathForTitle(title, `${suffix}`) };
    }
    store.setWorking(file.path, { type: "write", content: file.content });
  };
  const deleteTask = (task: TaskCard) => {
    // Deleting a card that only exists as an uncommitted add just drops the
    // add — a delete entry would ask git to remove a file HEAD never had.
    if (task.path in headContents) store.setWorking(task.path, { type: "delete" });
    else store.discardWorking(task.path);
  };

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: "0.75rem",
          margin: "0 0 0.75rem",
        }}
      >
        <CommitControls
          taskChanges={taskChanges}
          commitMessage={commit.commitMessage}
          onCommitMessageChange={commit.setCommitMessage}
          commitPending={commitPending}
          generatingMessage={commit.generatingMessage}
          autoSaveDueAt={commit.autoSaveDueAt}
          canCommit={api !== null}
          onMakeCommit={commit.makeCommit}
          onWriteCommitMessage={commit.writeCommitMessage}
          onDiscardAll={() => store.discardAll()}
        />
      </div>
      {commitError ? <ErrorCard message={`commit failed: ${commitError}`} /> : null}
      <DeletedTasksStrip
        deletedChanges={deletedChanges}
        onRestore={(path) => store.discardWorking(path)}
      />
      <Kanban
        tasks={tasks}
        taskChangeByPath={taskChangeByPath}
        onMove={moveTask}
        onAdd={addTask}
        onWrite={(task, source) => writeTask(task.path, source)}
        onDiscard={(path) => store.discardWorking(path)}
        onDelete={deleteTask}
      />
      <p style={{ color: "#6b7280", fontSize: "0.8rem", marginTop: "1rem" }}>
        <code>{commitOid.slice(0, 7)}</code>
        {" · "}
        {tasks.length} task{tasks.length === 1 ? "" : "s"}
        {taskChanges.length > 0 ? (
          <>
            {" · "}
            <span style={{ color: "#d9a05b" }}>
              {taskChanges.length} uncommitted change{taskChanges.length === 1 ? "" : "s"}
            </span>
          </>
        ) : null}
      </p>
    </>
  );
}

/** Full content, not a truncated hash: task files are small, and a prefix
 * fingerprint would miss edits past the cut and fail to restart the autosave
 * window. */
function entryFingerprint(entry: FileEntry): string {
  if (entry.type === "delete") return "delete";
  if (entry.type === "write") return `write:${entry.content.length}:${entry.content}`;
  return `b64:${entry.contentBase64.length}:${entry.contentBase64}`;
}

function BoardHeading({ projectId }: { projectId: string | null }) {
  return (
    <h1 style={{ fontSize: "1.2rem", margin: "0 0 1rem" }}>
      <span style={{ color: "#6b7280", fontWeight: 400 }}>board</span>
      {projectId ? (
        <>
          <span style={{ color: "#6b7280", fontWeight: 400 }}> / </span>
          {projectId}
        </>
      ) : null}
    </h1>
  );
}

function ErrorCard({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div
      style={{
        maxWidth: "34rem",
        background: "#2a1b1d",
        border: "1px solid #4a2a2e",
        borderRadius: "8px",
        padding: "0.9rem 1.1rem",
        margin: "0 0 1rem",
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
      }}
    >
      <span style={{ color: "#e6b3b8", flex: 1 }}>{message}</span>
      {children}
    </div>
  );
}
