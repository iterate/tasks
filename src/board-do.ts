import { DurableObject } from "cloudflare:workers";
import { RpcTarget, newWebSocketRpcSession, newWorkersRpcResponse } from "capnweb";
import type { RpcStub } from "capnweb";
import { LiveState, LiveStateRpcTarget } from "iterate/live-state";
import type { Project, UnauthenticatedOs } from "iterate/client";
import type { BoardApi, BoardState, CapabilityApi, TaskCard } from "./state.ts";
import {
  fallbackCommitMessage,
  newTaskFile,
  parseTaskCard,
  setTaskCardState,
  taskPathForTitle,
} from "./tasks-model.ts";
import type { AppEnv } from "./session.ts";

const CONFIG_REPO = "/repos/config";
const POLL_INTERVAL_MS = 30_000;

/**
 * What pairing stores, once, per board: the project's API key (revealed by a
 * human from /secrets/project-api-key and pasted into the pairing form) and a
 * minted capability key the PLATFORM must present when it dials back in
 * through an itx `remoteCapability` mount. The API key never goes back out to
 * a browser; the capability key is shown once on the board page so a human
 * can finish the outbound mount.
 */
type Pairing = {
  projectId: string;
  apiKey: string;
  capabilityKey: string;
  pairedBy: string;
  pairedAt: string;
};

/**
 * One board = one Durable Object, named by the project ref in the URL. It is
 * both ends of the mutual-auth loop from docs/remote-apps.md in the iterate
 * repo: INBOUND it connects to `${OS_BASE_URL}/api` as the project (
 * project-secret credential, verified inside the platform's secret system)
 * and reads/writes tasks/ markdown in /repos/config via listTaskFiles /
 * commitFiles; OUTBOUND it serves two Cap'n Web doors — signed-in browsers on
 * /api/board/* (cookie checked by the worker) and the platform itself on
 * /capability/* (bearer capability key checked here).
 */
export class TasksBoardDurableObject extends DurableObject<AppEnv> {
  #pairing: Pairing | null = null;
  #live: LiveState<BoardState>;
  /** Cached authenticated project stub; dropped and redialed on any failure. */
  #project: RpcStub<Project> | null = null;

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    this.#live = new LiveState<BoardState>({
      status: "connecting",
      error: null,
      projectId: null,
      commitOid: null,
      tasks: [],
    });
    void ctx.blockConcurrencyWhile(async () => {
      this.#pairing = (await ctx.storage.get<Pairing>("pairing")) ?? null;
      if (this.#pairing) {
        void this.#refresh();
        void this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
      } else {
        this.#patch({ status: "unpaired" });
      }
    });
  }

  #patch(partial: Partial<BoardState>): void {
    this.#live.setState({ ...this.#live.getState(), ...partial });
  }

  /**
   * Dial the platform as the paired project. The upgrade is a plain
   * fetch-with-Upgrade (the workerd-native way to open a client WebSocket);
   * authenticate and projects.get pipeline over the fresh socket without
   * waiting a round trip.
   */
  async #openProject(pairing: Pairing): Promise<RpcStub<Project>> {
    const response = await fetch(new URL("/api", this.env.OS_BASE_URL).toString(), {
      headers: { upgrade: "websocket" },
    });
    const socket = response.webSocket;
    if (!socket) {
      throw new Error(`os /api did not upgrade: ${response.status}`);
    }
    socket.accept();
    const os = newWebSocketRpcSession<UnauthenticatedOs>(socket as unknown as WebSocket);
    // project-secret: verified inside the project's secret Durable Object on
    // the platform side; grants exactly this one project. The published
    // ItxAuthCredentials type may lag the platform — hence the cast.
    const session = os.authenticate({
      type: "project-secret",
      projectId: pairing.projectId,
      secret: pairing.apiKey,
    } as never);
    return session.projects.get(pairing.projectId) as unknown as RpcStub<Project>;
  }

  /** Run an itx operation, redialing once if the cached session went stale. */
  async #withProject<T>(operation: (project: RpcStub<Project>) => Promise<T>): Promise<T> {
    const pairing = this.#pairing;
    if (!pairing) throw new Error("this board is not paired with a project yet");
    if (!this.#project) this.#project = await this.#openProject(pairing);
    try {
      return await operation(this.#project);
    } catch (firstError) {
      this.#project = await this.#openProject(pairing);
      try {
        return await operation(this.#project);
      } catch (secondError) {
        this.#project = null;
        throw secondError ?? firstError;
      }
    }
  }

  async #refresh(): Promise<void> {
    const pairing = this.#pairing;
    if (!pairing) {
      this.#patch({ status: "unpaired", projectId: null, commitOid: null, tasks: [] });
      return;
    }
    try {
      const listing = await this.#withProject(
        (project) =>
          project.repos.get(CONFIG_REPO).listTaskFiles() as Promise<{
            commitOid: string;
            files: Record<string, string>;
          }>,
      );
      const tasks = Object.entries(listing.files)
        .map(([path, source]) => parseTaskCard(path, source))
        .sort((a, b) => a.path.localeCompare(b.path));
      this.#patch({
        status: "ready",
        error: null,
        projectId: pairing.projectId,
        commitOid: listing.commitOid,
        tasks,
      });
    } catch (error) {
      this.#patch({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #commit(
    message: string,
    changes: Array<{ path: string; content: string } | { path: string; delete: true }>,
  ): Promise<void> {
    await this.#withProject((project) =>
      project.repos.get(CONFIG_REPO).commitFiles({ message, changes }),
    );
    await this.#refresh();
  }

  #tasks(): TaskCard[] {
    return this.#live.getState().tasks;
  }

  async alarm(): Promise<void> {
    if (this.#pairing) {
      await this.#refresh();
      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    }
  }

  // ---- verbs shared by the browser session and the platform capability ----

  async addTask(input: { title: string; body?: string; state?: string }): Promise<{ path: string }> {
    const title = input.title.trim();
    if (!title) throw new Error("a task needs a title");
    const existing = new Set(this.#tasks().map((task) => task.path));
    let file = newTaskFile({ title, body: input.body, state: input.state });
    for (let suffix = 2; existing.has(file.path); suffix++) {
      file = { ...file, path: taskPathForTitle(title, `${suffix}`) };
    }
    await this.#commit(fallbackCommitMessage([{ path: file.path, kind: "add" }]), [
      { path: file.path, content: file.content },
    ]);
    return { path: file.path };
  }

  async moveTask(input: { path: string; state: string }): Promise<void> {
    const task = this.#tasks().find((candidate) => candidate.path === input.path);
    if (!task) throw new Error(`no task at ${input.path}`);
    if (task.state === input.state) return;
    await this.#commit(fallbackCommitMessage([{ path: input.path, kind: "update" }]), [
      { path: input.path, content: setTaskCardState(task.source, input.state) },
    ]);
  }

  async updateTask(input: { path: string; source: string }): Promise<void> {
    await this.#commit(fallbackCommitMessage([{ path: input.path, kind: "update" }]), [
      { path: input.path, content: input.source },
    ]);
  }

  async deleteTask(input: { path: string }): Promise<void> {
    await this.#commit(fallbackCommitMessage([{ path: input.path, kind: "delete" }]), [
      { path: input.path, delete: true },
    ]);
  }

  async refresh(): Promise<void> {
    await this.#refresh();
  }

  liveState(): LiveStateRpcTarget<BoardState> {
    return new LiveStateRpcTarget(this.#live);
  }

  boardState(): BoardState {
    return this.#live.getState();
  }

  capabilityKey(): string | null {
    return this.#pairing?.capabilityKey ?? null;
  }

  /** Verify-then-store: the key must actually open the project before we keep it. */
  async #pair(input: { projectId: string; apiKey: string; pairedBy: string }): Promise<void> {
    const probe: Pairing = {
      projectId: input.projectId.trim(),
      apiKey: input.apiKey.trim(),
      capabilityKey: crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""),
      pairedBy: input.pairedBy,
      pairedAt: new Date().toISOString(),
    };
    if (!probe.projectId.startsWith("prj_")) throw new Error("projectId should look like prj_…");
    if (!probe.apiKey) throw new Error("apiKey is required");
    // Prove both halves before storing: the credential authenticates AND the
    // config repo answers a read.
    const previous = this.#pairing;
    this.#pairing = probe;
    this.#project = null;
    try {
      await this.#withProject((project) => project.repos.get(CONFIG_REPO).listTaskFiles());
    } catch (error) {
      this.#pairing = previous;
      this.#project = null;
      throw new Error(
        `pairing check failed (wrong key, wrong project id, or the platform is unreachable): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    await this.ctx.storage.put("pairing", probe);
    await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    await this.#refresh();
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/board/")) {
      // The worker already verified the user's session cookie.
      return newWorkersRpcResponse(request, new BoardSession(this));
    }

    if (url.pathname.startsWith("/api/pair/") && request.method === "POST") {
      const pairedBy = request.headers.get("x-tasks-user") ?? "unknown";
      const body = (await request.json()) as { projectId?: string; apiKey?: string };
      try {
        await this.#pair({
          projectId: body.projectId ?? "",
          apiKey: body.apiKey ?? "",
          pairedBy,
        });
      } catch (error) {
        return new Response(error instanceof Error ? error.message : String(error), { status: 400 });
      }
      return Response.json({ ok: true, capabilityKey: this.#pairing?.capabilityKey });
    }

    if (url.pathname.startsWith("/api/capability-key/")) {
      // Signed-in humans only (worker gate) — shown on the board page so the
      // outbound remoteCapability mount can be completed.
      return Response.json({ capabilityKey: this.capabilityKey() });
    }

    if (url.pathname.startsWith("/capability/")) {
      const expected = this.#pairing?.capabilityKey;
      const presented = request.headers.get("authorization");
      if (!expected || presented !== `Bearer ${expected}`) {
        return new Response("missing or invalid capability credential", { status: 401 });
      }
      return newWorkersRpcResponse(request, new PlatformCapability(this));
    }

    return new Response("not found", { status: 404 });
  }
}

/** What one signed-in browser holds: live state + the whole write surface. */
class BoardSession extends RpcTarget implements BoardApi {
  constructor(private readonly board: TasksBoardDurableObject) {
    super();
  }

  get liveState(): LiveStateRpcTarget<BoardState> {
    return this.board.liveState();
  }

  addTask(input: { title: string; body?: string; state?: string }): Promise<{ path: string }> {
    return this.board.addTask(input);
  }

  moveTask(input: { path: string; state: string }): Promise<void> {
    return this.board.moveTask(input);
  }

  updateTask(input: { path: string; source: string }): Promise<void> {
    return this.board.updateTask(input);
  }

  deleteTask(input: { path: string }): Promise<void> {
    return this.board.deleteTask(input);
  }

  refresh(): Promise<void> {
    return this.board.refresh();
  }
}

/** What the PLATFORM holds through an itx remoteCapability mount: small on purpose. */
class PlatformCapability extends RpcTarget implements CapabilityApi {
  constructor(private readonly board: TasksBoardDurableObject) {
    super();
  }

  add(title: string, body?: string): Promise<{ path: string }> {
    return this.board.addTask({ title, body });
  }

  async list(): Promise<Array<{ path: string; title: string; state: string }>> {
    await this.board.refresh();
    return this.board
      .boardState()
      .tasks.map((task) => ({ path: task.path, title: task.title, state: task.state }));
  }
}
