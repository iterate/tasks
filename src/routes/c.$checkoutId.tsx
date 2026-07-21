import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import type YProvider from "y-partyserver/provider";
import { CheckIcon, LinkIcon, SearchIcon, Settings2Icon } from "lucide-react";
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
  applyVerifiedIdentity,
  commitCheckoutOp,
  generateCheckoutMessageOp,
  localCollabUser,
  renameCollabUser,
  useCheckout,
  whoami,
} from "../lib/use-checkout.ts";
import type { TasksUser } from "../lib/tasks-api.ts";
import { useTaskCommit, type CommitMessageApi } from "../lib/use-task-commit.ts";
import type { TaskChangeSummary } from "../state.ts";
import {
  columnsForTasks,
  fallbackCommitMessage,
  isTaskFilePath,
  newTaskFile,
  setTaskCardState,
  taskColumnState,
  taskPathForTitle,
} from "../tasks-model.ts";
import {
  taskPathInFolder,
  toBoardTask,
  type BoardTask,
  type PresenceUser,
} from "../lib/board-model.ts";
import { Board } from "../components/board.tsx";
import { TaskSheet } from "../components/task-sheet.tsx";
import { CommitControls, DeletedTasksStrip } from "../components/commit-controls.tsx";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select.tsx";
import { SidebarTrigger } from "../ui/sidebar.tsx";
import { Skeleton } from "../ui/skeleton.tsx";

/**
 * Every piece of view state rides in the URL so any view is deep-linkable:
 * `repoPath` (omitted for the default repo), `task` (the open task sheet),
 * `q` (the board filter), `group=none` (grouping off; folder grouping is
 * the default and stays out of the URL).
 */
type CheckoutSearch = { repoPath?: string; task?: string; q?: string; group?: "none" };

export const Route = createFileRoute("/c/$checkoutId")({
  validateSearch: (search: Record<string, unknown>): CheckoutSearch => {
    const repoPath = normalizeRepoPath(
      typeof search.repoPath === "string" ? search.repoPath : null,
    );
    const validated: CheckoutSearch =
      repoPath === null || repoPath === DEFAULT_REPO_PATH ? {} : { repoPath };
    if (typeof search.task === "string" && search.task !== "") validated.task = search.task;
    if (typeof search.q === "string" && search.q !== "") validated.q = search.q;
    if (search.group === "none") validated.group = "none";
    return validated;
  },
  component: CheckoutPage,
});

type Peer = {
  id: number;
  user: PresenceUser;
  email?: string;
  userId?: string;
  openPath: string | null;
};

/**
 * The collaborative board page. Everything above the board lives in ONE
 * filter strip (no page header): sidebar trigger, task filter, grouping
 * control, presence, and the commit surface. Every mutation edits the
 * checkout's shared Y.Doc, so all collaborators repaint together.
 */
function CheckoutPage() {
  const { checkoutId } = Route.useParams();
  const repoPath = Route.useSearch().repoPath ?? DEFAULT_REPO_PATH;
  const { provider, doc, status, docVersion, awarenessVersion } = useCheckout(
    checkoutId,
    repoPath,
  );

  // The platform-verified identity: fetched once per page, overlaid on our
  // presence (real name, userId/email in awareness) as soon as both the
  // identity and the provider exist.
  const [me, setMe] = useState<TasksUser | null>(null);
  useEffect(() => {
    let cancelled = false;
    whoami()
      .then((user) => {
        if (!cancelled) setMe(user);
      })
      .catch(() => {
        // identity is progressive enhancement — the animal name stands in
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (provider !== null && me !== null) applyVerifiedIdentity(provider, me);
  }, [provider, me]);

  const snapshot = useMemo(() => {
    if (doc === null) return null;
    void docVersion; // dependency: recompute when the doc changes
    const files = checkoutFileContents(doc);
    const base = checkoutBaseContents(doc);
    const tasks = Object.entries(files)
      .filter(([path]) => isTaskFilePath(path))
      .map(([path, source]) => toBoardTask(path, source))
      .sort((a, b) => a.path.localeCompare(b.path));
    return {
      files,
      base,
      baseCommit: checkoutBaseCommit(doc),
      tasks,
      taskChanges: checkoutTaskChanges(files, base),
    };
  }, [doc, docVersion]);

  const peers = useMemo<Peer[]>(() => {
    if (provider === null || doc === null) return [];
    void awarenessVersion;
    const listed: Peer[] = [];
    for (const [id, state] of provider.awareness.getStates()) {
      if (id === doc.clientID) continue;
      const user = (state as { user?: PresenceUser & { email?: string; userId?: string } }).user;
      if (!user || typeof user.name !== "string") continue;
      const openPath = (state as { openPath?: string | null }).openPath ?? null;
      listed.push({
        id,
        user: { name: user.name, color: user.color },
        email: typeof user.email === "string" ? user.email : undefined,
        userId: typeof user.userId === "string" ? user.userId : undefined,
        openPath,
      });
    }
    return listed;
  }, [provider, doc, awarenessVersion]);

  const ready = provider !== null && doc !== null && snapshot?.baseCommit !== undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {ready ? (
        <ReadyCheckout
          checkoutId={checkoutId}
          repoPath={repoPath}
          provider={provider}
          doc={doc}
          snapshot={snapshot!}
          peers={peers}
          me={me}
          disconnected={status === "disconnected"}
        />
      ) : (
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <span className="font-mono text-xs text-muted-foreground">{checkoutId}</span>
          </div>
          <Skeleton className="h-8 w-64" />
          <div className="flex gap-2">
            <Skeleton className="h-40 w-72" />
            <Skeleton className="h-40 w-72" />
            <Skeleton className="h-40 w-72" />
          </div>
          <p className="text-sm text-muted-foreground">
            {status === "disconnected" ? "disconnected — retrying…" : "opening the checkout…"}
          </p>
        </div>
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
  me,
  disconnected,
}: {
  checkoutId: string;
  repoPath: string;
  provider: YProvider;
  doc: Y.Doc;
  snapshot: {
    files: Record<string, string>;
    base: Record<string, string>;
    baseCommit: string | undefined;
    tasks: BoardTask[];
    taskChanges: TaskChangeSummary[];
  };
  peers: Peer[];
  me: TasksUser | null;
  disconnected: boolean;
}) {
  const { files, base, baseCommit, tasks, taskChanges } = snapshot;
  // View state lives in the URL (deep-linkable): q = filter, group = row
  // grouping, task = the open sheet. Filter/grouping replace history
  // entries; opening a task pushes one, so Back closes the sheet.
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const filter = search.q ?? "";
  const rowField: "folder" | null = search.group === "none" ? null : "folder";
  const openPath = search.task ?? null;
  const setFilter = (value: string) =>
    void navigate({
      search: (prev) => ({ ...prev, q: value === "" ? undefined : value }),
      replace: true,
    });
  const setRowField = (value: "folder" | null) =>
    void navigate({
      search: (prev) => ({ ...prev, group: value === null ? "none" : undefined }),
      replace: true,
    });
  const setOpenPath = (path: string | null) =>
    void navigate({ search: (prev) => ({ ...prev, task: path ?? undefined }) });

  const filteredTasks = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    if (query === "") return tasks;
    return tasks.filter((task) =>
      [task.title, task.summary, task.state, task.folder, task.path, ...task.labels].some(
        (value) => value.toLocaleLowerCase().includes(query),
      ),
    );
  }, [tasks, filter]);

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
      generateCommitMessage: () => generateCheckoutMessageOp(checkoutId, repoPath),
    }),
    [checkoutId, repoPath],
  );

  const commitCheckout = useCallback(
    async (message: string | undefined) => {
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
  const moveTask = (task: BoardTask, state: string, folder: string) => {
    const content =
      taskColumnState(task.state) === state ? task.source : setTaskCardState(task.source, state);
    if (folder === task.folder) {
      if (content !== task.source) writeTask(task.path, content);
      return;
    }
    // Cross-folder drop = rename: same file content lands on the new path.
    const nextPath = taskPathInFolder(task.path, folder);
    if (nextPath === task.path || filesMap.has(nextPath)) return;
    doc.transact(() => {
      filesMap.delete(task.path);
      filesMap.set(nextPath, new Y.Text(content));
    });
    if (openPath === task.path) setOpenPath(nextPath);
  };
  const addTask = (state: string, folder: string | null) => {
    const reserved = new Set([...Object.keys(files), ...Object.keys(base)]);
    let file = newTaskFile({
      title: "New task",
      state,
      author: me?.email ?? me?.userId ?? undefined,
    });
    for (let suffix = 2; reserved.has(inFolder(file.path, folder)); suffix++) {
      file = { ...file, path: taskPathForTitle("New task", `${suffix}`) };
    }
    const path = inFolder(file.path, folder);
    filesMap.set(path, new Y.Text(file.content));
    setOpenPath(path);
  };
  const deleteTask = (path: string) => {
    filesMap.delete(path);
    if (openPath === path) setOpenPath(null);
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

  const columns = useMemo(() => columnsForTasks(tasks).map((column) => column.state), [tasks]);
  const openTask = openPath === null ? null : (tasks.find((task) => task.path === openPath) ?? null);

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-background px-2 py-1.5">
        <SidebarTrigger className="-ml-0.5" />
        <div className="relative min-w-0 flex-1 sm:max-w-64">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
            placeholder="Filter tasks"
            aria-label="Filter tasks"
            className="h-8 pl-8 text-sm"
          />
        </div>
        <span className="hidden text-xs tabular-nums whitespace-nowrap text-muted-foreground md:inline">
          {filteredTasks.length}/{tasks.length} tasks
          {baseCommit ? <> · {baseCommit.slice(0, 7)}</> : null}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <PresenceStrip provider={provider} peers={peers} me={me} />
          <ShareLink />
          <Select
            items={[
              { label: "Group: folder", value: "folder" },
              { label: "No grouping", value: "none" },
            ]}
            value={rowField ?? "none"}
            onValueChange={(value) => setRowField(value === "folder" ? "folder" : null)}
          >
            <SelectTrigger
              aria-label="Board grouping"
              size="sm"
              className="h-8 w-fit gap-1.5 text-xs"
            >
              <Settings2Icon aria-hidden className="size-3.5 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="folder">Group: folder</SelectItem>
              <SelectItem value="none">No grouping</SelectItem>
            </SelectContent>
          </Select>
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
      </div>
      {disconnected ? (
        <p className="border-b bg-amber-500/10 px-3 py-1 text-xs text-amber-800">
          disconnected — reconnecting… (edits keep working and sync when back)
        </p>
      ) : null}
      {commitError ? (
        <p className="border-b bg-destructive/10 px-3 py-1 text-xs text-red-700">
          commit failed: {commitError}
        </p>
      ) : null}
      <DeletedTasksStrip deletedChanges={deletedChanges} onRestore={revertTask} />
      <Board
        tasks={filteredTasks}
        rowField={rowField}
        taskChangeByPath={taskChangeByPath}
        presenceByPath={presenceByPath}
        onMove={moveTask}
        onAdd={addTask}
        onOpen={setOpenPath}
      />
      <TaskSheet
        task={openTask}
        text={openTask === null ? undefined : filesMap.get(openTask.path)}
        awareness={provider.awareness}
        columns={columns}
        presence={openTask === null ? [] : (presenceByPath.get(openTask.path) ?? [])}
        changeStatus={openTask === null ? undefined : taskChangeByPath.get(openTask.path)}
        onChangeState={(state) => {
          if (openTask !== null) writeTask(openTask.path, setTaskCardState(openTask.source, state));
        }}
        onRevert={() => {
          if (openTask !== null) revertTask(openTask.path);
        }}
        onDelete={() => {
          if (openTask !== null) deleteTask(openTask.path);
        }}
        onClose={() => setOpenPath(null)}
      />
    </>
  );
}

function inFolder(path: string, folder: string | null): string {
  return folder === null || folder === "/" ? path : taskPathInFolder(path, folder);
}

/**
 * You + everyone else in the checkout. Chips show the verified identity
 * when the platform provided one — hover for email, userId, and what the
 * person has open (the OS stream-processor presence vocabulary). Click your
 * own chip to override the display name.
 */
function PresenceStrip({
  provider,
  peers,
  me,
}: {
  provider: YProvider;
  peers: Peer[];
  me: TasksUser | null;
}) {
  const [self, setSelf] = useState(() =>
    typeof window === "undefined" ? null : localCollabUser(),
  );
  if (self === null) return null;
  const selfName = me?.name ?? me?.email ?? self.name;
  const selfTitle = presenceTitle("You — click to rename", me?.email, me?.userId, null);
  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        title={selfTitle}
        onClick={() => {
          const name = window.prompt("Your collaborator name", selfName);
          if (name?.trim()) setSelf(renameCollabUser(provider, name));
        }}
        className="rounded-full border bg-transparent px-2 py-0.5 text-[11px]"
        style={{ color: self.color, borderColor: `${self.color}66` }}
      >
        {selfName}
      </button>
      {peers.map((peer) => (
        <span
          key={peer.id}
          title={presenceTitle(peer.user.name, peer.email, peer.userId, peer.openPath)}
          className="rounded-full border px-2 py-0.5 text-[11px]"
          style={{ color: peer.user.color, borderColor: `${peer.user.color}66` }}
        >
          {peer.user.name}
        </span>
      ))}
    </span>
  );
}

function presenceTitle(
  name: string,
  email: string | null | undefined,
  userId: string | null | undefined,
  openPath: string | null,
): string {
  const lines = [name];
  if (email) lines.push(email);
  if (userId) lines.push(userId);
  if (openPath) lines.push(`editing ${openPath}`);
  return lines.join("\n");
}

function ShareLink() {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 text-xs text-muted-foreground"
      title="Copy share link"
      onClick={() => {
        void navigator.clipboard.writeText(window.location.href).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? (
        <CheckIcon aria-hidden className="size-3.5" />
      ) : (
        <LinkIcon aria-hidden className="size-3.5" />
      )}
      {copied ? "Copied" : "Share"}
    </Button>
  );
}
