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
  /** "unpaired" until a project API key is stored; "ready" once tasks are loaded. */
  status: "unpaired" | "connecting" | "ready" | "error";
  /** Human-readable failure when status is "error" (bad key, unreachable os, …). */
  error: string | null;
  projectId: string | null;
  /** HEAD commit the current tasks were read at. */
  commitOid: string | null;
  tasks: TaskCard[];
};

/**
 * The Cap'n Web capability a signed-in browser holds after connecting to a
 * board's Durable Object: read side is live state (snapshot + patches), write
 * side is verbs that each become one `commitFiles` to the project's
 * /repos/config through the platform's itx /api. Shared by the server session
 * (board-do.ts) and the client hook (lib/use-board.ts).
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

/**
 * What the PLATFORM holds when this app is mounted as an itx capability
 * (`itx.tasks.…` via remoteCapability): a deliberately small verb surface.
 * Same Durable Object, different door — the platform's dial carries the
 * board's capability key as a bearer token, never a user cookie.
 */
export type CapabilityApi = {
  add(title: string, body?: string): Promise<{ path: string }>;
  list(): Promise<Array<{ path: string; title: string; state: string }>>;
};

/**
 * One project-ref grammar for everything: the home form, the /p/$project
 * page, and the worker's /api/board/<project> route all normalize with this.
 * Accepts a project id (prj_…) or slug.
 */
export function normalizeProjectRef(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 80);
}
