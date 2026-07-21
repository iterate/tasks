import {
  collab,
  getSyncedVersion,
  receiveUpdates,
  sendableUpdates,
  type Update,
} from "@codemirror/collab";
import { ChangeSet, Text, type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { withProject } from "./use-checkout.ts";
import type { CollabChanges, CollabWaitResult, TasksWorkspace } from "./tasks-api.ts";

/**
 * The browser's end of the no-Yjs collab lane (PoC): @codemirror/collab's
 * rebase model over the vessel's capnweb `/api` — push batches out, long-poll
 * `wait` in. The server (the platform workspace DO) is the single ordering
 * authority; this client optimistically applies local edits and rebases
 * unconfirmed ones over every delivered batch.
 */
export class CollabConnection {
  readonly clientId = `web-${Math.random().toString(36).slice(2, 10)}`;
  epoch = "";
  /** Own ops seen back in deliveries — the stable clientSeq base. */
  confirmed = 0;
  /** Fold of confirmed ops only — the reseed baseline for carrying
   * unconfirmed local edits across a snapshot re-sync. */
  synced = Text.empty;
  onStatus: (status: string) => void = () => {};
  /** Set by the page: rebuild the editor from a server snapshot, seeding the
   * doc with `carriedText` (snapshot + best-effort local unconfirmed). */
  onReseed: (snapshot: { content: string; epoch: string; version: number }, carriedText: string) => void =
    () => {};

  constructor(
    readonly checkoutId: string,
    readonly repoPath: string,
    readonly filePath: string,
  ) {}

  #lane(project: {
    workspace(checkoutId: string, repoPath?: string): unknown;
  }): TasksWorkspace {
    return project.workspace(this.checkoutId, this.repoPath) as TasksWorkspace;
  }

  async open(): Promise<{ content: string; version: number }> {
    const opened = await withProject((project) => this.#lane(project).open(this.filePath));
    this.epoch = opened.epoch;
    this.confirmed = 0;
    this.synced = Text.of(opened.content.split("\n"));
    return opened;
  }

  async push(baseVersion: number, updates: readonly Update[]) {
    const ops = updates.map((update, index) => ({
      changes: update.changes.toJSON(),
      clientSeq: this.confirmed + index,
    }));
    return withProject((project) =>
      this.#lane(project).push({
        baseVersion,
        clientId: this.clientId,
        epoch: this.epoch,
        ops,
        path: this.filePath,
      }),
    );
  }

  async wait(afterVersion: number): Promise<CollabWaitResult> {
    return withProject((project) =>
      this.#lane(project).wait(this.filePath, this.epoch, afterVersion),
    );
  }

  async changes(): Promise<CollabChanges> {
    return withProject((project) => this.#lane(project).changes(this.filePath));
  }

  async readBase(): Promise<string | null> {
    return withProject((project) => this.#lane(project).readBase(this.filePath));
  }

  /** Fold delivered ops into the confirmed baseline and count own ones. */
  absorb(ops: { changes: unknown; clientId: string }[]): Update[] {
    this.confirmed += ops.filter((op) => op.clientId === this.clientId).length;
    const updates: Update[] = ops.map((op) => ({
      changes: ChangeSet.fromJSON(op.changes),
      clientID: op.clientId,
    }));
    for (const update of updates) this.synced = update.changes.apply(this.synced);
    return updates;
  }

  /** Reset the connection's confirmed baseline onto a server snapshot —
   * the bookkeeping half of a re-sync; the page rebuilds the editor. */
  reseed(snapshot: { content: string; epoch: string; version: number }): void {
    this.epoch = snapshot.epoch;
    this.confirmed = 0;
    this.synced = Text.of(snapshot.content.split("\n"));
  }

  /**
   * Best-effort carry of local unconfirmed edits onto a fresh snapshot:
   * express them as one splice against the confirmed baseline, then re-apply
   * onto the snapshot — exactly when the touched region is unchanged there;
   * insert-only (never deleting others' text) when it drifted. Text is never
   * silently discarded.
   */
  carryOnto(snapshotContent: string, localDoc: string): string {
    const base = this.synced.toString();
    const splice = commonSplice(base, localDoc);
    if (splice === null) return snapshotContent;
    if (snapshotContent.slice(splice.from, splice.to) === base.slice(splice.from, splice.to)) {
      return (
        snapshotContent.slice(0, splice.from) + splice.insert + snapshotContent.slice(splice.to)
      );
    }
    const at = Math.min(splice.from, snapshotContent.length);
    return snapshotContent.slice(0, at) + splice.insert + snapshotContent.slice(at);
  }
}

/** The ONE common-prefix/suffix splice used everywhere the client needs
 * "what single replacement turns base into next" (null = identical). */
export function commonSplice(
  base: string,
  next: string,
): { from: number; insert: string; to: number } | null {
  if (base === next) return null;
  let from = 0;
  const maxFrom = Math.min(base.length, next.length);
  while (from < maxFrom && base[from] === next[from]) from++;
  let toBase = base.length;
  let toNext = next.length;
  while (toBase > from && toNext > from && base[toBase - 1] === next[toNext - 1]) {
    toBase--;
    toNext--;
  }
  return { from, insert: next.slice(from, toNext), to: toBase };
}

const MAX_BACKOFF_MS = 10_000;
const backoff = (attempt: number) => Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);

/** The peer extension: collab state + the push/pull loops (official CM6
 * collab example shape, with capnweb long-poll as the transport). */
export function peerExtension(connection: CollabConnection, startVersion: number): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      pushing = false;
      done = false;
      failures = 0;

      constructor(readonly view: EditorView) {
        void this.pull();
      }

      update(update: ViewUpdate) {
        if (update.docChanged) void this.push();
      }

      async push(): Promise<void> {
        if (this.pushing || this.done) return;
        const updates = sendableUpdates(this.view.state);
        if (updates.length === 0) return;
        this.pushing = true;
        try {
          const result = await connection.push(getSyncedVersion(this.view.state), updates);
          switch (result.status) {
            case "accepted":
              this.failures = 0;
              break;
            case "too-large":
              // The batch can never succeed; stop the session loudly rather
              // than retrying an impossible push forever.
              this.done = true;
              connection.onStatus(`edit too large (cap ${result.maxBytes} bytes) — reopen the file`);
              return;
            case "epoch-mismatch":
            case "history-miss":
              // The pull loop's snapshot lane owns recovery.
              break;
          }
        } catch (error) {
          this.failures++;
          connection.onStatus(`push retry ${this.failures}: ${message(error)}`);
          await sleep(backoff(this.failures));
        }
        this.pushing = false;
        // Anything typed while the push was in flight goes in the next batch.
        if (!this.done && sendableUpdates(this.view.state).length > 0) {
          setTimeout(() => void this.push(), 120);
        }
      }

      async pull(): Promise<void> {
        while (!this.done) {
          try {
            const result = await connection.wait(getSyncedVersion(this.view.state));
            if (this.done) break;
            this.failures = 0;
            if (result.status === "ended") {
              // The file was deleted/replaced/reset: the session is gone for
              // everyone. Surface it and stop — reopening is a page decision.
              this.done = true;
              connection.onStatus("session ended (file deleted or replaced)");
              return;
            }
            if (result.status === "snapshot") {
              // Past the floor or epoch rotated: rebuild from the snapshot,
              // carrying local unconfirmed edits best-effort.
              const carried = connection.carryOnto(
                result.snapshot.content,
                this.view.state.doc.toString(),
              );
              this.done = true;
              connection.onStatus("re-synced from snapshot");
              connection.onReseed(result.snapshot, carried);
              return;
            }
            if (result.ops.length === 0) continue;
            this.view.dispatch(receiveUpdates(this.view.state, connection.absorb(result.ops)));
          } catch (error) {
            if (this.done) break;
            this.failures++;
            if (this.failures > 8) {
              this.done = true;
              connection.onStatus(`disconnected: ${message(error)}`);
              return;
            }
            connection.onStatus(`reconnecting (${this.failures})…`);
            await sleep(backoff(this.failures));
          }
        }
      }

      destroy() {
        this.done = true;
      }
    },
  );
  return [collab({ clientID: connection.clientId, startVersion }), plugin];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
