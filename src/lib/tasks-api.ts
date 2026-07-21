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

/** One known checkout, as remembered by the project's index DO. */
export type CheckoutIndexEntry = {
  repoPath: string;
  checkoutId: string;
  createdAt: number;
  lastSeenAt: number;
  lastCommit: string | null;
};

/**
 * Who this session is, as far as the platform can prove it. userId comes
 * from the verified project-app-session claims; email/name appear once the
 * auth worker mints them into the token (absent claims stay null). The
 * machine lane (project-secret) has no user at all.
 */
export type TasksUser = {
  userId: string | null;
  email: string | null;
  name: string | null;
  /** Avatar URL, once the auth worker mints an `image` claim. */
  image: string | null;
};

export interface TasksProject {
  projectId(): Promise<string>;
  /** The verified identity behind this session's credential. */
  whoami(): Promise<TasksUser>;
  /** The project's repo catalog — paths a checkout can be opened against. */
  repos(): Promise<string[]>;
  /** Every checkout anyone has opened, newest activity first (the sidebar). */
  checkouts(): Promise<CheckoutIndexEntry[]>;
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
  /**
   * Assign an agent to one task, the apps/os way: sets `state: in-progress`
   * + the `agent:` frontmatter, commits the checkout so the assignment is
   * durable, births the agent if needed, and sends it the kickoff brief.
   */
  assignAgent(path: string): Promise<{ agentPath: string }>;
}
