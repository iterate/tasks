import { newWebSocketRpcSession } from "capnweb";
import type { RpcStub } from "capnweb";
import type { Project, UnauthenticatedOs } from "iterate/client";
import * as Y from "yjs";
import { YServer } from "y-partyserver";
import type { Connection, ConnectionContext } from "partyserver";
import type { AppEnv } from "./board-do.ts";
import type { CommitResult, TaskChangeSummary } from "./state.ts";
import {
  fallbackCommitMessage,
  isTaskFilePath,
  taskCommitMessagePrompt,
} from "./tasks-model.ts";
import {
  checkoutBaseCommit,
  checkoutBaseContents,
  checkoutFileContents,
  checkoutFilesMap,
  checkoutMetaMap,
  checkoutRepoChanges,
} from "./lib/checkout-shared.ts";

const CONFIG_REPO = "/repos/config";
const PROJECT_ID_HEADER = "x-itx-project-id";
const AUTH_COOKIE = "iterate-project-auth";
const TASK_COMMIT_MODEL = "openai/gpt-5.5";
const DOC_STORAGE_KEY = "doc";

/**
 * One collaborative checkout = one y-partyserver YServer Durable Object,
 * named `<projectId>:<checkoutId>`. The stock mixin does all the Yjs work —
 * y-protocols sync + awareness relay over `/api/checkout/<id>` WebSockets
 * (the standard y-websocket wire, so the stock provider and editor bindings
 * just work) plus a debounced `onSave`. This subclass only adds:
 *
 *  - `onLoad`/`onSave`: the shared doc persists as one update blob in DO
 *    storage (the y-partyserver README pattern).
 *  - `onConnect` auth + seeding: the vessel holds no secrets, so each join's
 *    proxy-stamped `iterate-project-auth` token is verified by USING it
 *    against `${OS_BASE_URL}/api`; the first successful join seeds the doc
 *    from the repo's task files at HEAD ("files": path → Y.Text, "meta":
 *    base commit + base contents).
 *  - `onRequest`: plain HTTP POSTs for git ops — `/commit` flushes the doc's
 *    diff against base as one commit (attributed to the poster's token),
 *    `/generate-message` asks the project's AI for a commit one-liner.
 */
export class TasksCheckoutDurableObject extends YServer {
  #env(): AppEnv {
    return this.env as unknown as AppEnv;
  }

  async onLoad(): Promise<void> {
    const stored = await this.ctx.storage.get<Uint8Array>(DOC_STORAGE_KEY);
    if (stored) Y.applyUpdate(this.document, stored);
  }

  async onSave(): Promise<void> {
    await this.ctx.storage.put(DOC_STORAGE_KEY, Y.encodeStateAsUpdate(this.document));
  }

  override async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    try {
      await this.#withDial(ctx.request, (dial) => this.#verifyAndSeed(dial));
    } catch (error) {
      connection.close(4403, `session rejected: ${errorText(error)}`.slice(0, 120));
      return;
    }
    super.onConnect(connection, ctx);
  }

  /** listTaskFiles both proves the token works and provides the seed. */
  async #verifyAndSeed(dial: ProjectDial): Promise<void> {
    const listing = (await dial.withProject((project) =>
      project.repos.get(CONFIG_REPO).listTaskFiles(),
    )) as { commitOid: string; files: Record<string, string> };
    // Re-check after the await: a racing join may have seeded already.
    if (checkoutBaseCommit(this.document) !== undefined) return;
    this.document.transact(() => {
      const files = checkoutFilesMap(this.document);
      for (const [path, content] of Object.entries(listing.files)) {
        if (!isTaskFilePath(path)) continue;
        files.set(path, new Y.Text(content));
      }
      const meta = checkoutMetaMap(this.document);
      meta.set("baseCommit", listing.commitOid);
      meta.set("base", listing.files);
    });
  }

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const op = url.pathname.split("/").at(-1);
    if (request.method !== "POST" || (op !== "commit" && op !== "generate-message")) {
      return new Response("not found", { status: 404 });
    }
    try {
      const body = (await request.json()) as {
        message?: string;
        changes?: TaskChangeSummary[];
      };
      const result = await this.#withDial<CommitResult | string>(request, (dial) =>
        op === "commit"
          ? this.#commit(dial, body.message ?? "")
          : this.#generateCommitMessage(dial, body.changes ?? []),
      );
      return Response.json(result);
    } catch (error) {
      return new Response(errorText(error), { status: 500 });
    }
  }

  /**
   * One git commit of the checkout's diff against base, as the posting user.
   * The post-commit base rewrite uses the same pre-await file snapshot the
   * diff was computed from, so anything typed while the commit was in
   * flight stays visibly uncommitted — and the meta update syncs the new
   * base to every collaborator.
   */
  async #commit(dial: ProjectDial, message: string): Promise<CommitResult> {
    const trimmed = message.trim();
    if (!trimmed) throw new Error("a commit needs a message");
    const files = checkoutFileContents(this.document);
    const base = checkoutBaseContents(this.document);
    const changes = checkoutRepoChanges(files, base);
    if (changes.length === 0) {
      return {
        branch: "",
        changedPaths: [],
        commitOid: checkoutBaseCommit(this.document) ?? "",
        noChanges: true,
      };
    }
    for (const change of changes) {
      if (!isTaskFilePath(change.path)) {
        throw new Error(`${change.path} is not a task file — the checkout only commits tasks/ markdown`);
      }
    }
    const result = (await dial.withProject((project) =>
      project.repos.get(CONFIG_REPO).commitFiles({ message: trimmed, changes }),
    )) as CommitResult;
    this.document.transact(() => {
      const meta = checkoutMetaMap(this.document);
      meta.set("baseCommit", result.commitOid);
      meta.set("base", files);
    });
    await this.onSave();
    return result;
  }

  async #generateCommitMessage(dial: ProjectDial, changes: TaskChangeSummary[]): Promise<string> {
    const prompt = taskCommitMessagePrompt(changes);
    const result = (await dial.withProject((project) =>
      project.ai.run(TASK_COMMIT_MODEL, {
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
      }),
    )) as { response?: string };
    const generated = result.response?.trim().replace(/^["']|["']$/g, "");
    return generated ? generated.slice(0, 72) : fallbackCommitMessage(changes);
  }

  /** Per-operation platform dial from the request's own proxy-stamped auth. */
  async #withDial<T>(request: Request, operation: (dial: ProjectDial) => Promise<T>): Promise<T> {
    const projectId = request.headers.get(PROJECT_ID_HEADER);
    const token = readCookie(request, AUTH_COOKIE);
    if (!projectId || !token) throw new Error("missing project id or session token");
    const dial = new ProjectDial(this.#env().OS_BASE_URL, projectId, token);
    try {
      return await operation(dial);
    } finally {
      dial.close();
    }
  }
}

/**
 * A lazy dial to the platform as one user: opened on first use, redialed
 * once when a cached session goes stale mid-operation. Same
 * `project-app-session` handshake the board sessions use.
 */
class ProjectDial {
  #project: RpcStub<Project> | null = null;
  #socket: WebSocket | null = null;
  #session: { [Symbol.dispose]?: () => void } | null = null;
  #closed = false;

  constructor(
    private readonly osBaseUrl: string,
    private readonly projectId: string,
    private readonly token: string,
  ) {}

  async #open(): Promise<RpcStub<Project>> {
    this.#dispose();
    const response = await fetch(new URL("/api", this.osBaseUrl).toString(), {
      headers: { upgrade: "websocket" },
    });
    const socket = response.webSocket;
    if (!socket) throw new Error(`os /api did not upgrade: ${response.status}`);
    socket.accept();
    this.#socket = socket as unknown as WebSocket;
    const os = newWebSocketRpcSession<UnauthenticatedOs>(socket as unknown as WebSocket);
    this.#session = os as { [Symbol.dispose]?: () => void };
    const session = os.authenticate({
      type: "project-app-session",
      token: this.token,
    } as never);
    return session.projects.get(this.projectId) as unknown as RpcStub<Project>;
  }

  async withProject<T>(operation: (project: RpcStub<Project>) => Promise<T>): Promise<T> {
    if (this.#closed) throw new Error("connection closed");
    if (!this.#project) this.#project = await this.#open();
    try {
      return await operation(this.#project);
    } catch (firstError) {
      this.#project = await this.#open();
      try {
        return await operation(this.#project);
      } catch (secondError) {
        this.#project = null;
        throw secondError ?? firstError;
      }
    }
  }

  #dispose(): void {
    try {
      this.#session?.[Symbol.dispose]?.();
    } catch {
      // dispose races on a half-open socket are fine
    }
    try {
      this.#socket?.close();
    } catch {
      // ignore
    }
    this.#socket = null;
    this.#session = null;
    this.#project = null;
  }

  close(): void {
    this.#closed = true;
    this.#dispose();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}
