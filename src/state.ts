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

/**
 * The Cap'n Web capability a browser holds after connecting to a board's
 * Durable Object: read side is live state (snapshot + patches), write side is
 * verbs that each become one `commitFiles` to the project's /repos/config
 * through the platform's itx /api — attributed to the calling session's user.
 * Shared by the server session (board-do.ts) and the client hook (lib/use-board.ts).
 */
export type BoardApi = {
  liveState: LiveStateRpc<BoardState>;
  /** Create tasks/<slug>.md with the given title/body; returns the new path. */
  addTask(input: { title: string; body?: string; state?: string }): Promise<{ path: string }>;
  /** Rewrite the card's frontmatter `state` (a column drag). */
  moveTask(input: { path: string; state: string }): Promise<void>;
  /** Replace the whole file source (detail editor save). */
  updateTask(input: { path: string; source: string }): Promise<void>;
  deleteTask(input: { path: string }): Promise<void>;
  /** Re-read tasks from the repo HEAD now (also runs on a poll alarm). */
  refresh(): Promise<void>;
};
