import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { GitCommitVerticalIcon, ListFilterIcon, Rows3Icon } from "lucide-react";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { Board } from "../components/board.tsx";
import { WorkspaceTaskSheet } from "../components/workspace-task-sheet.tsx";
import { useWorkspaceBoard } from "../lib/use-workspace-board.ts";
import { DEFAULT_REPO_PATH, normalizeRepoPath } from "../lib/checkout-shared.ts";
import { columnsForTasks, newTaskFile, setTaskCardState, taskColumnState } from "../tasks-model.ts";
import type { BoardTask } from "../lib/board-model.ts";

/**
 * The tasks board on the WORKSPACE mechanism — same dialect as the Yjs
 * checkout board (folder swimlanes, drag between states, right-sheet detail,
 * deep links), but every read and write is the platform workspace: the
 * overlay is the diff, commits are workspace commits, the detail editor is
 * the live rebase-model collab session with redlines.
 *   /w/<checkoutId>?repo=/repos/config&task=<path>&q=<filter>&group=none
 */
export const Route = createFileRoute("/w/$checkoutId")({
  validateSearch: (search: Record<string, unknown>) => ({
    group: search.group === "none" ? ("none" as const) : ("folder" as const),
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
  const [committing, setCommitting] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");

  const patchSearch = useCallback(
    (patch: Partial<typeof search>) =>
      void navigate({ replace: true, search: (current) => ({ ...current, ...patch }) }),
    [navigate],
  );

  const filtered = useMemo(() => {
    const query = search.q.trim().toLowerCase();
    if (query === "") return board.tasks;
    return board.tasks.filter(
      (task) =>
        task.title.toLowerCase().includes(query) ||
        task.path.toLowerCase().includes(query) ||
        task.labels.some((label) => label.toLowerCase().includes(query)),
    );
  }, [board.tasks, search.q]);

  const columns = useMemo(
    () => columnsForTasks(board.tasks).map((column) => column.state),
    [board.tasks],
  );
  const openTask = useMemo(
    () => board.tasks.find((task) => task.path === search.task) ?? null,
    [board.tasks, search.task],
  );
  const dirtyCount = board.changes.size;

  const moveTask = useCallback(
    (task: BoardTask, state: string, folder: string) => {
      const restated =
        taskColumnState(task.state) === state ? task.source : setTaskCardState(task.source, state);
      if (folder === task.folder) {
        board.writeTask(task.path, restated);
        return;
      }
      // A folder move is a rename: same content lands at the new path, the
      // old file is deleted — both through the ordinary workspace writes.
      const name = task.path.split("/").at(-1)!;
      const prefix = task.path.slice(0, task.path.indexOf("tasks/") + "tasks/".length);
      const nextPath = folder === "/" ? `${prefix}${name}` : `${prefix}${folder}/${name}`;
      board.writeTask(nextPath, restated);
      board.deleteTask(task.path);
      if (search.task === task.path) patchSearch({ task: nextPath });
    },
    [board, patchSearch, search.task],
  );

  const addTask = useCallback(
    (state: string, folder: string | null) => {
      const file = newTaskFile({ state, title: "New task" });
      const target =
        folder === null || folder === "/"
          ? `tasks/${file.path.split("/").at(-1)!}`
          : `tasks/${folder}/${file.path.split("/").at(-1)!}`;
      board.writeTask(target, file.content);
      patchSearch({ task: target });
    },
    [board, patchSearch],
  );

  const makeCommit = useCallback(async () => {
    setCommitting(true);
    try {
      await board.commit(commitMessage.trim() || `Update ${dirtyCount} task file(s)`);
      setCommitMessage("");
    } finally {
      setCommitting(false);
    }
  }, [board, commitMessage, dirtyCount]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <span className="font-mono text-sm text-muted-foreground">
          {repoPath} <span className="text-foreground">›</span>{" "}
          <span className="font-semibold text-foreground">{checkoutId}</span>{" "}
          <span className="text-xs">(workspace)</span>
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="relative hidden sm:block">
            <ListFilterIcon className="pointer-events-none absolute top-2 left-2 size-4 text-muted-foreground" />
            <Input
              value={search.q}
              onChange={(event) => patchSearch({ q: event.target.value })}
              placeholder="Filter"
              className="h-8 w-44 pl-7"
            />
          </div>
          <Button
            variant={search.group === "folder" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => patchSearch({ group: search.group === "folder" ? "none" : "folder" })}
          >
            <Rows3Icon className="size-4" /> Group
          </Button>
          <Input
            value={commitMessage}
            onChange={(event) => setCommitMessage(event.target.value)}
            placeholder={dirtyCount === 0 ? "Nothing to commit" : `Commit ${dirtyCount} change(s)…`}
            className="h-8 w-52"
            disabled={dirtyCount === 0}
          />
          <Button size="sm" disabled={dirtyCount === 0 || committing} onClick={() => void makeCommit()}>
            <GitCommitVerticalIcon className="size-4" />
            {committing ? "Committing…" : "Commit"}
          </Button>
        </div>
      </header>
      {board.error !== null && (
        <p className="border-b bg-destructive/10 px-3 py-1 text-xs text-red-700">{board.error}</p>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {!board.ready ? (
          <p className="p-6 text-sm text-muted-foreground">Loading workspace…</p>
        ) : (
          <Board
            tasks={filtered}
            rowField={search.group === "folder" ? "folder" : null}
            taskChangeByPath={board.changes}
            presenceByPath={new Map()}
            recentByPath={new Map()}
            onMove={moveTask}
            onAdd={addTask}
            onOpen={(path) => patchSearch({ task: path })}
          />
        )}
      </div>
      <WorkspaceTaskSheet
        task={openTask}
        checkoutId={checkoutId}
        repoPath={repoPath}
        columns={columns}
        changeStatus={openTask === null ? undefined : board.changes.get(openTask.path)}
        onLiveContent={board.reflectLiveContent}
        onChangeState={(state) => {
          if (openTask !== null) board.writeTask(openTask.path, setTaskCardState(openTask.source, state));
        }}
        onDelete={() => {
          if (openTask !== null) {
            board.deleteTask(openTask.path);
            patchSearch({ task: "" });
          }
        }}
        onClose={() => patchSearch({ task: "" })}
      />
    </div>
  );
}
