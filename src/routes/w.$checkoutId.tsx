import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CollabEditorApi } from "../lib/collab-editor-api.ts";
import { SidebarTrigger } from "../ui/sidebar.tsx";
import { Board } from "../components/board.tsx";
import {
  CheckoutBreadcrumbs,
  FilterControl,
  GroupControl,
  MobileOverflow,
  ShareButton,
} from "../components/checkout-header.tsx";
import { ActivityIcon } from "lucide-react";
import { Button } from "../ui/button.tsx";
import { CommitControls, DeletedTasksStrip } from "../components/commit-controls.tsx";
import { StreamEventsSheet } from "../components/stream-events-sheet.tsx";
import { WithTooltip } from "../components/checkout-header.tsx";
import { WorkspaceTaskSheet } from "../components/workspace-task-sheet.tsx";
import { useWorkspaceBoard } from "../lib/use-workspace-board.ts";
import { useTaskCommit } from "../lib/use-task-commit.ts";
import { projectBoard } from "../lib/board-engine.ts";
import { taskPathInFolder, type BoardTask, type RowField } from "../lib/board-model.ts";
import { DEFAULT_REPO_PATH, normalizeRepoPath } from "../lib/checkout-shared.ts";
import {
  columnsForTasks,
  fallbackCommitMessage,
  isTaskFilePath,
  newTaskFile,
  setTaskCardLabels,
  setTaskCardState,
  taskColumnState,
  taskPathForTitle,
} from "../tasks-model.ts";

/**
 * The tasks board on the WORKSPACE mechanism — the SAME experience as the
 * Yjs checkout board (chrome, swimlanes, drag, filter/group, commit controls
 * with message writing, deleted-tasks strip, tag editing, deep links), but
 * every read and write is the platform workspace: the overlay is the diff,
 * commits are workspace commits, and the detail editor is the live
 * rebase-model collab session with redlines.
 *   /w/<checkoutId>?repo=/repos/config&task=<path>&q=<filter>&group=none
 */
export const Route = createFileRoute("/w/$checkoutId")({
  validateSearch: (search: Record<string, unknown>) => ({
    group:
      search.group === "none" || search.group === "label"
        ? (search.group as "none" | "label")
        : ("folder" as const),
    q: typeof search.q === "string" ? search.q : "",
    repo: typeof search.repo === "string" ? search.repo : DEFAULT_REPO_PATH,
    task: typeof search.task === "string" ? search.task : "",
  }),
  component: WorkspaceBoardPage,
});

function WorkspaceBoardPage() {
  const { checkoutId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const repoPath = normalizeRepoPath(search.repo) ?? DEFAULT_REPO_PATH;
  const board = useWorkspaceBoard(checkoutId, repoPath);
  // Auto-commit defaults OFF on the workspace board: every commit advances
  // the redline baseline, and a 60s autosave would wipe "what everyone did"
  // minute by minute. Committing is an explicit act here.
  const [autoCommit, setAutoCommit] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
  // A just-created task: the editor opens with the headline selected and the
  // filename trails the title until the first commit (same UX as the Yjs
  // board).
  const [draftPath, setDraftPath] = useState<string | null>(null);
  const renamedDraftRef = useRef(false);
  // The open sheet's live-doc API: mutations of the OPEN file go through the
  // live document (the board mirror is 200ms behind it — writing board state
  // over a live path would drop the newest keystrokes).
  const editorApiRef = useRef<CollabEditorApi | null>(null);

  /** Live text of the open file, else the board's copy. */
  const sourceOf = useCallback((task: BoardTask): string => {
    const api = editorApiRef.current;
    return api !== null && api.path === task.path ? api.source() : task.source;
  }, []);

  /** Transform the OPEN file in the live editor; false when not open. */
  const applyLive = useCallback(
    (path: string, transform: (source: string) => string): boolean => {
      const api = editorApiRef.current;
      if (api === null || api.path !== path) return false;
      api.applyTransform(transform);
      // Reflect immediately so cards/commit summaries don't lag the doc.
      board.reflectLiveContent(path, api.source());
      return true;
    },
    [board],
  );
  const [commitPending, setCommitPending] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  const patchSearch = useCallback(
    (patch: Partial<typeof search>) =>
      void navigate({ replace: true, search: (current) => ({ ...current, ...patch }) }),
    [navigate],
  );
  const rowField: RowField =
    search.group === "none" ? null : search.group === "label" ? "label" : "folder";

  const projection = useMemo(
    () => projectBoard({ filter: search.q, rowField, tasks: board.tasks }),
    [board.tasks, search.q, rowField],
  );
  const columns = useMemo(
    () => columnsForTasks(board.tasks).map((column) => column.state),
    [board.tasks],
  );
  const allTags = useMemo(
    () =>
      [...new Set(board.tasks.flatMap((task) => task.labels))].sort((a, b) => a.localeCompare(b)),
    [board.tasks],
  );
  const openTask = useMemo(
    () => board.tasks.find((task) => task.path === search.task) ?? null,
    [board.tasks, search.task],
  );
  const deletedChanges = useMemo(
    () => board.taskChanges.filter((change) => change.status === "deleted"),
    [board.taskChanges],
  );

  const commit = useTaskCommit({
    // The workspace lane summarizes deterministically; the AI one-liner is a
    // checkout-DO capability this lane can adopt later.
    api: {
      generateCommitMessage: async ({ changes }) => fallbackCommitMessage(changes),
    },
    enabled: autoCommit,
    onCommit: async (message) => {
      setCommitError(null);
      setCommitPending(true);
      try {
        return await board.commit(message?.trim() || fallbackCommitMessage(board.taskChanges));
      } catch (cause) {
        setCommitError(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      } finally {
        setCommitPending(false);
      }
    },
    taskChangeSignature: board.taskChanges
      .map((change) => `${change.status}:${change.path}`)
      .join("|"),
    taskChanges: board.taskChanges,
  });

  const moveTask = useCallback(
    (task: BoardTask, state: string, folder: string, labels?: string[]) => {
      const transform = (current: string) => {
        let next =
          taskColumnState(task.state) === state ? current : setTaskCardState(current, state);
        if (labels !== undefined) next = setTaskCardLabels(next, labels);
        return next;
      };
      if (folder === task.folder) {
        if (!applyLive(task.path, transform)) board.writeTask(task.path, transform(sourceOf(task)));
        return;
      }
      const nextPath = taskPathInFolder(task.path, folder);
      const source = transform(sourceOf(task));
      board.writeTask(nextPath, source);
      if (search.task === task.path) {
        patchSearch({ task: nextPath });
        // The open editor's final frame may still reach the old session —
        // carry any divergence over before the delete discards it.
        void board.readTask(task.path).then(
          (final) => {
            if (final !== null && transform(final) !== source) board.writeTask(nextPath, transform(final));
            board.deleteTask(task.path);
          },
          () => board.deleteTask(task.path),
        );
      } else {
        board.deleteTask(task.path);
      }
    },
    [applyLive, board, patchSearch, search.task, sourceOf],
  );

  const addTask = useCallback(
    (state: string, folder: string | null) => {
      const file = newTaskFile({ state, title: "New task" });
      const target = taskPathInFolder(file.path, folder ?? "/");
      board.writeTask(target, file.content);
      renamedDraftRef.current = false;
      setDraftPath(target);
      patchSearch({ task: target });
    },
    [board, patchSearch],
  );

  // While the draft's sheet is open and it is still an uncommitted add, its
  // filename trails the headline (debounced so half-typed titles don't churn
  // paths).
  useEffect(() => {
    if (draftPath === null || search.task !== draftPath) return;
    if (board.changes.get(draftPath) !== "added") return;
    const task = board.tasks.find((candidate) => candidate.path === draftPath);
    if (task === undefined) return;
    const target = taskPathInFolder(taskPathForTitle(task.title), task.folder);
    if (target === draftPath || board.files?.[target] !== undefined) return;
    const timer = setTimeout(() => {
      // The LIVE doc, not the board mirror — the mirror is debounced and a
      // rename must never persist a version missing the newest keystrokes.
      const source = sourceOf(task);
      if (board.files?.[target] !== undefined) return;
      board.writeTask(target, source);
      renamedDraftRef.current = true;
      setDraftPath(target);
      patchSearch({ task: target });
      // The old editor unmounts with the navigation; a keystroke landing in
      // its final frame lives in the old session's head — carry it over
      // before the delete discards that session.
      void board.readTask(draftPath).then(
        (final) => {
          if (final !== null && final !== source) board.writeTask(target, final);
          board.deleteTask(draftPath);
        },
        () => board.deleteTask(draftPath),
      );
    }, 700);
    return () => clearTimeout(timer);
  }, [draftPath, search.task, board, patchSearch, sourceOf]);

  // The sheet's path field: any rename the board can represent is allowed —
  // the file must stay a task (.md under a folder named "tasks").
  const renameTask = useCallback(
    (task: BoardTask, nextPathRaw: string): string | null => {
      const nextPath = nextPathRaw.split("/").filter(Boolean).join("/");
      if (nextPath === "") return "Path cannot be empty.";
      if (!isTaskFilePath(nextPath))
        return 'Path must be a .md file inside a folder named "tasks".';
      if (nextPath === task.path) return null;
      if (board.files?.[nextPath] !== undefined) return "A file already exists at that path.";
      const source = sourceOf(task);
      board.writeTask(nextPath, source);
      setDraftPath((current) => (current === task.path ? nextPath : current));
      if (search.task === task.path) patchSearch({ task: nextPath });
      // Same final-frame carry as the draft rename (see that effect).
      void board.readTask(task.path).then(
        (final) => {
          if (final !== null && final !== source) board.writeTask(nextPath, final);
          board.deleteTask(task.path);
        },
        () => board.deleteTask(task.path),
      );
      return null;
    },
    [board, patchSearch, search.task, sourceOf],
  );

  return (
    <>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-background px-3">
        <SidebarTrigger className="-ml-1" />
        <CheckoutBreadcrumbs repoPath={repoPath} checkoutId={checkoutId} />
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <div className="hidden items-center gap-1.5 sm:flex">
            <WithTooltip label="Stream events">
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 px-0"
                aria-label="Stream events"
                onClick={() => setEventsOpen(true)}
              >
                <ActivityIcon className="size-4" />
              </Button>
            </WithTooltip>
            <ShareButton />
            <FilterControl value={search.q} onChange={(q) => patchSearch({ q })} />
            <GroupControl
              value={rowField}
              onChange={(next) =>
                patchSearch({
                  group: next === null ? "none" : next === "label" ? "label" : "folder",
                })
              }
            />
          </div>
          <div className="sm:hidden">
            <MobileOverflow
              filter={search.q}
              onChangeFilter={(q) => patchSearch({ q })}
              group={rowField}
              onChangeGroup={(next) =>
                patchSearch({
                  group: next === null ? "none" : next === "label" ? "label" : "folder",
                })
              }
            />
          </div>
          <CommitControls
            taskChanges={board.taskChanges}
            commitMessage={commit.commitMessage}
            onCommitMessageChange={commit.setCommitMessage}
            commitPending={commitPending}
            generatingMessage={commit.generatingMessage}
            autoSaveDueAt={commit.autoSaveDueAt}
            autoCommit={autoCommit}
            onAutoCommitChange={setAutoCommit}
            canCommit={true}
            onMakeCommit={commit.makeCommit}
            onWriteCommitMessage={commit.writeCommitMessage}
            onDiscardAll={board.discardAll}
          />
        </div>
      </header>
      {board.error !== null && (
        <p className="border-b bg-amber-500/10 px-3 py-1 text-xs text-amber-800">{board.error}</p>
      )}
      {commitError !== null && (
        <p className="border-b bg-destructive/10 px-3 py-1 text-xs text-red-700">
          commit failed: {commitError}
        </p>
      )}
      <DeletedTasksStrip deletedChanges={deletedChanges} onRestore={board.revertTask} />
      {!board.ready ? (
        <p className="p-6 text-sm text-muted-foreground">Loading workspace…</p>
      ) : (
        <Board
          projection={projection}
          taskChangeByPath={board.changes}
          presenceByPath={new Map()}
          recentByPath={new Map()}
          onMove={moveTask}
          onAdd={addTask}
          onOpen={(path) => patchSearch({ task: path })}
        />
      )}
      <StreamEventsSheet
        open={eventsOpen}
        streamPath={`/workspaces/tasks/${checkoutId}~${repoPath.replace(/^\/+/, "").replaceAll("/", "--")}`}
        subscribe={board.subscribeEvents}
        onClose={() => setEventsOpen(false)}
      />
      <WorkspaceTaskSheet
        task={openTask}
        checkoutId={checkoutId}
        repoPath={repoPath}
        columns={columns}
        allTags={allTags}
        changeStatus={openTask === null ? undefined : board.changes.get(openTask.path)}
        onLiveContent={board.reflectLiveContent}
        onChangeState={(state) => {
          if (openTask === null) return;
          if (!applyLive(openTask.path, (current) => setTaskCardState(current, state)))
            board.writeTask(openTask.path, setTaskCardState(sourceOf(openTask), state));
        }}
        onChangeLabels={(labels) => {
          if (openTask === null) return;
          if (!applyLive(openTask.path, (current) => setTaskCardLabels(current, labels)))
            board.writeTask(openTask.path, setTaskCardLabels(sourceOf(openTask), labels));
        }}
        onRename={(nextPath) => (openTask === null ? null : renameTask(openTask, nextPath))}
        editorApiRef={editorApiRef}
        focusHeadline={
          openTask !== null && openTask.path === draftPath
            ? renamedDraftRef.current
              ? "end"
              : "select"
            : undefined
        }
        onRevert={() => {
          if (openTask !== null) board.revertTask(openTask.path);
        }}
        onDelete={() => {
          if (openTask !== null) {
            board.deleteTask(openTask.path);
            patchSearch({ task: "" });
          }
        }}
        onClose={() => patchSearch({ task: "" })}
      />
    </>
  );
}
