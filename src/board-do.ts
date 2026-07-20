import { DurableObject } from "cloudflare:workers";
import { RpcTarget, newWebSocketRpcSession, newWorkersRpcResponse } from "capnweb";
import type { RpcStub } from "capnweb";
import { LiveState, LiveStateRpcTarget } from "iterate/live-state";
import type { Project, UnauthenticatedOs } from "iterate/client";
import type { BoardApi, BoardState, TaskCard } from "./state.ts";
import {
  fallbackCommitMessage,
  newTaskFile,
  parseTaskCard,
  setTaskCardState,
  taskPathForTitle,
} from "./tasks-model.ts";

/** Worker + DO bindings. No secrets — auth is the per-connection session token. */
export type AppEnv = {
  BOARD: DurableObjectNamespace;
  OS_BASE_URL: string;
};

const CONFIG_REPO = "/repos/config";
const POLL_INTERVAL_MS = 30_000;
const PROJECT_ID_HEADER = "x-itx-project-id";
const AUTH_COOKIE = "iterate-project-auth";

/**
 * One board = one Durable Object, named by the project id stamped by the
 * project's reverse proxy. Entirely ephemeral: no DO storage, no pairing,
 * no long-lived credentials. Each accepted `/api/board` WebSocket carries
 * its own short-lived `iterate-project-auth` token; the session dials
 * `${OS_BASE_URL}/api` as that user (`project-app-session`), reads/writes
 * tasks/ markdown in /repos/config via listTaskFiles / commitFiles, and
 * pushes a shared in-memory LiveState to every connected browser.
 */
export class TasksBoardDurableObject extends DurableObject<AppEnv> {
  #live: LiveState<BoardState>;
  /** Live browser sessions — the alarm poll borrows a stub from one of these. */
  #sessions = new Set<BoardSession>();

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    this.#live = new LiveState<BoardState>({
      status: "connecting",
      error: null,
      projectId: null,
      commitOid: null,
      tasks: [],
    });
  }

  #patch(partial: Partial<BoardState>): void {
    this.#live.setState({ ...this.#live.getState(), ...partial });
  }

  registerSession(session: BoardSession): void {
    this.#sessions.add(session);
    // Arm (or re-arm) the poll whenever someone is connected.
    void this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
  }

  unregisterSession(session: BoardSession): void {
    this.#sessions.delete(session);
  }

  /**
   * Re-read tasks via the CALLING session's project stub and push the shared
   * LiveState. Commits from any session land here too so every browser
   * repaints from one source of truth.
   */
  async refresh(project: RpcStub<Project>, projectId: string): Promise<void> {
    try {
      const listing = (await project.repos.get(CONFIG_REPO).listTaskFiles()) as {
        commitOid: string;
        files: Record<string, string>;
      };
      const tasks = Object.entries(listing.files)
        .map(([path, source]) => parseTaskCard(path, source))
        .sort((a, b) => a.path.localeCompare(b.path));
      this.#patch({
        status: "ready",
        error: null,
        projectId,
        commitOid: listing.commitOid,
        tasks,
      });
    } catch (error) {
      this.#patch({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        projectId,
      });
    }
  }

  async commit(
    project: RpcStub<Project>,
    projectId: string,
    message: string,
    changes: Array<{ path: string; content: string } | { path: string; delete: true }>,
  ): Promise<void> {
    await project.repos.get(CONFIG_REPO).commitFiles({ message, changes });
    await this.refresh(project, projectId);
  }

  #tasks(): TaskCard[] {
    return this.#live.getState().tasks;
  }

  async addTask(
    project: RpcStub<Project>,
    projectId: string,
    input: { title: string; body?: string; state?: string },
  ): Promise<{ path: string }> {
    const title = input.title.trim();
    if (!title) throw new Error("a task needs a title");
    const existing = new Set(this.#tasks().map((task) => task.path));
    let file = newTaskFile({ title, body: input.body, state: input.state });
    for (let suffix = 2; existing.has(file.path); suffix++) {
      file = { ...file, path: taskPathForTitle(title, `${suffix}`) };
    }
    await this.commit(project, projectId, fallbackCommitMessage([{ path: file.path, kind: "add" }]), [
      { path: file.path, content: file.content },
    ]);
    return { path: file.path };
  }

  async moveTask(
    project: RpcStub<Project>,
    projectId: string,
    input: { path: string; state: string },
  ): Promise<void> {
    const task = this.#tasks().find((candidate) => candidate.path === input.path);
    if (!task) throw new Error(`no task at ${input.path}`);
    if (task.state === input.state) return;
    await this.commit(project, projectId, fallbackCommitMessage([{ path: input.path, kind: "update" }]), [
      { path: input.path, content: setTaskCardState(task.source, input.state) },
    ]);
  }

  async updateTask(
    project: RpcStub<Project>,
    projectId: string,
    input: { path: string; source: string },
  ): Promise<void> {
    await this.commit(project, projectId, fallbackCommitMessage([{ path: input.path, kind: "update" }]), [
      { path: input.path, content: input.source },
    ]);
  }

  async deleteTask(
    project: RpcStub<Project>,
    projectId: string,
    input: { path: string },
  ): Promise<void> {
    await this.commit(project, projectId, fallbackCommitMessage([{ path: input.path, kind: "delete" }]), [
      { path: input.path, delete: true },
    ]);
  }

  liveState(): LiveStateRpcTarget<BoardState> {
    return new LiveStateRpcTarget(this.#live);
  }

  /** 30s poll: borrow any live session's project stub; skip when nobody is connected. */
  async alarm(): Promise<void> {
    const session = this.#sessions.values().next().value as BoardSession | undefined;
    if (!session) return;
    try {
      await session.pollRefresh();
    } catch {
      // A dead session will unregister on dispose; keep the alarm loop alive
      // for anyone still connected.
    }
    if (this.#sessions.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api/board") {
      return new Response("not found", { status: 404 });
    }

    // Trusted headers from the project's reverse proxy (not from the browser
    // directly). Token rides as the iterate-project-auth cookie the platform
    // already set on the project host.
    const projectId = request.headers.get(PROJECT_ID_HEADER);
    const token = readCookie(request, AUTH_COOKIE);
    if (!projectId || !token) {
      return new Response("missing project id or session token", { status: 403 });
    }

    return newWorkersRpcResponse(
      request,
      new BoardSession(this, this.env.OS_BASE_URL, projectId, token),
    );
  }
}

/**
 * What one proxied browser connection holds: its own os dial (authenticated
 * as that user via project-app-session) plus the shared live-state surface.
 * Commits go out on THIS session's stub so attribution sticks to the user.
 */
class BoardSession extends RpcTarget implements BoardApi {
  #project: RpcStub<Project> | null = null;
  #osSocket: WebSocket | null = null;
  /** Cap'n Web session stub for the os dial — only used to dispose. */
  #osSession: { [Symbol.dispose]?: () => void } | null = null;
  #disposed = false;

  constructor(
    private readonly board: TasksBoardDurableObject,
    private readonly osBaseUrl: string,
    private readonly projectId: string,
    private readonly token: string,
  ) {
    super();
    this.board.registerSession(this);
    // Kick the first listTaskFiles so the shared board leaves "connecting".
    void this.refresh();
  }

  /**
   * Dial the platform as the connected user. The upgrade is a plain
   * fetch-with-Upgrade (the workerd-native way to open a client WebSocket);
   * authenticate and projects.get pipeline over the fresh socket without
   * waiting a round trip.
   */
  async #openProject(): Promise<RpcStub<Project>> {
    this.#closeOs();
    const response = await fetch(new URL("/api", this.osBaseUrl).toString(), {
      headers: { upgrade: "websocket" },
    });
    const socket = response.webSocket;
    if (!socket) {
      throw new Error(`os /api did not upgrade: ${response.status}`);
    }
    socket.accept();
    this.#osSocket = socket as unknown as WebSocket;
    const os = newWebSocketRpcSession<UnauthenticatedOs>(socket as unknown as WebSocket);
    this.#osSession = os as { [Symbol.dispose]?: () => void };
    // project-app-session: short-lived token the platform's project host
    // already verified for this user. The published ItxAuthCredentials type
    // may lag the platform — hence the cast (same pattern as project-secret).
    const session = os.authenticate({
      type: "project-app-session",
      token: this.token,
    } as never);
    return session.projects.get(this.projectId) as unknown as RpcStub<Project>;
  }

  /** Run an itx operation, redialing once if the cached session went stale. */
  async #withProject<T>(operation: (project: RpcStub<Project>) => Promise<T>): Promise<T> {
    if (this.#disposed) throw new Error("session closed");
    if (!this.#project) this.#project = await this.#openProject();
    try {
      return await operation(this.#project);
    } catch (firstError) {
      this.#project = await this.#openProject();
      try {
        return await operation(this.#project);
      } catch (secondError) {
        this.#project = null;
        throw secondError ?? firstError;
      }
    }
  }

  /** Alarm helper: refresh via this session's stub without exposing #withProject. */
  pollRefresh(): Promise<void> {
    return this.refresh();
  }

  #closeOs(): void {
    try {
      this.#osSession?.[Symbol.dispose]?.();
    } catch {
      // ignore dispose races on a half-open socket
    }
    try {
      this.#osSocket?.close();
    } catch {
      // ignore
    }
    this.#osSocket = null;
    this.#osSession = null;
    this.#project = null;
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.board.unregisterSession(this);
    this.#closeOs();
  }

  get liveState(): LiveStateRpcTarget<BoardState> {
    return this.board.liveState();
  }

  addTask(input: { title: string; body?: string; state?: string }): Promise<{ path: string }> {
    return this.#withProject((project) => this.board.addTask(project, this.projectId, input));
  }

  moveTask(input: { path: string; state: string }): Promise<void> {
    return this.#withProject((project) => this.board.moveTask(project, this.projectId, input));
  }

  updateTask(input: { path: string; source: string }): Promise<void> {
    return this.#withProject((project) => this.board.updateTask(project, this.projectId, input));
  }

  deleteTask(input: { path: string }): Promise<void> {
    return this.#withProject((project) => this.board.deleteTask(project, this.projectId, input));
  }

  refresh(): Promise<void> {
    return this.#withProject((project) => this.board.refresh(project, this.projectId));
  }
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}
