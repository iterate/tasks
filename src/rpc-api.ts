import { RpcTarget } from "capnweb";
import { getServerByName } from "partyserver";
import type { AppEnv } from "./board-do.ts";
import { ProjectDial, type TasksCheckoutDurableObject } from "./checkout-do.ts";
import type { TasksCheckoutIndexDurableObject } from "./checkout-index-do.ts";
import type { CommitResult, TaskChangeSummary } from "./state.ts";
import type {
  CheckoutIndexEntry,
  CheckoutSnapshot,
  ProjectCredential,
  TasksApi,
  TasksCheckout,
  TasksProject,
} from "./lib/tasks-api.ts";
import { DEFAULT_REPO_PATH, isCheckoutId, normalizeRepoPath } from "./lib/checkout-shared.ts";

const AUTH_COOKIE = "iterate-project-auth";

export type VesselEnv = AppEnv & {
  CHECKOUT: DurableObjectNamespace<TasksCheckoutDurableObject>;
  INDEX: DurableObjectNamespace<TasksCheckoutIndexDurableObject>;
};

/**
 * The checkout DO's plain-data RPC surface (native workerd RPC on the stub —
 * a capnweb stub is a Proxy and cannot cross this hop, so only strings and
 * JSON shapes do; per-user platform access travels as the token itself).
 */
type CheckoutStubOps = {
  ensureSeeded(credential: ProjectCredential, projectId: string, repoPath: string): Promise<void>;
  filesSnapshot(): Promise<CheckoutSnapshot>;
  readFile(path: string): Promise<string | null>;
  applyWrite(path: string, content: string | null): Promise<void>;
  changesSummary(): Promise<TaskChangeSummary[]>;
  commitDoc(
    credential: ProjectCredential,
    projectId: string,
    repoPath: string,
    message: string,
  ): Promise<CommitResult>;
  generateMessageDoc(credential: ProjectCredential, projectId: string): Promise<string>;
};

/**
 * The capability handed to every connection on `/api` — one method,
 * `authenticate`, which proves a project-app-session token by USING it
 * against the platform and returns the project-scoped API. Browsers rely on
 * the proxy-stamped cookie; agents and other services pass the token
 * explicitly. Either way the token's own projectId claim decides which
 * project this session is — the dial fails if the claim is a lie.
 */
export class TasksApiRoot extends RpcTarget implements TasksApi {
  readonly #env: VesselEnv;
  readonly #cookieToken: string | undefined;

  constructor(env: VesselEnv, request: Request) {
    super();
    this.#env = env;
    this.#cookieToken = readCookie(request, AUTH_COOKIE);
  }

  async authenticate(credential?: string | ProjectCredential): Promise<TasksProject> {
    const resolved = this.#resolve(credential);
    const projectId =
      resolved.type === "project-secret" ? resolved.projectId : projectIdClaim(resolved.token);
    const dial = new ProjectDial(this.#env.OS_BASE_URL, projectId, resolved);
    try {
      // Verify by use: the vessel keeps no secrets, so a cheap authenticated
      // read against the claimed project is the whole check.
      await dial.withProject((project) => project.repos.list());
    } catch (error) {
      dial.close();
      throw new Error(`authentication failed: ${errorText(error)}`);
    }
    return new TasksProjectApi(this.#env, dial, projectId, resolved);
  }

  #resolve(credential?: string | ProjectCredential): ProjectCredential {
    if (typeof credential === "string" && credential.trim() !== "") {
      return { type: "project-app-session", token: credential.trim() };
    }
    if (credential !== undefined && typeof credential === "object" && credential !== null) {
      if (credential.type === "project-app-session" && credential.token) return credential;
      if (credential.type === "project-secret" && credential.projectId && credential.secret) {
        return credential;
      }
      throw new Error("unsupported credential — expected project-app-session or project-secret");
    }
    if (this.#cookieToken) return { type: "project-app-session", token: this.#cookieToken };
    throw new Error(
      "no credential — pass authenticate(token | {type, ...}) or send the iterate-project-auth cookie",
    );
  }
}

export class TasksProjectApi extends RpcTarget implements TasksProject {
  readonly #env: VesselEnv;
  readonly #dial: ProjectDial;
  readonly #projectId: string;
  readonly #credential: ProjectCredential;

  constructor(env: VesselEnv, dial: ProjectDial, projectId: string, credential: ProjectCredential) {
    super();
    this.#env = env;
    this.#dial = dial;
    this.#projectId = projectId;
    this.#credential = credential;
  }

  async projectId(): Promise<string> {
    return this.#projectId;
  }

  async repos(): Promise<string[]> {
    const repos = (await this.#dial.withProject((project) => project.repos.list())) as Array<{
      path: string;
    }>;
    return repos.map((repo) => repo.path).sort();
  }

  async checkouts(): Promise<CheckoutIndexEntry[]> {
    return this.#env.INDEX.getByName(this.#projectId).list();
  }

  checkout(checkoutId: string, repoPath: string = DEFAULT_REPO_PATH): TasksCheckout {
    const normalized = normalizeRepoPath(repoPath);
    if (!isCheckoutId(checkoutId) || normalized === null) {
      throw new Error("bad checkout id or repo path");
    }
    return new TasksCheckoutApi(this.#env, this.#projectId, this.#credential, checkoutId, normalized);
  }

  [Symbol.dispose](): void {
    this.#dial.close();
  }
}

/**
 * One checkout, as a capability. Every method lazily makes sure the DO is
 * seeded first (agents may reach a checkout before any browser has), then
 * forwards to the DO's plain-data RPC methods — mutations land in the live
 * Y.Doc, so connected collaborators see agent edits keystroke-for-keystroke
 * with their own.
 */
export class TasksCheckoutApi extends RpcTarget implements TasksCheckout {
  readonly #env: VesselEnv;
  readonly #projectId: string;
  readonly #credential: ProjectCredential;
  readonly #checkoutId: string;
  readonly #repoPath: string;
  #stub: Promise<CheckoutStubOps> | null = null;
  #seeded: Promise<void> | null = null;

  constructor(
    env: VesselEnv,
    projectId: string,
    credential: ProjectCredential,
    checkoutId: string,
    repoPath: string,
  ) {
    super();
    this.#env = env;
    this.#projectId = projectId;
    this.#credential = credential;
    this.#checkoutId = checkoutId;
    this.#repoPath = repoPath;
  }

  async files(): Promise<CheckoutSnapshot> {
    return (await this.#ready()).filesSnapshot();
  }

  async read(path: string): Promise<string | null> {
    return (await this.#ready()).readFile(path);
  }

  async write(path: string, content: string): Promise<void> {
    return (await this.#ready()).applyWrite(path, content);
  }

  async delete(path: string): Promise<void> {
    return (await this.#ready()).applyWrite(path, null);
  }

  async changes(): Promise<TaskChangeSummary[]> {
    return (await this.#ready()).changesSummary();
  }

  async commit(message: string): Promise<CommitResult> {
    const stub = await this.#ready();
    return stub.commitDoc(this.#credential, this.#projectId, this.#repoPath, message);
  }

  async generateMessage(): Promise<string> {
    const stub = await this.#ready();
    return stub.generateMessageDoc(this.#credential, this.#projectId);
  }

  #do(): Promise<CheckoutStubOps> {
    // getServerByName (not plain getByName) so partyserver's onStart — which
    // loads the persisted doc — has completed before any method runs.
    this.#stub ??= getServerByName(
      this.#env.CHECKOUT as unknown as Parameters<typeof getServerByName>[0],
      `${this.#projectId}:${this.#repoPath}:${this.#checkoutId}`,
    ).then((stub) => stub as unknown as CheckoutStubOps);
    return this.#stub;
  }

  async #ready(): Promise<CheckoutStubOps> {
    const stub = await this.#do();
    this.#seeded ??= stub
      .ensureSeeded(this.#credential, this.#projectId, this.#repoPath)
      .catch((error: unknown) => {
        this.#seeded = null;
        throw error;
      });
    await this.#seeded;
    return stub;
  }
}

/**
 * The projectId claim, read (unverified) from the JWT payload purely to know
 * which project to dial — authenticate() then proves the token against that
 * very project, so a forged claim just fails the dial. Padding restored
 * before atob because workerd's atob is strict.
 */
function projectIdClaim(token: string): string {
  const parts = token.split(".");
  if (parts.length === 3) {
    const body = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    try {
      const claims = JSON.parse(atob(body + "=".repeat((4 - (body.length % 4)) % 4))) as {
        projectId?: unknown;
      };
      if (typeof claims.projectId === "string" && claims.projectId !== "") {
        return claims.projectId;
      }
    } catch {
      // fall through to the error below
    }
  }
  throw new Error("session token is not a project-app-session JWT");
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
