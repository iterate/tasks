import { Link, createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import * as Y from "yjs";
import type YProvider from "y-partyserver/provider";
import {
  DEFAULT_REPO_PATH,
  applyTextEdit,
  checkoutBaseCommit,
  checkoutBaseContents,
  checkoutFileContents,
  checkoutFilesMap,
  checkoutTaskChanges,
  normalizeRepoPath,
} from "../lib/checkout-shared.ts";
import {
  commitCheckoutOp,
  generateCheckoutMessageOp,
  localCollabUser,
  renameCollabUser,
  useCheckout,
} from "../lib/use-checkout.ts";
import { useTaskCommit, type CommitMessageApi } from "../lib/use-task-commit.ts";
import type { TaskCard, TaskChangeSummary } from "../state.ts";
import {
  fallbackCommitMessage,
  isTaskFilePath,
  newTaskFile,
  parseTaskCard,
  setTaskCardState,
  taskColumnState,
  taskPathForTitle,
} from "../tasks-model.ts";
import { CommitControls, DeletedTasksStrip } from "../components/commit-controls.tsx";
import { Kanban, type PresenceUser } from "../components/kanban.tsx";
import { TaskEditor } from "../components/task-editor.tsx";

export const Route = createFileRoute("/c/$checkoutId")({
  validateSearch: (search: Record<string, unknown>): { repoPath?: string } => {
    const repoPath = normalizeRepoPath(
      typeof search.repoPath === "string" ? search.repoPath : null,
    );
    return repoPath === null || repoPath === DEFAULT_REPO_PATH ? {} : { repoPath };
  },
  component: CheckoutPage,
});

/** Everything the board derives from the shared doc, recomputed per doc change. */
type CheckoutSnapshot = {
  files: Record<string, string>;
  base: Record<string, string>;
  baseCommit: string | undefined;
  tasks: TaskCard[];
  taskChanges: TaskChangeSummary[];
};

/**
 * The collaborative board. Every mutation — drags, adds, deletes, and each
 * keystroke in the detail editor — edits the checkout's shared Y.Doc, so
 * all collaborators repaint together and see each other's cursors. The
 * commit surface POSTs to the checkout DO, which flushes the doc's diff
 * against its base commit as ONE git commit, attributed to whoever pressed
 * the button (or whose autosave fired).
 */
function CheckoutPage() {
  const { checkoutId } = Route.useParams();
  const repoPath = Route.useSearch().repoPath ?? DEFAULT_REPO_PATH;
  const { provider, doc, status, docVersion, awarenessVersion } = useCheckout(
    checkoutId,
    repoPath,
  );

  const snapshot = useMemo<CheckoutSnapshot | null>(() => {
    if (doc === null) return null;
    void docVersion; // dependency: recompute when the doc changes
    const files = checkoutFileContents(doc);
    const base = checkoutBaseContents(doc);
    const tasks = Object.entries(files)
      .filter(([path]) => isTaskFilePath(path))
      .map(([path, source]) => parseTaskCard(path, source))
      .sort((a, b) => a.path.localeCompare(b.path));
    return {
      files,
      base,
      baseCommit: checkoutBaseCommit(doc),
      tasks,
      taskChanges: checkoutTaskChanges(files, base),
    };
  }, [doc, docVersion]);

  const peers = useMemo<Array<{ id: number; user: PresenceUser; openPath: string | null }>>(() => {
    if (provider === null || doc === null) return [];
    void awarenessVersion;
    const listed: Array<{ id: number; user: PresenceUser; openPath: string | null }> = [];
    for (const [id, state] of provider.awareness.getStates()) {
      if (id === doc.clientID) continue;
      const user = (state as { user?: PresenceUser }).user;
      if (!user || typeof user.name !== "string") continue;
      const openPath = (state as { openPath?: string | null }).openPath ?? null;
      listed.push({ id, user: { name: user.name, color: user.color }, openPath });
    }
    return listed;
  }, [provider, doc, awarenessVersion]);

  const seeded = snapshot?.baseCommit !== undefined;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          margin: "0 0 1rem",
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ fontSize: "1.2rem", margin: 0 }}>
          <span style={{ color: "#6b7280", fontWeight: 400 }}>checkout / </span>
          {checkoutId}
          {repoPath === DEFAULT_REPO_PATH ? null : (
            <code style={{ color: "#9aa3ad", fontSize: "0.8rem", marginLeft: "0.5rem" }}>
              {repoPath}
            </code>
          )}
        </h1>
        <PresenceStrip provider={provider} peers={peers} />
        <span style={{ flex: 1 }} />
        <ShareLink />
        <Link to="/" style={{ color: "#6b7280", fontSize: "0.85rem" }}>
          new checkout
        </Link>
      </div>
      {status === "disconnected" ? (
        <ErrorCard message="disconnected — reconnecting… (edits keep working and sync when back)" />
      ) : null}
      {provider === null || doc === null || snapshot === null || !seeded ? (
        <p style={{ color: "#9aa3ad" }}>opening the checkout…</p>
      ) : (
        <ReadyCheckout
          checkoutId={checkoutId}
          repoPath={repoPath}
          provider={provider}
          doc={doc}
          snapshot={snapshot}
          peers={peers}
        />
      )}
    </div>
  );
}

function ReadyCheckout({
  checkoutId,
  repoPath,
  provider,
  doc,
  snapshot,
  peers,
}: {
  checkoutId: string;
  repoPath: string;
  provider: YProvider;
  doc: Y.Doc;
  snapshot: CheckoutSnapshot;
  peers: Array<{ id: number; user: PresenceUser; openPath: string | null }>;
}) {
  const { files, base, baseCommit, tasks, taskChanges } = snapshot;

  const taskChangeByPath = useMemo(
    () => new Map(taskChanges.map((change) => [change.path, change.status] as const)),
    [taskChanges],
  );
  const deletedChanges = useMemo(
    () => taskChanges.filter((change) => change.status === "deleted"),
    [taskChanges],
  );
  const presenceByPath = useMemo(() => {
    const byPath = new Map<string, PresenceUser[]>();
    for (const peer of peers) {
      if (!peer.openPath) continue;
      const listed = byPath.get(peer.openPath) ?? [];
      listed.push(peer.user);
      byPath.set(peer.openPath, listed);
    }
    return byPath;
  }, [peers]);
  // Content-sensitive signature so every remote OR local edit restarts the
  // shared autosave window; whichever collaborator's timer fires first
  // commits, and the base rewrite syncs to everyone else, cancelling theirs.
  const taskChangeSignature = useMemo(
    () =>
      taskChanges
        .map((change) => `${change.path}:${change.status}:${files[change.path] ?? ""}`)
        .join("|"),
    [taskChanges, files],
  );

  const [commitPending, setCommitPending] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  const api = useMemo<CommitMessageApi>(
    () => ({
      generateCommitMessage: (input) =>
        generateCheckoutMessageOp(checkoutId, repoPath, input.changes),
    }),
    [checkoutId, repoPath],
  );

  const commitCheckout = useCallback(
    async (message: string | undefined) => {
      // The DO computes the authoritative diff at commit time; the fallback
      // message summarizes this client's view of the same change set.
      setCommitPending(true);
      setCommitError(null);
      try {
        await commitCheckoutOp(
          checkoutId,
          repoPath,
          message ??
            fallbackCommitMessage(
              checkoutTaskChanges(checkoutFileContents(doc), checkoutBaseContents(doc)),
            ),
        );
        // The new base + baseCommit arrive back through the doc sync.
      } catch (error) {
        setCommitError(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        setCommitPending(false);
      }
    },
    [checkoutId, repoPath, doc],
  );

  const commit = useTaskCommit({
    api,
    taskChanges,
    taskChangeSignature,
    onCommit: commitCheckout,
  });

  const filesMap = checkoutFilesMap(doc);
  const writeTask = (path: string, content: string) => {
    const text = filesMap.get(path);
    if (text) applyTextEdit(text, content);
    else filesMap.set(path, new Y.Text(content));
  };
  const moveTask = (task: TaskCard, state: string) => {
    if (taskColumnState(task.state) === state) return;
    writeTask(task.path, setTaskCardState(task.source, state));
  };
  const addTask = (title: string, state: string) => {
    const reserved = new Set([...Object.keys(files), ...Object.keys(base)]);
    let file = newTaskFile({ title, state });
    for (let suffix = 2; reserved.has(file.path); suffix++) {
      file = { ...file, path: taskPathForTitle(title, `${suffix}`) };
    }
    filesMap.set(file.path, new Y.Text(file.content));
  };
  const deleteTask = (task: TaskCard) => {
    filesMap.delete(task.path);
  };
  /** Back to the base commit's version: restore a delete, drop an add, undo edits. */
  const revertTask = (path: string) => {
    const baseContent = base[path];
    if (baseContent === undefined) filesMap.delete(path);
    else writeTask(path, baseContent);
  };
  const discardAll = () => {
    doc.transact(() => {
      for (const change of checkoutTaskChanges(
        checkoutFileContents(doc),
        checkoutBaseContents(doc),
      )) {
        revertTask(change.path);
      }
    });
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
          canCommit={true}
          onMakeCommit={commit.makeCommit}
          onWriteCommitMessage={commit.writeCommitMessage}
          onDiscardAll={discardAll}
        />
      </div>
      {commitError ? <ErrorCard message={`commit failed: ${commitError}`} /> : null}
      <DeletedTasksStrip deletedChanges={deletedChanges} onRestore={revertTask} />
      <Kanban
        tasks={tasks}
        taskChangeByPath={taskChangeByPath}
        presenceByPath={presenceByPath}
        onMove={moveTask}
        onAdd={addTask}
        onDiscard={revertTask}
        onDelete={deleteTask}
        renderEditor={(task) => {
          const text = filesMap.get(task.path);
          return text ? (
            <TaskEditor
              key={task.path}
              path={task.path}
              text={text}
              awareness={provider.awareness}
            />
          ) : null;
        }}
      />
      <p style={{ color: "#6b7280", fontSize: "0.8rem", marginTop: "1rem" }}>
        {baseCommit ? <code>{baseCommit.slice(0, 7)}</code> : null}
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
        {peers.length > 0 ? (
          <>
            {" · "}
            {peers.length + 1} collaborators
          </>
        ) : null}
      </p>
    </>
  );
}

/** You + everyone else in the checkout. Click your own chip to rename. */
function PresenceStrip({
  provider,
  peers,
}: {
  provider: YProvider | null;
  peers: Array<{ id: number; user: PresenceUser; openPath: string | null }>;
}) {
  const [self, setSelf] = useState(() =>
    typeof window === "undefined" ? null : localCollabUser(),
  );
  if (provider === null || self === null) return null;
  return (
    <span style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
      <button
        type="button"
        title="You — click to rename"
        onClick={() => {
          const name = window.prompt("Your collaborator name", self.name);
          if (name?.trim()) setSelf(renameCollabUser(provider, name));
        }}
        style={{
          color: self.color,
          border: `1px solid ${self.color}66`,
          background: "transparent",
          borderRadius: "999px",
          padding: "0.05rem 0.5rem",
          fontSize: "0.75rem",
        }}
      >
        {self.name}
      </button>
      {peers.map((peer) => (
        <span
          key={peer.id}
          title={peer.openPath ? `${peer.user.name} — editing ${peer.openPath}` : peer.user.name}
          style={{
            color: peer.user.color,
            border: `1px solid ${peer.user.color}66`,
            borderRadius: "999px",
            padding: "0.05rem 0.5rem",
            fontSize: "0.75rem",
          }}
        >
          {peer.user.name}
        </span>
      ))}
    </span>
  );
}

function ShareLink() {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      style={{ fontSize: "0.8rem" }}
      onClick={() => {
        void navigator.clipboard.writeText(window.location.href).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "copied!" : "copy share link"}
    </button>
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
