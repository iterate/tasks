import type { CommitResult, TaskChangeSummary } from "../state.ts";

/**
 * The vessel's ONE public API: a Cap'n Web WebSocket session at `/api`.
 * Everything that isn't Yjs binary sync speaks this vocabulary — the browser
 * UI, headless probes, and platform agents reaching in via a config worker's
 * `itx.worker.tasks` stub all hold the same capabilities over the same kind
 * of session.
 *
 * The server classes live in ../rpc-api.ts; clients consume these interfaces
 * through capnweb stubs, so a chain like
 * `api.authenticate(token).checkout(id).commit(msg)` pipelines into a single
 * round trip.
 */
/**
 * What a caller may authenticate with. A bare string is shorthand for a
 * project-app-session token (user-attributed — the browser lane and any
 * caller forwarding a user's cookie). `project-secret` is the machine lane:
 * a config worker can obtain its own project's API key
 * (`itx.secrets.get("/secrets/project-api-key").reveal()`) without any
 * browser in the loop, at the cost of project- rather than user-attribution.
 */
export type ProjectCredential =
  | { type: "project-app-session"; token: string }
  | { type: "project-secret"; projectId: string; secret: string };

export interface TasksApi {
  /**
   * Prove a credential by using it against the platform and get the
   * project-scoped API back. Omit it when the session's upgrade request
   * carried the `iterate-project-auth` cookie (the browser lane).
   */
  authenticate(credential?: string | ProjectCredential): Promise<TasksProject>;
}

export interface TasksProject {
  projectId(): Promise<string>;
  /** The project's repo catalog — paths a checkout can be opened against. */
  repos(): Promise<string[]>;
  /**
   * A capability on one collaborative checkout (creating it on first touch —
   * the underlying Durable Object seeds from the repo's HEAD task files).
   * Synchronous on purpose so calls pipeline through it.
   */
  checkout(checkoutId: string, repoPath?: string): TasksCheckout;
}

export type CheckoutSnapshot = {
  /** Commit the checkout's base was seeded from (or last committed to). */
  baseCommit: string;
  /** Live collaborative contents, path → markdown. */
  files: Record<string, string>;
};

export interface TasksCheckout {
  files(): Promise<CheckoutSnapshot>;
  read(path: string): Promise<string | null>;
  /**
   * Set a task file's full contents. Applied to the live Y.Doc as one
   * minimal splice, so concurrent human edits elsewhere in the file survive;
   * every connected browser sees it immediately.
   */
  write(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
  /** Uncommitted changes versus the base snapshot (A/M/D + titles). */
  changes(): Promise<TaskChangeSummary[]>;
  /** Flush the checkout's diff against base as one git commit. */
  commit(message: string): Promise<CommitResult>;
  /** AI one-liner for the current uncommitted change set. */
  generateMessage(): Promise<string>;
}
