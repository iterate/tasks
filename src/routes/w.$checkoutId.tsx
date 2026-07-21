import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
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
import type { BoardTask, RowField } from "../lib/board-model.ts";
import { DEFAULT_REPO_PATH, normalizeRepoPath } from "../lib/checkout-shared.ts";
import {
  columnsForTasks,
  fallbackCommitMessage,
  newTaskFile,
  setTaskCardLabels,
  setTaskCardState,
  taskColumnState,
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
  const [autoCommit, setAutoCommit] = useState(true);
  const [eventsOpen, setEventsOpen] = useState(false);
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
      let source =
        taskColumnState(task.state) === state ? task.source : setTaskCardState(task.source, state);
      if (labels !== undefined) source = setTaskCardLabels(source, labels);
      if (folder === task.folder) {
        board.writeTask(task.path, source);
        return;
      }
      const name = task.path.split("/").at(-1)!;
      const prefix = task.path.slice(0, task.path.indexOf("tasks/") + "tasks/".length);
      const nextPath = folder === "/" ? `${prefix}${name}` : `${prefix}${folder}/${name}`;
      board.writeTask(nextPath, source);
      board.deleteTask(task.path);
      if (search.task === task.path) patchSearch({ task: nextPath });
    },
    [board, patchSearch, search.task],
  );

  const addTask = useCallback(
    (state: string, folder: string | null) => {
      const file = newTaskFile({ state, title: "New task" });
      const name = file.path.split("/").at(-1)!;
      const target = folder === null || folder === "/" ? `tasks/${name}` : `tasks/${folder}/${name}`;
      board.writeTask(target, file.content);
      patchSearch({ task: target });
    },
    [board, patchSearch],
  );

  return (
    <>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-background px-3">
        <SidebarTrigger className="-ml-1" />
        <CheckoutBreadcrumbs repoPath={repoPath} checkoutId={checkoutId} />
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <div className="hidden items-center gap-1.5 sm:flex">
            <WithTooltip label="Stream events">
              <Button variant="ghost" size="icon" onClick={() => setEventsOpen(true)}>
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
        loadEvents={board.loadEvents}
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
          if (openTask !== null)
            board.writeTask(openTask.path, setTaskCardState(openTask.source, state));
        }}
        onChangeLabels={(labels) => {
          if (openTask !== null)
            board.writeTask(openTask.path, setTaskCardLabels(openTask.source, labels));
        }}
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
