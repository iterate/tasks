import type { LiveStateRpc } from "iterate/live-state";

/**
 * One task card, parsed from a markdown file under tasks/ in the project's
 * /repos/config repo (frontmatter `state`/`labels`/`agent` plus title and
 * body). `path` is the repo-relative file path and doubles as the card id.
 */
export type TaskCard = {
  path: string;
  title: string;
  /** Canonical column: "todo" | "in-progress" | "in-review" | "done" (or a custom literal). */
  state: string;
  labels: string[];
  agent: string | null;
  /** Full markdown source of the file (frontmatter included) for the detail editor. */
  source: string;
};

/** The canonical Kanban columns, in board order. Custom states get their own column after these. */
export const BOARD_COLUMNS = ["todo", "in-progress", "in-review", "done"] as const;

/** The whole board — the live-state value every connected browser mirrors. */
export type BoardState = {
  /** "connecting" until the first successful listTaskFiles; "ready" once tasks are loaded. */
  status: "connecting" | "ready" | "error";
  /** Human-readable failure when status is "error" (bad token, unreachable os, …). */
  error: string | null;
  projectId: string | null;
  /** HEAD commit the current tasks were read at. */
  commitOid: string | null;
  tasks: TaskCard[];
};

/** One repo file mutation — the wire shape `commitFiles` takes. */
export type RepoFileChange =
  | { path: string; content: string }
  | {
      path: string;
      /** Standard base64 of the file's raw bytes — the binary write lane. */
      contentBase64: string;
    }
  | { path: string; delete: true };

/** Uncommitted board status for a changed task path (working or staged). */
export type TaskChangeStatus = "added" | "modified" | "deleted";

/** What the commit UI (and the AI message generator) knows about one change. */
export type TaskChangeSummary = { path: string; status: TaskChangeStatus; title: string };

/** What one `commitFiles` batch reported back. */
export type CommitResult = {
  branch: string;
  changedPaths: string[];
  commitOid: string;
  noChanges: boolean;
};

/**
 * The Cap'n Web capability a browser holds after connecting to a board's
 * Durable Object: read side is live state (snapshot + patches) carrying the
 * HEAD checkout of tasks/; write side is one batched `commitChanges` — the
 * browser models its own git-shaped working tree (src/lib/working-tree.ts)
 * and flushes it as a single commit to the project's /repos/config through
 * the platform's itx /api, attributed to the calling session's user.
 * Shared by the server session (board-do.ts) and the client hook (lib/use-board.ts).
 */
export type BoardApi = {
  liveState: LiveStateRpc<BoardState>;
  /** One git commit of accumulated task-file changes as the calling user. */
  commitChanges(input: { message: string; changes: RepoFileChange[] }): Promise<CommitResult>;
  /** AI one-liner for the pending change set (falls back deterministically). */
  generateCommitMessage(input: { changes: TaskChangeSummary[] }): Promise<string>;
  /** Re-read tasks from the repo HEAD now (also runs on a poll alarm). */
  refresh(): Promise<void>;
};
